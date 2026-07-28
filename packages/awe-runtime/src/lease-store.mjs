// ---------------------------------------------------------------------------
// lease-store.mjs — where a run lease lives while a worker holds it.
//
// The decision rules are pure and live in
// `packages/awe-control-plane/src/lease.mjs`. This module is the persistence
// and the ATOMICITY, which is a separate problem: "a claim is refused while
// another lease is live" is only true if two workers cannot both observe "no
// lease" and both write one.
//
// Two implementations behind one interface, and they give DIFFERENT guarantees.
// Saying so is the point of this header, because a store that quietly gave less
// than the caller assumed would be worse than no store at all:
//
//   memory — a Map. Exact within one process. Across processes it protects
//            NOTHING, because there is nothing shared to contend over. This is
//            the right store for tests and for a single-process operator CLI,
//            and the wrong one for two workers.
//
//   file   — one JSON record per run under `<root>/leases/`. First acquisition
//            uses `open(..., 'wx')`, which is atomic create-or-fail on every
//            POSIX filesystem: exactly one of N racing workers creates the file
//            and the rest get EEXIST. That is a real mutual exclusion.
//
//            TAKING OVER AN EXPIRED LEASE IS NOT ATOMIC. It is read, decide,
//            temp-write, rename. Two workers can both observe the same expired
//            lease and both rename, and the second rename wins. Neither the
//            documentation nor the tests pretend otherwise. What makes that
//            safe is the layer above: the winner's identity is what is stored,
//            so the loser's `verify()` before it commits returns
//            `run_lease_lost`, and its journal write is refused by the store's
//            head check even if it skipped `verify()`. The lease narrows the
//            race; the fence and the compare-and-set close it.
//
// The successor is a table with `SELECT ... FOR UPDATE` or a conditional
// update, and it is ADR-0002. `read` / `acquire` / `verify` / `release` /
// `expire` / `list` is deliberately the shape such a table supports directly.
// ---------------------------------------------------------------------------

import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { canonicalJson } from '../../awe-kernel/src/index.mjs';
import {
  assertRunLease, evaluateClaim, evaluateHold, evaluateRelease, isExpired,
} from '../../awe-control-plane/src/index.mjs';
import { instantPlus } from './clock.mjs';

export const DEFAULT_LEASE_TTL_MS = 60_000;

function containedPath(root, relative) {
  const base = resolve(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}/`)) {
    throw new Error(`lease path '${relative}' escapes the store root`);
  }
  return target;
}

const fileName = (run_id) => `${run_id.replace(/:/g, '_')}.json`;

// The shared claim path: read the current record, ask the pure rules, and hand
// the caller either a refusal or the record to persist. Both stores use it, so
// there is exactly one place where a lease decision is made.
function decide({ current, run_id, org_id, holder, now, ttl_ms }) {
  return evaluateClaim({
    current,
    run_id,
    org_id,
    holder,
    now,
    expires_at: instantPlus(now, ttl_ms ?? DEFAULT_LEASE_TTL_MS),
  });
}

const refused = (verdict) => Object.freeze({
  ok: false,
  reason: verdict.reason,
  detail: verdict.detail,
  lease: null,
  mode: null,
  held_by: verdict.held_by ?? null,
});

const granted = (verdict) => Object.freeze({
  ok: true,
  reason: null,
  detail: verdict.detail ?? null,
  lease: verdict.lease,
  mode: verdict.mode,
  fence: verdict.lease.fence,
  previous_holder: verdict.previous_holder ?? null,
});

export function createMemoryLeaseStore({ ttl_ms = DEFAULT_LEASE_TTL_MS } = {}) {
  const leases = new Map();

  return Object.freeze({
    kind: 'lease_store',
    name: 'memory',
    ttl_ms,
    // Stated, not implied: a caller that needs cross-process exclusion and gets
    // this store is holding a guarantee it does not have.
    cross_process: false,

    read(run_id) { return leases.get(run_id) ?? null; },

    acquire({ run_id, org_id = null, holder, now, ttl_ms: ttl = null } = {}) {
      const verdict = decide({ current: leases.get(run_id) ?? null, run_id, org_id, holder, now, ttl_ms: ttl ?? ttl_ms });
      if (!verdict.ok) return refused(verdict);
      leases.set(run_id, verdict.lease);
      return granted(verdict);
    },

    verify({ run_id, holder, fence = null, now } = {}) {
      return evaluateHold({ current: leases.get(run_id) ?? null, run_id, holder, fence, now });
    },

    release({ run_id, holder } = {}) {
      const verdict = evaluateRelease({ current: leases.get(run_id) ?? null, run_id, holder });
      if (verdict.ok && verdict.released) leases.delete(run_id);
      return verdict;
    },

    // The janitor. It REPORTS the lapsed leases and deliberately does not
    // delete them.
    //
    // Deleting looks like the obvious cleanup and is a bug: the next claim on a
    // run with no record starts again at fence 1, so a suspended worker still
    // holding fence 1 would find its fence valid again and could commit on top
    // of its successor. The fence is only a fence if it never goes backwards.
    // An expired record is already claimable — `evaluateClaim` compares the
    // deadline rather than trusting the record's existence — so keeping it
    // costs one small row per abandoned run and buys monotonicity.
    //
    // The record is removed on `release`, which is the normal end of a run.
    expire({ now } = {}) {
      return [...leases.entries()]
        .filter(([, lease]) => isExpired(lease, now))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([run_id, lease]) => ({
          run_id, holder: lease.holder, fence: lease.fence, expired_at: lease.expires_at,
        }));
    },

    list() { return [...leases.keys()].sort(); },
  });
}

export function createFileLeaseStore({ root = 'artifacts', ttl_ms = DEFAULT_LEASE_TTL_MS } = {}) {
  const directory = join(root, 'leases');

  function pathFor(run_id) { return containedPath(directory, fileName(run_id)); }

  function readRecord(run_id) {
    try {
      const found = JSON.parse(readFileSync(pathFor(run_id), 'utf8'));
      return assertRunLease(found, 'lease store');
    } catch {
      return null;
    }
  }

  // Atomic create-or-fail. This is the primitive the whole store rests on.
  function createExclusive(target, body) {
    mkdirSync(dirname(target), { recursive: true });
    let fd;
    try {
      fd = openSync(target, 'wx', 0o600);
    } catch (e) {
      if (e?.code === 'EEXIST') return false;
      throw e;
    }
    try { writeSync(fd, body); } finally { closeSync(fd); }
    return true;
  }

  function replace(target, body) {
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.tmp`;
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, target);
  }

  return Object.freeze({
    kind: 'lease_store',
    name: 'local_file',
    root: directory,
    ttl_ms,
    cross_process: true,

    read(run_id) { return readRecord(run_id); },

    acquire({ run_id, org_id = null, holder, now, ttl_ms: ttl = null } = {}) {
      const current = readRecord(run_id);
      const verdict = decide({ current, run_id, org_id, holder, now, ttl_ms: ttl ?? ttl_ms });
      if (!verdict.ok) return refused(verdict);

      const target = pathFor(run_id);
      const body = `${canonicalJson(verdict.lease)}\n`;

      if (current === null) {
        // The contended-create path. Losing here is not an error: another worker
        // created the lease between our read and our open, which is exactly the
        // race this call exists to resolve — so re-read and answer with the
        // truth rather than overwriting it.
        if (createExclusive(target, body)) return granted(verdict);
        const now_current = readRecord(run_id);
        const second = decide({ current: now_current, run_id, org_id, holder, now, ttl_ms: ttl ?? ttl_ms });
        if (!second.ok) return refused(second);
        replace(target, `${canonicalJson(second.lease)}\n`);
        return granted(second);
      }

      replace(target, body);
      return granted(verdict);
    },

    verify({ run_id, holder, fence = null, now } = {}) {
      return evaluateHold({ current: readRecord(run_id), run_id, holder, fence, now });
    },

    release({ run_id, holder } = {}) {
      const verdict = evaluateRelease({ current: readRecord(run_id), run_id, holder });
      if (verdict.ok && verdict.released) {
        try { rmSync(pathFor(run_id)); } catch { /* already gone is the desired state */ }
      }
      return verdict;
    },

    // Reports, never deletes — see the memory store for why deleting an expired
    // lease would silently reset the fence and re-validate a zombie.
    expire({ now } = {}) {
      const swept = [];
      for (const run_id of this.list()) {
        const lease = readRecord(run_id);
        if (lease !== null && isExpired(lease, now)) {
          swept.push({ run_id, holder: lease.holder, fence: lease.fence, expired_at: lease.expires_at });
        }
      }
      return swept;
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
