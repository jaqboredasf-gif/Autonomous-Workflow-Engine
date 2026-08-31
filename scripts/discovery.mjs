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

const { interview } = await import(R('programs/discovery/interview.mjs'));
const { analyse, marketClaim, PAIN_CATALOGUE } = await import(R('programs/discovery/patterns.mjs'));
const { marketStage, candidates } = await import(R('programs/discovery/market-gate.mjs'));
const { externalReadiness } = await import(R('programs/discovery/external-readiness.mjs'));

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

// --- load ------------------------------------------------------------------
const dir = R('programs/discovery/interviews');
const interviews = [];
const problems = [];
for (const f of (existsSync(dir) ? readdirSync(dir) : []).filter((f) => /\.(json|mjs)$/.test(f)).sort()) {
  const full = join(dir, f);
  try {
    if (f.endsWith('.json')) {
      const raw = JSON.parse(readFileSync(full, 'utf8'));
      for (const r of Array.isArray(raw) ? raw : [raw]) interviews.push(interview(r));
    } else {
      const mod = await import(full);
      for (const v of Object.values(mod)) {
        if (v && typeof v === 'object' && v.patternTags) interviews.push(v);
        if (Array.isArray(v)) for (const x of v) if (x?.patternTags) interviews.push(x);
      }
    }
  } catch (e) { problems.push(`${f}: ${e.message}`); }
}

const analysis = analyse(interviews);
const claim = marketClaim(analysis);
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
  console.log(JSON.stringify({ problems, analysis, claim, stage, shortlist }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

const rule = '='.repeat(72);
console.log('AWE — CUSTOMER DISCOVERY');
console.log(rule);
console.log('');

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

console.log('');
console.log(rule);
console.log('  On the day:      docs/discovery/FIRST_FIVE_INTERVIEWS.md');
console.log('  Who to contact:  programs/discovery/OUTREACH.md');
console.log('  Second deployment gap:  npm run discovery -- --external-readiness');
