// ---------------------------------------------------------------------------
// eval-market-discovery.mjs — can this system tell us we are wrong?
//
// THE ONLY INTERESTING TEST OF A VALIDATION SYSTEM. Fed encouraging evidence it
// will say encouraging things whatever its logic is, so every scenario below is
// one where the comfortable conclusion is available and wrong: a contractor with
// no purchasing problem, one with an ERP that already works, a pain that is real
// and rare, an owner who loves it and a staff who do not, a business whose pain
// AWE cannot touch.
//
// The assertion in each is what the system REFUSES to conclude.
//
// AND THE INTEGRITY RULE THAT UNDERPINS ALL OF IT: a founder's inference must
// never be readable as a customer's testimony. Six weeks after a conversation
// nobody remembers which was which, and that is precisely when somebody quotes
// it. The record makes the distinction structural rather than remembered.
//
// SYNTHETIC INTERVIEWS ONLY, in memory. A test asserts the committed interview
// directory is still empty, because a suite that quietly populated it would
// hand us an imagined market.
//
//   node scripts/eval-market-discovery.mjs
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => join(ROOT, p);

const { interview, testimony, ATTRIBUTION, repeatedPatterns, summarize } =
  await import(R('programs/discovery/interview.mjs'));
const { analyse, marketClaim, PAIN_CATALOGUE, KNOWN_TAGS } = await import(R('programs/discovery/patterns.mjs'));
const { marketStage, qualify, candidates, STAGES, QUALIFICATION } = await import(R('programs/discovery/market-gate.mjs'));
const { externalReadiness, VERDICTS } = await import(R('programs/discovery/external-readiness.mjs'));

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
const throws = (fn, needle, name) => {
  let m = null;
  try { fn(); } catch (e) { m = e.message; }
  if (m === null) return check(false, name, 'it was allowed');
  return check(m.toLowerCase().includes(needle.toLowerCase()), name, `threw: ${m}`);
};

const said = (value, s = 'STATED', quote = null) => ({ value, said: s, quote });
let n = 0;
const talk = (org, over = {}) => interview({
  id: `i${++n}`, at: '2026-10-14', organization: org, organizationType: 'electrical',
  organizationSize: '~30 employees', role: 'office manager',
  workflow: 'material request to receipt',
  pain: said('requests arrive by text and get lost'),
  frequency: said('several a day'),
  patternTags: ['material_request_fragmentation'],
  ...over,
});
const stageOf = (interviews) => {
  const a = analyse(interviews);
  return marketStage({
    externalInterviews: a.sample.externalInterviews,
    externalOrganizations: a.sample.externalOrganizations,
    corroboratedPains: a.corroboratedPains.length,
    painsStated: a.testimony.painsStated,
    designPartnerCandidates: interviews.filter((i) => !i.internal && i.designPartnerInterest).length,
  });
};

// ---------------------------------------------------------------------------
console.log('--- a founder\'s conclusion is never a customer\'s testimony -------');
{
  eq(ATTRIBUTION, ['STATED', 'FOUNDER_OBSERVED', 'FOUNDER_INFERRED', 'UNKNOWN'],
    'four attributions, and the two founder ones name the founder');
  const { PROVENANCE_GRADES } = await import(R('proof/provenance.mjs'));
  // A MUTATION-ADJACENT FINDING: the first version used bare INFERRED, which is
  // also a provenance grade meaning something mid-table. Here it means "Jack
  // decided this" and is the weakest value in the file. One word, two rankings,
  // in a repository where both appear near each other.
  check(!ATTRIBUTION.some((a) => PROVENANCE_GRADES.includes(a)),
    'no word is shared with proof/provenance.mjs, where the same word would rank differently');

  throws(() => talk('Acme', { economicConsequence: 'a crew stood down' }),
    'is a bare value', 'a bare interpreted value is refused');
  throws(() => testimony('x', 'GUESSED'), 'unknown attribution', 'an attribution nobody defined is refused');
  throws(() => testimony('x', 'UNKNOWN'), 'say who it came from',
    'and a value attributed to UNKNOWN is refused rather than quietly kept');

  const i = talk('Acme', {
    pain: said('requests get lost', 'STATED', 'half of them are on my phone'),
    economicConsequence: said('a crew stood down for a morning', 'FOUNDER_INFERRED'),
  });
  eq(i.pain.said, 'STATED', 'what they said is marked as theirs');
  eq(i.pain.quote, 'half of them are on my phone', 'with their words kept');
  eq(i.economicConsequence.said, 'FOUNDER_INFERRED', 'and what the founder concluded is marked as his');
  eq(i.restsOnTestimony, true, 'the record says whether the pain itself rests on testimony');
  eq(talk('B', { pain: said('they seem overwhelmed', 'FOUNDER_INFERRED') }).restsOnTestimony, false,
    'and says so when it does not');
  notes.push('an inferred consequence cannot be read as a customer quote — the shape refuses it');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: the contractor has no purchasing problem ------------');
{
  const s = stageOf([
    talk('Acme', { pain: said('honestly the ordering side is fine'), patternTags: ['no_purchasing_pain'] }),
    talk('Bolt', { pain: said('we have never had a problem with material'), patternTags: ['no_purchasing_pain'] }),
    talk('Crown', { pain: said('ordering works, scheduling is the mess'), patternTags: ['scheduling_churn'] }),
  ]);
  eq(s.stage, 'DISCOVERY_STARTED', 'three conversations start discovery');
  check(s.stage !== 'REPEATED_PAIN_OBSERVED',
    'and go no further — two businesses agreeing they have NO problem is a finding, not a repeated pain');

  const a = analyse([
    talk('Acme', { pain: said('ordering is fine'), patternTags: ['no_purchasing_pain'] }),
    talk('Bolt', { pain: said('never had a problem'), patternTags: ['no_purchasing_pain'] }),
  ]);
  eq(a.corroboratedAbsences.length, 1, 'the shared absence is reported in its own list');
  eq(a.corroboratedPains.length, 0, 'and counts as no pain at all');
  eq(a.corroborated.length, 1, 'while still appearing among what was corroborated');
  check(a.awePainsNotCorroborated.length > 5,
    'and the AWE pains nobody corroborated are listed prominently');
  notes.push('two contractors with no purchasing problem produce no corroborated AWE pain');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: they already have an ERP that works ------------------');
{
  const erp = [
    talk('Acme', { currentTools: ['Procore', 'Sage'], pain: said('none really, Procore handles it'),
      patternTags: ['no_purchasing_pain'], willingnessToChange: 'WILL_NOT_CHANGE' }),
    talk('Bolt', { currentTools: ['Vista'], pain: said('it is clunky but it works'),
      patternTags: ['no_purchasing_pain'], willingnessToChange: 'CONTENT_WITH_WORKAROUND' }),
  ];
  const a = analyse(erp);
  const c = candidates(erp, a);
  check(c.every((x) => !x.viable), 'neither is a viable design partner');
  check(c.every((x) => x.blockedBy.some((b) => /addressable_pain/.test(b))),
    'because no reported pain maps to a capability AWE has');
  check(a.corroborated.every((p) => !p.addressable) || a.corroborated.length === 0,
    'and nothing addressable is corroborated');
  notes.push('a business whose ERP works is recorded as a negative result, not skipped');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: real pain, but rare ----------------------------------');
{
  const rare = [
    talk('Acme', { frequency: said('maybe twice a year'), economicConsequence: said('cost us a day once') }),
    talk('Bolt', { frequency: said('once or twice a year') }),
  ];
  const a = analyse(rare);
  eq(a.corroborated.length, 1, 'the pain is corroborated across two organizations');
  const c = candidates(rare, a);
  check(c.every((x) => x.criteria.find((k) => k.id === 'pain_is_frequent').answer === 'NO'),
    'and every candidate fails the frequency criterion');
  check(c.every((x) => x.viable), 'they are still viable — frequency is not disqualifying');
  check(c.every((x) => x.met < 6), 'but they do not meet everything');
  notes.push('a rare pain is corroborated and flagged as too rare to measure in a pilot');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: strong inspection pain, no purchasing pain ----------');
{
  const inspection = [
    talk('Acme', { pain: said('writing up inspections takes my best guy two days a week'),
      patternTags: ['inspection_report_labor'], frequency: said('weekly') }),
    talk('Bolt', { pain: said('the reports are the bottleneck, not the buying'),
      patternTags: ['inspection_report_labor'], frequency: said('weekly') }),
  ];
  const a = analyse(inspection);
  eq(a.corroborated.length, 1, 'inspection pain is corroborated');
  eq(a.corroborated[0].capability, 'tegg_reporting', 'and it maps to a capability that is not purchasing');
  check(a.awePainsNotCorroborated.includes('material_request_fragmentation'),
    'while the purchasing pains remain uncorroborated — which is the finding');
  notes.push('inspection pain corroborated and purchasing pain not: the wedge, not the product, is in question');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: a pain AWE cannot address at all ---------------------');
{
  const uncovered = [
    talk('Acme', { pain: said('nobody knows what a job cost until it is over'), patternTags: ['job_costing_gap'] }),
    talk('Bolt', { pain: said('we find out we lost money months later'), patternTags: ['job_costing_gap'] }),
    talk('Crown', { pain: said('job costing is the whole problem'), patternTags: ['job_costing_gap'] }),
  ];
  const a = analyse(uncovered);
  eq(a.unaddressed.length, 1, 'the pain three businesses share is reported as unaddressed');
  eq(a.unaddressed[0].tag, 'job_costing_gap', 'by name');
  eq(a.unaddressed[0].capability, null, 'with no capability behind it');
  eq(PAIN_CATALOGUE.job_costing_gap.capability, null,
    'the catalogue admits AWE has nothing for it rather than claiming a near-fit');
  check(candidates(uncovered, a).every((x) => !x.viable),
    'and nobody reporting only that pain is a viable partner');
  notes.push('the most valuable finding — a shared pain AWE cannot touch — is reported first, not buried');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: the owner loves it, the staff do not -----------------');
{
  const split = [
    interview({ id: 'own1', at: '2026-10-14', organization: 'Acme', organizationType: 'electrical',
      role: 'owner', workflow: 'material request to receipt',
      pain: said('I am sure we waste a fortune on this'), patternTags: ['material_request_fragmentation'],
      designPartnerInterest: true, willingnessToChange: 'ACTIVELY_LOOKING' }),
    interview({ id: 'staff1', at: '2026-10-14', organization: 'Acme', organizationType: 'electrical',
      role: 'office manager', workflow: 'material request to receipt',
      pain: said('the system we have is fine, I know where everything is'),
      patternTags: ['no_purchasing_pain'], willingnessToChange: 'CONTENT_WITH_WORKAROUND' }),
  ];
  const a = analyse(split);
  eq(a.sample.externalOrganizations, 1, 'two people at one company is ONE organization');
  eq(a.corroborated.length, 0, 'so nothing is corroborated, however enthusiastic the owner');
  eq(stageOf(split).stage, 'UNVALIDATED', 'and the stage does not move');
  const c = candidates(split, a)[0];
  check(c.criteria.find((k) => k.id === 'willing_to_change').answer === 'YES',
    'the owner\'s enthusiasm is recorded');
  check(a.patterns.some((p) => p.tag === 'no_purchasing_pain'),
    'and so is the contradiction from the person who does the work');
  notes.push('an enthusiastic owner and a content office manager is one organization, uncorroborated, with the contradiction preserved');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: contradictory evidence inside one interview ----------');
{
  const contradictory = talk('Acme', {
    pain: said('it is a nightmare, we lose orders constantly'),
    frequency: said('maybe once a month'),
    willingnessToChange: 'CONTENT_WITH_WORKAROUND',
    existingWorkaround: said('the spreadsheet works fine actually'),
    satisfactionWithWorkaround: said('seems happy with it', 'FOUNDER_OBSERVED'),
  });
  eq(contradictory.pain.said, 'STATED', 'the strong words are kept');
  eq(contradictory.satisfactionWithWorkaround.said, 'FOUNDER_OBSERVED',
    'and so is the founder\'s contrary observation, marked as his');
  const c = qualify([contradictory], analyse([contradictory]));
  check(c.criteria.find((k) => k.id === 'willing_to_change').answer === 'NO',
    'the qualification reads the behaviour, not the adjective');
  check(c.criteria.find((k) => k.id === 'pain_is_frequent').answer === 'NO',
    'and the frequency, not the intensity of the language');
  notes.push('"a nightmare, once a month, and the spreadsheet is fine" qualifies on behaviour rather than adjectives');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: the same pain as Lippolis ---------------------------');
{
  const matching = [
    talk('Acme', { economicConsequence: said('a crew stood down for a morning'), humanTimeStated: said('20 minutes an order'),
      willingnessToChange: 'ACTIVELY_LOOKING', designPartnerInterest: true, role: 'operations manager' }),
    talk('Bolt', { organizationType: 'hvac', economicConsequence: said('we ordered the same thing twice'),
      humanTimeStated: said('half an hour'), willingnessToChange: 'OPEN_IF_PROVEN', role: 'owner' }),
    talk('Crown', { organizationType: 'plumbing', willingnessToChange: 'ACTIVELY_LOOKING', role: 'office manager' }),
  ];
  const a = analyse(matching);
  eq(a.corroborated.length, 1, 'the pain is corroborated');
  eq(a.corroborated[0].externalOrganizations, 3, 'across three outside organizations');
  eq(a.corroborated[0].addressable, true, 'and AWE addresses it');
  eq(a.corroborated[0].organizationTypes.length, 3, 'across three trades, which is the strong version');
  const s = stageOf(matching);
  eq(s.stage, 'DESIGN_PARTNER_INTEREST', 'the stage advances to design-partner interest');
  check(s.stage !== 'DESIGN_PARTNER_COMMITTED', 'and stops short of commitment, which nobody has given');

  const c = candidates(matching, a);
  check(c[0].viable, 'the best candidate is viable');
  check(c[0].criteria.find((k) => k.id === 'measurable_before').answer === 'YES',
    'because they described their own handling time, so a before exists');
  notes.push('three trades describing the same addressable pain reaches DESIGN_PARTNER_INTEREST and no further');
}

// ---------------------------------------------------------------------------
console.log('--- SCENARIO: they want a pilot immediately ------------------------');
{
  const eager = [talk('Acme', { designPartnerInterest: true, willingnessToChange: 'ACTIVELY_LOOKING',
    willingnessToPay: 'WOULD_PAY_STATED_AMOUNT', statedAmount: '$500/month', role: 'owner',
    humanTimeStated: said('20 minutes an order') })];
  const a = analyse(eager);
  const c = qualify(eager, a);
  check(c.viable, 'an eager, reachable owner with an addressable pain is viable');
  eq(c.met, 6, 'meeting every criterion');
  eq(c.unknown, 0, 'with nothing left unknown');
  const s = stageOf(eager);
  eq(s.stage, 'UNVALIDATED',
    'and the market stage is still UNVALIDATED — one enthusiastic company is not discovery');
  check(/three different organizations/.test(s.next.needs),
    'the next stage still asks for three organizations');
  notes.push('one company wanting a pilot tomorrow does not advance market validation at all');
}

// ---------------------------------------------------------------------------
console.log('--- the gate cannot be reached by wishing --------------------------');
{
  eq(STAGES[0], 'UNVALIDATED', 'the first stage is unvalidated');
  eq(STAGES.at(-1), 'PAYING_CUSTOMER', 'and the last is somebody paying');
  eq(marketStage({}).stage, 'UNVALIDATED', 'an empty record is UNVALIDATED');
  check(/We have one customer/.test(marketStage({}).claim), 'and says nothing may be claimed');

  // Five people at one company.
  eq(marketStage({ externalInterviews: 5, externalOrganizations: 1 }).stage, 'UNVALIDATED',
    'five conversations at one organization is UNVALIDATED');
  // A survey.
  eq(marketStage({ externalInterviews: 40, externalOrganizations: 40, corroboratedPains: 0 }).stage,
    'DISCOVERY_STARTED', 'forty conversations with no corroborated pain go no further than discovery started');
  // Enthusiasm without testimony.
  eq(marketStage({ externalInterviews: 5, externalOrganizations: 5, corroboratedPains: 1, painsStated: 0 }).stage,
    'DISCOVERY_STARTED', 'a corroborated pain nobody stated in their own words does not count');
  // Stages do not skip.
  const skipped = marketStage({ payingCustomers: 1 });
  eq(skipped.stage, 'UNVALIDATED', 'a paying customer with no recorded discovery does not jump the queue');
  eq(skipped.anomalies.length, 1, 'it is reported as an anomaly');
  check(/record is incomplete/.test(skipped.anomalies[0]), 'meaning the record is incomplete, not the company validated');
  notes.push('five people at one company, forty with no pattern, and a paying customer with no discovery all fail');
}

// ---------------------------------------------------------------------------
console.log('--- no market prevalence may be claimed ---------------------------');
{
  const many = Array.from({ length: 30 }, (_, i) => talk(`Org${i}`, { organizationType: 'electrical' }));
  const a = analyse(many);
  const claim = marketClaim(a);
  eq(a.corroborated[0].externalOrganizations, 30, 'thirty organizations reported the same pain');
  check(!/%/.test(claim.sentence), 'and the sentence contains no percentage');
  check(!/most|majority|common|widespread|universal/i.test(claim.sentence),
    'nor a word implying prevalence');
  check(/not an estimate of the market/.test(claim.sentence), 'and says what it is not');
  check(/not a random sample/.test(claim.maySay.join(' ')), 'and how the sample was assembled');
  check(claim.mayNotSay.length >= 3, 'with the forbidden claims enumerated');
  eq(a.sample.selection, 'conversations the founder could arrange; not a random sample of any population',
    'the selection method is carried on the sample itself, not only in the claim');

  // Checked as ARITHMETIC rather than as vocabulary: the module's own prose
  // says the word "percentage" in the list of things that may not be claimed,
  // and the first version of this test matched that.
  const src = readFileSync(R('programs/discovery/patterns.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/'[^']*'/g, "''");
  check(!/\* *100|\/ *(total|population|market)/i.test(src),
    'and the module computes no percentage of any population');
  notes.push('thirty organizations still produce a sentence with no percentage in it');
}

// ---------------------------------------------------------------------------
console.log('--- corroboration counts organizations, not conversations ---------');
{
  const threeAtOne = [
    talk('Acme', { role: 'owner' }), talk('Acme', { role: 'office manager' }), talk('Acme', { role: 'foreman' }),
  ];
  const a = analyse(threeAtOne);
  eq(a.sample.externalInterviews, 3, 'three conversations');
  eq(a.sample.externalOrganizations, 1, 'at one organization');
  eq(a.corroborated.length, 0, 'corroborate nothing');
  eq(repeatedPatterns(threeAtOne).length, 0, 'and the older pattern function agrees');

  // Lippolis plus one outsider is one outsider.
  const withInternal = [
    talk('Lippolis Electric', { internal: true }),
    talk('Acme'),
  ];
  const b = analyse(withInternal);
  eq(b.sample.externalOrganizations, 1, 'our own customer is not an outside organization');
  eq(b.corroborated.length, 0, 'so a pain we share with one outsider is not corroborated');
  eq(b.patterns[0].organizations, 2, 'while the raw count still shows both');
  notes.push('three people at one company, and Lippolis plus one outsider, both corroborate nothing');
}

// ---------------------------------------------------------------------------
console.log('--- what a second organization would actually meet ------------------');
{
  const r = externalReadiness();
  eq(VERDICTS, ['READY_GENERICALLY', 'CONFIGURABLE', 'LIPPOLIS_SPECIFIC', 'UNKNOWN'], 'four verdicts');
  check(r.counts.UNKNOWN > 0,
    'some concerns are UNKNOWN — the report does not pretend the unmodelled parts are fine');
  check(r.counts.LIPPOLIS_SPECIFIC > 0, 'and some are still Lippolis-specific');
  check(r.unknowns.some((u) => /data_migration/.test(u)),
    'including migration, which nothing models and which a switching customer will expect');
  check(r.blockers.some((b) => /workflow_lifecycle/.test(b)),
    'and the workflow lifecycle, which is not configuration');
  check(/different capability/.test(r.partnerConstraint) && /rules engine/.test(r.partnerConstraint),
    'the constraint that decides the shortlist is named, and why it is a feature rather than a defect');
  check(!/%/.test(r.summary), 'the summary is not a percentage — profile fields and unmodelled concerns do not average');

  // It must be built FROM the profile, not beside it.
  const { PROFILE_FIELDS } = await import(R('capability/purchasing/profile.mjs'));
  const fromProfile = r.concerns.filter((c) => c.source === 'profile');
  eq(fromProfile.length, Object.keys(PROFILE_FIELDS).length,
    'every profile field appears, read from the profile rather than restated');
  notes.push(`second deployment: ${r.summary}`);
}

// ---------------------------------------------------------------------------
console.log('--- the founder kit matches the code ------------------------------');
{
  const kit = readFileSync(R('docs/discovery/FIRST_FIVE_INTERVIEWS.md'), 'utf8');
  check(/Do not open by explaining AWE/i.test(kit), 'the kit says not to lead with the product');
  check(/Would automation help you/.test(kit), 'and names the question that is worth nothing');
  for (const a of ATTRIBUTION.filter((x) => x !== 'UNKNOWN')) {
    check(kit.includes(a), `the kit explains the ${a} attribution the record demands`);
  }
  check(/come back and say the answer is no/i.test(kit),
    'and gives the founder permission to return with a negative result');
  check(/one company's opinion/i.test(kit), 'and that three people at one company corroborate nothing');
  for (const example of ['material_request_fragmentation', 'ACTIVELY_LOOKING', 'designPartnerInterest']) {
    check(kit.includes(example), `its example record uses the real field ${example}`);
  }
  // The example JSON in the kit must actually construct.
  const json = kit.slice(kit.indexOf('```json') + 7, kit.indexOf('```', kit.indexOf('```json') + 7));
  const parsed = JSON.parse(json);
  const built = interview(parsed);
  eq(built.organization, 'Acme Electric', 'and the example parses and constructs a real interview');
  eq(built.pain.said, 'STATED', 'with its attributions intact');
  check(!/aggregate\(\)|provenance\.mjs|ledger\.mjs/.test(kit),
    'and it names no internal module the founder would have to understand');

  const outreach = readFileSync(R('programs/discovery/OUTREACH.md'), 'utf8');
  check(/DECLINED/.test(outreach) && /NO_REPLY/.test(outreach),
    'the outreach queue keeps the people who said no');
  check(/response rate was 100/.test(outreach), 'and says why');
  // A sales process is a set of FIELDS, not a word. The page says the word
  // "pipeline" in explaining that it is not one, which the first version of
  // this test flagged.
  const header = outreach.slice(outreach.indexOf('| # |'), outreach.indexOf('\n', outreach.indexOf('| # |')));
  for (const salesField of ['Stage', 'Probability', 'Value', 'Close', 'Owner', 'Forecast']) {
    check(!header.includes(salesField), `the queue has no ${salesField} column`);
  }
  check(/Status/.test(header) && /Next action/.test(header),
    'only who, why, where it stands and what is next');
  const rows = [...outreach.matchAll(/^\| \d+ \|/gm)].length;
  eq(rows, 10, 'with ten empty rows and no invented contacts');
}

// ---------------------------------------------------------------------------
console.log('--- nothing real was invented by this suite ------------------------');
{
  const dir = R('programs/discovery/interviews');
  const records = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => /\.(json|mjs)$/.test(f));
  eq(records, [], 'the committed interview directory holds no interviews');
  eq(summarize([]).externalInterviews, 0, 'so no external interview has happened');
  eq(marketStage({}).stage, 'UNVALIDATED', 'and AWE is UNVALIDATED in the market');

  const suite = readFileSync(R('scripts/eval-market-discovery.mjs'), 'utf8');
  const writes = ['write', 'FileSync'].join('');
  check(!suite.includes(`${writes}(`), 'and this suite writes no interview of its own');
  notes.push('no interview has been recorded; the market claim is UNVALIDATED and says so');
}

console.log('');
for (const nte of notes) console.log(`  note: ${nte}`);
console.log('');
console.log(`market discovery: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
