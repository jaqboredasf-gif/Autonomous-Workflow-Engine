// ---------------------------------------------------------------------------
// awe-plan.mjs — what is the single action that most increases AWE's chance of
// arriving at the Iona Innovation Challenge with real evidence, while also
// making AWE a stronger company?
//
//   node scripts/awe-plan.mjs
//   node scripts/awe-plan.mjs --db /data/pcc.sqlite --org lippolis
//   node scripts/awe-plan.mjs --json
//
// Facts come from programs/iic-2027/derive.mjs — the same derivation the
// readiness scorecard uses — so the two commands cannot report different
// worlds. This command computes nothing of its own.
//
// A DATABASE IS ONLY COUNTED IF IT DECLARED ITSELF PRODUCTION. Pointing this at
// a rehearsal file reports zero production executions and says which
// environment it refused, which is the whole point of the stamp.
//
// READ ONLY.
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { deriveFacts } = await import(join(ROOT, 'programs/iic-2027/derive.mjs'));
const { mergeFacts, DECLARED } = await import(join(ROOT, 'programs/iic-2027/facts.mjs'));
const { plan, render } = await import(join(ROOT, 'programs/venture/plan.mjs'));

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const flag = (k) => argv.includes(`--${k}`);

const warnings = [];
const derived = await deriveFacts({ db: arg('db'), org: arg('org'), warn: (m) => warnings.push(m) });
const facts = mergeFacts(derived, DECLARED);
const result = plan(facts);

// The baseline gate (autonomy/lib/attestations.mjs) rides on top of the plan,
// not inside it: it is a human attestation, not a claim the planner ranks, and
// it must be impossible to read the plan without seeing it.
const { baseline } = await (await import(join(ROOT, 'autonomy/lib/human-evidence.mjs'))).loadHumanEvidence(ROOT);

if (flag('json')) {
  console.log(JSON.stringify({ facts, plan: result, warnings, baseline }, null, 2));
} else {
  const bar = '!'.repeat(72);
  if (baseline.banner) console.log(`${bar}\n  ${baseline.banner}\n  ${baseline.how_to_clear}\n${bar}\n`);
  for (const w of warnings) console.error(`NOTE: ${w}\n`);
  console.log(render(result));
}
