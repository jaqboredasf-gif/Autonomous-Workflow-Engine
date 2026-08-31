// ---------------------------------------------------------------------------
// baseline-import.mjs — turn two field sheets into the observation file.
//
// WHAT THIS EXISTS TO PREVENT. The founder collects evidence standing in an
// office with a stopwatch, and the thing the proof layer needs is a JSON
// document with method enums, ISO dates and provenance references. Asking one
// person to produce the second while doing the first guarantees either bad
// evidence or no evidence — and retyping thirty-five stopwatch readings into
// JSON at 11pm is where a transcription error becomes a baseline.
//
// So the field format is a CSV with six columns, four of which are obvious, and
// this is the deterministic conversion:
//
//   proof/baselines/observations/field/handling.csv  -> steps[].observations[]
//   proof/baselines/observations/field/cycle.csv     -> cycle.observations[]
//
//   node scripts/baseline-import.mjs
//   node scripts/baseline-import.mjs --dry-run
//
// IT REFUSES RATHER THAN GUESSES. A step name that is not one of the seven, a
// duration that is not a number, a date that is not a date, a row with nothing
// to go and look at: each is reported with its line number and nothing is
// written. A half-imported baseline is worse than none, because it looks
// finished.
//
// IT NEVER OVERWRITES WHAT IT DID NOT PRODUCE. The observation file may carry a
// labour rate somebody typed in, a reviewer, an appliesToShare worked out on
// paper. Those are preserved; only the observation arrays are replaced.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OBS_DIR = join(ROOT, 'proof/baselines/observations');
const TARGET = join(OBS_DIR, 'lippolis-purchasing.json');
const HANDLING = join(OBS_DIR, 'field/handling.csv');
const CYCLE = join(OBS_DIR, 'field/cycle.csv');

const { METHODS } = await import(join(ROOT, 'proof/baselines/ingest.mjs'));
const { lippolisPurchasingBaseline } = await import(join(ROOT, 'proof/baselines/lippolis-purchasing.mjs'));

const STEPS = lippolisPurchasingBaseline.steps.map((s) => s.id);

/** The words a person would write, mapped to the words the model uses. */
const METHOD_WORDS = Object.freeze({
  '': 'DIRECT_OBSERVATION',
  observed: 'DIRECT_OBSERVATION',
  watched: 'DIRECT_OBSERVATION',
  timed: 'DIRECT_OBSERVATION',
  from_paper: 'HISTORICAL_RECORD',
  paper: 'HISTORICAL_RECORD',
  records: 'HISTORICAL_RECORD',
  told_me: 'EMPLOYEE_ESTIMATE',
  told: 'EMPLOYEE_ESTIMATE',
  estimate: 'EMPLOYEE_ESTIMATE',
});

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const problems = [];

/** A CSV reader small enough to read: no quoting, because no field needs it. */
function rows(path, expected) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n')
    .map((l, i) => ({ n: i + 1, text: l.trim() }))
    .filter((l) => l.text && !l.text.startsWith('#'));
  if (!lines.length) return [];

  const header = lines[0].text.split(',').map((h) => h.trim());
  for (const want of expected) {
    if (!header.includes(want)) {
      problems.push(`${short(path)}: the header has no "${want}" column. Expected: ${expected.join(', ')}`);
      return [];
    }
  }
  return lines.slice(1).map((l) => {
    const cells = l.text.split(',').map((c) => c.trim());
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
    if (cells.some((c) => c.includes('"'))) {
      problems.push(`${short(path)} line ${l.n}: quotes are not supported — remove them, or use a semicolon in the note`);
    }
    return { ...row, _line: l.n, _file: short(path) };
  });
}

const short = (p) => p.replace(`${ROOT}/`, '');
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// --- handling -------------------------------------------------------------
const handling = {};
for (const id of STEPS) handling[id] = [];

for (const r of rows(HANDLING, ['step', 'seconds', 'who', 'ref'])) {
  const where = `${r._file} line ${r._line}`;
  if (!STEPS.includes(r.step)) {
    problems.push(`${where}: "${r.step}" is not one of the seven steps. One of: ${STEPS.join(', ')}`);
    continue;
  }
  const seconds = Number(r.seconds);
  if (!Number.isFinite(seconds) || seconds < 0) {
    problems.push(`${where}: seconds is ${JSON.stringify(r.seconds)}. Write what the stopwatch said, in seconds.`);
    continue;
  }
  if (seconds > 7200) {
    problems.push(`${where}: ${seconds} seconds is over two hours for one step. If that is right, say so in the note and split the row; more likely it is minutes written as seconds.`);
    continue;
  }
  if (!r.who) { problems.push(`${where}: no "who" — an unattributed timing cannot be questioned`); continue; }
  if (!r.ref) { problems.push(`${where}: no "ref" — write what this was about, so it can be found again`); continue; }
  const method = METHOD_WORDS[(r.method ?? '').toLowerCase()];
  if (!method) {
    problems.push(`${where}: method "${r.method}" is not one of: ${Object.keys(METHOD_WORDS).filter(Boolean).join(', ')} (blank means observed)`);
    continue;
  }
  const at = r.date && ISO.test(r.date) ? r.date : (r.date ? null : todayFromFile());
  if (at === null) {
    problems.push(`${where}: date "${r.date}" is not YYYY-MM-DD`);
    continue;
  }
  // `covers` is how many orders one timing accounted for. Blank means one.
  // Filing a week's packing slips in one sitting is one row with covers=12.
  const covers = r.covers ? Number(r.covers) : 1;
  if (!Number.isInteger(covers) || covers < 1) {
    problems.push(`${where}: covers is ${JSON.stringify(r.covers)}. Leave it blank, or write how many orders that one timing covered.`);
    continue;
  }
  handling[r.step].push({
    seconds, covers, method, observedBy: r.who, at, ref: r.ref, subject: r.who,
    ...(r.note ? { note: r.note } : {}),
  });
}

// --- cycle ----------------------------------------------------------------
const cycle = [];
for (const r of rows(CYCLE, ['po', 'raised', 'received'])) {
  const where = `${r._file} line ${r._line}`;
  if (!r.po) { problems.push(`${where}: no purchase order number`); continue; }
  for (const [field, value] of [['raised', r.raised], ['received', r.received]]) {
    if (!ISO.test(value ?? '')) problems.push(`${where}: ${field} "${value}" is not YYYY-MM-DD`);
  }
  if (!ISO.test(r.raised ?? '') || !ISO.test(r.received ?? '')) continue;
  const days = (Date.parse(r.received) - Date.parse(r.raised)) / 86_400_000;
  if (!(days >= 0)) {
    problems.push(`${where}: received (${r.received}) is before raised (${r.raised}). Check the packing slip.`);
    continue;
  }
  if (days > 365) {
    problems.push(`${where}: ${days} days between raised and received. Almost certainly a typo in one of the years.`);
    continue;
  }
  cycle.push({
    ref: r.po, raisedAt: r.raised, receivedAt: r.received,
    method: 'HISTORICAL_RECORD',
    ...(r.vendor ? { vendor: r.vendor } : {}),
  });
}

/**
 * The date to stamp on a row that did not supply one.
 *
 * NOT `new Date()`. A row imported a week after it was written would be stamped
 * with the import date, which is a false provenance claim about when somebody
 * stood in the office. If the sheet does not say, the file must.
 */
function todayFromFile() {
  const existing = existsSync(TARGET) ? JSON.parse(readFileSync(TARGET, 'utf8')) : {};
  return existing.observedOn ?? null;
}

// --- write ----------------------------------------------------------------
if (problems.length) {
  console.error('baseline-import: nothing was written.');
  console.error('');
  for (const p of problems) console.error(`  · ${p}`);
  console.error('');
  console.error('A half-imported baseline is worse than none, because it looks finished.');
  console.error('Fix the rows above and run this again.');
  process.exit(1);
}

const existing = existsSync(TARGET) ? JSON.parse(readFileSync(TARGET, 'utf8')) : {};
const next = {
  ...existing,
  steps: Object.fromEntries(STEPS.map((id) => [id, {
    // PRESERVED, not regenerated: appliesToShare is worked out on paper from a
    // tally, and the sheets have no column for it.
    ...(existing.steps?.[id] ?? { appliesToShare: 1 }),
    observations: handling[id],
  }])),
  cycle: { ...(existing.cycle ?? {}), observations: cycle },
};

const counts = STEPS.map((id) => `${id}: ${handling[id].length}`).join(', ');
if (dryRun) {
  console.log('baseline-import: --dry-run, nothing written.');
} else {
  writeFileSync(TARGET, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`baseline-import: wrote ${short(TARGET)}`);
}
console.log('');
console.log(`  handling observations   ${Object.values(handling).reduce((t, a) => t + a.length, 0)}`);
console.log(`    ${counts}`);
console.log(`  paper POs for cycle     ${cycle.length}`);
console.log('');
console.log('  Preserved from the existing file: labour rate, reviewer, appliesToShare.');
console.log('');
console.log('Next:  npm run baseline        # what it is worth, and what is still missing');
