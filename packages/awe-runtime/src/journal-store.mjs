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

export function createMemoryJournalStore() {
  const documents = new Map();
  return Object.freeze({
    kind: 'journal_store',
    name: 'memory',
    write(document) {
      documents.set(document.run_id, JSON.parse(canonicalJson(document)));
      return { ok: true, ref: document.run_id, error: null };
    },
    read(run_id) {
      const found = documents.get(run_id);
      return found === undefined ? null : JSON.parse(JSON.stringify(found));
    },
    list() { return [...documents.keys()].sort(); },
  });
}

export function createFileJournalStore({ root = DEFAULT_JOURNAL_ROOT } = {}) {
  const directory = join(root, 'journals');
  return Object.freeze({
    kind: 'journal_store',
    name: 'local_file',
    root: directory,
    write(document) {
      try {
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
    read(run_id) {
      try {
        return JSON.parse(readFileSync(containedPath(directory, fileName(run_id)), 'utf8'));
      } catch {
        return null;
      }
    },
    list() {
      try {
        return readdirSync(directory).filter((f) => f.endsWith('.json')).sort().map((f) => f.slice(0, -5));
      } catch {
        return [];
      }
    },
  });
}
