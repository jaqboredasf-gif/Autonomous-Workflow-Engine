// ---------------------------------------------------------------------------
// result-store.mjs — where a run's step outputs live between two service calls.
//
// This exists because of a boundary that had to be respected rather than
// worked around. A run that pauses for a human and resumes in another process
// needs its earlier steps' outputs — the consequential step cannot issue a
// payment instruction without the draft id the fourth step produced. The
// obvious place to put them is the run journal.
//
// The journal is the WRONG place, and deliberately refuses them: `report.mjs`
// and `journal.mjs` both record a workflow's data as a DIGEST, never as a body,
// because a control-plane record is reviewed by people and shipped to logs,
// while an invoice's supplier, amount and account number belong in the tenant
// tables that already hold them under RLS. Putting step outputs in the journal
// would retire that rule for every run.
//
// So the control plane keeps two stores with two different jobs:
//
//   journal store  — the append-only, hash-chained CONTROL record. Digests
//                    only. Safe to read while investigating an incident.
//   result store   — the tenant-bound DATA record. Bodies. Read by the run that
//                    owns it and by nothing else.
//
// Splitting them is what lets the successor of each be chosen separately: the
// journal becomes an append-only control table, the results become an
// RLS-protected tenant table, and neither decision forces the other. Both are
// ADR-0002.
//
// The store refuses a read whose tenant does not match what was written, so a
// caller that guessed a run id gets nothing even if it got past the journal.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { canonicalJson } from '../../awe-kernel/src/index.mjs';

export const RESULT_DOCUMENT_SCHEMA = 'awe.run_results/v1';

function containedPath(root, relative) {
  const base = resolve(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}/`)) {
    throw new Error(`result path '${relative}' escapes the store root`);
  }
  return target;
}

const fileName = (run_id) => `${run_id.replace(/:/g, '_')}.json`;

function document({ run_id, org_id, results }) {
  return { schema: RESULT_DOCUMENT_SCHEMA, run_id, org_id, results };
}

// A read is tenant-checked here as well as at the service, because "two
// independent checks" is the whole reason a second store is not just a second
// map inside the first one.
function tenantChecked(found, org_id) {
  if (found === null || found === undefined) return {};
  if (found.org_id !== org_id) return {};
  return found.results ?? {};
}

export function createMemoryResultStore() {
  const store = new Map();
  return Object.freeze({
    kind: 'result_store',
    name: 'memory',
    write({ run_id, org_id, results }) {
      store.set(run_id, JSON.parse(canonicalJson(document({ run_id, org_id, results }))));
      return { ok: true, ref: run_id, error: null };
    },
    read({ run_id, org_id }) {
      return tenantChecked(store.get(run_id) ?? null, org_id);
    },
    list() { return [...store.keys()].sort(); },
  });
}

export function createFileResultStore({ root = 'artifacts' } = {}) {
  const directory = join(root, 'results');
  return Object.freeze({
    kind: 'result_store',
    name: 'local_file',
    root: directory,
    write({ run_id, org_id, results }) {
      try {
        const target = containedPath(directory, fileName(run_id));
        mkdirSync(dirname(target), { recursive: true });
        const temp = `${target}.tmp`;
        writeFileSync(temp, `${canonicalJson(document({ run_id, org_id, results }))}\n`, { encoding: 'utf8', mode: 0o600 });
        renameSync(temp, target);
        return { ok: true, ref: target, error: null };
      } catch (e) {
        return { ok: false, ref: null, error: String(e?.message ?? e) };
      }
    },
    read({ run_id, org_id }) {
      try {
        return tenantChecked(JSON.parse(readFileSync(containedPath(directory, fileName(run_id)), 'utf8')), org_id);
      } catch {
        return {};
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
