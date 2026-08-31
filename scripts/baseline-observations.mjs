// ---------------------------------------------------------------------------
// baseline-observations.mjs — where the Lippolis baseline stands, and what the
// next hour of work is.
//
//   npm run baseline
//   npm run baseline -- --json
//
// ONE COMMAND, TWO QUESTIONS, because the founder asks them at different times
// and should not have to remember two names:
//
//   BEFORE COLLECTING   is everything in place to go and measure?  (pre-flight)
//   AFTER COLLECTING    is the baseline defensible, and what is missing?
//
// It answers whichever applies, and it changes nothing.
//
// JACK CANNOT DECLARE SUCCESS. There is no flag and no override. The only way
// to make this say DEFENSIBLE is to have collected the evidence, and the rules
// live in scripts/lib/baseline-readiness.mjs where the freeze command reads the
// same ones.
//
// READ ONLY.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => join(ROOT, p);
const OBS = R('proof/baselines/observations/lippolis-purchasing.json');
const FIELD = R('proof/baselines/observations/field');
const FROZEN_DIR = R('proof/baselines/frozen');

const { validate, outstanding, MEASURED_FLOOR, CYCLE_FLOOR } = await import(R('proof/baselines/ingest.mjs'));
const { governing } = await import(R('proof/baselines/governance.mjs'));
const { readiness } = await import(R('scripts/lib/baseline-readiness.mjs'));
const { lippolisPurchasingBaseline } = await import(R('proof/baselines/lippolis-purchasing.mjs'));
const { present } = await import(R('proof/provenance.mjs'));

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

// --- pre-flight: can we collect at all? -----------------------------------
const preflight = [];
const must = (ok, what, fix) => preflight.push({ ok, what, fix });

must(existsSync(OBS), 'the observation file exists', 'it is committed; check the path');
must(existsSync(join(FIELD, 'handling.csv')), 'the handling field sheet exists',
  'proof/baselines/observations/field/handling.csv');
must(existsSync(join(FIELD, 'cycle.csv')), 'the paper-PO field sheet exists',
  'proof/baselines/observations/field/cycle.csv');

const doc = existsSync(OBS) ? JSON.parse(readFileSync(OBS, 'utf8')) : { steps: {} };
const STEPS = lippolisPurchasingBaseline.steps.map((s) => s.id);
const problems = validate(doc, { expectSteps: STEPS.filter((id) => id in (doc.steps ?? {})) })
  .filter((p) => !/not present/.test(p));

must(problems.length === 0, 'the observation file is valid', problems.join('; '));
must(doc.orgId === 'lippolis', 'the observation file names the organization it is about',
  `orgId is ${JSON.stringify(doc.orgId)}, expected "lippolis"`);
must(doc.baselineId === lippolisPurchasingBaseline.id,
  'and the baseline it belongs to',
  `baselineId is ${JSON.stringify(doc.baselineId)}, expected ${JSON.stringify(lippolisPurchasingBaseline.id)}`);
must(STEPS.every((id) => id in (doc.steps ?? {})),
  `all ${STEPS.length} steps of the process are declared`,
  `missing: ${STEPS.filter((id) => !(id in (doc.steps ?? {}))).join(', ')}`);

const frozen = existsSync(FROZEN_DIR)
  ? readdirSync(FROZEN_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FROZEN_DIR, f), 'utf8')))
  : [];
const gov = governing(frozen, doc);

// DRIFT IS NOT A PRE-FLIGHT BLOCKER, and the first version of this command put
// it in the list above — so an edited observation printed "BLOCKED — collection
// cannot start", when the truth is that collection already happened and the
// frozen figures no longer match the file. Two different situations wanting two
// different actions. It has its own headline below.
const canCollect = preflight.every((p) => p.ok);
const state = readiness(doc, lippolisPurchasingBaseline);
const todo = outstanding(doc, { expectSteps: STEPS });

if (asJson) {
  console.log(JSON.stringify({ preflight, canCollect, readiness: state, governance: gov, outstanding: todo }, null, 2));
  process.exit(state.defensible ? 0 : 1);
}

const rule = '='.repeat(72);
console.log('LIPPOLIS PURCHASING BASELINE');
console.log(rule);
console.log('');

// --- headline --------------------------------------------------------------
if (!canCollect) {
  console.log('BLOCKED — collection cannot start');
  for (const p of preflight.filter((x) => !x.ok)) {
    console.log(`  · ${p.what}`);
    console.log(`      ${p.fix}`);
  }
} else if (gov.drifted) {
  console.log('EVIDENCE HAS DRIFTED FROM THE FROZEN BASELINE');
  console.log(`  ${gov.because}`);
  console.log('');
  console.log('  Case Study #001 is still computed against the frozen figures, so nothing has');
  console.log('  silently changed. Either revert the edit, or freeze an amendment:');
  console.log(`    node scripts/baseline-freeze.mjs --by "<you>" --at <today> --opens ${gov.record.observationWindow.opensAt.slice(0, 10)} \\`);
  console.log(`      --supersedes ${gov.record.version} --reason "<what was wrong, and how it was found>"`);
} else if (state.observationsTotal === 0 && state.cycleSamples === 0) {
  console.log('READY TO COLLECT BASELINE');
  console.log('  Nothing has been observed yet. Take docs/proof/BASELINE_DAY.md and the two field');
  console.log('  sheets, and go. Everything below is what you will come back to fill.');
} else if (!state.defensible) {
  console.log('BASELINE NOT READY');
  for (const b of state.blocking) console.log(`  · ${b}`);
} else {
  console.log('BASELINE DEFENSIBLE');
  console.log(`  ${state.handlingMinutes.toFixed(1)} minutes of human handling per purchase request  [${state.grade}]`);
  console.log(`  from ${state.observationsTotal} observation(s) across ${state.steps.length} steps`);
  console.log(`  the case study could reach ${state.ceiling} with this baseline`);
}

// --- the steps -------------------------------------------------------------
console.log('');
console.log('WHAT EACH STEP IS WORTH TODAY');
for (const s of state.steps) {
  const value = s.minutes === null ? '—' : `${s.minutes.toFixed(1)} min`;
  const share = s.appliesToShare !== 1 ? `  (on ${Math.round(s.appliesToShare * 100)}% of requests)` : '';
  console.log(`  ${s.grade.padEnd(14)} ${value.padStart(9)}  ${String(s.observations).padStart(2)} obs   ${s.id}${share}`);
}
console.log('');
console.log(`  ELAPSED TIME (paper POs)  ${state.cycleSamples} of ${CYCLE_FLOOR}`);
console.log(`  REVIEWED BY               ${state.reviewedBy ?? 'nobody'}`);
console.log(`  LOADED LABOUR RATE        ${state.labourRate ? `$${(state.labourRate / 100).toFixed(2)}/hour [${state.labourRateGrade}]` : 'not supplied — OPTIONAL'}`);

// --- what is holding it back ----------------------------------------------
if (state.weakening.length) {
  console.log('');
  console.log('WHAT IS HOLDING IT BELOW ITS BEST');
  for (const w of state.weakening) console.log(`  · ${w}`);
}
if (state.optional.length) {
  console.log('');
  console.log('OPTIONAL — does not block anything');
  for (const o of state.optional) console.log(`  · ${o}`);
}

// --- the next hour ---------------------------------------------------------
console.log('');
console.log('THE NEXT HOUR');
if (!todo.length) {
  console.log('  Nothing outstanding. Have somebody who did not do the timing read the figures back,');
  console.log('  record them as reviewedBy, then:');
  console.log('    node scripts/baseline-freeze.mjs --by "<you>" --at <today> --opens <install date>');
} else {
  for (const t of todo) console.log(`  · ${String(t.step).padEnd(24)} ${t.have}/${t.need}  ${t.because}`);
}

// --- governance ------------------------------------------------------------
console.log('');
console.log('GOVERNING BASELINE');
console.log(`  ${gov.because}`);
if (gov.established) {
  console.log(`  observation window opens  ${gov.record.observationWindow.opensAt}`);
  if (gov.history.length > 1) {
    console.log('  history:');
    for (const h of gov.history) {
      console.log(`    v${h.version}  ${h.handlingMinutes?.toFixed(1)} min [${h.grade}]  ${h.at} by ${h.by}${h.reason ? ` — ${h.reason}` : ''}`);
    }
  }
}

console.log('');
console.log(`  ${MEASURED_FLOOR} timed observations make a step MEASURED. Fewer is capped below it, however`);
console.log('  carefully it was timed, and one estimate among four timings makes the whole step');
console.log('  SELF_REPORTED — the weakest input sets the grade.');
console.log('');
console.log('  On the day:  docs/proof/BASELINE_DAY.md');
console.log('  Import:      npm run baseline:import');

process.exit(state.defensible ? 0 : 1);
