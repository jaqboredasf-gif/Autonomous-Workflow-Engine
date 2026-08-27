// ---------------------------------------------------------------------------
// provenance.mjs — how do we know, and how well.
//
// This module exists because of one sentence that must never be writable:
// "AWE saved 37.4 hours." A number without a grade and a source is a claim, and
// a claim is what a customer's finance director will take apart in the first
// meeting. So nothing in the proof system carries a bare number. Every quantity
// carries how it was obtained, where it came from, and what it was derived
// from.
//
// The grades are ordered, weakest last, and that order is the whole defence
// against fake precision: a derived quantity is graded at its WEAKEST input.
// One estimated minute anywhere in a chain makes the answer estimated, however
// many measured timestamps sit beside it. There is no averaging of confidence
// and no promotion — a derivation can only lose grade, never gain it.
//
// UNAVAILABLE is a real, first-class value rather than an absence. This follows
// the rule PCC already states about integrations (PCC_INTEGRATION_ARCHITECTURE
// §1, rule 5): a missing figure is null, not a stub. An unavailable quantity
// has value `null` — never 0 — because zero hours returned and unknown hours
// returned are different facts and only one of them is defensible.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

/**
 * The epistemic grades, strongest first.
 *
 *   MEASURED       an instrument recorded it. A timestamp the system wrote, a
 *                  stopwatch reading, a row count. Reproducible by re-reading.
 *   ESTIMATED      derived by a stated method from things that were measured,
 *                  or a sampled figure applied to a population. Defensible
 *                  arithmetic over incomplete observation.
 *   INFERRED       concluded from surrounding facts without observing the thing
 *                  itself. "Nobody edited it, so nobody handled it."
 *   SELF_REPORTED  a person said so. Legitimate evidence — the operator knows
 *                  their own job — but it is testimony, not instrumentation.
 *   UNAVAILABLE    we do not know. Value is null and stays null.
 */
export const PROVENANCE_GRADES = Object.freeze([
  'MEASURED',
  'ESTIMATED',
  'INFERRED',
  'SELF_REPORTED',
  'UNAVAILABLE',
]);

const RANK = new Map(PROVENANCE_GRADES.map((g, i) => [g, i]));

export function isGrade(g) {
  return RANK.has(g);
}

/** The weaker of two grades. Used everywhere a derivation combines inputs. */
export function weaker(a, b) {
  assertGrade(a);
  assertGrade(b);
  return RANK.get(a) >= RANK.get(b) ? a : b;
}

/** The weakest of many. An empty list is UNAVAILABLE: nothing supports nothing. */
export function weakestOf(grades) {
  if (!Array.isArray(grades) || grades.length === 0) return 'UNAVAILABLE';
  return grades.reduce((acc, g) => weaker(acc, g), 'MEASURED');
}

function assertGrade(g) {
  if (!isGrade(g)) throw new Error(`unknown provenance grade: ${JSON.stringify(g)}`);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Where a figure came from, specifically enough for somebody to go and look.
 *
 * `kind` is a closed vocabulary because "source: observation" tells a reader
 * nothing, and an open string field becomes exactly that within a month. `ref`
 * is deliberately free text but REQUIRED: it is the part a person follows.
 */
export const SOURCE_KINDS = Object.freeze([
  'SYSTEM_RECORD',      // a row this software wrote — audit log, timestamp column
  'OBSERVED_TIMING',    // somebody timed the real activity, with a stopwatch
  'SAMPLED_MEASUREMENT',// a measured subset, stated as such, applied to a population
  'HISTORICAL_RECORD',  // pre-existing records — paper POs, spreadsheets, invoices
  'OPERATOR_STATEMENT', // a named person's account of their own work
  'WORKFLOW_LOG',       // logs from a system that is not ours
  'DERIVED',            // computed from other proof quantities; ref names the calculation
]);

/**
 * @param {object} spec
 * @param {string} spec.kind    one of SOURCE_KINDS
 * @param {string} spec.ref     what to go and look at. A table name, a file, a
 *                              person and a date, a calculation name.
 * @param {string} [spec.at]    when the source was captured, ISO. Injected, never
 *                              read from a clock, so records replay identically.
 * @param {number} [spec.sampleSize] how many observations, where that applies.
 * @param {string} [spec.note]
 */
export function source({ kind, ref, at = null, sampleSize = null, note = null }) {
  if (!SOURCE_KINDS.includes(kind)) throw new Error(`unknown source kind: ${kind}`);
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error('a source needs a ref — a source nobody can go and check is not a source');
  }
  if (sampleSize !== null && !(Number.isInteger(sampleSize) && sampleSize > 0)) {
    throw new Error(`sampleSize must be a positive integer or null (got ${sampleSize})`);
  }
  return Object.freeze({ kind, ref, at, sampleSize, note });
}

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

export const UNITS = Object.freeze([
  'minutes',
  'hours',
  'days',
  'cents',
  'count',
  'ratio',
]);

/**
 * A number that can defend itself.
 *
 * Two rules are enforced here rather than trusted:
 *
 *   1. UNAVAILABLE means `value === null`. Not zero. The single most common way
 *      an ROI system starts lying is a null coalescing to 0 three layers below
 *      the person reading it.
 *
 *   2. Anything that is NOT unavailable must name at least one source. This is
 *      the same bar `deployment/evidence.mjs` sets — evidence that cannot say
 *      where it came from is an opinion — applied to money and hours.
 *
 * `basis` is prose: the sentence a founder reads out when a judge or a finance
 * director asks "how do we know?". It is required for the same reason.
 */
export function quantity({ value, unit, provenance, sources = [], basis = null, resolution = null }) {
  assertGrade(provenance);
  if (!UNITS.includes(unit)) throw new Error(`unknown unit: ${unit}`);

  if (provenance === 'UNAVAILABLE') {
    if (value !== null && value !== undefined) {
      throw new Error('an UNAVAILABLE quantity must have a null value — unknown is not zero');
    }
    return Object.freeze({
      value: null, unit, provenance, sources: Object.freeze([...sources]),
      basis: basis ?? 'not known', resolution: null, known: false,
    });
  }

  if (!Number.isFinite(value)) {
    throw new Error(`a ${provenance} quantity needs a finite value (got ${JSON.stringify(value)}) — use UNAVAILABLE to say we do not know`);
  }
  if (sources.length === 0) {
    throw new Error(`a ${provenance} quantity must name at least one source — a figure with no source is an opinion`);
  }
  if (typeof basis !== 'string' || basis.trim() === '') {
    throw new Error('a known quantity needs a basis — the sentence that answers "how do we know?"');
  }

  return Object.freeze({
    value,
    unit,
    provenance,
    sources: Object.freeze([...sources]),
    basis,
    // How finely this may honestly be reported. See `present()`.
    resolution: resolution ?? defaultResolution(provenance, unit),
    known: true,
  });
}

/** The shorthand for "we do not know", which is used more than anything else. */
export function unavailable(unit, basis = 'not known') {
  return quantity({ value: null, unit, provenance: 'UNAVAILABLE', basis });
}

/**
 * How precisely a grade may be reported.
 *
 * A measured elapsed time is a real number of minutes. An hours figure built
 * from a self-reported per-step estimate is not accurate to the minute and
 * printing it to the minute is a lie of presentation rather than of arithmetic
 * — which is the harder kind to catch, because the number underneath is
 * correct. So the grade decides the decimal places, once, here.
 */
function defaultResolution(provenance, unit) {
  if (unit === 'cents') return provenance === 'MEASURED' ? 1 : 100;       // to the dollar unless invoiced
  if (unit === 'ratio') return provenance === 'MEASURED' ? 0.001 : 0.01;
  if (unit === 'count') return 1;
  if (provenance === 'MEASURED') return unit === 'minutes' ? 1 : 0.1;
  return unit === 'minutes' ? 5 : 0.5;                                     // estimates round coarsely
}

/** The value rounded to what its grade can honestly support. Null stays null. */
export function present(q) {
  if (!q.known) return null;
  const r = q.resolution;
  if (!r) return q.value;
  const rounded = Math.round(q.value / r) * r;
  // Kill binary float dust: 0.30000000000000004 is not more precise, it is uglier.
  return Number(rounded.toFixed(6));
}

// ---------------------------------------------------------------------------
// Arithmetic that carries provenance with it
// ---------------------------------------------------------------------------

/**
 * Combine quantities under a function, degrading to the weakest input.
 *
 * If ANY input is unavailable the result is unavailable. That is stricter than
 * "treat unknown as zero and carry on", and it is the point: a total that
 * silently omits an unknown component reads as complete and is not.
 */
export function derive(inputs, fn, { unit, basis, sources = [] }) {
  const list = Object.values(inputs);
  if (list.some((q) => !q.known)) {
    const missing = Object.entries(inputs).filter(([, q]) => !q.known).map(([k]) => k);
    return quantity({
      value: null, unit, provenance: 'UNAVAILABLE',
      basis: `${basis} — cannot be computed: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unknown`,
    });
  }
  const grade = weakestOf(list.map((q) => q.provenance));
  const value = fn(Object.fromEntries(Object.entries(inputs).map(([k, q]) => [k, q.value])));
  if (!Number.isFinite(value)) {
    return quantity({ value: null, unit, provenance: 'UNAVAILABLE', basis: `${basis} — the calculation did not produce a finite value` });
  }
  return quantity({
    value, unit, provenance: grade, basis,
    sources: [...sources, source({ kind: 'DERIVED', ref: basis })],
  });
}

/**
 * Add quantities of one unit.
 *
 * Unknown members are SKIPPED rather than poisoning the sum, but the count of
 * them is reported by the caller — `ledger.mjs` does exactly this and prints
 * how many executions could not be valued beside the total. That is the honest
 * shape for a population sum, and it is why this behaves differently from
 * `derive()`, where every input is a necessary term of one calculation.
 */
export function sum(quantities, { unit, basis, sources = [] }) {
  const known = quantities.filter((q) => q.known);
  if (known.length === 0) {
    return quantity({ value: null, unit, provenance: 'UNAVAILABLE', basis: `${basis} — nothing measurable in range` });
  }
  for (const q of known) {
    if (q.unit !== unit) throw new Error(`cannot sum ${q.unit} into ${unit}`);
  }
  return quantity({
    value: known.reduce((t, q) => t + q.value, 0),
    unit,
    provenance: weakestOf(known.map((q) => q.provenance)),
    basis,
    sources: [...sources, source({ kind: 'DERIVED', ref: basis, sampleSize: known.length })],
  });
}

/** Minutes → hours, keeping grade and sources. */
export function toHours(q) {
  if (!q.known) return unavailable('hours', q.basis);
  if (q.unit !== 'minutes') throw new Error(`toHours expects minutes, got ${q.unit}`);
  return quantity({
    value: q.value / 60, unit: 'hours', provenance: q.provenance,
    sources: [...q.sources], basis: q.basis,
  });
}

/**
 * The breakdown a reader is entitled to: how much of a total rests on each
 * grade. A single headline grade tells you the weakest link; this tells you
 * whether the weakest link carried one minute or all of them.
 */
export function gradeMix(quantities) {
  const mix = Object.fromEntries(PROVENANCE_GRADES.map((g) => [g, { count: 0, value: 0 }]));
  for (const q of quantities) {
    const bucket = mix[q.provenance];
    bucket.count += 1;
    if (q.known) bucket.value += q.value;
  }
  return mix;
}
