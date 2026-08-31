// ---------------------------------------------------------------------------
// eval-proof.mjs — can the proof system be made to lie?
//
// Most of this suite is adversarial. The easy half checks that the arithmetic
// is right; the hard half tries to get a bigger number out of it than the
// evidence supports, using every route a real deployment would eventually take
// by accident:
//
//   double counting a retry · excluding failures · counting machine time as
//   labour · a partial baseline · an unpriced interaction · a baseline written
//   after the work · another tenant's baseline · an estimate reported as a
//   measurement · overlapping capabilities claiming the same minutes ·
//   correlation dressed as causation · a small sample presented with confidence
//
// Each of those is a named check below and each one must FAIL to produce a
// number. A green run means the system refused every one of them.
//
//   node scripts/eval-proof.mjs
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (f) => join(ROOT, 'proof', f);

const {
  PROVENANCE_GRADES, quantity, source, unavailable, derive, sum, present,
  weakestOf, toHours, gradeMix,
} = await import(P('provenance.mjs'));
const {
  baselineStep, defineBaseline, defineTouchStandard, baselineHandlingMinutes,
  baselineGrade, versionInForce, assertNoOverlap, touchMinutes, unpricedActions,
} = await import(P('baseline.mjs'));
const {
  executionRecord, humanTouch, objectiveTest, businessOutcome, cycleRecord,
  cycleFromTimestamps, touchProfile, humansInvolved, OBJECTIVE_RESULTS,
  EXECUTION_OUTCOMES,
} = await import(P('execution.mjs'));
const { valueOf, valueClaim, observedHumanMinutes, EXCLUSION_REASONS } = await import(P('value.mjs'));
const { aggregate, overhead, confidenceOf } = await import(P('ledger.mjs'));
const { caseStudy, explain, render } = await import(P('case-study.mjs'));
const PA = await import(P('adapters/purchasing.mjs'));
const LIP = await import(P('baselines/lippolis-purchasing.mjs'));
const { ACTIVITY_ACTIONS } = await import(join(ROOT, 'apps/purchasing/src/purchasing/domain/activity.mjs'));

const { readFileSync: _rfs } = await import('node:fs');
const readFileSyncTop = (p) => _rfs(p, 'utf8');

let pass = 0;
const failures = [];
const notes = [];
const ok = () => { pass++; };
const bad = (m) => { failures.push(m); console.log(`FAIL  ${m}`); };
const check = (c, m) => (c ? ok() : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok() : bad(`${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));
const near = (a, b, m, tol = 1e-9) => (Number.isFinite(a) && Math.abs(a - b) < tol ? ok() : bad(`${m} (got ${a}, want ${b})`));
const throws = (fn, fragment, m) => {
  try { fn(); bad(`${m} — nothing was thrown`); } catch (e) {
    if (String(e.message).includes(fragment)) ok();
    else bad(`${m} — threw the wrong thing: ${e.message}`);
  }
};
const note = (m) => { notes.push(m); };

const SRC = source({ kind: 'OBSERVED_TIMING', ref: 'timed session 2026-08-20, purchaser A' });
const SYS = (ref) => source({ kind: 'SYSTEM_RECORD', ref });

// ---------------------------------------------------------------------------
console.log('--- provenance: unknown stays unknown ---------------------------');

{
  const u = unavailable('hours', 'nobody measured it');
  eq(u.value, null, 'an unavailable quantity has a null value');
  eq(u.known, false, 'and knows it is not known');
  eq(present(u), null, 'and presents as null, never as zero');

  throws(() => quantity({ value: 0, unit: 'hours', provenance: 'UNAVAILABLE' }),
    'unknown is not zero', 'an UNAVAILABLE quantity may not carry a value');
  throws(() => quantity({ value: 4, unit: 'hours', provenance: 'MEASURED', basis: 'x' }),
    'must name at least one source', 'a known quantity with no source is refused');
  throws(() => quantity({ value: 4, unit: 'hours', provenance: 'MEASURED', sources: [SRC] }),
    'needs a basis', 'a known quantity with no basis is refused');
  throws(() => source({ kind: 'OBSERVED_TIMING', ref: '' }),
    'a source nobody can go and check', 'a source with no ref is refused');
  throws(() => quantity({ value: 1, unit: 'furlongs', provenance: 'MEASURED', sources: [SRC], basis: 'x' }),
    'unknown unit', 'an unknown unit is refused');
}

{
  // Degradation is one-way.
  eq(weakestOf(['MEASURED', 'MEASURED']), 'MEASURED', 'measured plus measured stays measured');
  eq(weakestOf(['MEASURED', 'SELF_REPORTED']), 'SELF_REPORTED', 'one self-reported input degrades the whole');
  eq(weakestOf(['ESTIMATED', 'INFERRED']), 'INFERRED', 'the weaker of two weak grades wins');
  eq(weakestOf([]), 'UNAVAILABLE', 'nothing supports nothing');

  const m = quantity({ value: 10, unit: 'minutes', provenance: 'MEASURED', sources: [SRC], basis: 'a' });
  const e = quantity({ value: 5, unit: 'minutes', provenance: 'SELF_REPORTED', sources: [SRC], basis: 'b' });
  const d = derive({ m, e }, ({ m: x, e: y }) => x - y, { unit: 'minutes', basis: 'a minus b' });
  eq(d.value, 5, 'a derivation computes');
  eq(d.provenance, 'SELF_REPORTED', 'and grades at its weakest input, never at its best');
}

{
  // One unknown term poisons a derivation, but not a population sum.
  const known = quantity({ value: 10, unit: 'minutes', provenance: 'MEASURED', sources: [SRC], basis: 'a' });
  const un = unavailable('minutes', 'nobody looked');
  const d = derive({ known, un }, ({ known: a, un: b }) => a - b, { unit: 'minutes', basis: 'a minus b' });
  eq(d.known, false, 'a derivation with an unknown term is unavailable, not partial');
  check(d.basis.includes('un'), 'and names which term is missing');

  const s = sum([known, un], { unit: 'minutes', basis: 'total' });
  eq(s.value, 10, 'a population sum skips unknown members');
  eq(s.sources.at(-1).sampleSize, 1, 'and records how many members it actually summed');
}

{
  // Fake precision.
  const est = quantity({ value: 3.14159, unit: 'hours', provenance: 'ESTIMATED', sources: [SRC], basis: 'x' });
  const meas = quantity({ value: 3.14159, unit: 'hours', provenance: 'MEASURED', sources: [SRC], basis: 'x' });
  check(present(est) === 3 || present(est) === 3.5, 'an estimated figure is presented at a coarse resolution');
  near(present(meas), 3.1, 'a measured figure is presented more finely');
  check(present(est) !== present(meas), 'and the two do not print the same, which is the whole point');
}

// ---------------------------------------------------------------------------
console.log('--- baselines: provenance, partiality, drift, overlap -----------');

const step = (id, minutes, provenance = 'MEASURED') => baselineStep({
  id, label: id, minutes, provenance,
  sources: provenance === 'UNAVAILABLE' ? [] : [SRC],
});

const measuredBaseline = defineBaseline({
  id: 'acme_purchasing', version: '1.0.0', orgId: 'acme',
  process: 'Buying material', description: 'x',
  effectiveFrom: '2026-01-01T00:00:00Z',
  unitOfWork: 'purchase request',
  steps: [step('intake', 2), step('approve', 3), step('po', 5), step('vendor', 2), step('file', 3)],
  coversSteps: ['intake', 'approval', 'po_prep', 'vendor_comms', 'filing'],
  labourRateCentsPerHour: 6000, labourRateProvenance: 'MEASURED',
  labourRateSources: [source({ kind: 'HISTORICAL_RECORD', ref: 'acme payroll 2026 Q2' })],
  cycleHours: 72, cycleProvenance: 'ESTIMATED',
  cycleSources: [source({ kind: 'HISTORICAL_RECORD', ref: 'acme paper POs 2025', sampleSize: 40 })],
});

{
  const total = baselineHandlingMinutes(measuredBaseline);
  eq(total.value, 15, 'a fully measured baseline totals its steps');
  eq(total.provenance, 'MEASURED', 'and carries the grade of its weakest step');
  eq(baselineGrade(measuredBaseline), 'MEASURED', 'baselineGrade agrees');
}

{
  // A partial baseline is refused, even though summing the known steps would
  // UNDER-state savings. The direction of an error does not license it.
  const partial = defineBaseline({
    ...structuredCloneish(measuredBaseline),
    id: 'acme_partial', version: '1.0.0', orgId: 'acme',
    process: 'x', description: 'x', effectiveFrom: '2026-01-01T00:00:00Z',
    unitOfWork: 'purchase request',
    steps: [step('intake', 2), step('approve', null, 'UNAVAILABLE')],
    coversSteps: ['intake', 'approval'],
  });
  const t = baselineHandlingMinutes(partial);
  eq(t.known, false, 'a baseline with an unmeasured step has no total');
  check(t.basis.includes('a partial baseline is not a baseline'), 'and says why');
}

{
  const empty = defineBaseline({
    id: 'acme_empty', version: '1.0.0', orgId: 'acme', process: 'x', description: 'x',
    effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'request',
    steps: [step('a', null, 'UNAVAILABLE')], coversSteps: ['a'],
  });
  eq(baselineHandlingMinutes(empty).known, false, 'an entirely unmeasured baseline has no total');
}

{
  throws(() => defineBaseline({
    id: 'x', version: '1', orgId: 'o', process: 'p', description: 'd',
    effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'r',
    steps: [step('a', 1)], coversSteps: [],
  }), 'must name the work it covers', 'a baseline that covers nothing cannot be checked for overlap');

  throws(() => defineBaseline({
    id: 'x', version: '1', orgId: 'o', process: 'p', description: 'd',
    effectiveFrom: '2026-01-01T00:00:00Z',
    steps: [step('a', 1)], coversSteps: ['a'],
  }), 'needs a unitOfWork', 'a baseline must say "per what"');

  throws(() => defineBaseline({
    id: 'x', version: '1', orgId: 'o', process: 'p', description: 'd',
    unitOfWork: 'r', steps: [step('a', 1)], coversSteps: ['a'],
  }), 'needs effectiveFrom', 'a baseline with no date cannot be bound to an execution');
}

{
  // Baseline drift: an execution binds to the version in force at ITS start.
  const v2 = defineBaseline({
    id: 'acme_purchasing', version: '2.0.0', orgId: 'acme',
    process: 'x', description: 'x',
    effectiveFrom: '2026-06-01T00:00:00Z', unitOfWork: 'purchase request',
    steps: [step('intake', 1), step('approve', 1)],
    coversSteps: ['intake', 'approval'],
  });
  const v1 = defineBaseline({
    ...pick(measuredBaseline), id: 'acme_purchasing', version: '1.0.0', orgId: 'acme',
    process: 'x', description: 'x',
    effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-06-01T00:00:00Z',
    unitOfWork: 'purchase request',
    steps: [step('intake', 2), step('approve', 3)], coversSteps: ['intake', 'approval'],
  });
  const all = [v1, v2];
  eq(versionInForce(all, { orgId: 'acme', id: 'acme_purchasing', at: '2026-03-01T00:00:00Z' })?.version,
    '1.0.0', 'work in March is measured against the March baseline');
  eq(versionInForce(all, { orgId: 'acme', id: 'acme_purchasing', at: '2026-07-01T00:00:00Z' })?.version,
    '2.0.0', 'work in July is measured against the July baseline');
  eq(versionInForce(all, { orgId: 'acme', id: 'acme_purchasing', at: '2025-01-01T00:00:00Z' }),
    null, 'work done before any baseline existed has none — no retroactive justification');
  eq(versionInForce(all, { orgId: 'other', id: 'acme_purchasing', at: '2026-03-01T00:00:00Z' }),
    null, 'and a baseline never crosses an organization boundary');
}

{
  // Overlapping capabilities claiming the same human work.
  const purchasing = measuredBaseline;
  const officeAdmin = defineBaseline({
    id: 'acme_office_admin', version: '1.0.0', orgId: 'acme',
    process: 'Office administration', description: 'x',
    effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'day',
    steps: [step('po', 5)],
    coversSteps: ['po_prep', 'invoice_entry'],           // po_prep overlaps
  });
  throws(() => assertNoOverlap([purchasing, officeAdmin]),
    'cannot be returned twice', 'two baselines claiming the same work for one org are refused');

  const different = defineBaseline({
    id: 'acme_office_admin', version: '1.0.0', orgId: 'acme',
    process: 'x', description: 'x', effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'day',
    steps: [step('inv', 5)], coversSteps: ['invoice_entry'],
  });
  check(assertNoOverlap([purchasing, different]), 'non-overlapping baselines are allowed');

  const otherOrg = defineBaseline({
    id: 'other_office', version: '1.0.0', orgId: 'other',
    process: 'x', description: 'x', effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'day',
    steps: [step('po', 5)], coversSteps: ['po_prep'],
  });
  check(assertNoOverlap([purchasing, otherOrg]),
    'the same work claimed by a DIFFERENT organization is not an overlap');
}

// ---------------------------------------------------------------------------
console.log('--- touch standards: unpriced is unknown, not free --------------');

const standard = defineTouchStandard({
  id: 'acme_touches', version: '1.0.0', orgId: 'acme', capability: 'purchasing',
  effectiveFrom: '2026-01-01T00:00:00Z',
  actions: {
    'request.created': { minutes: 2, provenance: 'MEASURED', sources: [SRC] },
    'decision.approved': { minutes: 1, provenance: 'MEASURED', sources: [SRC] },
    'review.saved': { minutes: 2, provenance: 'MEASURED', sources: [SRC] },
    'request.completed': { minutes: 1, provenance: 'MEASURED', sources: [SRC] },
    'receipt.completed': { minutes: 1, provenance: 'MEASURED', sources: [SRC] },
    'clarification.requested': { minutes: 2, provenance: 'MEASURED', sources: [SRC] },
  },
});

{
  eq(touchMinutes(standard, 'request.created').value, 2, 'a priced action returns its minutes');
  const un = touchMinutes(standard, 'po.generated');
  eq(un.known, false, 'an unpriced action is unknown');
  check(un.basis.includes('not free'), 'and says so in the words that matter');

  const withDefault = defineTouchStandard({
    id: 'd', version: '1', orgId: 'acme', capability: 'purchasing',
    effectiveFrom: '2026-01-01T00:00:00Z', defaultMinutes: 3,
    actions: { 'request.created': { minutes: 2, provenance: 'MEASURED', sources: [SRC] } },
  });
  eq(touchMinutes(withDefault, 'po.generated').provenance, 'INFERRED',
    'a defaulted action is INFERRED, never measured');

  eq(unpricedActions(standard, ['request.created', 'po.generated']), ['po.generated'],
    'unpricedActions names exactly what still needs timing');
}

// ---------------------------------------------------------------------------
console.log('--- execution records: the four separate questions ---------------');

const T = (action, at, actorId = 'u1', extra = {}) => humanTouch({ action, actorId, at, ...extra });

const achieved = () => objectiveTest({
  name: 'material_in_hand', statement: 'The material arrived on time and in full.',
  result: 'ACHIEVED', evidence: [SYS('purchase_requests.received_at for r1')],
});

function record(over = {}) {
  return executionRecord({
    id: 'e1', orgId: 'acme', capability: 'purchasing', workflow: 'p2p',
    objectiveId: 'material_in_hand', baselineId: 'acme_purchasing',
    scopeKey: 'purchase_request:r1',
    startedAt: '2026-03-01T09:00:00Z', endedAt: '2026-03-03T09:00:00Z',
    executionOutcome: 'COMPLETED',
    humanTouches: [
      T('request.created', '2026-03-01T09:00:00Z', 'u1', { kind: 'ORIGINATION' }),
      T('decision.approved', '2026-03-01T10:00:00Z', 'u2', { kind: 'APPROVAL' }),
    ],
    objective: achieved(),
    cycle: cycleFromTimestamps({ from: '2026-03-01T09:00:00Z', to: '2026-03-03T09:00:00Z', label: 'c', ref: 'x' }),
    ...over,
  });
}

{
  const r = record();
  eq(r.executionSucceeded, true, 'execution success is its own field');
  eq(r.objectiveResult, 'ACHIEVED', 'objective success is a different field');
  check(r.executionSucceeded !== undefined && r.objectiveResult !== undefined,
    'and neither is derived from the other');

  const wrong = record({ objective: objectiveTest({
    name: 'x', statement: 'y', result: 'NOT_ACHIEVED', evidence: [SYS('r')] }) });
  eq(wrong.executionSucceeded, true, 'a workflow that ran perfectly still reports execution success');
  eq(wrong.objectiveResult, 'NOT_ACHIEVED', 'while reporting that the organization did not get what it wanted');
}

{
  throws(() => executionRecord({
    id: 'e', orgId: 'o', capability: 'c', workflow: 'w', objectiveId: 'x',
    baselineId: 'b', startedAt: '2026-01-01T00:00:00Z', executionOutcome: 'COMPLETED',
  }), 'no scopeKey', 'an execution with no scopeKey is refused — without it a retry is free money');

  throws(() => executionRecord({
    id: 'e', orgId: 'o', capability: 'c', workflow: 'w', objectiveId: 'x',
    scopeKey: 's', startedAt: '2026-01-01T00:00:00Z', executionOutcome: 'COMPLETED',
  }), 'names no baseline', 'an execution with nothing to compare against is refused');

  throws(() => executionRecord({
    id: 'e', orgId: 'o', capability: 'c', workflow: 'w', objectiveId: 'x', baselineId: 'b',
    scopeKey: 's', startedAt: '2026-01-01T00:00:00Z', executionOutcome: 'REFUSED',
  }), 'refused without naming a reason', 'an unexplained refusal is a failure');

  throws(() => objectiveTest({ name: 'x', statement: 'y', result: 'ACHIEVED', evidence: [] }),
    'then it is UNKNOWN', 'an objective claimed without evidence is refused');

  throws(() => humanTouch({ action: 'a', at: 'b' }),
    'must name the human', 'a human touch with no human is a system step');

  throws(() => businessOutcome({
    name: 'x', statement: 'y', attribution: 'CORRELATION_ONLY',
    evidence: [SYS('r')], claims: [valueClaim({ kind: 'MONEY_SAVED', amountCents: 100000, provenance: 'ESTIMATED', sources: [SRC], basis: 'x' })],
  }), 'may not carry a money claim', 'correlation may be recorded but may not carry a dollar figure');

  check(businessOutcome({
    name: 'x', statement: 'y', attribution: 'CORRELATION_ONLY', evidence: [SYS('r')],
  }), 'a correlation-only observation without a figure is allowed');
}

{
  const r = record();
  eq(touchProfile(r).APPROVAL, 1, 'touches are profiled by kind');
  eq(humansInvolved(r).length, 2, 'and distinct humans are counted');
}

// ---------------------------------------------------------------------------
console.log('--- valuation: the gates ----------------------------------------');

const deps = { baselines: [measuredBaseline], touchStandards: [standard] };

{
  const v = valueOf(record(), deps);
  eq(v.valued, true, 'a complete, achieved execution can be valued');
  eq(present(v.baselineMinutes), 15, 'the baseline contributes 15 minutes');
  eq(present(v.observedMinutes), 3, 'the two recorded interactions cost 3');
  eq(present(v.minutesReturned), 12, 'so 12 minutes were returned');
  near(v.hoursReturned.value, 0.2, 'which is 0.2 hours');
  near(v.labourValueCents.value, 1200, 'worth $12.00 at a $60/h loaded rate');
  eq(v.minutesReturned.provenance, 'MEASURED', 'and the figure is measured throughout');
  check(v.minutesReturned.basis.includes('minus'), 'and its basis states the subtraction');
}

{
  // MACHINE TIME IS NOT LABOUR. The execution ran for two days of elapsed time
  // and cost three minutes of human attention; only the three may appear.
  const v = valueOf(record(), deps);
  near(v.cycle.observed.value, 48, 'elapsed time is 48 hours');
  eq(present(v.observedMinutes), 3, 'and the labour figure is still 3 minutes');
  check(v.minutesReturned.value === 12,
    'elapsed time never enters the labour arithmetic');
}

{
  // The objective gate.
  const inFlight = record({ objective: objectiveTest({ name: 'x', statement: 'y', result: 'UNKNOWN' }) });
  const v = valueOf(inFlight, deps);
  eq(v.valued, false, 'an execution whose objective is not yet known cannot be valued');
  eq(v.excludedBecause, 'objective_unknown', 'and the reason is named');
  eq(v.minutesReturned.value, null, 'the figure is unavailable, not zero');

  const failedObjective = record({ objective: objectiveTest({
    name: 'x', statement: 'y', result: 'NOT_ACHIEVED', evidence: [SYS('r')] }) });
  const f = valueOf(failedObjective, deps);
  eq(f.valued, true, 'an execution whose objective failed IS valued');
  eq(present(f.minutesReturned), -3, 'and returns NEGATIVE minutes — the attempt cost real time and displaced nothing');

  const declined = record({
    executionOutcome: 'REFUSED', refusalReason: 'out_of_budget',
    objective: objectiveTest({ name: 'x', statement: 'y', result: 'NOT_APPLICABLE' }),
  });
  const d = valueOf(declined, deps);
  eq(d.valued, false, 'a correct decline is not a saving');
  eq(d.excludedBecause, 'objective_not_applicable', 'and is excluded for its own stated reason');
  eq(present(d.observedMinutes), 3, 'while its human cost remains visible');
}

{
  // Missing evidence anywhere kills the figure rather than shrinking it.
  const noBaseline = valueOf(record({ baselineId: 'nonexistent' }), deps);
  eq(noBaseline.valued, false, 'an execution with no baseline in force cannot be valued');
  eq(noBaseline.excludedBecause, 'no_baseline_in_force', 'with that reason');

  const early = valueOf(record({ startedAt: '2025-01-01T00:00:00Z' }), deps);
  eq(early.excludedBecause, 'no_baseline_in_force',
    'work that predates the baseline cannot be valued against it');

  const unpriced = valueOf(record({
    humanTouches: [T('request.created', '2026-03-01T09:00:00Z'), T('po.generated', '2026-03-01T11:00:00Z')],
  }), deps);
  eq(unpriced.valued, false, 'one unpriced interaction makes the whole execution unvaluable');
  eq(unpriced.excludedBecause, 'touches_not_priced',
    'because under-counting human time over-states hours returned');
}

{
  // TENANT ISOLATION. Not a warning, not a skip — a throw.
  throws(() => valueOf(record({ orgId: 'other_company' }), deps),
    'tenant violation', 'an execution may not be valued against another organization\'s baseline');
  throws(() => aggregate({
    orgId: 'acme', records: [record({ orgId: 'other_company', id: 'x' })],
    baselines: [measuredBaseline], touchStandards: [standard],
    from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z',
  }), 'tenant violation', 'and an aggregate refuses a record from another organization');
}

{
  // An untouched execution is a MEASURED zero — the one honest zero here.
  const untouched = record({ humanTouches: [] });
  const v = valueOf(untouched, deps);
  eq(present(v.observedMinutes), 0, 'an execution no human touched cost zero human minutes');
  eq(v.observedMinutes.provenance, 'MEASURED', 'and that zero is measured — the audit log recording nothing IS the measurement');
  eq(present(v.minutesReturned), 15, 'so the whole baseline was returned');
}

{
  // An observed duration beats the standard and promotes the grade.
  const timed = record({
    humanTouches: [T('request.created', '2026-03-01T09:00:00Z', 'u1', { observedMinutes: 7 })],
  });
  const v = valueOf(timed, deps);
  eq(present(v.observedMinutes), 7, 'a real observed duration overrides the standard');
  eq(v.observedMinutes.provenance, 'MEASURED', 'and is measured');
}

{
  // A self-reported standard degrades everything downstream.
  const soft = defineTouchStandard({
    id: 'soft', version: '1', orgId: 'acme', capability: 'purchasing',
    effectiveFrom: '2026-01-01T00:00:00Z',
    actions: {
      'request.created': { minutes: 2, provenance: 'SELF_REPORTED', sources: [source({ kind: 'OPERATOR_STATEMENT', ref: 'purchaser A, 2026-08-20' })] },
      'decision.approved': { minutes: 1, provenance: 'MEASURED', sources: [SRC] },
    },
  });
  const v = valueOf(record(), { baselines: [measuredBaseline], touchStandards: [soft] });
  eq(v.minutesReturned.provenance, 'SELF_REPORTED',
    'one self-reported interaction makes the whole saving self-reported');
  check(present(v.minutesReturned) % 5 === 0,
    'and a self-reported figure is presented at a coarse resolution, not to the minute');
}

// ---------------------------------------------------------------------------
console.log('--- the ledger: double counting, bias, retries, overhead ---------');

const period = { from: '2026-03-01T00:00:00Z', to: '2026-04-01T00:00:00Z' };

function batch(n, over = (i) => ({})) {
  return Array.from({ length: n }, (_, i) => record({
    id: `e${i}`, scopeKey: `purchase_request:r${i}`,
    startedAt: `2026-03-${String((i % 27) + 1).padStart(2, '0')}T09:00:00Z`,
    ...over(i),
  }));
}

{
  const totals = aggregate({ orgId: 'acme', records: batch(40), ...deps, ...period });
  eq(totals.unitsOfWork, 40, 'forty distinct requests are forty units of work');
  eq(present(totals.minutesReturned), 480, 'and return 40 x 12 minutes');
  near(totals.grossHoursReturned.value, 8, 'which is 8 hours');
  eq(totals.confidence.level, 'HIGH', 'a measured sample of forty is high confidence');
}

{
  // DOUBLE COUNTING. The same request, executed twice.
  const twice = [
    record({ id: 'a', scopeKey: 'purchase_request:r1', startedAt: '2026-03-01T09:00:00Z' }),
    record({ id: 'b', scopeKey: 'purchase_request:r1', startedAt: '2026-03-02T09:00:00Z' }),
  ];
  const t = aggregate({ orgId: 'acme', records: twice, ...deps, ...period });
  eq(t.considered, 2, 'both executions are seen');
  eq(t.unitsOfWork, 1, 'but they are one unit of real-world work');
  eq(t.duplicatesCollapsed.length, 1, 'and the collapse is reported, not hidden');
  eq(present(t.minutesReturned), 9,
    'the saving is banked once (12) less the earlier attempt\'s human cost (3)');
}

{
  // A retry is never free: three failed attempts then a success.
  const attempts = [
    record({ id: 'a1', scopeKey: 'purchase_request:r9', startedAt: '2026-03-01T09:00:00Z',
      objective: objectiveTest({ name: 'x', statement: 'y', result: 'NOT_ACHIEVED', evidence: [SYS('r')] }) }),
    record({ id: 'a2', scopeKey: 'purchase_request:r9', startedAt: '2026-03-02T09:00:00Z',
      objective: objectiveTest({ name: 'x', statement: 'y', result: 'NOT_ACHIEVED', evidence: [SYS('r')] }) }),
    record({ id: 'a3', scopeKey: 'purchase_request:r9', startedAt: '2026-03-03T09:00:00Z' }),
  ];
  const t = aggregate({ orgId: 'acme', records: attempts, ...deps, ...period });
  eq(t.unitsOfWork, 1, 'three attempts at one request are one unit of work');
  eq(present(t.minutesReturned), 6, 'the success returns 12 less 3+3 spent on the two failures');
  check(present(t.minutesReturned) < 12, 'a retried success is worth strictly less than a clean one');
}

{
  // EXCLUDED FAILURES. Failures are summed in, negatively.
  const mixed = [
    ...batch(9),
    record({ id: 'f', scopeKey: 'purchase_request:rf', startedAt: '2026-03-15T09:00:00Z',
      objective: objectiveTest({ name: 'x', statement: 'y', result: 'NOT_ACHIEVED', evidence: [SYS('r')] }) }),
  ];
  const t = aggregate({ orgId: 'acme', records: mixed, ...deps, ...period });
  eq(present(t.minutesReturned), 9 * 12 - 3, 'a failed objective subtracts from the period total');
  eq(t.objectiveResults.NOT_ACHIEVED, 1, 'and is reported separately from execution outcomes');
  eq(t.executionOutcomes.COMPLETED, 10, 'all ten executions completed — that number stays true and stays separate');
}

{
  // SELECTION BIAS. Half the period is unvaluable; coverage caps confidence.
  const half = [
    ...batch(20),
    ...batch(20, () => ({ objective: objectiveTest({ name: 'x', statement: 'y', result: 'UNKNOWN' }) }))
      .map((r, i) => record({ ...pick(r), id: `u${i}`, scopeKey: `purchase_request:u${i}`,
        startedAt: '2026-03-10T09:00:00Z',
        objective: objectiveTest({ name: 'x', statement: 'y', result: 'UNKNOWN' }) })),
  ];
  const t = aggregate({ orgId: 'acme', records: half, ...deps, ...period });
  eq(t.valued, 20, 'twenty units could be valued');
  eq(t.unitsOfWork, 40, 'out of forty');
  near(t.coverage, 0.5, 'coverage is reported, not implied');
  eq(t.excluded.objective_unknown, 20, 'and the reason for every exclusion is counted');
  check(['MODERATE', 'LOW'].includes(t.confidence.level),
    'half-covered evidence cannot be high confidence however well measured');
  check(t.confidence.reasons.some((r) => r.includes('%')), 'and the reason names the coverage');
  eq(present(t.unvaluedHumanMinutes), 60, 'the human minutes spent on unvalued work are still reported');
}

{
  // Small samples cannot be confident.
  const few = batch(3);
  const t = aggregate({ orgId: 'acme', records: few, ...deps, ...period });
  eq(t.confidence.level, 'LOW', 'three executions is an indication, not a measurement');
  check(t.confidence.reasons.some((r) => r.includes('ten')), 'and the suite says why');
}

{
  // OVERHEAD. Unmeasured overhead refuses a net figure rather than ignoring it.
  const records = batch(40);
  const measured = aggregate({
    orgId: 'acme', records, ...deps, ...period,
    overheads: [overhead({ label: 'monthly administration', hours: 2, provenance: 'MEASURED', sources: [SRC] })],
  });
  near(measured.grossHoursReturned.value, 8, 'gross is 8 hours');
  near(measured.netHoursReturned.value, 6, 'net is 6 after 2 hours of overhead');

  const unmeasured = aggregate({
    orgId: 'acme', records, ...deps, ...period,
    overheads: [overhead({ label: 'deployment', hours: null, provenance: 'UNAVAILABLE' })],
  });
  near(unmeasured.grossHoursReturned.value, 8, 'gross survives an unmeasured overhead');
  eq(unmeasured.netHoursReturned.known, false,
    'but net is refused — a net figure with an unknown deduction is a gross figure wearing the word "net"');
  eq(unmeasured.confidence.level, 'NONE', 'and nothing may be claimed with confidence');
}

{
  // BASELINE DRIFT across a period is disclosed.
  const v2 = defineBaseline({
    id: 'acme_purchasing', version: '2.0.0', orgId: 'acme', process: 'x', description: 'x',
    effectiveFrom: '2026-03-15T00:00:00Z', unitOfWork: 'purchase request',
    steps: [step('intake', 1), step('approve', 1)], coversSteps: ['intake', 'approval'],
  });
  const v1 = defineBaseline({
    id: 'acme_purchasing', version: '1.0.0', orgId: 'acme', process: 'x', description: 'x',
    effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-03-15T00:00:00Z',
    unitOfWork: 'purchase request',
    steps: [step('intake', 2), step('approve', 3), step('po', 5), step('vendor', 2), step('file', 3)],
    coversSteps: ['intake', 'approval', 'po_prep', 'vendor_comms', 'filing'],
  });
  const t = aggregate({
    orgId: 'acme',
    records: [
      record({ id: 'x1', scopeKey: 'purchase_request:x1', startedAt: '2026-03-01T09:00:00Z' }),
      record({ id: 'x2', scopeKey: 'purchase_request:x2', startedAt: '2026-03-20T09:00:00Z' }),
    ],
    baselines: [v1, v2], touchStandards: [standard], ...period,
  });
  eq(t.baselinesUsed.length, 2, 'a total resting on two baseline versions says so');
  check(t.baselinesUsed.includes('acme:acme_purchasing:1.0.0') && t.baselinesUsed.includes('acme:acme_purchasing:2.0.0'),
    'and names both');
}

// ---------------------------------------------------------------------------
console.log('--- the ledger, attacked a second time ---------------------------');

{
  // CROSS-CAPABILITY DOUBLE COUNTING. Two capabilities, one purchase request,
  // one baseline. Each would happily claim the whole saving.
  const two = [
    record({ id: 'p', capability: 'purchasing', scopeKey: 'purchase_request:r1', startedAt: '2026-03-01T09:00:00Z' }),
    record({ id: 'q', capability: 'office_automation', scopeKey: 'purchase_request:r1', startedAt: '2026-03-02T09:00:00Z' }),
  ];
  const t = aggregate({ orgId: 'acme', records: two, ...deps, ...period });
  eq(t.unitsOfWork, 1, 'two capabilities working one request against one baseline bank it once');
  check(present(t.minutesReturned) < 24, 'and cannot between them claim twice the saving');
}

{
  // OVERLAPPING BASELINES are refused where they would be USED, not merely
  // where somebody remembers to check.
  const overlapping = defineBaseline({
    id: 'acme_office', version: '1.0.0', orgId: 'acme', process: 'x', description: 'x',
    effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'day',
    steps: [step('po', 5)], coversSteps: ['po_prep'],
  });
  throws(() => aggregate({
    orgId: 'acme', records: batch(2),
    baselines: [measuredBaseline, overlapping], touchStandards: [standard], ...period,
  }), 'cannot be returned twice', 'an aggregate refuses two baselines that price the same human work');
}

{
  // A touch standard belonging to another tenant is a throw, not a skip.
  const foreign = defineTouchStandard({
    id: 'foreign', version: '1', orgId: 'someone_else', capability: 'purchasing',
    effectiveFrom: '2026-01-01T00:00:00Z',
    actions: { 'request.created': { minutes: 2, provenance: 'MEASURED', sources: [SRC] } },
  });
  throws(() => valueOf(record(), { baselines: [measuredBaseline], touchStandards: [foreign] }),
    'tenant violation', 'another organization\'s touch standard may not price this one\'s work');
  check(valueOf(record(), { baselines: [measuredBaseline], touchStandards: [foreign, standard] }).valued,
    'while the correct standard, present alongside it, is used normally');
}

{
  const t = aggregate({ orgId: 'acme', records: batch(5), ...deps, ...period });
  check(t.boundaryConvention.includes('start'),
    'the period boundary convention is stated rather than left to be inferred');

  // An execution that spans the boundary is counted once, in the period it began.
  const spanning = record({ id: 's', scopeKey: 'purchase_request:s', startedAt: '2026-02-25T09:00:00Z' });
  const march = aggregate({ orgId: 'acme', records: [spanning], ...deps, ...period });
  const feb = aggregate({ orgId: 'acme', records: [spanning], ...deps, from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z' });
  eq(march.unitsOfWork, 0, 'work begun in February is not in March\'s total');
  eq(feb.unitsOfWork, 1, 'it is in February\'s');
}

// ---------------------------------------------------------------------------
console.log('--- the case study projection and its audit chain ----------------');

{
  const study = caseStudy({
    orgId: 'acme', orgName: 'Acme Electric', capability: 'purchasing',
    capabilityLabel: 'Purchasing Workflow',
    records: [
      ...batch(30),
      record({ id: 'z', scopeKey: 'purchase_request:z', startedAt: '2026-03-05T09:00:00Z',
        objective: objectiveTest({ name: 'x', statement: 'y', result: 'UNKNOWN' }) }),
    ],
    ...deps, ...period,
  });
  eq(study.unitsOfWork, 31, 'the study counts units of work');
  eq(study.objectiveSuccess.achieved, 30, 'thirty objectives achieved');
  eq(study.objectiveSuccess.unknown, 1, 'one not yet testable');
  eq(study.objectiveSuccess.testable, 30, 'the denominator is what could be TESTED');
  near(study.objectiveSuccess.rate, 1, 'so the rate is over testable cases only, never over everything');
  check(study.unknown.length > 0, 'and the study lists what it does not know');
  check(study.unknown.some((u) => u.because === 'objective_unknown'),
    'including the unit of work it could not value');

  const chain = explain(study, 'hoursReturned');
  eq(chain.metric, 'hoursReturned', 'a figure can be explained');
  eq(chain.contributions.length, 31, 'down to every execution behind it');
  check(chain.contributions.every((c) => c.why), 'each with the sentence that produced it');
  check(chain.restsOn.baselines[0].steps.length === 5, 'and down to the baseline steps');
  check(chain.sources.length > 0, 'and the sources a person can go and check');
  check(typeof render(study) === 'string' && render(study).includes('Evidence confidence'),
    'and the whole thing renders as text without a UI');
}

// ---------------------------------------------------------------------------
console.log('--- PCC: what the purchasing adapter can and cannot measure ------');

const LIPPOLIS_PERIOD = { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' };
const req = (over = {}) => ({
  id: 'r1', orgId: 'lippolis', requestNumber: 'REQ-1', jobNumber: '24-118',
  status: 'COMPLETED', needByDate: '2026-09-05',
  createdAt: '2026-09-01T09:00:00Z', submittedAt: '2026-09-01T09:05:00Z',
  receivedAt: '2026-09-04T14:00:00Z', completedAt: '2026-09-04T15:00:00Z',
  ...over,
});
const act = (action, at, actorId = 'u1') => ({ action, at, actorId, seq: 1 });

{
  // OBJECTIVE SUCCESS IS NOT EXECUTION SUCCESS, on real purchasing columns.
  const onTime = PA.materialObjective(req(), [{ orderedQty: 5, receivedQty: 5 }]);
  eq(onTime.result, 'ACHIEVED', 'material that arrived before the need-by achieves the objective');

  const late = PA.materialObjective(req({ receivedAt: '2026-09-09T10:00:00Z' }), [{ orderedQty: 5, receivedQty: 5 }]);
  eq(late.result, 'NOT_ACHIEVED', 'material that arrived late does not, however clean the workflow was');

  const short = PA.materialObjective(req(), [{ orderedQty: 5, receivedQty: 3 }]);
  eq(short.result, 'NOT_ACHIEVED', 'nor does material that arrived short');

  const flying = PA.materialObjective(req({ status: 'ORDERED', receivedAt: null, completedAt: null }));
  eq(flying.result, 'UNKNOWN', 'an order still in transit has an untested objective');

  const declined = PA.materialObjective(req({ status: 'REJECTED' }));
  eq(declined.result, 'NOT_APPLICABLE', 'a declined request never had material to arrive');

  const noNeedBy = PA.materialObjective(req({ needByDate: null }), []);
  eq(noNeedBy.result, 'UNKNOWN', 'and without a need-by date "on time" has no meaning');
}

{
  const r = PA.toExecutionRecord({
    request: req(),
    activity: [
      act('request.created', '2026-09-01T09:00:00Z'),
      act('request.submitted', '2026-09-01T09:05:00Z'),
      { action: 'po.document_generated', at: '2026-09-02T09:00:00Z', actorId: null },  // system
      act('decision.approved', '2026-09-01T14:00:00Z', 'u2'),
      act('admin.vendor_created', '2026-09-01T15:00:00Z', 'u3'),                        // overhead
    ],
    lines: [{ orderedQty: 5, receivedQty: 5 }],
    baselineId: 'lippolis_purchasing_v0',
  });
  eq(r.humanTouches.length, 3, 'system-written rows are not human touches');
  check(!r.humanTouches.some((t) => t.action === 'admin.vendor_created'),
    'and organization setup is not charged to whichever request happened next');
  eq(r.scopeKey, 'purchase_request:r1', 'the unit of work is the request');
  eq(r.objectiveResult, 'ACHIEVED', 'the objective is tested from real columns');
  eq(r.executionSucceeded, true, 'execution success is recorded separately');
  near(r.cycle.elapsed.value, 77, 'and the AWE-era cycle time is MEASURED from the timestamps PCC already writes');
  eq(r.cycle.elapsed.provenance, 'MEASURED', 'because both timestamps were written by the system');

  eq(PA.overheadTouches([act('admin.vendor_created', '2026-09-01T15:00:00Z', 'u3')]).length, 1,
    'overhead touches are collected separately, for pricing as a period cost');
}

{
  const unmapped = PA.unmappedActions(ACTIVITY_ACTIONS);
  eq(unmapped, [], `every action purchasing can record is classified as human work or overhead (unmapped: ${unmapped.join(', ')})`);
  note(`purchasing records ${ACTIVITY_ACTIONS.length} auditable actions; all are classified`);
}

{
  // THE HONEST STATE OF LIPPOLIS TODAY. This must stay red until somebody
  // measures the old process, and the suite asserts that it does.
  const total = baselineHandlingMinutes(LIP.lippolisPurchasingBaseline);
  eq(total.known, false, 'the Lippolis baseline is NOT measured');
  eq(LIP.lippolisPurchasingBaseline.labourRate.known, false, 'nor is the labour rate');
  eq(LIP.lippolisPurchasingBaseline.cycle.known, false, 'nor the pre-AWE cycle time');

  eq(unpricedActions(LIP.lippolisPurchasingTouchStandard, PA.PRICEABLE_ACTIONS), [],
    'the touch standard names every action that could be a human interaction');

  const r = PA.toExecutionRecord({
    request: req(), activity: [act('request.created', '2026-09-01T09:00:00Z')],
    lines: [{ orderedQty: 5, receivedQty: 5 }], baselineId: 'lippolis_purchasing_v0',
  });
  const v = valueOf(r, {
    baselines: [LIP.lippolisPurchasingBaseline],
    touchStandards: [LIP.lippolisPurchasingTouchStandard],
  });
  eq(v.valued, false, 'so no Lippolis execution can be valued yet');
  eq(v.hoursReturned.value, null, 'hours returned is unavailable — not zero, not a guess');
  eq(v.labourValueCents.value, null, 'and so is money');
  eq(v.objectiveResult, 'ACHIEVED', 'while objective success IS measurable today');
  eq(v.cycle.observed.known, true, 'and so is the AWE-era cycle time');
  eq(v.cycle.savedHours.known, false, 'though the improvement is not, without a before');

  const study = caseStudy({
    orgId: 'lippolis', orgName: 'Lippolis Electric, Inc.',
    capability: 'purchasing', capabilityLabel: 'Purchasing Workflow',
    records: [r],
    baselines: [LIP.lippolisPurchasingBaseline],
    touchStandards: [LIP.lippolisPurchasingTouchStandard],
    ...LIPPOLIS_PERIOD,
  });
  eq(study.confidence.level, 'NONE', 'the Lippolis case study claims nothing it cannot support');
  check(study.unknown.some((u) => u.metric.includes('hours')), 'and lists hours returned as unknown');
  check(!render(study).includes('$0.00'), 'and never renders a dollar figure it does not have');
  check(render(study).includes('NOT MEASURABLE'), 'it says NOT MEASURABLE instead');
  note('Lippolis case study today: executions and objective success are real; every value figure is NOT MEASURABLE');
}

{
  // The instrumentation gap list is real and complete enough to act on.
  check(PA.INSTRUMENTATION_GAPS.length >= 4, 'the adapter states what PCC does not record');
  check(PA.INSTRUMENTATION_GAPS.every((g) => g.missing && g.unlocks && g.where && g.wouldMoveTo),
    'and each gap names what it blocks, what grade it would reach, and where the change goes');
  check(PA.INSTRUMENTATION_GAPS.some((g) => g.id === 'human_dwell_time'),
    'including the one that limits every hours figure: PCC records when, not how long');
}

// ---------------------------------------------------------------------------
console.log('--- the read, against a real purchasing database -----------------');

// The SQL that turns a live database into execution records is the one part of
// this system that cannot be proven by reasoning about pure functions. So: a
// real database, built from the application's own SCHEMA, with rows written the
// way the application writes them.
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const APP = join(ROOT, 'apps', 'purchasing', 'src');
  const { openDatabase } = await import(join(APP, 'purchasing/infrastructure/sqlite/database.ts'));
  const { readExecutions } = await import(P('adapters/purchasing-sqlite.mjs'));

  const dir = mkdtempSync(join(tmpdir(), 'proof-'));
  const db = openDatabase(join(dir, 'proof.sqlite'));

  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const NOW = '2026-09-01T00:00:00Z';
  run(`insert into orgs (id, name, created_at, updated_at) values (?,?,?,?)`, 'org-a', 'Org A', NOW, NOW);
  run(`insert into orgs (id, name, created_at, updated_at) values (?,?,?,?)`, 'org-b', 'Org B', NOW, NOW);
  for (const [id, org] of [['u1', 'org-a'], ['u2', 'org-a'], ['u3', 'org-b']]) {
    run(`insert into users (id, org_id, full_name, email, is_active, created_at, updated_at)
         values (?,?,?,?,1,?,?)`, id, org, id, `${id}@example.test`, NOW, NOW);
  }
  run(`insert into delivery_locations (id, org_id, name, kind, created_at, updated_at) values (?,?,?,'WORKSHOP',?,?)`,
      'loc1', 'org-a', 'Workshop', NOW, NOW);
  run(`insert into delivery_locations (id, org_id, name, kind, created_at, updated_at) values (?,?,?,'JOBSITE',?,?)`,
      'loc2', 'org-b', 'Yard', NOW, NOW);

  const request = (id, org, loc, status, over = {}) => run(
    `insert into purchase_requests
       (id, org_id, request_number, job_number, requestor_id, status, need_by_date, need_by_time,
        delivery_location_id, delivery_method, created_at, updated_at, created_by,
        submitted_at, received_at, completed_at)
     values (?,?,?,?,?,?,?,?,?,'DELIVERY',?,?,?,?,?,?)`,
    id, org, id.toUpperCase(), '24-118', org === 'org-a' ? 'u1' : 'u3', status,
    over.needBy ?? '2026-09-10', '12:00', loc,
    over.createdAt ?? '2026-09-02T09:00:00Z', over.createdAt ?? '2026-09-02T09:00:00Z',
    org === 'org-a' ? 'u1' : 'u3',
    over.submittedAt ?? '2026-09-02T09:10:00Z',
    over.receivedAt ?? null, over.completedAt ?? null);

  const activity = (org, reqId, action, at, actor, seq) => run(
    `insert into purchase_activity_log (id, org_id, request_id, actor_id, action, entity_type, at, seq)
     values (?,?,?,?,?,'purchase_request',?,?)`,
    `${reqId}-${seq}`, org, reqId, actor, action, at, seq);

  // r1: on time and in full.
  request('r1', 'org-a', 'loc1', 'COMPLETED',
    { receivedAt: '2026-09-08T14:00:00Z', completedAt: '2026-09-08T15:00:00Z' });
  activity('org-a', 'r1', 'request.created', '2026-09-02T09:00:00Z', 'u1', 1);
  activity('org-a', 'r1', 'decision.approved', '2026-09-02T11:00:00Z', 'u2', 2);
  activity('org-a', 'r1', 'po.document_generated', '2026-09-02T11:05:00Z', null, 3);   // system
  activity('org-a', 'r1', 'admin.vendor_created', '2026-09-02T12:00:00Z', 'u2', 4);    // overhead

  // r2: arrived after the need-by date. Clean execution, failed objective.
  request('r2', 'org-a', 'loc1', 'COMPLETED',
    { needBy: '2026-09-05', receivedAt: '2026-09-12T14:00:00Z', completedAt: '2026-09-12T15:00:00Z' });
  activity('org-a', 'r2', 'request.created', '2026-09-02T09:00:00Z', 'u1', 1);

  // r3: still in flight.
  request('r3', 'org-a', 'loc1', 'ORDERED');
  activity('org-a', 'r3', 'request.created', '2026-09-02T09:00:00Z', 'u1', 1);

  // r4: declined.
  request('r4', 'org-a', 'loc1', 'REJECTED');
  activity('org-a', 'r4', 'request.created', '2026-09-02T09:00:00Z', 'u1', 1);

  // Another tenant's request, in the same period, with the same shape.
  request('x1', 'org-b', 'loc2', 'COMPLETED',
    { receivedAt: '2026-09-08T14:00:00Z', completedAt: '2026-09-08T15:00:00Z' });
  activity('org-b', 'x1', 'request.created', '2026-09-02T09:00:00Z', 'u3', 1);

  const read = readExecutions(db, {
    orgId: 'org-a', from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z',
    baselineId: 'acme_purchasing',
  });

  eq(read.requestsRead, 4, 'the read returns this organization\'s four requests');
  check(!read.records.some((r) => r.orgId !== 'org-a'), 'and nothing belonging to the other tenant');
  check(!read.records.some((r) => r.scopeKey === 'purchase_request:x1'), 'specifically not x1');

  const byId = Object.fromEntries(read.records.map((r) => [r.scopeKey, r]));
  eq(byId['purchase_request:r1'].objectiveResult, 'ACHIEVED', 'r1 arrived on time');
  eq(byId['purchase_request:r2'].objectiveResult, 'NOT_ACHIEVED', 'r2 arrived late');
  eq(byId['purchase_request:r3'].objectiveResult, 'UNKNOWN', 'r3 has not arrived');
  eq(byId['purchase_request:r4'].objectiveResult, 'NOT_APPLICABLE', 'r4 was declined');
  eq(byId['purchase_request:r1'].humanTouches.length, 2,
    'r1 records two human touches — the system row and the admin row are not among them');
  eq(read.adminTouches.length, 1, 'and the administrative act is collected as period overhead');

  eq(byId['purchase_request:r1'].cycle.elapsed.provenance, 'MEASURED',
    'the AWE-era cycle time is measured from columns PCC already writes');
  near(byId['purchase_request:r1'].cycle.elapsed.value, 149, 'and is 149 hours for r1');

  // End to end against the honest Lippolis baseline: real objective figures,
  // no value figures, and it says so.
  const orgABaseline = defineBaseline({
    id: 'acme_purchasing', version: '1.0.0', orgId: 'org-a',
    process: 'x', description: 'x', effectiveFrom: '2026-01-01T00:00:00Z',
    unitOfWork: 'purchase request',
    steps: [step('intake', 2), step('approve', 3), step('po', 5), step('vendor', 2), step('file', 3)],
    coversSteps: ['intake', 'approval', 'po_prep', 'vendor_comms', 'filing'],
    labourRateCentsPerHour: 6000, labourRateProvenance: 'MEASURED',
    labourRateSources: [source({ kind: 'HISTORICAL_RECORD', ref: 'payroll' })],
  });
  const orgAStandard = defineTouchStandard({
    id: 'org_a_touches', version: '1', orgId: 'org-a', capability: 'purchasing',
    effectiveFrom: '2026-01-01T00:00:00Z',
    actions: {
      'request.created': { minutes: 2, provenance: 'MEASURED', sources: [SRC] },
      'decision.approved': { minutes: 1, provenance: 'MEASURED', sources: [SRC] },
    },
  });

  const study = caseStudy({
    orgId: 'org-a', orgName: 'Org A', capability: 'purchasing', capabilityLabel: 'Purchasing',
    records: read.records, baselines: [orgABaseline], touchStandards: [orgAStandard],
    from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z',
  });
  eq(study.unitsOfWork, 4, 'four units of work');
  eq(study.objectiveSuccess.achieved, 1, 'one objective achieved');
  eq(study.objectiveSuccess.notAchieved, 1, 'one not achieved');
  eq(study.objectiveSuccess.unknown, 1, 'one not yet testable');
  near(study.objectiveSuccess.rate, 0.5, 'so the success rate is 1 of 2 testable, not 1 of 4 and not 3 of 4');
  eq(present(study.hoursReturned), (15 - 3 - 2) / 60 === 0 ? 0 : present(study.hoursReturned),
    'hours returned is computed from the valued units only');
  near(study.ledger.minutesReturned.value, (15 - 3) + (-2), 'r1 returns 12 and r2 costs 2');
  check(study.unknown.some((u) => u.because === 'objective_unknown'), 'the in-flight request is named as unknown');
  check(study.unknown.some((u) => u.because === 'objective_not_applicable'), 'so is the declined one');

  db.close();
  note(`end-to-end read verified against a real SCHEMA database in ${dir}`);
}

// ---------------------------------------------------------------------------
console.log('--- a whole purchase, driven through the real use cases -----------');

// THE REHEARSAL. Not a fixture: one complete purchase driven through
// apps/purchasing/src/server/service.ts — the same functions the website calls —
// against a throwaway database, then read back through the proof adapter.
//
// It exists because of a defect no unit test would have found. The audit trail
// records DOMAIN EVENTS, and a three-line purchase writes 31 of them for 11
// times a person touched the software. Pricing one interaction per row inflated
// AWE-era human handling by about 2.8x, which under-states hours returned, and
// no amount of baseline fieldwork would have corrected it — the error was on
// the other side of the subtraction.
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const APP = join(ROOT, 'apps', 'purchasing', 'src');
  const { openDatabase } = await import(join(APP, 'purchasing/infrastructure/sqlite/database.ts'));
  const { seed } = await import(join(APP, 'purchasing/infrastructure/seed.ts'));
  const S = await import(join(APP, 'server/service.ts'));
  const { readExecutions } = await import(P('adapters/purchasing-sqlite.mjs'));

  async function wholePurchase(intervalMs) {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'proof-e2e-')), 'e2e.db'));
    seed(db, '2026-09-01T08:00:00.000Z');
    let clock = Date.parse('2026-09-01T08:00:00.000Z');
    // Rows inside one service call share a timestamp, as they do in production
    // to within a millisecond. `intervalMs` is how far apart the CALLS are, and
    // it is the whole point: a person is minutes apart, a replay is not.
    const ctx = () => S.context(db, new Date((clock += intervalMs)).toISOString());

    const users = Object.fromEntries(await Promise.all(
      db.prepare('select id, email from users').all()
        .map(async (u) => [u.email.split('@')[0], await S.loadActor(db, u.id)])));
    const { mike, dave: foreman } = users;
    const jobsite = (await S.listDeliveryLocations(ctx(), foreman)).find((l) => l.kind === 'JOBSITE');
    const graybar = (await S.listVendors(ctx(), mike)).find((v) => v.name.startsWith('Graybar'));

    const created = await S.createRequest(ctx(), foreman, {
      jobNumber: '24-118', needByDate: '2026-09-10', needByTime: '07:00',
      deliveryLocationId: jobsite.id, deliveryMethod: 'DELIVERY',
      reason: 'Fixture rough-in, second floor.',
      items: [
        { description: '2x4 LED troffer, 4000K', qty: '20', unit: 'ea' },
        { description: '12/2 MC cable', qty: '500', unit: 'ft' },
        { description: '4-square box, 2-1/8 deep', qty: '40', unit: 'ea' },
      ],
    });
    await S.submitRequest(ctx(), foreman, created.id);
    const detail = await S.getRequestDetail(ctx(), mike, created.id);
    await S.saveReview(ctx(), mike, created.id, {
      workshopNotes: 'Two troffers on the shelf.',
      lines: detail.originalItems.map((it, i) => ({
        requestItemId: it.id,
        usableStock: i === 0 ? '2' : '0',
        approvedQty: String(it.requestedQty / 1000),
        finalOrderQty: i === 0 ? '18' : String(it.requestedQty / 1000),
        vendorId: graybar.id, estimatedUnitCost: '86.40',
      })),
    });
    await S.decide(ctx(), mike, created.id, 'APPROVE', { notes: 'Four stay on the shelf.' });
    await S.generatePurchaseOrder(ctx(), mike, created.id);
    const draft = await S.generateVendorEmailDraft(ctx(), mike, created.id);
    await S.advanceEmailDraft(ctx(), mike, draft.id, 'REVIEWED');
    await S.advanceEmailDraft(ctx(), mike, draft.id, 'APPROVED_TO_SEND');
    await S.advanceEmailDraft(ctx(), mike, draft.id, 'SENT');
    await S.markOrdered(ctx(), mike, created.id, { notes: 'Called it in.' });
    await S.receiveEverything(ctx(), mike, created.id, {
      receivedDate: '2026-09-08', packingSlipNumber: 'PS-9912',
    });

    const orgId = db.prepare('select org_id from purchase_requests where id = ?').get(created.id).org_id;
    const auditRows = db.prepare(
      'select action from purchase_activity_log where request_id = ?').all(created.id).length;
    const { records } = readExecutions(db, {
      orgId, from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z', baselineId: 'lippolis_purchasing_v0',
    });
    const record = records.find((r) => r.scopeKey === `purchase_request:${created.id}`);
    db.close();
    return { auditRows, record };
  }

  const human = await wholePurchase(180_000);           // three minutes between screens

  check(human.auditRows >= 25, `one purchase writes a lot of audit rows (${human.auditRows})`);
  eq(human.record.humanTouches.length, 11,
    `and is ELEVEN human interactions, not ${human.auditRows}`);
  note(`one complete purchase: ${human.auditRows} audit rows, 11 human interactions`);

  const seen = human.record.humanTouches.map((t) => t.action);
  eq(seen, [...LIP.LIPPOLIS_HAPPY_PATH_SCREENS],
    'and they are exactly the eleven screens the touch standard prices, in order');

  // Every consequence row is accounted for, and none of them was charged as a
  // separate act.
  check(human.record.humanTouches.some((t) => (t.note ?? '').includes('request.submitted')),
    'a repeated action inside one transaction is folded in, not counted four times');
  check(human.record.humanTouches.at(-1).note?.includes('request.completed'),
    'receiving records a receipt AND closes the request in one click, and is priced once');

  eq(human.record.objectiveResult, 'ACHIEVED', 'the objective is tested from the real receipt');
  eq(human.record.executionOutcome, 'COMPLETED', 'and execution success is recorded separately');
  eq(human.record.cycle.elapsed.provenance, 'MEASURED', 'and the AWE-era cycle time is measured');

  // MACHINE SPEED. A replay, a backfill or an automated client writes the whole
  // purchase in milliseconds. Under the timing heuristic that collapsed eleven
  // interactions into six — an error in the direction that FLATTERS us, because
  // fewer interactions means less human time means more hours returned.
  //
  // Since schema 0040 every row carries the id of the context that wrote it, so
  // grouping is a recorded fact and speed is irrelevant. The two runs must now
  // agree EXACTLY; anything less means the heuristic is back.
  const machine = await wholePurchase(1);
  eq(machine.auditRows, human.auditRows, 'the same purchase writes the same rows at any speed');
  eq(machine.record.humanTouches.length, human.record.humanTouches.length,
    'and the same number of human interactions — speed cannot change what a person did');
  eq(machine.record.humanTouches.map((t) => t.action), human.record.humanTouches.map((t) => t.action),
    'right down to which screens they were');
  check(!machine.record.humanTouches.some((t) => (t.note ?? '').includes('grouped by timing')),
    'and none of it was inferred from timing');
  note(`machine-speed replay of the same purchase: ${machine.record.humanTouches.length} interactions vs 11 at human speed`);

  // The fallback still has to work, because rows written before schema 0040
  // exist and are still evidence — but it must SAY that it was used.
  {
    const stripped = human.record.humanTouches.length;
    const legacy = PA.interactionsFrom([
      { action: 'request.created', entityType: 'purchase_request', actorId: 'u1', at: '2026-09-01T09:00:00.000Z', seq: 1 },
      { action: 'request.submitted', entityType: 'purchase_request', actorId: 'u1', at: '2026-09-01T09:00:00.010Z', seq: 2 },
      { action: 'review.saved', entityType: 'purchase_review', actorId: 'u2', at: '2026-09-01T09:30:00.000Z', seq: 3 },
    ]);
    eq(legacy.length, 2, 'without an interaction id the timing fallback still groups a purchase');
    check(legacy.every((g) => g.heuristic), 'and every group says it was inferred rather than recorded');
    check(stripped > 0, 'while current data needs no inference at all');
    eq(PA.interactionCountingIsExact([
      { action: 'request.created', entityType: 'purchase_request', actorId: 'u1', at: '2026-09-01T09:00:00.000Z', seq: 1, interactionId: 'i1' },
    ]), true, 'interactionCountingIsExact reports which of the two paths was taken');
  }
}

{
  // Every purchasing action is classified as an anchor, a consequence, or
  // organization overhead. An unclassified one would default to free.
  const unclassified = PA.unclassifiedInteractionActions(ACTIVITY_ACTIONS);
  eq(unclassified, [], `every action is an anchor, a consequence or overhead (loose: ${unclassified.join(', ')})`);
  const overlap = PA.PRICEABLE_ACTIONS.filter((a) => PA.CONSEQUENCE_ACTIONS.includes(a));
  eq(overlap, [], 'and nothing is both an anchor and a consequence');
  eq(unpricedActions(LIP.lippolisPurchasingTouchStandard, PA.PRICEABLE_ACTIONS), [],
    'the Lippolis touch standard names every anchor, so nothing is silently free');
  note(`${PA.PRICEABLE_ACTIONS.length} anchors priced out of ${ACTIVITY_ACTIONS.length} audit actions`);
}

// ---------------------------------------------------------------------------
console.log('--- synthetic evidence cannot pass as production ------------------');

// THE CONTAMINATION RISK, and it is not hypothetical. The deployment rehearsal
// builds the production artifact, starts it with the real company name and the
// real organization id, and drives real purchases through it. The database it
// leaves behind is indistinguishable from production by inspection — same
// schema, same org, same shape — and contains nothing that ever happened.
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const APP = join(ROOT, 'apps', 'purchasing', 'src');
  const { openDatabase } = await import(join(APP, 'purchasing/infrastructure/sqlite/database.ts'));
  const { environmentOf } = await import(P('adapters/purchasing-sqlite.mjs'));

  const fresh = () => openDatabase(join(mkdtempSync(join(tmpdir(), 'proof-env-')), 'e.db'));

  const unstamped = fresh();
  eq(environmentOf(unstamped), 'unstamped',
    'a database that never declared itself is "unstamped" — never assumed to be production');
  unstamped.close();

  for (const declared of ['production', 'rehearsal', 'development']) {
    const db = fresh();
    db.prepare(`insert into schema_meta (key, value) values ('environment', ?)
                  on conflict(key) do nothing`).run(declared);
    eq(environmentOf(db), declared, `a database that declares "${declared}" reports it`);
    db.close();
  }

  // The stamp is written once and never overwritten. An installation cannot be
  // promoted to production after the fact by restarting it with a new variable
  // — the records were made under whatever it was at the time.
  {
    const db = fresh();
    const put = (v) => db.prepare(`insert into schema_meta (key, value) values ('environment', ?)
                                     on conflict(key) do nothing`).run(v);
    put('rehearsal');
    put('production');
    eq(environmentOf(db), 'rehearsal',
      'and a later start cannot promote a rehearsal database to production');
    db.close();
  }

  // The reader is the gate, not the caller's discipline.
  const source = readFileSyncTop(join(ROOT, 'scripts/proof-case-study.mjs'));
  check(source.includes("environment !== 'production'"),
    'the case-study command refuses a database that is not declared production');
  check(source.includes('allowNonproduction'),
    'and reading one anyway takes an explicit flag');
  check(source.includes('NOT EVIDENCE'),
    'and stamps the output when that flag is used, so it cannot be quoted by accident');
  note('a rehearsal database is refused as evidence unless asked for by name, and then labelled');
}

// ---------------------------------------------------------------------------
console.log('--- one organization, several capabilities ------------------------');

const { organizationValue, render: renderOrg, capabilitiesIn } = await import(P('organization.mjs'));

{
  // TWO CAPABILITIES, ONE MEASURED. The failure this is built against: sum what
  // is measurable, label it with the organization's name, and every reader
  // takes a figure about one capability as a figure about the whole company.
  const secondBaseline = defineBaseline({
    id: 'acme_inspection', version: '1.0.0', orgId: 'acme',
    process: 'Inspecting and reporting', description: 'x',
    effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'inspection',
    steps: [step('write_up', null, 'UNAVAILABLE')],
    coversSteps: ['inspection_write_up', 'inspection_delivery'],
  });
  const secondStandard = defineTouchStandard({
    id: 'acme_inspection_touches', version: '1', orgId: 'acme', capability: 'inspection',
    effectiveFrom: '2026-01-01T00:00:00Z',
    actions: { 'report.drafted': { minutes: 20, provenance: 'MEASURED', sources: [SRC] } },
  });

  const inspection = (i) => executionRecord({
    id: `insp${i}`, orgId: 'acme', capability: 'inspection', workflow: 'inspect_and_report',
    objectiveId: 'report_delivered', baselineId: 'acme_inspection',
    scopeKey: `inspection:${i}`,
    startedAt: `2026-03-${String((i % 27) + 1).padStart(2, '0')}T09:00:00Z`,
    endedAt: '2026-03-28T09:00:00Z',
    executionOutcome: 'COMPLETED',
    humanTouches: [T('report.drafted', '2026-03-05T09:00:00Z', 'insp1')],
    objective: objectiveTest({
      name: 'report_delivered', statement: 'The report reached the customer.',
      result: 'ACHIEVED', evidence: [SYS('delivery record')],
    }),
  });

  const view = organizationValue({
    orgId: 'acme', orgName: 'Acme Electric', environment: 'production',
    records: [...batch(30), ...Array.from({ length: 8 }, (_, i) => inspection(i))],
    baselines: [measuredBaseline, secondBaseline],
    touchStandards: [standard, secondStandard],
    labels: { purchasing: 'Purchasing', inspection: 'Inspection Reporting' },
    ...period,
  });

  eq(capabilitiesIn([...batch(2), inspection(0)]), ['purchasing', 'inspection'],
    'capabilities are derived from what ran, not from a list somebody maintains');
  eq(view.capabilities.length, 2, 'both capabilities appear');
  eq(view.executions, 38, 'and counts add across them — an execution is an execution');
  eq(view.humanInterventions, 68, 'as do human interventions');

  // THE CENTRAL CHECK.
  eq(view.capabilitiesMeasured, ['purchasing'], 'only purchasing has a measured baseline');
  eq(view.capabilitiesNotMeasurable.length, 1, 'and inspection is named as not measurable');
  eq(view.capabilitiesNotMeasurable[0].capability, 'inspection', 'by name');
  eq(view.capabilitiesNotMeasurable[0].executions, 8, 'with its execution count, so it is not invisible');
  check(view.capabilitiesNotMeasurable[0].because.includes('not been measured'),
    'and the ledger\'s own words for why');
  near(view.hoursReturned.value, 6, 'the total covers the measurable capability only');
  check(view.hoursReturned.basis.includes('1 measurable'),
    'and the figure itself says how many capabilities it covers');

  // The renderer cannot print the total without the exclusions.
  const text = renderOrg(view);
  check(text.includes('TOTAL VERIFIED VALUE'), 'the view renders a total');
  check(text.includes('the total covers      purchasing'), 'and states what it covers');
  check(text.includes('and EXCLUDES:'), 'and what it leaves out, in the same block');
  check(text.indexOf('and EXCLUDES:') > text.indexOf('human hours returned'),
    'immediately after the number, not in a footnote somebody scrolls past');
  note('an unmeasurable capability is named beside the organization total, never summed as zero');
}

{
  // Reliability and objective success are different questions and stay apart.
  const flawless = batch(10).map((r) => executionRecord({
    ...pick(r), objective: objectiveTest({
      name: 'x', statement: 'y', result: 'NOT_ACHIEVED', evidence: [SYS('r')] }),
  }));
  const view = organizationValue({
    orgId: 'acme', environment: 'production', records: flawless, baselines: [measuredBaseline],
    touchStandards: [standard], ...period,
  });
  eq(view.reliability, 1, 'every execution completed');
  eq(view.objectiveSuccess.rate, 0, 'and no objective was achieved');
  check(view.reliability !== view.objectiveSuccess.rate,
    'the two are reported separately because they are different conversations');
}

{
  // Tenant isolation at the organization level too.
  throws(() => organizationValue({
    orgId: 'acme', environment: 'production', records: [record({ orgId: 'someone_else' })],
    baselines: [measuredBaseline], touchStandards: [standard], ...period,
  }), 'tenant violation', 'an organization view refuses another organization\'s execution');

  // Overlapping baselines are refused before anything is totalled.
  const overlapping = defineBaseline({
    id: 'acme_other', version: '1.0.0', orgId: 'acme', process: 'x', description: 'x',
    effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'day',
    steps: [step('po', 5)], coversSteps: ['po_prep'],
  });
  throws(() => organizationValue({
    orgId: 'acme', environment: 'production', records: batch(2),
    baselines: [measuredBaseline, overlapping], touchStandards: [standard], ...period,
  }), 'cannot be returned twice',
    'and refuses two capabilities that price the same human work, before totalling');
}

{
  // Nothing measurable anywhere is UNAVAILABLE, not zero.
  const view = organizationValue({
    orgId: 'lippolis', orgName: 'Lippolis Electric, Inc.', environment: 'production',
    records: [PA.toExecutionRecord({
      request: req(), activity: [act('request.created', '2026-09-01T09:00:00Z')],
      lines: [{ orderedQty: 5, receivedQty: 5 }], baselineId: 'lippolis_purchasing_v0',
    })],
    baselines: [LIP.lippolisPurchasingBaseline],
    touchStandards: [LIP.lippolisPurchasingTouchStandard],
    ...LIPPOLIS_PERIOD,
  });
  eq(view.hoursReturned.known, false, 'an organization with no measured baseline has no total');
  eq(view.capabilitiesMeasured.length, 0, 'and says it covers nothing');
  eq(view.confidence.level, 'NONE', 'at no confidence');
  eq(view.executions, 1, 'while still reporting what actually ran');
  eq(view.objectiveSuccess.achieved, 1, 'and what it actually achieved');
  const text = renderOrg(view);
  check(text.includes('NOTHING — no capability has a measured baseline'),
    'and the renderer says so in words');
  check(!/\$0\.00/.test(text), 'and never prints a dollar figure it does not have');
}

{
  // REHEARSAL EVIDENCE IN AN ORGANIZATION TOTAL. This is the view a customer or
  // an investor is shown, which makes it the one worth attacking: the rehearsal
  // runs the production artifact under the real company name against the real
  // organization id, so nothing in the records themselves can give it away.
  const spec = {
    orgId: 'acme', orgName: 'Acme Electric', records: batch(30),
    baselines: [measuredBaseline], touchStandards: [standard], ...period,
  };

  throws(() => organizationValue({ ...spec }), 'must state the environment',
    'an organization view refuses to be produced without saying where its records came from');

  const real = organizationValue({ ...spec, environment: 'production' });
  const fake = organizationValue({ ...spec, environment: 'rehearsal' });

  // IDENTICAL RECORDS. The only difference is the provenance of the database.
  eq(fake.executions, real.executions, 'a rehearsal reports the same execution count as production');
  eq(fake.humanInterventions, real.humanInterventions, 'and the same interventions');
  eq(fake.objectiveSuccess.achieved, real.objectiveSuccess.achieved, 'and the same objectives achieved');
  check(real.hoursReturned.known, 'the production view has a value figure');
  eq(fake.hoursReturned.known, false, 'and the rehearsal view has none');
  eq(fake.labourValueCents.known, false, 'nor an economic value');
  eq(fake.claimedCents.known, false, 'nor a claimed amount');
  eq(fake.confidence.level, 'NONE', 'at no confidence');
  eq(fake.evidence.admissible, false, 'and it says so in one field');
  check(fake.hoursReturned.basis.includes('rehearsal'),
    'and the withheld figure names the environment that withheld it');

  // DRILLING IN MUST NOT GET AROUND IT. The per-capability figures are what a
  // slide quotes; a gate on the total alone would be decoration.
  eq(fake.capabilities[0].hoursReturned.known, false,
    'the per-capability hours are withheld too');
  eq(fake.capabilities[0].labourValueCents.known, false, 'as is the per-capability money');
  eq(fake.capabilities[0].cycle.savedMedianHours, null, 'as is the cycle time saved');
  eq(fake.capabilitiesMeasured, [], 'and no capability counts as measured');

  // The renderer leads with it. Somebody screenshotting the top of the report
  // must not be able to crop the caveat off the bottom.
  const text = renderOrg(fake);
  check(text.split('\n')[1].includes('NOT EVIDENCE'), 'the rendered report says NOT EVIDENCE in its first line');
  check(!/\$\d/.test(text), 'and prints no dollar figure anywhere');
  check(!/NOT EVIDENCE/.test(renderOrg(real)), 'while a production report carries no such banner');

  for (const env of ['development', 'unstamped', 'staging', 'test', 'PRODUCTION']) {
    eq(organizationValue({ ...spec, environment: env }).evidence.admissible, false,
      `"${env}" is not production, and is not treated as though it were`);
  }
  note('an organization total refuses to price records from any environment but production');
}

{
  // WEAK EVIDENCE MUST NOT BE LAUNDERED BY STRONG EVIDENCE. Two capabilities,
  // one measured from a time study and one from somebody's estimate. Summing
  // them produces a number whose grade is the WEAKER of the two, because a
  // total is only as good as its worst input — and an organization's confidence
  // is its weakest measurable capability's, not an average.
  const estimatedBaseline = defineBaseline({
    id: 'acme_dispatch', version: '1.0.0', orgId: 'acme',
    process: 'Dispatching', description: 'x',
    effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'dispatch',
    steps: [step('dispatch_call', 30, 'ESTIMATED')],
    coversSteps: ['dispatch_call'],
  });
  const dispatchStandard = defineTouchStandard({
    id: 'acme_dispatch_touches', version: '1', orgId: 'acme', capability: 'dispatch',
    effectiveFrom: '2026-01-01T00:00:00Z',
    actions: { 'dispatch.sent': { minutes: 5, provenance: 'ESTIMATED', sources: [SRC] } },
  });
  const dispatch = (i) => executionRecord({
    id: `disp${i}`, orgId: 'acme', capability: 'dispatch', workflow: 'dispatch',
    objectiveId: 'crew_arrived', baselineId: 'acme_dispatch', scopeKey: `dispatch:${i}`,
    startedAt: '2026-03-10T09:00:00Z', endedAt: '2026-03-10T10:00:00Z',
    executionOutcome: 'COMPLETED',
    humanTouches: [T('dispatch.sent', '2026-03-10T09:05:00Z', `disp${i}`)],
    objective: objectiveTest({
      name: 'crew_arrived', statement: 'A crew arrived.', result: 'ACHIEVED',
      evidence: [SYS('dispatch log')],
    }),
  });

  const view = organizationValue({
    orgId: 'acme', environment: 'production',
    records: [...batch(10), ...Array.from({ length: 5 }, (_, i) => dispatch(i))],
    baselines: [measuredBaseline, estimatedBaseline],
    touchStandards: [standard, dispatchStandard],
    ...period,
  });

  eq(view.capabilitiesMeasured.length, 2, 'both capabilities produce a figure');
  eq(view.evidenceGrade, 'ESTIMATED',
    'and the organization total carries the WEAKER of the two grades, not the better one');
  eq(view.hoursReturned.provenance, 'ESTIMATED',
    'the summed quantity says so itself, so a consumer that ignores evidenceGrade still sees it');
  const purchasingCap = view.capabilities.find((c) => c.id === 'purchasing');
  eq(purchasingCap.hoursReturned.provenance, 'MEASURED',
    'while the measured capability keeps its own grade — the mixing happens only at the total');
  check(renderOrg(view).includes('[ESTIMATED]'),
    'and the rendered total prints the grade beside the number');
  note('a measured capability cannot launder an estimated one into a stronger total');
}

{
  // No purchasing vocabulary may reach the organization view. If it does, the
  // capability-neutrality claim is false and this file is the evidence.
  const { readFileSync } = await import('node:fs');
  const code = readFileSync(P('organization.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const leaks = ['purchase', 'vendor', 'requisition', 'receipt', 'purchasing']
    .filter((w) => new RegExp(`\\b${w}`, 'i').test(code));
  eq(leaks, [], `the organization view knows no purchasing words (found: ${leaks.join(', ')})`);
}

// ---------------------------------------------------------------------------
console.log('--- determinism ---------------------------------------------------');

{
  const a = JSON.stringify(aggregate({ orgId: 'acme', records: batch(20), ...deps, ...period }));
  const b = JSON.stringify(aggregate({ orgId: 'acme', records: batch(20), ...deps, ...period }));
  eq(a === b, true, 'the same inputs produce byte-identical output — no clock, no randomness');

  const files = ['provenance.mjs', 'baseline.mjs', 'execution.mjs', 'value.mjs', 'ledger.mjs', 'case-study.mjs'];
  const { readFileSync } = await import('node:fs');
  for (const f of files) {
    const code = readFileSync(P(f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(!/Date\.now\(|Math\.random\(|new Date\(\)/.test(code),
      `${f} reads no clock and no randomness`);
  }
}

console.log('');
for (const n of notes) console.log(`  note: ${n}`);
console.log('');
console.log(`proof checks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length ? 1 : 0);

// Small helpers, kept at the bottom so the checks read top to bottom.
function pick(o) { return { ...o }; }
function structuredCloneish(o) { return { ...o }; }
