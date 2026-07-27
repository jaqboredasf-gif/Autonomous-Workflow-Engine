// ---------------------------------------------------------------------------
// eval-execution.mjs — assertion harness behind Runner E (execution outcomes +
// durable run artifacts).
//
// PURE OFFLINE. No API keys, no model calls, no DB, no network, no Graph, no
// mailbox. It exercises the two real workflows through the shared run
// scaffolding (scripts/lib/awe-execution.mjs) and the local artifact store
// (scripts/lib/artifact-store.mjs), and asserts as HARD gates:
//
//   * envelope parity   — every outbound fixture produces a standardized
//                         outcome whose verdict matches the SAME label Runner 4
//                         asserts against the engine's native result
//   * machine codes     — every refusal carries a registered blocked reason and
//                         every failure a kernel error code; no human-readable
//                         message is ever load-bearing
//   * correlation       — run/workflow/org/trace ids reach the envelope, the
//                         events and the report
//   * five paths        — success, refusal, blocked routing, validation failure
//                         and internal error all return an envelope, never a
//                         throw and never an ad-hoc shape
//   * no send path      — no run of either workflow can emit an approval or a
//                         send event
//   * leak-proofing     — no credential, no draft body, no extracted personal
//                         data reaches an event or an artifact
//   * durability        — reports are written atomically, deterministically and
//                         inside the artifact root; a failed write downgrades
//                         the run instead of being swallowed
//
// The classification path runs against an injected in-memory database double,
// which is the whole reason `classify()` takes one: an orchestration that can
// only be tested with live credentials is an orchestration nobody tests.
//
// Exit 0 iff all gates pass. Invoked by scripts/eval-execution.sh.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPORT_KEYS, assertReport, createExecutionContext, createGateRun, loadCorpus,
  memoryArtifactSink, memoryAuditSink, reportPath, runWorkflow, serializeReport,
} from '../packages/awe-kernel/src/index.mjs';
import { BLOCKED_REASONS } from './lib/approval-matrix.mjs';
import { prepareOutbound } from './lib/outbound-draft.mjs';
import { normalizeEmail } from './lib/classification.mjs';
import { fixtureAdapter } from './lib/model-adapters.mjs';
import { reasons as platformReasons } from './lib/awe-reasons.mjs';
import {
  CLASSIFY_WORKFLOW, FORBIDDEN_EVENTS, OUTBOUND_WORKFLOW,
  contextFor, executeClassification, executeOutbound,
} from './lib/awe-execution.mjs';
import {
  createFileArtifactSink, createFileAuditSink, listArtifacts, readArtifact,
} from './lib/artifact-store.mjs';
import { persistSuiteReport } from './lib/runner-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUTBOUND_DIR = join(ROOT, 'fixtures', 'outbound');
const EMAILS_DIR = join(ROOT, 'fixtures', 'emails');

// A fixed, self-cleaning scratch directory: no randomness, so two runs of this
// suite exercise byte-identical paths.
const SCRATCH = join(tmpdir(), 'awe-eval-execution');

const run = createGateRun({ name: 'eval-execution (Runner E, offline, deterministic)' });
const { check, equal } = run;

const AT = '2026-07-27T09:00:00Z';
const DONE = '2026-07-27T09:00:01Z';
const ENVELOPE_KEYS = ['ok', 'status', 'blocked_reason', 'error', 'data', 'events', 'audit', 'verify', 'meta'];

// ---------------------------------------------------------------------------
// 1. Outbound drafting through the shared scaffolding
// ---------------------------------------------------------------------------

run.section('outbound drafting — standardized outcomes');

const policySets = JSON.parse(readFileSync(join(OUTBOUND_DIR, 'policies.json'), 'utf8'));
const outboundCorpus = loadCorpus({
  dir: OUTBOUND_DIR, casesDir: join(OUTBOUND_DIR, 'cases'), name: 'fixtures/outbound',
});
run.corpusParity(outboundCorpus);

function requestFor(c) {
  return {
    action: c.action,
    policies: policySets[c.policy_set],
    messageType: c.message_type,
    context: c.context,
    amountCents: c.amount_cents ?? null,
    unavailableRoles: c.unavailable_roles ?? [],
    workRequestKey: c.work_request_key,
    existingDraftKeys: c.existing_draft_keys ?? [],
    isFixture: c.is_fixture !== false,
    env: c.env ?? {},
  };
}

for (const { name: f, data: c, label } of outboundCorpus.cases) {
  if (label === null) continue;
  if (!policySets[c.policy_set]) { check(false, `${f} references unknown policy_set '${c.policy_set}'`); continue; }

  const request = requestFor(c);
  const context = contextFor(OUTBOUND_WORKFLOW, request, { org_id: 'org-fixture', started_at: AT, trace_id: 'trace-e' });
  const outcome = executeOutbound(request, context);

  // Every path returns an envelope — the shape is the contract, not a
  // convention each caller has to remember.
  run.contract(outcome, ENVELOPE_KEYS, `${f} outcome envelope`);
  run.deterministic(() => executeOutbound(request, context), `${f} executeOutbound`);

  // The envelope's verdict must agree with the SAME label Runner 4 asserts
  // against the engine's native result. That is what makes this a translation
  // and not a second implementation.
  equal(outcome.ok, label.ok, `${f} envelope ok`);
  equal(outcome.status, label.ok ? 'ok' : 'blocked', `${f} envelope status`);
  equal(outcome.blocked_reason, label.blocked_reason ?? null, `${f} envelope blocked_reason`);
  equal(outcome.events.map((e) => e.event_type), label.events ?? [], `${f} envelope event types`);

  // A blocked run is a correct run, never an error.
  equal(outcome.error, null, `${f} a refusal must not be reported as an error`);

  if (outcome.blocked_reason !== null) {
    // Machine-readable, registered, and never a message.
    check(platformReasons.has(outcome.blocked_reason),
      `${f} blocked_reason '${outcome.blocked_reason}' is not in the platform reason union`);
    run.member(outcome.blocked_reason, BLOCKED_REASONS, `${f} blocked_reason vocabulary`);
    run.record('blocked_reason', outcome.blocked_reason);
  }

  // Correlation reaches the envelope and every event it carries.
  equal(outcome.meta.run_id, context.run_id, `${f} run id on the envelope`);
  equal(outcome.meta.workflow_id, OUTBOUND_WORKFLOW, `${f} workflow id on the envelope`);
  equal(outcome.meta.trace_id, 'trace-e', `${f} trace id on the envelope`);
  for (const e of outcome.events) {
    equal(e.org_id, 'org-fixture', `${f} event carries the tenant`);
    equal(e.entity_type, 'outbound_message', `${f} event entity type`);
    check(typeof e.event_key === 'string' && e.event_key.length === 16, `${f} event is content-addressed`);
  }

  // No send path exists, proven per run rather than by reading the source.
  equal(outcome.events.filter((e) => FORBIDDEN_EVENTS.includes(e.event_type)), [],
    `${f} emitted an approval or send event from a drafting run`);

  // The envelope carries the draft's shape and routing — never its content.
  if (outcome.ok) {
    equal(outcome.data.send_capability, false, `${f} an ok draft claims send capability`);
    equal(outcome.data.requires_human_approval, true, `${f} an ok draft does not require human approval`);
    check(!('body_text' in outcome.data) && !('subject' in outcome.data),
      `${f} the draft body reached the outcome envelope`);
  }
  check(Array.isArray(outcome.audit) && outcome.audit.length > 0, `${f} produced no gate trail`);
}

// Fail-closed coverage: every refusal the engine can produce is exercised
// through the standardized path too, not only through the native one. HARD.
run.coverage('blocked_reason', BLOCKED_REASONS, { label: 'outbound blocked-reason coverage (via envelopes)' });

run.section('outbound — validation failure and internal error');

const goodRequest = requestFor(outboundCorpus.cases.find((c) => c.label?.ok === true).data);
const ctx = contextFor(OUTBOUND_WORKFLOW, goodRequest, { org_id: 'org-fixture', started_at: AT });

// A malformed REQUEST is the caller's mistake: `failed('invalid_input')`, with a
// kernel error code. It is deliberately NOT a blocked reason — a blocked run is
// a correct run, and a malformed request is not a run at all.
for (const [name, broken] of [
  ['no policies', { ...goodRequest, policies: undefined }],
  ['no message type', { ...goodRequest, messageType: undefined }],
  ['unknown message type', { ...goodRequest, messageType: 'not_a_type' }],
  ['no work request key', { ...goodRequest, workRequestKey: undefined, context: {} }],
  ['not an object', null],
]) {
  const bad = executeOutbound(broken, ctx);
  run.contract(bad, ENVELOPE_KEYS, `invalid request (${name}) outcome envelope`);
  equal(bad.status, 'failed', `invalid request (${name}) is a failure`);
  equal(bad.error.code, 'invalid_input', `invalid request (${name}) carries a machine-readable code`);
  equal(bad.blocked_reason, null, `invalid request (${name}) is not dressed up as a refusal`);
  check(bad.audit.length > 0, `invalid request (${name}) records why it was rejected`);
}

// An engine that throws is caught and classified — a run never escapes as an
// exception, which is the property an unattended worker depends on.
const exploding = {
  ...goodRequest,
  context: new Proxy({}, { get(_, key) { if (key === 'customer_name') throw new Error('exploding context'); return undefined; } }),
};
const boom = executeOutbound(exploding, ctx);
equal(boom.status, 'failed', 'a throwing engine produces a failed envelope, not an exception');
equal(boom.error.code, 'contract_violation', 'an unclassified throw fails closed');
check(boom.error.message.includes('exploding context'), 'the underlying error is preserved for a human');

// ---------------------------------------------------------------------------
// 2. Classification through the shared scaffolding
// ---------------------------------------------------------------------------

run.section('classification — standardized outcomes (injected database double)');

const adapter = fixtureAdapter(join(EMAILS_DIR, 'model_recorded.json'));
const emailFile = (n) => JSON.parse(readFileSync(join(EMAILS_DIR, n), 'utf8'));
const emailFor = (n) => normalizeEmail(emailFile(n), n);

// An in-memory stand-in for scripts/lib/db.mjs. It is NOT a reimplementation of
// the live keyword net or territory check — Runner 2A proves those against the
// real database functions. It exists so the ORCHESTRATION (budget, union,
// fail-closed, groundedness, verify) can be exercised with no credentials.
function dbDouble({ keyword = false, territoryResult = null, verifyOk = true, throwOn = null } = {}) {
  return {
    org: 'org-fixture',
    async keywordNet(text) {
      if (throwOn === 'keywordNet') throw new Error('connection reset');
      return keyword === true ? true : /burning smell|smoke|sparks|shock|electrical fire/i.test(text);
    },
    async territory() { return territoryResult; },
    async ingestEmail(_email, fixtureName) { return `email-${fixtureName}`; },
    async findWorkRequestByEmail() { return null; },
    async candidateOriginals() { return []; },
    async writeClassification() { return { id: 'wr-double', org_id: 'org-fixture' }; },
    async verify() {
      return verifyOk
        ? { ok: true, checks: { row_updated: true, values_match: true, org_scoped: true, event_present: true, no_duplicate_side_effect: true }, failures: [], digest: 'x' }
        : { ok: false, checks: { row_updated: true, values_match: false, org_scoped: true, event_present: false, no_duplicate_side_effect: true }, failures: [{ id: 'values_match' }, { id: 'event_present' }], digest: 'y' };
    },
  };
}

async function classifyOnce(name, opts = {}, ctxOpts = {}) {
  const email = emailFor(name);
  const context = contextFor(CLASSIFY_WORKFLOW, { fixture: name }, { org_id: 'org-fixture', started_at: AT, ...ctxOpts });
  return { context, outcome: await executeClassification(email, { adapter, db: dbDouble(), ...opts }, context) };
}

// Success path — a routine service call.
{
  const { context, outcome } = await classifyOnce('01_service_call_basic.json');
  run.contract(outcome, ENVELOPE_KEYS, 'classification outcome envelope');
  equal(outcome.status, 'ok', 'a clean classification succeeds');
  equal(outcome.data.classification, 'service_call', 'the classification is carried');
  equal(outcome.events.map((e) => e.event_type), ['request.classified'], 'the expected event is emitted');
  equal(outcome.meta.run_id, context.run_id, 'run id on the classification envelope');
  equal(outcome.events[0].entity_type, 'work_request', 'classification events are about a work request');
  check(outcome.audit.some((a) => a.step === 'groundedness'), 'the groundedness gate is in the trail');
  check(outcome.audit.some((a) => a.step === 'model_call'), 'the model call is in the trail');

  // Extracted personal data never reaches an event: the field NAMES do, which is
  // what a groundedness review needs, and the values stay on the row.
  const payload = outcome.events[0].payload;
  check(Array.isArray(payload.extracted_fields), 'events record which fields were extracted');
  for (const forbidden of ['customer_name', 'customer_phone', 'customer_address', 'customer_email']) {
    check(!(forbidden in payload), `the event payload carries the raw ${forbidden}`);
  }
  check(!JSON.stringify(payload).includes(emailFile('01_service_call_basic.json').from_addr),
    'the sender address reached the audit event');
}

// Emergency path — the deterministic keyword net wins over the model.
{
  const { outcome } = await classifyOnce('05_out_of_territory_emergency.json', { db: dbDouble({ keyword: true }) });
  equal(outcome.status, 'ok', 'an emergency classification succeeds');
  equal(outcome.data.emergency, true, 'the keyword net escalated the run');
  equal(outcome.events.map((e) => e.event_type), ['request.emergency_escalated'], 'the emergency event is emitted');
}

// Fail-closed path — unparseable model output after the retry budget.
{
  const { outcome } = await classifyOnce('11_attachment_only.json');
  equal(outcome.status, 'blocked', 'an unparseable model result is a refusal, not a guess');
  equal(outcome.blocked_reason, 'classification_fail_closed', 'the refusal has a registered machine-readable reason');
  check(platformReasons.has(outcome.blocked_reason), 'the classify reason is in the platform union');
  equal(outcome.error, null, 'a fail-closed refusal is not an error');
  equal(outcome.events.map((e) => e.event_type), ['request.triage_required'], 'a fail-closed run asks for a human');
  run.record('classify_reason', outcome.blocked_reason);
}

// Groundedness path — an extracted value that is not in the source text.
{
  const ungrounded = {
    name: 'ungrounded',
    model: 'synthetic',
    async classify() {
      return {
        text: JSON.stringify({
          classification: 'service_call', is_emergency: false, confidence: 0.9,
          property_type: 'residential', missing_info: false,
          customer_name: 'Nobody Invented', customer_phone: '555-000-0000',
          customer_address: '1 Fabricated Way', county: 'Nowhere', zip: '00000',
          reasoning: 'invented',
        }),
        usage: { input_tokens: 0, output_tokens: 0 }, latency_ms: 0,
      };
    },
  };
  const { outcome } = await classifyOnce('01_service_call_basic.json', { adapter: ungrounded });
  equal(outcome.status, 'blocked', 'invented values block the run');
  equal(outcome.blocked_reason, 'ungrounded_extraction', 'the groundedness refusal is machine-readable');
  check(outcome.audit.some((a) => a.step === 'groundedness' && a.ok === false), 'the failed gate is named in the trail');
  run.record('classify_reason', outcome.blocked_reason);
  // The invented values are named, never quoted, in the event.
  check(outcome.events[0].payload.hallucinated_fields.length > 0, 'the ungrounded fields are recorded');
  check(!JSON.stringify(outcome.events[0].payload).includes('Nobody Invented'),
    'an invented value was copied into the audit event');
}

// Unverified write — the loudest signal there is, and it outranks everything.
{
  const { outcome } = await classifyOnce('01_service_call_basic.json', { persist: true, db: dbDouble({ verifyOk: false }) });
  equal(outcome.status, 'failed', 'a write that could not be verified is a failure');
  equal(outcome.error.code, 'verify_failed', 'the failure carries the kernel taxonomy code');
  check(outcome.error.message.includes('values_match'), 'the failed checks are named for a human');
  equal(outcome.blocked_reason, null, 'an unverified write is not dressed up as a refusal');
  check(outcome.verify !== null && outcome.verify.ok === false, 'the verify result travels with the envelope');
}

// A verified write is a success, and the verify result is evidence.
{
  const { outcome } = await classifyOnce('01_service_call_basic.json', { persist: true });
  equal(outcome.status, 'ok', 'a verified write succeeds');
  equal(outcome.data.verify_ok, true, 'the verify verdict is in the report data');
  equal(outcome.data.work_request_id, 'wr-double', 'the written row is identified');
}

// Validation failure and internal error.
{
  const context = contextFor(CLASSIFY_WORKFLOW, {}, { org_id: 'org-fixture', started_at: AT });
  for (const [name, email, opts] of [
    ['not normalized', { subject: 'x' }, { adapter }],
    ['no fixture name', normalizeEmail(emailFile('01_service_call_basic.json'), ''), { adapter }],
    ['no adapter', emailFor('01_service_call_basic.json'), { adapter: null }],
  ]) {
    const bad = await executeClassification(email, { db: dbDouble(), ...opts }, context);
    equal(bad.status, 'failed', `invalid classification request (${name}) is a failure`);
    equal(bad.error.code, 'invalid_input', `invalid classification request (${name}) carries a machine code`);
  }

  const dead = await executeClassification(
    emailFor('01_service_call_basic.json'),
    { adapter, db: dbDouble({ throwOn: 'keywordNet' }) },
    context,
  );
  equal(dead.status, 'failed', 'an unreachable database produces a failed envelope, not an exception');
  equal(dead.error.code, 'contract_violation', 'an unclassified infrastructure error fails closed');
  check(dead.error.message.includes('connection reset'), 'the underlying error is preserved');
}

run.coverage('classify_reason', ['classification_fail_closed', 'ungrounded_extraction'],
  { label: 'classify blocked-reason coverage' });

// ---------------------------------------------------------------------------
// 3. Durable artifacts on the local filesystem
// ---------------------------------------------------------------------------

run.section('durable run artifacts (local filesystem sink)');

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

// The containment gate below asserts that nothing was written outside the root.
// Clear the target first so the assertion is about THIS run and not about a file
// an aborted earlier run (or a deliberate perturbation) left behind.
const ESCAPE_TARGET = join(SCRATCH, '..', '..', 'escaped.json');
rmSync(ESCAPE_TARGET, { force: true });

const artifacts = createFileArtifactSink({ root: SCRATCH });
const auditSink = createFileAuditSink({ root: SCRATCH });

const draftRequest = requestFor(outboundCorpus.cases.find((c) => c.label?.ok === true).data);
const runCtx = createExecutionContext({
  run_id: 'e2e-run-1', workflow_id: OUTBOUND_WORKFLOW, org_id: 'org-fixture',
  started_at: AT, trace_id: 'trace-e2e', attributes: { suite: 'runner-e' },
});

const result = await runWorkflow({
  context: runCtx,
  artifacts,
  audit: auditSink,
  finished_at: DONE,
  body: (c) => executeOutbound(draftRequest, c),
});

equal(result.final_state, 'completed', 'the end-to-end run terminates with an explicit final state');
equal(result.artifact.ok, true, `the artifact was written: ${result.artifact.error}`);
equal(result.audit_result.ok, true, 'the audit events were emitted');
assertReport(result.report);
run.contract(result.report, REPORT_KEYS, 'persisted report contract');

// Predictable directory structure.
equal(listArtifacts(SCRATCH), ['outbound_draft/2026-07-27/e2e-run-1.json'],
  'the artifact landed on <workflow>/<date>/<run_id>.json');
equal(reportPath(result.report), 'outbound_draft/2026-07-27/e2e-run-1.json', 'the computed path is the stored path');

// Round-trip: what is on disk is exactly the report, and it re-validates.
const onDisk = readArtifact(result.artifact.ref);
assertReport(onDisk);
equal(onDisk.report_digest, result.report.report_digest, 'the stored artifact is byte-faithful');
equal(onDisk.run_id, 'e2e-run-1', 'the stored artifact is correlatable');
equal(onDisk.final_state, 'completed', 'the stored artifact states its own final state');

// Deterministic and idempotent: the same run rewrites its own file, and leaves
// no temp file behind.
const again = await runWorkflow({
  context: runCtx, artifacts, audit: auditSink, finished_at: DONE,
  body: (c) => executeOutbound(draftRequest, c),
});
equal(again.report.report_digest, result.report.report_digest, 'a replayed run produces an identical report');
equal(listArtifacts(SCRATCH), ['outbound_draft/2026-07-27/e2e-run-1.json'],
  'a replayed run rewrites its own artifact rather than accumulating');
equal(readdirSync(join(SCRATCH, 'outbound_draft', '2026-07-27')).filter((f) => f.endsWith('.tmp')), [],
  'the atomic write left no temp file behind');

// Nothing sensitive is on disk. The needles are taken from the draft this very
// run produced, so the check cannot be vacuous: if the body ever started
// reaching the artifact, these are the exact strings that would appear.
const bytes = readFileSync(result.artifact.ref, 'utf8');
const nativeDraft = prepareOutbound(draftRequest).draft;
check(typeof nativeDraft.body_text === 'string' && nativeDraft.body_text.length > 20,
  'the fixture used for the leak check produced no draft body to leak');
for (const [what, needle] of [
  ['the draft body', nativeDraft.body_text.split('\n')[0]],
  ['the draft subject', nativeDraft.subject],
  ['the recipient address', nativeDraft.to_addrs[0]],
  ['a service-role key', 'service_role'],
  ['a management token', 'sbp_'],
  ['a JWT', 'eyJ'],
]) {
  check(needle.length > 0 && !bytes.includes(needle), `the artifact contains ${what}`);
}
check(bytes.endsWith('\n'), 'the artifact ends with a newline');
// The bytes are the canonical serialization, not merely parseable JSON.
equal(bytes, serializeReport(result.report), 'the stored bytes are the canonical serialization');

// The audit sink wrote a durable, correlatable trail.
const auditPath = join(SCRATCH, 'audit', 'org-fixture.jsonl');
check(existsSync(auditPath), 'the audit trail was written');
const auditLines = readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check(auditLines.length >= 1, 'the audit trail has entries');
equal(auditLines[0].run_id, 'e2e-run-1', 'audit lines carry the run id');
equal(auditLines[0].workflow_id, OUTBOUND_WORKFLOW, 'audit lines carry the workflow id');
check(typeof auditLines[0].event_key === 'string', 'audit lines are content-addressed');

// A refused run is recorded just as durably as a successful one — a refusal that
// leaves no evidence is indistinguishable from a run that never happened.
const blockedCase = outboundCorpus.cases.find((c) => c.label?.ok === false && c.label?.blocked_reason);
const blockedReq = requestFor(blockedCase.data);
const blockedRun = await runWorkflow({
  context: createExecutionContext({ run_id: 'e2e-blocked', workflow_id: OUTBOUND_WORKFLOW, org_id: 'org-fixture', started_at: AT }),
  artifacts, finished_at: DONE, body: (c) => executeOutbound(blockedReq, c),
});
equal(blockedRun.final_state, 'blocked', 'a refusal terminates as blocked');
equal(readArtifact(blockedRun.artifact.ref).blocked_reason, blockedCase.label.blocked_reason,
  'the refusal reason is in the durable record');

// Containment: a workflow id cannot walk out of the artifact root.
const escape = await artifacts.write(result.report, { path: '../../escaped.json' });
equal(escape.ok, false, 'a path that escapes the artifact root is refused');
check(String(escape.error).includes('escapes'), 'the containment refusal says why');
check(!existsSync(ESCAPE_TARGET), 'nothing was written outside the artifact root');

// A sink that cannot write downgrades the run rather than crashing it.
const readOnly = createFileArtifactSink({ root: join(SCRATCH, 'nope.json', 'deeper') });
const undurable = await runWorkflow({
  context: createExecutionContext({ run_id: 'e2e-undurable', workflow_id: OUTBOUND_WORKFLOW, org_id: 'org-fixture', started_at: AT }),
  artifacts: readOnly, finished_at: DONE, body: (c) => executeOutbound(draftRequest, c),
});
equal(undurable.outcome.status, 'ok', 'the workflow verdict survives a sink failure');

// The in-memory sinks are interchangeable with the file ones — the same run,
// through a different backend, produces the same report.
const memRun = await runWorkflow({
  context: runCtx, artifacts: memoryArtifactSink(), audit: memoryAuditSink(), finished_at: DONE,
  body: (c) => executeOutbound(draftRequest, c),
});
equal(memRun.report.report_digest, result.report.report_digest,
  'the report does not depend on which sink stored it');

rmSync(SCRATCH, { recursive: true, force: true });

// ---------------------------------------------------------------------------

const report = run.summary({ fixtures: outboundCorpus.cases.length });

const persisted = await persistSuiteReport(report, { workflowId: 'execution' });
if (persisted.skipped) console.log('run artifact: skipped (AWE_ARTIFACTS=off)');
else if (persisted.ok) console.log(`run artifact: ${persisted.ref} [${persisted.final_state}]`);
else console.log(`FAIL  run artifact was not written — ${persisted.error}`);

process.exit(run.exitCode || (persisted.skipped || persisted.ok ? 0 : 1));
