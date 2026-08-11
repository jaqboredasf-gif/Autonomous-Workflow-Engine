// ---------------------------------------------------------------------------
// sign-in-throttle.ts — the memory behind domain/throttle.mjs.
//
// The rule is pure and lives in the domain. This is the part that remembers,
// and it is deliberately the smallest thing that works: a Map in the server
// process, swept as it goes.
//
// WHAT THAT HONESTLY BUYS, AND WHAT IT DOES NOT.
//
// One instance: correct. Several instances behind a load balancer: each one
// counts separately, so the effective limit multiplies by the instance count.
// That is a real weakness and it is stated here rather than discovered later —
// but a per-instance limit still turns unlimited guessing into a few guesses
// per instance per fifteen minutes, which is the difference that matters. When
// PCC runs on more than one instance this needs a shared store (Postgres table
// or the platform's KV), and the interface below is what would move: nothing
// above it changes.
//
// A restart clears the counters. Also true of every in-memory limiter, and
// also not a reason to have none.
// ---------------------------------------------------------------------------

import {
  attemptDecision, recordFailure, throttleKeys,
  MAX_FAILURES, MAX_SOURCE_FAILURES,
} from '../purchasing/domain/throttle.mjs';

/** key -> failure timestamps, epoch seconds. */
const failures = new Map<string, number[]>();

/**
 * Keys are swept when they are touched, but a key nobody touches again would
 * live forever. This bounds the map: once it is large, the coldest entries go.
 * They are only failure counters — dropping one grants a few extra guesses to
 * somebody who stopped guessing a quarter of an hour ago.
 */
const MAX_TRACKED_KEYS = 10_000;

function sweep() {
  if (failures.size <= MAX_TRACKED_KEYS) return;
  const excess = failures.size - MAX_TRACKED_KEYS;
  let dropped = 0;
  for (const key of failures.keys()) {
    failures.delete(key);
    if (++dropped >= excess) break;
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * May this address, from this source, attempt a sign-in?
 *
 * Returns the wait in seconds when it may not. The caller reports the same
 * refusal whether the account exists or not — a throttle that only triggers
 * for real accounts is an account-enumeration oracle.
 */
export function checkSignInAllowed(email: string, source: string | null) {
  const now = nowSeconds();
  const keys = throttleKeys(email, source);

  const account = attemptDecision(failures.get(keys.account) ?? [], now, MAX_FAILURES);
  if (!account.allowed) return account;
  return attemptDecision(failures.get(keys.source) ?? [], now, MAX_SOURCE_FAILURES);
}

/** Count a failed attempt against both keys. */
export function recordSignInFailure(email: string, source: string | null) {
  const now = nowSeconds();
  const keys = throttleKeys(email, source);
  failures.set(keys.account, recordFailure(failures.get(keys.account) ?? [], now));
  failures.set(keys.source, recordFailure(failures.get(keys.source) ?? [], now));
  sweep();
}

/**
 * Forget the account's failures after a success.
 *
 * The SOURCE counter is deliberately left alone: one correct password among
 * fifty wrong ones is what a successful spray looks like, and clearing the
 * source budget on success would hand the attacker a reset button.
 */
export function clearSignInFailures(email: string) {
  failures.delete(throttleKeys(email, null).account);
}

/** Test seam. Not exported through any route. */
export function __resetThrottle() {
  failures.clear();
}
