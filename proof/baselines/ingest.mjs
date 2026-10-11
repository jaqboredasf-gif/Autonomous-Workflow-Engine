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
export function observation({ minutes, seconds, covers = 1, method, observedBy, at, ref, subject = null, note = null }) {
  // WORK DONE IN BATCHES IS STILL PER-ORDER WORK. Filing is the clearest case:
  // nobody files one packing slip, they file the week's in one sitting. Timing
  // that sitting and dividing by how many it covered is a MEASUREMENT of the
  // per-order cost — and without this column the only options were to skip the
  // step, or to ask somebody what they thought it took, which would drag the
  // whole baseline down to SELF_REPORTED.
  if (!(Number.isInteger(covers) && covers >= 1)) {
    throw new Error(`an observation covers a whole number of units, at least 1, got ${JSON.stringify(covers)}`);
  }
  // SECONDS ARE THE FIELD UNIT. A stopwatch reads 01:32, and asking somebody
  // standing in an office to write 1.53 forces arithmetic at the exact moment
  // they are trying to watch what happens next. It also silently coarsens the
  // short steps: a 90-second stock check written as "2 minutes" is a 33% error
  // in the direction that flatters us.
  if (seconds !== undefined && seconds !== null) {
    if (minutes !== undefined && minutes !== null) {
      throw new Error('an observation gives seconds or minutes, not both — one of them is a transcription error');
    }
    if (!(Number.isFinite(seconds) && seconds >= 0)) {
      throw new Error(`an observation needs seconds as a non-negative number, got ${JSON.stringify(seconds)}`);
    }
    minutes = seconds / 60;
  }
  if (Number.isFinite(minutes) && covers > 1) minutes /= covers;
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
  return Object.freeze({ minutes, covers, method, observedBy, at, ref, subject, note });
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

  // THE SAME THING OBSERVED TWICE IS ONE OBSERVATION. A row pasted twice, or
  // the same purchase order timed on two visits, would otherwise raise the
  // sample count toward MEASURED without adding any evidence — which is the
  // cheapest possible way to buy a stronger grade by accident.
  const byRef = new Map();
  for (const o of obs) {
    const key = `${o.ref}::${o.at}`;
    const seen = byRef.get(key);
    if (!seen) { byRef.set(key, o); continue; }
    if (seen.minutes !== o.minutes) {
      throw new Error(
        `step ${id}: ${JSON.stringify(o.ref)} on ${o.at} is recorded twice with different durations ` +
        `(${(seen.minutes * 60).toFixed(0)}s and ${(o.minutes * 60).toFixed(0)}s). ` +
        'One of them is wrong and the file cannot decide which. Check the sheet and remove or correct one.');
    }
    throw new Error(
      `step ${id}: ${JSON.stringify(o.ref)} on ${o.at} appears twice. ` +
      'A duplicated row raises the sample count without adding evidence — remove one.');
  }

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
    note: `${(o.minutes * 60).toFixed(0)}s per unit` +
      (o.covers > 1 ? ` (a batch of ${o.covers}, timed whole and divided)` : '') +
      `, ${o.method.toLowerCase().replace(/_/g, ' ')}, recorded by ${o.observedBy}` +
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
 * ELAPSED TIME THE OLD PROCESS TOOK, END TO END.
 *
 * A DIFFERENT QUESTION FROM HANDLING TIME, and the one the paper purchase
 * orders answer without interrupting anybody: a PO raised on the 3rd and
 * received on the 11th took eight days, of which almost none was labour.
 *
 * THIS HAD NOWHERE TO GO. The field kit asked the founder to spend an afternoon
 * recording the raised and received dates of twenty-five paper POs, and the
 * observation schema had no field for them — so the whole afternoon's output
 * would have been retyped into nothing. It lands here.
 *
 * Counted in DAYS because that is what the paperwork says, and converted to
 * hours because that is the unit the ledger compares against.
 */
export function cycleFrom(spec) {
  if (!spec || !Array.isArray(spec.observations) || spec.observations.length === 0) {
    return { hours: null, provenance: 'UNAVAILABLE', sources: [] };
  }
  const rows = spec.observations.map((o) => {
    if (!METHODS[o.method]) throw new Error(`cycle: unknown method ${JSON.stringify(o.method)}`);
    if (!o.ref) throw new Error('cycle: every observation must name the purchase order it came from');
    const days = o.days ?? daysBetween(o.raisedAt, o.receivedAt);
    if (!(Number.isFinite(days) && days >= 0)) {
      throw new Error(`cycle: ${o.ref} has no usable duration — give days, or raisedAt and receivedAt`);
    }
    return { ...o, days };
  });

  // The MEDIAN, because vendor lead time has a long tail: one back-ordered item
  // sitting for six weeks would drag a mean far above anything typical.
  const days = median(rows.map((r) => r.days));
  const grade = rows.map((r) => METHODS[r.method].grade).reduce(weakest, 'MEASURED');

  return {
    hours: days * 24,
    provenance: rows.length < CYCLE_FLOOR ? 'SELF_REPORTED' : grade,
    sources: rows.map((r) => source({
      kind: METHODS[r.method].kind,
      ref: r.ref,
      at: r.receivedAt ?? null,
      note: `${r.days} day(s) from raised to received`,
    })),
    samples: rows.length,
  };
}

function daysBetween(a, b) {
  if (!a || !b) return NaN;
  return (Date.parse(b) - Date.parse(a)) / 86_400_000;
}

/**
 * Below this many purchase orders, an elapsed-time median means little.
 *
 * FIFTEEN, and higher than the handling-time floor of five on purpose: vendor
 * lead time is the most variable quantity in this process — a counter pickup is
 * an hour and a back-ordered switchgear is three weeks — so the median needs
 * more observations before it stops moving. This is the field protocol's own
 * number, and reading the dates off fifteen filed POs interrupts nobody.
 */
export const CYCLE_FLOOR = 15;

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
  if (doc.cycle) {
    try { cycleFrom(doc.cycle); } catch (e) { at('cycle', e.message); }
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
  const cycleSamples = doc?.cycle?.observations?.length ?? 0;
  if (cycleSamples < CYCLE_FLOOR) {
    rows.push({
      step: 'cycle (paper POs)', have: cycleSamples, need: CYCLE_FLOOR,
      because: `${CYCLE_FLOOR - cycleSamples} more filed PO(s) with a raised and a received date. Interrupts nobody.`,
    });
  }
  if (!doc?.labourRate?.centsPerHour) {
    rows.push({
      step: 'labourRate', have: 0, need: 1,
      because: 'one email to payroll. OPTIONAL — hours returned does not wait on it; only the money figure does',
    });
  }
  return rows;
}
