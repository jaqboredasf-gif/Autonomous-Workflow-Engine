// ---------------------------------------------------------------------------
// baseline-readiness.mjs — is the Lippolis baseline good enough to govern?
//
// ONE SET OF RULES, three callers: the readiness command Jack runs in the
// field, the freeze command that refuses to freeze something not ready, and the
// pre-flight that says whether collection can start at all. A second opinion
// about "good enough" living in any one of them would be the thing that
// eventually disagrees.
//
// THE RULES ARE NOT NEW. Every threshold here is already enforced somewhere
// else and is read from there rather than restated:
//
//   MEASURED_FLOOR (5)   ingest.mjs — below five, a median is one odd Tuesday
//   CYCLE_FLOOR (15)     ingest.mjs — vendor lead time varies more than anything
//   handlingMinutes      baseline.mjs — a partial baseline has no total at all
//
// JACK CANNOT DECLARE SUCCESS. There is no flag, no override and no --force.
// The only way to make this say DEFENSIBLE is to have collected the evidence.
//
// PURE: no clock, no I/O.
// ---------------------------------------------------------------------------

import { MEASURED_FLOOR, CYCLE_FLOOR, METHODS } from '../../proof/baselines/ingest.mjs';
import { baselineHandlingMinutes, baselineGrade } from '../../proof/baseline.mjs';

export function readiness(doc, baseline) {
  const blocking = [];
  const weakening = [];

  const steps = baseline.steps.map((s) => {
    const recorded = doc.steps?.[s.id]?.observations ?? [];
    return {
      id: s.id,
      label: s.label,
      observations: recorded.length,
      grade: s.minutes.provenance,
      minutes: s.minutes.known ? s.minutes.value : null,
      appliesToShare: doc.steps?.[s.id]?.appliesToShare ?? 1,
    };
  });

  // --- what makes it impossible ------------------------------------------
  for (const s of steps) {
    if (s.observations === 0) {
      blocking.push(`${s.id}: no observations at all. A baseline missing one step has no total — it is not a smaller total.`);
    }
  }
  const handling = baselineHandlingMinutes(baseline);
  if (!handling.known && !blocking.length) {
    blocking.push(`the baseline has no handling total: ${handling.basis}`);
  }

  // --- what holds it below its best ---------------------------------------
  for (const s of steps) {
    if (s.observations > 0 && s.observations < MEASURED_FLOOR) {
      weakening.push(`${s.id}: ${s.observations} of ${MEASURED_FLOOR} observations — capped below MEASURED whatever the method`);
    }
    if (s.grade === 'SELF_REPORTED') {
      weakening.push(`${s.id}: graded SELF_REPORTED — one recollection among the timings sets the whole step`);
    } else if (s.grade === 'ESTIMATED' && s.observations >= MEASURED_FLOOR) {
      weakening.push(`${s.id}: graded ESTIMATED — derived from records rather than watched`);
    }
  }

  const cycleSamples = doc.cycle?.observations?.length ?? 0;
  if (cycleSamples === 0) {
    weakening.push('no paper POs read: elapsed-time change cannot be stated. This interrupts nobody — it is a filing cabinet.');
  } else if (cycleSamples < CYCLE_FLOOR) {
    weakening.push(`${cycleSamples} of ${CYCLE_FLOOR} paper POs — below ${CYCLE_FLOOR} the elapsed-time median is graded SELF_REPORTED`);
  }

  if (!doc.reviewedBy) {
    weakening.push('nobody has reviewed it. An unreviewed baseline is one person\'s afternoon, and the case-study gate caps at DEFENSIBLE.');
  }

  // --- what is OPTIONAL, and must not be confused with missing ------------
  const optional = [];
  if (!doc.labourRate?.centsPerHour) {
    optional.push(
      'no loaded labour rate. HOURS RETURNED does not wait on it — only the money figure does, ' +
      'which will read NOT MEASURABLE until somebody at payroll answers.');
  }

  const grade = blocking.length ? 'UNAVAILABLE' : baselineGrade(baseline);

  return Object.freeze({
    defensible: blocking.length === 0,
    grade,
    handlingMinutes: handling.known ? handling.value : null,
    steps: Object.freeze(steps),
    observationsTotal: steps.reduce((t, s) => t + s.observations, 0),
    cycleSamples,
    reviewedBy: doc.reviewedBy ?? null,
    labourRate: doc.labourRate?.centsPerHour ?? null,
    labourRateGrade: doc.labourRate?.method ? METHODS[doc.labourRate.method]?.grade ?? 'UNAVAILABLE' : 'UNAVAILABLE',
    blocking: Object.freeze(blocking),
    weakening: Object.freeze(weakening),
    optional: Object.freeze(optional),
    // What the case study could reach with this baseline, evidence aside.
    ceiling: blocking.length ? 'NOT_READY'
      : (grade === 'MEASURED' && doc.reviewedBy) ? 'STRONG' : 'DEFENSIBLE',
  });
}
