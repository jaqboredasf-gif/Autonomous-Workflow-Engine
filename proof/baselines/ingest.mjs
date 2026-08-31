// ---------------------------------------------------------------------------
// baselines/ingest.mjs — turn what the founder actually observed into a
// baseline, without letting anybody type a number into a source file.
//
// THE PROBLEM THIS SOLVES. `lippolis-purchasing.mjs` declares seven steps with
// every duration UNAVAILABLE, and its header says: do not edit a number in here
// without also editing its provenance and adding a source. That instruction is
// correct and it is an instruction — the kind a tired person follows at 11pm by
// typing `minutes: 6` and moving on, because `quantity()` will accept it as
// long as *a* source object is present.
//
// So observations arrive as DATA — a JSON file the founder fills in over
// several days, one line per thing they watched — and this module is the only
// path from that data to a baseline. Every rule below is enforced at import,
// which means a badly-recorded observation fails loudly in the repository
// rather than quietly becoming a figure in a case study.
//
// WHAT IT REFUSES:
//   · an observation with no method, no observer, no date, or no reference to
//     the thing observed. "6 minutes" with nothing to go and look at is not
//     evidence, it is a memory.
//   · MEASURED from fewer than five observations. The field protocol's own
//     words: below five the median is one person's odd Tuesday. A step observed
//     three times is real and it is not a measurement, and this caps it rather
//     than arguing about it.
//   · a method this system has no meaning for, rather than guessing at the
//     nearest one.
//
// WHAT IT PRESERVES, because collapsing them is the thing that destroys a case
// study under questioning:
//   DIRECT_OBSERVATION  somebody watched it with a clock   -> MEASURED
//   HISTORICAL_RECORD   derived from paperwork that exists -> ESTIMATED
//   EMPLOYEE_ESTIMATE   somebody's account of their own work -> SELF_REPORTED
//
// A step built from four timed observations and one recollection is
// SELF_REPORTED, not "mostly measured". The weakest input sets the grade,
// everywhere, always.
//
// PURE: no clock, no randomness. The caller loads the file.
// ---------------------------------------------------------------------------

import { baselineStep } from '../baseline.mjs';
import { quantity, source, unavailable } from '../provenance.mjs';

/**
 * How an observation was obtained, and what that is worth.
 *
 * Closed on purpose. A method not on this list is refused rather than mapped to
 * the nearest one — "I asked the vendor" is not an employee estimate and
 * pretending it is would put it behind the wrong word.
 */
export const METHODS = Object.freeze({
  DIRECT_OBSERVATION: {
    grade: 'MEASURED',
    kind: 'OBSERVED_TIMING',
    means: 'somebody watched the work happen and timed it',
  },
  HISTORICAL_RECORD: {
    grade: 'ESTIMATED',
    kind: 'HISTORICAL_RECORD',
    means: 'derived from records that already existed — dated paper POs, packing slips, sent email',
  },
  EMPLOYEE_ESTIMATE: {
    grade: 'SELF_REPORTED',
    kind: 'OPERATOR_STATEMENT',
    means: 'the person who does the work said how long it takes',
  },
});

/**
 * Below this many observations, a step cannot be MEASURED however it was
 * obtained.
 *
 * FIVE, and the reason is stated so it can be argued with: a median over fewer
 * than five occurrences is dominated by whichever one was unusual, and every
 * step in this process has an unusual version — the request that needed three
 * phone calls, the vendor who answered immediately. Five is the smallest number
 * at which the middle value means anything, and it is the number
 * docs/proof/LIPPOLIS_BASELINE_FIELD_PROTOCOL.md asks the founder to collect.
 *
 * This is a threshold for how much weight a median deserves. It is not a power
 * calculation and nothing here pretends otherwise.
 */
export const MEASURED_FLOOR = 5;

const GRADE_ORDER = ['MEASURED', 'ESTIMATED', 'INFERRED', 'SELF_REPORTED', 'UNAVAILABLE'];
const weakest = (a, b) => (GRADE_ORDER.indexOf(a) >= GRADE_ORDER.indexOf(b) ? a : b);

/** The median. Odd counts take the middle; even counts take the lower middle. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * One observation, validated.
 *
 * `ref` is what makes this evidence rather than a note: the thing a skeptical
 * reader goes and looks at. A PO number, a file, a date and a person.
 */
export function observation({ minutes, method, observedBy, at, ref, subject = null, note = null }) {
  if (!METHODS[method]) {
    throw new Error(
      `unknown observation method ${JSON.stringify(method)}. ` +
      `One of: ${Object.keys(METHODS).join(', ')}. ` +
      'A method that is not on the list is refused rather than mapped to the nearest one.');
  }
  if (!(Number.isFinite(minutes) && minutes >= 0)) {
    throw new Error(`an observation needs minutes as a non-negative number, got ${JSON.stringify(minutes)}`);
  }
  if (!observedBy) throw new Error('an observation must say who observed it — an unattributed timing cannot be questioned');
  if (!at) throw new Error('an observation must say when it was made');
  if (!ref) {
    throw new Error(
      'an observation must name what was observed — a purchase order number, a file, a person and a date. ' +
      '"6 minutes" with nothing to go and look at is a memory, not evidence.');
  }
  return Object.freeze({ minutes, method, observedBy, at, ref, subject, note });
}

/**
 * A set of observations for one step, as a baseline step.
 *
 * @param {string} id            the step id, matching the baseline's shape
 * @param {string} label
 * @param {Array}  observations
 * @param {number} appliesToShare  what fraction of units of work this step
 *                                 happens on. 1 = every one.
 */
export function stepFromObservations({ id, label, observations = [], appliesToShare = 1, performedBy = null, note = null }) {
  if (!(Number.isFinite(appliesToShare) && appliesToShare > 0 && appliesToShare <= 1)) {
    throw new Error(`step ${id}: appliesToShare must be greater than 0 and at most 1, got ${JSON.stringify(appliesToShare)}`);
  }

  if (observations.length === 0) {
    return baselineStep({
      id, label, minutes: null, provenance: 'UNAVAILABLE', performedBy,
      note: note ?? 'not yet observed',
    });
  }

  const obs = observations.map(observation);
  const raw = median(obs.map((o) => o.minutes));

  // A STEP THAT HAPPENS ON ONE REQUEST IN FOUR IS NOT A FULL STEP OF THE
  // AVERAGE. Scaling here rather than leaving it to the reader is the whole
  // difference between a baseline and a wish: clarification taking eight
  // minutes when it happens, on a quarter of requests, contributes two.
  const minutes = raw * appliesToShare;

  // The weakest method sets the grade, and too few observations caps it below
  // MEASURED whatever the method was.
  let grade = obs.map((o) => METHODS[o.method].grade).reduce(weakest, 'MEASURED');
  const capped = grade === 'MEASURED' && obs.length < MEASURED_FLOOR;
  if (capped) grade = 'ESTIMATED';

  const sources = obs.map((o) => source({
    kind: METHODS[o.method].kind,
    ref: o.ref,
    at: o.at,
    note: `${o.minutes} min, ${o.method.toLowerCase().replace(/_/g, ' ')}, recorded by ${o.observedBy}` +
      (o.subject ? `, performed by ${o.subject}` : ''),
  }));

  const spread = obs.length > 1
    ? ` (${Math.min(...obs.map((o) => o.minutes))}-${Math.max(...obs.map((o) => o.minutes))} min observed)`
    : '';
  const share = appliesToShare === 1 ? '' : `, occurring on ${Math.round(appliesToShare * 100)}% of units`;
  const cap = capped ? `; capped below MEASURED because ${obs.length} observation(s) is fewer than ${MEASURED_FLOOR}` : '';

  return baselineStep({
    id,
    label,
    minutes,
    provenance: grade,
    sources,
    performedBy,
    note: `median of ${obs.length} observation(s)${spread}${share}${cap}${note ? `. ${note}` : ''}`,
  });
}

/**
 * The loaded labour rate, which every money figure rests on and nothing else
 * can supply.
 */
export function labourRateFrom(spec) {
  if (!spec || spec.centsPerHour === null || spec.centsPerHour === undefined) {
    return { centsPerHour: null, provenance: 'UNAVAILABLE', sources: [] };
  }
  if (!METHODS[spec.method]) {
    throw new Error(`labour rate: unknown method ${JSON.stringify(spec.method)}`);
  }
  if (!spec.ref) throw new Error('labour rate: name where the figure came from — payroll, and who said so');
  if (!(Number.isFinite(spec.centsPerHour) && spec.centsPerHour > 0)) {
    throw new Error(`labour rate: centsPerHour must be a positive number, got ${JSON.stringify(spec.centsPerHour)}`);
  }
  return {
    centsPerHour: spec.centsPerHour,
    provenance: METHODS[spec.method].grade,
    sources: [source({ kind: METHODS[spec.method].kind, ref: spec.ref, at: spec.at ?? null, note: spec.note ?? null })],
  };
}

/**
 * Validate an observation file without building anything.
 *
 * Returns every problem rather than throwing on the first, because a founder
 * fixing a file wants the whole list.
 */
export function validate(doc, { expectSteps = [] } = {}) {
  const problems = [];
  const at = (where, message) => problems.push(`${where}: ${message}`);

  if (!doc || typeof doc !== 'object') return ['the observation file is not an object'];
  if (!doc.baselineId) at('file', 'no baselineId — nothing says which baseline these observations are for');
  if (!doc.orgId) at('file', 'no orgId — evidence is organization-bound');
  if (!doc.steps || typeof doc.steps !== 'object') at('file', 'no steps object');

  for (const [id, step] of Object.entries(doc.steps ?? {})) {
    if (expectSteps.length && !expectSteps.includes(id)) {
      at(`steps.${id}`, `not a step of this baseline. Known: ${expectSteps.join(', ')}`);
    }
    for (const [i, o] of (step.observations ?? []).entries()) {
      try { observation(o); } catch (e) { at(`steps.${id}.observations[${i}]`, e.message); }
    }
    try { stepFromObservations({ id, label: id, ...step }); } catch (e) { at(`steps.${id}`, e.message); }
  }

  for (const id of expectSteps) {
    if (!(id in (doc.steps ?? {}))) at(`steps.${id}`, 'not present — the step will be UNAVAILABLE');
  }

  if (doc.labourRate) {
    try { labourRateFrom(doc.labourRate); } catch (e) { at('labourRate', e.message); }
  }
  return problems;
}

/** What is still missing, for the founder's next hour. */
export function outstanding(doc, { expectSteps = [] } = {}) {
  const rows = [];
  for (const id of expectSteps) {
    const step = doc?.steps?.[id];
    const n = step?.observations?.length ?? 0;
    if (n === 0) { rows.push({ step: id, have: 0, need: MEASURED_FLOOR, because: 'not observed at all' }); continue; }
    const grades = step.observations.map((o) => METHODS[o.method]?.grade ?? 'UNAVAILABLE');
    const allDirect = grades.every((g) => g === 'MEASURED');
    if (allDirect && n < MEASURED_FLOOR) {
      rows.push({ step: id, have: n, need: MEASURED_FLOOR, because: `${MEASURED_FLOOR - n} more timed observation(s) would make it MEASURED` });
    } else if (!allDirect) {
      rows.push({ step: id, have: n, need: MEASURED_FLOOR, because: `graded ${grades.reduce(weakest, 'MEASURED')} — the weakest observation sets it` });
    }
  }
  if (!doc?.labourRate?.centsPerHour) {
    rows.push({ step: 'labourRate', have: 0, need: 1, because: 'one email to payroll; every money figure waits on it' });
  }
  return rows;
}
