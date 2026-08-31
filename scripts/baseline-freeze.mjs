// ---------------------------------------------------------------------------
// baseline-freeze.mjs — make this baseline the one that governs Case Study #001.
//
//   node scripts/baseline-freeze.mjs --by "Jack Daly" --at 2026-09-10 --opens 2026-09-15
//   node scripts/baseline-freeze.mjs --by "Jack Daly" --at ... --opens ... \
//     --supersedes 1 --reason "po_preparation row 4 was 320s, transcribed as 32s"
//
// WHAT FREEZING IS FOR. After this, the observation file may go on changing and
// the case study will still be computed against the evidence as it stood here.
// Any later divergence is REPORTED, not forbidden: a baseline must be
// correctable, and a correction must be a visible, reasoned, versioned act
// rather than an edit nobody can see.
//
// IT REFUSES TO FREEZE SOMETHING THAT IS NOT READY. The readiness rules live in
// scripts/baseline-ready.mjs and are the same ones that answer "is the baseline
// defensible" — there is no second opinion here about what good enough means.
//
// --by IS A PERSON. Not a script, not "AWE". Somebody is vouching that these
// observations describe what they watched.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OBS = join(ROOT, 'proof/baselines/observations/lippolis-purchasing.json');
const FROZEN_DIR = join(ROOT, 'proof/baselines/frozen');

const { freeze } = await import(join(ROOT, 'proof/baselines/governance.mjs'));
const { lippolisPurchasingBaseline } = await import(join(ROOT, 'proof/baselines/lippolis-purchasing.mjs'));
const { baselineHandlingMinutes } = await import(join(ROOT, 'proof/baseline.mjs'));
const { readiness } = await import(join(ROOT, 'scripts/lib/baseline-readiness.mjs'));

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);

const by = arg('by');
const at = arg('at');
const opens = arg('opens');
const supersedes = arg('supersedes');
const reason = arg('reason');

if (!by || !at || !opens) {
  console.error('usage: node scripts/baseline-freeze.mjs --by "<person>" --at YYYY-MM-DD --opens YYYY-MM-DD');
  console.error('');
  console.error('  --by      the person vouching that these observations describe what they watched');
  console.error('  --at      when the baseline was established');
  console.error('  --opens   when the production observation window opens. Purchases before this');
  console.error('            are not eligible for Case Study #001, and it cannot be before --at.');
  process.exit(2);
}

const doc = JSON.parse(readFileSync(OBS, 'utf8'));
const state = readiness(doc, lippolisPurchasingBaseline);

if (!state.defensible) {
  console.error('baseline-freeze: this baseline is NOT READY, and nothing was written.');
  console.error('');
  for (const r of state.blocking) console.error(`  · ${r}`);
  console.error('');
  console.error('Run: npm run baseline    for what is still missing.');
  process.exit(1);
}

const existing = existsSync(FROZEN_DIR)
  ? readdirSync(FROZEN_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FROZEN_DIR, f), 'utf8')))
  : [];
const version = existing.length ? Math.max(...existing.map((r) => r.version)) + 1 : 1;

if (version > 1 && !supersedes) {
  console.error(`baseline-freeze: version ${version - 1} already exists.`);
  console.error('An amendment must say what it supersedes and why:');
  console.error(`  --supersedes ${version - 1} --reason "<what was wrong, and how it was found>"`);
  process.exit(1);
}

let record;
try {
  record = freeze({
    doc,
    baseline: lippolisPurchasingBaseline,
    handlingMinutes: baselineHandlingMinutes(lippolisPurchasingBaseline),
    establishedBy: by, at, opensAt: opens,
    version, supersedes, reason,
  });
} catch (e) {
  console.error(`baseline-freeze: ${e.message}`);
  process.exit(1);
}

const path = join(FROZEN_DIR, `lippolis-purchasing.v${version}.json`);
if (existsSync(path)) {
  console.error(`baseline-freeze: ${path} already exists. A frozen version is never overwritten.`);
  process.exit(1);
}
writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);

console.log(`baseline-freeze: wrote ${path.replace(`${ROOT}/`, '')}`);
console.log('');
console.log(`  baseline v${record.version}${record.supersedes ? ` (supersedes v${record.supersedes})` : ''}`);
console.log(`  handling             ${record.handlingMinutes.toFixed(1)} minutes per purchase request  [${record.handlingGrade}]`);
console.log(`  established by       ${record.establishedBy} on ${record.establishedAt}`);
console.log(`  evidence digest      ${record.evidenceDigest.slice(0, 16)}…`);
if (record.reason) console.log(`  reason               ${record.reason}`);
console.log('');
console.log(`  OBSERVATION WINDOW OPENS ${record.observationWindow.opensAt}`);
console.log('  Purchases raised before that date are not eligible for Case Study #001.');
console.log('  Purchases raised after it cannot quietly leave: the population is counted at the source.');
console.log('');
console.log('  Commit this file. It is what a skeptical reader checks the figures against.');
