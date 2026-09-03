// ---------------------------------------------------------------------------
// postgres/lease-store.mjs — the durable run lease.
//
// The file store's own header admits the hole this closes: "TAKING OVER AN
// EXPIRED LEASE IS NOT ATOMIC. It is read, decide, temp-write, rename. Two
// workers can both observe the same expired lease and both rename, and the
// second rename wins."
//
// Here, taking over is a CONDITIONAL UPDATE:
//
//     update awe_run_leases set ... where run_id = $1 and fence = $expected
//                                    and (expires_at <= $now or holder = $me)
//
// Two workers that both read fence 3 both try to write fence 4; the first
// changes the row's fence and the second's `fence = 3` predicate no longer
// matches, so it updates nothing, is told `applied: false`, re-reads, and finds
// the run held. Exactly one wins, always, and the loser learns so BEFORE it does
// any work rather than at commit time.
//
// THE RULES ARE STILL PURE AND STILL SOMEWHERE ELSE. `evaluateClaim`,
// `evaluateHold` and `evaluateRelease` in `awe-control-plane/src/lease.mjs`
// decide whether a claim is legal, what mode it is, and what the new fence
// should be. This module asks them, then asks the database whether that decision
// won the race. Restating "a live lease may not be taken from another holder" in
// SQL would be a second source of truth — so the SQL asserts only the SAFETY
// half of it (`expires_at <= now or holder = me`), which is an invariant that
// must hold no matter what any caller believes.
//
// BOUNDED RETRY. A lost race is re-decided against the record that beat us, at
// most `attempts` times. Unbounded retry would livelock a hot run; zero retry
// would report "held" for a lease that had just been released a microsecond
// earlier. Three is the compromise, and it is an argument.
//
// THE FENCE IS ALSO A DATABASE INVARIANT. 0017 attaches a BEFORE UPDATE trigger
// that refuses any write lowering it. If this module ever had a bug that handed
// back a lower fence, the write would fail rather than quietly re-validating a
// zombie worker.
// ---------------------------------------------------------------------------

import { KernelError } from '../../../awe-kernel/src/index.mjs';
import {
  assertRunLease, evaluateClaim, evaluateHold, evaluateRelease,
} from '../../../awe-control-plane/src/index.mjs';
import { instantPlus } from '../clock.mjs';
import { DEFAULT_LEASE_TTL_MS, leaseGranted, leaseRefused } from '../lease-store.mjs';
import { assertExecutor } from './executor.mjs';

/**
 * Everything the database hands back that claims to be a lease goes through
 * `assertRunLease`, which re-derives `lease_digest` over the record's own bytes.
 * A record edited in place — a fence lowered, a deadline pushed out — fails here
 * instead of granting somebody a run they do not hold.
 */
function validateLease(payload, run_id) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new KernelError('contract_violation', `lease store returned a non-object for run '${run_id}'`, { run_id });
  }
  assertRunLease(payload, 'postgres lease store');
  if (payload.run_id !== run_id) {
    throw new KernelError('contract_violation', `lease store returned run '${payload.run_id}' when asked for '${run_id}'`, { run_id, returned: payload.run_id });
  }
  return payload;
}

export function createPostgresLeaseStore({
  executor, ttl_ms = DEFAULT_LEASE_TTL_MS, attempts = 3, org_id = null,
} = {}) {
  assertExecutor(executor, 'createPostgresLeaseStore');

  async function readRecord(run_id) {
    return validateLease(await executor.call('awe_lease_read', { run_id }), run_id);
  }

  return Object.freeze({
    kind: 'lease_store',
    name: 'postgres',
    ttl_ms,
    durable: true,
    // The claim that actually matters, and the reason this adapter exists. The
    // memory store says false and the file store says true-with-a-caveat; this
    // one is true without one.
    cross_process: true,
    org_id,

    async read(run_id) { return readRecord(run_id); },

    /**
     * acquire({ run_id, org_id, holder, now, ttl_ms })
     *
     * Decide, then race, then — if we lost — decide again against the winner.
     */
    async acquire({ run_id, org_id: tenant = null, holder, now, ttl_ms: ttl = null } = {}) {
      const window = ttl ?? ttl_ms;
      let verdict = null;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const current = await readRecord(run_id);
        verdict = evaluateClaim({
          current, run_id, org_id: tenant, holder, now, expires_at: instantPlus(now, window),
        });
        if (!verdict.ok) return leaseRefused(verdict);

        const outcome = await executor.call('awe_lease_acquire', {
          lease: verdict.lease,
          // null means "there must be no row"; a number means "the row must
          // still be at this fence". Either way it is the caller's read that is
          // being tested, which is what makes this a compare-and-set rather
          // than a hopeful write.
          expected_fence: current === null ? null : current.fence,
          now,
        });
        if (outcome?.applied === true) return leaseGranted(verdict);
      }

      // Every attempt was beaten. That is `run_lease_held` by definition — some
      // other worker is winning this run — and it is data, not an error.
      const current = await readRecord(run_id);
      return leaseRefused({
        reason: 'run_lease_held',
        detail: current === null
          ? `run '${run_id}' was claimed and released faster than ${attempts} attempts could observe`
          : `run '${run_id}' is leased by '${current.holder}' until ${current.expires_at}`,
        held_by: current?.holder ?? null,
      });
    },

    async verify({ run_id, holder, fence = null, now } = {}) {
      return evaluateHold({ current: await readRecord(run_id), run_id, holder, fence, now });
    },

    /**
     * release({ run_id, holder })
     *
     * The rules decide whether this holder may release; the SQL then deletes
     * only where the holder still matches, so a lease taken over in between is
     * not deleted out from under its new owner.
     */
    async release({ run_id, holder } = {}) {
      const verdict = evaluateRelease({ current: await readRecord(run_id), run_id, holder });
      if (verdict.ok && verdict.released) {
        await executor.call('awe_lease_release', { run_id, holder });
      }
      return verdict;
    },

    /**
     * expire({ now }) — reports, deletes nothing. Deleting an expired record
     * would restart its fence at 1 and hand a suspended worker a fence that is
     * valid again; the memory store's header explains this at length and the
     * rule does not change because the storage did.
     */
    async expire({ now, org_id: tenant = null } = {}) {
      const scope = org_id ?? tenant;
      const rows = await executor.call('awe_lease_expire', {
        now, ...(scope === null ? {} : { org_id: scope }),
      });
      if (!Array.isArray(rows)) {
        throw new KernelError('contract_violation', 'awe_lease_expire returned a non-array', {});
      }
      return rows;
    },

    async list({ org_id: tenant = null } = {}) {
      const scope = org_id ?? tenant;
      const rows = await executor.call('awe_lease_list', scope === null ? {} : { org_id: scope });
      if (!Array.isArray(rows)) {
        throw new KernelError('contract_violation', 'awe_lease_list returned a non-array', {});
      }
      return rows;
    },
  });
}
