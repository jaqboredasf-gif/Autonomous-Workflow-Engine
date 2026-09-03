// ---------------------------------------------------------------------------
// journal-store.mjs — where a run journal lives between two service calls.
//
// This is the module that makes "pause for a human, resume in a different
// process" real rather than a claim. A paused run IS its journal; if the
// journal is only in memory, resuming means the same process never exited, and
// nothing about durability has been demonstrated.
//
// Two implementations behind one interface:
//
//   memory  — a Map. For tests and for a single-call submit/inspect cycle.
//   file    — one canonical JSON document per run under `<root>/journals/`,
//             written atomically (temp + rename) with mode 0600, so a crashed
//             writer never leaves a half-parsed journal that a resume would
//             then refuse.
//
// The successor is a table, and it is ADR-0002: `read`/`write`/`list` is
// deliberately the same three-method shape a Supabase-backed store would have,
// so swapping it is one module.
//
// The store verifies NOTHING about the document's contents. Verification is the
// journal's own job (`loadRunJournal` re-checks the document digest and the
// entire hash chain), and a store that also verified would give two answers to
// one question.
//
// WHAT THE STORE *DOES* CHECK is concurrency: `write(document, { expected_head })`
// is a compare-and-set on the journal's chain head.
//
//   expected_head: undefined  — no check (a caller that has not opted in)
//   expected_head: null       — the run must NOT already be stored
//   expected_head: '<digest>' — the stored run's head must be exactly this
//
// This is the second half of the single-writer guarantee. The run lease
// (`lease-store.mjs`) stops two workers starting on the same run; the head
// check stops a worker whose lease lapsed mid-run from committing on top of its
// successor. Neither alone is sufficient: a lease can expire while its holder
// is still alive, and a head check alone would let both workers execute the
// side effects and only then discover one of them was wasted — which, for a
// step that issued a payment instruction, is far too late.
//
// Two further refusals, added when the durable store made them checkable and
// the conformance suite made the gap visible:
//
//   tenant      a write for a run id another tenant already holds is refused,
//               rather than replacing that tenant's history.
//   append-only a write whose document DROPS or REWRITES an entry the store
//               already holds is refused. The head check alone did not cover
//               this: a writer whose view is current can still hand back a
//               tampered prefix, and the chain would verify because a tampered
//               history is internally consistent.
//
// The file store's check is read-compare-rename, so a sufficiently unlucky pair
// of writers can still interleave inside the window. It is stated here rather
// than glossed: the durable, genuinely atomic version is a conditional UPDATE
// in the table this store's successor becomes (ADR-0002), and the lease is what
// makes the window unreachable in normal operation.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { canonicalJson } from '../../awe-kernel/src/index.mjs';

export const DEFAULT_JOURNAL_ROOT = 'artifacts';

// Path containment: a run id is caller-supplied, and a caller-supplied path
// component that escapes the root is a directory traversal. Same guard the
// artifact sink uses.
function containedPath(root, relative) {
  const base = resolve(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}/`)) {
    throw new Error(`journal path '${relative}' escapes the store root`);
  }
  return target;
}

function fileName(run_id) {
  // Run ids are already constrained to `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` by
  // the kernel's execution context, but ':' is not a friendly path character on
  // every filesystem, so it is folded here rather than being trusted.
  return `${run_id.replace(/:/g, '_')}.json`;
}

/**
 * The compare-and-set decision, shared by both stores so the rule is written
 * once. Returns null when the write may proceed, or the refusal to return.
 */
function headConflict({ stored, expected_head, run_id }) {
  if (expected_head === undefined) return null;
  const actual = stored === null || stored === undefined ? null : stored.head ?? null;
  if (actual === expected_head) return null;
  return {
    ok: false,
    ref: null,
    reason: 'journal_write_conflict',
    error: expected_head === null
      ? `run '${run_id}' is already stored; this writer expected to create it`
      : `run '${run_id}' has moved on — expected head ${expected_head}, stored head ${actual}`,
    conflict: { expected: expected_head, actual },
  };
}

/**
 * The append-only half, and it was genuinely missing here.
 *
 * These stores replace the WHOLE document on every write. The head
 * compare-and-set stops a writer whose view is stale, but it does not stop a
 * writer whose view is current from committing a document that has DROPPED or
 * REWRITTEN earlier entries: read the run at head h, hand back a document whose
 * head is also h but whose seq-3 entry says something else, and the store would
 * take it. The hash chain would still verify, because the tampered history is
 * internally consistent — it is just not the history that happened.
 *
 * The Postgres store cannot express that bug: existing rows are never touched
 * and new entries must chain from the stored head. This is the same guarantee,
 * enforced where the two other stores could not previously offer it, so all
 * three now answer the conformance suite identically.
 */
function appendOnlyConflict({ stored, document }) {
  if (stored === null || stored === undefined) return null;

  const refusal = (error) => ({
    ok: false, ref: null, reason: 'journal_append_only', error,
    conflict: { expected: stored.head ?? null, actual: document.head ?? null },
  });

  if (document.genesis !== stored.genesis) {
    return refusal(`run '${document.run_id}' cannot be re-parented onto another genesis`);
  }
  const before = stored.entries ?? [];
  const after = document.entries ?? [];
  if (after.length < before.length) {
    return refusal(
      `run '${document.run_id}' holds ${before.length} entries; this writer offered ${after.length}`,
    );
  }
  for (let i = 0; i < before.length; i += 1) {
    if (after[i]?.entry_digest !== before[i].entry_digest) {
      return refusal(
        `run '${document.run_id}' entry ${i + 1} was rewritten — history is appended to, never amended`,
      );
    }
  }
  return null;
}

/**
 * The tenant half of the compare-and-set, added when the Postgres store made it
 * checkable. Two runs can only share an id by derivation collision, and the
 * control-plane service already refuses that at `startRun` — but a store whose
 * WRITE is keyed on run id alone would let the second tenant replace the first
 * one's history, and "the caller above happens to check" is not a guarantee the
 * store gets to rely on.
 */
function tenantConflict({ stored, document }) {
  if (stored === null || stored === undefined) return null;
  if (stored.org_id === document.org_id) return null;
  return {
    ok: false,
    ref: null,
    reason: 'journal_write_conflict',
    // Says nothing about who the real owner is.
    error: `run '${document.run_id}' already exists and is not accessible to this tenant`,
    conflict: { expected: null, actual: null },
  };
}

export function createMemoryJournalStore() {
  const documents = new Map();
  return Object.freeze({
    kind: 'journal_store',
    name: 'memory',
    write(document, { expected_head } = {}) {
      const stored = documents.get(document.run_id) ?? null;
      const mismatch = tenantConflict({ stored, document });
      if (mismatch !== null) return mismatch;
      const conflict = headConflict({ stored, expected_head, run_id: document.run_id });
      if (conflict !== null) return conflict;
      const rewrite = appendOnlyConflict({ stored, document });
      if (rewrite !== null) return rewrite;
      documents.set(document.run_id, JSON.parse(canonicalJson(document)));
      return { ok: true, ref: document.run_id, error: null };
    },
    // The optional tenant is a FILTER, not a post-hoc check: a caller that names
    // a tenant gets null for another tenant's run, indistinguishable from a run
    // that does not exist.
    read(run_id, { org_id = null } = {}) {
      const found = documents.get(run_id);
      if (found === undefined) return null;
      if (org_id !== null && found.org_id !== org_id) return null;
      return JSON.parse(JSON.stringify(found));
    },
    list({ org_id = null } = {}) {
      return [...documents.entries()]
        .filter(([, document]) => org_id === null || document.org_id === org_id)
        .map(([run_id]) => run_id)
        .sort();
    },
  });
}

export function createFileJournalStore({ root = DEFAULT_JOURNAL_ROOT } = {}) {
  const directory = join(root, 'journals');
  return Object.freeze({
    kind: 'journal_store',
    name: 'local_file',
    root: directory,
    write(document, { expected_head } = {}) {
      try {
        const stored = this.read(document.run_id);
        const mismatch = tenantConflict({ stored, document });
        if (mismatch !== null) return mismatch;
        const conflict = headConflict({ stored, expected_head, run_id: document.run_id });
        if (conflict !== null) return conflict;
        const rewrite = appendOnlyConflict({ stored, document });
        if (rewrite !== null) return rewrite;
        const target = containedPath(directory, fileName(document.run_id));
        mkdirSync(dirname(target), { recursive: true });
        const temp = `${target}.tmp`;
        writeFileSync(temp, `${canonicalJson(document)}\n`, { encoding: 'utf8', mode: 0o600 });
        renameSync(temp, target);
        return { ok: true, ref: target, error: null };
      } catch (e) {
        return { ok: false, ref: null, error: String(e?.message ?? e) };
      }
    },
    read(run_id, { org_id = null } = {}) {
      try {
        const found = JSON.parse(readFileSync(containedPath(directory, fileName(run_id)), 'utf8'));
        if (org_id !== null && found.org_id !== org_id) return null;
        return found;
      } catch {
        return null;
      }
    },
    list({ org_id = null } = {}) {
      try {
        const ids = readdirSync(directory).filter((f) => f.endsWith('.json')).sort().map((f) => f.slice(0, -5));
        if (org_id === null) return ids;
        // The stored id is the FILE name with ':' folded, so the tenant filter
        // reads each document rather than guessing the id back from the path.
        return ids.filter((id) => {
          try {
            return JSON.parse(readFileSync(containedPath(directory, `${id}.json`), 'utf8')).org_id === org_id;
          } catch {
            return false;
          }
        });
      } catch {
        return [];
      }
    },
  });
}
