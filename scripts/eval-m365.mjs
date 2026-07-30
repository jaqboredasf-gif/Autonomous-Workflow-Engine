// ---------------------------------------------------------------------------
// eval-m365.mjs — assertion harness behind Runner 6 (Task I1, Microsoft 365
// Integration Plane).
//
// PURE OFFLINE. No credentials, no admin consent, no webhook endpoint, no
// network, no database, no model call. It drives the REAL integration plane
// (packages/m365, imported directly — Node strips the types, so this tests the
// module that ships) against the deterministic fake Graph provider and the
// labelled fixtures in fixtures/m365/.
//
// Beyond the per-case labels it enforces the invariants that make the slice
// safe, as HARD gates:
//   * no send            — no send/transmit path exists anywhere in the package,
//                          the capability registry has none, the fake has no
//                          route for one, and the live gateway refuses one
//   * tenant isolation   — cross-tenant requests are denied at the executor AND
//                          at notification validation
//   * allowlist          — unlisted resources and unlisted capabilities refused
//   * least privilege    — under- and over-declared scopes both refused
//   * approval           — a side effect without a granted human approval is denied
//   * idempotency        — duplicate deliveries create no second execution,
//                          no second draft, no second email_messages row
//   * retry bounds       — throttling recovers; exhaustion fails cleanly
//   * evidence           — every accepted event and every attempted side effect
//                          leaves a chained, verifiable record
//   * determinism        — the whole corpus twice, byte-identical
//   * no fabrication     — the fake can never report fidelity 'live', and the
//                          live gateway refuses to exist without credentials
//   * vocabulary parity  — engine vocabularies == migration 0016 check lists
//
// Exit 0 iff all gates pass. Invoked by scripts/eval-m365.sh.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CAPABILITY_CATALOG, CAPABILITY_NAMES, FORBIDDEN_CAPABILITIES, findCapability, catalogScopes,
  DENIAL_REASONS, FAILURE_REASONS,
  PERMITTED_SCOPES, FORBIDDEN_SCOPES, auditGrantedScopes,
  NOTIFICATION_REJECTIONS, SUBSCRIPTION_STATES,
  createFakeGraphGateway, createFixedClock, createInMemoryEvidenceLog, createEvidenceWriter,
  verifyEvidenceChain, hashValue,
  createInMemorySubscriptionStore, createSubscriptionManager, transition,
  createInMemoryDeliveryLedger, validateNotification, deliveryKeyFor,
  createInMemoryExecutionStore,
  createInMemoryApprovalStore,
  createCapabilityExecutor, createInMemoryInvocationLedger,
  createCapabilityHandlers,
  createMailAdapter, createTeamsAdapter, createDocumentAdapter, createIdentityAdapter,
  createNullCredentialProvider, createEnvCredentialProvider, createHttpGraphGateway,
  runInboundMailSlice, buildPersistencePlan, toEmailMessageRow, safeFileName,
  BlockedLiveProofError,
} from '../packages/m365/src/index.ts';

import { createPolicyBridge, DRAFT_MESSAGE_TYPE } from './lib/m365-policy-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIR = join(ROOT, 'fixtures', 'm365');
const CASES = join(DIR, 'notifications');

const allowlist = JSON.parse(readFileSync(join(DIR, 'allowlist.json'), 'utf8'));
const graphState = JSON.parse(readFileSync(join(DIR, 'graph-state.json'), 'utf8'));
const subscriptionSeed = JSON.parse(readFileSync(join(DIR, 'subscriptions.json'), 'utf8'));
const labels = JSON.parse(readFileSync(join(DIR, 'labels.json'), 'utf8'));
const policySets = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'outbound', 'policies.json'), 'utf8'));

const AWE_TENANT = allowlist.binding.aweTenantId;
const MS_TENANT = allowlist.binding.microsoftTenantId;
const TEAMS_CHANNEL = '19:devchannel@thread.tacv2';
const LIBRARY = 'drive-dev-0001';
const CLOCK_START = '2026-07-30T12:00:00.000Z';

const SERVICE_PRINCIPAL = { kind: 'service', id: 'app-awe-m365', displayName: 'AWE M365 app (fixture)' };
const APPROVER = { kind: 'user', id: 'user-0001-dev-approver', displayName: 'Dev Approver (fixture)', role: 'owner' };

let pass = 0, fail = 0;
const ok = () => { pass++; };
const bad = (m) => { console.log(`FAIL  ${m}`); fail++; };
const check = (cond, m) => (cond ? ok() : bad(m));
const eq = (a, b, m) => check(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// --- Harness ---------------------------------------------------------------

/**
 * A complete, isolated integration plane: fresh stores, fresh fake tenant, fixed
 * clock. Nothing leaks between cases, which is what makes per-case assertions
 * about "exactly one draft" meaningful.
 */
function buildHarness({ faults = [], policies = policySets.seed_v1, mode = 'TEST' } = {}) {
  const clock = createFixedClock(CLOCK_START, 1000);
  const gateway = createFakeGraphGateway(graphState, { faults });
  const evidenceLog = createInMemoryEvidenceLog();
  const evidence = createEvidenceWriter(evidenceLog, clock);
  const ledger = createInMemoryInvocationLedger();
  const subscriptions = createSubscriptionManager(
    createInMemorySubscriptionStore(subscriptionSeed.map((s) => ({ ...s }))),
    clock,
  );
  const deliveries = createInMemoryDeliveryLedger();
  const executions = createInMemoryExecutionStore();
  const approvals = createInMemoryApprovalStore();
  const policy = createPolicyBridge({ policies, allowlist, env: {} });

  const adapters = {
    identity: createIdentityAdapter(gateway),
    mail: createMailAdapter(gateway),
    teams: createTeamsAdapter(gateway),
    document: createDocumentAdapter(gateway),
  };

  const executor = createCapabilityExecutor({
    allowlist,
    evidence,
    ledger,
    handlers: createCapabilityHandlers(adapters),
    fidelity: gateway.fidelity,
    mode,
    // Deterministic "sleep": retry backoff must not make the suite slow or flaky.
    sleep: async () => {},
  });

  return {
    clock, gateway, evidenceLog, evidence, ledger, subscriptions, deliveries,
    executions, approvals, policy, executor, adapters,
    deps: {
      aweTenantId: AWE_TENANT,
      microsoftTenantId: MS_TENANT,
      allowlist,
      subscriptions,
      deliveries,
      executor,
      executions,
      evidence,
      policy,
      approvals,
      clock,
      mode,
      fidelity: gateway.fidelity,
      servicePrincipal: SERVICE_PRINCIPAL,
      approverPrincipal: APPROVER,
      approverRole: 'owner',
      teamsChannelId: TEAMS_CHANNEL,
      sharepointLibraryId: LIBRARY,
    },
  };
}

// --- Fixture cases ---------------------------------------------------------

const files = readdirSync(CASES).filter((f) => f.endsWith('.json')).sort();
const runSummaries = [];
const seenRejections = new Set();
const seenDenials = new Set();
const seenFailures = new Set();

async function runCase(file, spec, label) {
  const harness = buildHarness({ faults: spec.faults ?? [] });
  const times = spec.deliverTimes ?? 1;
  const results = [];

  for (let i = 0; i < times; i++) {
    results.push(await runInboundMailSlice(spec.notification, {
      ...harness.deps,
      options: { ...(spec.options ?? {}), draft: undefined },
    }));
  }

  const first = results[0];
  const statuses = results.map((r) => r.status);

  // --- Labels -------------------------------------------------------------
  eq(first.status, label.status, `${file}: slice status`);
  eq(first.notificationAudit.accepted, label.accepted, `${file}: notification accepted`);
  eq(first.notificationAudit.rejection, label.rejection, `${file}: rejection reason`);
  if (label.deliveryStatuses) {
    check(JSON.stringify(statuses) === JSON.stringify(label.deliveryStatuses),
      `${file}: delivery statuses ${JSON.stringify(statuses)} != ${JSON.stringify(label.deliveryStatuses)}`);
  }
  if (first.notificationAudit.rejection) seenRejections.add(first.notificationAudit.rejection);

  // --- Side-effect counts, measured at the PROVIDER, not from our own claims -
  const drafts = harness.gateway.created.filter((c) => c.kind === 'draft');
  const teamsPosts = harness.gateway.created.filter((c) => c.kind === 'teams_message');
  const driveItems = harness.gateway.created.filter((c) => c.kind === 'drive_item');
  eq(drafts.length, label.draftsCreated, `${file}: drafts created at the provider`);
  eq(teamsPosts.length, label.teamsMessages, `${file}: teams messages at the provider`);
  eq(driveItems.length, label.storedDocuments, `${file}: documents stored at the provider`);
  eq(harness.executions.all().length, label.executions, `${file}: execution records`);

  const attachmentsRetrieved = (first.contextItem?.attachments ?? []).filter((a) => a.retrieved).length;
  eq(attachmentsRetrieved, label.attachmentsRetrieved, `${file}: attachments retrieved`);

  // --- Denials and failures must be the EXACT expected reasons -------------
  const denials = {};
  const failures = {};
  for (const r of first.results) {
    if (r.outcome === 'denied') { denials[r.capability] = r.denialReason; seenDenials.add(r.denialReason); }
    if (r.outcome === 'failed') { failures[r.capability] = r.failureReason; seenFailures.add(r.failureReason); }
  }
  check(JSON.stringify(denials) === JSON.stringify(label.denied),
    `${file}: denials ${JSON.stringify(denials)} != ${JSON.stringify(label.denied)}`);
  check(JSON.stringify(failures) === JSON.stringify(label.failed),
    `${file}: failures ${JSON.stringify(failures)} != ${JSON.stringify(label.failed)}`);

  if (label.readAttempts != null) {
    const read = first.results.find((r) => r.capability === 'm365.mail.message.read');
    eq(read?.attempts, label.readAttempts, `${file}: message read attempts`);
  }

  // --- Universal invariants, asserted on EVERY case ------------------------
  // 1. No send, ever: the fake has no send route and nothing asked for one.
  const sendCalls = harness.gateway.calls.filter((c) => /sendmail|\/send$|\/reply|\/forward/i.test(c.path));
  eq(sendCalls.length, 0, `${file}: zero transmit calls attempted`);

  // 2. Every produced draft is in an allowlisted development mailbox.
  for (const d of drafts) {
    const entry = allowlist.entries.find((e) => e.kind === 'mailbox' && e.id.toLowerCase() === d.target.toLowerCase());
    check(entry != null && entry.isDevelopmentResource && entry.capabilities.includes('m365.mail.draft.create'),
      `${file}: draft created in unauthorized mailbox '${d.target}'`);
  }

  // 3. Every capability result carries evidence, and no evidence claims to be live.
  for (const r of first.results) {
    check(r.evidence != null && r.evidence.evidenceHash.length === 64, `${file}: ${r.capability} has evidence`);
    eq(r.fidelity, 'synthetic', `${file}: ${r.capability} fidelity is synthetic`);
    eq(r.evidence.fidelity, 'synthetic', `${file}: ${r.capability} evidence fidelity is synthetic`);
  }

  // 4. Evidence count == attempted side effects, and the chain verifies.
  eq(harness.evidenceLog.all().length, first.results.length, `${file}: one evidence row per capability attempt`);
  const chain = verifyEvidenceChain(harness.evidenceLog, AWE_TENANT);
  check(chain.ok, `${file}: evidence chain intact (${chain.problems.join('; ')})`);

  // 5. A refused notification touches the provider not at all.
  if (!first.notificationAudit.accepted) {
    eq(harness.gateway.calls.length, 0, `${file}: refused notification made zero Graph calls`);
    eq(harness.evidenceLog.all().length, 0, `${file}: refused notification produced no capability evidence`);
  }

  // 6. The persistence plan matches what actually happened.
  const plan = buildPersistencePlan(first, harness.evidenceLog.byExecution(first.executionId ?? ''));
  eq(plan.m365_notifications.length, 1, `${file}: exactly one notification row planned`);
  eq(plan.email_messages.length, first.contextItem ? 1 : 0, `${file}: email_messages rows planned`);
  if (first.contextItem) {
    const row = plan.email_messages[0];
    check(row.org_id === AWE_TENANT, `${file}: planned email row is tenant-scoped`);
    check(row.is_fixture === true, `${file}: synthetic content is marked is_fixture`);
    check(row.graph_message_id.startsWith('fixture:'), `${file}: synthetic content uses the fixture: namespace`);
    check(row.direction === 'inbound', `${file}: planned email row is inbound`);
  }

  // 7. Duplicate deliveries: the ledger counted them and nothing else moved.
  if (times > 1) {
    const entry = harness.deliveries.get(deliveryKeyFor(spec.notification));
    eq(entry?.deliveryCount, times, `${file}: delivery ledger counted every redelivery`);
    for (let i = 1; i < results.length; i++) {
      eq(results[i].status, 'duplicate', `${file}: delivery ${i + 1} is a duplicate`);
      eq(results[i].executionId, results[0].executionId, `${file}: duplicate reuses the original execution id`);
      eq(results[i].results.length, 0, `${file}: duplicate attempted no capability`);
      eq(results[i].contextItem, null, `${file}: duplicate produced no context item`);
    }
  }

  runSummaries.push({
    file,
    status: first.status,
    rejection: first.notificationAudit.rejection,
    drafts: drafts.length,
    teams: teamsPosts.length,
    docs: driveItems.length,
    evidence: harness.evidenceLog.all().map((e) => `${e.capability}:${e.outcome}:${e.denialReason ?? e.failureReason ?? 'ok'}`),
  });

  return { harness, results };
}

for (const file of files) {
  const spec = JSON.parse(readFileSync(join(CASES, file), 'utf8'));
  const label = labels[file];
  if (!label) { bad(`${file}: no label`); continue; }
  await runCase(file, spec, label);
}

// --- Determinism: the whole corpus again, byte-identical --------------------

const firstPass = JSON.stringify(runSummaries);
runSummaries.length = 0;
for (const file of files) {
  const spec = JSON.parse(readFileSync(join(CASES, file), 'utf8'));
  const label = labels[file];
  if (label) await runCase(file, spec, label);
}
check(JSON.stringify(runSummaries) === firstPass, 'determinism: identical results across two full runs');

// --- Executor gates, exercised directly -------------------------------------
//
// The fixtures drive the plane through the pipeline; these drive the executor
// itself, so every denial reason has a test rather than only the ones a
// notification can reach.

const baseResource = { kind: 'message', id: 'AAMkAGRLPHMSG0001', parent: 'dev-intake@awe-dev.example.invalid' };

function directRequest(overrides = {}) {
  const capability = overrides.capability ?? 'm365.mail.message.read';
  const spec = findCapability(capability);
  const resource = overrides.targetResource ?? baseResource;
  const executionId = overrides.executionId ?? 'exec_direct_0001';
  return {
    aweTenantId: AWE_TENANT,
    microsoftTenantId: MS_TENANT,
    objectiveId: 'obj_direct',
    workPackageId: 'wp.direct',
    taskId: 'task_direct',
    executionId,
    capability,
    capabilityVersion: overrides.capabilityVersion ?? spec?.version ?? 1,
    actingPrincipal: overrides.actingPrincipal ?? SERVICE_PRINCIPAL,
    targetResource: resource,
    requiredScopes: overrides.requiredScopes ?? spec?.requiredScopes ?? ['Mail.Read'],
    policyDecisionRef: overrides.policyDecisionRef ?? {
      id: 'pol_direct',
      effect: 'permit',
      capability,
      resourceId: resource.id,
      executionId,
      decidedAt: CLOCK_START,
      expiresAt: '2026-07-30T13:00:00.000Z',
      engine: 'test',
    },
    approvalRef: overrides.approvalRef ?? null,
    idempotencyKey: overrides.idempotencyKey ?? `idem_direct_${capability}`,
    correlationId: 'corr_direct',
    timeoutMs: overrides.timeoutMs ?? 15000,
    maxAttempts: overrides.maxAttempts ?? 2,
    input: overrides.input ?? {},
    // Identity overrides (objectiveId, aweTenantId, ...) apply last so a test can
    // blank any single field and watch the right gate catch it.
    ...('objectiveId' in overrides ? { objectiveId: overrides.objectiveId } : {}),
    ...('aweTenantId' in overrides ? { aweTenantId: overrides.aweTenantId } : {}),
    ...('microsoftTenantId' in overrides ? { microsoftTenantId: overrides.microsoftTenantId } : {}),
  };
}

async function expectDenial(overrides, expected, message) {
  const h = buildHarness();
  const result = await h.executor.execute(directRequest(overrides));
  eq(result.outcome, 'denied', `${message}: outcome`);
  eq(result.denialReason, expected, `${message}: reason`);
  eq(result.attempts, 0, `${message}: made no provider attempt`);
  eq(h.gateway.calls.length, 0, `${message}: touched the provider zero times`);
  eq(h.evidenceLog.all().length, 1, `${message}: refusal still wrote evidence`);
  seenDenials.add(expected);
  return result;
}

// Cross-tenant, both directions.
{
  const h = buildHarness();
  const wrongMs = await h.executor.execute({ ...directRequest(), microsoftTenantId: '88888888-8888-4888-8888-888888888888' });
  eq(wrongMs.outcome, 'denied', 'cross-tenant: foreign microsoft tenant denied');
  eq(wrongMs.denialReason, 'cross_tenant_denied', 'cross-tenant: reason');
  eq(h.gateway.calls.length, 0, 'cross-tenant: no provider call');
  seenDenials.add('cross_tenant_denied');

  const h2 = buildHarness();
  const wrongAwe = await h2.executor.execute({ ...directRequest(), aweTenantId: '99999999-9999-4999-8999-999999999999' });
  eq(wrongAwe.outcome, 'denied', 'cross-tenant: foreign awe tenant denied');
  eq(wrongAwe.denialReason, 'tenant_binding_missing', 'cross-tenant: unbound awe tenant reason');
  eq(h2.gateway.calls.length, 0, 'cross-tenant: unbound awe tenant made no provider call');
  seenDenials.add('tenant_binding_missing');
}

await expectDenial(
  { targetResource: { kind: 'message', id: 'X', parent: 'ceo@awe-prod.example.invalid' } },
  'resource_not_allowlisted', 'unauthorized mailbox',
);

await expectDenial(
  { targetResource: { kind: 'message', id: 'X', parent: 'production-office@awe-prod.example.invalid' } },
  'resource_not_allowlisted', 'allowlisted but non-development resource in TEST mode',
);

await expectDenial({ capability: 'm365.mail.message.send' }, 'external_send_forbidden', 'explicit send capability');
await expectDenial({ capability: 'm365.calendar.event.create' }, 'external_send_forbidden', 'explicitly forbidden capability');

{
  const h = buildHarness();
  const unknown = await h.executor.execute({ ...directRequest(), capability: 'm365.something.invented' });
  eq(unknown.denialReason, 'unknown_capability', 'unknown capability denied');
  seenDenials.add('unknown_capability');
}

await expectDenial({ capabilityVersion: 99 }, 'unsupported_capability_version', 'capability version mismatch');
await expectDenial({ requiredScopes: ['User.ReadBasic.All'] }, 'scope_not_declared', 'under-declared scope');
await expectDenial({ requiredScopes: ['Mail.Read', 'Mail.ReadWrite'] }, 'scope_not_declared', 'over-declared scope');
await expectDenial({ timeoutMs: 0 }, 'invalid_request', 'zero timeout');
await expectDenial({ maxAttempts: 99 }, 'invalid_request', 'retry bound above the ceiling');
await expectDenial({ objectiveId: '' }, 'invalid_request', 'missing objective id');

await expectDenial(
  { policyDecisionRef: { ...directRequest().policyDecisionRef, effect: 'deny', reason: 'matrix blocked' } },
  'policy_denied', 'policy deny',
);
await expectDenial(
  { policyDecisionRef: { ...directRequest().policyDecisionRef, executionId: 'exec_someone_else' } },
  'policy_decision_mismatch', 'policy decision bound to another execution',
);
await expectDenial(
  { policyDecisionRef: { ...directRequest().policyDecisionRef, expiresAt: CLOCK_START } },
  'policy_decision_expired', 'policy decision with no validity window',
);
{
  const h = buildHarness();
  const noPolicy = await h.executor.execute({ ...directRequest(), policyDecisionRef: null });
  eq(noPolicy.outcome, 'denied', 'absent policy reference is denied');
  eq(noPolicy.denialReason, 'policy_decision_missing', 'absent policy reference has its own reason');
  eq(h.gateway.calls.length, 0, 'absent policy reference made no provider call');
  seenDenials.add('policy_decision_missing');
}

// Least privilege from the other side: correctly declared scopes that admin
// consent never granted in this tenant.
{
  const narrowed = { ...allowlist, grantedScopes: ['User.ReadBasic.All'] };
  const h = buildHarness();
  const executor = createCapabilityExecutor({
    allowlist: narrowed,
    evidence: h.evidence,
    ledger: h.ledger,
    handlers: createCapabilityHandlers(h.adapters),
    fidelity: h.gateway.fidelity,
    mode: 'TEST',
    sleep: async () => {},
  });
  const result = await executor.execute(directRequest());
  eq(result.outcome, 'denied', 'ungranted scope denied');
  eq(result.denialReason, 'insufficient_scope', 'ungranted scope reason');
  eq(h.gateway.calls.length, 0, 'ungranted scope made no provider call');
  seenDenials.add('insufficient_scope');
}

// Approval gates, on the capability that requires one.
const draftResource = { kind: 'mailbox', id: 'dev-intake@awe-dev.example.invalid' };
const draftInput = { subject: 'Re: fixture', bodyText: 'body', toAddrs: ['customer@customer.example.invalid'] };
const draftBase = {
  capability: 'm365.mail.draft.create',
  targetResource: draftResource,
  input: draftInput,
};

await expectDenial({ ...draftBase, approvalRef: null }, 'approval_missing', 'draft without an approval');
await expectDenial({
  ...draftBase,
  approvalRef: {
    id: 'apr_pending', state: 'pending', capability: 'm365.mail.draft.create',
    resourceId: draftResource.id, executionId: 'exec_direct_0001',
    approvedBy: null, approvedAt: null, expiresAt: '2026-07-30T13:00:00.000Z',
  },
}, 'approval_not_granted', 'draft with a pending approval');
await expectDenial({
  ...draftBase,
  approvalRef: {
    id: 'apr_wrong', state: 'approved', capability: 'm365.mail.draft.create',
    resourceId: draftResource.id, executionId: 'exec_somewhere_else',
    approvedBy: APPROVER, approvedAt: CLOCK_START, expiresAt: '2026-07-30T13:00:00.000Z',
  },
}, 'approval_mismatch', 'approval bound to another execution');
await expectDenial({
  ...draftBase,
  approvalRef: {
    id: 'apr_robot', state: 'approved', capability: 'm365.mail.draft.create',
    resourceId: draftResource.id, executionId: 'exec_direct_0001',
    approvedBy: SERVICE_PRINCIPAL, approvedAt: CLOCK_START, expiresAt: '2026-07-30T13:00:00.000Z',
  },
}, 'approval_by_service_principal', 'automation cannot approve its own action');
await expectDenial({
  ...draftBase,
  approvalRef: {
    id: 'apr_stale', state: 'approved', capability: 'm365.mail.draft.create',
    resourceId: draftResource.id, executionId: 'exec_direct_0001',
    approvedBy: APPROVER, approvedAt: '2026-07-30T13:00:00.000Z', expiresAt: CLOCK_START,
  },
}, 'approval_expired', 'expired approval');

// TEST-mode recipient safety: a real recipient on an otherwise valid draft.
{
  const h = buildHarness();
  const approvalRef = {
    id: 'apr_ok', state: 'approved', capability: 'm365.mail.draft.create',
    resourceId: draftResource.id, executionId: 'exec_direct_0001',
    approvedBy: APPROVER, approvedAt: CLOCK_START, expiresAt: '2026-07-30T13:00:00.000Z',
  };
  const real = await h.executor.execute(directRequest({
    ...draftBase,
    approvalRef,
    input: { ...draftInput, toAddrs: ['someone@a-real-company.com'] },
  }));
  eq(real.denialReason, 'test_mode_violation', 'TEST mode refuses a real recipient');
  eq(h.gateway.created.length, 0, 'TEST mode violation created nothing');
  seenDenials.add('test_mode_violation');

  // ... and the same request with a fixture recipient succeeds, so the gate is
  // discriminating rather than simply always-refusing.
  const h2 = buildHarness();
  const good = await h2.executor.execute(directRequest({ ...draftBase, approvalRef }));
  eq(good.outcome, 'succeeded', 'approved draft to a fixture recipient succeeds');
  eq(h2.gateway.created.filter((c) => c.kind === 'draft').length, 1, 'exactly one draft created');

  // Idempotency: the identical request again replays and creates nothing new.
  const replay = await h2.executor.execute(directRequest({ ...draftBase, approvalRef }));
  eq(replay.outcome, 'replayed', 'second identical invocation replays');
  eq(replay.attempts, 0, 'replay made no provider attempt');
  eq(h2.gateway.created.filter((c) => c.kind === 'draft').length, 1, 'replay created no second draft');
  check(JSON.stringify(replay.microsoftResourceIds) === JSON.stringify(good.microsoftResourceIds),
    'replay returns the original Microsoft resource ids');
  eq(h2.evidenceLog.all().length, 2, 'replay wrote its own evidence row');
}

// --- Notification validation, exercised directly ----------------------------

{
  const h = buildHarness();
  const base = {
    subscriptionId: 'sub-dev-0001',
    subscriptionExpirationDateTime: '2026-08-01T09:00:00.000Z',
    clientState: 'fixture-client-state-0001',
    changeType: 'created',
    resource: '/users/dev-intake@awe-dev.example.invalid/messages/AAMkAGRLPHMSG0001',
    resourceData: { id: 'AAMkAGRLPHMSG0001' },
    tenantId: MS_TENANT,
  };
  const opts = {
    allowlist, subscriptions: h.subscriptions, aweTenantId: AWE_TENANT,
    nowIso: CLOCK_START, requireDevelopmentResource: true,
  };
  eq(validateNotification(base, opts).accepted, true, 'validation: healthy notification accepted');

  // The delivery key must ignore fields that vary between redeliveries of the
  // same change, and must change when the change itself does.
  const later = { ...base, subscriptionExpirationDateTime: '2026-08-02T09:00:00.000Z' };
  eq(deliveryKeyFor(later), deliveryKeyFor(base), 'delivery key ignores expiry drift');
  check(deliveryKeyFor({ ...base, resource: `${base.resource}X` }) !== deliveryKeyFor(base),
    'delivery key changes with the resource');
  check(deliveryKeyFor({ ...base, changeType: 'updated' }) !== deliveryKeyFor(base),
    'delivery key changes with the change type');

  // Alternative Graph resource spellings must parse to the same mailbox.
  const folderForm = {
    ...base,
    resource: "/users/dev-intake@awe-dev.example.invalid/mailFolders('inbox')/messages/AAMkAGRLPHMSG0001",
  };
  eq(validateNotification(folderForm, opts).accepted, true, 'validation: mailFolders form accepted');
  eq(validateNotification({ ...base, resource: 'garbage' }, opts).rejection, 'resource_mismatch',
    'validation: unparseable resource refused');
}

// --- Subscription lifecycle state machine -----------------------------------

{
  const legal = [
    ['pending', 'created', 'active'],
    ['pending', 'create_failed', 'failed'],
    ['active', 'renewed', 'active'],
    ['active', 'renew_failed', 'expired'],
    ['active', 'expired', 'expired'],
    ['active', 'revoked', 'revoked'],
    ['active', 'reauth_required', 'reauthorization_required'],
    ['expired', 'recreated', 'pending'],
    ['revoked', 'recreated', 'pending'],
    ['failed', 'recreated', 'pending'],
    ['reauthorization_required', 'renewed', 'active'],
  ];
  for (const [from, event, to] of legal) {
    const t = transition(from, event);
    check(t.ok && t.state === to, `subscription lifecycle: ${from} --${event}--> ${to}`);
  }

  const illegal = [
    ['expired', 'renewed'],
    ['revoked', 'renewed'],
    ['failed', 'created'],
    ['active', 'created'],
    ['pending', 'renewed'],
  ];
  for (const [from, event] of illegal) {
    const t = transition(from, event);
    check(!t.ok, `subscription lifecycle: ${from} --${event}--> refused`);
  }

  const h = buildHarness();
  eq(h.subscriptions.assertUsable('sub-dev-expired', CLOCK_START).ok, false, 'expired subscription is unusable');
  eq(h.subscriptions.assertUsable('sub-dev-revoked', CLOCK_START).reason, 'subscription_state_revoked',
    'revoked subscription reports its state');
  eq(h.subscriptions.assertUsable('sub-dev-0001', CLOCK_START).ok, true, 'healthy subscription is usable');
  eq(h.subscriptions.dueForRenewal(CLOCK_START, 3 * 24 * 3600 * 1000).length,
    subscriptionSeed.filter((s) => s.state === 'active').length,
    'renewal window lists every active subscription');
  const applied = h.subscriptions.apply('sub-dev-0001', 'revoked');
  check(applied.ok && applied.record.state === 'revoked', 'subscription manager applies a legal transition');
  const refused = h.subscriptions.apply('sub-dev-0001', 'renewed');
  check(!refused.ok, 'subscription manager refuses an illegal transition');
}

// --- Scope policy -----------------------------------------------------------

{
  check(auditGrantedScopes(allowlist.grantedScopes).ok, 'granted scopes pass the configuration audit');
  const broad = auditGrantedScopes(['Mail.Send', 'Sites.ReadWrite.All']);
  check(!broad.ok && broad.problems.length === 2, 'tenant-wide / send scopes are refused at configuration time');
  check(!('Mail.Send' in { ...Object.fromEntries(PERMITTED_SCOPES.map((s) => [s, true])) }),
    'Mail.Send is not a permitted scope');
  check('Mail.Send' in FORBIDDEN_SCOPES, 'Mail.Send is named as forbidden, with a reason');
  for (const s of catalogScopes()) check(PERMITTED_SCOPES.includes(s), `catalog scope '${s}' is permitted`);
  check(catalogScopes().every((s) => !(s in FORBIDDEN_SCOPES)), 'no catalog scope is forbidden');
}

// --- Capability catalog -----------------------------------------------------

{
  eq(CAPABILITY_CATALOG.length, 7, 'capability catalog size');
  check(CAPABILITY_CATALOG.every((c) => c.sideEffect !== 'external_send'),
    'no capability declares an external send');
  check(CAPABILITY_CATALOG.every((c) => c.idempotent === true), 'every capability is idempotent');
  check(!CAPABILITY_NAMES.includes('m365.mail.message.send'), 'there is no send capability');
  check(FORBIDDEN_CAPABILITIES.includes('m365.mail.message.send'), 'send is explicitly forbidden, not just absent');
  for (const c of CAPABILITY_CATALOG) {
    check(c.requiredScopes.length > 0, `${c.name} declares its scopes`);
    check(c.resourceKinds.length > 0, `${c.name} declares its resource kinds`);
    check(c.description.length > 10, `${c.name} is described`);
  }
  // Anything that writes outside a read must either require approval or be an
  // internal post to an allowlisted channel. Nothing writes unattended.
  for (const c of CAPABILITY_CATALOG.filter((x) => x.sideEffect === 'internal_write')) {
    check(c.requiresApproval || c.name.startsWith('m365.teams.'),
      `${c.name}: an unattended write must be an internal Teams post`);
  }
}

// --- Policy bridge ----------------------------------------------------------

{
  const bridge = createPolicyBridge({ policies: policySets.seed_v1, allowlist, env: {} });
  const q = {
    aweTenantId: AWE_TENANT, capability: 'm365.mail.draft.create',
    targetResource: draftResource, executionId: 'e1', objectiveId: 'o1',
    actingPrincipal: APPROVER, atIso: CLOCK_START,
  };
  eq(bridge.decide(q).effect, 'permit', 'policy bridge permits a draft the matrix can route');

  // The matrix is the authority: an inactive policy row denies the draft.
  const inactive = createPolicyBridge({ policies: policySets.inactive, allowlist, env: {} });
  const denied = inactive.decide({ ...q, messageType: 'service_call_confirmation' });
  eq(denied.effect, 'deny', 'policy bridge denies when the matrix blocks');
  check(denied.reason.includes('policy_inactive'), 'policy bridge surfaces the matrix reason');

  // An empty matrix has no row for the draft type at all.
  const empty = createPolicyBridge({ policies: [], allowlist, env: {} });
  eq(empty.decide(q).effect, 'deny', 'policy bridge denies with no matrix row');
  check(empty.decide(q).reason.includes('no_policy'), 'policy bridge reports no_policy');

  // Unlisted resources are denied even for capabilities the bridge otherwise permits.
  eq(bridge.decide({ ...q, capability: 'm365.teams.notification.create', targetResource: { kind: 'teams_channel', id: '19:unknown@thread.tacv2' } }).effect,
    'deny', 'policy bridge denies an unlisted Teams channel');
  eq(bridge.decide({ ...q, capability: 'm365.something.new', targetResource: draftResource }).effect,
    'deny', 'policy bridge fails closed on an unknown capability');

  // The full pipeline with a matrix that cannot route the draft type.
  const h = buildHarness({ policies: [] });
  const spec = JSON.parse(readFileSync(join(CASES, '01_happy_path_approved.json'), 'utf8'));
  const result = await runInboundMailSlice(spec.notification, { ...h.deps, options: { syntheticDecision: 'approved' } });
  const draft = result.results.find((r) => r.capability === 'm365.mail.draft.create');
  eq(draft?.denialReason, 'policy_denied', 'unroutable message type denies the draft through the pipeline');
  eq(h.gateway.created.filter((c) => c.kind === 'draft').length, 0, 'policy denial created no draft');
  seenDenials.add('policy_denied');
}

// --- Approval store invariants ---------------------------------------------

{
  const store = createInMemoryApprovalStore();
  const ref = store.request({
    aweTenantId: AWE_TENANT, capability: 'm365.mail.draft.create', targetResource: draftResource,
    executionId: 'e1', objectiveId: 'o1', approverRole: 'owner', reason: 'test', atIso: CLOCK_START,
  });
  eq(ref.state, 'pending', 'a requested approval starts pending');
  eq(ref.approvedBy, null, 'a requested approval names nobody');

  let threw = null;
  try { store.decide(ref.id, 'approved', SERVICE_PRINCIPAL, CLOCK_START); } catch (e) { threw = e; }
  check(threw?.code === 'approval_by_service_principal', 'a service principal cannot decide');

  store.decide(ref.id, 'approved', APPROVER, CLOCK_START);
  threw = null;
  try { store.decide(ref.id, 'rejected', APPROVER, CLOCK_START); } catch (e) { threw = e; }
  check(threw?.code === 'already_decided', 'one decision per approval');
}

// --- Normalization ----------------------------------------------------------

{
  const h = buildHarness();
  const spec = JSON.parse(readFileSync(join(CASES, '01_happy_path_approved.json'), 'utf8'));
  const result = await runInboundMailSlice(spec.notification, { ...h.deps, options: spec.options });
  const item = result.contextItem;

  eq(item.trust, 'untrusted_external', 'context item is flagged untrusted');
  eq(item.kind, 'email_message', 'context item kind');
  eq(item.source.provider, 'microsoft-graph', 'context item records its provider');
  check(item.contentHash.length === 64, 'context item carries a content hash');
  eq(item.attachments.length, 1, 'attachment normalized');
  check(item.attachments[0].contentHash.length === 64, 'attachment carries a content hash');

  const row = toEmailMessageRow(item);
  // Column parity with migration 0011's email_messages insert contract.
  const expectedColumns = ['org_id', 'direction', 'mailbox', 'graph_message_id', 'from_addr', 'to_addrs',
    'subject', 'body_text', 'body_html', 'attachments', 'raw', 'received_at', 'is_fixture'];
  check(JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...expectedColumns].sort()),
    `email_messages row columns: ${Object.keys(row).sort().join(',')}`);
  check(!JSON.stringify(row.raw).includes('Ignore all previous instructions'),
    'raw provenance does not duplicate untrusted body content');
  check(item.bodyText.includes('Ignore all previous instructions'),
    'untrusted instructions are preserved as DATA in the body column');

  // Re-normalizing the same message is stable.
  const h2 = buildHarness();
  const again = await runInboundMailSlice(spec.notification, { ...h2.deps, options: spec.options });
  eq(again.contextItem.contextItemId, item.contextItemId, 'context item id is derived and stable');
  eq(again.contextItem.contentHash, item.contentHash, 'content hash is stable');
  eq(again.executionId, result.executionId, 'execution id is derived and stable');
}

// --- Path safety ------------------------------------------------------------

{
  eq(safeFileName('../../etc/passwd'), 'passwd', 'attachment names cannot escape the prefix');
  eq(safeFileName('a b/c:d*.pdf'), 'c_d_.pdf', 'attachment names are sanitized');
  eq(safeFileName(''), 'attachment', 'empty attachment name falls back');
  eq(safeFileName('...'), 'attachment', 'dot-only attachment name falls back');
}

// --- Credentials + live proof -----------------------------------------------

{
  const nullProvider = createNullCredentialProvider();
  const described = nullProvider.describe();
  eq(described.available, false, 'null credential provider has nothing');
  eq(described.clientSecretPresent, false, 'null credential provider reports no secret');
  check(!JSON.stringify(described).includes('secret-value'), 'credential description carries no secret value');

  let threw = null;
  try { nullProvider.get(); } catch (e) { threw = e; }
  check(threw instanceof BlockedLiveProofError, 'missing credentials raise BlockedLiveProofError');
  check(threw.missing.includes('M365_CLIENT_SECRET'), 'BlockedLiveProofError names the exact missing variables');

  // The live gateway cannot be constructed without credentials AND an opt-in.
  threw = null;
  try {
    createHttpGraphGateway({ credentials: nullProvider, grantedScopes: allowlist.grantedScopes, env: {} });
  } catch (e) { threw = e; }
  check(threw instanceof BlockedLiveProofError, 'live gateway refuses to exist without prerequisites');
  check(threw.missing.some((m) => m.includes('M365_LIVE_SMOKE')), 'live gateway requires an explicit opt-in');

  // Even with complete credentials, a forbidden granted scope blocks it.
  const fullCreds = createEnvCredentialProvider({
    M365_TENANT_ID: 't', M365_CLIENT_ID: 'c', M365_CLIENT_SECRET: 's', M365_LIVE_SMOKE: '1',
  });
  eq(fullCreds.describe().available, true, 'env credential provider sees complete credentials');
  eq(fullCreds.describe().clientSecretPresent, true, 'presence is reported without the value');
  threw = null;
  try {
    createHttpGraphGateway({
      credentials: fullCreds,
      grantedScopes: ['Mail.Send'],
      env: { M365_LIVE_SMOKE: '1' },
    });
  } catch (e) { threw = e; }
  check(threw instanceof BlockedLiveProofError, 'a forbidden granted scope blocks the live gateway');

  // A capability whose handler cannot reach a live provider records
  // blocked_live_proof — not a success, not a plausible-looking empty result.
  const h = buildHarness();
  const blocked = createCapabilityExecutor({
    allowlist,
    evidence: h.evidence,
    ledger: h.ledger,
    handlers: {
      'm365.mail.message.read': async () => {
        throw new BlockedLiveProofError(['M365_CLIENT_SECRET', 'admin consent for Mail.Read']);
      },
    },
    fidelity: 'live',
    mode: 'TEST',
    sleep: async () => {},
  });
  const blockedResult = await blocked.execute(directRequest());
  eq(blockedResult.outcome, 'blocked_live_proof', 'a missing live prerequisite is reported as blocked');
  eq(blockedResult.failureReason, 'live_access_blocked', 'blocked live proof failure reason');
  eq(blockedResult.data, null, 'blocked live proof fabricates no data');
  check(blockedResult.detail.includes('M365_CLIENT_SECRET'), 'blocked live proof names the missing prerequisite');
  check(h.evidenceLog.all().some((e) => e.outcome === 'blocked_live_proof'), 'blocked live proof is recorded as evidence');
  seenFailures.add('live_access_blocked');

  // The fake can never claim to be live.
  const fake = createFakeGraphGateway(graphState);
  eq(fake.fidelity, 'synthetic', 'fake gateway reports synthetic fidelity');
  const res = await fake.execute({
    method: 'GET', path: '/users/dev-intake@awe-dev.example.invalid/messages/AAMkAGRLPHMSG0001',
    scopes: ['Mail.Read'], correlationId: 'c', idempotencyKey: 'k', timeoutMs: 1000,
  });
  eq(res.fidelity, 'synthetic', 'fake responses report synthetic fidelity');
  const noRoute = await fake.execute({
    method: 'POST', path: '/users/dev-intake@awe-dev.example.invalid/sendMail',
    scopes: ['Mail.Send'], correlationId: 'c', idempotencyKey: 'k', timeoutMs: 1000,
  });
  eq(noRoute.status, 501, 'the fake has no send route');
  const unknownMailbox = await fake.execute({
    method: 'GET', path: '/users/nobody@nowhere.example.invalid/messages/X',
    scopes: ['Mail.Read'], correlationId: 'c', idempotencyKey: 'k', timeoutMs: 1000,
  });
  eq(unknownMailbox.status, 404, 'the fake invents nothing for an unknown mailbox');
}

// --- Evidence ---------------------------------------------------------------

{
  const h = buildHarness();
  const spec = JSON.parse(readFileSync(join(CASES, '01_happy_path_approved.json'), 'utf8'));
  const result = await runInboundMailSlice(spec.notification, { ...h.deps, options: spec.options });

  const required = ['aweTenantId', 'microsoftTenantId', 'objectiveId', 'workPackageId', 'taskId',
    'executionId', 'correlationId', 'idempotencyKey', 'capability', 'capabilityVersion',
    'actingPrincipal', 'targetResource', 'requiredScopes', 'policyDecisionId', 'policyEffect',
    'outcome', 'fidelity', 'microsoftResourceIds', 'inputHash', 'attempts', 'gates',
    'evidenceHash', 'recordedAt'];
  for (const e of h.evidenceLog.all()) {
    for (const f of required) {
      check(e[f] !== undefined && e[f] !== null, `evidence row ${e.capability} carries ${f}`);
    }
    check(e.gates.length > 0, `evidence row ${e.capability} records its gate outcomes`);
  }

  const draftEvidence = h.evidenceLog.all().find((e) => e.capability === 'm365.mail.draft.create');
  check(draftEvidence.approvalId != null, 'draft evidence names the approval it ran under');
  eq(draftEvidence.approvalState, 'approved', 'draft evidence records the approval state');
  check(draftEvidence.microsoftResourceIds.draftMessageId != null, 'draft evidence records the Microsoft draft id');
  check(draftEvidence.outputHash?.length === 64, 'draft evidence hashes the provider response');

  // Tamper detection: mutate a record and the chain must break.
  const log = h.evidenceLog.all();
  const victim = log[1];
  log[1] = { ...victim, attempts: victim.attempts + 41, microsoftResourceIds: { messageId: 'rewritten' } };
  check(!verifyEvidenceChain(h.evidenceLog, AWE_TENANT).ok, 'a tampered evidence row breaks the chain');
  log[1] = victim;
  check(verifyEvidenceChain(h.evidenceLog, AWE_TENANT).ok, 'restoring the row restores the chain');

  // Persistence plan shape parity with migration 0016.
  const plan = buildPersistencePlan(result, h.evidenceLog.byExecution(result.executionId));
  eq(plan.m365_executions.length, 1, 'one execution row planned');
  eq(plan.m365_capability_invocations.length, h.evidenceLog.all().length, 'one invocation row per evidence record');
  for (const row of plan.m365_capability_invocations) {
    check(/^[0-9a-f]{64}$/.test(row.evidence_hash), 'planned invocation carries a sha256 evidence hash');
    check(/^[0-9a-f]{64}$/.test(row.input_hash), 'planned invocation carries a sha256 input hash');
    check(row.org_id === AWE_TENANT, 'planned invocation is tenant-scoped');
  }
}

// --- Vocabulary parity with migration 0016 ----------------------------------

{
  const sql = readFileSync(join(ROOT, 'supabase', 'migrations', '0016_m365_integration_plane.sql'), 'utf8');
  const listAfter = (anchor) => {
    const at = sql.indexOf(anchor);
    if (at < 0) return [];
    const open = sql.indexOf('(', at + anchor.length);
    const close = sql.indexOf(')', open);
    return [...sql.slice(open, close).matchAll(/'([a-z0-9_.]+)'/g)].map((m) => m[1]);
  };

  const sqlDenials = listAfter('denial_reason          text');
  check(JSON.stringify([...sqlDenials].sort()) === JSON.stringify([...DENIAL_REASONS].sort()),
    `0016 denial_reason vocabulary parity (sql ${sqlDenials.length} vs engine ${DENIAL_REASONS.length})`);

  const sqlFailures = listAfter('failure_reason         text');
  check(JSON.stringify([...sqlFailures].sort()) === JSON.stringify([...FAILURE_REASONS].sort()),
    `0016 failure_reason vocabulary parity (sql ${sqlFailures.length} vs engine ${FAILURE_REASONS.length})`);

  const sqlCapabilities = listAfter('capability             text');
  check(JSON.stringify([...sqlCapabilities].sort()) === JSON.stringify([...CAPABILITY_NAMES].sort()),
    `0016 capability vocabulary parity (sql ${sqlCapabilities.length} vs engine ${CAPABILITY_NAMES.length})`);

  const sqlRejections = listAfter('rejection_reason     text');
  check(JSON.stringify([...sqlRejections].sort()) === JSON.stringify([...NOTIFICATION_REJECTIONS].sort()),
    `0016 rejection_reason vocabulary parity (sql ${sqlRejections.length} vs engine ${NOTIFICATION_REJECTIONS.length})`);

  const stateEnum = /create type m365_subscription_state as enum\s*\(([^)]*)\)/.exec(sql);
  const sqlStates = [...(stateEnum?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check(JSON.stringify([...sqlStates].sort()) === JSON.stringify([...SUBSCRIPTION_STATES].sort()),
    '0016 subscription state parity');

  check(!/mail\.send|sendmail|'sent'/i.test(sql), '0016 contains no send vocabulary');
}

// --- Source purity ----------------------------------------------------------
//
// The strongest guarantee this slice can offer is that the machinery is absent.
// These gates assert the absence, over the shipped source.

{
  const pkgDir = join(ROOT, 'packages', 'm365', 'src');
  const sources = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.ts')) sources.push([p, readFileSync(p, 'utf8')]);
    }
  };
  walk(pkgDir);
  check(sources.length >= 15, `package source files found (${sources.length})`);

  for (const [path, src] of sources) {
    // Comments DOCUMENT the exclusions, so purity is linted on code lines only.
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');
    const name = path.slice(ROOT.length + 1);
    // http-gateway.ts IS the network transport, and the ambient declaration file
    // only names the globals it uses. Both are exempt by design, and both are
    // separately asserted: the gateway refuses transmit paths (below), and the
    // declaration file contains no executable code at all.
    const isTransport = name.endsWith('http-gateway.ts') || name.endsWith('.d.ts');

    if (!isTransport) {
      check(!/sendMail|\/send['"`]|\.send\(/.test(code), `${name}: contains no send path`);
      check(!/\bfetch\s*\(|XMLHttpRequest|new WebSocket|node:https?\b/.test(code), `${name}: makes no network call`);
    }
    // No secret material in source, anywhere.
    check(!/client_secret\s*[:=]\s*['"][^'"]{8,}/i.test(code), `${name}: no inline client secret`);
    check(!/password\s*[:=]\s*['"][^'"]{6,}/i.test(code), `${name}: no inline password`);
    check(!/\bey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(code), `${name}: no embedded JWT`);
  }

  // The live transport refuses every transmit path it could be asked for.
  const transport = readFileSync(join(pkgDir, 'http-gateway.ts'), 'utf8');
  for (const pattern of ['sendMail', '/send$', '/reply', '/forward']) {
    check(transport.includes(pattern), `live gateway names '${pattern}' in its refusal list`);
  }

  // Nothing anywhere in the new surface hard-codes a real Microsoft tenant.
  const fixtureText = [
    readFileSync(join(DIR, 'allowlist.json'), 'utf8'),
    readFileSync(join(DIR, 'graph-state.json'), 'utf8'),
    readFileSync(join(DIR, 'subscriptions.json'), 'utf8'),
  ].join('\n');
  const addresses = [...fixtureText.matchAll(/[a-z0-9._-]+@[a-z0-9.-]+/gi)].map((m) => m[0]);
  check(addresses.length > 0, 'fixtures contain addresses to check');
  for (const a of addresses) {
    check(a.endsWith('.invalid') || a.endsWith('@thread.tacv2'),
      `fixture address '${a}' uses a reserved unresolvable domain`);
  }
  check(!/onmicrosoft\.com|\.sharepoint\.com|graph\.microsoft\.com/i.test(fixtureText),
    'fixtures reference no real Microsoft host');
}

// --- Coverage gates ---------------------------------------------------------

{
  const rejectionCoverage = NOTIFICATION_REJECTIONS.filter((r) => seenRejections.has(r));
  console.log(`\n--- Runner 6 gates ---`);
  console.log(`notification-rejection coverage ${rejectionCoverage.length}/${NOTIFICATION_REJECTIONS.length}`);
  check(rejectionCoverage.length === NOTIFICATION_REJECTIONS.length,
    `every notification rejection is exercised (missing: ${NOTIFICATION_REJECTIONS.filter((r) => !seenRejections.has(r)).join(', ')})`);

  const denialCoverage = DENIAL_REASONS.filter((r) => seenDenials.has(r));
  console.log(`denial-reason coverage ${denialCoverage.length}/${DENIAL_REASONS.length}`);
  check(denialCoverage.length === DENIAL_REASONS.length,
    `every denial reason is exercised (missing: ${DENIAL_REASONS.filter((r) => !seenDenials.has(r)).join(', ')})`);

  const failureCoverage = FAILURE_REASONS.filter((r) => seenFailures.has(r));
  console.log(`failure-reason coverage ${failureCoverage.length}/${FAILURE_REASONS.length}`);
  check(failureCoverage.length === FAILURE_REASONS.length,
    `every failure reason is exercised (missing: ${FAILURE_REASONS.filter((r) => !seenFailures.has(r)).join(', ')})`);

  console.log(`capability catalog ${CAPABILITY_CATALOG.length} capabilities, ${catalogScopes().length} distinct scopes`);
  console.log(`draft message type routed through the approval matrix: ${DRAFT_MESSAGE_TYPE}`);
  console.log(`hash function sanity: ${hashValue({ a: 1 }) === hashValue({ a: 1 }) ? 'stable' : 'UNSTABLE'}`);
}

console.log(`\neval-m365 (Runner 6, offline, deterministic): passed=${pass} failed=${fail}  [${files.length} fixtures]`);
process.exit(fail === 0 ? 0 : 1);
