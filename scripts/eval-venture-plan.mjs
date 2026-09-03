// ---------------------------------------------------------------------------
// eval-venture-plan.mjs — does the planning system give sensible advice to a
// company in a bad situation?
//
// A PLANNER IS ONLY WORTH ANYTHING WHEN IT DISAGREES WITH YOU. Told about a
// company doing well it will say encouraging things whatever its logic is, so
// the only informative tests are the unflattering ones: lots of code and no
// users, a beautiful demo and no proof, revenue with no measurable outcome. In
// every one of those the comfortable recommendation is "keep doing what you are
// doing", and in every one it is wrong.
//
// So each scenario below is a real failure mode of an early company, expressed
// as a facts object, and the assertion is about what the planner REFUSES to say
// as much as what it says.
//
// THE VANITY-METRIC TEST, which is the one that matters most: a scenario is
// constructed to look impressive on every countable dimension while the load-
// bearing evidence is absent. If the planner congratulates it, the model is a
// dashboard.
//
// Offline. Pure functions over fixture facts; no repository state is read
// except in the last section, which asserts against the tree as it actually is.
//
//   node scripts/eval-venture-plan.mjs
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => join(ROOT, p);

const { plan, render } = await import(R('programs/venture/plan.mjs'));
const { CLAIMS, CLAIM_IDS, assessClaims, GRADES, TRACKS, COSTS } = await import(R('programs/venture/claims.mjs'));
const { GATES, assessGates, currentGate, gateOf } = await import(R('programs/venture/gates.mjs'));
const { deriveFacts } = await import(R('programs/iic-2027/derive.mjs'));
const { PROVENANCE_GRADES } = await import(R('proof/provenance.mjs'));

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

// A company with nothing. Every scenario is this plus what it claims to have.
const NOTHING = Object.freeze({
  deployment: { capabilities: 1, deployable: true, phase: 'BUILD_ONLY', blockers: [], aweOwnedBlockers: 0, externalBlockers: 0, readyUnderPolicy: false, deployments: 0, approvedCommit: null, packageBuilder: false },
  discovery: { interviews: 0, externalInterviews: 0, organizations: 0, externalOrganizations: 0, repeatedPatterns: 0, allPatterns: 0, designPartnerCandidates: 0, statedAmounts: 0, activelyLooking: 0, processExists: true },
  proof: { architectureOperational: true, baselineMethodologyExists: true, baselineFieldProtocolExists: true, capabilityNeutral: true, secondCapabilityAdapter: true, objectiveTestable: true, unclassifiedActions: 0, objectivesTested: 0, baselineMeasured: false, moneyMeasurable: false, confidence: 'NONE', valuedUnits: 0, evidenceEnvironment: null },
  usage: { executions: 0, activeDays: 0, organizations: 0 },
  repeatability: { profileHonouredPercent: 71, secondOrganizationProven: true },
});
const world = (over = {}) => {
  const out = { ...NOTHING };
  for (const [k, v] of Object.entries(over)) out[k] = { ...(NOTHING[k] ?? {}), ...v };
  return out;
};
const claimIn = (p, id) => p.claims.find((c) => c.id === id);
const recommends = (p, id) => p.highestLeverage?.claim === id || p.founderHighestLeverage?.claim === id;
const anyAction = (p) => `${p.highestLeverage?.action ?? ''} ${p.founderHighestLeverage?.action ?? ''}`;

// ---------------------------------------------------------------------------
console.log('--- the model is well-formed ------------------------------------');
{
  eq(CLAIM_IDS.length, 12, 'there are twelve claims');
  eq(new Set(CLAIM_IDS).size, 12, 'and their ids are unique');
  eq(GRADES, PROVENANCE_GRADES,
    'claim confidence uses the proof layer\'s vocabulary rather than a second five-word scale');

  for (const c of CLAIMS) {
    check(TRACKS.includes(c.track), `${c.id} names a known track`);
    check(COSTS.includes(c.cost), `${c.id} names a known cost`);
    check(c.requiredEvidence.length > 0, `${c.id} says what would make it true`);
    check(typeof c.whyItMatters === 'string' && c.whyItMatters.length > 10, `${c.id} says why it matters`);
    check(c.requires.every((r) => CLAIM_IDS.includes(r)), `${c.id} requires only claims that exist`);
    check(c.unlocks.every((u) => CLAIM_IDS.includes(u)), `${c.id} unlocks only claims that exist`);
    check(!c.requires.includes(c.id) && !c.unlocks.includes(c.id), `${c.id} does not depend on itself`);
  }

  // NO CYCLES. A dependency loop makes every claim in it permanently blocked
  // and the planner permanently silent about the whole area.
  const graph = new Map(CLAIMS.map((c) => [c.id, c.requires]));
  const state = new Map();
  const cyclic = (id) => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'open') return true;
    state.set(id, 'open');
    for (const r of graph.get(id) ?? []) if (cyclic(r)) return true;
    state.set(id, 'done');
    return false;
  };
  check(!CLAIM_IDS.some(cyclic), 'the prerequisite graph has no cycles');

  eq(GATES.map((g) => g.n), [1, 2, 3, 4, 5], 'the gates are numbered in order');
  for (const g of GATES) {
    check(g.claims.every((id) => CLAIM_IDS.includes(id)), `gate ${g.n} names only claims that exist`);
    check(g.requires.length > 0, `gate ${g.n} has repository requirements, not only claims`);
  }
  const covered = new Set(GATES.flatMap((g) => g.claims));
  eq([...CLAIM_IDS].filter((id) => !covered.has(id)), [], 'every claim belongs to at least one gate');
}

// ---------------------------------------------------------------------------
console.log('--- lots of code, zero users ------------------------------------');
{
  // The commonest failure in the category, and the one this whole repository is
  // most at risk of: the software is excellent and nobody has used it.
  const p = plan(world({
    deployment: { phase: 'GO_LIVE', deployments: 1, packageBuilder: true, approvedCommit: { commit: 'abc1234', signedBy: 'Jack Daly' } },
  }));
  eq(claimIn(p, 'works_in_production').grade, 'UNAVAILABLE', 'production usage is unproven whatever the code says');
  eq(claimIn(p, 'measurable_value').grade, 'UNAVAILABLE', 'and so is value');
  check(p.currentGate.n <= 2, 'the company is at gate 1 or 2, not further', `gate ${p.currentGate.n}`);
  check(!recommends(p, 'multi_capability') && !recommends(p, 'path_beyond_wedge'),
    'the planner does not recommend more architecture');
  check(!/abstraction|dashboard|deck|pitch/i.test(anyAction(p)), 'nor a dashboard or a deck');
  notes.push('lots of code and no users: the planner points at usage and baseline, not at more code');
}

// ---------------------------------------------------------------------------
console.log('--- excellent demo, no proof ------------------------------------');
{
  const p = plan(world({
    demo: { liveDemoExists: true, backupExists: true, rehearsals: 12 },
    narrative: { oneMinuteExists: true, executiveSummaryExists: true, judgeQuestionsAnswered: 10, mockPitches: 4 },
  }));
  check(!p.gates.find((g) => g.n === 5).passed, 'a polished demo does not pass the IIC gate on its own');
  eq(claimIn(p, 'measurable_value').grade, 'UNAVAILABLE', 'because there is still nothing to demonstrate about value');
  check(p.currentGate.n === 1, 'the company is still at gate 1');
  check(!/demo|rehears|pitch/i.test(anyAction(p)), 'and no recommended action is about presentation');
  notes.push('a rehearsed demo moves no gate on its own');
}

// ---------------------------------------------------------------------------
console.log('--- one customer only -------------------------------------------');
{
  // Everything works, at exactly one company. The number that looks like
  // traction and is not.
  const p = plan(world({
    usage: { executions: 400, activeDays: 120, organizations: 1 },
    proof: { baselineMeasured: true, moneyMeasurable: true, confidence: 'HIGH', valuedUnits: 380, objectivesTested: 380, evidenceEnvironment: 'production' },
    discovery: { interviews: 6, externalInterviews: 0, organizations: 1 },
  }));
  eq(claimIn(p, 'measurable_value').grade, 'MEASURED', 'value at one customer is genuinely measured');
  eq(claimIn(p, 'problem_real').grade, 'SELF_REPORTED',
    'but six conversations inside one company is a customer, not a problem');
  eq(claimIn(p, 'external_pain').grade, 'UNAVAILABLE', 'and there is no external evidence at all');
  check(p.founderHighestLeverage?.claim === 'problem_real' || p.founderHighestLeverage?.claim === 'external_pain',
    'the founder action is to get outside the building', p.founderHighestLeverage?.claim);
  notes.push('one deeply happy customer does not make the problem real outside their office');
}

// ---------------------------------------------------------------------------
console.log('--- high usage, no baseline -------------------------------------');
{
  // The scenario that produces the most confident wrong number in a pitch.
  const p = plan(world({
    usage: { executions: 900, activeDays: 200, organizations: 1 },
    proof: { objectivesTested: 900, baselineMeasured: false, moneyMeasurable: false, confidence: 'NONE', evidenceEnvironment: 'production' },
  }));
  eq(claimIn(p, 'works_in_production').grade, 'MEASURED', 'routine production use is proven');
  eq(claimIn(p, 'measurable_value').grade, 'UNAVAILABLE',
    'and no value figure exists, because nothing says what it used to cost');
  check(claimIn(p, 'measurable_value').because.includes('baseline'), 'the reason names the baseline');
  check(p.founderHighestLeverage?.claim === 'problem_economic',
    'the recommended action is to measure the baseline', p.founderHighestLeverage?.claim);
  notes.push('900 executions with no baseline still buys no value claim');
}

// ---------------------------------------------------------------------------
console.log('--- strong ROI, but estimated -----------------------------------');
{
  const p = plan(world({
    usage: { executions: 300, activeDays: 90, organizations: 1 },
    proof: { baselineMeasured: true, moneyMeasurable: true, confidence: 'LOW', valuedUnits: 300, objectivesTested: 300, evidenceEnvironment: 'production' },
  }));
  eq(claimIn(p, 'measurable_value').grade, 'ESTIMATED',
    'a value figure at LOW confidence is ESTIMATED, not MEASURED');
  check(p.overallGrade === 'UNAVAILABLE' || p.overallGrade !== 'MEASURED',
    'and it does not make the company\'s overall evidence strong');
  notes.push('a computed number at LOW confidence is reported as estimated, not as proof');
}

// ---------------------------------------------------------------------------
console.log('--- many interviews, no product ---------------------------------');
{
  const p = plan(world({
    discovery: { interviews: 60, externalInterviews: 55, organizations: 20, externalOrganizations: 19, repeatedPatterns: 6, designPartnerCandidates: 8, activelyLooking: 9, statedAmounts: 5 },
    deployment: { capabilities: 0, deployable: false, phase: 'BLOCKED_BEFORE_BUILD' },
    proof: { objectiveTestable: false },
  }));
  eq(claimIn(p, 'external_pain').grade, 'MEASURED', 'the market evidence is real');
  eq(claimIn(p, 'awe_solves').grade, 'UNAVAILABLE', 'and the product claim is not');
  check(p.currentGate.n === 1, 'the company is at gate 1 despite excellent discovery', `gate ${p.currentGate.n}`);
  check(p.highestLeverage?.claim === 'awe_solves' || p.highestLeverage?.claim === 'repeatable_deployment',
    'and the engineering action is to build the thing', p.highestLeverage?.claim);
  check(!recommends(p, 'external_pain'), 'more interviews are not recommended when 55 already exist');
  notes.push('sixty interviews do not substitute for a product');
}

// ---------------------------------------------------------------------------
console.log('--- product ready, blocked on IT --------------------------------');
{
  // The situation AWE will be in shortly, and the one where a planner most
  // easily invents busywork.
  const p = plan(world({
    deployment: {
      phase: 'DEPLOY_ONLY', packageBuilder: true, approvedCommit: { commit: 'abc1234', signedBy: 'Jack Daly' },
      aweOwnedBlockers: 0, externalBlockers: 2,
      blockers: [
        { path: 'network.hostname', phase: 'REQUIRED_BEFORE_GO_LIVE', owner: 'CUSTOMER_IT', kind: 'EXTERNAL', reason: 'not chosen' },
        { path: 'service.enabled_at_boot', phase: 'REQUIRED_BEFORE_GO_LIVE', owner: 'CUSTOMER_IT', kind: 'EXTERNAL', reason: 'no VM' },
      ],
    },
  }));
  check(p.externalBlockers.some((b) => b.claim === 'works_in_production'),
    'production usage is reported as waiting on somebody else');
  check(p.highestLeverage?.claim !== 'works_in_production',
    'and is never given as an engineering action');
  check(p.founderHighestLeverage?.claim === 'problem_economic',
    'while the founder is sent to do the thing that does not need IT', p.founderHighestLeverage?.claim);
  check(!/build|architecture|abstraction/i.test(p.founderHighestLeverage?.action ?? ''),
    'and that thing is not more building');
  notes.push('blocked on IT: the planner names the blocker and redirects to work that is not blocked');
}

// ---------------------------------------------------------------------------
console.log('--- design partner, but no deployment ---------------------------');
{
  const p = plan(world({
    validation: { designPartners: 2, externalDeployments: 0 },
    discovery: { interviews: 30, externalInterviews: 28, organizations: 12, externalOrganizations: 11, repeatedPatterns: 4, designPartnerCandidates: 5 },
  }));
  eq(claimIn(p, 'external_want').grade, 'INFERRED', 'committed time is evidence of want, short of a deployment');
  check(!p.gates.find((g) => g.n === 2).passed, 'and it does not pass the proof gate');
  check(p.currentGate.n === 1, 'the company is still at gate 1');
  notes.push('design partners are not deployments and do not move the proof gate');
}

// ---------------------------------------------------------------------------
console.log('--- second capability, same customer ----------------------------');
{
  const p = plan(world({
    usage: { executions: 500, activeDays: 150, organizations: 1 },
    proof: { baselineMeasured: true, moneyMeasurable: true, confidence: 'HIGH', valuedUnits: 480, objectivesTested: 500, capabilityNeutral: true, secondCapabilityAdapter: true, evidenceEnvironment: 'production' },
  }));
  eq(claimIn(p, 'not_hardcoded').grade, 'INFERRED', 'a second capability at the same customer is not a second customer');
  eq(claimIn(p, 'external_pain').grade, 'UNAVAILABLE', 'and says nothing about anybody else');
  check(!p.gates.find((g) => g.n === 4).passed, 'the commercial gate stays shut');
  notes.push('breadth at one customer is not breadth of market');
}

// ---------------------------------------------------------------------------
console.log('--- revenue without a measurable outcome ------------------------');
{
  const p = plan(world({
    revenue: { payingCustomers: 2 },
    businessModel: { unitDefined: true, pricingHypothesis: true, pricingTested: true, priceAccepted: 2 },
    validation: { designPartners: 2, externalDeployments: 2, externalTestimony: 1 },
    discovery: { interviews: 25, externalInterviews: 22, organizations: 10, externalOrganizations: 9, repeatedPatterns: 3, designPartnerCandidates: 4 },
    usage: { executions: 200, activeDays: 90, organizations: 2 },
    proof: { objectivesTested: 200, baselineMeasured: false, moneyMeasurable: false, confidence: 'NONE', evidenceEnvironment: 'production' },
  }));
  eq(claimIn(p, 'will_pay').grade, 'MEASURED', 'people paying is the strongest commercial evidence there is');
  eq(claimIn(p, 'measurable_value').grade, 'UNAVAILABLE',
    'and it still does not tell us what the software accomplished');
  check(!p.gates.find((g) => g.n === 2).passed,
    'revenue does not pass the proof gate — the two are different questions');
  check(p.founderHighestLeverage?.claim === 'problem_economic',
    'and the action is still to measure the baseline', p.founderHighestLeverage?.claim);
  notes.push('revenue is not proof of outcome, and the planner keeps them apart');
}

// ---------------------------------------------------------------------------
console.log('--- impressive architecture, weak business need ------------------');
{
  const p = plan(world({
    proof: { capabilityNeutral: true, secondCapabilityAdapter: true, architectureOperational: true },
    repeatability: { profileHonouredPercent: 95, secondOrganizationProven: true, externallyValidated: false },
    deployment: { phase: 'GO_LIVE', deployments: 3, packageBuilder: true, approvedCommit: { commit: 'a1b2c3d', signedBy: 'Jack Daly' } },
  }));
  // ARCHITECTURALLY REPEATABLE IS NOT EXTERNALLY VALIDATED, and this is the
  // sharpest place the difference shows: 95% of the profile is configuration, a
  // second organization has been provisioned and driven end to end, and no real
  // business other than the first has ever run it. That is INFERRED, and it
  // used to read MEASURED — which is the claim overstating itself in exactly
  // the scenario this section exists to catch.
  eq(claimIn(p, 'not_hardcoded').grade, 'INFERRED',
    'strong architecture against a SYNTHETIC second organization is INFERRED, never MEASURED');
  check(/ARCHITECTURALLY REPEATABLE/.test(claimIn(p, 'not_hardcoded').because),
    'and it says which of the two claims it has earned');
  check(claimIn(p, 'not_hardcoded').missing.some((m) => /REAL business/i.test(m)),
    'and names the one piece of evidence a keyboard cannot produce');
  eq(claimIn(p, 'problem_real').grade, 'UNAVAILABLE', 'and nobody has established there is a problem');
  check(p.founderHighestLeverage?.claim === 'problem_real' || p.founderHighestLeverage?.claim === 'problem_economic',
    'so the action is to go and find out', p.founderHighestLeverage?.claim);
  {
    // The claim's own next action must send Jack to a customer, not to the
    // editor. Asserted on MEANING rather than on the word "extract", because the
    // correct text says extraction will NOT help — which a keyword match reads
    // as the opposite of what it is.
    const next = CLAIMS.find((c) => c.id === 'not_hardcoded').nextAction({
      repeatability: { profileHonouredPercent: 95, secondOrganizationProven: true, externallyValidated: false },
    });
    check(/SIGNED DESIGN PARTNER|design partner/i.test(next),
      'the claim\'s next action is to sign a design partner, not to write more configuration');
    check(/will not raise it|Nothing to build/i.test(next),
      'and it says outright that more extraction cannot raise the grade');
  }

  // MEASURED IS STILL REACHABLE, so the cap above is a bar rather than a
  // ceiling nobody can clear.
  const real = plan(world({
    proof: { capabilityNeutral: true, secondCapabilityAdapter: true, architectureOperational: true },
    repeatability: { profileHonouredPercent: 95, secondOrganizationProven: true, externallyValidated: true },
    deployment: { phase: 'GO_LIVE', deployments: 3, packageBuilder: true, approvedCommit: { commit: 'a1b2c3d', signedBy: 'Jack Daly' } },
  }));
  eq(claimIn(real, 'not_hardcoded').grade, 'MEASURED',
    'a REAL second business running it is what settles the claim');
  notes.push('strong architecture with no established need sends the founder outside, not to the editor');
}

// ---------------------------------------------------------------------------
console.log('--- the vanity-metric test --------------------------------------');
{
  // Every countable thing is large. Nothing load-bearing is measured. This is
  // what a company optimising for a dashboard looks like, and it is the exact
  // shape the planner must refuse to congratulate.
  const p = plan(world({
    usage: { executions: 5000, activeDays: 300, organizations: 4 },
    discovery: { interviews: 120, externalInterviews: 115, organizations: 40, externalOrganizations: 39, repeatedPatterns: 0, designPartnerCandidates: 30, activelyLooking: 40, statedAmounts: 20 },
    demo: { liveDemoExists: true, backupExists: true, rehearsals: 20 },
    narrative: { oneMinuteExists: true, executiveSummaryExists: true, judgeQuestionsAnswered: 20, mockPitches: 10 },
    deployment: { phase: 'GO_LIVE', deployments: 4, packageBuilder: true, approvedCommit: { commit: 'a1b2c3d', signedBy: 'Jack Daly' } },
    proof: { baselineMeasured: false, moneyMeasurable: false, confidence: 'NONE', objectivesTested: 0, evidenceEnvironment: 'production' },
  }));
  eq(claimIn(p, 'measurable_value').grade, 'UNAVAILABLE',
    'five thousand executions and no baseline is still no value claim');
  eq(claimIn(p, 'external_pain').grade, 'INFERRED',
    '115 interviews with no independently repeated pain is a big number and a weak fact');
  check(!p.gates.find((g) => g.n === 2).passed, 'the proof gate stays shut on volume alone');
  check(!p.gates.find((g) => g.n === 5).passed, 'and so does the IIC gate');
  check(p.overallGrade !== 'MEASURED', 'the company\'s overall evidence is not strong');
  notes.push('every countable number large and nothing measured: no gate opens');
}

// ---------------------------------------------------------------------------
console.log('--- the planner refuses to invent -------------------------------');
{
  const p = plan(world());
  // NO PROBABILITY OF WINNING, anywhere, ever.
  const json = JSON.stringify(p);
  check(!/probability|likelihood|chanceOfWinning|score/i.test(json),
    'the plan contains no probability, likelihood or score');
  const text = render(p);
  check(!/%/.test(text.split('THE TWELVE CLAIMS')[0]) || !/\d+% ready/i.test(text),
    'and prints no readiness percentage');
  check(text.includes('No probability of winning is computed'), 'and says so explicitly');

  // Everything is UNAVAILABLE and the planner still names exactly two actions.
  check(p.highestLeverage !== null, 'there is always an engineering action while something is movable');
  check(p.founderHighestLeverage !== null, 'and always a founder action');
  check(p.highestLeverage.claim !== p.founderHighestLeverage.claim, 'and they are different things');

  // Checked against the CANDIDATE SET, not only against what was chosen: a
  // claim that loses the ranking is not evidence that the rule excluding it
  // works.
  const candidateIds = new Set(p.candidates.map((c) => c.claim));
  for (const c of p.claims.filter((x) => x.blockedBy.length > 0)) {
    check(!candidateIds.has(c.id), `${c.id} is blocked and is not a candidate`);
  }
  for (const c of p.claims.filter((x) => x.track === 'EXTERNAL')) {
    check(!candidateIds.has(c.id), `${c.id} is external and is not a candidate`);
  }
  for (const c of p.claims.filter((x) => !x.actionable)) {
    check(!candidateIds.has(c.id), `${c.id} is earned rather than built, and is not a candidate`);
  }
  for (const c of p.claims.filter((x) => x.grade === 'MEASURED')) {
    check(!candidateIds.has(c.id), `${c.id} is already measured and is not a candidate`);
  }
  // And nothing recommended also appears under "do not build".
  const listed = new Set(p.notYet.map((n) => n.claim));
  check(!listed.has(p.highestLeverage.claim) && !listed.has(p.founderHighestLeverage.claim),
    'nothing is both recommended and forbidden');
}

// ---------------------------------------------------------------------------
console.log('--- the refusals bind when they would otherwise change the answer -');
{
  // A MUTATION TEST CAUGHT THIS SECTION MISSING. Removing the "never recommend
  // an EXTERNAL claim" filter broke nothing, because in every world above some
  // other claim outranked it anyway — so the assertions were true and vacuous.
  // These worlds are built so that the forbidden claim would come FIRST if the
  // rule were deleted, which is the only way to test a refusal.

  // Gate 1 fully satisfied, so the top-ranked claim by gate order is
  // `works_in_production` — gate 2, and EXTERNAL. Nobody at AWE can move it.
  const gate1Done = world({
    deployment: {
      phase: 'GO_LIVE', deployments: 2, packageBuilder: true,
      approvedCommit: { commit: 'a1b2c3d', signedBy: 'Jack Daly' },
      aweOwnedBlockers: 0, externalBlockers: 0,
    },
  });
  const p = plan(gate1Done);
  eq(p.currentGate.n, 2, 'with gate 1 satisfied the company is at gate 2');
  const wip = claimIn(p, 'works_in_production');
  eq(wip.grade, 'UNAVAILABLE', 'and production usage is the gate-2 claim with no evidence');
  eq(wip.blockedBy.length, 0, 'nothing blocks it — it is simply not ours to do');
  eq(wip.track, 'EXTERNAL', 'because it is external');
  check(p.highestLeverage?.claim !== 'works_in_production',
    'so it is NOT the engineering action, even though it is the top-ranked gate-2 claim',
    p.highestLeverage?.claim);
  // THE RULE, not just its consequence. An external claim never enters the
  // candidate set at all — checked directly, because checking only the chosen
  // action left the rule unreachable and a mutation test proved it.
  check(!p.candidates.some((c) => c.claim === 'works_in_production'),
    'and it is never a candidate for any track');
  check(p.candidates.every((c) => c.track !== 'EXTERNAL'),
    'no external claim is ever a candidate');
  check(p.externalBlockers.some((b) => b.claim === 'works_in_production'),
    'it is reported as something to chase instead');
  check(p.founderHighestLeverage?.claim === 'problem_economic',
    'and the founder is sent to the gate-2 work that IS theirs', p.founderHighestLeverage?.claim);

  // Now the blocked-claim refusal, made to bind the same way. `measurable_value`
  // is gate 2 and would rank above the gate-4 founder claims — but it waits on
  // two prerequisites with no evidence.
  const mv = claimIn(p, 'measurable_value');
  check(mv.blockedBy.length > 0, 'measurable_value is blocked', mv.blockedBy.join(','));
  eq(gateOf('measurable_value'), 2, 'and it belongs to the current gate');
  check(p.founderHighestLeverage?.claim !== 'measurable_value',
    'yet it is not recommended, because its prerequisites have no evidence');
  check(p.notYet.some((n) => n.claim === 'measurable_value' && n.kind === 'BLOCKED'),
    'it appears under what cannot be moved yet');

  // And the consequence refusal, likewise. With gate 1 done and a measured
  // baseline, `multi_capability` sits at gate 3 with evidence and is cheap —
  // but it is earned, not built.
  const q = plan(world({
    deployment: { phase: 'GO_LIVE', deployments: 2, packageBuilder: true, approvedCommit: { commit: 'a1b2c3d', signedBy: 'Jack' } },
    usage: { executions: 500, activeDays: 200, organizations: 1 },
    proof: { baselineMeasured: true, moneyMeasurable: true, confidence: 'HIGH', valuedUnits: 480, objectivesTested: 500, evidenceEnvironment: 'production' },
  }));
  const mc = claimIn(q, 'multi_capability');
  eq(mc.actionable, false, 'multi_capability is earned rather than built');
  check(mc.blockedBy.length === 0, 'nothing blocks it');
  check(q.highestLeverage?.claim !== 'multi_capability',
    'and it is never the recommended action', q.highestLeverage?.claim);
  check(q.notYet.some((n) => n.claim === 'multi_capability' && n.kind === 'CONSEQUENCE'),
    'it is named as a consequence instead');
  notes.push('the three refusals were tested in worlds where deleting them changes the answer');
}

// ---------------------------------------------------------------------------
console.log('--- gate order dominates leverage -------------------------------');
{
  // The property that makes this a plan rather than a backlog. A cheap,
  // high-leverage claim from a later gate must not outrank the current gate's
  // work.
  const p = plan(world());
  eq(p.currentGate.n, 1, 'the fixture company is at gate 1');
  eq(gateOf(p.highestLeverage.claim), 1, 'and the engineering action serves gate 1');
  check(p.proofGap.length > 0, 'the gap names what gate 1 is missing');
  for (const g of p.proofGap) check(typeof g.detail === 'string' && g.detail.length > 5, `the gap entry ${g.id} says what is actually missing`);
}

// ---------------------------------------------------------------------------
console.log('--- the plan measures nothing itself ----------------------------');
{
  // If a number appears here that appears nowhere else, there are two answers
  // to a question somebody will ask once.
  const strip = (f) => readFileSync(R(f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['programs/venture/claims.mjs', 'programs/venture/gates.mjs', 'programs/venture/plan.mjs']) {
    const code = strip(f);
    for (const forbidden of ['readFileSync', 'existsSync', 'DatabaseSync', 'spawnSync', 'execSync', 'Date.now', 'Math.random']) {
      check(!code.includes(forbidden), `${f} does not call ${forbidden}`);
    }
  }
  // Determinism: same facts, same plan.
  const a = JSON.stringify(plan(world({ usage: { executions: 7 } })));
  const b = JSON.stringify(plan(world({ usage: { executions: 7 } })));
  eq(a, b, 'the same facts produce the same plan, byte for byte');
}

// ---------------------------------------------------------------------------
console.log('--- a rehearsal cannot raise the readiness of the company --------');
{
  // THE MOST DANGEROUS NUMBER IN THIS REPOSITORY would be a readiness figure
  // taken from a rehearsal database. The rehearsal runs the production
  // artifact, under the real company name, against the real organization id —
  // so it produces exactly the shape of a good result and describes work nobody
  // did. The reader-side refusal already existed; the PLANNING side did not,
  // and the planning side is the one somebody quotes.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const APP = R('apps/purchasing/src/purchasing/infrastructure');
  const { openDatabase } = await import(join(APP, 'sqlite/database.ts'));
  const { bootstrapDatabase } = await import(join(APP, 'bootstrap.ts'));

  const install = (environment) => {
    const path = join(mkdtempSync(join(tmpdir(), 'plan-')), 'pcc.sqlite');
    const db = openDatabase(path);
    bootstrapDatabase(db, {
      NODE_ENV: 'production', PCC_ENVIRONMENT: environment, PCC_ORG_ID: 'lippolis',
      PCC_ORG_NAME: 'Lippolis Electric, Inc.', PCC_ORG_ADDRESS: 'addr', PCC_ORG_PHONE: 'phone',
    }, '2026-08-01T09:00:00Z');
    db.close();
    return path;
  };

  const warnings = [];
  const rehearsal = await deriveFacts({ db: install('rehearsal'), org: 'lippolis', warn: (m) => warnings.push(m) });
  eq(rehearsal.usage.executions, 0, 'a rehearsal database contributes no production executions');
  eq(rehearsal.proof.evidenceEnvironment, 'rehearsal', 'and the environment it declared is reported');
  check(warnings.some((w) => w.includes('rehearsal') && w.includes('not counted')),
    'and the refusal is said out loud rather than silently applied');

  const p = plan(rehearsal);
  eq(claimIn(p, 'works_in_production').grade, 'UNAVAILABLE', 'the production claim stays unproven');
  check(claimIn(p, 'works_in_production').because.includes('rehearsal'),
    'and names the environment it refused, so nobody thinks the file was missing');
  check(!p.gates.find((g) => g.n === 2).passed, 'the proof gate does not open on rehearsal data');

  // The control: the same code path, with a production stamp, does count.
  const production = await deriveFacts({ db: install('production'), org: 'lippolis', warn: () => {} });
  eq(production.proof.evidenceEnvironment, 'production',
    'a production-stamped database is read as production');
  notes.push('a rehearsal database moves no band, no claim and no gate');
}

// ---------------------------------------------------------------------------
console.log('--- against the repository as it actually is ---------------------');
{
  const facts = await deriveFacts();
  const p = plan(facts);

  // Gate 1 closed on 2026-09-03 when 585b749 was signed: the deployment is
  // approved, and what is left before go-live belongs to Lippolis IT. The
  // planner moving to gate 2 is the model working, not drifting.
  eq(p.currentGate.n, 2, 'AWE is at gate 2 — first real proof');
  eq(claimIn(p, 'awe_solves').grade, 'MEASURED', 'the workflow demonstrably runs end to end');
  eq(claimIn(p, 'works_in_production').grade, 'UNAVAILABLE', 'and nothing has run in production');
  eq(claimIn(p, 'measurable_value').grade, 'UNAVAILABLE', 'so no value can be claimed');

  // THE EXPECTED ANSWER, and the reason this suite exists. It stays on the
  // deployment path after the signature, because a deployment performed once is
  // not yet a deployment that repeats — only the wording moves, from "clear the
  // blocker" to "do it a second time from the same package".
  eq(p.highestLeverage.claim, 'repeatable_deployment',
    'the engineering action is still the deployment path');
  check(/deployment blocker|deployment-gate|second installation|same package/i.test(p.highestLeverage.action),
    'and it names a concrete deployment act', p.highestLeverage.action);
  check(/customer|Lippolis/i.test(p.highestLeverage.because ?? ''),
    'and says the remaining wait is the customer\'s, not ours', p.highestLeverage.because);
  eq((p.highestLeverage.missing ?? []).slice().sort(),
    ['network.hostname', 'service.enabled_at_boot', 'storage.backed_up_by_customer'],
    'naming the three facts only Lippolis IT can supply');
  eq(p.founderHighestLeverage.claim, 'problem_economic',
    'the founder action is to measure the baseline');
  check(/BASELINE_DAY\.md/.test(p.founderHighestLeverage.action),
    'and it names the operational checklist rather than the methodology — the founder is going to a building, not reading a design');
  check(/interview/i.test(p.founderHighestLeverage.thenNext?.action ?? ''),
    'with customer discovery next after it');

  // AND WHAT IT MUST NOT SAY.
  const said = `${p.highestLeverage.action} ${p.founderHighestLeverage.action}`;
  for (const forbidden of ['deck', 'pitch', 'dashboard', 'slide', 'abstraction']) {
    check(!new RegExp(forbidden, 'i').test(said), `no recommended action mentions a ${forbidden}`);
  }
  check(p.notYet.some((n) => n.claim === 'path_beyond_wedge'), 'the long-range claim is named as not-yet');

  notes.push(`repository today: gate ${p.currentGate.n}, engineering=${p.highestLeverage.claim}, founder=${p.founderHighestLeverage.claim}`);
}

// ---------------------------------------------------------------------------
console.log('--- the founder actions point at procedures that exist -----------');
{
  // A PLAN THAT NAMES A DOCUMENT THAT DOES NOT EXIST is worse than one that
  // says "go and think about it", because somebody spends twenty minutes
  // looking for it first. Every artifact the two recommended actions name is
  // checked here against the tree.
  const facts = await deriveFacts();
  const p = plan(facts);
  const said = `${p.highestLeverage.action} ${p.founderHighestLeverage.action} ${p.founderHighestLeverage.thenNext?.action ?? ''}`;
  const named = [...said.matchAll(/[\w./-]+\.(?:mjs|md|sh|ps1)/g)].map((m) => m[0]);
  check(named.length > 0, `${named.length} artifact(s) are named by the recommended actions`);
  for (const f of named) {
    check(existsSync(R(f)) || existsSync(R(join('scripts', f))), `${f} exists`);
  }

  // PHASE ORDER, which is the expensive thing to get wrong: a baseline
  // measured after the first production purchase cannot govern it.
  const activation = readFileSync(R('docs/proof/FIRST_REAL_PROOF_ACTIVATION.md'), 'utf8');
  check(/BEFORE the first real purchase/i.test(activation),
    'the activation procedure states the one ordering rule');
  check(/permanently unvaluable|permanently unmeasurable/i.test(activation),
    'and what it costs to get the order wrong');
  for (const section of ['BEFORE DEPLOYMENT', 'DURING DEPLOYMENT', 'AFTER DEPLOYMENT']) {
    check(activation.includes(section), `it covers ${section}`);
  }
  for (const threshold of ['10 valued units', '30']) {
    check(activation.includes(threshold), `it names the ${threshold} sample floor`);
  }
  check(/confidenceOf\(\)/.test(activation),
    'and attributes the floor to the code that enforces it, not to an opinion');
  for (const grade of ['MEASURED', 'ESTIMATED', 'SELF_REPORTED', 'INFERRED', 'UNAVAILABLE']) {
    check(activation.includes(grade), `it separates ${grade} evidence from the rest`);
  }
  check(/PCC_ENVIRONMENT/.test(activation) && /PCC_ORG_ID/.test(activation),
    'and names the two settings that cannot be corrected after the first start');

  // THE DISCOVERY TRACK, reusing what exists rather than a second CRM.
  const campaign = readFileSync(R('programs/discovery/CAMPAIGN.md'), 'utf8');
  const { interview } = await import(R('programs/discovery/interview.mjs'));
  const record = interview({
    id: 'x', at: '2026-09-01', organization: 'Someone Electric', role: 'office manager',
    workflow: 'buying material',
    pain: { value: 'x', said: 'STATED' }, frequency: { value: 'daily', said: 'STATED' },
    currentTools: ['paper'],
    humanTimeStated: { value: '20 minutes', said: 'STATED' }, failureModes: ['wrong item'],
    economicConsequence: { value: 'crew idle', said: 'STATED' },
    existingWorkaround: { value: 'phone the supplier', said: 'STATED' },
    willingnessToChange: 'OPEN_IF_PROVEN',
    willingnessToPay: 'NOT_ASKED', patternTags: ['material_arrives_wrong'], designPartnerInterest: true,
  });
  // Every field the campaign asks the interviewer to capture must survive into
  // the record, or the conversation is a memory rather than evidence.
  for (const field of ['workflow', 'pain', 'frequency', 'currentTools', 'humanTimeStated',
    'failureModes', 'economicConsequence', 'existingWorkaround', 'willingnessToChange',
    'willingnessToPay', 'patternTags', 'designPartnerInterest']) {
    check(record[field] !== undefined, `an interview record captures ${field}`);
  }
  check(/two different organizations|2\+ \*different organizations\*|counts \*\*organizations\*\*/i.test(campaign),
    'the campaign says a pattern needs two different organizations, not two people');
  check(/not electrical/i.test(campaign),
    'and that the first five must include one outside the trade Lippolis is in');
  check(!/pipeline|deal stage|close rate/i.test(campaign), 'and it is not a sales process');
  notes.push('both founder actions name procedures that exist and cover what they claim to');
}

console.log('');
for (const n of notes) console.log(`  note: ${n}`);
console.log('');
console.log(`venture plan: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
