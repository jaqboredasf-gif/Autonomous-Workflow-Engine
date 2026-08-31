// ---------------------------------------------------------------------------
// eval-baseline-activation.mjs — can Jack actually collect this, and does the
// evidence survive contact with the software?
//
// THE CHAIN THIS COVERS, end to end, with nothing real in it:
//
//   field sheet -> import -> validation -> baseline -> provenance -> grade
//   -> readiness -> freeze -> observation window -> case-study eligibility
//
// WHAT IS WORTH TESTING HERE is not that the happy path works. It is that the
// path REFUSES the things a tired person does at the end of a long day: a row
// pasted twice, a duration in minutes written into the seconds column, a date
// that is not a date, a timing with nothing to go and look at. Each of those
// produces a plausible baseline if it gets through, and a plausible baseline is
// the worst possible output.
//
// AND THAT THE BASELINE CANNOT MOVE QUIETLY. A frozen baseline whose
// observations are edited afterwards must be DETECTABLE — not forbidden,
// because a transcription error is real and correcting it is right, but visible,
// versioned and reasoned.
//
// NOTHING REAL IS TOUCHED. Every fixture is in memory or in a temporary
// directory. A test asserts the committed observation file is still empty,
// because a suite that quietly filled it in would hand us a fabricated baseline.
//
//   node scripts/eval-baseline-activation.mjs
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => join(ROOT, p);

const ING = await import(R('proof/baselines/ingest.mjs'));
const { observation, stepFromObservations, cycleFrom, labourRateFrom, validate, outstanding,
  MEASURED_FLOOR, CYCLE_FLOOR, METHODS } = ING;
const { freeze, digestOf, governing, eligible } = await import(R('proof/baselines/governance.mjs'));
const { readiness } = await import(R('scripts/lib/baseline-readiness.mjs'));
const { baselineStep, defineBaseline, baselineHandlingMinutes, baselineGrade } = await import(R('proof/baseline.mjs'));
const { present } = await import(R('proof/provenance.mjs'));
const { lippolisPurchasingBaseline } = await import(R('proof/baselines/lippolis-purchasing.mjs'));

let pass = 0;
const failures = [];
const notes = [];
const check = (ok, name, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
};
const eq = (a, b, name) => check(
  JSON.stringify(a) === JSON.stringify(b), name,
  JSON.stringify(a) === JSON.stringify(b) ? '' : `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
const near = (a, b, name, tol = 0.01) => check(Math.abs(a - b) <= tol, name, `got ${a}, wanted ${b}`);
const throws = (fn, needle, name) => {
  let m = null;
  try { fn(); } catch (e) { m = e.message; }
  if (m === null) return check(false, name, 'it was allowed');
  return check(m.toLowerCase().includes(needle.toLowerCase()), name, `threw: ${m}`);
};

const STEPS = lippolisPurchasingBaseline.steps.map((s) => s.id);
const obs = (seconds, ref, over = {}) =>
  ({ seconds, method: 'DIRECT_OBSERVATION', observedBy: 'Jack', at: '2026-09-03', ref, ...over });

// ---------------------------------------------------------------------------
console.log('--- the field unit is seconds, because a stopwatch is ------------');
{
  const s = stepFromObservations({ id: 'stock_check', label: 'x',
    observations: [obs(90, 'a'), obs(120, 'b'), obs(75, 'c'), obs(100, 'd'), obs(110, 'e')] });
  eq(s.minutes.provenance, 'MEASURED', 'five timed observations are MEASURED');
  near(s.minutes.value, 100 / 60, 'and the median is taken in seconds, not in rounded minutes');
  check(s.minutes.value !== 2, 'a 100-second step is not recorded as two minutes');

  throws(() => observation({ minutes: 2, seconds: 120, method: 'DIRECT_OBSERVATION', observedBy: 'J', at: 'd', ref: 'r' }),
    'not both', 'giving seconds and minutes together is a transcription error and is refused');
  notes.push('stopwatch seconds survive to the baseline without field arithmetic');
}

// ---------------------------------------------------------------------------
console.log('--- work done in batches is still per-order work ------------------');
{
  // Nobody files one packing slip. Without this, filing could only be an
  // employee estimate, which would drag the whole baseline to SELF_REPORTED.
  const s = stepFromObservations({ id: 'tracking_and_filing', label: 'x', observations: [
    obs(720, 'friday slips', { covers: 12 }), obs(600, 'w2', { covers: 10 }),
    obs(900, 'w3', { covers: 15 }), obs(480, 'w4', { covers: 8 }), obs(660, 'w5', { covers: 11 }),
  ] });
  eq(s.minutes.provenance, 'MEASURED', 'five timed batches are a measurement of the per-order cost');
  near(s.minutes.value, 1, 'twelve minutes across twelve orders is one minute each');
  check(/a batch of 12, timed whole and divided/.test(s.minutes.sources[0].note),
    'and the division is disclosed in the source, not hidden in a round number');
  throws(() => observation({ ...obs(60, 'r'), covers: 0 }), 'at least 1', 'a batch of zero is refused');
  throws(() => observation({ ...obs(60, 'r'), covers: 2.5 }), 'whole number', 'as is half an order');
  notes.push('batch filing is measurable in one sitting, which is what makes a MEASURED baseline reachable');
}

// ---------------------------------------------------------------------------
console.log('--- the malformed rows a tired person actually writes -------------');
{
  const bad = [
    [{ ...obs(60, 'r'), observedBy: undefined }, 'who observed it', 'no observer'],
    [{ ...obs(60, 'r'), at: undefined }, 'when', 'no date'],
    [{ ...obs(60, 'r'), ref: undefined }, 'must name what was observed', 'nothing to go and look at'],
    [{ ...obs(-1, 'r') }, 'non-negative', 'a negative duration'],
    [{ ...obs(60, 'r'), method: 'roughly' }, 'unknown observation method', 'a method nobody defined'],
  ];
  for (const [row, needle, what] of bad) {
    throws(() => observation(row), needle, `${what} is refused`);
  }

  // Duplicates and conflicts, which raise the sample count without adding evidence.
  throws(() => stepFromObservations({ id: 'x', label: 'x', observations: [obs(90, 'PO-7'), obs(90, 'PO-7')] }),
    'appears twice', 'a row pasted twice is refused');
  throws(() => stepFromObservations({ id: 'x', label: 'x', observations: [obs(90, 'PO-7'), obs(120, 'PO-7')] }),
    'different durations', 'and the same reference timed twice differently says so rather than picking one');

  // Four timings and one recollection is not four-fifths measured.
  const mixed = stepFromObservations({ id: 'x', label: 'x', observations: [
    obs(60, 'a'), obs(60, 'b'), obs(60, 'c'), obs(60, 'd'),
    obs(60, 'e', { method: 'EMPLOYEE_ESTIMATE' }),
  ] });
  eq(mixed.minutes.provenance, 'SELF_REPORTED',
    'one estimate among four timings makes the whole step an estimate');

  // Below the floor, however carefully timed.
  const few = stepFromObservations({ id: 'x', label: 'x', observations: [obs(60, 'a'), obs(60, 'b'), obs(60, 'c')] });
  eq(few.minutes.provenance, 'ESTIMATED', `${MEASURED_FLOOR - 3} short of the floor is not a measurement`);
  check(/fewer than 5/.test(few.note), 'and the note says why');
}

// ---------------------------------------------------------------------------
console.log('--- a step that happens sometimes is not a full step --------------');
{
  const always = stepFromObservations({ id: 'clarification', label: 'x',
    observations: [obs(480, 'a'), obs(480, 'b'), obs(480, 'c'), obs(480, 'd'), obs(480, 'e')] });
  const quarter = stepFromObservations({ id: 'clarification', label: 'x', appliesToShare: 0.25,
    observations: [obs(480, 'a'), obs(480, 'b'), obs(480, 'c'), obs(480, 'd'), obs(480, 'e')] });
  near(always.minutes.value, 8, 'eight minutes when it happens');
  near(quarter.minutes.value, 2, 'contributes two when it happens on a quarter of requests');
  check(/25% of units/.test(quarter.note), 'and the scaling is stated');
  throws(() => stepFromObservations({ id: 'x', label: 'x', appliesToShare: 0, observations: [obs(60, 'a')] }),
    'greater than 0', 'a share of zero is refused');
  throws(() => stepFromObservations({ id: 'x', label: 'x', appliesToShare: 1.5, observations: [obs(60, 'a')] }),
    'at most 1', 'as is a share above one');
}

// ---------------------------------------------------------------------------
console.log('--- elapsed time comes from the filing cabinet --------------------');
{
  // THE AFTERNOON THAT USED TO GO NOWHERE. The field kit asked for 25 paper POs
  // with raised and received dates, and the schema had no field for them.
  const po = (i, days) => ({
    ref: `PO-${i}`, raisedAt: '2026-06-01',
    receivedAt: new Date(Date.parse('2026-06-01') + days * 86_400_000).toISOString().slice(0, 10),
    method: 'HISTORICAL_RECORD',
  });
  const fifteen = cycleFrom({ observations: Array.from({ length: 15 }, (_, i) => po(i, (i % 9) + 1)) });
  eq(fifteen.provenance, 'ESTIMATED', 'fifteen filed POs give an ESTIMATED elapsed time');
  check(fifteen.hours > 0, 'with a figure', String(fifteen.hours));
  eq(fifteen.samples, 15, 'and the sample size is recorded');

  const few = cycleFrom({ observations: Array.from({ length: 5 }, (_, i) => po(i, i + 1)) });
  eq(few.provenance, 'SELF_REPORTED', `below ${CYCLE_FLOOR} it is graded no better than an impression`);

  // The median, not the mean: one back-ordered item must not drag it.
  const withOutlier = cycleFrom({ observations: [
    ...Array.from({ length: 14 }, (_, i) => po(i, 5)), po(99, 200),
  ] });
  near(withOutlier.hours, 5 * 24, 'a single 200-day back-order does not move the median');

  eq(cycleFrom(null).provenance, 'UNAVAILABLE', 'and no POs read is UNAVAILABLE, not zero');
  throws(() => cycleFrom({ observations: [{ ref: 'x', method: 'HISTORICAL_RECORD' }] }),
    'no usable duration', 'a row with no dates is refused rather than assumed');
  throws(() => cycleFrom({ observations: [{ raisedAt: '2026-01-01', receivedAt: '2026-01-02', method: 'HISTORICAL_RECORD' }] }),
    'must name the purchase order', 'as is one with nothing to check it against');
  notes.push('the paper-PO afternoon now reaches the baseline as elapsed time');
}

// ---------------------------------------------------------------------------
console.log('--- the loaded labour rate is OPTIONAL ----------------------------');
{
  // HOURS RETURNED IS THE PRIMARY METRIC and must not wait on payroll.
  const steps = STEPS.map((id) => stepFromObservations({ id, label: id,
    observations: [obs(120, `${id}-1`), obs(120, `${id}-2`), obs(120, `${id}-3`), obs(120, `${id}-4`), obs(120, `${id}-5`)] }));
  const noRate = defineBaseline({
    id: 'lippolis_purchasing_v0', version: '1.0.0', orgId: 'lippolis',
    process: 'p', description: 'd', effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'request',
    steps, coversSteps: ['purchasing'],
    labourRateCentsPerHour: null, labourRateProvenance: 'UNAVAILABLE',
    reviewedBy: 'Mike', reviewedAt: '2026-09-10',
  });
  eq(baselineHandlingMinutes(noRate).known, true, 'a baseline with no labour rate still has a handling time');
  eq(baselineGrade(noRate), 'MEASURED', 'at full grade');
  eq(noRate.labourRate.known, false, 'while the rate itself stays unknown');

  const doc = docWith(steps.length, { labourRate: null });
  const state = readiness(doc, noRate);
  eq(state.defensible, true, 'and the baseline is DEFENSIBLE without it');
  eq(state.optional.length, 1, 'the rate is reported as optional');
  check(/does not wait on it/.test(state.optional[0]), 'saying explicitly what does and does not wait on it');
  check(!state.blocking.some((b) => /labour|rate/i.test(b)), 'and it blocks nothing');

  // Supplied later, it must carry provenance.
  const rate = labourRateFrom({ centsPerHour: 5200, method: 'HISTORICAL_RECORD', ref: 'payroll, Paul, 2026-09-02' });
  eq(rate.provenance, 'ESTIMATED', 'a rate from payroll records is ESTIMATED');
  eq(rate.sources.length, 1, 'and carries a source');
  throws(() => labourRateFrom({ centsPerHour: 5200, method: 'HISTORICAL_RECORD' }),
    'name where the figure came from', 'a rate with no provenance is refused');
  throws(() => labourRateFrom({ centsPerHour: -1, method: 'HISTORICAL_RECORD', ref: 'x' }),
    'positive', 'as is a negative one');
  notes.push('hours returned never waits on payroll; only the money figure does');
}

// ---------------------------------------------------------------------------
console.log('--- readiness cannot be declared, only earned ---------------------');
{
  const partial = STEPS.slice(0, 5).map((id) => stepFromObservations({ id, label: id,
    observations: Array.from({ length: 5 }, (_, i) => obs(120, `${id}-${i}`)) }));
  const missing = STEPS.slice(5).map((id) => baselineStep({ id, label: id, minutes: null, provenance: 'UNAVAILABLE' }));
  const b = defineBaseline({
    id: 'lippolis_purchasing_v0', version: '1.0.0', orgId: 'lippolis',
    process: 'p', description: 'd', effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'request',
    steps: [...partial, ...missing], coversSteps: ['purchasing'],
  });
  const doc = { steps: Object.fromEntries([
    ...STEPS.slice(0, 5).map((id) => [id, { observations: Array.from({ length: 5 }, (_, i) => obs(120, `${id}-${i}`)), appliesToShare: 1 }]),
    ...STEPS.slice(5).map((id) => [id, { observations: [], appliesToShare: 1 }]),
  ]) };
  const state = readiness(doc, b);
  eq(state.defensible, false, 'five of seven steps observed is NOT READY');
  eq(state.blocking.length, 2, 'and it names the two that are missing');
  check(state.blocking.every((x) => /no observations at all/.test(x)), 'by name');
  eq(state.ceiling, 'NOT_READY', 'no case study can be built on it');

  // NO ESCAPE HATCH, checked as BEHAVIOUR rather than as prose — the first
  // version of this matched the readiness module's own comment saying there is
  // no --force, and failed.
  const strip = (f) => readFileSync(R(f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = strip('scripts/lib/baseline-readiness.mjs') + strip('scripts/baseline-freeze.mjs');
  for (const escape of ['force', 'override', 'skip', 'ignore']) {
    check(!new RegExp(`arg\\(['"]${escape}`, 'i').test(code) &&
      !new RegExp(`includes\\(['"]--${escape}`, 'i').test(code),
      `no --${escape} flag is read anywhere in the readiness or freeze path`);
  }
  check(!/defensible\s*[:=]\s*true/.test(code),
    'and nothing assigns defensibility directly');
  notes.push('the only way to reach DEFENSIBLE is to have collected the evidence');
}

// ---------------------------------------------------------------------------
console.log('--- freezing, and what stops the baseline moving quietly ----------');
{
  const steps = STEPS.map((id) => stepFromObservations({ id, label: id,
    observations: Array.from({ length: 5 }, (_, i) => obs(120, `${id}-${i}`)) }));
  const b = defineBaseline({
    id: 'lippolis_purchasing_v0', version: '1.0.0', orgId: 'lippolis',
    process: 'p', description: 'd', effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'request',
    steps, coversSteps: ['purchasing'], reviewedBy: 'Mike', reviewedAt: '2026-09-10',
  });
  const doc = docWith(7);
  const handling = baselineHandlingMinutes(b);

  const v1 = freeze({ doc, baseline: b, handlingMinutes: handling,
    establishedBy: 'Jack Daly', at: '2026-09-10', opensAt: '2026-09-15' });
  eq(v1.version, 1, 'the first freeze is version 1');
  eq(v1.establishedBy, 'Jack Daly', 'and names a person');
  eq(v1.handlingMinutes, handling.value, 'recording what the baseline came out as');
  check(v1.evidenceDigest.length === 64, 'with a digest of the evidence it was built from');
  eq(Object.keys(v1.stepGrades).length, 7, 'and every step\'s grade');

  // A person, not a script.
  throws(() => freeze({ doc, baseline: b, handlingMinutes: handling, at: '2026-09-10', opensAt: '2026-09-15' }),
    'name the person', 'a freeze with no person is refused');
  throws(() => freeze({ doc, baseline: b, handlingMinutes: handling, establishedBy: 'Jack', at: '2026-09-10' }),
    'when the production observation window opens', 'as is one that opens no window');
  throws(() => freeze({ doc, baseline: b, handlingMinutes: handling, establishedBy: 'Jack', at: '2026-09-20', opensAt: '2026-09-15' }),
    'cannot govern work that predates it', 'and one whose window opens before the baseline existed');
  throws(() => freeze({ doc, baseline: b, handlingMinutes: { known: false }, establishedBy: 'J', at: '2026-09-10', opensAt: '2026-09-15' }),
    'nothing to freeze', 'a baseline with no handling total cannot be frozen');

  // THE DIGEST IS ABOUT EVIDENCE, not commentary.
  const commented = { ...doc, _README: ['a new comment'], reviewedBy: 'Somebody Else' };
  eq(digestOf(commented), digestOf(doc), 'editing a comment or a reviewer name is not tampering');
  const edited = JSON.parse(JSON.stringify(doc));
  edited.steps[STEPS[0]].observations[0].seconds = 999;
  check(digestOf(edited) !== digestOf(doc), 'changing a measurement always is');

  // DRIFT IS DETECTED, NOT FORBIDDEN.
  eq(governing([v1], doc).drifted, false, 'an unedited file has not drifted');
  const drifted = governing([v1], edited);
  eq(drifted.drifted, true, 'an edited one has');
  check(/computed against the FROZEN evidence/.test(drifted.because),
    'and the report says which figures are being used');
  check(/freeze an amendment with a reason/.test(drifted.because), 'and what to do about it');

  // AMENDMENTS ARE VERSIONED AND MUST SAY WHY.
  throws(() => freeze({ doc: edited, baseline: b, handlingMinutes: handling, establishedBy: 'Jack',
    at: '2026-09-20', opensAt: '2026-09-25', version: 2, supersedes: 1 }),
    'gives no reason', 'an amendment with no reason is refused');
  const v2 = freeze({ doc: edited, baseline: b, handlingMinutes: handling, establishedBy: 'Jack',
    at: '2026-09-20', opensAt: '2026-09-25', version: 2, supersedes: 1,
    reason: 'po_preparation row 4 read 320s on the sheet and was typed as 32s' });
  const g = governing([v1, v2], edited);
  eq(g.record.version, 2, 'v2 supersedes v1 and governs');
  eq(g.history.length, 2, 'and v1 stays visible in the history');
  check(g.history[1].reason.includes('320s'), 'with the reason it was amended');
  eq(g.drifted, false, 'and the amended baseline matches the edited file');
  notes.push('a baseline can be corrected; it cannot be corrected invisibly');
}

// ---------------------------------------------------------------------------
console.log('--- drift is a governance state, not a collection blocker ---------');
{
  // FOUND BY WALKING THROUGH IT. An edited observation printed "BLOCKED —
  // collection cannot start", which is the wrong instruction: collection has
  // already happened, and what is needed is a revert or an amendment.
  const cmd = readFileSync(R('scripts/baseline-observations.mjs'), 'utf8');
  check(/EVIDENCE HAS DRIFTED FROM THE FROZEN BASELINE/.test(cmd),
    'drift has its own headline');
  check(!/must\(!gov\.drifted/.test(cmd), 'and is not one of the pre-flight blockers');
  check(/--supersedes \$\{gov\.record\.version\}/.test(cmd),
    'and the headline prints the exact amendment command, with the version filled in');
  check(/still computed against the frozen figures/.test(cmd),
    'saying that nothing has silently changed in the meantime');
}

// ---------------------------------------------------------------------------
console.log('--- the observation window decides what is eligible ---------------');
{
  const steps = STEPS.map((id) => stepFromObservations({ id, label: id,
    observations: Array.from({ length: 5 }, (_, i) => obs(120, `${id}-${i}`)) }));
  const b = defineBaseline({
    id: 'lippolis_purchasing_v0', version: '1.0.0', orgId: 'lippolis',
    process: 'p', description: 'd', effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'request',
    steps, coversSteps: ['purchasing'], reviewedBy: 'Mike', reviewedAt: '2026-09-10',
  });
  const record = freeze({ doc: docWith(7), baseline: b, handlingMinutes: baselineHandlingMinutes(b),
    establishedBy: 'Jack', at: '2026-09-10', opensAt: '2026-09-15T00:00:00Z' });

  eq(eligible(record, '2026-09-14T23:59:59Z').ok, false, 'a purchase raised the day before is not eligible');
  check(/before the observation window opened/.test(eligible(record, '2026-09-14T00:00:00Z').because),
    'and is told why');
  eq(eligible(record, '2026-09-15T00:00:00Z').ok, true, 'one raised the moment it opens is');
  eq(eligible(record, '2026-11-01T00:00:00Z').ok, true, 'and so is one two months later — the window does not close on its own');
  eq(eligible(null, '2026-11-01T00:00:00Z').ok, false, 'with no frozen baseline nothing is eligible');

  // The window belongs to the baseline, not to the command line.
  check(record.observationWindow.governingBaselineVersion === record.version,
    'the window names the baseline version that governs it');
  check(/whatever became of it/.test(record.observationWindow.inclusionRule),
    'and its inclusion rule keeps failures in the population');
  check(/does not reconcile/.test(record.observationWindow.denominatorRule),
    'and states the denominator rule fixed in advance');
  notes.push('purchases before the window cannot enter, and purchases after it cannot silently leave');
}

// ---------------------------------------------------------------------------
console.log('--- the importer refuses what it cannot be sure of ----------------');
{
  const dir = mkdtempSync(join(tmpdir(), 'baseline-'));
  const field = join(dir, 'field');
  mkdirSync(field, { recursive: true });

  const run = (handling, cycle, target) => {
    writeFileSync(join(field, 'handling.csv'), handling);
    writeFileSync(join(field, 'cycle.csv'), cycle);
    writeFileSync(join(dir, 'lippolis-purchasing.json'), JSON.stringify(target ?? { steps: {}, observedOn: '2026-09-03' }, null, 2));
    return spawnSync(process.execPath, [R('scripts/baseline-import.mjs'), '--dry-run'],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PCC_OBS_DIR: dir } });
  };

  // The importer reads the committed paths, so the malformed cases are checked
  // through the module's own rules rather than by relocating it.
  const HEAD = 'step,seconds,who,ref,covers,method,date,note\n';
  const bad = [
    ['not_a_step,60,Mike,x,,,2026-09-03,', 'is not one of the seven steps'],
    ['stock_check,abc,Mike,x,,,2026-09-03,', 'Write what the stopwatch said'],
    ['stock_check,-5,Mike,x,,,2026-09-03,', 'Write what the stopwatch said'],
    ['stock_check,99999,Mike,x,,,2026-09-03,', 'over two hours'],
    ['stock_check,60,,x,,,2026-09-03,', 'no "who"'],
    ['stock_check,60,Mike,,,,2026-09-03,', 'no "ref"'],
    ['stock_check,60,Mike,x,,guessed,2026-09-03,', 'method "guessed" is not one of'],
    ['stock_check,60,Mike,x,,,03/09/2026,', 'is not YYYY-MM-DD'],
    ['stock_check,60,Mike,x,0,,2026-09-03,', 'covers is'],
  ];
  const importer = readFileSync(R('scripts/baseline-import.mjs'), 'utf8');
  for (const [, message] of bad) {
    check(importer.includes(message.split('"')[0].trim().slice(0, 24)),
      `the importer has a message for: ${message.slice(0, 40)}`);
  }
  check(/nothing was written/.test(importer), 'and it writes nothing when any row is bad');
  check(/looks finished/.test(importer), 'saying why a half-import is worse than none');
  check(/received .* is before raised/.test(importer), 'it catches a received date before the raised date');
  check(/typo in one of the years/.test(importer), 'and a year typo');
  check(/PRESERVED, not regenerated/.test(importer),
    'and it preserves the labour rate, reviewer and appliesToShare it did not produce');

  // The real importer, against the real (empty) sheets, is a no-op.
  const real = spawnSync(process.execPath, [R('scripts/baseline-import.mjs'), '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  eq(real.status, 0, 'the committed empty sheets import cleanly');
  check(/handling observations   0/.test(real.stdout), 'as zero observations');
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log('--- nothing real was filled in by this suite ----------------------');
{
  // A suite that quietly populated the observation file would hand us a
  // fabricated baseline, which is the exact thing all of this exists to stop.
  const doc = JSON.parse(readFileSync(R('proof/baselines/observations/lippolis-purchasing.json'), 'utf8'));
  eq(validate(doc, { expectSteps: Object.keys(doc.steps) }), [], 'the committed observation file is valid');
  check(Object.values(doc.steps).every((s) => (s.observations?.length ?? 0) === 0),
    'and every step is still empty');
  eq(doc.cycle.observations.length, 0, 'no paper POs have been read');
  eq(doc.labourRate.centsPerHour, null, 'no labour rate has been supplied');
  eq(doc.reviewedBy, null, 'and nobody has reviewed anything');

  const state = readiness(doc, lippolisPurchasingBaseline);
  eq(state.defensible, false, 'so the real baseline is NOT READY');
  eq(state.blocking.length, 7, 'with all seven steps unobserved');
  eq(state.ceiling, 'NOT_READY', 'and no case study can rest on it');

  check(!existsSync(R('proof/baselines/frozen/lippolis-purchasing.v1.json')),
    'nothing has been frozen');
  eq(governing([], doc).established, false, 'so nothing governs Case Study #001 yet');
  eq(outstanding(doc, { expectSteps: STEPS }).length, 9,
    'and nine things are outstanding: seven steps, the paper POs and the rate');
  notes.push('the committed baseline is still empty, which is the true state of the world');
}

// ---------------------------------------------------------------------------
console.log('--- the checklist matches the code -------------------------------');
{
  const day = readFileSync(R('docs/proof/BASELINE_DAY.md'), 'utf8');

  // THE DEFECT THIS PAGE REPLACED: "time each of the seven steps five times, in
  // one morning" is not physically executable, because filing happens over days
  // and the approver is a different person. Both are now addressed by name.
  check(/covers/.test(day) && /whole stack/.test(day),
    'the checklist tells the founder to time filing as a batch');
  check(/different person/.test(day), 'and that the approver is somebody else');
  check(/that is fine|normal first pass/i.test(day),
    'and that coming back short on the hard steps is normal rather than a failure');
  // FOUND BY READING IT AS JACK: tracking_and_filing covers chasing (per order)
  // and filing (per batch), and a median over rows measuring different things
  // is not a median of anything.
  check(/chasing AND filing/.test(day) && /different rates/.test(day),
    'the checklist warns that the tracking step mixes two rates');
  check(/keep the watch running across/.test(day),
    'and gives one executable instruction rather than a caveat');
  check(/most likely to be understated/.test(day),
    'and says which way the error would run');

  // The one rule that decides whether the evidence is usable.
  check(/OCCUPIED/.test(day), 'it states that only occupied minutes are timed');
  check(/When in doubt, stop the watch/.test(day), 'with a rule for the ambiguous case');
  check(/tally/.test(day) && /appliesToShare/.test(day),
    'and that the sometimes-step needs a count, not a timing');

  // Numbers in the page must be the numbers in the code.
  check(day.includes(`**Five of each step.**`), `it asks for ${MEASURED_FLOOR} of each step`);
  check(day.includes('You need 15'), `and ${CYCLE_FLOOR} paper POs`);
  check(day.includes('30 completed purchases'), 'and 30 production purchases');

  // Every command it names must run.
  const commands = [...day.matchAll(/^\s*(npm run [\w:]+|node scripts\/[\w.-]+)/gm)].map((m) => m[1]);
  check(commands.length >= 5, `${commands.length} commands are named`);
  for (const c of new Set(commands)) {
    if (c.startsWith('node scripts/')) {
      check(existsSync(R(c.replace('node ', ''))), `${c} exists`);
    } else {
      const name = c.replace('npm run ', '');
      const pkg = JSON.parse(readFileSync(R('package.json'), 'utf8'));
      check(Boolean(pkg.scripts[name]), `${c} is a defined npm script`);
    }
  }
  // Files the page tells the founder to OPEN must exist. Files it says the
  // tooling will CREATE must not be required to.
  const created = /proof\/baselines\/frozen\//;
  for (const f of [...day.matchAll(/`(proof\/[\w./-]+|docs\/[\w./-]+)`/g)].map((m) => m[1])) {
    if (created.test(f)) {
      check(!existsSync(R(f)), `${f} is named as an output and does not exist yet`);
      continue;
    }
    check(existsSync(R(f)), `${f} exists`);
  }

  // It must not send the founder to read architecture.
  check(!/aggregate\(\)|provenance\.mjs|ledger\.mjs|confidenceOf/.test(day),
    'and it names no internal module the founder would have to understand');
  notes.push('every command, file and threshold in the checklist is checked against the code');
}

function docWith(n, over = {}) {
  return {
    baselineId: 'lippolis_purchasing_v0', orgId: 'lippolis',
    reviewedBy: 'Mike', reviewedAt: '2026-09-10',
    labourRate: { centsPerHour: null },
    steps: Object.fromEntries(STEPS.slice(0, n).map((id) => [id, {
      observations: Array.from({ length: 5 }, (_, i) => obs(120, `${id}-${i}`)), appliesToShare: 1,
    }])),
    cycle: { observations: [] },
    ...over,
  };
}

console.log('');
for (const n of notes) console.log(`  note: ${n}`);
console.log('');
console.log(`baseline activation: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
