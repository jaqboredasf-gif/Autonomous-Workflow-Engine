// ---------------------------------------------------------------------------
// baseline-observations.mjs — is the baseline evidence good enough yet, and
// what is the next hour of work?
//
//   node scripts/baseline-observations.mjs
//   node scripts/baseline-observations.mjs --json
//
// Reads proof/baselines/observations/<org>-<capability>.json, validates every
// observation in it, and prints what each step is graded and what would raise
// it. It changes nothing.
//
// THE QUESTION IT ANSWERS is the one the founder actually has standing in an
// office with a stopwatch: have I done enough of this step yet, or should I
// stay another twenty minutes. Answering that badly costs a second visit.
//
// READ ONLY.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { validate, outstanding, MEASURED_FLOOR, METHODS } = await import(join(ROOT, 'proof/baselines/ingest.mjs'));
const { lippolisPurchasingBaseline } = await import(join(ROOT, 'proof/baselines/lippolis-purchasing.mjs'));
const { baselineHandlingMinutes, baselineGrade } = await import(join(ROOT, 'proof/baseline.mjs'));
const { present } = await import(join(ROOT, 'proof/provenance.mjs'));

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const asJson = argv.includes('--json');

const file = arg('file', join(ROOT, 'proof/baselines/observations/lippolis-purchasing.json'));
if (!existsSync(file)) {
  console.error(`no observation file at ${file}`);
  process.exit(1);
}
const doc = JSON.parse(readFileSync(file, 'utf8'));
const expectSteps = lippolisPurchasingBaseline.steps.map((s) => s.id);

const problems = validate(doc, { expectSteps: expectSteps.filter((id) => id in (doc.steps ?? {})) });
const hard = problems.filter((p) => !/not present/.test(p));
const todo = outstanding(doc, { expectSteps });

if (asJson) {
  console.log(JSON.stringify({ file, problems, outstanding: todo }, null, 2));
  process.exit(hard.length ? 1 : 0);
}

console.log('BASELINE OBSERVATIONS');
console.log('='.repeat(72));
console.log(`  ${file.replace(ROOT + '/', '')}`);
console.log('');

if (hard.length) {
  console.log('PROBLEMS — these must be fixed before the file means anything');
  for (const p of hard) console.log(`  · ${p}`);
  console.log('');
}

console.log('WHAT EACH STEP IS WORTH TODAY');
for (const s of lippolisPurchasingBaseline.steps) {
  const n = doc.steps?.[s.id]?.observations?.length ?? 0;
  const share = doc.steps?.[s.id]?.appliesToShare ?? 1;
  const grade = s.minutes.provenance;
  const value = s.minutes.known ? `${present(s.minutes)} min` : '—';
  console.log(`  ${grade.padEnd(14)} ${value.padStart(9)}  ${s.id}${share !== 1 ? `  (on ${Math.round(share * 100)}% of units)` : ''}`);
  console.log(`  ${' '.repeat(14)} ${' '.repeat(9)}  ${n} observation(s). ${s.label}`);
}

const handling = baselineHandlingMinutes(lippolisPurchasingBaseline);
console.log('');
console.log(`BASELINE TOTAL       ${handling.known ? `${present(handling)} minutes per purchase request  [${baselineGrade(lippolisPurchasingBaseline)}]` : 'NOT MEASURABLE'}`);
if (!handling.known) {
  console.log('                     Any step UNAVAILABLE makes the whole baseline unavailable, which');
  console.log('                     makes every value figure downstream read NOT MEASURABLE. That is');
  console.log('                     correct: a total missing one of its parts is not a smaller total.');
}
console.log(`REVIEWED BY          ${doc.reviewedBy ?? 'nobody — an unreviewed baseline is one person\'s afternoon'}`);
const rate = doc.labourRate?.centsPerHour;
console.log(`LOADED LABOUR RATE   ${rate ? `$${(rate / 100).toFixed(2)}/hour [${METHODS[doc.labourRate.method]?.grade}]` : 'not supplied — every money figure waits on it'}`);

console.log('');
console.log('THE NEXT HOUR');
if (!todo.length) {
  console.log('  Nothing outstanding. Have somebody other than the observer review it, and record');
  console.log('  reviewedBy / reviewedAt in the file.');
} else {
  for (const t of todo) {
    console.log(`  · ${t.step.padEnd(22)} ${t.have}/${t.need}  ${t.because}`);
  }
}
console.log('');
console.log(`  ${MEASURED_FLOOR} timed observations make a step MEASURED. Fewer is capped below it, however`);
console.log('  carefully it was timed, and one estimate among four timings makes the whole step');
console.log('  SELF_REPORTED — the weakest input sets the grade.');
console.log('');
console.log('  The full method: docs/proof/LIPPOLIS_BASELINE_FIELD_PROTOCOL.md');
console.log('  The sequence:    docs/proof/FIRST_REAL_PROOF_ACTIVATION.md');

process.exit(hard.length ? 1 : 0);
