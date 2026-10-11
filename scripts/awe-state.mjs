// ---------------------------------------------------------------------------
// awe-state.mjs — the engineering state a later agent reads instead of logs.
//
//   npm run engineering-state                 # reads .awe/verify.json
//   node scripts/awe-state.mjs --verify path/to/verify.json --out .awe
//
// Writes <out>/engineering-state.json: which commit was examined, what passed,
// failed and was blocked, which blockers are open and what can be observed
// about them, and whether autonomous engineering may proceed, and why.
// Derivation rules: autonomy/lib/state.mjs.
//
// A missing or unreadable verify.json is reported as NOT_SAFE, never as an
// error that leaves no state behind: "we do not know" is a state.
//
// Exit 0 whenever a state file was written; the verdict is IN the file. CI
// decides pass/fail from awe-verify, so this command cannot turn red into green
// or the reverse.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveEngineeringState } from '../autonomy/lib/state.mjs';
import { runDetectors } from '../autonomy/lib/detectors.mjs';
import { git } from '../autonomy/lib/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d = null) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);

const outDir = resolve(arg('out', join(ROOT, '.awe')));
const verifyPath = resolve(arg('verify', join(outDir, 'verify.json')));
const blockers = JSON.parse(readFileSync(join(ROOT, 'autonomy/blockers.json'), 'utf8')).blockers;
const policy = JSON.parse(readFileSync(join(ROOT, 'autonomy/policy.json'), 'utf8'));

let verify = null;
let verifyError = null;
if (!existsSync(verifyPath)) verifyError = `${relative(ROOT, verifyPath)} does not exist; run npm run verify first`;
else {
  try { verify = JSON.parse(readFileSync(verifyPath, 'utf8')); }
  catch (e) { verifyError = `${relative(ROOT, verifyPath)} is unreadable: ${e.message}`; }
}

const state = deriveEngineeringState({
  verify, verifyError, blockers, policy,
  detections: runDetectors(ROOT, blockers),
  head: git(ROOT, ['rev-parse', 'HEAD']),
  now: new Date().toISOString(),
});

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'engineering-state.json'), JSON.stringify(state, null, 2) + '\n');

const a = state.autonomy;
console.log(`AWE ENGINEERING STATE — ${state.commit?.slice(0, 12) ?? 'unknown commit'} (${state.branch ?? 'unknown branch'})`);
if (state.verification) {
  const s = state.verification.summary;
  console.log(`verification ${state.verification.verdict}: pass ${s.pass}, fail ${s.fail}, blocked ${s.blocked}, skipped ${s.skipped}`);
}
console.log(`\nAUTONOMY: ${a.verdict}`);
for (const r of a.reasons) console.log(`  · [${r.level}] ${r.reason}`);
console.log('\nBLOCKERS (observe and escalate only)');
for (const b of state.blockers) {
  const o = b.observed;
  const seen = !o.observable ? `unobservable here: ${o.reason}`
    : o.still_present ? 'still present' : 'detector suggests resolved; human must confirm';
  console.log(`  ${b.id.padEnd(15)} ${b.status} — ${seen}`);
}
if (state.known_debt.length) {
  console.log('\nKNOWN DEBT (non-blocking failures)');
  for (const d of state.known_debt) console.log(`  ${d.id} — ${d.reason}`);
}
console.log(`\nwrote ${relative(process.cwd(), join(outDir, 'engineering-state.json')) || join(outDir, 'engineering-state.json')}`);
