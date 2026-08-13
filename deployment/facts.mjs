// ---------------------------------------------------------------------------
// facts.mjs — how AWE knows what it knows about a deployment.
//
// THE PROBLEM THIS SOLVES. PCC reached the end of application development while
// still blocked on a hostname nobody had been asked for. Not because the
// question was hard, but because there was nowhere for "we do not know this
// yet" to live: a value was either written down somewhere or it was absent, and
// absent looks identical to not-yet-asked, to asked-and-waiting, and to
// safely-defaulted.
//
// So every deployment fact carries HOW IT IS KNOWN, and the four states are
// deliberately not interchangeable:
//
//   DECLARED  somebody told us. Trustworthy as far as the teller is.
//   DERIVED   AWE worked it out from other facts. Only as good as its inputs.
//   VERIFIED  AWE checked it against the actual environment. The strongest.
//   UNKNOWN   nobody has said, nothing implies it, nothing has checked.
//
// The distinction that matters most is DECLARED vs VERIFIED. "IT says the
// server runs Linux" and "the preflight ran `uname` on the server" are
// different kinds of true, and a deployment that cannot tell them apart will
// eventually discover the difference on installation day.
//
// UNKNOWN IS A VALUE, NOT AN ABSENCE. A fact that has never been established is
// present in the model, has an owner, and can block a phase. This is the whole
// point: a missing hostname should be a row in a report, not a silence.
// ---------------------------------------------------------------------------

/** @typedef {'DECLARED'|'DERIVED'|'VERIFIED'|'UNKNOWN'} FactState */

export const FACT_STATES = ['DECLARED', 'DERIVED', 'VERIFIED', 'UNKNOWN'];

/**
 * How much weight a state carries when deciding whether one fact may replace
 * another.
 *
 * The ordering is NOT how certain each state feels — it is who has the better
 * claim to describe the customer's environment:
 *
 *   VERIFIED  we looked at the actual machine. Nothing beats this.
 *   DECLARED  a human said it about their own infrastructure.
 *   DERIVED   AWE inferred it from other facts. A guess, however good.
 *   UNKNOWN   nothing.
 *
 * DERIVED sits BELOW DECLARED deliberately. If AWE infers `systemd` from
 * "the OS is Linux" and the customer said `docker-compose`, the customer is
 * describing their machine and AWE is guessing about it. Only checking the
 * machine settles it.
 */
export const FACT_CONFIDENCE = { UNKNOWN: 0, DERIVED: 1, DECLARED: 2, VERIFIED: 3 };

/** A fact nobody has established. Carries the reason, so a report can say why. */
export function unknown(reason = 'not yet established') {
  return Object.freeze({ value: null, state: 'UNKNOWN', source: null, reason });
}

export function declared(value, source) {
  if (!source) throw new Error('a declared fact must say who declared it');
  return Object.freeze({ value, state: 'DECLARED', source, reason: null });
}

export function derived(value, source) {
  if (!source) throw new Error('a derived fact must say what it was derived from');
  return Object.freeze({ value, state: 'DERIVED', source, reason: null });
}

export function verified(value, source) {
  if (!source) throw new Error('a verified fact must say what verified it');
  return Object.freeze({ value, state: 'VERIFIED', source, reason: null });
}

/** Is this a fact object rather than a bare value? */
export function isFact(x) {
  return Boolean(x) && typeof x === 'object' && typeof x.state === 'string' && FACT_STATES.includes(x.state);
}

/**
 * Accept either a bare value or a fact.
 *
 * Bare values in a manifest are treated as DECLARED by whoever wrote the file —
 * that is what writing a value down means. This keeps hand-written manifests
 * readable: `port: 3000` is allowed and means "somebody decided 3000".
 */
export function toFact(x, source = 'manifest') {
  if (isFact(x)) return x;
  if (x === null || x === undefined) return unknown();
  return declared(x, source);
}

/** Is the fact established at all? */
export function isKnown(fact) {
  return isFact(fact) && fact.state !== 'UNKNOWN' && fact.value !== null && fact.value !== undefined;
}

/**
 * Record that something was checked against the real environment.
 *
 * Upgrading in place rather than replacing: a hostname that IT declared and the
 * preflight then resolved is the same fact, now known better, and the report
 * should be able to say both — "IT said pcc.lippolis.local, and DNS agrees".
 */
export function upgrade(fact, next) {
  const current = toFact(fact);
  if (FACT_CONFIDENCE[next.state] < FACT_CONFIDENCE[current.state]) return current;
  return Object.freeze({ ...next, previously: current.state === 'UNKNOWN' ? null : current });
}

/**
 * A fact whose declared value disagrees with what was verified.
 *
 * Not an error here — reporting it is the job, and deciding what to do about it
 * is the operator's. Silently preferring one over the other is how a deployment
 * proceeds on a false premise.
 */
export function conflicts(fact) {
  return Boolean(
    fact?.previously && fact.state === 'VERIFIED' && fact.previouslyValue !== undefined
      && fact.previouslyValue !== fact.value,
  );
}

/** One line for a report. Never prints a secret — see manifest.mjs. */
export function describeFact(path, fact) {
  const f = toFact(fact);
  if (f.state === 'UNKNOWN') return `${path}: UNKNOWN — ${f.reason ?? 'not established'}`;
  return `${path}: ${JSON.stringify(f.value)} [${f.state}${f.source ? ` via ${f.source}` : ''}]`;
}
