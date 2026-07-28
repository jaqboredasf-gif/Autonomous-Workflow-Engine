// ---------------------------------------------------------------------------
// clock.mjs — the injected clocks.
//
// The kernel and the control plane read no clock, by rule: a component that
// calls `Date.now()` cannot be part of a determinism gate, and a run that cannot
// be replayed cannot be evidence. Time therefore arrives as an argument, and
// this module is where the argument comes from.
//
// `createSteppingClock` is what makes timeout and duration behaviour TESTABLE
// rather than flaky. It is a virtual clock: it advances only when something
// advances it — either automatically by a fixed tick per read, or explicitly by
// an adapter simulating work. A step that "takes 9 seconds" does so in
// microseconds of wall time and produces byte-identical events every run.
//
// A real deployment injects a clock that reads the system time. That clock is
// deliberately NOT in this file: adding it here would make it the convenient
// default, and the convenient default should be the reproducible one.
// ---------------------------------------------------------------------------

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function toInstant(epochMs) {
  // Millisecond precision, always three digits, always UTC — the shape the
  // kernel's `isInstant` accepts and the shape that sorts lexicographically.
  const seconds = Math.floor(epochMs / 1000);
  const millis = epochMs - seconds * 1000;
  const date = new Date(seconds * 1000);
  const iso = date.toISOString().slice(0, 19);
  return `${iso}.${String(millis).padStart(3, '0')}Z`;
}

function parseInstant(instant) {
  if (!ISO_INSTANT.test(instant)) throw new Error(`not an ISO-8601 instant: '${instant}'`);
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) throw new Error(`instant '${instant}' could not be parsed`);
  return ms;
}

/**
 * createFixedClock(instant) -> () => instant
 *
 * Never moves. For a run where elapsed time must not affect the outcome at all.
 */
export function createFixedClock(instant = '2026-07-28T09:00:00.000Z') {
  parseInstant(instant);
  return () => instant;
}

/**
 * createSteppingClock({ start, tick_ms })
 *
 *   clock()          -> the current instant, then advances by `tick_ms`
 *   clock.advance(n) -> jump forward n milliseconds (a step simulating work)
 *   clock.peek()     -> the current instant WITHOUT advancing
 *   clock.elapsed()  -> milliseconds since `start`
 *
 * The per-read tick is what makes ordinary event ordering visible in a timeline
 * without every caller having to advance manually; `advance()` is what a
 * failure-injecting adapter uses to blow a step's time budget on purpose.
 */
export function createSteppingClock({ start = '2026-07-28T09:00:00.000Z', tick_ms = 10 } = {}) {
  const origin = parseInstant(start);
  let current = origin;

  const clock = () => {
    const instant = toInstant(current);
    current += tick_ms;
    return instant;
  };
  clock.advance = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('advance() takes a non-negative number of milliseconds');
    current += ms;
    return toInstant(current);
  };
  clock.peek = () => toInstant(current);
  clock.elapsed = () => current - origin;
  clock.reset = () => { current = origin; };
  return clock;
}
