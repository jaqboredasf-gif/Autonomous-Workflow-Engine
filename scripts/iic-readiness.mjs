// ---------------------------------------------------------------------------
// iic-readiness.mjs — where does AWE actually stand?
//
// Assembles the facts the readiness scorecard scores. Everything it can derive
// from the repository or a live database, it derives; the short remainder comes
// from programs/iic-2027/facts.mjs, where each entry must name a witness.
//
//   node scripts/iic-readiness.mjs
//   node scripts/iic-readiness.mjs --db /data/pcc.sqlite --org lippolis
//   node scripts/iic-readiness.mjs --milestones
//   node scripts/iic-readiness.mjs --json
//
// THE DERIVATION LIVES IN programs/iic-2027/derive.mjs, not here, because
// scripts/awe-plan.mjs needs the same facts. Two copies of "how many external
// interviews are there" is two answers to that question, arriving on the day
// the two commands disagree in front of somebody.
//
// SEE ALSO scripts/awe-plan.mjs, which answers the different and more useful
// question: given these facts, what is the single next thing to do. This
// command scores; that one decides.
//
// NOTHING HERE ASSERTS A SCORE. Every band comes from a fact, and a fact that
// does not exist scores zero with the absence named.
//
// READ ONLY.
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { assess, render } = await import(join(ROOT, 'programs/iic-2027/readiness.mjs'));
const { DECLARED, mergeFacts } = await import(join(ROOT, 'programs/iic-2027/facts.mjs'));
const { status: milestoneStatus } = await import(join(ROOT, 'programs/iic-2027/milestones.mjs'));
const { deriveFacts } = await import(join(ROOT, 'programs/iic-2027/derive.mjs'));

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const flag = (k) => argv.includes(`--${k}`);

const warnings = [];
const derived = await deriveFacts({ db: arg('db'), org: arg('org'), warn: (m) => warnings.push(m) });
const facts = mergeFacts(derived, DECLARED);
const assessment = assess(facts);

if (flag('json')) {
  console.log(JSON.stringify({ facts, assessment, milestones: milestoneStatus(facts), warnings }, null, 2));
} else {
  for (const w of warnings) console.error(`NOTE: ${w}\n`);
  console.log(render(assessment, { title: 'AWE readiness — derived from the repository' }));
  console.log('');
  console.log('--- where the facts came from --------------------------------------');
  for (const [group, values] of Object.entries(derived)) {
    console.log(`  ${group}: ${JSON.stringify(values).slice(0, 300)}`);
  }
  if (Object.keys(DECLARED).length === 0) {
    console.log('  declared: nothing. Every band above rests on something the code could check.');
  }
  console.log('');
  console.log('For what to DO about it: node scripts/awe-plan.mjs');
  if (flag('milestones')) {
    const st = milestoneStatus(facts);
    console.log('');
    console.log('--- dated targets (computed, not ticked) ---------------------------');
    for (const m of st.months) {
      console.log(`  ${m.at}: ${m.met}/${m.total} met`);
      for (const id of m.outstanding) {
        const row = st.rows.find((r) => r.id === id);
        console.log(`      ☐ ${row.target}`);
        console.log(`        evidence: ${row.evidence}`);
      }
    }
  }
}
