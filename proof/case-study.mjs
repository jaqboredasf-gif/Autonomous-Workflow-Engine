// ---------------------------------------------------------------------------
// case-study.mjs — one truth, many projections.
//
// The presentation layer is not the source of truth. A case study, a customer
// ROI report, an AXIS answer and a slide are the SAME derivation rendered
// differently, so the derivation lives here — once, testable, with no HTML in
// it — and every surface reads this.
//
// Two functions, and the second is the reason the first is trustworthy:
//
//   caseStudy(...)  the figures, with every unknown named as unknown.
//   explain(...)    the audit chain behind any one figure, so that
//                   "AWE returned 37.4 hours" can be answered with
//                   "here is where each of them came from" rather than
//                   "the dashboard says so".
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { aggregate } from './ledger.mjs';
import { baselineGrade, baselineHandlingMinutes } from './baseline.mjs';
import { present } from './provenance.mjs';

/**
 * The deployment case study for one organization, one capability, one period.
 *
 * Every field is either a figure with a grade or an explicit unknown. There is
 * no field that renders as a plausible zero, and `unknown` collects, by name,
 * everything the reader should not assume was measured.
 */
export function caseStudy({
  orgId, orgName, capability, capabilityLabel,
  records, baselines, touchStandards, from, to, overheads = [],
  census = null,
}) {
  const total = aggregate({ orgId, records, baselines, touchStandards, from, to, overheads, capability });

  const baselinesUsed = baselines.filter((b) => total.baselinesUsed.includes(b.key));
  const objectiveAchieved = total.objectiveResults.ACHIEVED ?? 0;
  const objectiveKnown = objectiveAchieved + (total.objectiveResults.NOT_ACHIEVED ?? 0);

  const unknown = [];
  if (!total.grossHoursReturned.known) unknown.push({ metric: 'human hours returned', because: total.grossHoursReturned.basis });
  if (!total.labourValueCents.known) unknown.push({ metric: 'labour value returned', because: total.labourValueCents.basis });
  if (!total.claimedCents.known) unknown.push({ metric: 'money saved, protected or created', because: total.claimedCents.basis });
  if (total.cycle.savedSamples === 0) unknown.push({ metric: 'cycle-time improvement', because: 'no execution in the period could be compared against a measured pre-AWE elapsed time' });
  if ((total.objectiveResults.UNKNOWN ?? 0) > 0) {
    unknown.push({
      metric: 'objective success for some units of work',
      because: `${total.objectiveResults.UNKNOWN} unit(s) of work have not yet reached a state where the objective can be tested`,
    });
  }
  for (const [reason, count] of Object.entries(total.excluded)) {
    unknown.push({ metric: `value of ${count} unit(s) of work`, because: reason });
  }

  return Object.freeze({
    organization: { id: orgId, name: orgName },
    capability: { id: capability, label: capabilityLabel },
    period: total.period,

    // --- who is in the denominator, and who is missing from it ------------
    denominator: denominator(total, census),

    // --- what happened --------------------------------------------------
    executions: total.considered,
    unitsOfWork: total.unitsOfWork,
    executionOutcomes: total.executionOutcomes,
    retriesCollapsed: total.duplicatesCollapsed.length,

    // --- did the organization get what it wanted ------------------------
    // Reported as a fraction of what could be TESTED, never of everything.
    // A rate over a denominator that includes untestable cases is the same
    // arithmetic as counting an unknown as a success.
    objectiveSuccess: {
      achieved: objectiveAchieved,
      notAchieved: total.objectiveResults.NOT_ACHIEVED ?? 0,
      unknown: total.objectiveResults.UNKNOWN ?? 0,
      testable: objectiveKnown,
      rate: objectiveKnown ? objectiveAchieved / objectiveKnown : null,
    },

    humanInterventions: total.humanTouches,

    // --- what changed ---------------------------------------------------
    baseline: baselinesUsed.map((b) => ({
      key: b.key,
      process: b.process,
      unitOfWork: b.unitOfWork,
      handlingMinutes: baselineHandlingMinutes(b),
      grade: baselineGrade(b),
      steps: b.steps.map((s) => ({ id: s.id, label: s.label, minutes: present(s.minutes), grade: s.minutes.provenance })),
      reviewedBy: b.reviewedBy,
      reviewedAt: b.reviewedAt,
    })),
    observedHandling: total.minutesReturned,   // carries its own basis string
    // Human minutes spent on work that produced no claimable saving. Printed
    // beside the headline so "excluded" cannot be read as "free".
    unvaluedHumanMinutes: total.unvaluedHumanMinutes,
    hoursReturned: total.grossHoursReturned,
    overheadHours: total.overheadHours,
    netHoursReturned: total.netHoursReturned,
    cycle: total.cycle,

    // --- what it was worth ----------------------------------------------
    labourValueCents: total.labourValueCents,
    claimedCents: total.claimedCents,
    claims: total.claims,

    // --- how much to believe it ------------------------------------------
    confidence: total.confidence,
    coverage: total.coverage,
    gradeMix: total.gradeMix,
    evidenceClasses: evidenceClasses(baselinesUsed, total),
    evidenceSources: evidenceSources(total),
    unknown: Object.freeze(unknown),

    /** The ledger this was projected from, for anything that needs to drill in. */
    ledger: total,
  });
}

/**
 * EVERY ELIGIBLE UNIT OF WORK, ACCOUNTED FOR.
 *
 * THE FAILURE THIS EXISTS AGAINST is not dishonesty; it is arithmetic that
 * cannot see what it was not given. `aggregate()` counts the records it is
 * handed. Hand it the twenty-six purchases that went well and it reports
 * twenty-six, at high coverage, with no field anywhere reading "and four
 * others". Nobody has to decide to cherry-pick for a case study to be
 * cherry-picked.
 *
 * So the population is established from the SOURCE — a count over the
 * eligibility predicate, taken by the adapter before any record is read — and
 * every eligible unit lands in exactly one bucket here. `reconciled` is false
 * when the buckets do not add up to the census, and a case study that does not
 * reconcile cannot be graded DEFENSIBLE however good its numbers are.
 *
 * A census of `null` is not an error and is not a pass: it means nobody
 * established the population, and it is reported as `UNESTABLISHED`.
 */
function denominator(total, census) {
  const outcomes = total.executionOutcomes;
  const objectives = total.objectiveResults;

  const completed = outcomes.COMPLETED ?? 0;
  const failed = outcomes.FAILED ?? 0;
  const refused = outcomes.REFUSED ?? 0;
  const abandoned = outcomes.ABANDONED ?? 0;

  const buckets = Object.freeze({
    // The workflow ran AND the organization got what it wanted.
    objectiveAchieved: objectives.ACHIEVED ?? 0,
    // The workflow ran and the organization did not.
    objectiveNotAchieved: objectives.NOT_ACHIEVED ?? 0,
    // Ran, and the objective cannot be tested yet. NOT a success.
    objectiveNotYetTestable: objectives.UNKNOWN ?? 0,
    // Ran, and the right answer was "no" — a declined request is not a failure.
    objectiveNotApplicable: objectives.NOT_APPLICABLE ?? 0,
  });

  const reachedLedger = total.unitsOfWork;
  const eligible = census?.eligible ?? null;
  // Retries collapse into the unit of work they retried, so the census counts
  // attempts and the ledger counts units. The difference is stated, not netted.
  const collapsed = total.duplicatesCollapsed.reduce((t, c) => t + (c.attempts - 1), 0);
  const accountedFor = reachedLedger + collapsed;

  return Object.freeze({
    established: census !== null,
    rule: census?.rule ?? null,
    source: census?.source ?? null,
    eligible,
    reachedLedger,
    retriesFoldedIn: collapsed,
    accountedFor,
    missing: eligible === null ? null : eligible - accountedFor,
    reconciled: eligible === null ? false : eligible === accountedFor,

    // How the units that DID reach the ledger ended, by both questions the
    // model keeps apart. Reported together so a reader cannot see one without
    // the other.
    executionOutcomes: Object.freeze({ completed, failed, refused, abandoned }),
    objectiveOutcomes: buckets,

    // And which of them produced a value figure. `notValued` carries the
    // ledger's own reason codes, so "excluded" is never a silent bucket.
    valued: total.valued,
    notValued: total.excluded,
    coverage: total.coverage,
  });
}

/**
 * HOW EACH PART OF THE BASELINE WAS OBTAINED, kept apart.
 *
 * A reader is entitled to know that "nineteen minutes per purchase" is four
 * minutes somebody timed, nine minutes derived from dated paperwork and six
 * minutes Mike remembered — because those three deserve different amounts of
 * belief and averaging them into one number destroys that information for good.
 *
 * NO NEW TAXONOMY. The classes are the existing provenance grade paired with
 * the existing source kind, named in the words a person would use:
 *
 *   MEASURED             somebody observed it happening, with a clock
 *   HISTORICALLY_DERIVED computed from records that already existed
 *   EMPLOYEE_ESTIMATED   somebody's account of their own work
 *   INFERRED             derived from other quantities in this system
 *   UNKNOWN              nobody has established it
 *
 * Inventing a second five-word scale beside proof/provenance.mjs would
 * guarantee the two drift, so this is a projection of that one rather than a
 * rival to it.
 */
export function classOf(quantity) {
  if (!quantity || !quantity.known) return 'UNKNOWN';
  const kinds = new Set((quantity.sources ?? []).map((s) => s.kind));
  switch (quantity.provenance) {
    case 'MEASURED':
      return kinds.has('OBSERVED_TIMING') || kinds.has('SYSTEM_RECORD') ? 'MEASURED' : 'MEASURED';
    case 'ESTIMATED':
      return kinds.has('HISTORICAL_RECORD') || kinds.has('SAMPLED_MEASUREMENT')
        ? 'HISTORICALLY_DERIVED' : 'EMPLOYEE_ESTIMATED';
    case 'SELF_REPORTED':
      return 'EMPLOYEE_ESTIMATED';
    case 'INFERRED':
      return 'INFERRED';
    default:
      return 'UNKNOWN';
  }
}

export const EVIDENCE_CLASSES = Object.freeze([
  'MEASURED', 'HISTORICALLY_DERIVED', 'EMPLOYEE_ESTIMATED', 'INFERRED', 'UNKNOWN',
]);

function evidenceClasses(baselinesUsed, total) {
  const byClass = Object.fromEntries(EVIDENCE_CLASSES.map((c) => [c, { steps: 0, minutes: 0 }]));

  for (const b of baselinesUsed) {
    for (const step of b.steps) {
      const cls = classOf(step.minutes);
      byClass[cls].steps += 1;
      if (step.minutes.known) byClass[cls].minutes += step.minutes.value;
    }
  }

  const totalMinutes = Object.values(byClass).reduce((t, c) => t + c.minutes, 0);
  return Object.freeze({
    // The BASELINE's composition, which is where the belief actually rests:
    // the AWE-era side is machine-recorded, so the argument is always about
    // what the old process cost.
    baseline: Object.freeze(Object.fromEntries(EVIDENCE_CLASSES.map((c) => [c, Object.freeze({
      ...byClass[c],
      shareOfBaseline: totalMinutes ? byClass[c].minutes / totalMinutes : null,
    })]))),
    // The single word for the whole baseline: its weakest known part.
    weakest: EVIDENCE_CLASSES.filter((c) => c !== 'UNKNOWN')
      .reverse().find((c) => byClass[c].steps > 0) ?? 'UNKNOWN',
    unknownSteps: byClass.UNKNOWN.steps,
    // The headline figure's own grade, for the reader who reads nothing else.
    headline: classOf(total.grossHoursReturned),
  });
}

/** Every distinct source behind the period's figures, deduplicated. */
function evidenceSources(total) {
  const seen = new Map();
  const add = (q) => {
    for (const s of q?.sources ?? []) {
      const key = `${s.kind}:${s.ref}`;
      if (!seen.has(key)) seen.set(key, s);
    }
  };
  add(total.minutesReturned);
  add(total.labourValueCents);
  add(total.claimedCents);
  for (const v of total.valuations) {
    add(v.baselineMinutes);
    add(v.observedMinutes);
  }
  return Object.freeze([...seen.values()]);
}

/**
 * "AXIS, how do we know?"
 *
 * Walks one headline figure down to the executions, the baseline steps and the
 * recorded interactions it rests on. Returns a tree a caller can print at any
 * depth. This is the function that makes the whole system answerable rather
 * than merely correct.
 */
export function explain(study, metric = 'hoursReturned') {
  const total = study.ledger;
  const q = {
    hoursReturned: total.grossHoursReturned,
    netHoursReturned: total.netHoursReturned,
    labourValueCents: total.labourValueCents,
    claimedCents: total.claimedCents,
  }[metric];
  if (!q) throw new Error(`nothing named "${metric}" is explainable`);

  return Object.freeze({
    metric,
    value: present(q),
    unit: q.unit,
    grade: q.provenance,
    basis: q.basis,
    known: q.known,
    confidence: total.confidence,
    restsOn: {
      period: total.period,
      organization: total.orgId,
      unitsOfWork: total.unitsOfWork,
      valued: total.valued,
      notValued: total.excluded,
      baselines: study.baseline.map((b) => ({
        key: b.key,
        totalMinutes: present(b.handlingMinutes),
        grade: b.grade,
        steps: b.steps,
        reviewedBy: b.reviewedBy,
      })),
      touchStandards: total.touchStandardsUsed,
    },
    contributions: Object.freeze(total.valuations.map((v) => ({
      execution: v.executionId,
      unitOfWork: v.scopeKey,
      executionOutcome: v.executionOutcome,
      objective: v.objectiveResult,
      objectiveStatement: v.objective?.statement ?? null,
      baselineMinutes: present(v.baselineMinutes),
      observedMinutes: present(v.observedMinutes),
      minutesReturned: present(v.minutesReturned),
      grade: v.minutesReturned.provenance,
      why: v.minutesReturned.basis,
      excludedBecause: v.excludedBecause,
      humanTouches: v.humanTouchCount,
      foldedAttempts: v.foldedAttempts ?? 0,
    }))),
    sources: study.evidenceSources,
  });
}

/**
 * The plain-text form, for a terminal, an email, or a slide's speaker notes.
 * Deliberately here rather than in a UI: the wording of an economic claim is
 * part of the claim.
 */
export function render(study) {
  const L = [];
  const hrs = present(study.hoursReturned);
  const net = present(study.netHoursReturned);
  const money = present(study.labourValueCents);
  const pct = (r) => (r === null ? 'not measurable' : `${Math.round(r * 100)}%`);

  L.push(`${study.organization.name.toUpperCase()}`);
  L.push(`${study.capability.label}`);
  L.push('');
  L.push(`Period: ${study.period.from} to ${study.period.to}`);
  L.push('');
  L.push(`Executions:              ${study.executions}`);
  L.push(`Units of work:           ${study.unitsOfWork}${study.retriesCollapsed ? ` (${study.retriesCollapsed} retried)` : ''}`);
  L.push(`Objective achieved:      ${study.objectiveSuccess.achieved} / ${study.objectiveSuccess.testable} testable  (${pct(study.objectiveSuccess.rate)})`);
  L.push(`  not yet testable:      ${study.objectiveSuccess.unknown}`);
  L.push(`Human interventions:     ${study.humanInterventions}`);
  L.push('');
  for (const b of study.baseline) {
    const m = present(b.handlingMinutes);
    L.push(`Baseline handling time:  ${m === null ? `NOT MEASURED (per ${b.unitOfWork})` : `${m} min per ${b.unitOfWork}`}  [${b.grade}]`);
  }
  if (study.baseline.length === 0) L.push('Baseline handling time:  NOT MEASURED');
  L.push(`Human hours returned:    ${hrs === null ? 'NOT MEASURABLE' : hrs}  [${study.hoursReturned.provenance}]`);
  if (study.overheadHours) L.push(`Less period overhead:    ${present(study.overheadHours) ?? 'NOT MEASURED'} h`);
  L.push(`Net hours returned:      ${net === null ? 'NOT MEASURABLE' : net}`);
  L.push(`Human minutes spent on`);
  L.push(`  unvalued work:         ${present(study.unvaluedHumanMinutes) ?? 'not known'}`);
  L.push(`Cycle time (median):     ${study.cycle.observedMedianHours === null ? 'no data' : `${study.cycle.observedMedianHours.toFixed(1)} h`} over ${study.cycle.observedSamples} sample(s)`);
  L.push(`Cycle time saved:        ${study.cycle.savedMedianHours === null ? 'NOT MEASURABLE' : `${study.cycle.savedMedianHours.toFixed(1)} h`} over ${study.cycle.savedSamples} sample(s)`);
  L.push(`Labour value returned:   ${money === null ? 'NOT MEASURABLE' : `$${(money / 100).toFixed(2)}`}  [${study.labourValueCents.provenance}]`);
  L.push('');
  L.push(`Evidence confidence:     ${study.confidence.level}`);
  for (const r of study.confidence.reasons) L.push(`  · ${r}`);
  L.push('');
  L.push(`Evidence sources (${study.evidenceSources.length}):`);
  for (const s of study.evidenceSources.slice(0, 12)) L.push(`  · [${s.kind}] ${s.ref}`);
  if (study.evidenceSources.length > 12) L.push(`  · … ${study.evidenceSources.length - 12} more`);
  L.push('');
  L.push(`Unknown (${study.unknown.length}):`);
  for (const u of study.unknown) L.push(`  · ${u.metric} — ${u.because}`);
  return L.join('\n');
}
