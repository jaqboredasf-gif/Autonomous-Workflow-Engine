// ---------------------------------------------------------------------------
// throttle.mjs — how many times somebody may guess.
//
// PURE. No clock, no storage, no request. It is handed the failures recorded
// against a key and the current time, and it answers whether the next attempt
// is allowed. Everything that remembers anything lives outside.
//
// WHY THIS EXISTS NOW. Until this milestone PCC ran on one machine in a
// workshop, and a password could be guessed as fast as the server answered —
// which the gap register has said in writing since Checkpoint 1E and which
// nobody needed to care about, because reaching the server meant standing in
// the building. Putting it on the internet is the moment that stops being true.
//
// WHAT IT DELIBERATELY IS NOT: a general rate limiter, a WAF, or a bot
// defence. It is the smallest thing that turns "unlimited guesses" into "a few
// guesses, then a wait", which is the difference between a weak password
// falling in minutes and falling never.
//
// TWO KEYS, AND BOTH MATTER:
//   the ADDRESS  — stops one account being ground down
//   the SOURCE   — stops one attacker spraying one password across many
//                  addresses, which the per-address counter cannot see
// A limiter with only the first is a limiter an attacker walks around by
// changing the email on every request.
// ---------------------------------------------------------------------------

/** Failures allowed inside the window before the key is locked. */
export const MAX_FAILURES = 5;

/** How far back failures are counted, in seconds. */
export const WINDOW_SECONDS = 15 * 60;

/** How long a locked key stays locked, in seconds. */
export const LOCK_SECONDS = 15 * 60;

/**
 * A source address gets a looser limit than a single account, because a shop
 * shares one office IP and several people signing in badly on a Monday morning
 * must not lock each other out. It is still bounded: 30 failures from one
 * address in fifteen minutes is not somebody misremembering a password.
 */
export const MAX_SOURCE_FAILURES = 30;

/**
 * May this attempt proceed?
 *
 * @param {number[]} failures     epoch-second timestamps of recent failures
 * @param {number} now            epoch seconds
 * @param {number} [max]          failures allowed in the window
 * @returns {{allowed: true} | {allowed: false, retryAfterSeconds: number}}
 */
export function attemptDecision(failures = [], now = 0, max = MAX_FAILURES) {
  const recent = withinWindow(failures, now);
  if (recent.length < max) return { allowed: true };

  // The lock runs from the MOST RECENT failure, not the first. Guessing again
  // while locked extends the lock — otherwise an attacker simply keeps trying
  // through the window and resumes the moment it rolls off.
  const newest = Math.max(...recent);
  const retryAfterSeconds = Math.max(1, newest + LOCK_SECONDS - now);
  return { allowed: false, retryAfterSeconds };
}

/** Drop failures that have aged out. What the store should persist. */
export function withinWindow(failures = [], now = 0) {
  const cutoff = now - WINDOW_SECONDS;
  return failures.filter((t) => Number.isFinite(t) && t > cutoff);
}

/**
 * Record a failure and return the list to keep.
 *
 * Bounded on purpose: an unbounded array is a memory leak with an attacker
 * holding the pen. Past the limit the oldest entries are dropped, which cannot
 * weaken the decision — the newest are the ones the lock is measured from.
 */
export function recordFailure(failures = [], now = 0, cap = 64) {
  return [...withinWindow(failures, now), now].slice(-cap);
}

/**
 * The key an attempt is counted under.
 *
 * The address is lowercased and trimmed so `Mike@…`, `mike@…` and ` mike@… `
 * are one account rather than three budgets.
 */
export function throttleKeys(email, sourceAddress) {
  return {
    account: `account:${String(email ?? '').trim().toLowerCase()}`,
    source: `source:${String(sourceAddress ?? 'unknown')}`,
  };
}
