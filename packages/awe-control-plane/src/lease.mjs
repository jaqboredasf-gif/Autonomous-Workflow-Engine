// ---------------------------------------------------------------------------
// lease.mjs — the run lease: one run, one writer.
//
// The defect this closes was named in the previous session's own risk list:
// "two processes resuming the same run concurrently would both proceed". They
// genuinely would. The journal refuses a CONTRADICTORY history, but two workers
// that each load the same paused journal, each execute the consequential step,
// and each write a valid continuation produce two histories that are internally
// consistent and one payment that went out twice. Append-only does not imply
// single-writer; this module is what makes it so.
//
// Three mechanisms, layered, because each one alone has a hole:
//
//   1. THE LEASE. A worker claims a run for a bounded time before touching it.
//      A second worker's claim is refused while the first lease is live. This
//      is the mechanism that stops the ordinary race.
//   2. EXPIRY. A lease has a deadline, so a worker that crashes mid-run does
//      not strand it forever. Expiry is evaluated against an INJECTED instant —
//      this module reads no clock — which is what makes "the lease expired
//      three seconds ago" a deterministic test rather than a sleep.
//   3. THE FENCE. Every acquisition of a lease that was not simply renewed
//      increments a monotonic integer. A worker that was paused long enough for
//      its lease to expire and be taken can still be holding a stale record
//      that says it is the holder; the fence and holder together are what a
//      committer checks before writing, so the zombie's write is refused
//      instead of silently overwriting the successor's.
//
// The fence answers the question expiry alone cannot: a lease that expires does
// not notify the process that held it. Nothing prevents that process from
// waking up and continuing — except being told, at commit time, that the world
// moved on.
//
// PURE: no clock, no randomness, no I/O, no ambient environment. Every decision
// is a function of (current record, arguments, supplied instant). Persistence
// is `packages/awe-runtime/src/lease-store.mjs`, one layer up, exactly like the
// journal and its store.
// ---------------------------------------------------------------------------

import { deepFreeze, digest, invariant, isInstant } from './kernel.mjs';

export const RUN_LEASE_SCHEMA = 'awe.run_lease/v1';

// How a claim was satisfied. Distinct values because they mean different things
// to an operator reading a log: a `stolen` lease means a worker died or hung.
export const CLAIM_MODES = ['acquired', 'renewed', 'stolen'];

const HOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function instantMs(instant, at) {
  invariant(isInstant(instant), 'invalid_input', `${at} needs an ISO-8601 instant, got '${instant}'`, { instant });
  const ms = Date.parse(instant);
  invariant(Number.isFinite(ms), 'invalid_input', `${at} could not parse instant '${instant}'`, { instant });
  return ms;
}

/**
 * defineRunLease(...) -> frozen, self-describing lease record.
 *
 * Self-digesting for the same reason the journal document is: a lease read back
 * from a file is evidence about who was allowed to write, and evidence that
 * cannot detect its own edit is not evidence.
 */
export function defineRunLease({
  run_id, org_id = null, holder, fence, acquired_at, expires_at,
} = {}) {
  invariant(typeof run_id === 'string' && run_id.length > 0, 'invalid_input', 'a lease needs a run_id', { run_id });
  invariant(
    typeof holder === 'string' && HOLDER_PATTERN.test(holder),
    'invalid_input', `lease holder '${holder}' must be a short opaque worker identity`, { holder },
  );
  invariant(
    Number.isInteger(fence) && fence >= 1,
    'invalid_input', `lease fence '${fence}' must be an integer at or above 1`, { fence },
  );
  const from = instantMs(acquired_at, 'a lease acquired_at');
  const until = instantMs(expires_at, 'a lease expires_at');
  invariant(
    until > from,
    'invalid_input', 'a lease that expires at or before it was acquired grants nothing',
    { acquired_at, expires_at },
  );

  const body = { schema: RUN_LEASE_SCHEMA, run_id, org_id, holder, fence, acquired_at, expires_at };
  return deepFreeze({ ...body, lease_digest: digest(body) });
}

export function assertRunLease(lease, at = 'lease') {
  invariant(
    lease !== null && typeof lease === 'object' && !Array.isArray(lease),
    'contract_violation', `${at}: a lease record must be an object`, {},
  );
  invariant(
    lease.schema === RUN_LEASE_SCHEMA,
    'contract_violation', `${at}: lease schema '${lease.schema}' is not '${RUN_LEASE_SCHEMA}'`, {},
  );
  const { lease_digest, ...body } = lease;
  invariant(
    digest(body) === lease_digest,
    'contract_violation', `${at}: lease_digest does not match the lease content`,
    { expected: digest(body), actual: lease_digest },
  );
  return lease;
}

/**
 * isExpired(lease, now) — `now` is supplied, never read. A lease whose deadline
 * is exactly `now` is expired: the boundary belongs to the successor, so two
 * workers can never both consider themselves the holder at the same instant.
 */
export function isExpired(lease, now) {
  if (lease === null || lease === undefined) return true;
  return instantMs(now, 'lease expiry') >= instantMs(lease.expires_at, 'lease expires_at');
}

export function remainingMs(lease, now) {
  if (lease === null || lease === undefined) return 0;
  return Math.max(0, instantMs(lease.expires_at, 'lease expires_at') - instantMs(now, 'lease expiry'));
}

/**
 * evaluateClaim({ current, run_id, org_id, holder, now, expires_at })
 *   -> { ok, reason, detail, mode, lease }
 *
 * Returns DATA, never an exception, for the same reason registry resolution
 * does: "somebody else is working on this run" is a normal, expected outcome a
 * worker handles by moving on to the next run, not an error condition.
 *
 * BOTH instants are supplied. Deriving `expires_at` from a TTL here would mean
 * formatting an instant, which means `new Date(...)`, which the control-plane
 * purity lint forbids for good reason — so the TTL arithmetic lives one layer
 * up next to the clock that produced `now`, and the DECISION lives here.
 */
export function evaluateClaim({
  current = null, run_id, org_id = null, holder, now, expires_at,
} = {}) {
  const at = instantMs(now, 'a lease claim');
  invariant(
    instantMs(expires_at, 'a lease claim expires_at') > at,
    'invalid_input', 'a lease claim must expire after the instant it is made',
    { now, expires_at },
  );

  if (current === null || current === undefined) {
    return deepFreeze({
      ok: true, reason: null, detail: null, mode: 'acquired',
      lease: defineRunLease({ run_id, org_id, holder, fence: 1, acquired_at: now, expires_at }),
    });
  }

  assertRunLease(current, 'evaluateClaim');
  // A lease record for a different run reaching this call is a wiring bug in the
  // caller, not a contended claim — and returning "denied" would hide it.
  invariant(
    current.run_id === run_id,
    'contract_violation', `lease for run '${current.run_id}' was evaluated against run '${run_id}'`,
    { stored: current.run_id, requested: run_id },
  );
  // Likewise a tenant mismatch: the service resolves ownership before it ever
  // reaches the lease, so a mismatch here means two runs share an id.
  invariant(
    current.org_id === org_id,
    'contract_violation', `lease for run '${run_id}' is bound to tenant '${current.org_id}', not '${org_id}'`,
    { stored: current.org_id, requested: org_id },
  );

  const expired = isExpired(current, now);

  if (!expired && current.holder !== holder) {
    return deepFreeze({
      ok: false,
      reason: 'run_lease_held',
      detail: `run '${run_id}' is leased by '${current.holder}' until ${current.expires_at}`,
      mode: null,
      lease: null,
      held_by: current.holder,
      expires_at: current.expires_at,
    });
  }

  if (!expired) {
    // A renewal keeps the fence. The holder has not lost the run, so nothing
    // downstream should be invalidated by a heartbeat.
    return deepFreeze({
      ok: true, reason: null, detail: null, mode: 'renewed',
      lease: defineRunLease({
        run_id, org_id, holder, fence: current.fence, acquired_at: current.acquired_at, expires_at,
      }),
    });
  }

  // Expired — including expired-and-mine. Taking over ALWAYS bumps the fence,
  // even for the original holder: a worker whose lease lapsed cannot know
  // whether anything happened in the gap, and pretending otherwise is how a
  // stale in-memory view gets committed.
  return deepFreeze({
    ok: true,
    reason: null,
    detail: `previous lease held by '${current.holder}' expired at ${current.expires_at}`,
    mode: 'stolen',
    lease: defineRunLease({ run_id, org_id, holder, fence: current.fence + 1, acquired_at: now, expires_at }),
    previous_holder: current.holder,
  });
}

/**
 * evaluateHold({ current, run_id, holder, fence, now })
 *
 * The COMMIT-TIME check: "do I still hold what I think I hold?" A worker calls
 * this after doing the work and before writing the journal. A stale holder or a
 * stale fence is `run_lease_lost`, which the caller turns into a refusal rather
 * than a write.
 */
export function evaluateHold({ current = null, run_id, holder, fence = null, now } = {}) {
  const no = (detail) => deepFreeze({ ok: false, reason: 'run_lease_lost', detail });

  if (current === null || current === undefined) {
    return no(`run '${run_id}' holds no lease; '${holder}' cannot commit against it`);
  }
  assertRunLease(current, 'evaluateHold');
  if (current.holder !== holder) {
    return no(`run '${run_id}' is now leased by '${current.holder}', not '${holder}'`);
  }
  if (fence !== null && current.fence !== fence) {
    return no(`lease fence for run '${run_id}' moved from ${fence} to ${current.fence} — the lease lapsed and was retaken`);
  }
  if (isExpired(current, now)) {
    return no(`lease on run '${run_id}' expired at ${current.expires_at}`);
  }
  return deepFreeze({ ok: true, reason: null, detail: null, remaining_ms: remainingMs(current, now) });
}

/**
 * evaluateRelease({ current, run_id, holder })
 *
 * Releasing a lease you do not hold is refused rather than ignored: it is the
 * same zombie condition as a stale commit, and silently deleting a live lease
 * would hand the run to a third worker while the real holder was mid-step.
 */
export function evaluateRelease({ current = null, run_id, holder } = {}) {
  if (current === null || current === undefined) {
    return deepFreeze({ ok: true, reason: null, detail: 'no lease to release', released: false });
  }
  assertRunLease(current, 'evaluateRelease');
  if (current.holder !== holder) {
    return deepFreeze({
      ok: false,
      reason: 'run_lease_lost',
      detail: `run '${run_id}' is leased by '${current.holder}'; '${holder}' may not release it`,
      released: false,
    });
  }
  return deepFreeze({ ok: true, reason: null, detail: null, released: true });
}
