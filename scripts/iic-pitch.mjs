// ---------------------------------------------------------------------------
// iic-pitch.mjs — what could we honestly say on stage today, and what is
// missing that would most change that?
//
//   node scripts/iic-pitch.mjs
//   node scripts/iic-pitch.mjs --db /data/pcc.sqlite --org lippolis
//   node scripts/iic-pitch.mjs --beats          the full beat-by-beat detail
//   node scripts/iic-pitch.mjs --artifacts      the four deliverables
//   node scripts/iic-pitch.mjs --json
//
// SAME FACTS AS EVERYTHING ELSE. programs/iic-2027/derive.mjs, exactly as the
// scorecard and the planner read them. This command adds no evidence and stores
// no numbers; every figure it prints was read from proof/, deployment/,
// capability/ or programs/discovery/ a few milliseconds earlier.
//
// AND IT DOES NOT PLAN. It finds the presentation's weakest point and names the
// CLAIM that owns it; the action comes from `npm run plan`, which knows which
// gate the company is at. Two commands proposing actions would eventually
// propose different ones.
//
// READ ONLY.
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { deriveFacts } = await import(join(ROOT, 'programs/iic-2027/derive.mjs'));
const { mergeFacts, DECLARED } = await import(join(ROOT, 'programs/iic-2027/facts.mjs'));
const N = await import(join(ROOT, 'programs/iic-2027/narrative.mjs'));
const A = await import(join(ROOT, 'programs/iic-2027/artifacts.mjs'));
const { plan } = await import(join(ROOT, 'programs/venture/plan.mjs'));

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const flag = (k) => argv.includes(`--${k}`);

const warnings = [];
const derived = await deriveFacts({ db: arg('db'), org: arg('org'), warn: (m) => warnings.push(m) });
const facts = mergeFacts(derived, DECLARED);

const narrative = N.assessNarrative(facts);
const artifacts = A.assessArtifacts(narrative);
const demoTier = A.bestDemoTier(facts);
const venture = plan(facts);

if (flag('json')) {
  console.log(JSON.stringify({ facts, narrative, artifacts, demoTier: demoTier.id, warnings }, null, 2));
  process.exit(0);
}

for (const w of warnings) console.error(`NOTE: ${w}\n`);

const MARK = { STRONG: '████', INFERRED: '██··', PARTIAL: '█···', NOT_READY: '····' };
const line = (s) => console.log(s);
const rule = (t) => { line(''); line(t); line('-'.repeat(t.length)); };

line('AWE — IIC PRESENTATION READINESS');
line('========================================================================');
line('');
line('WHAT AWE IS');
line(`  ${wrap(N.ONE_SENTENCE.spoken, 70, '  ')}`);
line('');
line(`  Judged on: ${N.JUDGING_CRITERIA.join(', ')}`);
line(`  (${N.CRITERIA_PROVENANCE.edition}, retrieved ${N.CRITERIA_PROVENANCE.retrieved}. ${N.CRITERIA_PROVENANCE.caveat})`);

rule('THE BEATS');
for (const b of narrative.beats) {
  line(`${MARK[b.status]} ${b.status.padEnd(9)} ${b.title}`);
  line(`               ${b.why}`);
}

rule('WEAKEST BEAT');
{
  const w = narrative.weakest;
  line(`  ${w.title} — ${w.status}`);
  line(`  the audience is asking: ${w.question}`);
  line(`  ${w.why}`);
  line('');
  line(`  ${wrap(w.killCondition, 70, '  ')}`);
}

rule('EVIDENCE THAT WOULD MOST IMPROVE THE PITCH');
line('  ranked by what the gap costs the beat, then by (criteria × beats) / cost');
line('');
for (const [i, g] of narrative.gaps.slice(0, 5).entries()) {
  line(`  ${i + 1}. ${g.label}`);
  line(`     today: ${g.status === 'NONE' ? 'nothing' : g.status} — ${g.because}`);
  line(`     leaves the ${g.beats.join(', ')} beat(s) at ${g.costsBeat}; serves ${g.judgeImportance} judging criteria`);
  line(`     owned by claim "${g.ownedByClaim}" (${g.cost.toLowerCase()} cost)` +
    (g.independentValue ? ' · worth doing even if the competition were cancelled' : ' · only valuable for the competition'));
  line('');
}

rule('CRITERIA COVERAGE');
for (const c of narrative.criteriaCoverage) {
  line(`  ${c.criterion.padEnd(24)} strongest beat: ${c.strongestBeat.padEnd(10)} (${c.beats.length} beat(s) serve it)`);
}

rule('THE FOUR DELIVERABLES');
for (const a of artifacts) {
  line(`  ${a.name}`);
  line(`    as strong as its weakest beat: ${a.status} (${a.weakestBeat})`);
  line(`    ${a.producible ? 'PRODUCIBLE now' : `NOT YET — blocked by: ${a.blockedBy.join(', ')}`}`);
  if (!a.producible) line(`    if the date arrives anyway: ${wrap(a.fallback, 66, '      ')}`);
  line('');
}

rule('BEST DEMONSTRATION AVAILABLE TODAY');
line(`  ${demoTier.tier} — ${demoTier.what}`);
line(`  loses: ${demoTier.loses}`);

if (flag('beats')) {
  rule('BEAT DETAIL');
  for (const b of narrative.beats) {
    line('');
    line(`${b.title.toUpperCase()}  [${b.status}]`);
    line(`  question   ${b.question}`);
    line(`  takeaway   ${b.takeaway}`);
    line(`  criteria   ${b.criteria.join(', ') || '—'}`);
    line(`  claims     ${b.claims.join(', ') || '—'}`);
    for (const s of b.slots) {
      line(`  ${s.required ? '[required]' : '[optional]'} ${s.id}: ${s.source} — ${s.value}`);
      if (s.provenance) line(`               ${s.provenance}`);
    }
    line(`  kill when  ${wrap(b.killCondition, 66, '             ')}`);
  }
}

if (flag('artifacts')) {
  rule('ARTIFACT DETAIL');
  for (const a of A.ARTIFACTS) {
    line('');
    line(a.name.toUpperCase());
    line(`  purpose  ${wrap(a.purpose, 68, '           ')}`);
    line(`  budget   ${wrap(a.budget, 68, '           ')}`);
    line(`  carries  ${a.carries.join(' → ')}`);
    for (const d of a.drops) line(`  drops    ${d.beat}: ${d.why}`);
    for (const s of a.structure) {
      line(`    ${(s.at ?? s.section ?? '').padEnd(12)} ${s.segment ?? ''}${s.beat ? ` (${s.beat})` : ''}`);
      if (s.mustShow) line(`                 show:     ${wrap(s.mustShow, 52, '                           ')}`);
      if (s.mustNotShow) line(`                 not:      ${wrap(s.mustNotShow, 52, '                           ')}`);
      if (s.evidence) line(`                 evidence: ${s.evidence.join(', ')}`);
    }
  }
}

rule('WHAT TO DO ABOUT IT');
line('  This command does not plan, and does not outrank the planner. It ranks');
line('  EVIDENCE by what it is worth to the presentation; the planner ranks WORK');
line('  by what it is worth to the company, in gate order. The planner wins.');
line('');
line(`  gate ${venture.currentGate?.n ?? '—'}: ${venture.currentGate?.name ?? 'all gates passed'}`);
line('');
line(`    engineering: ${wrap(venture.highestLeverage?.action ?? '—', 62, '                 ')}`);
line('');
line(`    founder:     ${wrap(venture.founderHighestLeverage?.action ?? '—', 62, '                 ')}`);
line('');
line('  node scripts/awe-plan.mjs');

line('');
line('========================================================================');
line('No probability of winning is computed. Beats, evidence and what is missing.');

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { out.push(cur.trim()); cur = w; }
    else cur += ' ' + w;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.join('\n' + indent);
}
