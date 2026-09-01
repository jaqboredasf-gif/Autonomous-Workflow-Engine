// ---------------------------------------------------------------------------
// discovery.mjs — what have the conversations actually shown?
//
//   npm run discovery
//   npm run discovery -- --json
//   npm run discovery -- --external-readiness
//
// Run it after every interview. It reads programs/discovery/interviews/,
// reports what is in the sample, which pains more than one outside organization
// described independently, who might be a design partner, and what may honestly
// be said about the market — which today is very little.
//
// IT IS BUILT TO BE ABLE TO SAY THE HYPOTHESIS IS WRONG. A pain AWE addresses
// that nobody outside reported is printed as prominently as one that was, and a
// pain several businesses share that AWE cannot touch is printed first.
//
// READ ONLY.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => join(ROOT, p);

const { loadInterviews } = await import(R('programs/discovery/load.mjs'));
const { analyse, marketClaim, PAIN_CATALOGUE } = await import(R('programs/discovery/patterns.mjs'));
const { analyseAlternatives, alternativesClaim } = await import(R('programs/discovery/alternatives.mjs'));
const { analyseUnitOfSale } = await import(R('programs/discovery/unit-of-sale.mjs'));
const { marketStage, candidates } = await import(R('programs/discovery/market-gate.mjs'));
const { externalReadiness } = await import(R('programs/discovery/external-readiness.mjs'));

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

// --- load ------------------------------------------------------------------
// ONE READER, in programs/discovery/load.mjs. This file used to walk the
// directory itself and so did derive.mjs, and the two handled a malformed
// record differently — which is two answers to "how many interviews are there".
const { records: interviews, problems: refused, sheets } = await loadInterviews();
const problems = refused.map((p) => `${p.file}: ${p.reason}`);

const analysis = analyse(interviews);
const claim = marketClaim(analysis);
const alternatives = analyseAlternatives(interviews);
const altClaim = alternativesClaim(alternatives, { externalOrganizations: analysis.sample.externalOrganizations });
const unit = analyseUnitOfSale(interviews);
const stage = marketStage({
  externalInterviews: analysis.sample.externalInterviews,
  externalOrganizations: analysis.sample.externalOrganizations,
  corroboratedPains: analysis.corroboratedPains.length,
  painsStated: analysis.testimony.painsStated,
  designPartnerCandidates: interviews.filter((i) => !i.internal && i.designPartnerInterest).length,
});
const shortlist = candidates(interviews, analysis);

if (argv.includes('--external-readiness')) {
  const r = externalReadiness();
  if (asJson) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  console.log('WHAT A SECOND ORGANIZATION WOULD MEET');
  console.log('='.repeat(72));
  console.log(`  ${r.summary}`);
  for (const v of ['LIPPOLIS_SPECIFIC', 'UNKNOWN', 'CONFIGURABLE', 'READY_GENERICALLY']) {
    console.log('');
    console.log(`  ${v}`);
    for (const c of r.byVerdict[v]) console.log(`    · ${c.id.padEnd(34)} ${c.means.slice(0, 90)}`);
  }
  console.log('');
  console.log('  THE CONSTRAINT THAT DECIDES THE SHORTLIST');
  console.log(`  ${r.partnerConstraint}`);
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify({ problems, analysis, claim, stage, shortlist, alternatives, altClaim, unit }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

const rule = '='.repeat(72);
console.log('AWE — CUSTOMER DISCOVERY');
console.log(rule);
console.log('');

if (sheets.length) {
  console.log(`FIELD SHEETS WAITING — ${sheets.length} written and not yet imported: ${sheets.join(', ')}`);
  console.log('  npm run evidence -- --import programs/discovery/interviews/<file>');
  console.log('');
}

if (problems.length) {
  console.log('PROBLEMS — these records were not read');
  for (const p of problems) console.log(`  · ${p}`);
  console.log('');
}

// --- the research question, restated every time ---------------------------
console.log('THE QUESTION');
console.log('  Are the operational pains observed at Lippolis repeated across other');
console.log('  construction businesses? Not "do people like AWE".');
console.log('');

console.log(`MARKET VALIDATION STAGE   ${stage.stage}`);
console.log(`  ${stage.claim}`);
if (stage.next) {
  console.log('');
  console.log(`  NEXT STAGE  ${stage.next.stage}`);
  console.log(`    needs:  ${stage.next.needs}`);
  console.log(`    today:  ${stage.next.found}`);
}
for (const a of stage.anomalies) console.log(`  ANOMALY: ${a}`);
console.log('');

const s = analysis.sample;
console.log('THE SAMPLE');
console.log(`  ${s.externalInterviews} conversation(s) at ${s.externalOrganizations} outside organization(s)` +
  `${s.interviews !== s.externalInterviews ? `, plus ${s.interviews - s.externalInterviews} inside the deploying customer` : ''}`);
if (s.organizationTypes.length) console.log(`  types:  ${s.organizationTypes.join(', ')}`);
if (s.roles.length) console.log(`  roles:  ${s.roles.join(', ')}`);
console.log(`  how it was assembled: ${s.selection}`);
console.log('');

if (!analysis.patterns.length) {
  console.log('NOTHING HAS BEEN RECORDED YET.');
  console.log('  Take docs/discovery/FIRST_FIVE_INTERVIEWS.md and have the first conversation.');
  console.log('  One record per conversation in programs/discovery/interviews/.');
} else {
  console.log('WHAT MORE THAN ONE OUTSIDE ORGANIZATION DESCRIBED INDEPENDENTLY');
  if (!analysis.corroboratedPains.length) {
    console.log('  Nothing yet. Below two outside organizations a pain is one company\'s opinion.');
  }
  for (const p of analysis.corroboratedPains) {
    console.log(`  ${String(p.externalOrganizations).padStart(2)} orgs  ${p.tag}${p.addressable ? '' : '   ← AWE HAS NO CAPABILITY FOR THIS'}`);
    console.log(`          ${p.means ?? '(a pain not in the catalogue — this is a finding)'}`);
    console.log(`          roles: ${p.roles.join(', ')}   types: ${p.organizationTypes.join(', ') || 'not recorded'}`);
    for (const q of p.quotes.slice(0, 2)) console.log(`          "${q.quote}" — ${q.org}`);
  }

  if (analysis.corroboratedAbsences.length) {
    console.log('');
    console.log('WHAT MORE THAN ONE OUTSIDE ORGANIZATION SAID WAS *NOT* A PROBLEM');
    console.log('  A finding, and not evidence that a pain exists.');
    for (const p of analysis.corroboratedAbsences) console.log(`  · ${p.tag} — ${p.externalOrganizations} organizations`);
  }

  if (analysis.unaddressed.length) {
    console.log('');
    console.log('PAINS SEVERAL BUSINESSES SHARE THAT AWE CANNOT ADDRESS');
    console.log('  The most valuable thing discovery can find. Do not skip past it.');
    for (const p of analysis.unaddressed) console.log(`  · ${p.tag} — ${p.externalOrganizations} organizations`);
  }

  if (analysis.unknownTags.length) {
    console.log('');
    console.log('PAINS NOBODY PREDICTED');
    console.log(`  Not in the catalogue, which is how a new one gets found: ${analysis.unknownTags.join(', ')}`);
  }

  console.log('');
  console.log('PAINS AWE ADDRESSES THAT NOBODY OUTSIDE HAS CORROBORATED');
  console.log('  If this list stays long, the hypothesis is wrong and that is the finding.');
  console.log(`  ${analysis.awePainsNotCorroborated.join(', ') || 'none — every AWE pain has outside corroboration'}`);

  console.log('');
  console.log('HOW MUCH OF THIS IS THE CUSTOMERS TALKING');
  console.log(`  pains in their own words   ${analysis.testimony.painsStated}`);
  console.log(`  pains we inferred          ${analysis.testimony.painsInferred}`);
  console.log(`  consequences they stated   ${analysis.testimony.consequencesStated}`);
}

if (shortlist.length) {
  console.log('');
  console.log('DESIGN-PARTNER CANDIDATES');
  for (const c of shortlist) {
    console.log(`  ${c.viable ? 'VIABLE    ' : 'NOT YET   '} ${c.organization} (${c.organizationType ?? 'type not recorded'})  ${c.met}/6 met, ${c.unknown} unknown`);
    for (const b of c.blockedBy) console.log(`      blocked: ${b}`);
    for (const n of c.nextConversation.slice(0, 2)) console.log(`      ask next: ${n}`);
  }
}

console.log('');
console.log('WHAT MAY BE SAID');
console.log(`  ${claim.sentence}`);
console.log('');
console.log('  MAY NOT SAY:');
for (const m of claim.mayNotSay) console.log(`    · ${m}`);

// --- what they use instead -------------------------------------------------
// PHASE OF THE CONVERSATION, NOT A COMPETITIVE LANDSCAPE. Every row below came
// out of somebody describing their own Tuesday; nothing here is a claim about
// anybody else's product.
console.log('');
console.log('WHAT THEY USE INSTEAD');
if (!alternatives.rows.length) {
  console.log('  Nobody has described what they do today. Four questions, in the same conversation:');
  console.log('    what do you use · what works about it · what fails · why have you not fixed it');
} else {
  for (const a of alternatives.rows) {
    const flags = [a.adequate ? 'ADEQUATE — nothing fails' : null, a.analysed ? null : 'listed, not analysed',
      a.founderInferredOnly ? 'FOUNDER INFERRED — not counted' : null].filter(Boolean);
    console.log(`  ${String(a.externalOrganizations).padStart(2)} orgs  ${a.kind}${flags.length ? `   ← ${flags.join('; ')}` : ''}`);
    for (const f of a.whatFails.slice(0, 2)) console.log(`          fails:   "${f.text}" — ${f.organization}`);
    for (const w of a.whyNotFixed.slice(0, 2)) console.log(`          unfixed: "${w.text}" — ${w.organization}`);
    if (a.hardestSwitch !== 'NOT_ASKED') console.log(`          hardest switching cost reported: ${a.hardestSwitch}`);
  }
  console.log('');
  console.log(`  ${altClaim.say}`);
  if (altClaim.adequateWarning) console.log(`  AGAINST US: ${altClaim.adequateWarning}`);
  console.log(`  MAY NOT SAY: ${altClaim.mustNotSay}`);
}

// --- what a sale would be --------------------------------------------------
// NOT A PRICE. Who signs, who uses it, what they think they are buying.
console.log('');
console.log(`WHAT A SALE WOULD BE   ${unit.verdict.verdict}`);
console.log(`  ${unit.verdict.because}`);
if (unit.units.length) {
  console.log('  named as the thing they would buy:');
  for (const u of unit.units) console.log(`    ${String(u.organizations).padStart(2)} orgs  ${u.value}`);
}
if (unit.buyers.length) console.log(`  who would sign:  ${unit.buyers.map((b) => `${b.value} (${b.organizations})`).join(', ')}`);
if (unit.users.length) console.log(`  who would use it: ${unit.users.map((b) => `${b.value} (${b.organizations})`).join(', ')}`);
for (const c of unit.costOfProblem.slice(0, 3)) console.log(`  costs them today: "${c.text}" — ${c.organization}`);
if (unit.findings.splitBuyerUser.length) {
  console.log(`  THE BUYER IS NOT THE USER in ${unit.findings.splitBuyerUser.length} conversation(s): ${unit.findings.splitBuyerUser.join(', ')}`);
  console.log('    A product everybody likes and nobody signs for. Both people have to be convinced.');
}
if (unit.findings.wantsService.length) {
  console.log(`  THEY WANT THE WORK DONE, NOT SOFTWARE in ${unit.findings.wantsService.length}: ${unit.findings.wantsService.join(', ')}`);
  console.log('    A real answer and a different company. Do not record it as product demand.');
}
if (unit.findings.useNotPay.length) {
  console.log(`  WOULD USE IT, WOULD NOT PAY in ${unit.findings.useNotPay.length}: ${unit.findings.useNotPay.join(', ')}`);
  console.log('    Enthusiasm without a budget. It moves external_want and never will_pay.');
}

console.log('');
console.log(rule);
console.log('  Capture a conversation:  npm run evidence -- --new interview');
console.log('  On the day:      docs/discovery/FIRST_FIVE_INTERVIEWS.md');
console.log('  Who to contact:  programs/discovery/OUTREACH.md');
console.log('  Second deployment gap:  npm run discovery -- --external-readiness');
