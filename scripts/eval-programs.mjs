// ---------------------------------------------------------------------------
// eval-programs.mjs — can the scorecard be flattered, and can discovery lie?
//
// Two things are being tested, and both are ways a company tells itself a
// comfortable story:
//
//   THE SCORECARD    a band that can be raised without producing anything is
//                    decoration. Every dimension must be movable ONLY by a
//                    fact, an unwitnessed declaration must be refused, and a
//                    derived measurement must beat a declaration that
//                    contradicts it.
//
//   DISCOVERY        five conversations inside one company must not look like
//                    a market. That is the single most expensive mistake
//                    available at this stage, and `repeatedPatterns()` exists
//                    to make it visible.
//
//   node scripts/eval-programs.mjs
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = await import(join(ROOT, 'programs/iic-2027/readiness.mjs'));
const F = await import(join(ROOT, 'programs/iic-2027/facts.mjs'));
const M = await import(join(ROOT, 'programs/iic-2027/milestones.mjs'));
const D = await import(join(ROOT, 'programs/discovery/interview.mjs'));

let pass = 0;
const failures = [];
const notes = [];
const ok = () => { pass++; };
const bad = (m) => { failures.push(m); console.log(`FAIL  ${m}`); };
const check = (c, m) => (c ? ok() : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok() : bad(`${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));
const throws = (fn, fragment, m) => {
  try { fn(); bad(`${m} — nothing was thrown`); } catch (e) {
    if (String(e.message).includes(fragment)) ok();
    else bad(`${m} — threw the wrong thing: ${e.message}`);
  }
};
const note = (m) => { notes.push(m); };

const bandOf = (a, id) => a.dimensions.find((d) => d.id === id).level;
const whyOf = (a, id) => a.dimensions.find((d) => d.id === id).why;

// ---------------------------------------------------------------------------
console.log('--- the scorecard scores facts, not intentions -------------------');

{
  const empty = R.assess({});
  eq(empty.total, 0, 'an empty repository scores zero across the board');
  eq(empty.dimensions.length, 12, 'twelve dimensions');
  check(empty.dimensions.every((d) => d.why && d.why.length > 0),
    'and every band, including zero, cites why it was assigned');
  check(empty.dimensions.every((d) => !/^(good|bad|ok|n\/a)$/i.test(d.why)),
    'in a sentence rather than a verdict');
}

{
  // A dimension may not be moved by an opinion. Only by a fact.
  const before = R.assess({});
  const after = R.assess({ discovery: { externalInterviews: 22, organizations: 6, interviews: 25, repeatedPatterns: 4 } });
  check(bandOf(after, 'customer_discovery') > bandOf(before, 'customer_discovery'),
    'recorded interviews raise the discovery band');
  check(whyOf(after, 'customer_discovery').includes('22'),
    'and the reason names the number that moved it');
}

{
  // MEASURABLE OUTCOMES is the dimension most worth attacking, because it is
  // the one a founder most wants to be higher than it is.
  const testableOnly = R.assess({ proof: { objectiveTestable: true, objectivesTested: 40 } });
  eq(bandOf(testableOnly, 'measurable_outcomes'), 2,
    'measuring objective success without a baseline caps at 2 — real, but no improvement can be stated');
  check(whyOf(testableOnly, 'measurable_outcomes').includes('no baseline'),
    'and says so');

  const withBaseline = R.assess({ proof: {
    objectiveTestable: true, objectivesTested: 40, baselineMeasured: true, confidence: 'LOW', valuedUnits: 5 } });
  eq(bandOf(withBaseline, 'measurable_outcomes'), 3, 'a baseline at LOW confidence reaches 3, not 4');

  const strong = R.assess({ proof: {
    objectiveTestable: true, objectivesTested: 40, baselineMeasured: true, confidence: 'HIGH', valuedUnits: 40 } });
  eq(bandOf(strong, 'measurable_outcomes'), 4, 'and only HIGH or MODERATE confidence reaches 4');

  const completionOnly = R.assess({ proof: { objectiveTestable: false, objectivesTested: 1000 } });
  eq(bandOf(completionOnly, 'measurable_outcomes'), 0,
    'a thousand completed executions with no objective test scores ZERO — completion is not accomplishment');
}

{
  // Production usage cannot be inflated by a busy afternoon.
  const burst = R.assess({ usage: { executions: 400, activeDays: 2, organizations: 1 } });
  eq(bandOf(burst, 'production_usage'), 2, 'four hundred executions in two days is real use, not routine use');
  const routine = R.assess({ usage: { executions: 400, activeDays: 90, organizations: 1 } });
  eq(bandOf(routine, 'production_usage'), 3, 'ninety days of it is routine');
}

{
  // One customer is not a market, however many people were interviewed.
  const oneCompany = R.assess({ discovery: { interviews: 12, organizations: 1, externalInterviews: 12, repeatedPatterns: 0 } });
  eq(bandOf(oneCompany, 'problem_evidence'), 1,
    'twelve conversations inside one organization is a customer, not a market');
  check(whyOf(oneCompany, 'problem_evidence').includes('not a market'), 'and the scorecard says the words');
}

{
  // Revenue is binary at the bottom: a pricing hypothesis is not revenue.
  const hypothesis = R.assess({ revenue: { pricingHypothesis: true, payingCustomers: 0 } });
  eq(bandOf(hypothesis, 'revenue'), 1, 'a pricing hypothesis with nobody paying scores 1');
  const paid = R.assess({ revenue: { payingCustomers: 1 } });
  eq(bandOf(paid, 'revenue'), 3, 'one paying customer scores 3, not 4');
}

// ---------------------------------------------------------------------------
console.log('--- the next action, and why it is that one ----------------------');

{
  const empty = R.assess({});
  const hl = empty.highestLeverage;
  check(hl, 'an empty scorecard still produces a next action');
  eq(hl.dimension, 'customer_discovery',
    'with everything at zero and everything cheap, the action is the one that unblocks the most');
  check(hl.unblocks >= 3, 'and the ranking says how many other dimensions it unblocks');
  check(hl.action.length > 40 && !/improve|strengthen|enhance/i.test(hl.action),
    'the action is a task somebody could start this afternoon, not an exhortation');
  check(hl.runnersUp.length === 2, 'with two runners-up');

  // The tie-break exists because without it this degenerates to alphabetical.
  const noBlocks = R.assess({});
  check(noBlocks.highestLeverage.dimension !== 'business_model',
    'and specifically NOT the alphabetically-first zero, which is what a naive ranking returns');
}

{
  // Once discovery is done, the recommendation must move on.
  const discovered = R.assess({
    discovery: { interviews: 48, externalInterviews: 45, organizations: 12, repeatedPatterns: 5, designPartnerCandidates: 4 },
    usage: { executions: 200, activeDays: 60, organizations: 1 },
    proof: { objectiveTestable: true, objectivesTested: 100 },
  });
  check(discovered.highestLeverage.dimension !== 'customer_discovery',
    'a solved dimension is no longer the recommendation');
  eq(discovered.highestLeverage.dimension, 'measurable_outcomes',
    'and with usage real and no baseline, the recommendation is to measure the baseline');
  check(discovered.highestLeverage.action.includes('BASELINE'),
    'naming the methodology document rather than the aspiration');
  note(`with production usage and no baseline, the recommendation is: ${discovered.highestLeverage.action.slice(0, 60)}…`);
}

{
  // Everything at maximum returns null rather than a made-up next step.
  const maxed = R.assess({
    discovery: { interviews: 60, externalInterviews: 60, organizations: 20, repeatedPatterns: 9, designPartnerCandidates: 9 },
    deployment: { capabilities: 3, deployable: true, readyUnderPolicy: true, deployments: 4 },
    usage: { executions: 900, activeDays: 200, organizations: 4 },
    proof: { objectiveTestable: true, objectivesTested: 500, baselineMeasured: true, confidence: 'HIGH', valuedUnits: 400 },
    validation: { designPartners: 5, externalDeployments: 3, externalTestimony: 3 },
    revenue: { payingCustomers: 4 },
    differentiation: { alternativesAnalysed: 4, statedDifference: true, evidencedDifference: true },
    repeatability: { profileHonouredPercent: 95, secondOrganizationProven: true },
    businessModel: { unitDefined: true, pricingHypothesis: true, pricingTested: true, priceAccepted: 3 },
    demo: { liveDemoExists: true, backupExists: true, rehearsals: 9 },
    narrative: { oneMinuteExists: true, executiveSummaryExists: true, judgeQuestionsAnswered: 12, mockPitches: 7 },
  });
  eq(maxed.total, maxed.max, 'a fully evidenced company scores full marks');
  eq(maxed.highestLeverage, null, 'and gets no invented next action');
  check(R.render(maxed).includes('Check the facts before believing that'),
    'the renderer is suspicious of a perfect score, which is the correct posture');
}

// ---------------------------------------------------------------------------
console.log('--- declared facts need a witness --------------------------------');

{
  throws(() => F.assertDeclarationsWitnessed({ revenue: { payingCustomers: 3 } }),
    'a claim with no witness is not evidence',
    'a declared fact with no note is refused');
  check(F.assertDeclarationsWitnessed({ revenue: { payingCustomers: 3, note: 'invoices #1-3, paid 2027-01' } }),
    'a declared fact naming its witness is accepted');
  check(F.assertDeclarationsWitnessed(F.DECLARED), 'the committed declarations pass their own check');

  // A DERIVED measurement beats a DECLARED claim that contradicts it.
  const merged = F.mergeFacts(
    { proof: { confidence: 'NONE', baselineMeasured: false } },
    { proof: { confidence: 'HIGH', baselineMeasured: true, note: 'somebody was optimistic' } },
  );
  eq(merged.proof.confidence, 'NONE', 'a declaration cannot overrule a measurement');
  eq(merged.proof.baselineMeasured, false, 'in either direction');

  eq(Object.keys(F.DECLARED).length, 0,
    'nothing is currently declared — every band in the committed scorecard rests on a derivable fact');
}

// ---------------------------------------------------------------------------
console.log('--- milestones are computed, never ticked ------------------------');

{
  const src = await import('node:fs').then((fs) => fs.readFileSync(join(ROOT, 'programs/iic-2027/milestones.mjs'), 'utf8'));
  check(!/\bdone\s*:/.test(src) && !/\bcompleted\s*:\s*true/.test(src),
    'no milestone carries a done flag — a plan somebody can tick is a plan that gets ticked');
  check(M.MILESTONES.every((m) => typeof m.met === 'function'),
    'each is a function of the facts');
  check(M.MILESTONES.every((m) => m.evidence && m.evidence.length > 10),
    'and each names what would demonstrate it');

  const none = M.status({});
  eq(none.rows.filter((r) => r.met).length, 0, 'with no facts, nothing is met');

  const sept = M.status({
    proof: { architectureOperational: true, objectiveTestable: true, unclassifiedActions: 0, baselineMethodologyExists: true },
    discovery: { processExists: true },
  });
  const septMonth = sept.months.find((m) => m.at === '2026-09');
  eq(septMonth.met, septMonth.total, 'the September targets are met by the artifacts in this repository');
  eq(sept.months.find((m) => m.at === '2026-12').met, 0,
    'and no later target is met by them, which is what a target means');

  const months = M.status({}).months.map((m) => m.at);
  eq(months, ['2026-09', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'],
    'the checkpoints follow the verified competition calendar');
  // The evidence deadline is January, ahead of the February kickoff. A plan
  // that puts evidence-gathering after the kickoff has misread the calendar.
  const frozen = M.MILESTONES.find((m) => m.id === 'evidence_frozen');
  const video = M.MILESTONES.find((m) => m.id === 'milestone_one_video');
  check(frozen.at < video.at, 'evidence is frozen BEFORE the first milestone is due, not after');
  eq(video.at, '2027-02', 'and the one-minute video lands at the February kickoff');
}

// ---------------------------------------------------------------------------
console.log('--- discovery: one customer is not a market ----------------------');

const iv = (over = {}) => D.interview({
  id: over.id ?? 'i1', at: '2026-09-10',
  organization: over.organization ?? 'org-1', organizationType: 'electrical contractor',
  role: 'office manager', workflow: 'buying material for a job',
  pain: 'the same details get typed three times',
  frequency: 'daily',
  patternTags: over.patternTags ?? ['duplicate_data_entry'],
  ...over,
});

{
  throws(() => D.interview({
    id: 'x', at: '2026-09-10', organization: 'o', role: 'r',
    workflow: 'w', pain: 'p', patternTags: [],
  }), 'no patternTags', 'an untagged interview is refused — it cannot contribute to finding a pattern');

  throws(() => D.interview({
    id: 'x', at: '2026-09-10', organization: 'o', role: 'r', pain: 'p', patternTags: ['a'],
  }), 'names no workflow', 'a conversation about nothing in particular is not discovery');

  throws(() => D.interview({
    id: 'x', at: '2026-09-10', organization: 'o', role: 'r', workflow: 'w', pain: 'p',
    patternTags: ['a'], willingnessToPay: 'WOULD_PAY_STATED_AMOUNT',
  }), 'records no amount', 'claiming an amount was stated without recording it is refused');

  throws(() => D.interview({
    id: 'x', at: '2026-09-10', organization: 'o', role: 'r', workflow: 'w', pain: 'p',
    patternTags: ['Duplicate Entry'],
  }), 'snake_case', 'pattern tags are a controlled vocabulary, or they never match');
}

{
  // THE CENTRAL CHECK. Three people at one company are one organization.
  const oneCompany = ['a', 'b', 'c'].map((id) => iv({ id, organization: 'lippolis' }));
  const patterns = D.repeatedPatterns(oneCompany);
  eq(patterns.length, 0, 'three interviews inside one organization produce NO repeated pattern');

  const twoCompanies = [iv({ id: 'a', organization: 'lippolis' }), iv({ id: 'b', organization: 'other-electric' })];
  const p2 = D.repeatedPatterns(twoCompanies);
  eq(p2.length, 1, 'two organizations naming the same pain do');
  eq(p2[0].organizations, 2, 'and it says how many');
  eq(p2[0].externallyCorroborated, true, 'and that both were outside the deploying organization');
}

{
  // A pattern named only INSIDE the deploying organization is not corroboration.
  const inside = [
    iv({ id: 'a', organization: 'lippolis', internal: true }),
    iv({ id: 'b', organization: 'lippolis-workshop', internal: true }),
  ];
  const p = D.repeatedPatterns(inside);
  eq(p.length, 1, 'two internal organizations do form a pattern');
  eq(p[0].externallyCorroborated, false, 'but it is not externally corroborated');
  eq(D.summarize(inside).repeatedPatterns, 0,
    'and the scorecard counts only externally corroborated patterns');
  eq(D.summarize(inside).externalInterviews, 0, 'internal conversations are never external validation');
}

{
  const mixed = [
    iv({ id: 'a', organization: 'lippolis', internal: true }),
    iv({ id: 'b', organization: 'other-electric', designPartnerInterest: true, willingnessToChange: 'ACTIVELY_LOOKING' }),
    iv({ id: 'c', organization: 'third-co', patternTags: ['duplicate_data_entry', 'no_visibility_of_orders'],
        willingnessToPay: 'WOULD_PAY_STATED_AMOUNT', statedAmount: '$200/month' }),
  ];
  const s = D.summarize(mixed);
  eq(s.interviews, 3, 'three interviews');
  eq(s.externalInterviews, 2, 'two of them external');
  eq(s.organizations, 3, 'across three organizations');
  eq(s.repeatedPatterns, 1, 'one externally corroborated pattern');
  eq(s.designPartnerCandidates, 1, 'one design-partner candidate');
  eq(s.statedAmounts, 1, 'one person named a figure');
  eq(s.activelyLooking, 1, 'one is actively looking');
}

{
  check(D.PROTOCOL.length >= 10, 'the interview protocol has enough questions to be a protocol');
  check(/walk me through/i.test(D.PROTOCOL[0]), 'and it opens on their process rather than on ours');
  check(D.PROTOCOL.at(-1).toLowerCase().includes('early'), 'and closes on design-partner interest');
  const priceIndex = D.PROTOCOL.findIndex((q) => /expect .*cost/i.test(q));
  check(priceIndex > 6, 'the price question comes late, because it changes every answer before it');
  const painCostIndex = D.PROTOCOL.findIndex((q) => /what does it cost you/i.test(q));
  check(painCostIndex >= 0 && painCostIndex < priceIndex,
    'and what the PROBLEM costs them is asked before what a solution might');
}

// ---------------------------------------------------------------------------
console.log('--- one source of truth -----------------------------------------');

{
  // The competition program must not carry its own copy of any value figure.
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = readdirSync(join(ROOT, 'programs/iic-2027')).filter((f) => f.endsWith('.mjs'));
  for (const f of files) {
    const code = readFileSync(join(ROOT, 'programs/iic-2027', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(!/hoursReturned\s*[=:]\s*[0-9]/.test(code) && !/labourValue\w*\s*[=:]\s*[0-9]/.test(code),
      `${f} states no value figure of its own`);
    check(!/Date\.now\(|Math\.random\(/.test(code), `${f} reads no clock and no randomness`);
  }
  note('the competition program reads proof/ and stores no figure of its own');
}

console.log('');
for (const n of notes) console.log(`  note: ${n}`);
console.log('');
console.log(`program checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length ? 1 : 0);
