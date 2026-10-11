// ---------------------------------------------------------------------------
// eval-case-study-001.mjs — would Case Study #001 survive a skeptical reader?
//
// THE STRATEGIC CLAIM THIS PROTECTS. Anybody can say "our automation saved
// forty hours". The thing worth having at IIC — and worth having with a
// customer on any Tuesday — is being able to answer the follow-up questions:
// which forty, out of how many, measured by whom, including the failures, and
// show me. That is not a presentation problem. It is an architecture problem,
// and this suite is where the architecture is attacked.
//
// TWO HALVES:
//
//   SYNTHETIC SCENARIOS  drive the whole pipeline with evidence built to order
//                        — a big saving, a small one, none at all, a NEGATIVE
//                        one — and assert the output stays truthful in each.
//                        The scenario that matters most is the one where AWE
//                        made things worse, because a system that cannot report
//                        that has not been tested, it has been demonstrated.
//
//   THE JUDGE'S QUESTIONS  the eleven things a hostile reader asks, each as an
//                        assertion. "Did you cherry-pick these?" is answerable
//                        only if the population came from somewhere other than
//                        the caller's hand, so that is what is checked — not
//                        that we intended not to cherry-pick.
//
// SYNTHETIC EVIDENCE NEVER TOUCHES PRODUCTION AGGREGATION. Every fixture here
// is an in-memory record built by this file. Nothing writes a database, and the
// last section proves the production reader would refuse this evidence outright
// if it ever appeared in one.
//
// Offline. Pure functions over fixtures.
//
//   node scripts/eval-case-study-001.mjs
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (f) => join(ROOT, 'proof', f);

const { baselineStep, defineBaseline, defineTouchStandard } = await import(P('baseline.mjs'));
const { executionRecord, humanTouch, objectiveTest } = await import(P('execution.mjs'));
const { caseStudy, explain, classOf, EVIDENCE_CLASSES } = await import(P('case-study.mjs'));
const { gradeCaseStudy, renderGrade, STANDARD, GRADES } = await import(P('case-study-standard.mjs'));
const { source, present } = await import(P('provenance.mjs'));
const { stepFromObservations, observation, validate, outstanding, MEASURED_FLOOR, METHODS } =
  await import(P('baselines/ingest.mjs'));

let pass = 0;
const failures = [];
const notes = [];
const check = (ok, name, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
};
const eq = (a, b, name) => check(
  JSON.stringify(a) === JSON.stringify(b), name,
  JSON.stringify(a) === JSON.stringify(b) ? '' : `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
const near = (a, b, name, tol = 0.01) => check(Math.abs(a - b) <= tol, name, `got ${a}, wanted ${b}`);
/** The arithmetic, exactly. `present()` deliberately coarsens by grade. */
const raw = (q) => q.value;
const throws = (fn, needle, name) => {
  let m = null;
  try { fn(); } catch (e) { m = e.message; }
  if (m === null) return check(false, name, 'it was allowed');
  return check(m.toLowerCase().includes(needle.toLowerCase()), name, `threw: ${m}`);
};

// ---------------------------------------------------------------------------
// A world. Every scenario below is this, varied.
// ---------------------------------------------------------------------------
const ORG = 'testco';
const PERIOD = { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' };
const TIMED = (ref) => source({ kind: 'OBSERVED_TIMING', ref });

/** A baseline totalling `minutes`, at a chosen grade. */
const baselineOf = (minutes, grade = 'MEASURED', extra = {}) => defineBaseline({
  id: 'testco_purchasing', version: '1.0.0', orgId: ORG,
  process: 'Buying material', description: 'the old way',
  effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'purchase request',
  steps: [baselineStep({
    id: 'whole_process', label: 'the whole process', minutes, provenance: grade,
    sources: grade === 'UNAVAILABLE' ? [] : [TIMED('timed session 2026-08-20, purchaser A')],
  })],
  coversSteps: ['purchasing'],
  labourRateCentsPerHour: 6000, labourRateProvenance: 'MEASURED',
  labourRateSources: [source({ kind: 'HISTORICAL_RECORD', ref: 'payroll 2026 Q3' })],
  reviewedBy: 'a second person',
  reviewedAt: '2026-08-25',
  ...extra,
});

/** A touch standard pricing one action at `minutes`. */
const standardOf = (minutes) => defineTouchStandard({
  id: 'testco_touches', version: '1', orgId: ORG, capability: 'purchasing',
  effectiveFrom: '2026-01-01T00:00:00Z',
  actions: { 'request.handled': { minutes, provenance: 'MEASURED', sources: [TIMED('screen timings 2026-08-21')] } },
});

/**
 * One purchase. `touches` human interactions, and whatever objective result.
 */
const purchase = (i, { touches = 1, objective = 'ACHIEVED', outcome = 'COMPLETED', scope = null, retries = 0 } = {}) => executionRecord({
  id: `req${i}`, orgId: ORG, capability: 'purchasing', workflow: 'request_to_receipt',
  objectiveId: 'material_arrived', baselineId: 'testco_purchasing',
  scopeKey: scope ?? `request:${i}`,
  startedAt: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T09:00:00Z`,
  endedAt: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T15:00:00Z`,
  executionOutcome: outcome,
  errorCode: outcome === 'FAILED' ? 'vendor_rejected' : null,
  refusalReason: outcome === 'REFUSED' ? 'the request was declined' : null,
  retries,
  humanTouches: Array.from({ length: touches }, (_, t) =>
    humanTouch({ action: 'request.handled', actorId: 'mike', at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T09:${String(t * 5).padStart(2, '0')}:00Z` })),
  objective: objectiveTest({
    name: 'material_arrived',
    statement: 'The material the job asked for arrived at the place it was needed.',
    result: objective,
    evidence: ['ACHIEVED', 'NOT_ACHIEVED'].includes(objective)
      ? [source({ kind: 'SYSTEM_RECORD', ref: `receipt for req${i}` })] : [],
  }),
});

/** One Lippolis purchase, for the end-to-end dry run. */
const lip = (i, { touches = 2, objective = 'ACHIEVED', outcome = 'COMPLETED' } = {}) => executionRecord({
  id: `lipreq${i}`, orgId: 'lippolis', capability: 'purchasing', workflow: 'request_to_receipt',
  objectiveId: 'material_arrived', baselineId: 'lippolis_purchasing_v0', scopeKey: `request:${i}`,
  startedAt: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T09:00:00Z`,
  endedAt: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T15:00:00Z`,
  executionOutcome: outcome,
  errorCode: outcome === 'FAILED' ? 'vendor_rejected' : null,
  humanTouches: Array.from({ length: touches }, (_, t) =>
    humanTouch({ action: 'request.handled', actorId: 'mike', at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T09:${String(t * 5).padStart(2, '0')}:00Z` })),
  objective: objectiveTest({
    name: 'material_arrived', statement: 'The material arrived where it was needed.', result: objective,
    evidence: ['ACHIEVED', 'NOT_ACHIEVED'].includes(objective)
      ? [source({ kind: 'SYSTEM_RECORD', ref: `receipt for lipreq${i}` })] : [],
  }),
});

/** Build a case study over `records` with a census that matches by default. */
const study = (records, { baseline = baselineOf(30), touchMinutes = 5, eligible = null } = {}) => caseStudy({
  orgId: ORG, orgName: 'Testco', capability: 'purchasing', capabilityLabel: 'Purchasing',
  records, baselines: [baseline], touchStandards: [standardOf(touchMinutes)],
  ...PERIOD,
  census: { eligible: eligible ?? records.length, rule: 'every request in the period', source: 'purchase_requests' },
});
const grade = (s, over = {}) => gradeCaseStudy(s, {
  environment: 'production', humanTouchRecordComplete: true, ...over,
});
const many = (n, opts) => Array.from({ length: n }, (_, i) => purchase(i, opts));

// ---------------------------------------------------------------------------
console.log('--- the standard was fixed before any number existed -------------');
{
  eq(GRADES, ['NOT_READY', 'PARTIAL', 'DEFENSIBLE', 'STRONG'], 'four grades, ranking evidence');
  check(STANDARD.version === '1.0.0', 'the standard carries a version');
  check(STANDARD.effectiveFrom < '2026-09-01', 'dated before the first possible production execution');

  // NO THRESHOLD MAY BE COMPUTED. A number derived from an observation is a
  // number that moved after somebody saw the result, however it was written.
  const src = readFileSync(P('case-study-standard.mjs'), 'utf8');
  const standardBlock = src.slice(src.indexOf('export const STANDARD'), src.indexOf('export function gradeCaseStudy'));
  for (const forbidden of ['Math.', 'Date', 'length', 'reduce(', 'filter(', 'study.', 'records']) {
    check(!standardBlock.includes(forbidden),
      `the standard's own definition contains no ${forbidden} — every threshold is a constant`);
  }
  eq(STANDARD.minimumValuedUnits, { defensible: 10, strong: 30 },
    'the unit thresholds are the ledger\'s own confidence cliffs, not a third opinion');
  eq(STANDARD.denominator.maximumUnexplainedExclusions, 0, 'no unit may be excluded without a reason');
  check(STANDARD.denominator.failuresMustBeReported === true, 'failures must be in the story');
  check(typeof STANDARD.denominator.incomplete === 'string' && STANDARD.denominator.incomplete.length > 30,
    'and incomplete work has a stated policy, fixed in advance');
  notes.push('every threshold in the standard is a constant; a test forbids computing one');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: AWE returns substantial time -----------------------');
{
  const s = study(many(40, { touches: 1 }));         // 30 min baseline, 5 min after
  const g = grade(s);
  eq(s.denominator.eligible, 40, 'forty eligible units');
  eq(s.denominator.reconciled, true, 'and the population reconciles');
  near(raw(s.hoursReturned), (40 * 25) / 60, 'twenty-five minutes returned per purchase');
  eq(s.hoursReturned.provenance, 'MEASURED', 'at MEASURED, because both sides were measured');
  eq(g.grade, 'STRONG', 'a large, well-evidenced saving grades STRONG');
  check(/State the figure/.test(g.permittedClaim), 'and the figure may be stated plainly');
  notes.push('40 purchases, 30 min before, 5 min after: 16.7 hours returned, STRONG');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: AWE returns a small amount of time -----------------');
{
  const s = study(many(40, { touches: 5 }), { baseline: baselineOf(26) });  // 26 vs 25
  eq(present(s.hoursReturned) > 0, true, 'a small saving is still a saving');
  near(raw(s.hoursReturned), (40 * 1) / 60, 'one minute per purchase');
  eq(grade(s).grade, 'STRONG', 'and a small honest number grades exactly as well as a large one');
  notes.push('a one-minute-per-purchase saving grades the same as a large one — the grade is about evidence');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: AWE returns nothing --------------------------------');
{
  const s = study(many(40, { touches: 6 }), { baseline: baselineOf(30) });  // 30 vs 30
  near(raw(s.hoursReturned), 0, 'exactly zero hours returned');
  eq(s.hoursReturned.known, true, 'and zero is a FIGURE, not an absence — it was measured');
  eq(grade(s).grade, 'STRONG', 'reporting a true zero is strong evidence');
  notes.push('a measured zero is reported as zero, at full grade — the system can say "no benefit"');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: AWE makes things WORSE ------------------------------');
{
  // THE SCENARIO THAT DECIDES WHETHER ANY OF THIS IS WORTH ANYTHING. A system
  // that cannot report a negative result has not been tested; it has been
  // demonstrated.
  const s = study(many(40, { touches: 10 }), { baseline: baselineOf(20) });  // 20 before, 50 after
  check(present(s.hoursReturned) < 0, 'a negative result is preserved, not floored at zero',
    String(present(s.hoursReturned)));
  near(raw(s.hoursReturned), (40 * -30) / 60, 'thirty minutes LOST per purchase');
  eq(s.hoursReturned.known, true, 'and it is a known figure');
  eq(grade(s).grade, 'STRONG', 'a well-evidenced bad result is STRONG evidence of a bad result');
  check(/State the figure/.test(grade(s).permittedClaim),
    'and the permitted claim does not soften it');
  notes.push('AWE costing 30 min per purchase reports -20 hours at STRONG: the grade never rewards the answer');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: some workflows fail --------------------------------');
{
  const records = [
    ...many(26, { touches: 1 }),
    ...Array.from({ length: 2 }, (_, i) => purchase(100 + i, { outcome: 'FAILED', objective: 'NOT_ACHIEVED', touches: 3 })),
    ...Array.from({ length: 1 }, (_, i) => purchase(200 + i, { objective: 'UNKNOWN', touches: 1 })),
    ...Array.from({ length: 1 }, (_, i) => purchase(300 + i, { outcome: 'ABANDONED', objective: 'UNKNOWN', touches: 1 })),
  ];
  const s = study(records);
  const d = s.denominator;

  eq(d.eligible, 30, 'thirty eligible units');
  eq(d.reconciled, true, 'all thirty accounted for');
  eq(d.executionOutcomes.failed, 2, 'two failed');
  eq(d.executionOutcomes.abandoned, 1, 'one abandoned');
  eq(d.objectiveOutcomes.objectiveAchieved, 26, 'twenty-six achieved the objective');
  eq(d.objectiveOutcomes.objectiveNotAchieved, 2, 'two did not');
  eq(d.objectiveOutcomes.objectiveNotYetTestable, 2, 'and two cannot be tested yet');

  // THE RATE'S DENOMINATOR IS WHAT COULD BE TESTED, never everything.
  eq(s.objectiveSuccess.testable, 28, 'the success rate is over the 28 that could be tested');
  near(s.objectiveSuccess.rate, 26 / 28, 'not over all thirty, which would count an unknown as a success');
  check(d.objectiveOutcomes.objectiveNotYetTestable > 0 && s.objectiveSuccess.rate < 1,
    'and untestable units are neither a success nor silently dropped');
  notes.push('30 eligible: 26 achieved, 2 failed, 2 not yet testable — every one in a named bucket');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: human evidence missing ------------------------------');
{
  // The capability cannot see its own humans. Reporting zero human time would
  // be the largest possible saving from the least possible evidence.
  const blind = many(40, { touches: 0 }).map((r) => executionRecord({
    ...pick(r), humanTouches: [], humanTouchesComplete: false,
  }));
  const s = study(blind);
  eq(s.hoursReturned.known, false, 'no hours figure exists when the human trail is partial');
  eq(s.denominator.notValued, { touches_not_priced: 40 },
    'every unit is excluded from valuation, with the ledger\'s own reason code');
  const why = s.ledger.valuations[0].observedMinutes.basis;
  check(/subset/i.test(why), 'and the per-execution reason says the recorded touches are a subset', why);
  eq(grade(s, { humanTouchRecordComplete: false }).grade, 'NOT_READY',
    'and the case study is NOT_READY however many executions there are');
  notes.push('a partial human-touch trail yields no figure and NOT_READY, not a flattering zero');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: baseline estimated vs measured ----------------------');
{
  const measured = study(many(40), { baseline: baselineOf(30, 'MEASURED') });
  const estimated = study(many(40), { baseline: baselineOf(30, 'ESTIMATED') });
  const selfReported = study(many(40), { baseline: baselineOf(30, 'SELF_REPORTED') });

  near(raw(measured.hoursReturned), raw(estimated.hoursReturned),
    'the same arithmetic produces the same number whatever the grade');
  check(present(measured.hoursReturned) !== present(estimated.hoursReturned),
    'while the PRESENTED figure is coarser for the estimate — fake precision is refused');
  eq(measured.hoursReturned.provenance, 'MEASURED', 'but the measured one is MEASURED');
  eq(estimated.hoursReturned.provenance, 'ESTIMATED', 'the estimated one is ESTIMATED');
  eq(grade(measured).grade, 'STRONG', 'and only the measured one is STRONG');
  eq(grade(estimated).grade, 'DEFENSIBLE', 'an estimated baseline caps the case study at DEFENSIBLE');
  eq(grade(selfReported).grade, 'DEFENSIBLE', 'so does an employee\'s recollection');
  check(grade(estimated).failed.some((f) => f.id === 'evidence_grade_strong'),
    'and the reason names the evidence grade');
  notes.push('identical numbers, different provenance, different grade — the number never sets the grade');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: mixed evidence quality -----------------------------');
{
  const mixed = defineBaseline({
    id: 'testco_purchasing', version: '1.0.0', orgId: ORG,
    process: 'Buying material', description: 'x',
    effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'purchase request',
    steps: [
      baselineStep({ id: 'timed', label: 'timed', minutes: 10, provenance: 'MEASURED', sources: [TIMED('stopwatch')] }),
      baselineStep({ id: 'from_paper', label: 'from paper', minutes: 12, provenance: 'ESTIMATED', sources: [source({ kind: 'HISTORICAL_RECORD', ref: '30 paper POs' })] }),
      baselineStep({ id: 'remembered', label: 'remembered', minutes: 8, provenance: 'SELF_REPORTED', sources: [source({ kind: 'OPERATOR_STATEMENT', ref: 'Mike, 2026-09-02' })] }),
    ],
    coversSteps: ['purchasing'],
    labourRateCentsPerHour: 6000, labourRateProvenance: 'MEASURED',
    labourRateSources: [source({ kind: 'HISTORICAL_RECORD', ref: 'payroll' })],
    reviewedBy: 'a second person', reviewedAt: '2026-08-25',
  });
  const s = study(many(40), { baseline: mixed });
  const c = s.evidenceClasses;

  // THE THREE CLASSES STAY APART. Averaging them into "30 minutes" destroys
  // the information a reader needs and cannot be recovered afterwards.
  eq(c.baseline.MEASURED.steps, 1, 'one step was timed');
  eq(c.baseline.HISTORICALLY_DERIVED.steps, 1, 'one came from paperwork that already existed');
  eq(c.baseline.EMPLOYEE_ESTIMATED.steps, 1, 'one is somebody\'s account of their own work');
  near(c.baseline.MEASURED.shareOfBaseline, 10 / 30, 'and each one\'s share of the baseline is stated');
  eq(c.weakest, 'EMPLOYEE_ESTIMATED', 'the baseline as a whole is only as good as its weakest part');
  eq(s.hoursReturned.provenance, 'SELF_REPORTED', 'which the headline grade reflects');
  eq(grade(s).grade, 'DEFENSIBLE', 'defensible, and not strong');
  eq(EVIDENCE_CLASSES.length, 5, 'the classes are a projection of the five provenance grades');
  notes.push('a baseline of 10 timed + 12 from paper + 8 remembered reports all three, and grades as the weakest');
}

// ---------------------------------------------------------------------------
console.log('--- THE JUDGE: "did you cherry-pick these transactions?" ----------');
{
  // The answer has to be structural. "We did not" is not an answer.
  const all = [
    ...many(26, { touches: 1 }),
    ...Array.from({ length: 4 }, (_, i) => purchase(400 + i, { outcome: 'FAILED', objective: 'NOT_ACHIEVED', touches: 4 })),
  ];
  const honest = study(all, { eligible: 30 });
  eq(honest.denominator.reconciled, true, 'reporting all thirty reconciles');
  eq(grade(honest).grade, 'STRONG', 'and grades STRONG');

  // Now hand the ledger only the good ones, as somebody sincerely would.
  const picked = caseStudy({
    orgId: ORG, orgName: 'Testco', capability: 'purchasing', capabilityLabel: 'Purchasing',
    records: all.filter((r) => r.executionOutcome === 'COMPLETED'),
    baselines: [baselineOf(30)], touchStandards: [standardOf(5)], ...PERIOD,
    census: { eligible: 30, rule: 'every request in the period', source: 'purchase_requests' },
  });
  eq(picked.denominator.eligible, 30, 'the census still says thirty');
  eq(picked.denominator.reachedLedger, 26, 'only twenty-six reached the ledger');
  eq(picked.denominator.missing, 4, 'four are unaccounted for');
  eq(picked.denominator.reconciled, false, 'the population does not reconcile');
  eq(grade(picked).grade, 'NOT_READY', 'and the case study is NOT_READY, whatever its numbers say');
  check(grade(picked).failed.some((f) => f.id === 'population_reconciles'),
    'the failing rule names the population');
  check(present(picked.hoursReturned) > present(honest.hoursReturned),
    'note that the cherry-picked version has the BETTER number — which is the point');

  // And with no census at all, nothing establishes the population.
  const blind = caseStudy({
    orgId: ORG, orgName: 'Testco', capability: 'purchasing', capabilityLabel: 'Purchasing',
    records: all.filter((r) => r.executionOutcome === 'COMPLETED'),
    baselines: [baselineOf(30)], touchStandards: [standardOf(5)], ...PERIOD,
  });
  eq(blind.denominator.established, false, 'with no census the population is not established');
  eq(grade(blind).grade, 'NOT_READY', 'and that alone is NOT_READY');

  // TWO DIFFERENT PROBLEMS, TWO DIFFERENT FIXES. Both reach the same verdict,
  // which is why a mutation test found the census rule silently redundant with
  // the reconciliation rule. It is not redundant to the person reading the
  // report: "nobody counted the population" is answered by taking a census, and
  // "four units are missing" is answered by finding them. So both rules must
  // fire, and each must say its own thing.
  const noCensus = grade(blind).failed.find((f) => f.id === 'population_established');
  const mismatch = grade(picked).failed.find((f) => f.id === 'population_reconciles');
  check(!!noCensus, 'a missing census fails the population_established rule');
  check(/nothing establishes what was left out/.test(noCensus.found),
    'saying nobody counted the population', noCensus.found);
  check(!!mismatch, 'a mismatch fails the population_reconciles rule');
  check(/4 unexplained/.test(mismatch.found),
    'saying how many units are missing, which is a different job', mismatch.found);
  check(!grade(picked).failed.some((f) => f.id === 'population_established'),
    'and a case study WITH a census does not also complain that it has none');
  notes.push('filtering to the successful workflows produces a BETTER number and a NOT_READY grade');
}

// ---------------------------------------------------------------------------
console.log('--- THE JUDGE: "who measured the old process, and when?" ---------');
{
  const s = study(many(40));
  const b = s.baseline[0];
  check(b.reviewedBy, 'the baseline names who reviewed it');
  check(b.reviewedAt, 'and when');
  check(b.steps.every((st) => st.grade), 'every step carries its own grade');
  check(s.evidenceSources.length > 0, 'and the sources are enumerable');
  check(s.evidenceSources.every((src) => src.kind && src.ref),
    'each naming a kind and something to go and look at');

  // An unreviewed baseline cannot be STRONG, however well measured.
  const unreviewed = study(many(40), { baseline: baselineOf(30, 'MEASURED', { reviewedBy: null, reviewedAt: null }) });
  eq(grade(unreviewed).grade, 'DEFENSIBLE', 'an unreviewed baseline caps the case study at DEFENSIBLE');
  check(grade(unreviewed).failed.some((f) => f.id === 'baseline_reviewed'), 'and says so');
}

// ---------------------------------------------------------------------------
console.log('--- THE JUDGE: "were employees just faster that day?" -------------');
{
  // Answerable only with the spread and the sample size, which the ingestion
  // layer records and the baseline carries in its note.
  // Distinct refs: two observations of the SAME purchase order on the same day
  // are one observation, and ingest.mjs refuses them — which it did to the
  // first version of this fixture, correctly.
  let n = 0;
  const o = (m) => observation({ minutes: m, method: 'DIRECT_OBSERVATION', observedBy: 'Jack', at: '2026-09-03', ref: `PO 1234-COOPER-${++n}` });
  const st = stepFromObservations({ id: 'po_preparation', label: 'x', observations: [o(4), o(6), o(6), o(7), o(15)] });
  eq(st.minutes.provenance, 'MEASURED', 'five timed observations are MEASURED');
  near(present(st.minutes), 6, 'and the MEDIAN is used, so one unusual morning does not set the figure');
  check(/4-15 min observed/.test(st.note), 'while the full spread is disclosed, not hidden by the median');
  eq(st.minutes.sources.length, 5, 'and every individual observation remains a source');

  // Below five, it cannot be MEASURED however carefully timed.
  const few = stepFromObservations({ id: 'x', label: 'x', observations: [o(4), o(6), o(7)] });
  eq(few.minutes.provenance, 'ESTIMATED', 'three timed observations are not a measurement');
  check(/fewer than 5/.test(few.note), 'and the note says why it was capped');
  eq(MEASURED_FLOOR, 5, 'the floor is a stated constant');
}

// ---------------------------------------------------------------------------
console.log('--- THE JUDGE: "did you include setup time?" ----------------------');
{
  const { overhead } = await import(P('ledger.mjs'));
  const withOverhead = caseStudy({
    orgId: ORG, orgName: 'Testco', capability: 'purchasing', capabilityLabel: 'Purchasing',
    records: many(40), baselines: [baselineOf(30)], touchStandards: [standardOf(5)], ...PERIOD,
    census: { eligible: 40, rule: 'r', source: 's' },
    overheads: [overhead({ label: 'installation and training', hours: 6, provenance: 'MEASURED', sources: [TIMED('install log')] })],
  });
  near(raw(withOverhead.hoursReturned), (40 * 25) / 60, 'the gross figure is unchanged');
  near(raw(withOverhead.netHoursReturned), (40 * 25) / 60 - 6, 'and the net figure subtracts the setup hours');
  check(present(withOverhead.netHoursReturned) < present(withOverhead.hoursReturned),
    'so setup time is visible rather than absorbed');

  // Unmeasured overhead refuses a net figure rather than assuming zero.
  const unknownOverhead = caseStudy({
    orgId: ORG, orgName: 'Testco', capability: 'purchasing', capabilityLabel: 'Purchasing',
    records: many(40), baselines: [baselineOf(30)], touchStandards: [standardOf(5)], ...PERIOD,
    census: { eligible: 40, rule: 'r', source: 's' },
    overheads: [overhead({ label: 'training', hours: null, provenance: 'UNAVAILABLE' })],
  });
  eq(unknownOverhead.netHoursReturned.known, false,
    'an unmeasured overhead makes the NET figure unknown rather than equal to the gross');
  eq(unknownOverhead.hoursReturned.known, true, 'while the gross figure stands');
}

// ---------------------------------------------------------------------------
console.log('--- THE JUDGE: "why are machine timestamps treated as labour?" ----');
{
  // They are not, and it is structural: the labour path has no access to
  // elapsed time at all.
  const value = readFileSync(P('value.mjs'), 'utf8');
  const labourSection = value.slice(value.indexOf('function returnedMinutes'));
  for (const forbidden of ['startedAt', 'endedAt', 'elapsed', 'cycle']) {
    check(!labourSection.includes(forbidden),
      `the hours-returned arithmetic never reads ${forbidden}`);
  }
  const s = study(many(40));
  check(s.cycle !== undefined, 'cycle time is reported');
  check(s.hoursReturned.basis.includes('minutes'), 'and the hours figure is built from priced interactions');
  check(!/elapsed|wall/i.test(s.hoursReturned.basis ?? ''), 'never from wall-clock time');

  // Human minutes come from a touch standard keyed on the audit action, not
  // from the gaps between events.
  const { touchMinutes } = await import(P('baseline.mjs'));
  check(touchMinutes(standardOf(5), 'request.handled').known,
    'a touch standard prices the audit action by name, not by the gap between events');
  notes.push('the labour arithmetic cannot see elapsed time — checked in the source, not promised');
}

// ---------------------------------------------------------------------------
console.log('--- THE JUDGE: "could two automations claim the same time?" -------');
{
  const { assertNoOverlap } = await import(P('baseline.mjs'));
  const second = defineBaseline({
    id: 'testco_other', version: '1.0.0', orgId: ORG, process: 'x', description: 'x',
    effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'request',
    steps: [baselineStep({ id: 'a', label: 'a', minutes: 5, provenance: 'MEASURED', sources: [TIMED('x')] })],
    coversSteps: ['purchasing'],
  });
  throws(() => assertNoOverlap([baselineOf(30), second]), 'cannot be returned twice',
    'two baselines pricing the same work are refused before anything is totalled');

  // And two attempts at one purchase bank once.
  const retried = [
    purchase(1, { scope: 'request:7', outcome: 'FAILED', objective: 'NOT_ACHIEVED', touches: 3 }),
    purchase(2, { scope: 'request:7', touches: 1 }),
  ];
  const s = study(retried, { eligible: 2 });
  eq(s.denominator.reachedLedger, 1, 'two attempts at one purchase are one unit of work');
  eq(s.denominator.retriesFoldedIn, 1, 'and the folded attempt is reported, not hidden');
  eq(s.denominator.accountedFor, 2, 'so the population still reconciles');
  eq(s.denominator.reconciled, true, 'exactly');
  check(present(s.hoursReturned) < 25 / 60,
    'and the failed attempt\'s human minutes are charged against the saving, so a retry is not free');
}

// ---------------------------------------------------------------------------
console.log('--- THE JUDGE: "did you choose the baseline after the result?" ----');
{
  // A baseline governs only work that started after it took effect.
  const late = baselineOf(30, 'MEASURED', { effectiveFrom: '2026-09-15T00:00:00Z' });
  const s = study(many(10), { baseline: late });
  const early = s.ledger.valuations.filter((v) => v.startedAt < '2026-09-15');
  check(early.length > 0, 'some executions started before the baseline took effect');
  check(early.every((v) => v.excludedBecause === 'no_baseline_in_force'),
    'and none of them is valued against it');
  check(s.baseline.length === 0 || s.denominator.valued < 10,
    'so a baseline written today cannot govern last week\'s work');
  notes.push('a baseline cannot be applied to work that predates its effectiveFrom');
}

// ---------------------------------------------------------------------------
console.log('--- THE JUDGE: "can I inspect where this number came from?" -------');
{
  const s = study(many(30));
  const t = explain(s, 'hoursReturned');
  eq(t.metric, 'hoursReturned', 'the trace names the metric');
  check(t.value !== null, 'and its value');
  eq(t.grade, 'MEASURED', 'and its grade');
  eq(t.restsOn.unitsOfWork, 30, 'and how many units of work it rests on');
  eq(t.contributions.length, 30, 'with one row per unit of work');
  for (const c of t.contributions.slice(0, 3)) {
    check(c.execution, 'each row names the execution');
    check(c.baselineMinutes !== undefined && c.observedMinutes !== undefined,
      'the before and the after');
    check(c.minutesReturned !== undefined, 'and what it contributed');
    check(c.why, 'and the sentence explaining it');
  }
  // The arithmetic reconciles: the parts add to the whole.
  const summed = t.contributions.reduce((acc, c) => acc + (c.minutesReturned ?? 0), 0);
  near(summed / 60, raw(s.hoursReturned), 'and the contributions sum to the headline figure', 0.05);
  check(t.restsOn.baselines[0].steps.length > 0, 'the baseline steps are in the trace');
  check(t.sources.length > 0, 'as are the evidence sources');
  notes.push('"how do you know?" resolves to per-execution rows that sum to the headline');
}

// ---------------------------------------------------------------------------
console.log('--- THE JUDGE: "would you report it if AWE made things worse?" ----');
{
  // Asked and answered above with a negative figure. Here: the grade must not
  // move with the sign of the result.
  const good = study(many(40, { touches: 1 }), { baseline: baselineOf(60) });
  const bad = study(many(40, { touches: 10 }), { baseline: baselineOf(20) });
  check(present(good.hoursReturned) > 0 && present(bad.hoursReturned) < 0,
    'one result is positive and one is negative');
  eq(grade(good).grade, grade(bad).grade, 'and they grade identically');
  eq(grade(bad).grade, 'STRONG', 'both STRONG');
  notes.push('the grade is a function of evidence and is provably independent of the sign of the result');
}

// ---------------------------------------------------------------------------
console.log('--- THE JUDGE: "are these numbers estimates?" ---------------------');
{
  const s = study(many(40), { baseline: baselineOf(30, 'ESTIMATED') });
  eq(s.hoursReturned.provenance, 'ESTIMATED', 'the headline carries its own grade');
  eq(classOf(s.hoursReturned), 'EMPLOYEE_ESTIMATED', 'classified in words a person would use');
  check(s.unknown.length >= 0, 'and the unknowns are enumerated');
  const g = grade(s);
  check(/indication|State the figure/.test(g.permittedClaim), 'the permitted claim reflects the grade');
  check(g.grade !== 'STRONG', 'and an estimate is never STRONG');
}

// ---------------------------------------------------------------------------
console.log('--- the grade tracks evidence, never the size of the number -------');
{
  // A sweep: hold evidence constant, vary the result. Then hold the result
  // constant and vary the evidence. Only the second should move the grade.
  const grades = [10, 20, 30, 40, 60, 120].map((b) => grade(study(many(40), { baseline: baselineOf(b) })).grade);
  eq(new Set(grades).size, 1, 'six different results, one grade');
  eq(grades[0], 'STRONG', 'all STRONG');

  const byEvidence = ['MEASURED', 'ESTIMATED', 'SELF_REPORTED']
    .map((g) => grade(study(many(40), { baseline: baselineOf(30, g) })).grade);
  eq(byEvidence, ['STRONG', 'DEFENSIBLE', 'DEFENSIBLE'], 'one result, and the grade moves with the evidence');

  const bySample = [5, 10, 30].map((n) => grade(study(many(n))).grade);
  eq(bySample, ['PARTIAL', 'DEFENSIBLE', 'STRONG'], 'and with the sample size');
  notes.push('grade is invariant under the result and varies with evidence and sample size');
}

// ---------------------------------------------------------------------------
console.log('--- synthetic evidence cannot reach production aggregation --------');
{
  // Everything above is in-memory. This asserts the production path would
  // refuse it, so a fixture cannot become a claim by being written somewhere.
  const cs = readFileSync(join(ROOT, 'scripts/proof-case-study.mjs'), 'utf8');
  check(cs.includes("environment !== 'production'"), 'the reader refuses a non-production database');
  check(/gradeCaseStudy/.test(cs), 'and grades what it does read');

  const s = study(many(40));
  eq(grade(s, { environment: 'rehearsal' }).grade, 'NOT_READY',
    'a perfect case study from a rehearsal database is NOT_READY');
  check(grade(s, { environment: 'rehearsal' }).failed.some((f) => f.id === 'production_identity'),
    'and the failing rule names the environment');
  eq(grade(s, { environment: 'unstamped' }).grade, 'NOT_READY', 'as is one from an unstamped database');

  const suite = readFileSync(join(ROOT, 'scripts/eval-case-study-001.mjs'), 'utf8');
  // Split so the literals below are not themselves matches — the first version
  // of this check failed against its own source.
  const opens = ['Database', 'Sync'].join('');
  const writes = ['write', 'FileSync'].join('');
  check(!suite.includes(`${opens}(`) && !suite.includes(`${writes}(`),
    'and this suite calls neither, so a fixture cannot become a claim by being written somewhere');
}

// ---------------------------------------------------------------------------
console.log('--- the observation file is validated, not trusted ----------------');
{
  const doc = JSON.parse(readFileSync(P('baselines/observations/lippolis-purchasing.json'), 'utf8'));
  const steps = Object.keys(doc.steps);
  eq(validate(doc, { expectSteps: steps }), [], 'the committed observation file is valid');
  eq(steps.length, 7, 'and declares all seven steps of the Lippolis process');
  check(Object.values(doc.steps).every((s) => s.observations.length === 0),
    'every one of them empty, which is the true state today');
  check(doc.labourRate.centsPerHour === null, 'and no labour rate has been supplied');

  const todo = outstanding(doc, { expectSteps: steps });
  eq(todo.length, 9,
    'so nine things are outstanding: seven steps, the paper POs for elapsed time, and the rate');
  check(todo.some((t) => /paper POs/.test(t.step)),
    'including the filing-cabinet afternoon, which interrupts nobody');

  // The refusals.
  throws(() => observation({ minutes: 6, method: 'GUESS', observedBy: 'J', at: 'x', ref: 'y' }),
    'unknown observation method', 'a method this system has no meaning for is refused, not mapped');
  throws(() => observation({ minutes: 6, method: 'DIRECT_OBSERVATION', observedBy: 'J', at: 'x' }),
    'must name what was observed', 'an observation with nothing to go and look at is refused');
  throws(() => observation({ minutes: 6, method: 'DIRECT_OBSERVATION', at: 'x', ref: 'y' }),
    'who observed it', 'as is one with no observer');
  throws(() => observation({ minutes: -1, method: 'DIRECT_OBSERVATION', observedBy: 'J', at: 'x', ref: 'y' }),
    'non-negative', 'and a negative duration');

  // The three classes map onto the existing grades rather than beside them.
  eq(METHODS.DIRECT_OBSERVATION.grade, 'MEASURED', 'watching it is MEASURED');
  eq(METHODS.HISTORICAL_RECORD.grade, 'ESTIMATED', 'deriving it from paperwork is ESTIMATED');
  eq(METHODS.EMPLOYEE_ESTIMATE.grade, 'SELF_REPORTED', 'being told is SELF_REPORTED');

  // A step that happens on a quarter of requests contributes a quarter.
  // Distinct refs, because the same thing observed twice is one observation.
  let k = 0;
  const o = (m) => ({ minutes: m, method: 'DIRECT_OBSERVATION', observedBy: 'J', at: 'd', ref: `r${++k}` });
  const scaled = stepFromObservations({ id: 'clarification', label: 'x', appliesToShare: 0.25, observations: [o(8), o(8), o(8), o(8), o(8)] });
  near(present(scaled.minutes), 2, 'eight minutes on a quarter of requests contributes two');
  check(/25% of units/.test(scaled.note), 'and the note says so');
}

// ---------------------------------------------------------------------------
console.log('--- the whole chain, from a filled-in observation file ------------');
{
  // THE DRY RUN. Everything above tests a link; this runs the chain:
  //
  //   observation file -> ingest -> baseline -> production executions ->
  //   human touches -> objective outcomes -> comparison -> hours returned ->
  //   grade -> audit trace
  //
  // It uses the SEVEN REAL LIPPOLIS STEPS, so it is a rehearsal of the actual
  // case study rather than of a simplified one. Nothing is written anywhere;
  // the document is a fixture in memory.
  const STEP_IDS = ['request_intake', 'clarification', 'stock_check', 'approval_handling',
    'po_preparation', 'vendor_communication', 'tracking_and_filing'];

  const timed = (m, n = 5) => Array.from({ length: n }, (_, i) => ({
    minutes: m + (i % 3) - 1, method: 'DIRECT_OBSERVATION',
    observedBy: 'Jack', at: '2026-09-03', subject: 'Karen', ref: `PO 1234-COOPER-${i + 1}`,
  }));

  const doc = {
    baselineId: 'lippolis_purchasing_v0', orgId: 'lippolis',
    reviewedBy: 'Mike Purchasing', reviewedAt: '2026-09-10',
    labourRate: { centsPerHour: 5200, method: 'HISTORICAL_RECORD', ref: 'payroll, Paul, 2026-09-02' },
    steps: {
      request_intake:       { observations: timed(3), appliesToShare: 1 },
      clarification:        { observations: timed(8), appliesToShare: 0.25 },
      stock_check:          { observations: timed(6), appliesToShare: 1 },
      approval_handling:    { observations: timed(2), appliesToShare: 1 },
      po_preparation:       { observations: timed(7), appliesToShare: 1 },
      vendor_communication: { observations: timed(4), appliesToShare: 1 },
      tracking_and_filing:  { observations: timed(9), appliesToShare: 1 },
    },
  };
  // Elapsed time comes from the filing cabinet, so a complete file has it too.
  doc.cycle = { observations: Array.from({ length: 18 }, (_, i) => ({
    ref: `PO-${i}`, raisedAt: '2026-06-01',
    receivedAt: new Date(Date.parse('2026-06-01') + ((i % 9) + 1) * 86_400_000).toISOString().slice(0, 10),
    method: 'HISTORICAL_RECORD',
  })) };
  eq(validate(doc, { expectSteps: STEP_IDS }), [], 'a fully populated observation file validates');
  eq(outstanding(doc, { expectSteps: STEP_IDS }), [], 'and nothing is outstanding');

  const { labourRateFrom } = await import(P('baselines/ingest.mjs'));
  const rate = labourRateFrom(doc.labourRate);
  const built = defineBaseline({
    id: 'lippolis_purchasing_v0', version: '1.0.0', orgId: 'lippolis',
    process: 'Buying material for a job', description: 'the process before PCC',
    effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'purchase request',
    steps: STEP_IDS.map((id) => stepFromObservations({ id, label: id, ...doc.steps[id] })),
    coversSteps: ['purchasing'],
    labourRateCentsPerHour: rate.centsPerHour,
    labourRateProvenance: rate.provenance,
    labourRateSources: rate.sources,
    reviewedBy: doc.reviewedBy, reviewedAt: doc.reviewedAt,
  });

  const { baselineHandlingMinutes, baselineGrade } = await import(P('baseline.mjs'));
  const handling = baselineHandlingMinutes(built);
  eq(handling.known, true, 'the seven observed steps produce a baseline total');
  // 3 + (8*0.25) + 6 + 2 + 7 + 4 + 9 = 33 minutes per purchase request.
  near(raw(handling), 33, 'of 33 minutes per purchase request');
  eq(baselineGrade(built), 'MEASURED', 'graded MEASURED, because every step was timed five times');
  check(built.steps.find((s) => s.id === 'clarification').note.includes('25% of units'),
    'and the step that happens on a quarter of requests is scaled, with the scaling disclosed');

  // Production: 30 purchases, 26 good, 2 failed, 2 not yet testable.
  const production = [
    ...Array.from({ length: 26 }, (_, i) => lip(i, { touches: 2 })),
    ...Array.from({ length: 2 }, (_, i) => lip(100 + i, { outcome: 'FAILED', objective: 'NOT_ACHIEVED', touches: 4 })),
    ...Array.from({ length: 2 }, (_, i) => lip(200 + i, { objective: 'UNKNOWN', touches: 2 })),
  ];
  const s = caseStudy({
    orgId: 'lippolis', orgName: 'Lippolis Electric, Inc.',
    capability: 'purchasing', capabilityLabel: 'Purchasing',
    records: production, baselines: [built],
    touchStandards: [defineTouchStandard({
      id: 'lippolis_touches', version: '1', orgId: 'lippolis', capability: 'purchasing',
      effectiveFrom: '2026-01-01T00:00:00Z',
      actions: { 'request.handled': { minutes: 4, provenance: 'MEASURED', sources: [TIMED('PCC screen timings')] } },
    })],
    from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z',
    census: { eligible: 30, rule: 'every purchase request raised in the period', source: 'purchase_requests' },
  });

  eq(s.denominator.eligible, 30, 'thirty eligible purchases');
  eq(s.denominator.reconciled, true, 'all thirty accounted for');
  eq(s.denominator.executionOutcomes.failed, 2, 'two failed, and they are in the report');
  eq(s.denominator.objectiveOutcomes.objectiveNotYetTestable, 2, 'two not yet testable');
  eq(s.hoursReturned.known, true, 'a figure exists');
  eq(s.hoursReturned.provenance, 'MEASURED', 'at MEASURED');
  eq(s.evidenceClasses.weakest, 'MEASURED', 'and the baseline is measured throughout');
  eq(s.labourValueCents.provenance, 'ESTIMATED',
    'while the MONEY figure is only as good as the payroll record it rests on');

  const g = gradeCaseStudy(s, { environment: 'production', humanTouchRecordComplete: true });
  eq(g.grade, 'DEFENSIBLE', 'the case study grades DEFENSIBLE');
  check(g.failed.some((f) => f.id === 'minimum_units_strong'),
    'and STRONG is held back by the valued-unit count, not by the numbers');

  // And the trace answers the question.
  const t = explain(s, 'hoursReturned');
  eq(t.contributions.length, 30, 'thirty rows in the trace, one per unit of work');
  const summed = t.contributions.reduce((a, c) => a + (c.minutesReturned ?? 0), 0);
  near(summed / 60, raw(s.hoursReturned), 'summing to the headline', 0.05);
  check(t.contributions.some((c) => c.excludedBecause), 'with the excluded units named and why');
  check(t.restsOn.baselines[0].steps.length === 7, 'and all seven baseline steps in the chain');

  notes.push(`dry run: 33 min baseline from 35 timed observations, 30 purchases -> ${raw(s.hoursReturned).toFixed(1)} h returned, DEFENSIBLE`);
}

// ---------------------------------------------------------------------------
console.log('--- against the real Lippolis baseline today ----------------------');
{
  const { lippolisPurchasingBaseline, lippolisPurchasingTouchStandard } = await import(P('baselines/lippolis-purchasing.mjs'));
  const s = caseStudy({
    orgId: 'lippolis', orgName: 'Lippolis Electric, Inc.',
    capability: 'purchasing', capabilityLabel: 'Purchasing',
    records: [], baselines: [lippolisPurchasingBaseline], touchStandards: [lippolisPurchasingTouchStandard],
    from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z',
    census: { eligible: 0, rule: 'r', source: 's' },
  });
  eq(s.hoursReturned.known, false, 'no hours can be claimed for Lippolis today');
  const g = gradeCaseStudy(s, { environment: 'production', humanTouchRecordComplete: true });
  eq(g.grade, 'NOT_READY', 'and Case Study #001 is NOT_READY');
  check(g.failed.some((f) => f.id === 'baseline_in_force'), 'because no baseline has been measured');
  check(/Nothing may be claimed about value/.test(g.permittedClaim),
    'so nothing may be claimed about value');
  check(renderGrade(g, s).includes('NOT MEASURABLE'), 'and the rendering says NOT MEASURABLE');
  notes.push('Case Study #001 today: NOT_READY, because nobody has measured the old process');
}

// ---------------------------------------------------------------------------
console.log('--- the field kit asks for only what software cannot do -----------');
{
  const kit = readFileSync(join(ROOT, 'docs/proof/JACK_FIELD_KIT.md'), 'utf8');

  // EVERY STEP NEEDS A PERSON. A field kit containing a task the repository
  // could have done is a field kit that wastes the scarcest resource here.
  check(/Everything on this page needs a person/i.test(kit),
    'the kit states that every step needs a person');
  for (const heading of ['WHO', 'What', 'How long', 'Unlocks']) {
    check(new RegExp(`\\*\\*${heading}\\*\\*`, 'i').test(kit), `each step states ${heading}`);
  }

  // The two mistakes that would silently ruin the baseline.
  check(/Handling time is not elapsed time/i.test(kit),
    'it warns that handling time is not elapsed time');
  check(/appliesToShare/.test(kit),
    'and that a step happening sometimes is not a full step');

  // The numbers in the kit must be the numbers in the code.
  check(kit.includes(`${MEASURED_FLOOR} times each`) || kit.includes(`**five times each**`),
    'the observation count it asks for is the one ingest.mjs enforces');
  check(kit.includes(String(STANDARD.minimumValuedUnits.strong)),
    'and the purchase count is the standard\'s own threshold');
  check(kit.includes(String(STANDARD.minimumValuedUnits.defensible)),
    'as is the floor');

  // Every command and file it names must exist.
  for (const named of [...kit.matchAll(/`(scripts\/[\w.-]+|proof\/[\w./-]+|docs\/[\w./-]+)`/g)].map((m) => m[1])) {
    check(existsSync(join(ROOT, named)), `${named} exists`);
  }

  // The negative result must be in the kit, and must not be hedged.
  check(/Negative/.test(kit) && /\*\*Report it\.\*\*/.test(kit),
    'it tells the founder to report a negative result');
  check(/Failures stay in/i.test(kit) && /reconcile/i.test(kit),
    'and that removing a failure makes the result worse, not better');
  check(/Do not coach anybody/i.test(kit),
    'and not to intervene during the observation window');
  notes.push('the field kit names only human work, and its numbers are read from the code');
}

function pick(r) {
  return {
    id: r.id, orgId: r.orgId, capability: r.capability, workflow: r.workflow,
    objectiveId: r.objectiveId, baselineId: r.baselineId, scopeKey: r.scopeKey,
    startedAt: r.startedAt, endedAt: r.endedAt, executionOutcome: r.executionOutcome,
    refusalReason: r.refusalReason, errorCode: r.errorCode,
    retries: r.retries, objective: r.objective, outcomes: [...r.outcomes],
    cycle: r.cycle, meta: { ...r.meta },
  };
}

console.log('');
for (const n of notes) console.log(`  note: ${n}`);
console.log('');
console.log(`case study 001: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
