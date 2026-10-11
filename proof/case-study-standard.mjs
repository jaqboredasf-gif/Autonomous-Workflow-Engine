// ---------------------------------------------------------------------------
// case-study-standard.mjs — the rules for AWE Case Study #001, frozen before
// anybody has seen a number.
//
// WHY THIS FILE EXISTS AND WHY IT IS SEPARATE FROM `caseStudy()`.
//
// `caseStudy()` must ALWAYS produce a truthful projection, including the
// projection that says nothing is measurable. Making it refuse to render a weak
// result would confuse two different questions — "what does the evidence say"
// and "is this good enough to publish" — and would make the honest answer
// harder to obtain than the flattering one. So the projection is unconditional
// and this file grades it.
//
// THE FAILURE MODE THIS IS BUILT AGAINST is not fraud. It is the ordinary human
// sequence: run the numbers, find 26 of 30 workflows went well, and decide —
// sincerely — that the four that did not were "not really representative". Every
// step of that reasoning feels like judgement rather than like moving the goal
// posts, and the result is a case study that cannot survive one hard question.
//
// The defence is chronological, not moral: the thresholds, the denominator
// policy, the exclusion policy and the incomplete-workflow policy are written
// HERE, with a version and a date, before any production execution exists. A
// test asserts that no threshold is derived from an observation. Changing one
// afterwards means bumping `version` and leaving the old entry visible, so the
// change is a thing somebody did rather than a thing that was always true.
//
// FOUR GRADES, and they rank EVIDENCE rather than results:
//
//   NOT_READY   the claim cannot be made at all
//   PARTIAL     something true can be said, and it is not a case study
//   DEFENSIBLE  a skeptical reader can check it and will find it holds
//   STRONG      as above, and the weakest input is a measurement
//
// A case study reporting that AWE returned NO time can be STRONG. A case study
// reporting a large saving from six workflows and an employee's recollection
// cannot be better than PARTIAL. That asymmetry is the whole point: the grade
// answers "how much should you believe this", never "how good is the news".
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { PROVENANCE_GRADES, present } from './provenance.mjs';

export const GRADES = Object.freeze(['NOT_READY', 'PARTIAL', 'DEFENSIBLE', 'STRONG']);
const RANK = new Map(GRADES.map((g, i) => [g, i]));

/**
 * THE STANDARD. Every number below is a constant chosen from what the
 * measurement architecture requires, before any production data existed.
 *
 * `effectiveFrom` predates the first possible production execution, which is
 * the point: it is checkable that these rules were not written after the fact.
 */
export const STANDARD = Object.freeze({
  id: 'awe_case_study_001',
  version: '1.0.0',
  effectiveFrom: '2026-08-31T00:00:00Z',
  organization: 'lippolis',
  capability: 'purchasing',

  // --- how many, and why that many -----------------------------------------
  //
  // NOT "thirty because a document said thirty". Thirty is where
  // `confidenceOf()` in ledger.mjs stops capping confidence at MODERATE, and
  // ten is where it stops capping at LOW. Those two numbers already govern
  // every figure this system produces, so the case-study standard adopts them
  // rather than introducing a third opinion about sample size.
  //
  // The honest limit of that reasoning, stated so nobody overclaims: these are
  // thresholds for how much weight a median deserves, not a statistical power
  // calculation. Thirty purchase requests is a small sample of a real process
  // and this system says so — it caps confidence, it does not compute a
  // p-value, and a case study built on thirty units should be read as "this is
  // what happened in these thirty", not "this is what always happens".
  minimumValuedUnits: { defensible: 10, strong: 30 },

  // Coverage: the share of eligible units that produced a value figure. A
  // total derived from a minority of the period describes a minority of the
  // period, whatever its confidence.
  minimumCoverage: { defensible: 0.5, strong: 0.8 },

  // --- the denominator policy, fixed in advance ----------------------------
  denominator: Object.freeze({
    // WHO COUNTS. Stated as a rule over the source, not as a filter somebody
    // applies: every unit of work the organization began in the period, in the
    // capability, whatever became of it.
    eligibility: 'every unit of work the organization began in the period, in this capability, whatever became of it',

    // The population must be established from the SOURCE and must reconcile
    // with what reached the ledger. Without this the arithmetic cannot see
    // what it was not given.
    requireCensus: true,
    requireReconciliation: true,

    // FAILURES ARE IN THE STORY. A case study may not be graded above
    // NOT_READY if failed or abandoned executions were removed from the
    // population rather than reported in it.
    failuresMustBeReported: true,

    // INCOMPLETE WORK IS NOT A SUCCESS AND NOT A FAILURE. A unit whose
    // objective cannot yet be tested is reported in its own bucket and is
    // excluded from the success RATE — never counted as either outcome, and
    // never quietly dropped from the denominator.
    incomplete: 'reported in its own bucket; excluded from the success rate; never dropped from the population',

    // EXCLUSIONS ARE ENUMERATED, BY REASON, FROM THE LEDGER'S OWN CODES. A
    // case study may exclude a unit from VALUATION — there is no baseline in
    // force, the objective is untestable — and may never exclude one from the
    // population.
    exclusionsMustCarryReasons: true,
    maximumUnexplainedExclusions: 0,
  }),

  // --- what evidence must exist --------------------------------------------
  evidence: Object.freeze({
    // The database must have declared itself production at creation. A
    // rehearsal carries the real company name and the real organization id.
    requireProductionIdentity: true,

    // A baseline must be in force, and it must be one somebody reviewed. An
    // unreviewed baseline is one person's afternoon.
    requireBaseline: true,
    requireBaselineReview: { defensible: true, strong: true },

    // The capability must record every human action against an execution. A
    // partial trail under-counts human time, which over-states hours returned.
    requireCompleteHumanTouchRecord: true,

    // The objective must be testable and tested for at least some units.
    // "It ran" is not "they got what they wanted".
    requireObjectiveOutcomes: true,

    // The weakest input to the headline figure.
    weakestAcceptableGrade: { defensible: 'SELF_REPORTED', strong: 'MEASURED' },
  }),

  // --- what must be disclosed, whatever the numbers say --------------------
  disclosure: Object.freeze({
    unknownsNamed: true,
    evidenceClassBreakdown: true,
    negativeResultsPreserved: true,
    auditTraceAvailable: true,
  }),
});

/**
 * Grade a produced case study against the standard.
 *
 * Returns the grade, every rule that failed with what it wanted and what it
 * found, and the sentence that may honestly be said at this grade.
 *
 * @param {object} study    the output of caseStudy()
 * @param {object} facts    things the study cannot know about itself
 * @param {string} facts.environment          what the source database declared
 * @param {boolean} facts.humanTouchRecordComplete
 */
export function gradeCaseStudy(study, facts = {}, standard = STANDARD) {
  const failed = [];
  const met = [];
  const record = (ok, id, wanted, found, blocks) => {
    (ok ? met : failed).push(Object.freeze({ id, wanted, found, blocks }));
    return ok;
  };

  const d = study.denominator ?? {};
  const valued = d.valued ?? 0;
  const coverage = d.coverage ?? null;
  const S = standard;

  // --- things that make the claim impossible, not merely weak --------------
  record(facts.environment === 'production',
    'production_identity',
    'the source database declared itself production when it was created',
    facts.environment ? `declared "${facts.environment}"` : 'no environment was established',
    'NOT_READY');

  record(d.established === true,
    'population_established',
    'the eligible population is counted at the source, not inferred from the records supplied',
    d.established ? d.rule : 'no census was taken — nothing establishes what was left out',
    'NOT_READY');

  record(d.reconciled === true,
    'population_reconciles',
    'every eligible unit is accounted for',
    d.eligible === null
      ? 'no population to reconcile against'
      : `${d.eligible} eligible, ${d.accountedFor} accounted for, ${d.missing} unexplained`,
    'NOT_READY');

  record(facts.humanTouchRecordComplete === true,
    'human_touch_record_complete',
    'the capability records every human action against an execution',
    facts.humanTouchRecordComplete === false
      ? 'the trail is partial, so human time is under-counted and hours returned over-stated'
      : 'not established',
    'NOT_READY');

  const baselines = study.baseline ?? [];
  record(baselines.length > 0 && baselines.some((b) => b.handlingMinutes?.known),
    'baseline_in_force',
    'a measured baseline governs the work',
    baselines.length === 0 ? 'no baseline was in force' : 'a baseline exists and its handling time is not known',
    'NOT_READY');

  // FAILURES IN THE STORY. The population reconciling is what proves nothing
  // was removed; this asserts the buckets are actually reported.
  const outcomes = d.executionOutcomes ?? {};
  record(typeof outcomes.failed === 'number' && typeof outcomes.abandoned === 'number',
    'failures_reported',
    'failed and abandoned executions appear in the projection',
    'the projection does not report them',
    'NOT_READY');

  // --- things that decide DEFENSIBLE ---------------------------------------
  record(valued >= S.minimumValuedUnits.defensible,
    'minimum_units_defensible',
    `at least ${S.minimumValuedUnits.defensible} valued units of work`,
    `${valued}`,
    'PARTIAL');

  record(coverage !== null && coverage >= S.minimumCoverage.defensible,
    'minimum_coverage_defensible',
    `at least ${Math.round(S.minimumCoverage.defensible * 100)}% of eligible units valued`,
    coverage === null ? 'no coverage figure' : `${Math.round(coverage * 100)}%`,
    'PARTIAL');

  record((study.objectiveSuccess?.testable ?? 0) > 0,
    'objectives_tested',
    'the objective was tested for at least some units — "it ran" is not "they got what they wanted"',
    `${study.objectiveSuccess?.testable ?? 0} testable`,
    'PARTIAL');

  record(study.hoursReturned?.known === true,
    'headline_figure_exists',
    'a human-hours-returned figure can be stated at all',
    study.hoursReturned?.basis ?? 'not computed',
    'PARTIAL');

  const unexplained = Object.entries(study.denominator?.notValued ?? {})
    .filter(([reason]) => !reason || reason === 'null' || reason === 'none').length;
  record(unexplained <= S.denominator.maximumUnexplainedExclusions,
    'exclusions_explained',
    'every unit excluded from valuation carries the ledger\'s reason for it',
    `${unexplained} exclusion(s) with no reason`,
    'PARTIAL');

  const headlineGrade = study.hoursReturned?.provenance ?? 'UNAVAILABLE';
  record(gradeAtLeast(headlineGrade, S.evidence.weakestAcceptableGrade.defensible),
    'evidence_grade_defensible',
    `the weakest input to the headline is at least ${S.evidence.weakestAcceptableGrade.defensible}`,
    headlineGrade,
    'PARTIAL');

  // --- things that decide STRONG -------------------------------------------
  record(valued >= S.minimumValuedUnits.strong,
    'minimum_units_strong',
    `at least ${S.minimumValuedUnits.strong} valued units of work`,
    `${valued}`,
    'DEFENSIBLE');

  record(coverage !== null && coverage >= S.minimumCoverage.strong,
    'minimum_coverage_strong',
    `at least ${Math.round(S.minimumCoverage.strong * 100)}% of eligible units valued`,
    coverage === null ? 'no coverage figure' : `${Math.round(coverage * 100)}%`,
    'DEFENSIBLE');

  record(gradeAtLeast(headlineGrade, S.evidence.weakestAcceptableGrade.strong),
    'evidence_grade_strong',
    `the weakest input to the headline is ${S.evidence.weakestAcceptableGrade.strong}`,
    headlineGrade,
    'DEFENSIBLE');

  record(baselines.every((b) => Boolean(b.reviewedBy)),
    'baseline_reviewed',
    'somebody other than its author reviewed the baseline',
    baselines.some((b) => !b.reviewedBy) ? 'at least one baseline is unreviewed' : 'reviewed',
    'DEFENSIBLE');

  // --- the grade -----------------------------------------------------------
  // The worst thing that failed sets the ceiling. Nothing averages.
  let grade = 'STRONG';
  for (const f of failed) grade = worse(grade, f.blocks);

  return Object.freeze({
    standard: { id: S.id, version: S.version, effectiveFrom: S.effectiveFrom },
    grade,
    met: Object.freeze(met),
    failed: Object.freeze(failed),
    // What may honestly be said at this grade. The wording is part of the claim.
    permittedClaim: PERMITTED_CLAIM[grade],
    // The one sentence a reader wants: what would raise it.
    toRaise: Object.freeze(failed.filter((f) => f.blocks === ceilingOf(grade)).map((f) => f.wanted)),
  });
}

const PERMITTED_CLAIM = Object.freeze({
  NOT_READY: 'Nothing may be claimed about value. Say what ran and what is missing, and nothing else.',
  PARTIAL: 'Report what happened — executions, outcomes, interventions — and report the value figure as an indication over a named, small number of units. Do not lead with it and do not annualise it.',
  DEFENSIBLE: 'State the figure, with its denominator, its evidence grade and its unknowns beside it. A skeptical reader can check it and will find it holds.',
  STRONG: 'State the figure. Its weakest input is a measurement, the population reconciles, and the audit trace answers "how do you know" down to individual executions.',
});

function ceilingOf(grade) {
  return { NOT_READY: 'NOT_READY', PARTIAL: 'PARTIAL', DEFENSIBLE: 'DEFENSIBLE', STRONG: 'STRONG' }[grade];
}
function worse(a, b) {
  return RANK.get(a) <= RANK.get(b) ? a : b;
}
function gradeAtLeast(actual, wanted) {
  const order = PROVENANCE_GRADES;
  const ai = order.indexOf(actual);
  const wi = order.indexOf(wanted);
  return ai !== -1 && wi !== -1 && ai <= wi;
}

/** The grading as text. Leads with what would raise it, because that is the use. */
export function renderGrade(g, study = null) {
  const L = [];
  L.push(`CASE STUDY GRADE: ${g.grade}`);
  L.push(`  standard ${g.standard.id} v${g.standard.version}, fixed ${g.standard.effectiveFrom.slice(0, 10)}`);
  L.push('');
  L.push(`  ${g.permittedClaim}`);
  if (study) {
    L.push('');
    L.push(`  headline: ${study.hoursReturned?.known
      ? `${present(study.hoursReturned)} human hours returned [${study.hoursReturned.provenance}]`
      : 'NOT MEASURABLE'}`);
  }
  if (g.failed.length) {
    L.push('');
    L.push('  NOT MET');
    for (const f of g.failed) {
      L.push(`    · ${f.wanted}`);
      L.push(`        found: ${f.found}   (caps the grade at ${f.blocks})`);
    }
  }
  L.push('');
  L.push(`  ${g.met.length} of ${g.met.length + g.failed.length} rules met.`);
  return L.join('\n');
}
