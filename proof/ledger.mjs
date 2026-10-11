// ---------------------------------------------------------------------------
// ledger.mjs — many executions, one defensible total.
//
// Aggregation is where an honest per-execution figure becomes a dishonest
// headline. Every mistake this module guards against is one that produces a
// LARGER number, which is why each guard is a refusal rather than a warning:
//
//   DOUBLE COUNTING       two executions on the same real-world thing — a
//                         retry, a resubmission, a second capability touching
//                         the same request — each banking the whole saving.
//                         Prevented by `scopeKey`: one unit of work is banked
//                         once, and the ledger reports how many duplicates it
//                         collapsed.
//
//   SELECTION BIAS        totalling only the executions that could be valued
//                         and printing that as the period's result. Prevented
//                         by reporting `considered` against `valued` and the
//                         reason for every exclusion, and by capping confidence
//                         on low coverage.
//
//   EXCLUDED FAILURES     failures quietly dropped. Prevented at source:
//                         `value.mjs` gives an unachieved objective a NEGATIVE
//                         return, and this module sums it in.
//
//   BASELINE DRIFT        a period spanning two baseline versions blended into
//                         one comparison. Prevented by reporting the versions
//                         a total rests on; a total resting on more than one is
//                         labelled, not hidden.
//
//   UNCOUNTED OVERHEAD    the hours spent deploying and maintaining AWE never
//                         subtracted. Prevented by `overheads`, which are
//                         period costs and are deducted from the period total.
//
//   TENANT LEAKAGE        one organization's executions in another's total.
//                         Prevented by requiring an orgId and throwing on any
//                         record that does not match it.
//
// PURE: no clock, no randomness, no I/O. The period is supplied by the caller.
// ---------------------------------------------------------------------------

import { assertNoOverlap } from './baseline.mjs';
import { EXCLUSION_REASONS, valueOf } from './value.mjs';
import {
  gradeMix, present, quantity, source, sum, toHours, unavailable, weakestOf,
} from './provenance.mjs';

/**
 * A period cost that must come off the top: deployment, maintenance, training,
 * the hours somebody spends administering the tool.
 *
 * These are NOT per-execution and pretending otherwise (by dividing them across
 * executions) hides them — a busy month would show a smaller unit overhead and
 * a bigger apparent saving purely from volume.
 */
export function overhead({ label, hours, provenance, sources = [], note = null }) {
  return Object.freeze({
    label, note,
    hours: quantity({
      value: provenance === 'UNAVAILABLE' ? null : hours,
      unit: 'hours', provenance, sources,
      basis: `period overhead: ${label}`,
    }),
  });
}

/**
 * Total a period.
 *
 * @param {object} spec
 * @param {string} spec.orgId       required. Every record must match it.
 * @param {Array}  spec.records     ExecutionRecords
 * @param {Array}  spec.baselines
 * @param {Array}  spec.touchStandards
 * @param {string} spec.from        ISO instant, inclusive
 * @param {string} spec.to          ISO instant, exclusive
 * @param {Array}  [spec.overheads]
 * @param {string} [spec.capability] narrow to one capability
 */
export function aggregate({
  orgId, records, baselines, touchStandards, from, to,
  overheads = [], capability = null,
}) {
  if (!orgId) throw new Error('an aggregate must name the organization it is about');
  if (!from || !to) throw new Error('an aggregate must state its period');

  for (const r of records) {
    if (r.orgId !== orgId) {
      throw new Error(`tenant violation: aggregate for ${orgId} was handed execution ${r.id} belonging to ${r.orgId}`);
    }
  }

  // Overlapping baselines are refused at the point they would be used, not
  // merely made checkable. Two baselines for this organization that price the
  // same human work would each return it.
  assertNoOverlap(baselines.filter((b) => b.orgId === orgId));

  const inPeriod = records.filter((r) =>
    String(r.startedAt) >= String(from) && String(r.startedAt) < String(to) &&
    (capability === null || r.capability === capability));

  const valuations = inPeriod.map((r) => valueOf(r, { baselines, touchStandards }));

  // --- double-count prevention --------------------------------------------
  // One unit of real-world work banks once. When several executions share a
  // scopeKey the LAST-STARTED valued one wins: a retry that finally achieved
  // the objective is the execution that displaced the baseline work, and the
  // earlier attempts' human minutes are folded in as cost so a retry is never
  // free.
  //
  // Keyed on the BASELINE and the unit of work, deliberately NOT on the
  // capability. Two capabilities that both produce a record for one purchase
  // request, measured against one baseline, are two claims on the same human
  // minutes; keying by capability would let each bank them. Different baselines
  // may both bank the same unit of work only because `assertNoOverlap` below
  // has already proven they price different steps.
  const byScope = new Map();
  for (const v of valuations) {
    const key = `${v.baselineKey ?? 'no-baseline'}:${v.scopeKey}`;
    const bucket = byScope.get(key) ?? [];
    bucket.push(v);
    byScope.set(key, bucket);
  }

  const banked = [];
  const collapsed = [];
  for (const [key, group] of byScope) {
    if (group.length === 1) { banked.push(group[0]); continue; }
    const ordered = [...group].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const winner = [...ordered].reverse().find((v) => v.valued) ?? ordered.at(-1);
    const losers = ordered.filter((v) => v !== winner);
    banked.push(withAttemptCost(winner, losers));
    collapsed.push({ scope: key, attempts: group.length, banked: winner.executionId, folded: losers.map((l) => l.executionId) });
  }

  // --- the totals -----------------------------------------------------------
  const valued = banked.filter((v) => v.valued);
  const excluded = banked.filter((v) => !v.valued);

  const minutesReturned = sum(valued.map((v) => v.minutesReturned), {
    unit: 'minutes',
    basis: `${orgId}${capability ? ` / ${capability}` : ''}: human minutes returned, ${from} to ${to}`,
  });
  const grossHoursReturned = toHours(minutesReturned);

  const overheadHours = sum(overheads.map((o) => o.hours), {
    unit: 'hours',
    basis: `${orgId}: period overhead, ${from} to ${to}`,
  });

  // Overhead that is UNAVAILABLE does not zero out. A period with an unmeasured
  // overhead reports a GROSS figure and refuses to report a net one, because a
  // net figure computed with an unknown deduction is a gross figure wearing the
  // word "net".
  const netHoursReturned = overheads.length === 0
    ? grossHoursReturned
    : (overheadHours.known && grossHoursReturned.known
        ? quantity({
            value: grossHoursReturned.value - overheadHours.value,
            unit: 'hours',
            provenance: weakestOf([grossHoursReturned.provenance, overheadHours.provenance]),
            sources: [...grossHoursReturned.sources, ...overheadHours.sources],
            basis: `${orgId}: hours returned after ${present(overheadHours)} h of period overhead`,
          })
        : unavailable('hours', `${orgId}: net hours cannot be stated — ${overheadHours.known ? 'the gross figure' : 'the period overhead'} is not known`));

  const labourValueCents = sum(valued.map((v) => v.labourValueCents), {
    unit: 'cents',
    basis: `${orgId}: labour value of time returned, ${from} to ${to}`,
  });

  // Human minutes that were spent and produced no claimable saving: declined
  // requests, executions still in flight, work with no measured baseline. This
  // figure exists so that "excluded" never reads as "free". It is a COST and it
  // is reported beside the total rather than folded into it, because folding it
  // in would value work against a baseline that does not price it.
  const unvaluedHumanMinutes = sum(
    excluded.map((v) => v.observedMinutes).filter((q) => q.known),
    { unit: 'minutes', basis: `${orgId}: human minutes spent on units of work that could not be valued, ${from} to ${to}` },
  );

  const claims = banked.flatMap((v) => v.claims.filter((c) => c.countsTowardTotal));
  const claimedCents = sum(claims.map((c) => c.amount), {
    unit: 'cents',
    basis: `${orgId}: money claimed by attributed business outcomes, ${from} to ${to}`,
  });

  // --- objective and execution success, kept apart -------------------------
  const objectives = tally(banked.map((v) => v.objectiveResult));
  const executions = tally(banked.map((v) => v.executionOutcome));

  const coverage = banked.length === 0 ? null : valued.length / banked.length;

  return Object.freeze({
    orgId,
    capability,
    period: { from, to },

    // Which executions a period contains is a convention, and a convention
    // nobody stated is a convention somebody will disagree with after the
    // figures are published. An execution belongs to the period it STARTED in.
    // Work that began in one month and finished in the next is counted once, in
    // the first — never split, never counted twice, never dropped.
    boundaryConvention: 'execution belongs to the period containing its start',
    considered: inPeriod.length,
    unitsOfWork: banked.length,
    duplicatesCollapsed: Object.freeze(collapsed),
    valued: valued.length,
    excluded: Object.freeze(countBy(excluded.map((v) => v.excludedBecause))),
    coverage,

    executionOutcomes: Object.freeze(executions),
    objectiveResults: Object.freeze(objectives),
    humanTouches: banked.reduce((t, v) => t + v.humanTouchCount, 0),

    baselinesUsed: Object.freeze([...new Set(banked.map((v) => v.baselineKey).filter(Boolean))]),
    touchStandardsUsed: Object.freeze([...new Set(banked.map((v) => v.touchStandardKey).filter(Boolean))]),

    minutesReturned,
    unvaluedHumanMinutes,
    grossHoursReturned,
    overheadHours: overheads.length ? overheadHours : null,
    netHoursReturned,
    labourValueCents,
    claimedCents,
    claims: Object.freeze(claims),

    cycle: cycleSummary(banked),
    gradeMix: Object.freeze(gradeMix(valued.map((v) => v.minutesReturned))),
    confidence: confidenceOf({ coverage, valued, banked, netHoursReturned }),
    valuations: Object.freeze(banked),
  });
}

/**
 * Fold failed attempts' human cost into the attempt that finally counted.
 *
 * Without this, a workflow that fails four times and succeeds on the fifth
 * reports the same saving as one that worked first time. The retries were real
 * human minutes.
 */
function withAttemptCost(winner, losers) {
  const cost = losers
    .map((l) => l.observedMinutes)
    .filter((q) => q.known)
    .reduce((t, q) => t + q.value, 0);
  const anyUnknown = losers.some((l) => !l.observedMinutes.known);

  if (!winner.valued) return Object.freeze({ ...winner, foldedAttempts: losers.length });
  if (anyUnknown) {
    return Object.freeze({
      ...winner,
      valued: false,
      excludedBecause: 'touches_not_priced',
      foldedAttempts: losers.length,
      minutesReturned: unavailable('minutes', `${winner.scopeKey}: an earlier attempt's human cost is not priced, so the net saving on this unit of work is unknown`),
      hoursReturned: unavailable('hours', `${winner.scopeKey}: an earlier attempt's human cost is not priced`),
      labourValueCents: unavailable('cents', `${winner.scopeKey}: an earlier attempt's human cost is not priced`),
    });
  }
  const minutesReturned = quantity({
    value: winner.minutesReturned.value - cost,
    unit: 'minutes',
    provenance: weakestOf([winner.minutesReturned.provenance, ...losers.map((l) => l.observedMinutes.provenance)]),
    sources: [...winner.minutesReturned.sources, source({ kind: 'DERIVED', ref: `${losers.length} earlier attempt(s) on ${winner.scopeKey}` })],
    basis: `${winner.minutesReturned.basis}, less ${cost} min spent on ${losers.length} earlier attempt(s)`,
  });
  const hoursReturned = toHours(minutesReturned);
  return Object.freeze({
    ...winner,
    foldedAttempts: losers.length,
    minutesReturned,
    hoursReturned,
    labourValueCents: winner.labourValueCents.known && winner.hoursReturned.value !== 0
      ? quantity({
          value: (winner.labourValueCents.value / winner.hoursReturned.value) * hoursReturned.value,
          unit: 'cents',
          provenance: weakestOf([winner.labourValueCents.provenance, minutesReturned.provenance]),
          sources: [...winner.labourValueCents.sources],
          basis: `${winner.labourValueCents.basis}, adjusted for earlier attempts`,
        })
      : winner.labourValueCents,
  });
}

function cycleSummary(valuations) {
  const observed = valuations.map((v) => v.cycle?.observed).filter((q) => q?.known).map((q) => q.value);
  const saved = valuations.map((v) => v.cycle?.savedHours).filter((q) => q?.known).map((q) => q.value);
  return Object.freeze({
    observedMedianHours: medianOf(observed),
    observedSamples: observed.length,
    savedMedianHours: medianOf(saved),
    savedSamples: saved.length,
  });
}

function medianOf(values) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * How much a reader should trust the headline.
 *
 * DERIVED, never set — the same rule `deployment/evidence.mjs` applies to
 * readiness. The inputs are the two things that actually determine it: how much
 * of the period could be valued at all, and how the valued part was obtained.
 *
 * A small sample caps confidence regardless of grade. Nine perfectly measured
 * executions are still nine executions, and "MEASURED" on a sample of nine is
 * how a pilot's noise becomes a customer's expectation.
 */
export function confidenceOf({ coverage, valued, banked, netHoursReturned }) {
  const reasons = [];
  if (banked.length === 0) return Object.freeze({ level: 'NONE', reasons: Object.freeze(['no executions in period']) });
  if (!netHoursReturned.known) {
    return Object.freeze({ level: 'NONE', reasons: Object.freeze([netHoursReturned.basis]) });
  }

  const grade = weakestOf(valued.map((v) => v.minutesReturned.provenance));
  let level =
    grade === 'MEASURED' ? 'HIGH'
    : grade === 'ESTIMATED' ? 'MODERATE'
    : grade === 'INFERRED' ? 'LOW'
    : 'LOW';
  reasons.push(`the weakest input to the total is ${grade}`);

  if (coverage !== null && coverage < 0.8) {
    level = cap(level, 'MODERATE');
    reasons.push(`only ${Math.round(coverage * 100)}% of units of work in the period could be valued`);
  }
  if (coverage !== null && coverage < 0.5) {
    level = cap(level, 'LOW');
    reasons.push('fewer than half the units of work could be valued — the total describes a minority of the period');
  }
  if (valued.length < 30) {
    level = cap(level, 'MODERATE');
    reasons.push(`${valued.length} valued unit(s) of work is a small sample`);
  }
  if (valued.length < 10) {
    level = cap(level, 'LOW');
    reasons.push('fewer than ten valued units of work — this is an indication, not a measurement');
  }
  return Object.freeze({ level, reasons: Object.freeze(reasons) });
}

const ORDER = ['NONE', 'LOW', 'MODERATE', 'HIGH'];
function cap(level, ceiling) {
  return ORDER.indexOf(level) > ORDER.indexOf(ceiling) ? ceiling : level;
}

function tally(values) {
  return countBy(values);
}

function countBy(values) {
  const out = {};
  for (const v of values) {
    const key = v ?? 'none';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export { EXCLUSION_REASONS };
