// ---------------------------------------------------------------------------
// eval-evidence.mjs — can the evidence layer be flattered, and does bad news
// arrive as bad news?
//
// Everything in programs/evidence/ and the two discovery analyses exist to turn
// a real event into a number. That is exactly the machinery a company uses to
// tell itself a comfortable story, so this suite is written as ten ways it
// would be nice if it lied:
//
//   · five people misunderstand the explanation
//   · somebody likes AWE and has no problem
//   · a real pain, already adequately handled by an ERP
//   · a pattern in two of five conversations
//   · they want the work done, not software
//   · the buyer is not the user
//   · they would use it and would not pay
//   · a rewritten sentence performs worse than the one it replaced
//   · the market contradicts what the first customer implied
//   · the pitch lands beautifully and nothing outside the building has changed
//
// In every one of them the correct behaviour is that a number goes DOWN, stays
// at zero, or a finding appears. Not one of them may produce validation.
//
//   node scripts/eval-evidence.mjs
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => join(ROOT, p);

const D = await import(R('programs/discovery/interview.mjs'));
const ALT = await import(R('programs/discovery/alternatives.mjs'));
const UOS = await import(R('programs/discovery/unit-of-sale.mjs'));
const C = await import(R('programs/evidence/comprehension.mjs'));
const MP = await import(R('programs/evidence/mock-pitch.mjs'));
const FS = await import(R('programs/evidence/founder-story.mjs'));
const IMP = await import(R('programs/evidence/import.mjs'));
const ST = await import(R('programs/evidence/status.mjs'));
const N = await import(R('programs/iic-2027/narrative.mjs'));
const RD = await import(R('programs/iic-2027/readiness.mjs'));
const CL = await import(R('programs/venture/claims.mjs'));

let pass = 0;
const failures = [];
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

// --- fixtures ---------------------------------------------------------------

const said = (v, s = 'STATED') => ({ value: v, said: s });

const iv = (over = {}) => D.interview({
  id: 'i1', at: '2026-09-10', organization: 'org-a', role: 'office manager',
  workflow: 'buying material', pain: said('the same detail is typed three times'),
  patternTags: ['repeated_data_entry'], ...over,
});

const test = (over = {}) => C.comprehensionTest({
  id: 't1', at: '2026-09-10', person: 'AB', background: 'nurse', relationship: 'STRANGER',
  explanationVersion: 'v1', restatement: 'it does the office paperwork itself under the company rules so nobody types it',
  concepts: {
    business_operations_work: 'PRESENT', execution_not_advice: 'PRESENT',
    company_rules: 'PRESENT', reduced_human_handling: 'PRESENT',
  },
  ...over,
});

const CONFUSED = {
  business_operations_work: 'PRESENT', execution_not_advice: 'ABSENT',
  company_rules: 'ABSENT', reduced_human_handling: 'GARBLED',
};

// ---------------------------------------------------------------------------
console.log('--- the explanation is tested, not admired ------------------------');

{
  eq(test().verdict, 'CLEAR', 'four concepts in their own words is CLEAR');
  eq(test({ concepts: CONFUSED }).verdict, 'CONFUSING', 'losing "it does the work" is CONFUSING however much else survived');

  // THE LOAD-BEARING CONCEPT. Three of four sounds like a good result and is
  // not, when the missing one is the one that separates AWE from an assistant.
  const three = test({ concepts: {
    business_operations_work: 'PRESENT', execution_not_advice: 'ABSENT',
    company_rules: 'PRESENT', reduced_human_handling: 'PRESENT' } });
  eq(three.verdict, 'CONFUSING', 'three of four concepts is CONFUSING when the missing one is execution');
  check(three.why.includes('does the work'), 'and the reason names which idea was lost');

  // A PARROT IS NOT A PASS.
  const echo = test({ verbatimEcho: true });
  eq(echo.verdict, 'CONFUSING', 'a verbatim echo cannot pass, whatever was typed into the concepts');
  eq(echo.concepts.execution_not_advice, 'PRESENT', 'what the founder scored is preserved');
  eq(echo.effectiveConcepts.execution_not_advice, 'GARBLED', 'and overridden for the verdict');

  throws(() => test({ relationship: 'AWE_INSIDER' }), 'not a test of the explanation',
    'somebody inside the project is refused outright, not down-weighted');
  throws(() => test({ restatement: '   ' }), 'records no restatement',
    'a scored test with no words under it is refused');
  throws(() => test({ explanationVersion: null }), 'which version of the explanation',
    'a test that does not name the wording is refused');
}

{
  // SCENARIO 1: five people misunderstand AWE.
  const five = [1, 2, 3, 4, 5].map((n) => test({ id: `t${n}`, person: `P${n}`, concepts: CONFUSED }));
  const s = C.comprehensionSummary(five);
  eq(s.verdict, 'CONFUSING', 'five people who did not get it is a CONFUSING sample');
  eq(s.plainLanguageTests, 0, 'and it raises the plain-language count by nothing');
  eq(s.weakestConcept, 'execution_not_advice', 'and it names the clause to rewrite');

  const facts = { narrative: { plainLanguageTests: 0, comprehensionTested: 5, comprehensionVerdict: 'CONFUSING' } };
  const beat = N.assessNarrative(facts).beats.find((b) => b.id === 'what_awe_is');
  eq(beat.status, 'NOT_READY', 'the "what AWE is" beat stays NOT_READY when the explanation was tested and failed');
  const slot = N.assessNarrative(facts).slots.find((s2) => s2.id === 'plain_language_test');
  check(!slot.known, 'evidence AGAINST the explanation does not partly fill the slot for it');
  check(slot.value.includes('did not land'), 'and the slot says the explanation is the thing to fix');
}

{
  // ONE FRIENDLY RESULT IS NOT A SAMPLE.
  const one = C.comprehensionSummary([test()]);
  eq(one.verdict, 'NOT_TESTED', 'one person is below the first sample');
  const beat = N.assessNarrative({ narrative: { plainLanguageTests: 1, comprehensionTested: 1, comprehensionVerdict: 'NOT_TESTED' } })
    .beats.find((b) => b.id === 'what_awe_is');
  eq(beat.status, 'NOT_READY', 'and one friendly restatement does not turn the beat green');

  const good = C.comprehensionSummary([1, 2, 3, 4, 5].map((n) => test({ id: `t${n}`, person: `P${n}` })));
  eq(good.verdict, 'CLEAR', 'five clear restatements is a CLEAR sample');
  eq(good.plainLanguageTests, 5, 'and every one of them counts');
  check(!/%/.test(good.say), 'the sentence to say out loud contains no percentage');
  check(good.say.includes('of 5 people asked'), 'it counts people');

  // ONE LOST PERSON IS ENOUGH TO STOP IT BEING CLEAR.
  const four = C.comprehensionSummary([
    ...[1, 2, 3, 4].map((n) => test({ id: `t${n}`, person: `P${n}` })),
    test({ id: 't5', person: 'P5', concepts: CONFUSED }),
  ]);
  eq(four.verdict, 'CONFUSING', 'four out of five is not a working explanation');
}

{
  // SCENARIO 8: a rewrite performs worse than the sentence it replaced.
  const v1 = [1, 2, 3].map((n) => test({ id: `a${n}`, at: '2026-09-01', person: `A${n}`, explanationVersion: 'v1' }));
  const v2 = [1, 2, 3].map((n) => test({ id: `b${n}`, at: '2026-10-01', person: `B${n}`, explanationVersion: 'v2', concepts: CONFUSED }));
  const cmp = C.byVersion([...v1, ...v2]);
  eq(cmp.regressions.length, 1, 'a revision that loses more people is reported as a regression');
  eq(cmp.regressions[0].to, 'v2', 'naming the version that made it worse');
  check(cmp.rows.length === 2, 'versions are compared, never pooled into one flattering number');
}

// ---------------------------------------------------------------------------
console.log('--- what they use instead is testimony, not a landscape -----------');

{
  throws(() => iv({ alternatives: [{ kind: 'spreadsheet' }] }), 'does not say who it came from',
    'an alternative with no attribution is refused');
  throws(() => iv({ alternatives: [{ kind: 'sharepoint', said: 'STATED' }] }), 'unknown alternative kind',
    'an unknown alternative kind is refused rather than bucketed');
  throws(() => iv({ alternatives: [{ kind: 'other', said: 'STATED' }] }), 'must say what it was',
    '"other" must say what it was');

  // SCENARIO: THE FOUNDER'S GUESS. Kept, shown, never counted.
  const guessed = ALT.analyseAlternatives([iv({ alternatives: [
    { kind: 'erp', said: 'FOUNDER_INFERRED', whatFails: 'probably clunky', whyNotFixed: 'probably expensive' }] })]);
  eq(guessed.analysed, 0, 'an alternative the founder inferred is not analysis');
  eq(guessed.founderInferredOnly, ['erp'], 'it is reported as the founder\'s, by name');
  eq(ALT.differentiationFacts(guessed, { positioningWritten: true }).alternativesAnalysed, 0,
    'and it moves the differentiation band by nothing');
  check(!ALT.differentiationFacts(guessed, { positioningWritten: true }).statedDifference,
    'a positioning document with no real alternative under it does not count as a stated difference');
}

{
  // SCENARIO 3: a real pain, and the ERP they already have handles it.
  const adequate = ALT.analyseAlternatives([iv({ alternatives: [
    { kind: 'erp', said: 'STATED', whatWorks: 'it does purchase orders fine', switchingCost: 'BLOCKING' }] })]);
  eq(adequate.adequate, ['erp'], 'an alternative with nothing failing is reported as ADEQUATE');
  eq(adequate.analysed, 0, 'and it is not counted as analysis, because nothing failed to analyse');
  const claim = ALT.alternativesClaim(adequate, { externalOrganizations: 1 });
  check(claim.adequateWarning && claim.adequateWarning.includes('against the problem'),
    'and the claim carries the finding that argues against us');

  const analysed = ALT.analyseAlternatives([iv({ alternatives: [
    { kind: 'email', said: 'STATED', whatFails: 'things get lost in a thread', whyNotFixed: 'nobody has time to look',
      switchingCost: 'LOW' }] })]);
  eq(analysed.analysed, 1, 'what fails plus why it persists, from the customer, is an analysed alternative');
  eq(analysed.rows[0].hardestSwitch, 'LOW', 'and the switching cost they reported is carried');
  eq(ALT.differentiationFacts(analysed, { positioningWritten: true }).alternativesAnalysed, 1,
    'and it moves the differentiation fact');
  check(RD.assess({ differentiation: ALT.differentiationFacts(analysed, { positioningWritten: true }) })
    .dimensions.find((d) => d.id === 'differentiation').level >= 1,
    'which moves the differentiation band off zero');
}

{
  // EVIDENCED DIFFERENCE IS NEVER DERIVED. Showing somebody the difference is
  // something a person does in a room.
  const strong = ALT.analyseAlternatives([1, 2, 3].map((n) => iv({
    id: `i${n}`, organization: `org-${n}`,
    alternatives: [{ kind: 'email', said: 'STATED', whatFails: 'lost in a thread', whyNotFixed: 'no time' }] })));
  const f = ALT.differentiationFacts(strong, { positioningWritten: true });
  check(!('evidencedDifference' in f), 'no arrangement of interview records claims the difference was demonstrated');
  eq(RD.assess({ differentiation: f }).dimensions.find((d) => d.id === 'differentiation').level, 2,
    'so differentiation is capped at band 2 by evidence alone');
}

// ---------------------------------------------------------------------------
console.log('--- a unit of sale is discovered, never decided -------------------');

{
  const withUnit = (org, unit, over = {}) => iv({
    id: `i-${org}`, organization: org,
    commercial: { buyer: 'OWNER', user: 'OFFICE_MANAGER', deploymentUnit: unit, said: 'STATED', ...over },
  });

  eq(UOS.analyseUnitOfSale([]).verdict.verdict, 'NOT_ASKED', 'nothing asked is NOT_ASKED, not "unknown"');
  eq(UOS.analyseUnitOfSale([withUnit('a', 'company_workflow')]).verdict.verdict, 'TOO_FEW',
    'one organization naming a unit is a preference, not a unit of sale');

  const two = UOS.analyseUnitOfSale([withUnit('a', 'company_workflow'), withUnit('b', 'company_workflow')]);
  eq(two.verdict.verdict, 'CANDIDATE', 'two organizations agreeing is a candidate');
  eq(UOS.businessModelFacts(two).unitDefined, false, 'a candidate does not define the unit');

  const three = UOS.analyseUnitOfSale(['a', 'b', 'c'].map((o) => withUnit(o, 'company_workflow')));
  eq(three.verdict.verdict, 'SUPPORTED', 'three outside organizations agreeing is supported');
  eq(UOS.businessModelFacts(three).unitDefined, true, 'and only then is the unit defined');
  eq(RD.assess({ businessModel: UOS.businessModelFacts(three) }).dimensions.find((d) => d.id === 'business_model').level, 1,
    'which moves the business-model band off zero, and no further — no price has been proposed');

  // A TIE IS A RESULT. Picking the first would manufacture a consensus.
  const split = UOS.analyseUnitOfSale([
    withUnit('a', 'company_workflow'), withUnit('b', 'seat'),
    withUnit('c', 'company_workflow'), withUnit('d', 'seat')]);
  eq(split.verdict.verdict, 'CONTESTED', 'an even split is CONTESTED, not a winner');
  eq(UOS.businessModelFacts(split).unitDefined, false, 'and it defines nothing');

  // FOUR ORGANIZATIONS AT ONE COMPANY ARE ONE COMPANY.
  const oneCompany = UOS.analyseUnitOfSale(['a', 'a', 'a'].map((o, n) => withUnit(o, 'company_workflow')));
  check(oneCompany.verdict.verdict !== 'SUPPORTED', 'three conversations inside one organization do not support a unit');
}

{
  // SCENARIO 5: they want the work done, not software.
  const service = UOS.analyseUnitOfSale([iv({ organization: 'org-a',
    commercial: { buyer: 'OWNER', deploymentUnit: 'service', wantsService: true, said: 'STATED' } })]);
  eq(service.findings.wantsService.length, 1, 'wanting a service is recorded as a finding');
  check(service.verdict.verdict !== 'SUPPORTED', 'and it does not support a software unit of sale');

  // SCENARIO 6: the buyer is not the user.
  const split = UOS.analyseUnitOfSale([iv({ organization: 'org-a',
    commercial: { buyer: 'OWNER', user: 'OFFICE_MANAGER', said: 'STATED' } })]);
  eq(split.findings.splitBuyerUser.length, 1, 'a buyer who is not the user is surfaced');

  // SCENARIO 7: would use it, would not pay.
  const free = UOS.analyseUnitOfSale([iv({ organization: 'org-a',
    willingnessToPay: 'WOULD_NOT_PAY', willingnessToChange: 'ACTIVELY_LOOKING',
    commercial: { buyer: 'OWNER', said: 'STATED' } })]);
  eq(free.findings.useNotPay.length, 1, 'enthusiasm without a budget is a finding');
  const claims = CL.assessClaims({ discovery: D.summarize([iv({ organization: 'org-a', willingnessToPay: 'WOULD_NOT_PAY' })]) });
  eq(claims.find((c) => c.id === 'will_pay').grade, 'UNAVAILABLE', 'and "customers will pay" stays UNAVAILABLE');
}

// ---------------------------------------------------------------------------
console.log('--- a pattern is organizations, and a count is not a percentage ---');

{
  // SCENARIO 4: the same pain in two of five conversations.
  const five = [
    iv({ id: 'i1', organization: 'a', patternTags: ['repeated_data_entry'] }),
    iv({ id: 'i2', organization: 'b', patternTags: ['repeated_data_entry'] }),
    iv({ id: 'i3', organization: 'c', patternTags: ['manual_po_creation'] }),
    iv({ id: 'i4', organization: 'd', patternTags: ['no_purchasing_pain'] }),
    iv({ id: 'i5', organization: 'e', patternTags: ['lost_paperwork'] }),
  ];
  const patterns = D.repeatedPatterns(five);
  const rde = patterns.find((p) => p.tag === 'repeated_data_entry');
  eq(rde.organizations, 2, 'two organizations named it, and the record says two');
  check(rde.externallyCorroborated, 'which is corroboration');
  eq(D.summarize(five).repeatedPatterns, 1, 'one corroborated pattern out of five conversations');

  const { marketClaim, analyse } = await import(R('programs/discovery/patterns.mjs'));
  const claim = marketClaim(analyse(five));
  check(!/%/.test(claim.sentence), 'the market sentence contains no percentage');
  check(claim.mayNotSay.some((m) => /percentage/i.test(m)), 'and says so explicitly');

  // FIVE CONVERSATIONS INSIDE ONE COMPANY ARE ONE COMPANY.
  const inside = [1, 2, 3, 4, 5].map((n) => iv({ id: `x${n}`, organization: 'a', patternTags: ['repeated_data_entry'] }));
  eq(D.repeatedPatterns(inside).length, 0, 'five people at one company name no pattern');
}

{
  // SCENARIO 2: they like AWE and report no problem.
  const happy = [iv({ id: 'i1', organization: 'a', patternTags: ['no_purchasing_pain'] }),
    iv({ id: 'i2', organization: 'b', patternTags: ['no_purchasing_pain'] })];
  const { analyse } = await import(R('programs/discovery/patterns.mjs'));
  const a = analyse(happy);
  eq(a.corroboratedPains.length, 0, 'two businesses agreeing they have no problem is not a corroborated pain');
  eq(a.corroboratedAbsences.length, 1, 'it is a corroborated absence, which is a different and real finding');
  const claims = CL.assessClaims({ discovery: D.summarize(happy) });
  check(!claims.find((c) => c.id === 'external_pain').proven, 'and "other businesses have this pain" is not proven by it');
}

// ---------------------------------------------------------------------------
console.log('--- a mock pitch is about the pitch, and never about the market ---');

{
  const mp = (over = {}) => MP.mockPitch({
    id: 'm1', at: '2026-11-01', listener: 'STRANGER', listenerBackground: 'accountant',
    whatTheyThoughtItWas: 'software that does the ordering', ...over });

  eq(mp().countsAsMockPitch, true, 'a listener who said something makes it a mock pitch');
  const alone = MP.mockPitch({ id: 'm2', at: '2026-11-01', listener: 'STRANGER', listenerBackground: 'accountant' });
  eq(alone.countsAsMockPitch, false, 'a delivery nobody responded to is a rehearsal');
  check(alone.why.includes('rehearsal'), 'and it says why it did not count');
  eq(MP.mockPitchFacts([mp(), alone]).mockPitches, 1, 'only the one with a listener counts');
  eq(MP.mockPitchFacts([mp(), alone]).rehearsals, 2, 'both count as rehearsals');
  eq(MP.mockPitchFacts([mp({ listener: 'AWE_INSIDER' })]).mockPitches, 0,
    'somebody inside the project listening to the pitch is not a test of it');

  throws(() => mp({ demoShown: true }), 'records no effect', 'a demonstration with no recorded effect is refused');

  // SCENARIO 10: the pitch lands and nothing outside the building has changed.
  const glowing = [1, 2, 3, 4, 5].map((n) => mp({ id: `m${n}`, trust: 'BELIEVED', strongestPoint: 'the live demo' }));
  const facts = { narrative: MP.mockPitchFacts(glowing), demo: { rehearsals: 5 } };
  const assessment = RD.assess(facts);
  eq(assessment.dimensions.find((d) => d.id === 'customer_discovery').level, 0,
    'five glowing mock pitches move customer discovery by nothing');
  eq(assessment.dimensions.find((d) => d.id === 'problem_evidence').level, 0, 'and problem evidence by nothing');
  eq(assessment.dimensions.find((d) => d.id === 'external_validation').level, 0, 'and external validation by nothing');
  const keys = Object.keys(MP.mockPitchFacts(glowing));
  check(!keys.some((k) => /discovery|interview|organization|market/i.test(k)),
    'nothing in the mock-pitch facts is shaped like a discovery fact');

  // REPEATED CONFUSION IS THE OUTPUT.
  const lost = [1, 2, 3].map((n) => mp({ id: `c${n}`, confusingPoint: 'what the proof numbers meant' }));
  eq(MP.mockPitchLearning(lost).repeatedConfusion[0].count, 3, 'three listeners lost at the same beat is a finding');
  eq(MP.mockPitchLearning([mp({ trust: 'BELIEVED' }), mp({ id: 'm9', trust: 'SCEPTICAL' })]).lowestTrust, 'SCEPTICAL',
    'the pitch is reported against the most sceptical person in the room, not the average');
}

// ---------------------------------------------------------------------------
console.log('--- the founder story is a form, and it scores nothing ------------');

{
  const empty = FS.founderStory({});
  eq(empty.outstanding.length, 5, 'five facts, none of them invented');
  eq(empty.mayTellTheIncident, false, 'and the incident may not be told');
  throws(() => FS.founderStory({ role: 'apprentice' }), 'is a bare value', 'a founder fact with no confirmation is refused');
  throws(() => FS.founderStory({ role: { value: 'apprentice' } }), 'no confirmedBy', 'and one with no date is refused');

  const filled = FS.founderStory({ incident: { value: 'the 14 March order', confirmedBy: 'Jack Daly', confirmedAt: '2026-09-05' } });
  eq(filled.mayTellTheIncident, true, 'a confirmed incident may be told');
  const before = RD.assess({});
  const after = RD.assess(FS.founderStoryFacts(filled));
  eq(after.total, before.total, 'and confirming it moves no readiness band, because the rubric has no team criterion');
}

// ---------------------------------------------------------------------------
console.log('--- the field sheet refuses rather than guesses -------------------');

{
  const sheet = (s) => IMP.importSheet(s, { source: 'sheet' });

  const noKind = await sheet('id: x\n');
  check(noKind.errors.some((e) => e.includes('does not say what it is')), 'a sheet that does not name its kind is refused');

  const noAttribution = await sheet([
    'kind: interview', 'id: i1', 'at: 2026-09-10', 'organization: org-a', 'role: office manager',
    'workflow: buying material', 'pain: everything is typed twice', 'pattern-tags: repeated_data_entry',
  ].join('\n'));
  check(noAttribution.errors.some((e) => e.includes('pain-said')),
    'a pain with no attribution is refused — the importer never assumes the customer said it');
  eq(noAttribution.record, null, 'and nothing is built');

  const typo = await sheet([
    'kind: interview', 'id: i1', 'at: 2026-09-10', 'organization: org-a', 'role: office manager',
    'workflow: buying material', 'pain: typed twice', 'pain-said: STATED', 'pattern-tag: repeated_data_entry',
  ].join('\n'));
  check(typo.errors.some((e) => e.includes('patternTag')),
    'a typo\'d key is reported as a typo, not silently dropped into a confusing downstream refusal');

  const good = await sheet([
    'kind: interview', 'id: i1', 'at: 2026-09-10', 'organization: org-a', 'organization-type: electrical, 30 staff',
    'role: office manager', 'workflow: buying material', 'pain: the same detail is typed three times',
    'pain-said: STATED', 'pain-quote: we type it into three things',
    'pattern-tags: repeated_data_entry, lost_paperwork',
    'willingness-to-change: OPEN_IF_PROVEN',
    '--- alternative', 'kind: spreadsheet', 'said: STATED', 'what-fails: nobody updates it',
    'why-not-fixed: no time to look', 'switching-cost: LOW',
    '--- commercial', 'buyer: OWNER', 'user: OFFICE_MANAGER', 'deployment-unit: company_workflow', 'said: STATED',
  ].join('\n'));
  eq(good.errors, [], 'a filled-in sheet imports cleanly');
  eq(good.record.pain.said, 'STATED', 'carrying the attribution');
  eq(good.record.alternatives.length, 1, 'the alternative block');
  eq(good.record.commercial.deploymentUnit, 'company_workflow', 'and the commercial block');
  const built = D.interview(good.record);
  eq(built.patternTags.length, 2, 'and the record the module builds from it is the real thing');

  // A BLANK TEMPLATE IMPORTS NOTHING. Its own instructions are comments.
  const { readFileSync } = await import('node:fs');
  for (const t of ['programs/discovery/templates/interview.md', 'programs/evidence/templates/comprehension.md',
    'programs/evidence/templates/mock-pitch.md']) {
    const r = await sheet(readFileSync(R(t), 'utf8'));
    check(r.errors.length > 0 && r.record === null, `the blank template ${t.split('/').pop()} is refused`);
    check(r.errors.every((e) => /is required and is empty/.test(e)),
      `and only for its empty required fields, not for its own help text (${t.split('/').pop()})`);
  }
}

// ---------------------------------------------------------------------------
console.log('--- the map points at things that exist --------------------------');

{
  const slotIds = new Set(N.SLOTS.map((s) => s.id));
  const beatIds = new Set(N.BEATS.map((b) => b.id));
  const claimIds = new Set(CL.CLAIM_IDS);
  const dimIds = new Set(RD.DIMENSIONS.map((d) => d.id));

  for (const row of ST.EVIDENCE_MAP) {
    for (const s of row.slots) check(slotIds.has(s), `${row.id} names evidence slot "${s}", which exists`);
    for (const b of row.beats) check(beatIds.has(b), `${row.id} names beat "${b}", which exists`);
    for (const c of row.claims) check(claimIds.has(c), `${row.id} names claim "${c}", which exists`);
    for (const d of row.dimensions) check(dimIds.has(d), `${row.id} names dimension "${d}", which exists`);
    check(row.steps <= 2, `${row.id} is at most two steps from a real event to a readiness change`);
    check(row.steps !== 1 || row.id === 'founder_story',
      `${row.id} does not skip validation on the way in`);
  }
  for (const a of ST.AREAS) {
    check(beatIds.has(a.beat), `area ${a.id} names beat "${a.beat}", which exists`);
    for (const e of a.evidence) check(ST.EVIDENCE_MAP.some((r) => r.id === e), `area ${a.id} names evidence "${e}", which exists`);
  }
}

{
  // THE STATUS VIEW READS; IT DOES NOT PLAN. Every action it prints must be a
  // string the planner produced, or there are two planners.
  const facts = { discovery: D.summarize([]) };
  const claims = CL.assessClaims(facts);
  const narrative = N.assessNarrative(facts);
  const status = ST.evidenceStatus({ narrative, claims, facts });
  const actions = new Set(claims.map((c) => c.nextAction));
  for (const a of status) {
    if (a.nextAction) check(actions.has(a.nextAction), `${a.id} prints an action the planner produced`);
    const beat = narrative.beats.find((b) => b.id === a.beat);
    eq(a.status, beat.status, `${a.id} reports the beat's own status`);
  }
}

{
  // THE SNAPSHOT'S PROHIBITIONS ARE DERIVED FROM ABSENCE, and each names what
  // would retire it. A typed list goes stale in the flattering direction.
  const facts = { discovery: D.summarize([]), repeatability: { externallyValidated: false } };
  const snap = ST.pitchSnapshot({ facts, claims: CL.assessClaims(facts), narrative: N.assessNarrative(facts) });
  check(snap.mustNotClaim.length > 5, 'with no evidence, most things may not be claimed');
  check(snap.mustNotClaim.every((m) => m.until), 'and every prohibition names the fact that would retire it');
  check(snap.mustNotClaim.some((m) => /synthetic/.test(m.say)), 'the synthetic second company is prohibited by name');
  eq(snap.supported.length, 0, 'nothing is supported on no evidence');

  const strong = { ...facts, repeatability: { externallyValidated: true, profileHonouredPercent: 92, secondOrganizationProven: true } };
  const after = ST.pitchSnapshot({ facts: strong, claims: CL.assessClaims(strong), narrative: N.assessNarrative(strong) });
  check(!after.mustNotClaim.some((m) => /synthetic/.test(m.say)),
    'and the prohibition disappears when the fact behind it changes, without anybody editing a list');
}

// ---------------------------------------------------------------------------
console.log('--- an inference never wears the customer\'s voice -----------------');

{
  const inferred = iv({ pain: said('the crew stands idle', 'FOUNDER_INFERRED') });
  eq(inferred.pain.said, 'FOUNDER_INFERRED', 'the attribution survives onto the record');
  eq(inferred.restsOnTestimony, false, 'and the record says it does not rest on testimony');
  const { analyse } = await import(R('programs/discovery/patterns.mjs'));
  const a = analyse([inferred, iv({ id: 'i2', organization: 'b', pain: said('the crew stands idle', 'FOUNDER_INFERRED') })]);
  eq(a.testimony.painsStated, 0, 'two inferred pains produce no stated pains');
  const { marketStage } = await import(R('programs/discovery/market-gate.mjs'));
  const stage = marketStage({ externalInterviews: 2, externalOrganizations: 2,
    corroboratedPains: a.corroboratedPains.length, painsStated: a.testimony.painsStated, designPartnerCandidates: 0 });
  check(stage.stage !== 'REPEATED_PAIN_OBSERVED',
    'and the market gate does not reach REPEATED_PAIN_OBSERVED on the founder\'s own conclusions');
}

// ---------------------------------------------------------------------------
console.log('--- the whole loop, once -----------------------------------------');

{
  // A real conversation, captured on a sheet, imported, and every downstream
  // number moving on its own.
  const { readFileSync } = await import('node:fs');
  const sheetText = [
    'kind: comprehension', 'id: t1', 'at: 2026-09-10', 'person: AB', 'background: plumber',
    'relationship: STRANGER', 'version: spoken-v1',
    'restatement: it does the ordering paperwork itself, by the rules the boss sets, so nobody has to type it',
    'concept-business-operations-work: PRESENT', 'concept-execution-not-advice: PRESENT',
    'concept-company-rules: PRESENT', 'concept-reduced-human-handling: PRESENT',
  ].join('\n');
  const imported = await IMP.importSheet(sheetText, { source: 'sheet' });
  eq(imported.errors, [], 'the sheet imports');
  const record = C.comprehensionTest(imported.record);
  const five = [1, 2, 3, 4, 5].map((n) => C.comprehensionTest({ ...imported.record, id: `t${n}`, person: `P${n}` }));
  const summary = C.comprehensionSummary(five);

  const before = RD.assess({});
  const after = RD.assess({ narrative: { plainLanguageTests: summary.plainLanguageTests, oneMinuteExists: false } });
  eq(record.verdict, 'CLEAR', 'the record scores itself');
  eq(summary.plainLanguageTests, 5, 'the sample counts the clear ones');

  const facts = { narrative: {
    plainLanguageTests: summary.plainLanguageTests,
    comprehensionTested: summary.tested,
    comprehensionVerdict: summary.verdict } };
  eq(N.assessNarrative(facts).beats.find((b) => b.id === 'what_awe_is').status, 'STRONG',
    'the presentation beat becomes deliverable');
  check(after.total >= before.total, 'and no band went down because a real thing happened');

  const { status } = await import(R('programs/iic-2027/milestones.mjs'));
  const rung = status(facts).rows.find((r) => r.id === 'rehearsal_explain');
  check(rung.met, 'the September rehearsal rung is met by people, not by a document');
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`evidence checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  · ${f}`); process.exit(1); }
