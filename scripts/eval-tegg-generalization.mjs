// ---------------------------------------------------------------------------
// eval-tegg-generalization.mjs — is AWE's proof architecture capability-neutral,
// or is it purchasing's reporting code with a general-sounding name?
//
// THE CLAIM UNDER TEST. `proof/` was built while measuring one thing. A
// measurement layer that fits exactly one capability proves nothing about the
// next one, and the way to find out is not to read it — it is to feed it a
// capability it has never seen and see what breaks.
//
// TEGG is the falsification attempt, and it is a fair one: a different product,
// in a different language, in a different repository, sharing no code, no
// database and no vocabulary with purchasing. It is a read-only Python agent
// that signs in to the TEGG portal, reads a completed site visit and produces
// an ESA findings review.
//
// WHAT THIS SUITE PROVES, in order:
//
//   1. A TEGG run ledger already carries what an ExecutionRecord needs. Nothing
//      was added to TEGG.
//   2. Those records pass through `aggregate()` and `organizationValue()`
//      unmodified, beside purchasing records, in one organization view.
//   3. The honest answer that comes out is NOT MEASURABLE — and the suite
//      asserts that, because a generalization that produced numbers here would
//      have proved the opposite of what it claims.
//   4. The seam the exercise actually found: an empty human-touch list means
//      "measured zero" only for a capability whose audit trail records every
//      human action. TEGG's does not. Asserted by showing the number that
//      appears if the adapter lies about it.
//
// WHERE THE REAL LEDGERS ARE. TEGG lives in its own repository and its run
// ledgers carry a third party's customer names, agreement numbers and site
// names; none of that is copied here. The fixtures below are synthetic and
// match the real SHAPE, and when a TEGG workspace is present on the machine the
// suite reads the real ledgers too and says how many. Set TEGG_WORKSPACE to
// point at one; ~/TEGG/work is tried by default.
//
// Offline. No network, no portal, no Python.
//
//   node scripts/eval-tegg-generalization.mjs
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (f) => join(ROOT, 'proof', f);

const TEGG = await import(P('adapters/tegg.mjs'));
const { aggregate } = await import(P('ledger.mjs'));
const { organizationValue, render } = await import(P('organization.mjs'));
const { baselineStep, defineBaseline, defineTouchStandard } = await import(P('baseline.mjs'));
const { executionRecord, objectiveTest } = await import(P('execution.mjs'));
const { valueOf } = await import(P('value.mjs'));
const { source } = await import(P('provenance.mjs'));

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
const throws = (fn, needle, name) => {
  let m = null;
  try { fn(); } catch (e) { m = e.message; }
  if (m === null) return check(false, name, 'it was allowed');
  return check(m.toLowerCase().includes(needle.toLowerCase()), name, `threw: ${m}`);
};

const CAP = { capability: 'tegg_reporting', baselineId: 'lippolis_tegg_v0' };

// The real shape, verified against 29 ledgers in a TEGG workspace on
// 2026-08-31: every field this adapter reads was present in all of them.
const ledger = (over = {}) => ({
  schema_version: 1,
  run_id: 'visit-findings-20260731T184101+0000',
  operation: 'visit-findings',
  status: 'completed',
  started_at: '2026-07-31T18:41:01+00:00',
  updated_at: '2026-07-31T18:47:45+00:00',
  tenant: 'lippolis',
  integration: 'tegg-pro',
  environment: 'production',
  base_url: 'https://example.invalid',
  credential_source: 'environment: TEGG_USERNAME, TEGG_PASSWORD',
  steps: [
    { step: 'open_knowledge', at: '2026-07-31T18:41:01+00:00', detail: '', data: {} },
    { step: 'finish', at: '2026-07-31T18:47:45+00:00', detail: '', data: {} },
  ],
  step_names: ['open_knowledge', 'sign_in', 'finish'],
  resumes: 0,
  human_action_required: [],
  contradictions: [],
  corrected_knowledge: [],
  stale_knowledge: [],
  knowledge_used: [],
  external_changes: [],
  records: [],
  notes: [],
  visit: { identifier: 'T25-000', job_number: 'T25-000' },
  ...over,
});

// ---------------------------------------------------------------------------
console.log('--- a TEGG run already carries what an execution record needs ----');
{
  const r = TEGG.toExecutionRecord(ledger(), CAP);
  eq(r.id, 'visit-findings-20260731T184101+0000', 'the run id is the execution id');
  eq(r.orgId, 'lippolis', 'the tenant is the organization — no mapping table');
  eq(r.workflow, 'visit-findings', 'the operation is the workflow');
  eq(r.capability, 'tegg_reporting', 'the capability is the one the caller asked for');
  eq(r.startedAt, '2026-07-31T18:41:01+00:00', 'the run start is the execution start');
  eq(r.endedAt, '2026-07-31T18:47:45+00:00', 'and the last update is the end');
  eq(r.executionOutcome, 'COMPLETED', 'a completed run completed');
  eq(r.executionSucceeded, true, 'and the workflow succeeded');
  eq(r.meta.stepsVerified, 2, 'the verified steps come through for a reader tracing it');

  // TENANT IS NOT OPTIONAL AND NOT GUESSABLE.
  throws(() => TEGG.toExecutionRecord(ledger({ tenant: undefined }), CAP), 'names no tenant',
    'a ledger with no tenant is refused rather than defaulted to the only customer we have');
  throws(() => TEGG.toExecutionRecord(ledger(), { baselineId: 'x' }), 'needs the capability',
    'and the adapter will not invent a capability either');
  throws(() => TEGG.toExecutionRecord(ledger(), { capability: 'x' }), 'needs the baseline',
    'nor a baseline to measure against');
}

// ---------------------------------------------------------------------------
console.log('--- every run status maps to an outcome, or is refused ------------');
{
  eq(TEGG.toExecutionRecord(ledger({ status: 'completed' }), CAP).executionOutcome, 'COMPLETED', 'completed');
  eq(TEGG.toExecutionRecord(ledger({ status: 'interrupted' }), CAP).executionOutcome, 'ABANDONED',
    'an interrupted run is ABANDONED, not failed — nothing went wrong, the laptop closed');

  // ESCALATED IS A REFUSAL, AND THAT IS THE POINT OF TEGG'S DESIGN: the agent
  // stopped because the portal disagreed with what it believed, and said so
  // instead of retrying into a mess. Recording it as a failure would penalise
  // the behaviour we want.
  const escalated = TEGG.toExecutionRecord(ledger({
    status: 'escalated',
    human_action_required: ['no usable navigation knowledge exists for this tenant.'],
  }), CAP);
  eq(escalated.executionOutcome, 'REFUSED', 'an escalation is a refusal');
  check(escalated.refusalReason.includes('no usable navigation knowledge'),
    'and it carries the sentence TEGG actually wrote, unchanged');
  eq(escalated.executionSucceeded, false, 'a refusal did not succeed');

  const failed = TEGG.toExecutionRecord(ledger({ status: 'failed' }), CAP);
  eq(failed.executionOutcome, 'FAILED', 'a failed run failed');
  check(!!failed.errorCode, 'and carries an error code, because the model insists on one');

  eq(TEGG.toExecutionRecord(ledger({ status: 'running' }), CAP), null,
    'a run still going is not evidence yet, and is skipped rather than counted');

  throws(() => TEGG.toExecutionRecord(ledger({ status: 'partially_done' }), CAP), 'does not map',
    'a status this adapter does not know is refused — a status silently read as COMPLETED becomes a saving');
}

// ---------------------------------------------------------------------------
console.log('--- two runs against one site visit are one unit of work ----------');
{
  // A resume, a retry after an escalation, a second look: one visit, one unit
  // of real-world work. Keying on the visit is what stops a capability that had
  // to be run twice reporting twice the saving.
  eq(TEGG.scopeKeyFor(ledger({ visit: { identifier: 'T25-204' } })), 'visit:T25-204',
    'a visit-findings run is keyed on the visit');
  eq(TEGG.scopeKeyFor(ledger({ visit: undefined, run_id: 'documentation-read-1' })), 'run:documentation-read-1',
    'a run with no external subject is keyed on itself, rather than grouped by guesswork');

  const twice = [
    ledger({ run_id: 'a', status: 'escalated', human_action_required: ['stopped'], visit: { identifier: 'T25-9' } }),
    ledger({ run_id: 'b', started_at: '2026-07-31T19:00:00+00:00', visit: { identifier: 'T25-9' } }),
  ].map((l) => TEGG.toExecutionRecord(l, CAP));

  const led = aggregate({
    orgId: 'lippolis', capability: 'tegg_reporting', records: twice,
    baselines: [], touchStandards: [],
    from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z',
  });
  eq(led.considered, 2, 'both runs are considered');
  eq(led.unitsOfWork, 1, 'and they collapse to one unit of work');
  eq(led.duplicatesCollapsed.length, 1, 'the collapse is reported rather than silent');
  notes.push('two TEGG runs against one site visit bank once, through the ledger\'s existing rule');
}

// ---------------------------------------------------------------------------
console.log('--- the seam this exercise found: a partial human trail -----------');
{
  // TEGG's `human_action_required` is a list of SENTENCES. It records that a
  // person had to act; not which person, and not when. So the adapter emits no
  // touches AND says the trail is incomplete.
  const r = TEGG.toExecutionRecord(ledger({ human_action_required: ['somebody had to check the export'] }), CAP);
  eq(r.humanTouches.length, 0, 'the adapter invents no human touches');
  eq(r.humanTouchesComplete, false, 'and says the trail is not complete');
  eq(r.meta.humanActionsRequired, 1, 'while still reporting that one human action was required');

  // THE NUMBER THAT APPEARS IF IT LIES. Same record, same baseline, same touch
  // standard — the only difference is the claim about the trail.
  const baseline = defineBaseline({
    id: 'lippolis_tegg_v0', version: '1.0.0', orgId: 'lippolis',
    process: 'Producing an ESA findings review', description: 'x',
    effectiveFrom: '2026-01-01T00:00:00Z', unitOfWork: 'review',
    steps: [baselineStep({
      id: 'read_and_write_up', label: 'read_and_write_up', minutes: 240, provenance: 'MEASURED',
      sources: [source({ kind: 'OBSERVED_TIMING', ref: 'hypothetical time study, this suite only' })],
    })],
    coversSteps: ['esa_review'],
  });
  const standard = defineTouchStandard({
    id: 'tegg_touches', version: '1', orgId: 'lippolis', capability: 'tegg_reporting',
    effectiveFrom: '2026-01-01T00:00:00Z',
    actions: {},
  });
  const honest = valueOf(r, { baselines: [baseline], touchStandards: [standard] });
  const lying = valueOf(executionRecord({ ...pick(r), humanTouchesComplete: true }),
    { baselines: [baseline], touchStandards: [standard] });

  eq(honest.observedMinutes.known, false, 'an incomplete trail makes human minutes UNAVAILABLE');
  check(honest.observedMinutes.basis.includes('subset'),
    'and says why: the recorded interactions are a subset');
  eq(lying.observedMinutes.known, true, 'while claiming a complete trail reads the silence as zero');
  eq(lying.observedMinutes.value, 0, 'exactly zero human minutes');
  check(honest.excludedBecause === 'objective_unknown' || honest.excludedBecause === 'touches_not_priced',
    'so the honest record is excluded from valuation');
  notes.push('a capability that cannot see its own humans reports UNKNOWN minutes, not zero');
}

// ---------------------------------------------------------------------------
console.log('--- one organization, purchasing and TEGG, one view ---------------');
{
  const teggRecords = [
    ledger({ run_id: 't1', visit: { identifier: 'T25-1' } }),
    ledger({ run_id: 't2', visit: { identifier: 'T25-2' } }),
    ledger({ run_id: 't3', status: 'escalated', human_action_required: ['stopped'], visit: { identifier: 'T25-3' } }),
    ledger({ run_id: 't4', status: 'running', visit: { identifier: 'T25-4' } }),
  ];
  const { records, skipped, environment } = TEGG.readRuns(teggRecords, CAP);
  eq(records.length, 3, 'three finished runs become evidence');
  eq(skipped.length, 1, 'and the one still going is skipped');
  check(skipped[0].because.includes('has not finished'), 'with a reason a reader can act on');
  eq(environment, 'production', 'and the environment comes from the runs themselves');

  // MIXED ENVIRONMENTS ARE REFUSED, NOT RESOLVED. Picking a majority or
  // filtering silently would hide that somebody's evidence directory is mixed.
  throws(() => TEGG.readRuns([ledger(), ledger({ run_id: 'x', environment: 'rehearsal' })], CAP),
    'more than one environment',
    'a directory holding both production and rehearsal runs is refused');

  // A purchasing execution, built the way the purchasing adapter builds them.
  const purchasing = executionRecord({
    id: 'pr1', orgId: 'lippolis', capability: 'purchasing', workflow: 'request_to_receipt',
    objectiveId: 'material_arrived', baselineId: 'lippolis_purchasing_v0', scopeKey: 'request:1',
    startedAt: '2026-07-05T09:00:00+00:00', endedAt: '2026-07-06T09:00:00+00:00',
    executionOutcome: 'COMPLETED',
    objective: objectiveTest({
      name: 'material_arrived', statement: 'The material arrived.', result: 'ACHIEVED',
      evidence: [source({ kind: 'SYSTEM_RECORD', ref: 'receipt' })],
    }),
  });

  // THE WHOLE CLAIM, IN ONE CALL. Two capabilities, no capability-specific
  // argument, no branch inside organization.mjs.
  const view = organizationValue({
    orgId: 'lippolis', orgName: 'Lippolis Electric, Inc.', environment: 'production',
    records: [purchasing, ...records],
    baselines: [], touchStandards: [],
    labels: { purchasing: 'Purchasing', tegg_reporting: 'TEGG Reporting' },
    from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z',
  });

  eq(view.capabilities.map((c) => c.id), ['purchasing', 'tegg_reporting'],
    'both capabilities appear, derived from what ran');
  eq(view.executions, 4, 'and executions add across them');
  eq(view.capabilities.find((c) => c.id === 'tegg_reporting').executions, 3, 'three of them TEGG\'s');

  // RELIABILITY IS REAL AND MEASURABLE TODAY. It needs no baseline: it is a
  // count of what finished over what ran.
  const tegg = view.capabilities.find((c) => c.id === 'tegg_reporting');
  eq(tegg.reliability, 2 / 3, 'TEGG reliability is two completions in three units of work');
  eq(tegg.objectiveSuccess.testable, 0, 'and no objective is testable, because none is observed');

  // AND THE HONEST ANSWER TO THE VALUE QUESTION IS: NOT YET.
  eq(view.hoursReturned.known, false, 'no hours are claimed for either capability');
  eq(view.capabilitiesMeasured, [], 'nothing is measured');
  eq(view.capabilitiesNotMeasurable.length, 2, 'and both capabilities are named as not measurable');
  eq(view.confidence.level, 'NONE', 'at no confidence');
  const text = render(view);
  check(text.includes('NOTHING — no capability has a measured baseline'), 'the report says so in words');
  check(!/\$\d/.test(text), 'and prints no dollar figure it does not have');
  check(text.includes('TEGG Reporting'), 'while naming TEGG so it is not invisible');
  notes.push('TEGG passes through the existing boundary with an adapter and no change to the arithmetic');
}

// ---------------------------------------------------------------------------
console.log('--- the arithmetic learned no TEGG words -------------------------');
{
  // If the generalization required editing the core, it is not a
  // generalization. Same test the organization view already carries for
  // purchasing vocabulary, pointed the other way.
  const strip = (f) => readFileSync(P(f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['ledger.mjs', 'value.mjs', 'baseline.mjs', 'provenance.mjs', 'organization.mjs']) {
    const code = strip(f);
    const leaks = ['tegg', 'visit', 'esa', 'portal', 'findings', 'inspection']
      .filter((w) => new RegExp(`\\b${w}`, 'i').test(code));
    eq(leaks, [], `proof/${f} knows no TEGG words`);
  }
  // The adapter is where capability knowledge is allowed to live.
  const adapter = readFileSync(P('adapters/tegg.mjs'), 'utf8');
  check(/tegg/i.test(adapter), 'and the adapter is where TEGG vocabulary is allowed');
  check(!/purchase|vendor|requisition/i.test(strip('adapters/tegg.mjs')),
    'while knowing nothing about purchasing');
}

// ---------------------------------------------------------------------------
console.log('--- against the real ledgers, when a workspace is present ---------');
{
  const workspace = process.env.TEGG_WORKSPACE ?? join(homedir(), 'TEGG', 'work');
  const dir = join(workspace, 'operations');
  if (!existsSync(dir)) {
    notes.push(`no TEGG workspace at ${dir} — the synthetic fixtures above are all that ran`);
    console.log(`  --  skipped: no TEGG workspace at ${dir}`);
  } else {
    const real = readdirSync(dir)
      .map((d) => join(dir, d, 'state.json'))
      .filter((f) => existsSync(f))
      .map((f) => JSON.parse(readFileSync(f, 'utf8')));
    check(real.length > 0, `read ${real.length} real run ledger(s)`);

    // EVERY FIELD THE ADAPTER READS IS PRESENT IN EVERY REAL LEDGER. This is
    // the assertion that makes the synthetic fixtures above trustworthy.
    for (const field of ['run_id', 'operation', 'status', 'started_at', 'updated_at',
      'tenant', 'environment', 'steps', 'resumes', 'human_action_required']) {
      const missing = real.filter((l) => l[field] === undefined).map((l) => l.run_id);
      eq(missing, [], `every real ledger carries ${field}`);
    }

    // Every real status maps. A new one appearing is a finding, not a crash.
    const unmapped = [...new Set(real.map((l) => l.status))]
      .filter((s) => !TEGG.OUTCOME_FOR[s] && !TEGG.NOT_TERMINAL.includes(s));
    eq(unmapped, [], 'every status in the real workspace maps to an outcome');

    // TENANT ISOLATION, ON REAL DATA. The workspace holds more than one tenant.
    const byTenant = new Map();
    for (const l of real) byTenant.set(l.tenant, (byTenant.get(l.tenant) ?? 0) + 1);
    check(byTenant.size >= 1, `the workspace holds ${byTenant.size} tenant(s)`);
    if (byTenant.size > 1) {
      const [a] = [...byTenant.keys()];
      const mine = real.filter((l) => l.tenant === a);
      const theirs = real.filter((l) => l.tenant !== a);
      const { records } = TEGG.readRuns(mine, CAP);
      throws(() => organizationValue({
        orgId: a, environment: 'production',
        records: [...records, ...TEGG.readRuns(theirs, CAP).records],
        baselines: [], touchStandards: [],
        from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z',
      }), 'tenant violation',
        'a real second tenant\'s runs are refused by the organization view');
    }

    const production = real.filter((l) => l.environment === 'production');
    const { records, skipped } = TEGG.readRuns(
      production.filter((l) => l.tenant === 'lippolis'), CAP);
    check(records.length + skipped.length === production.filter((l) => l.tenant === 'lippolis').length,
      'every production run for the tenant is either evidence or explicitly skipped');
    notes.push(`real workspace: ${real.length} ledgers, ${records.length} became evidence, ${skipped.length} skipped as unfinished`);
  }
}

function pick(r) {
  return {
    id: r.id, orgId: r.orgId, capability: r.capability, workflow: r.workflow,
    objectiveId: r.objectiveId, baselineId: r.baselineId, scopeKey: r.scopeKey,
    startedAt: r.startedAt, endedAt: r.endedAt, executionOutcome: r.executionOutcome,
    refusalReason: r.refusalReason, errorCode: r.errorCode,
    humanTouches: [...r.humanTouches], retries: r.retries, objective: r.objective,
    outcomes: [...r.outcomes], cycle: r.cycle, meta: { ...r.meta },
  };
}

console.log('');
for (const n of notes) console.log(`  note: ${n}`);
console.log('');
console.log(`tegg generalization: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
