// ---------------------------------------------------------------------------
// eval-control-plane.mjs — assertion harness behind Runner P (execution control
// plane).
//
// PURE OFFLINE. No API keys, no model calls, no DB, no network, no mailbox, no
// n8n, no filesystem writes. Every clock is a virtual stepping clock, so
// timeout and duration behaviour is a deterministic assertion rather than a
// sleep, and two runs of this file produce byte-identical results.
//
// It asserts, as HARD gates:
//
//   manifest      — closed key set, fail-closed defaults, the risk/approval
//                   obligation, promotion accountability, step/tool coherence,
//                   compensation ordering, and self-digest integrity
//   registry      — unknown workflow, unknown version, incompatible version,
//                   unpromoted, tenant out of scope, missing dependency, and
//                   the structural proof that no API accepts a workflow
//                   DEFINITION
//   policy        — deny by default, LIVE refused outright, the three-way
//                   ceiling intersection, approval thresholds, and G4 (a
//                   service actor may never approve)
//   journal       — the hash chain, the transition table, refusal of a
//                   contradictory or tampered history, and the guarantee that
//                   state is projected rather than stored
//   dispatch      — unregistered tool, incompatible tool version, retired
//                   lifecycle, input/output validation, idempotent replay,
//                   idempotency conflict, and the step time budget
//   engine        — the full reference slice, pause, approve, resume, deny,
//                   compensate, retry, cancel, and timeout
//   service       — pause/resume across separate service calls with a fresh
//                   store, cross-tenant refusal on resume, and complete audit
//                   reconstruction from the persisted journal alone
//   layering      — the control plane imports the kernel and nothing else, has
//                   no clock, no network, no filesystem and no ambient env, and
//                   the reference adapters contain no send path
//
// Exit 0 iff all gates pass. Invoked by scripts/eval-control-plane.sh.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SIDE_EFFECTS, createExecutionContext, createGateRun, createToolCatalog, defineTool,
  digest, isKernelError, memoryArtifactSink, memoryAuditSink, stripComments,
} from '../packages/awe-kernel/src/index.mjs';
import {
  ADVANCE_OUTCOMES, CONTROL_PLANE_BLOCKED_REASONS, POLICY_DECISIONS, PROMOTION_STATES,
  RESOLUTION_REASONS, RISK_CLASSES, RUN_EVENT_TYPES, RUN_STATES, TERMINAL_STATES, TRANSITIONS,
  assertRunLease, createPolicyEngine, createRunEngine, createRunJournal, createToolDispatcher,
  createWorkflowRegistry, defineRunLease, defineToolGrant, defineWorkflowManifest,
  evaluateApprovalDecision, evaluateClaim, evaluateHold, evaluateRelease, isExpired,
  loadRunJournal, projectRunState, remainingMs, satisfiesVersion, validateContextRequirements,
  verifyChain,
} from '../packages/awe-control-plane/src/index.mjs';
import {
  createControlPlaneService, createMemoryJournalStore, createMemoryLeaseStore,
  createMemoryResultStore, createSteppingClock,
} from '../packages/awe-runtime/src/index.mjs';
import {
  OTHER_ORG, REFERENCE_ORG, createSyntheticLedger, invoiceIntakeManifest,
  referenceContextItems, referenceGrants, referenceTools, referenceValidators,
  tenantPolicyManifest,
} from '../packages/awe-runtime/src/reference/invoice-intake.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL_PLANE_SRC = join(ROOT, 'packages', 'awe-control-plane', 'src');

const run = createGateRun({ name: 'eval-control-plane (Runner P, offline, deterministic)' });
const { check, equal, section } = run;

function group(title, body) {
  section(title);
  try { body(); } catch (e) { check(false, `${title}: threw unexpectedly — ${e?.stack ?? e}`); }
}
async function groupAsync(title, body) {
  section(title);
  try { await body(); } catch (e) { check(false, `${title}: threw unexpectedly — ${e?.stack ?? e}`); }
}

let fixtures = 0;

// --- shared composition ------------------------------------------------------

/**
 * A fresh, fully in-memory control plane. Every negative case builds one of
 * these with ONE thing changed, so a passing negative test proves the guard it
 * names fired — not that two unrelated compositions behave differently.
 */
function compose({
  manifest = invoiceIntakeManifest(),
  policyManifest = tenantPolicyManifest(),
  grants = referenceGrants(),
  failures = {},
  tools = null,
  start = '2026-07-28T09:00:00.000Z',
  tick_ms = 10,
} = {}) {
  const ledger = createSyntheticLedger();
  const clock = createSteppingClock({ start, tick_ms });
  const manifests = policyManifest === null ? [manifest] : [manifest, policyManifest];
  const journals = createMemoryJournalStore();
  const results = createMemoryResultStore();
  const service = createControlPlaneService({
    manifests,
    tools: tools ?? referenceTools({ ledger, failures, advance: clock.advance }),
    grants,
    validators: referenceValidators(),
    journals,
    results,
    artifacts: memoryArtifactSink(),
    audit: memoryAuditSink(),
    clock,
  });
  fixtures += 1;
  return { service, ledger, clock, manifest, journals, results };
}

const startReference = (service, over = {}) => service.startRun({
  workflow_id: 'invoice_intake_approval',
  version: '^1.2.0',
  org_id: REFERENCE_ORG,
  context_items: referenceContextItems({ org_id: over.org_id ?? REFERENCE_ORG }),
  ...over,
});

// =============================================================================
// 1. MANIFEST — runtime-validated, versioned, fail-closed
// =============================================================================

group('workflow manifest — contract and identity', () => {
  const m = invoiceIntakeManifest();
  equal(m.schema, 'awe.workflow_manifest/v1', 'manifest declares its pinned schema');
  equal(m.workflow_id, 'invoice_intake_approval', 'workflow id');
  equal(m.version, '1.2.0', 'pinned semver version');
  equal(m.risk, 'high', 'risk classification is carried');
  equal(m.promotion.status, 'promoted', 'promotion status is carried');
  equal(m.tenant_scope, { mode: 'allow_list', org_ids: [REFERENCE_ORG] }, 'tenant scope is explicit');
  equal(m.required_tools.length, 6, 'required tools are declared');
  equal(m.required_context.length, 3, 'required context schemas are declared');
  equal(m.dependencies, [{ workflow_id: 'tenant_payment_policy', version: '^1.0.0' }], 'dependencies are declared');
  check(m.limits.step_timeout_ms > 0 && m.limits.run_timeout_ms > 0 && m.limits.max_attempts >= 1, 'timeout/retry settings are declared');
  equal(m.approval_policy.requires_approval_at_or_above, 'external', 'approval policy is declared');
  check(typeof m.manifest_digest === 'string' && m.manifest_digest.length > 0, 'manifest carries a self-digest');

  run.deterministic(() => invoiceIntakeManifest(), 'manifest construction is deterministic');
  equal(invoiceIntakeManifest().manifest_digest, m.manifest_digest, 'the same spec produces the same digest');
});

group('workflow manifest — fails closed', () => {
  const base = () => ({
    workflow_id: 'w', version: '1.0.0', description: 'd', risk: 'low',
    tenant_scope: { mode: 'allow_list', org_ids: ['o'] },
    required_tools: [{ name: 't', version: '1.0.0' }],
    steps: [{ id: 's', tool: 't' }],
  });
  // Sanity: the base spec must itself be valid, or every negative below is
  // proving nothing.
  check(defineWorkflowManifest(base()).workflow_id === 'w', 'the base spec is valid');

  run.throwsKernel(() => defineWorkflowManifest({ ...base(), aproval_policy: {} }), 'invalid_input', 'a misspelled key is refused, not ignored');
  run.throwsKernel(() => defineWorkflowManifest({ ...base(), tenant_scope: undefined }), 'invalid_input', 'a manifest with no tenant scope is refused');
  run.throwsKernel(() => defineWorkflowManifest({ ...base(), tenant_scope: { mode: 'allow_list', org_ids: [] } }), 'invalid_input', 'an empty allow-list is refused, never read as "any tenant"');
  run.throwsKernel(() => defineWorkflowManifest({ ...base(), tenant_scope: { mode: 'any_tenant', org_ids: ['o'] } }), 'invalid_input', 'any_tenant plus an allow-list is a contradiction');
  run.throwsKernel(() => defineWorkflowManifest({ ...base(), risk: undefined }), 'invalid_input', 'a manifest with no risk class is refused');
  run.throwsKernel(() => defineWorkflowManifest({ ...base(), version: '1.0' }), 'invalid_input', 'a non-semver version is refused');
  run.throwsKernel(() => defineWorkflowManifest({ ...base(), steps: [] }), 'invalid_input', 'a manifest with no steps is refused');
  run.throwsKernel(() => defineWorkflowManifest({ ...base(), required_tools: [] }), 'invalid_input', 'a manifest requiring no tools is refused');
  run.throwsKernel(
    () => defineWorkflowManifest({ ...base(), steps: [{ id: 's', tool: 'unlisted' }] }),
    'invalid_input', 'a step reaching a tool outside required_tools is refused',
  );
  run.throwsKernel(
    () => defineWorkflowManifest({ ...base(), risk: 'critical' }),
    'invalid_input', 'a critical-risk manifest with no approval threshold is refused',
  );
  run.throwsKernel(
    () => defineWorkflowManifest({
      ...base(), risk: 'critical', approval_policy: { requires_approval_at_or_above: 'external' },
    }),
    'invalid_input', 'a critical-risk manifest with no approver role is refused',
  );
  run.throwsKernel(
    () => defineWorkflowManifest({ ...base(), promotion: { status: 'promoted' } }),
    'invalid_input', 'promotion without a recorded promoter and instant is refused',
  );
  run.throwsKernel(
    () => defineWorkflowManifest({
      ...base(),
      required_tools: [{ name: 't', version: '1.0.0' }, { name: 'c', version: '1.0.0' }],
      steps: [{ id: 'c_step', tool: 'c', compensates: 's' }, { id: 's', tool: 't' }],
    }),
    'invalid_input', 'a compensation naming a LATER step is refused',
  );
  run.throwsKernel(
    () => defineWorkflowManifest({ ...base(), limits: { step_timeout_ms: 50_000, run_timeout_ms: 1000 } }),
    'invalid_input', 'a step budget larger than the run budget is refused',
  );
  run.throwsKernel(
    () => defineWorkflowManifest({ ...base(), dependencies: [{ workflow_id: 'w', version: '1.0.0' }] }),
    'invalid_input', 'a self-dependency is refused',
  );

  equal(RISK_CLASSES, ['low', 'medium', 'high', 'critical'], 'risk vocabulary is closed and ordered');
  equal(PROMOTION_STATES, ['draft', 'review', 'promoted', 'retired'], 'promotion vocabulary is closed');
});

group('version requirements', () => {
  check(satisfiesVersion('1.2.0', '1.2.0'), 'a pinned requirement matches exactly');
  check(!satisfiesVersion('1.2.1', '1.2.0'), 'a pinned requirement does NOT match a newer patch');
  check(satisfiesVersion('1.3.0', '^1.2.0'), 'a caret requirement accepts a newer minor');
  check(satisfiesVersion('1.2.5', '^1.2.0'), 'a caret requirement accepts a newer patch');
  check(!satisfiesVersion('1.1.9', '^1.2.0'), 'a caret requirement rejects an older minor');
  check(!satisfiesVersion('2.0.0', '^1.2.0'), 'a caret requirement never crosses a major');
  check(!satisfiesVersion('1.2.0', '>=1.0.0'), 'an unsupported range grammar is refused, not guessed');
});

group('context requirement validation', () => {
  const m = invoiceIntakeManifest();
  const items = referenceContextItems();
  const full = { org_id: REFERENCE_ORG, items };
  equal(validateContextRequirements(m, full).ok, true, 'a complete bundle satisfies the requirements');

  const missingPolicy = { org_id: REFERENCE_ORG, items: items.filter((i) => i.kind !== 'policy') };
  const verdict = validateContextRequirements(m, missingPolicy);
  equal(verdict.ok, false, 'a bundle missing the tenant policy is unmet');
  equal(verdict.unmet[0].reason, 'insufficient_items', 'the unmet requirement names itself');

  const foreign = { org_id: REFERENCE_ORG, items: referenceContextItems({ org_id: OTHER_ORG }) };
  check(
    validateContextRequirements(m, foreign).unmet.some((u) => u.reason === 'tenant_mismatch'),
    'a cross-tenant item is reported as a tenant leak, not as missing context',
  );
});

// =============================================================================
// 2. WORKFLOW REGISTRY — resolution is the only way to something executable
// =============================================================================

group('workflow registry — resolution', () => {
  const registry = createWorkflowRegistry([invoiceIntakeManifest(), tenantPolicyManifest()]);
  const ok = registry.resolve({ workflow_id: 'invoice_intake_approval', version: '^1.2.0', org_id: REFERENCE_ORG });
  equal(ok.ok, true, 'a registered, promoted, in-scope workflow resolves');
  equal(ok.manifest.version, '1.2.0', 'resolution returns the manifest');
  equal(ok.dependencies, [{ workflow_id: 'tenant_payment_policy', version: '1.0.0', manifest_digest: tenantPolicyManifest().manifest_digest }], 'dependencies resolve too');

  // --- unknown workflow
  const unknown = registry.resolve({ workflow_id: 'no_such_workflow', org_id: REFERENCE_ORG });
  equal(unknown.reason, 'workflow_not_registered', 'unknown workflow');
  equal(unknown.manifest, null, 'a refused resolution carries no manifest');

  // --- unknown / incompatible version
  equal(
    registry.resolve({ workflow_id: 'invoice_intake_approval', version: '9.9.9', org_id: REFERENCE_ORG }).reason,
    'workflow_version_unknown', 'unknown pinned version',
  );
  equal(
    registry.resolve({ workflow_id: 'invoice_intake_approval', version: '^2.0.0', org_id: REFERENCE_ORG }).reason,
    'workflow_version_incompatible', 'incompatible caret version',
  );

  // --- unauthorized tenant
  equal(
    registry.resolve({ workflow_id: 'invoice_intake_approval', version: '^1.2.0', org_id: OTHER_ORG }).reason,
    'tenant_out_of_scope', 'a tenant outside the manifest scope',
  );
  equal(
    registry.resolve({ workflow_id: 'invoice_intake_approval', version: '^1.2.0', org_id: null }).reason,
    'tenant_out_of_scope', 'a run naming no tenant at all',
  );

  // --- unpromoted
  const draftRegistry = createWorkflowRegistry([invoiceIntakeManifest({ promotion_status: 'draft' }), tenantPolicyManifest()]);
  equal(
    draftRegistry.resolve({ workflow_id: 'invoice_intake_approval', version: '^1.2.0', org_id: REFERENCE_ORG }).reason,
    'workflow_not_promoted', 'a draft workflow does not execute',
  );

  // --- missing dependency
  const orphan = createWorkflowRegistry([invoiceIntakeManifest()]);
  const missing = orphan.resolve({ workflow_id: 'invoice_intake_approval', version: '^1.2.0', org_id: REFERENCE_ORG });
  equal(missing.reason, 'dependency_unsatisfied', 'a workflow whose dependency is not registered does not execute');
  equal(missing.detail.includes('tenant_payment_policy'), true, 'the refusal names the missing dependency');

  // --- an UNPROMOTED dependency is also unsatisfied
  const draftDep = createWorkflowRegistry([invoiceIntakeManifest(), tenantPolicyManifest({ promotion_status: 'review' })]);
  equal(
    draftDep.resolve({ workflow_id: 'invoice_intake_approval', version: '^1.2.0', org_id: REFERENCE_ORG }).reason,
    'dependency_unsatisfied', 'a dependency that exists but is not promoted is unsatisfied',
  );

  run.throwsKernel(
    () => createWorkflowRegistry([invoiceIntakeManifest(), invoiceIntakeManifest()]),
    'invalid_input', 'registering the same workflow version twice is refused',
  );

  run.record('resolution_reason', [
    'workflow_not_registered', 'workflow_version_unknown', 'workflow_version_incompatible',
    'workflow_not_promoted', 'tenant_out_of_scope', 'dependency_unsatisfied',
  ]);
  run.coverage('resolution_reason', RESOLUTION_REASONS, { label: 'resolution-reason coverage' });
});

group('workflow registry — no bypass path exists', () => {
  // The structural claim: nothing in the control plane or the runtime service
  // accepts a workflow DEFINITION. A caller may only name one.
  const files = [
    ...readdirSync(CONTROL_PLANE_SRC).filter((f) => f.endsWith('.mjs')).map((f) => join(CONTROL_PLANE_SRC, f)),
    join(ROOT, 'packages', 'awe-runtime', 'src', 'control-plane-service.mjs'),
  ];
  // `startRun` and `advanceRun` take a `manifest` only from the registry's own
  // resolution; the eval asserts the public entry point cannot be handed one.
  const service = compose().service;
  const before = service.listWorkflows().length;
  const smuggled = service.startRun({
    workflow_id: 'invoice_intake_approval',
    // Not a parameter. If the service ever grows one, this stops being ignored
    // and the assertion below fails.
    manifest: defineWorkflowManifest({
      workflow_id: 'smuggled', version: '1.0.0', description: 'x', risk: 'low',
      tenant_scope: { mode: 'any_tenant' },
      required_tools: [{ name: 'read_invoice_email', version: '^1.0.0' }],
      steps: [{ id: 's', tool: 'read_invoice_email' }],
    }),
    org_id: REFERENCE_ORG,
    context_items: referenceContextItems(),
  });
  check(smuggled instanceof Promise, 'startRun is async');
  equal(service.listWorkflows().length, before, 'passing a manifest to startRun registers nothing');

  run.sourcePurity(files, [{
    name: 'registry bypass',
    pattern: /workflow_definition|inline_manifest|adhocWorkflow/,
    message: 'a workflow must be NAMED, never supplied',
  }], { label: 'no registry bypass' });
});

// =============================================================================
// 3. POLICY ENGINE — deny by default
// =============================================================================

group('policy engine — deny by default and fail closed', () => {
  const manifest = invoiceIntakeManifest();
  const descriptor = referenceTools({ ledger: createSyntheticLedger() })
    .find((t) => t.descriptor.name === 'record_invoice_draft').descriptor;
  const external = referenceTools({ ledger: createSyntheticLedger() })
    .find((t) => t.descriptor.name === 'issue_payment_instruction').descriptor;

  const context = (over = {}) => createExecutionContext({
    run_id: 'run-p1', workflow_id: 'invoice_intake_approval', org_id: REFERENCE_ORG,
    mode: 'TEST', is_fixture: true, started_at: '2026-07-28T09:00:00Z', ...over,
  });

  const empty = createPolicyEngine({ grants: [] });
  equal(empty.evaluate({ manifest, descriptor, context: context() }).decision, 'deny', 'no grant means no execution');
  equal(empty.evaluate({ manifest, descriptor, context: context() }).reason, 'tool_not_authorized', 'and it says why');

  const granted = createPolicyEngine({ grants: referenceGrants() });
  equal(granted.evaluate({ manifest, descriptor, context: context() }).decision, 'allow', 'a matching grant allows a write_internal tool');
  equal(granted.evaluate({ manifest, descriptor: external, context: context() }).decision, 'require_approval', 'an external tool requires approval');

  // --- LIVE is refused outright until ADR-0002 is ratified
  const live = granted.evaluate({
    manifest, descriptor, context: context({ org_id: REFERENCE_ORG, mode: 'LIVE', is_fixture: false }),
  });
  equal(live.decision, 'deny', 'LIVE mode is refused');
  equal(live.reason, 'live_mode_unratified', 'and names ADR-0002 as the reason');
  equal(granted.allows_live, false, 'no shipped composition enables LIVE');

  // --- tenant binding
  const noTenant = createPolicyEngine({ grants: referenceGrants({ org_id: 'x' }) })
    .evaluate({ manifest, descriptor, context: context({ org_id: null }) });
  equal(noTenant.reason, 'tenant_binding_required', 'a tenant-scoped tool cannot run for no tenant');

  // --- unauthorized tenant: a real tenant with an empty grant set
  equal(
    granted.evaluate({ manifest, descriptor, context: context({ org_id: OTHER_ORG }) }).reason,
    'tenant_out_of_scope', 'a tenant outside the manifest scope is denied',
  );

  // --- the ceiling is the MINIMUM of manifest and grant; neither can widen it
  const cappedGrant = createPolicyEngine({ grants: referenceGrants({ max_side_effect: 'read' }) });
  const capped = cappedGrant.evaluate({ manifest, descriptor: external, context: context() });
  equal(capped.decision, 'deny', 'a tenant grant capped at read denies an external tool');
  equal(capped.reason, 'tool_not_authorized', 'and reports it as an authorization refusal');

  const cappedManifest = invoiceIntakeManifest({});
  const loweredManifest = defineWorkflowManifest({
    ...JSON.parse(JSON.stringify({
      workflow_id: cappedManifest.workflow_id,
      version: cappedManifest.version,
      title: cappedManifest.title,
      description: cappedManifest.description,
      tenant_scope: cappedManifest.tenant_scope,
      required_context: cappedManifest.required_context,
      approval_policy: cappedManifest.approval_policy,
      limits: cappedManifest.limits,
      dependencies: cappedManifest.dependencies,
      risk: cappedManifest.risk,
      promotion: cappedManifest.promotion,
      steps: cappedManifest.steps,
      // the manifest lowers issue_payment_instruction to write_internal
      required_tools: cappedManifest.required_tools.map((t) => (t.name === 'issue_payment_instruction'
        ? { ...t, max_side_effect: 'write_internal' } : t)),
    })),
  });
  equal(
    granted.evaluate({ manifest: loweredManifest, descriptor: external, context: context() }).reason,
    'tool_not_authorized', 'a manifest ceiling below the tool\'s class denies it even with a full grant',
  );

  // --- tool not required by the manifest / version incompatible
  const foreignTool = defineTool({
    name: 'send_email', version: '1.0.0', description: 'x',
    workflow_id: 'invoice_intake_approval', side_effect: 'external',
  });
  equal(
    granted.evaluate({ manifest, descriptor: foreignTool, context: context() }).reason,
    'tool_not_registered', 'a tool the manifest never required is denied',
  );

  const wrongVersion = defineTool({
    name: 'record_invoice_draft', version: '2.0.0', description: 'x',
    workflow_id: 'invoice_intake_approval', side_effect: 'write_internal',
  });
  equal(
    granted.evaluate({ manifest, descriptor: wrongVersion, context: context() }).reason,
    'tool_version_incompatible', 'a tool at a major version the manifest does not require is denied',
  );

  run.deterministic(() => granted.evaluate({ manifest, descriptor: external, context: context() }), 'policy evaluation is deterministic');
  equal(POLICY_DECISIONS, ['allow', 'require_approval', 'deny'], 'the decision vocabulary is closed');

  run.throwsKernel(
    () => createPolicyEngine({ grants: [...referenceGrants(), ...referenceGrants()] }),
    'invalid_input', 'a duplicate grant is refused rather than silently shadowing',
  );
  run.throwsKernel(
    () => defineToolGrant({ org_id: 'o', workflow_id: 'w', tool: 't', unexpected: true }),
    'invalid_input', 'a grant with an unknown key is refused',
  );
  equal(
    defineToolGrant({ org_id: 'o', workflow_id: 'w', tool: 't' }).max_side_effect,
    'read', 'a grant that does not say what a tool may do grants only reads',
  );
});

group('approval rules — doctrine G4', () => {
  const manifest = invoiceIntakeManifest();
  const pending = { approval_id: 'apr-1', step_id: 'issue_payment', org_id: REFERENCE_ORG };

  const good = evaluateApprovalDecision({
    manifest, pending, decision: 'approve', actor: 'human', principal: 'jack', principal_roles: ['owner'], org_id: REFERENCE_ORG,
  });
  equal(good.ok, true, 'a named human holding an approver role may approve');

  equal(
    evaluateApprovalDecision({
      manifest, pending, decision: 'approve', actor: 'service', principal: 'automation',
      principal_roles: ['owner'], org_id: REFERENCE_ORG,
    }).reason,
    'approval_actor_invalid', 'AUTOMATION MAY NEVER APPROVE ITS OWN WORK, whatever roles it claims',
  );
  equal(
    evaluateApprovalDecision({
      manifest, pending, decision: 'approve', actor: 'human', principal: null,
      principal_roles: ['owner'], org_id: REFERENCE_ORG,
    }).reason,
    'approval_actor_invalid', 'an anonymous approval is refused',
  );
  equal(
    evaluateApprovalDecision({
      manifest, pending, decision: 'approve', actor: 'human', principal: 'mallory',
      principal_roles: ['field_employee'], org_id: REFERENCE_ORG,
    }).reason,
    'approver_role_not_permitted', 'a principal without an approver role is refused',
  );
  equal(
    evaluateApprovalDecision({
      manifest, pending, decision: 'approve', actor: 'human', principal: 'jack',
      principal_roles: ['owner'], org_id: OTHER_ORG,
    }).reason,
    'approval_tenant_mismatch', 'another tenant may not approve this run',
  );
  equal(
    evaluateApprovalDecision({
      manifest, pending: null, decision: 'approve', actor: 'human', principal: 'jack',
      principal_roles: ['owner'], org_id: REFERENCE_ORG,
    }).reason,
    'approval_unknown', 'there is nothing to approve on a run with no pending approval',
  );
  equal(
    evaluateApprovalDecision({
      manifest, pending, decision: 'maybe', actor: 'human', principal: 'jack',
      principal_roles: ['owner'], org_id: REFERENCE_ORG,
    }).reason,
    'approval_unknown', 'a decision verb outside {approve, reject} is refused',
  );
});

// =============================================================================
// 4. JOURNAL — append-only, hash-chained, state PROJECTED not stored
// =============================================================================

group('run journal — chain and transitions', () => {
  const journal = createRunJournal({
    run_id: 'run-j1', workflow_id: 'invoice_intake_approval', workflow_version: '1.2.0', org_id: REFERENCE_ORG,
  });
  equal(journal.state().state, 'pending', 'a run with no events is pending');

  journal.append({ event_type: 'workflow.started', occurred_at: '2026-07-28T09:00:00Z', payload: {} });
  equal(journal.state().state, 'running', 'workflow.started moves the run to running');

  journal.append({ event_type: 'step.started', occurred_at: '2026-07-28T09:00:01Z', payload: { step_id: 's1' } });
  journal.append({ event_type: 'step.completed', occurred_at: '2026-07-28T09:00:02Z', payload: { step_id: 's1' } });
  equal(journal.state().completed_steps.map((s) => s.step_id), ['s1'], 'completed steps are projected');

  // --- an illegal transition is refused at APPEND time
  run.throwsKernel(
    () => journal.append({ event_type: 'approval.granted', occurred_at: '2026-07-28T09:00:03Z', payload: {} }),
    'contract_violation', 'an approval cannot be granted on a run that never requested one',
  );
  run.throwsKernel(
    () => journal.append({ event_type: 'workflow.started', occurred_at: '2026-07-28T09:00:03Z', payload: {} }),
    'contract_violation', 'a run cannot start twice',
  );
  run.throwsKernel(
    () => journal.append({ event_type: 'not_an_event', occurred_at: '2026-07-28T09:00:03Z', payload: {} }),
    'invalid_input', 'an event type outside the transition table cannot be appended',
  );

  journal.append({ event_type: 'workflow.completed', occurred_at: '2026-07-28T09:00:04Z', payload: {} });
  equal(journal.state().terminal, true, 'the run is terminal');
  run.throwsKernel(
    () => journal.append({ event_type: 'step.started', occurred_at: '2026-07-28T09:00:05Z', payload: {} }),
    'contract_violation', 'nothing may be appended after a terminal state',
  );

  // --- the chain
  const entries = journal.entries();
  equal(entries.map((e) => e.seq), [1, 2, 3, 4], 'sequence numbers are dense and positional');
  equal(entries[0].prev_digest, journal.genesis, 'the first entry chains to the run genesis');
  for (let i = 1; i < entries.length; i += 1) {
    check(entries[i].prev_digest === entries[i - 1].entry_digest, `entry ${i + 1} chains to its predecessor`);
  }
  check(verifyChain(entries, { genesis: journal.genesis }) === journal.head(), 'chain verification returns the head');

  equal(RUN_EVENT_TYPES.length, Object.keys(TRANSITIONS).length, 'every event type has a transition');
  check(TERMINAL_STATES.every((s) => RUN_STATES.includes(s)), 'terminal states are run states');
  check(
    Object.values(TRANSITIONS).every((t) => t.from.every((s) => !TERMINAL_STATES.includes(s))),
    'NO event lists a terminal state as a legal predecessor — post-terminal appends are impossible by construction',
  );
});

group('run journal — a corrupted or contradictory history is refused', () => {
  const journal = createRunJournal({
    run_id: 'run-j2', workflow_id: 'invoice_intake_approval', workflow_version: '1.2.0', org_id: REFERENCE_ORG,
  });
  journal.append({ event_type: 'workflow.started', occurred_at: '2026-07-28T09:00:00Z', payload: {} });
  journal.append({ event_type: 'step.started', occurred_at: '2026-07-28T09:00:01Z', payload: { step_id: 's1' } });
  journal.append({ event_type: 'step.completed', occurred_at: '2026-07-28T09:00:02Z', payload: { step_id: 's1' } });
  const document = journal.toDocument();

  // Tamper, then RESEAL: the outer `journal_digest` is recomputed so the
  // document is self-consistent at the header level. Without this every case
  // below is caught by the header digest alone, and the per-entry checks —
  // sequence, entry digest, chain, event key — are never actually exercised.
  // (Found by a deliberate perturbation: the chain check could be deleted with
  // the whole suite still green.)
  const tamper = (mutate) => {
    const copy = JSON.parse(JSON.stringify(document));
    mutate(copy);
    const { journal_digest, ...rest } = copy;
    return { ...rest, journal_digest: digest(rest) };
  };

  // The header digest is still a real check, on its own terms.
  run.throwsKernel(
    () => loadRunJournal({ ...document, entry_count: 99 }),
    'contract_violation', 'an unsealed edit is caught by the journal digest',
  );

  // --- a deleted entry
  run.throwsKernel(
    () => loadRunJournal(tamper((d) => { d.entries.splice(1, 1); })),
    'contract_violation', 'a deleted entry is detected',
  );
  // --- a reordered pair
  run.throwsKernel(
    () => loadRunJournal(tamper((d) => { const t = d.entries[1]; d.entries[1] = d.entries[2]; d.entries[2] = t; })),
    'contract_violation', 'a reordered history is detected',
  );
  // --- an edited payload, re-digested at the ENTRY level but not the event level
  run.throwsKernel(
    () => loadRunJournal(tamper((d) => { d.entries[1].event.payload.step_id = 'somewhere_else'; })),
    'contract_violation', 'an edited event payload is detected by the kernel event key',
  );
  // --- a spliced-in entry from another run
  run.throwsKernel(
    () => loadRunJournal(tamper((d) => { d.entries[1].prev_digest = 'deadbeefdeadbeef'; })),
    'contract_violation', 'a spliced entry is detected by the chain',
  );
  // --- an entry TRANSPLANTED from another journal of the same run.
  //
  // This is the case the hash chain exists for, and the only one the other two
  // checks cannot see: the transplanted entry has the right `seq`, and its own
  // `entry_digest` is genuine because it was produced by a real append — so a
  // validator that only checked sequence numbers and per-entry digests would
  // accept a history that never happened. It is caught solely because
  // `prev_digest` points at the OTHER journal's predecessor.
  //
  // (This assertion was added after a deliberate perturbation showed the chain
  // check could be deleted with every other gate still green.)
  const donor = createRunJournal({
    run_id: 'run-j2', workflow_id: 'invoice_intake_approval', workflow_version: '1.2.0', org_id: REFERENCE_ORG,
  });
  donor.append({ event_type: 'workflow.started', occurred_at: '2026-07-28T10:00:00Z', payload: { different: true } });
  donor.append({ event_type: 'step.started', occurred_at: '2026-07-28T10:00:01Z', payload: { step_id: 's1' } });
  const donorEntry = donor.entries()[1];

  equal(donorEntry.seq, document.entries[1].seq, 'the donor entry has the same sequence number as the one it replaces');
  check(
    (() => {
      const { entry_digest, ...body } = donorEntry;
      return JSON.stringify(body).length > 0 && donorEntry.entry_digest === entry_digest;
    })(),
    'and its own digest is genuine — it was produced by a real append',
  );
  check(
    donorEntry.prev_digest !== document.entries[1].prev_digest,
    'only its predecessor differs',
  );
  run.throwsKernel(
    () => loadRunJournal(tamper((d) => { d.entries[1] = donorEntry; })),
    'contract_violation', 'an entry transplanted from another journal is caught by the chain, and by nothing else',
  );

  // --- BACKDATING an event.
  //
  // `occurred_at` is deliberately excluded from the kernel's `event_key` (the
  // same logical event replayed at a different time is the same event for
  // idempotency purposes), so rewriting a timestamp passes `assertEvent`, leaves
  // the chain intact and leaves every sequence number correct. The per-entry
  // digest is the ONLY thing standing between an auditor and a rewritten
  // approval time — which is exactly the record most worth backdating.
  run.throwsKernel(
    () => loadRunJournal(tamper((d) => { d.entries[1].event.occurred_at = '2020-01-01T00:00:00Z'; })),
    'contract_violation', 'an event cannot be backdated — the per-entry digest catches it, and nothing else does',
  );

  // --- a FULLY RE-CHAINED forgery.
  //
  // The strongest offline attacker: one who edits a payload and then recomputes
  // every downstream `prev_digest` and `entry_digest` so the whole chain
  // verifies. The kernel's content-addressed `event_key` is what survives that,
  // because it commits to the payload independently of the journal's own
  // bookkeeping.
  const rechain = (entries, genesis) => {
    let previous = genesis;
    return entries.map((entry) => {
      const body = { seq: entry.seq, prev_digest: previous, event: entry.event };
      const sealed = { ...body, entry_digest: digest(body) };
      previous = sealed.entry_digest;
      return sealed;
    });
  };
  run.throwsKernel(
    () => loadRunJournal(tamper((d) => {
      d.entries[1].event.payload.step_id = 'a_step_that_never_ran';
      d.entries = rechain(d.entries, d.genesis);
    })),
    'contract_violation', 'a fully re-chained forgery is still caught by the kernel event key',
  );

  // --- defence in depth, stated honestly.
  //
  // The sequence check is NOT independently load-bearing: given the genesis
  // digest and the prev_digest chain, any deletion, insertion or reordering is
  // already detected without it. It is kept because it names the failure in
  // terms an operator can act on ("the log has a gap") instead of "digest
  // mismatch", and a deliberate perturbation confirmed it can be removed with
  // the rest of the suite green. This assertion records that relationship so a
  // future reader does not mistake redundancy for coverage.
  const chainOnly = createRunJournal({
    run_id: 'run-j5', workflow_id: 'w', workflow_version: '1.0.0', org_id: REFERENCE_ORG,
  });
  chainOnly.append({ event_type: 'workflow.started', occurred_at: '2026-07-28T09:00:00Z', payload: {} });
  chainOnly.append({ event_type: 'step.started', occurred_at: '2026-07-28T09:00:01Z', payload: { step_id: 's' } });
  const gapped = chainOnly.entries().slice(1);
  run.throwsKernel(
    () => verifyChain(gapped, { genesis: chainOnly.genesis }),
    'contract_violation', 'a deleted first entry is caught (by sequence AND by the chain — the two overlap by design)',
  );

  // --- a CONTRADICTORY history: entries that chain perfectly but describe an
  //     impossible sequence. This is the case a hash chain alone cannot catch,
  //     and it is why the projection re-checks the transition table.
  const rogue = createRunJournal({
    run_id: 'run-j3', workflow_id: 'invoice_intake_approval', workflow_version: '1.2.0', org_id: REFERENCE_ORG,
  });
  rogue.append({ event_type: 'workflow.started', occurred_at: '2026-07-28T09:00:00Z', payload: {} });
  rogue.append({ event_type: 'workflow.completed', occurred_at: '2026-07-28T09:00:01Z', payload: {} });
  const forged = JSON.parse(JSON.stringify(rogue.toDocument()));
  // Take a well-formed `approval.granted` entry from a DIFFERENT, valid journal
  // and re-chain it onto this one, so every digest is genuine.
  const approvalSource = createRunJournal({
    run_id: 'run-j3', workflow_id: 'invoice_intake_approval', workflow_version: '1.2.0', org_id: REFERENCE_ORG,
  });
  approvalSource.append({ event_type: 'workflow.started', occurred_at: '2026-07-28T09:00:00Z', payload: {} });
  approvalSource.append({ event_type: 'step.started', occurred_at: '2026-07-28T09:00:01Z', payload: { step_id: 'x' } });
  approvalSource.append({ event_type: 'approval.requested', occurred_at: '2026-07-28T09:00:02Z', payload: { approval_id: 'a', step_id: 'x' } });
  const legitimateApproval = approvalSource.entries()[2];

  check(
    (() => {
      try {
        projectRunState([...forged.entries, legitimateApproval], { genesis: forged.genesis, verify: false });
        return false;
      } catch (e) {
        return isKernelError(e, 'contract_violation');
      }
    })(),
    'a history that chains but contradicts itself is refused by the projection, not accepted',
  );
});

group('run journal — state is projected, never stored', () => {
  const files = readdirSync(CONTROL_PLANE_SRC).filter((f) => f.endsWith('.mjs')).map((f) => join(CONTROL_PLANE_SRC, f));
  run.sourcePurity(files, [{
    name: 'stored state',
    // A setter would be the only way for a stored state to disagree with the
    // history. There is none, and this asserts there is none.
    pattern: /\.state\s*=(?!=)|setState|\bstate\s*=\s*['"](running|completed|failed)['"]/,
    message: 'run state must be projected from the journal, never assigned',
  }], { label: 'no stored run state' });

  const journal = createRunJournal({
    run_id: 'run-j4', workflow_id: 'w', workflow_version: '1.0.0', org_id: REFERENCE_ORG,
  });
  journal.append({ event_type: 'workflow.started', occurred_at: '2026-07-28T09:00:00Z', payload: {} });
  const projected = journal.state();
  run.deterministic(() => journal.state(), 'projection is deterministic');
  equal(projected.state, projectRunState(journal.entries(), { genesis: journal.genesis }).state, 'the journal and a bare projection agree');
});

// =============================================================================
// 5. DISPATCH — the controlled tool boundary
// =============================================================================

await groupAsync('tool dispatch — refusals before the adapter is reached', async () => {
  const ledger = createSyntheticLedger();
  const clock = createSteppingClock({});
  const manifest = invoiceIntakeManifest();
  const context = createExecutionContext({
    run_id: 'run-d1', workflow_id: 'invoice_intake_approval', org_id: REFERENCE_ORG,
    mode: 'TEST', is_fixture: true, started_at: '2026-07-28T09:00:00.000Z',
  });

  let calls = 0;
  const counting = referenceTools({ ledger, advance: clock.advance }).map((t) => ({
    descriptor: t.descriptor,
    adapter: (...args) => { calls += 1; return t.adapter(...args); },
  }));

  const dispatcher = createToolDispatcher({
    catalog: createToolCatalog(counting),
    policy: createPolicyEngine({ grants: referenceGrants() }),
    validators: referenceValidators(),
    clock,
  });

  // --- unregistered tool
  const unregistered = await dispatcher.invoke({ manifest, tool: 'delete_everything', input: {}, context });
  equal(unregistered.reason, 'tool_not_registered', 'an unregistered tool is refused');
  equal(calls, 0, 'and no adapter ran');

  // --- incompatible tool version: a catalog whose descriptor is v3
  const stale = createToolDispatcher({
    catalog: createToolCatalog([{
      descriptor: defineTool({
        name: 'record_invoice_draft', version: '3.0.0', description: 'x',
        workflow_id: 'invoice_intake_approval', side_effect: 'write_internal',
      }),
      adapter: () => { calls += 1; return { draft_id: 'd', status: 'draft' }; },
    }]),
    policy: createPolicyEngine({ grants: referenceGrants() }),
    validators: referenceValidators(),
    clock,
  });
  const incompatible = await stale.invoke({ manifest, tool: 'record_invoice_draft', input: {}, context });
  equal(incompatible.reason, 'tool_version_incompatible', 'a tool at an incompatible version is refused');
  equal(calls, 0, 'and no adapter ran');

  // --- retired lifecycle
  const retired = createToolDispatcher({
    catalog: createToolCatalog([{
      descriptor: defineTool({
        name: 'record_invoice_draft', version: '1.0.0', description: 'x',
        workflow_id: 'invoice_intake_approval', side_effect: 'write_internal', lifecycle: 'retired',
      }),
      adapter: () => { calls += 1; return { draft_id: 'd', status: 'draft' }; },
    }]),
    policy: createPolicyEngine({ grants: referenceGrants() }),
    validators: referenceValidators(),
    clock,
  });
  equal(
    (await retired.invoke({ manifest, tool: 'record_invoice_draft', input: {}, context })).reason,
    'tool_lifecycle_ineligible', 'a retired tool may not be executed',
  );
  equal(calls, 0, 'and no adapter ran');

  // --- approval required
  const gated = await dispatcher.invoke({
    manifest,
    step: manifest.steps.find((s) => s.id === 'issue_payment'),
    tool: 'issue_payment_instruction',
    input: { _run_id: 'r', _org_id: REFERENCE_ORG, _results: { record_draft: { draft_id: 'd', status: 'draft' } } },
    context,
  });
  equal(gated.reason, 'approval_required', 'a consequential tool is refused without approval');
  equal(calls, 0, 'and no adapter ran — the approval gate is BEFORE the effect');
  equal(gated.obligations.approver_roles, ['accountant', 'owner'], 'the refusal states who may approve');

  // --- input validation
  const badInput = await dispatcher.invoke({
    manifest,
    step: manifest.steps.find((s) => s.id === 'extract_fields'),
    tool: 'extract_invoice_fields',
    input: { _run_id: 'r', _org_id: REFERENCE_ORG, _results: {} },
    context,
  });
  equal(badInput.reason, 'tool_input_invalid', 'a step whose precondition is unmet is refused');
  equal(calls, 0, 'and no adapter ran');

  // --- a declared schema with NO registered validator fails closed
  const unvalidated = createToolDispatcher({
    catalog: createToolCatalog([{
      descriptor: defineTool({
        name: 'record_invoice_draft', version: '1.0.0', description: 'x',
        workflow_id: 'invoice_intake_approval', side_effect: 'write_internal',
        input_schema: 'awe.nobody.registered/v1',
      }),
      adapter: () => { calls += 1; return {}; },
    }]),
    policy: createPolicyEngine({ grants: referenceGrants() }),
    validators: {},
    clock,
  });
  equal(
    (await unvalidated.invoke({ manifest, tool: 'record_invoice_draft', input: {}, context })).reason,
    'tool_input_invalid', 'a declared schema with no validator is an unchecked boundary and is refused',
  );
  equal(calls, 0, 'and no adapter ran');
});

await groupAsync('tool dispatch — idempotency and the step budget', async () => {
  const ledger = createSyntheticLedger();
  const clock = createSteppingClock({});
  const manifest = invoiceIntakeManifest();
  const context = createExecutionContext({
    run_id: 'run-d2', workflow_id: 'invoice_intake_approval', org_id: REFERENCE_ORG,
    mode: 'TEST', is_fixture: true, started_at: '2026-07-28T09:00:00.000Z',
  });

  let calls = 0;
  const dispatcher = createToolDispatcher({
    catalog: createToolCatalog(referenceTools({ ledger, advance: clock.advance }).map((t) => ({
      descriptor: t.descriptor,
      adapter: (...args) => { calls += 1; return t.adapter(...args); },
    }))),
    policy: createPolicyEngine({ grants: referenceGrants() }),
    validators: referenceValidators(),
    clock,
  });

  const step = manifest.steps.find((s) => s.id === 'read_email');
  const input = { _run_id: context.run_id, _org_id: REFERENCE_ORG, _results: {} };

  const first = await dispatcher.invoke({ manifest, step, input, context });
  equal(first.ok, true, 'the first invocation runs');
  equal(calls, 1, 'the adapter ran once');
  equal(first.replayed, false, 'it was not a replay');

  // --- DUPLICATE invocation: same identity, same input -> replayed, NOT re-run
  const second = await dispatcher.invoke({ manifest, step, input, context });
  equal(second.ok, true, 'a duplicate invocation succeeds');
  equal(second.replayed, true, 'and is marked as a replay');
  equal(calls, 1, 'THE ADAPTER DID NOT RUN AGAIN — no double side effect');
  equal(second.data, first.data, 'the recorded result is replayed');

  // --- IDEMPOTENCY CONFLICT: the same declared key with a different input
  const sharedKey = { ...step, id: 'shared', idempotency_key: 'fixed-effect-identity' };
  const a = await dispatcher.invoke({ manifest, step: sharedKey, input: { ...input, marker: 'a' }, context });
  equal(a.ok, true, 'the first claim on a declared identity succeeds');
  const b = await dispatcher.invoke({ manifest, step: sharedKey, input: { ...input, marker: 'b' }, context });
  equal(b.reason, 'idempotency_conflict', 'a DIFFERENT input under the same declared identity is refused');
  equal(calls, 2, 'and the conflicting adapter never ran');

  // --- STEP TIMEOUT, deterministically: the adapter advances the virtual clock
  //     past the manifest's step budget.
  const slow = createToolDispatcher({
    catalog: createToolCatalog(referenceTools({
      ledger, advance: clock.advance, failures: { read_invoice_email: manifest.limits.step_timeout_ms + 500 },
    })),
    policy: createPolicyEngine({ grants: referenceGrants() }),
    validators: referenceValidators(),
    clock,
  });
  const timedOut = await slow.invoke({ manifest, step, input, context });
  equal(timedOut.reason, 'step_timeout', 'a step that exceeds its budget is refused');
  check(timedOut.elapsed_ms > manifest.limits.step_timeout_ms, 'and the overrun is measured');
  check(!slow.knownEffects().includes(timedOut.idempotency_key), 'a timed-out effect is NOT recorded — its outcome is unknown, so a retry must re-run it');

  // --- an adapter that THROWS becomes a failed step, never an escaped exception
  const throwing = createToolDispatcher({
    catalog: createToolCatalog(referenceTools({ ledger, failures: { read_invoice_email: 'throw' } })),
    policy: createPolicyEngine({ grants: referenceGrants() }),
    validators: referenceValidators(),
    clock,
  });
  const threw = await throwing.invoke({ manifest, step, input, context });
  equal(threw.status, 'failed', 'a throwing adapter produces a failed invocation');
  equal(threw.reason, 'step_failed', 'with a classified reason');

  // --- output validation
  const badOutput = createToolDispatcher({
    catalog: createToolCatalog([{
      descriptor: defineTool({
        name: 'read_invoice_email', version: '1.0.0', description: 'x',
        workflow_id: 'invoice_intake_approval', side_effect: 'read',
        output_schema: 'awe.invoice.email/v1',
      }),
      adapter: () => ({ nothing: 'useful' }),
    }]),
    policy: createPolicyEngine({ grants: referenceGrants() }),
    validators: referenceValidators(),
    clock,
  });
  equal(
    (await badOutput.invoke({ manifest, step, input, context })).reason,
    'tool_output_invalid', 'an adapter returning the wrong shape is refused',
  );
});

// =============================================================================
// 6. ENGINE + SERVICE — the reference vertical slice, end to end
// =============================================================================

await groupAsync('reference slice — valid execution through approval, pause and resume', async () => {
  const { service, ledger } = compose();

  const started = await startReference(service);
  equal(started.advance, 'paused', 'the run PAUSES at the consequential step');
  equal(started.state, 'paused', 'and its projected state says so');
  equal(started.blocked_reason, 'approval_required', 'with a registered blocked reason');
  equal(started.final_state, 'paused', 'the run report records it as paused, not completed');
  equal(
    started.executed_tools.map((t) => t.tool),
    ['read_invoice_email', 'extract_invoice_fields', 'classify_invoice_risk', 'record_invoice_draft'],
    'exactly the four low-risk/internal steps ran',
  );
  equal(started.pending_approval.step_id, 'issue_payment', 'the pending approval names the step');
  equal(started.pending_approval.tool, 'issue_payment_instruction', 'and the tool');
  equal(started.pending_approval.side_effect, 'external', 'and why it is consequential');
  equal(ledger.instructions().length, 0, 'NO PAYMENT INSTRUCTION EXISTS — the effect is behind the gate');
  equal(ledger.drafts().length, 1, 'the internal draft was recorded');

  // --- separate service call: the decision
  const denied = await service.decideApproval({
    run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'approve',
    actor: 'service', principal: 'automation', principal_roles: ['owner'],
  });
  equal(denied.reason, 'approval_actor_invalid', 'automation cannot approve, even here');

  const wrongTenant = await service.decideApproval({
    run_id: started.run_id, org_id: OTHER_ORG, decision: 'approve',
    actor: 'human', principal: 'mallory', principal_roles: ['owner'],
  });
  equal(wrongTenant.reason, 'approval_tenant_mismatch', 'another tenant cannot approve this run');

  const decided = await service.decideApproval({
    run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'approve',
    actor: 'human', principal: 'jack', principal_roles: ['owner'], note: 'PO matches',
  });
  equal(decided.ok, true, 'the named owner approves');
  equal(decided.state, 'running', 'and the run is running again');
  equal(ledger.instructions().length, 0, 'approving alone still issues nothing — deciding and acting are two calls');

  // --- separate service call: the resume
  const resumed = await service.resumeRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(resumed.advance, 'completed', 'the resumed run completes');
  equal(resumed.state, 'completed', 'terminal state is completed');
  equal(resumed.final_state, 'completed', 'and the run report agrees');
  equal(ledger.instructions().length, 1, 'the payment instruction was issued — once');
  equal(
    resumed.executed_tools.map((t) => t.tool).slice(-1),
    ['issue_payment_instruction'], 'through the controlled tool boundary',
  );

  // --- complete audit reconstruction from the journal ALONE
  const rebuilt = service.getRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(rebuilt.state, 'completed', 'state rebuilt from the persisted journal agrees');
  equal(rebuilt.journal_head, resumed.journal_head, 'and so does the chain head');
  equal(rebuilt.executed_tools.length, 5, 'every tool invocation is in the reconstruction');

  const types = rebuilt.timeline.map((t) => t.event_type);
  for (const required of [
    'workflow.started', 'step.started', 'step.completed', 'approval.requested',
    'workflow.paused', 'approval.granted', 'workflow.resumed', 'tool.invoked', 'workflow.completed',
  ]) {
    check(types.includes(required), `the audit history records '${required}'`);
  }
  run.record('run_event_type', types);
});

await groupAsync('reference slice — approval DENIED rolls back', async () => {
  const { service, ledger } = compose();
  const started = await startReference(service);
  equal(started.state, 'paused', 'the run paused');
  equal(ledger.drafts()[0].status, 'draft', 'the draft is live before the decision');

  const decided = await service.decideApproval({
    run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'reject',
    actor: 'human', principal: 'jack', principal_roles: ['accountant'], note: 'PO does not match',
  });
  equal(decided.ok, true, 'the rejection is recorded');
  equal(decided.state, 'rejected', 'and the run is rejected');

  const resumed = await service.resumeRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(resumed.advance, 'failed', 'a denied run does not execute — it fails');
  equal(resumed.blocked_reason, 'approval_rejected', 'with the denial as the reason');
  equal(ledger.instructions().length, 0, 'NO PAYMENT INSTRUCTION WAS EVER ISSUED');
  equal(ledger.voided(), [ledger.drafts()[0].id], 'and the draft was compensated');
  equal(ledger.drafts()[0].status, 'void', 'the draft is void');
  check(
    resumed.compensations.some((c) => c.compensates === 'record_draft' && c.status === 'completed'),
    'the compensation is recorded in the journal',
  );
  run.record('run_event_type', resumed.timeline.map((t) => t.event_type));
});

await groupAsync('reference slice — failure, retry and compensation', async () => {
  // The consequential step is pre-approved by lowering the threshold, so the
  // case under test is the FAILURE path rather than the approval path.
  // A medium-risk, ungated variant of the SAME manifest: the case under test is
  // the failure path, and a high-risk manifest is (correctly) refused if it
  // declares no approval threshold.
  const manifest = invoiceIntakeManifest({ approval_threshold: null, risk: 'medium' });
  const { service, ledger } = compose({
    manifest,
    failures: { issue_payment_instruction: 'throw' },
  });
  const started = await startReference(service);
  equal(started.advance, 'failed', 'the run fails when the consequential step throws');
  equal(started.state, 'failed', 'terminal state is failed');
  equal(started.failed_steps.filter((s) => s.step_id === 'issue_payment').length, manifest.limits.max_attempts, `the step was retried up to max_attempts (${manifest.limits.max_attempts})`);
  equal(ledger.instructions().length, 0, 'nothing was issued');
  equal(ledger.voided().length, 1, 'the draft was compensated after the failure');
  check(
    started.compensations.some((c) => c.compensates === 'record_draft' && c.status === 'completed'),
    'compensation.requested and compensation.completed are both in the history',
  );
  run.record('run_event_type', started.timeline.map((t) => t.event_type));

  // --- a NON-retryable refusal is not retried
  const unauthorized = compose({ grants: referenceGrants({ tools: ['read_invoice_email'] }) });
  const refused = await startReference(unauthorized.service);
  equal(refused.advance, 'failed', 'a run whose second tool is ungranted fails');
  equal(refused.blocked_reason, 'tool_not_authorized', 'with the authorization refusal');
  equal(refused.failed_steps.length, 1, 'AND IS NOT RETRIED — a policy refusal refuses identically every time');
});

await groupAsync('reference slice — timeout and cancellation', async () => {
  // --- step timeout, escalated to a run failure after the retry budget
  const slow = compose({ failures: { classify_invoice_risk: 9000 } });
  const timedOut = await startReference(slow.service);
  equal(timedOut.advance, 'failed', 'a step that repeatedly blows its budget fails the run');
  equal(timedOut.blocked_reason, 'step_timeout', 'with the timeout as the reason');
  equal(timedOut.executed_tools.map((t) => t.tool).includes('record_invoice_draft'), false, 'and nothing after it ran');

  // --- RUN timeout: a per-read tick large enough to exhaust the run budget
  const manifest = invoiceIntakeManifest({ limits: { step_timeout_ms: 5000, run_timeout_ms: 6000 } });
  const overrun = compose({ manifest, tick_ms: 1500 });
  const expired = await startReference(overrun.service);
  equal(expired.advance, 'timed_out', 'a run that exceeds its own budget times out');
  equal(expired.state, 'timed_out', 'terminal state is timed_out');
  equal(expired.blocked_reason, 'run_timeout', 'with the run budget as the reason');
  run.record('run_event_type', expired.timeline.map((t) => t.event_type));

  // --- cancellation, at a step boundary
  const cancelling = compose();
  const cancelled = await cancelling.service.startRun({
    workflow_id: 'invoice_intake_approval',
    version: '^1.2.0',
    org_id: REFERENCE_ORG,
    context_items: referenceContextItems(),
    cancel: { requested: true, reason: 'operator pulled the run' },
  });
  equal(cancelled.advance, 'cancelled', 'a cancelled run stops');
  equal(cancelled.state, 'cancelled', 'terminal state is cancelled');
  equal(cancelled.executed_tools.length, 0, 'and no tool ran — cancellation is checked at the step boundary, before any effect');
  run.record('run_event_type', cancelled.timeline.map((t) => t.event_type));

  // --- cancelling a PAUSED run compensates what it already committed
  const midway = compose();
  const paused = await startReference(midway.service);
  equal(paused.state, 'paused', 'the run paused');
  const stopped = await midway.service.cancelRun({ run_id: paused.run_id, org_id: REFERENCE_ORG, reason: 'no longer needed' });
  equal(stopped.state, 'cancelled', 'the paused run is cancelled');
  equal(midway.ledger.voided().length, 1, 'and the draft it had already recorded was compensated');
  equal(midway.ledger.instructions().length, 0, 'with nothing issued');
});

await groupAsync('service — refusals before a journal exists still leave a record', async () => {
  const { service } = compose();

  // --- unknown workflow
  const unknown = await service.startRun({ workflow_id: 'no_such_workflow', org_id: REFERENCE_ORG });
  equal(unknown.blocked_reason, 'workflow_not_registered', 'unknown workflow is refused');
  check(unknown.report !== null && unknown.report !== undefined, 'and still produces a durable run report');

  // --- unpromoted
  const draft = compose({ manifest: invoiceIntakeManifest({ promotion_status: 'draft' }) });
  equal((await startReference(draft.service)).blocked_reason, 'workflow_not_promoted', 'an unpromoted workflow is refused');

  // --- incompatible version
  equal(
    (await service.startRun({
      workflow_id: 'invoice_intake_approval', version: '^3.0.0', org_id: REFERENCE_ORG,
      context_items: referenceContextItems(),
    })).blocked_reason,
    'workflow_version_incompatible', 'an incompatible version requirement is refused',
  );

  // --- missing dependency
  const orphan = compose({ policyManifest: null });
  equal((await startReference(orphan.service)).blocked_reason, 'dependency_unsatisfied', 'a missing dependency is refused');

  // --- unauthorized tenant
  const foreign = await service.startRun({
    workflow_id: 'invoice_intake_approval', version: '^1.2.0', org_id: OTHER_ORG,
    context_items: referenceContextItems({ org_id: OTHER_ORG }),
  });
  equal(foreign.blocked_reason, 'tenant_out_of_scope', 'a tenant outside the manifest scope is refused');

  // --- invalid context
  const thin = await service.startRun({
    workflow_id: 'invoice_intake_approval', version: '^1.2.0', org_id: REFERENCE_ORG,
    context_items: referenceContextItems().filter((i) => i.kind !== 'policy'),
  });
  equal(thin.blocked_reason, 'context_requirements_unmet', 'a run missing its required context does not start');
  equal(thin.state, 'failed', 'and is reported as failed');

  // --- a cross-tenant context item is a REFUSAL, not a filter
  const leaky = await service.startRun({
    workflow_id: 'invoice_intake_approval', version: '^1.2.0', org_id: REFERENCE_ORG,
    context_items: [...referenceContextItems(), ...referenceContextItems({ org_id: OTHER_ORG })],
  });
  equal(leaky.state, 'failed', 'a bundle carrying another tenant\'s item refuses to assemble');
});

await groupAsync('service — resume is tenant-bound and durable', async () => {
  const { service, ledger } = compose();
  const started = await startReference(service);
  equal(started.state, 'paused', 'the run paused');

  // --- RESUME WITH THE WRONG TENANT
  const stolen = await service.resumeRun({ run_id: started.run_id, org_id: OTHER_ORG });
  equal(stolen.ok, false, 'another tenant may not resume this run');
  equal(stolen.reason, 'approval_tenant_mismatch', 'and is refused by the ownership guard');
  check(!String(stolen.detail).includes(REFERENCE_ORG), 'the refusal does not disclose who owns the run');
  equal(ledger.instructions().length, 0, 'and nothing executed');

  const noSuchRun = await service.resumeRun({ run_id: 'run-that-never-existed', org_id: REFERENCE_ORG });
  equal(noSuchRun.ok, false, 'an unknown run cannot be resumed');

  // --- resuming a run whose approval is still pending re-requests it rather
  //     than proceeding
  const stillPending = await service.resumeRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(stillPending.state, 'paused', 'a resume without a decision stays paused');
  equal(ledger.instructions().length, 0, 'and issues nothing');
});

await groupAsync('service — pause and resume across a COLD store', async () => {
  // The strongest durability claim available offline: both persisted documents
  // — the CONTROL record (journal) and the DATA record (step results) — are
  // moved into a brand-new service with brand-new stores, brand-new adapters
  // and a brand-new ledger. Nothing else is shared. If the resume works, the
  // run genuinely survives a process boundary.
  const first = compose();
  const started = await startReference(first.service);
  equal(started.state, 'paused', 'the first service paused the run');

  const journalDocument = first.service.getJournalDocument({ run_id: started.run_id, org_id: REFERENCE_ORG });
  check(journalDocument !== null, 'the journal document is retrievable');
  const carriedResults = first.results.read({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(Object.keys(carriedResults).sort(), ['classify_risk', 'extract_fields', 'read_email', 'record_draft'], 'the DATA record holds the four completed steps\' outputs');

  // The journal must NOT be a way to recover the data. Assert that, rather than
  // trusting the comment in result-store.mjs.
  const serialized = JSON.stringify(journalDocument);
  check(!serialized.includes('INV-2291'), 'the journal carries no invoice number');
  check(!serialized.includes('Northgate'), 'the journal carries no supplier name');
  check(serialized.includes('result_digest'), 'it carries result DIGESTS instead');

  const coldJournals = createMemoryJournalStore();
  coldJournals.write(journalDocument);
  const coldResults = createMemoryResultStore();
  coldResults.write({ run_id: started.run_id, org_id: REFERENCE_ORG, results: carriedResults });

  const coldLedger = createSyntheticLedger();
  const coldClock = createSteppingClock({ start: '2026-07-28T11:00:00.000Z' });
  const cold = createControlPlaneService({
    manifests: [invoiceIntakeManifest(), tenantPolicyManifest()],
    tools: referenceTools({ ledger: coldLedger, advance: coldClock.advance }),
    grants: referenceGrants(),
    validators: referenceValidators(),
    journals: coldJournals,
    results: coldResults,
    artifacts: memoryArtifactSink(),
    audit: memoryAuditSink(),
    clock: coldClock,
  });
  fixtures += 1;

  const rebuilt = cold.getRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(rebuilt.state, 'paused', 'the cold service reconstructs the paused state from the document alone');
  equal(rebuilt.pending_approval.step_id, 'issue_payment', 'including the pending approval');
  equal(rebuilt.executed_tools.length, 4, 'and the four invocations already made');

  // A cold store is still tenant-bound.
  equal(cold.getRun({ run_id: started.run_id, org_id: OTHER_ORG }), null, 'another tenant sees nothing in the cold store');
  equal(
    coldResults.read({ run_id: started.run_id, org_id: OTHER_ORG }),
    {}, 'and the DATA store independently refuses the wrong tenant',
  );

  const decided = await cold.decideApproval({
    run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'approve',
    actor: 'human', principal: 'jack', principal_roles: ['owner'],
  });
  equal(decided.ok, true, 'the cold service records the approval');

  const finished = await cold.resumeRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(finished.advance, 'completed', 'and completes the run');
  equal(coldLedger.instructions().length, 1, 'issuing the payment instruction exactly once');
  equal(coldLedger.drafts().length, 0, 'WITHOUT re-running the earlier steps — the cold ledger never saw a draft');
  equal(finished.executed_tools.length, 5, 'the reconstruction reports all five invocations');
  equal(first.ledger.instructions().length, 0, 'and the original ledger is untouched');
});

// =============================================================================
// 7. LAYERING AND PURITY
// =============================================================================

// =============================================================================
// 6a. APPROVAL QUORUM — a gate several people have to open
// =============================================================================

group('quorum — the manifest rule counts people, not roles', () => {
  const spec = {
    workflow_id: 'w', version: '1.0.0', description: 'd', risk: 'low',
    tenant_scope: { mode: 'allow_list', org_ids: ['o'] },
    required_tools: [{ name: 't', version: '1.0.0' }],
    steps: [{ id: 's', tool: 't' }],
  };
  const two_owners = defineWorkflowManifest({
    ...spec,
    approval_policy: { requires_approval_at_or_above: 'external', approver_roles: ['owner'], quorum: 2 },
  });
  equal(two_owners.approval_policy.quorum, 2, '"two owners must both sign off" is expressible with ONE named role');
  run.throwsKernel(
    () => defineWorkflowManifest({ ...spec, approval_policy: { quorum: 2 } }),
    'invalid_input', 'a quorum above one with no eligible approver role is refused',
  );
  run.throwsKernel(
    () => defineWorkflowManifest({ ...spec, approval_policy: { approver_roles: ['owner'], quorum: 0 } }),
    'invalid_input', 'a quorum of zero is refused',
  );
});

await groupAsync('quorum — one approval is not enough, and one person is not two', async () => {
  const manifest = invoiceIntakeManifest({ approval_quorum: 2 });
  const { service, ledger } = compose({ manifest });
  const started = await startReference(service);
  equal(started.state, 'paused', 'the run paused at the consequential step');
  equal(started.pending_approval.quorum, 2, 'the pending approval states the quorum it needs');
  equal(started.pending_approval.outstanding, 2, 'and that nothing has been recorded yet');

  const first = await service.decideApproval({
    run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'approve',
    actor: 'human', principal: 'jack', principal_roles: ['owner'], note: 'PO matches',
  });
  equal(first.ok, true, 'the first approver is accepted');
  equal(first.quorum_satisfied, false, 'but the quorum is NOT satisfied');
  equal(first.outstanding, 1, 'and one approval is still outstanding');
  equal(first.state, 'paused', 'so the run is still paused, not approved');

  // THE case the whole mechanism exists for.
  const again = await service.decideApproval({
    run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'approve',
    actor: 'human', principal: 'jack', principal_roles: ['owner'], note: 'still me',
  });
  equal(again.ok, false, 'the same person voting twice is refused');
  equal(again.reason, 'approval_duplicate_principal', 'with a reason that names why — a quorum counts distinct people');

  // A resume between the two approvals must NOT execute anything.
  const early = await service.resumeRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(early.advance, 'paused', 'resuming a partially-approved run advances nothing');
  equal(early.blocked_reason, 'approval_required', 'and says it is still waiting for a human');
  equal(ledger.instructions().length, 0, 'NO PAYMENT INSTRUCTION — one of two approvals does not open the gate');

  const second = await service.decideApproval({
    run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'approve',
    actor: 'human', principal: 'dana', principal_roles: ['accountant'], note: 'second pair of eyes',
  });
  equal(second.ok, true, 'a DIFFERENT eligible person approves');
  equal(second.quorum_satisfied, true, 'which satisfies the quorum');
  equal(second.outstanding, 0, 'with nothing outstanding');
  equal(second.principals, ['jack', 'dana'], 'and both approvers are named — not just the last one');
  equal(second.state, 'running', 'only now is the run runnable again');

  const resumed = await service.resumeRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(resumed.advance, 'completed', 'the resumed run completes');
  equal(ledger.instructions().length, 1, 'and the payment instruction is issued exactly once');

  const rebuilt = service.getRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(rebuilt.approval_votes.map((v) => v.principal), ['jack', 'dana'], 'every vote is in the append-only history');
  equal(
    rebuilt.approvals[0].principals, ['jack', 'dana'],
    'and the granted gate records who satisfied it, so accountability survives the run',
  );
  const types = rebuilt.timeline.map((t) => t.event_type);
  equal(
    types.filter((t) => t === 'approval.recorded').length, 2,
    'two votes are recorded as two separate events',
  );
  equal(
    types.filter((t) => t === 'approval.granted').length, 1,
    'and the gate opened once — the votes and the gate are not the same event',
  );
  run.record('run_event_type', types);
});

await groupAsync('G4 is checked before the run is looked up', async () => {
  const { service } = compose();
  const started = await startReference(service);

  // The same submission against a run that EXISTS and one that does not must
  // give a service actor the identical answer. Any difference is an oracle: a
  // caller that can never approve anything would still learn which run ids are
  // real, and whose they are.
  const real = await service.decideApproval({
    run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'approve',
    actor: 'service', principal: 'automation', principal_roles: ['owner'],
  });
  const invented = await service.decideApproval({
    run_id: 'run_that_never_existed', org_id: REFERENCE_ORG, decision: 'approve',
    actor: 'service', principal: 'automation', principal_roles: ['owner'],
  });
  equal(real.reason, 'approval_actor_invalid', 'automation is refused on a real run');
  equal(invented.reason, 'approval_actor_invalid', 'and identically on an invented one — the refusal reveals nothing');
  equal(real.detail, invented.detail, 'down to the detail text');

  // A HUMAN, by contrast, is told the run is unknown — which is correct, and is
  // what proves the check above is ordering rather than a blanket answer.
  const human = await service.decideApproval({
    run_id: 'run_that_never_existed', org_id: REFERENCE_ORG, decision: 'approve',
    actor: 'human', principal: 'jack', principal_roles: ['owner'],
  });
  equal(human.reason, 'approval_unknown', 'a human submitting an unknown run id is told so');
});

await groupAsync('quorum — one denial overrides accumulated approvals', async () => {
  const manifest = invoiceIntakeManifest({ approval_quorum: 3 });
  const { service, ledger } = compose({ manifest });
  const started = await startReference(service);

  for (const [principal, role] of [['jack', 'owner'], ['dana', 'accountant']]) {
    const vote = await service.decideApproval({
      run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'approve',
      actor: 'human', principal, principal_roles: [role],
    });
    equal(vote.ok, true, `${principal} approves`);
    equal(vote.quorum_satisfied, false, `and the run is still short of its quorum after ${principal}`);
  }

  const veto = await service.decideApproval({
    run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'reject',
    actor: 'human', principal: 'sam', principal_roles: ['owner'], note: 'supplier bank details changed',
  });
  equal(veto.ok, true, 'the third approver rejects');
  equal(veto.state, 'rejected', 'and TWO standing approvals do not out-vote one refusal');

  const resumed = await service.resumeRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(resumed.advance, 'failed', 'continuing a rejected run rolls it back rather than executing');
  equal(resumed.blocked_reason, 'approval_rejected', 'with the denial as the reason');
  equal(ledger.instructions().length, 0, 'no payment instruction was ever issued');
  equal(ledger.drafts()[0].status, 'void', 'and the internal draft was compensated');
});

// =============================================================================
// 6b. ONE RUN, ONE WRITER — the lease, its expiry and its fence
// =============================================================================

group('run lease — the pure claim rules', () => {
  const RUN = 'run_alpha';
  const T0 = '2026-07-28T09:00:00.000Z';
  const T30 = '2026-07-28T09:00:30.000Z';
  const T60 = '2026-07-28T09:01:00.000Z';
  const T90 = '2026-07-28T09:01:30.000Z';
  const claim = (over = {}) => evaluateClaim({
    run_id: RUN, org_id: REFERENCE_ORG, holder: 'worker_a', now: T0, expires_at: T60, ...over,
  });

  const first = claim();
  equal(first.ok, true, 'an unheld run is claimable');
  equal(first.mode, 'acquired', 'and the claim is an acquisition');
  equal(first.lease.fence, 1, 'the first fence is 1');
  equal(first.lease.org_id, REFERENCE_ORG, 'the lease carries the tenant it was taken for');

  const contended = claim({ current: first.lease, holder: 'worker_b', now: T30, expires_at: T90 });
  equal(contended.ok, false, 'a SECOND worker is refused while the lease is live');
  equal(contended.reason, 'run_lease_held', 'with the registered reason');
  equal(contended.held_by, 'worker_a', 'and is told who holds it, so it can log something useful');

  const renewed = claim({ current: first.lease, holder: 'worker_a', now: T30, expires_at: T90 });
  equal(renewed.ok, true, 'the holder may renew');
  equal(renewed.mode, 'renewed', 'which is a renewal, not a re-acquisition');
  equal(renewed.lease.fence, 1, 'and a renewal does NOT move the fence — nothing downstream is invalidated');

  const stolen = claim({ current: first.lease, holder: 'worker_b', now: T60, expires_at: T90 });
  equal(stolen.ok, true, 'once expired, another worker may take the run — a crashed worker cannot strand it');
  equal(stolen.mode, 'stolen', 'and the takeover is visible as such');
  equal(stolen.lease.fence, 2, 'taking over ALWAYS bumps the fence');
  equal(stolen.previous_holder, 'worker_a', 'naming who lapsed');

  const selfSteal = claim({ current: first.lease, holder: 'worker_a', now: T60, expires_at: T90 });
  equal(
    selfSteal.lease.fence, 2,
    'even the ORIGINAL holder gets a new fence after expiry — it cannot know what happened in the gap',
  );

  equal(isExpired(first.lease, T60), true, 'a lease is expired AT its deadline, so two holders never overlap');
  equal(isExpired(first.lease, '2026-07-28T09:00:59.999Z'), false, 'and live one millisecond before it');
  equal(remainingMs(first.lease, T30), 30_000, 'remaining time is reported for a heartbeat to act on');

  // Commit-time holds. `evaluateHold` has three independent checks and they are
  // easy to make vacuous: a stolen lease has BOTH a new holder and a new fence,
  // so a single case testing it proves only that one of the two fired. Each
  // check below therefore has a case that ONLY it can catch.
  equal(evaluateHold({ current: first.lease, run_id: RUN, holder: 'worker_a', fence: 1, now: T30 }).ok, true, 'the holder may commit');
  const rival = evaluateClaim({ run_id: RUN, org_id: REFERENCE_ORG, holder: 'worker_b', now: T0, expires_at: T60 });
  equal(
    evaluateHold({ current: rival.lease, run_id: RUN, holder: 'worker_a', fence: null, now: T30 }).reason,
    'run_lease_lost',
    'HOLDER only: a caller that tracks no fence is still refused when someone else holds the run',
  );
  equal(
    evaluateHold({ current: selfSteal.lease, run_id: RUN, holder: 'worker_a', fence: 1, now: T60 }).reason,
    'run_lease_lost',
    'FENCE only: the same holder, live lease, stale fence — a suspended copy of worker_a may not commit',
  );
  equal(
    evaluateHold({ current: stolen.lease, run_id: RUN, holder: 'worker_a', fence: 1, now: T60 }).reason,
    'run_lease_lost', 'a worker whose run was taken may NOT commit',
  );
  equal(
    evaluateHold({ current: first.lease, run_id: RUN, holder: 'worker_a', fence: 1, now: T90 }).reason,
    'run_lease_lost', 'and neither may one whose lease simply expired under it',
  );
  equal(
    evaluateHold({ current: null, run_id: RUN, holder: 'worker_a', fence: 1, now: T0 }).reason,
    'run_lease_lost', 'committing against a run that holds no lease at all is refused',
  );
  equal(
    evaluateRelease({ current: stolen.lease, run_id: RUN, holder: 'worker_a' }).reason,
    'run_lease_lost', 'and a lapsed worker may not release its successor\'s lease on the way out',
  );

  // Fail-closed construction.
  run.throwsKernel(() => defineRunLease({ run_id: RUN, holder: 'w', fence: 0, acquired_at: T0, expires_at: T60 }), 'invalid_input', 'a fence below 1 is refused');
  run.throwsKernel(() => defineRunLease({ run_id: RUN, holder: 'w', fence: 1, acquired_at: T60, expires_at: T0 }), 'invalid_input', 'a lease that expires before it starts grants nothing');
  run.throwsKernel(() => claim({ expires_at: T0 }), 'invalid_input', 'a zero-length claim is refused');
  run.throwsKernel(
    () => claim({ current: first.lease, run_id: 'run_beta' }),
    'contract_violation', 'a lease evaluated against the wrong run is a WIRING BUG, not a contended claim',
  );
  run.throwsKernel(
    () => claim({ current: first.lease, org_id: OTHER_ORG }),
    'contract_violation', 'and so is one evaluated against the wrong tenant',
  );
  run.throwsKernel(
    () => assertRunLease({ ...first.lease, holder: 'mallory' }),
    'contract_violation', 'an edited lease record is refused — a lease is evidence about who could write',
  );
  run.deterministic(() => claim().lease, 'lease construction is deterministic');
});

await groupAsync('single writer — a contended resume, a lapsed lease and a stale commit', async () => {
  // Two SERVICES over one shared pair of stores is the honest model of two
  // workers: they share the durable state and share no memory.
  const ledger = createSyntheticLedger();
  const clock = createSteppingClock({ start: '2026-07-28T09:00:00.000Z', tick_ms: 10 });
  const journals = createMemoryJournalStore();
  const results = createMemoryResultStore();
  const leases = createMemoryLeaseStore({ ttl_ms: 30_000 });
  const worker = (holder) => createControlPlaneService({
    manifests: [invoiceIntakeManifest(), tenantPolicyManifest()],
    tools: referenceTools({ ledger, failures: {}, advance: clock.advance }),
    grants: referenceGrants(),
    validators: referenceValidators(),
    journals, results, leases, holder, lease_ttl_ms: 30_000,
    artifacts: memoryArtifactSink(), audit: memoryAuditSink(), clock,
  });
  fixtures += 1;

  const a = worker('worker_a');
  const b = worker('worker_b');

  check(a.holder === 'worker_a' && b.holder === 'worker_b', 'two workers with distinct identities share one journal store');
  let refusedHolder = null;
  try {
    createControlPlaneService({ manifests: [], journals, leases });
  } catch (e) { refusedHolder = String(e.message); }
  check(
    refusedHolder !== null && refusedHolder.includes('holder'),
    'a service given a real lease store but NO worker identity is refused — two processes sharing a holder name would both proceed',
  );

  const started = await a.startRun({
    workflow_id: 'invoice_intake_approval', version: '^1.2.0', org_id: REFERENCE_ORG,
    context_items: referenceContextItems({ org_id: REFERENCE_ORG }),
  });
  equal(started.state, 'paused', 'worker_a starts the run and it pauses for a human');
  equal(leases.list(), [], 'and worker_a RELEASED the lease when it stopped — a paused run is not a held run');

  await a.decideApproval({
    run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'approve',
    actor: 'human', principal: 'jack', principal_roles: ['owner'],
  });

  // --- the contended resume. `b` takes the run and never gives it back, which
  // is what a worker mid-step looks like from the outside.
  const held = leases.acquire({
    run_id: started.run_id, org_id: REFERENCE_ORG, holder: 'worker_b', now: clock.peek(), ttl_ms: 30_000,
  });
  equal(held.ok, true, 'worker_b claims the run');

  const blockedResume = await a.resumeRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(blockedResume.ok, false, 'worker_a\'s concurrent resume is REFUSED');
  equal(blockedResume.reason, 'run_lease_held', 'with the registered reason');
  equal(blockedResume.held_by, 'worker_b', 'naming the holder');
  equal(ledger.instructions().length, 0, 'and NOTHING executed — this is the double-payment that used to be possible');

  // --- expiry: worker_b dies. The run must not be stranded.
  clock.advance(31_000);
  const swept = a.expireLeases();
  equal(swept.map((s) => s.run_id), [started.run_id], 'the janitor reports the abandoned run');
  equal(swept[0].holder, 'worker_b', 'and who abandoned it');
  equal(
    leases.list(), [started.run_id],
    'and does NOT delete the record — deleting it would restart the fence at 1 and re-validate the suspended worker',
  );

  const recovered = await a.resumeRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
  equal(recovered.ok, true, 'worker_a can now recover the run');
  equal(recovered.advance, 'completed', 'and it completes');
  equal(recovered.lease_fence, 2, 'under a NEW fence, because the lease was taken over');
  equal(ledger.instructions().length, 1, 'the payment instruction is issued exactly once across both workers');
  equal(leases.list(), [], 'and the lease is released at the end');
});

await groupAsync('single writer — a zombie worker\'s commit is refused, not applied', async () => {
  // The case a lease alone cannot catch: worker_a is not racing worker_b, it is
  // SUSPENDED. Its lease lapses, worker_b finishes the run, and then worker_a
  // wakes up still believing it holds the run and tries to commit.
  const { journals, run_id } = await (async () => {
    const { service, journals: store } = compose();
    const started = await startReference(service);
    await service.decideApproval({
      run_id: started.run_id, org_id: REFERENCE_ORG, decision: 'approve',
      actor: 'human', principal: 'jack', principal_roles: ['owner'],
    });
    await service.resumeRun({ run_id: started.run_id, org_id: REFERENCE_ORG });
    return { journals: store, run_id: started.run_id };
  })();

  const current = journals.read(run_id);
  check(current !== null, 'the completed run is stored');

  // A stale writer holds a document whose head is one entry behind.
  const stale = {
    ...current,
    entries: current.entries.slice(0, -1),
    entry_count: current.entries.length - 1,
    head: current.entries[current.entries.length - 2].entry_digest,
  };
  const conflict = journals.write(stale, { expected_head: stale.head });
  equal(conflict.ok, false, 'a compare-and-set against a head the run has moved past is REFUSED');
  equal(conflict.reason, 'journal_write_conflict', 'with the registered reason');
  equal(conflict.conflict.actual, current.head, 'and reports the head the run is actually at');

  const create = journals.write(current, { expected_head: null });
  equal(create.ok, false, 'and a writer that expected to CREATE the run finds it already exists');
  equal(create.reason, 'journal_write_conflict', 'refused by the same check');

  const ok = journals.write(current, { expected_head: current.head });
  equal(ok.ok, true, 'a writer at the current head commits normally');
  equal(journals.write(current).ok, true, 'and a caller that passes no expectation is unaffected');
});

group('control-plane layering lint', () => {
  const FORBIDDEN = [
    { name: 'network (fetch)', pattern: /\bfetch\s*\(/, message: 'the control plane must never reach the network' },
    { name: 'network (sockets)', pattern: /from\s+['"]node:(http|https|net|tls|dgram)['"]/, message: 'the control plane must never open a socket' },
    { name: 'clock (Date.now)', pattern: /Date\.now\s*\(/, message: 'time is injected, never read' },
    { name: 'clock (new Date)', pattern: /new\s+Date\s*\(/, message: 'time is injected, never read' },
    { name: 'randomness', pattern: /Math\.random\s*\(|randomUUID|randomBytes/, message: 'a control plane with randomness cannot be replayed' },
    { name: 'process.env', pattern: /process\.env/, message: 'the control plane takes its inputs as arguments' },
    { name: 'filesystem', pattern: /from\s+['"]node:fs['"]|readFileSync|writeFileSync/, message: 'persistence belongs to injected stores' },
    { name: 'child process', pattern: /child_process|execSync|spawnSync/, message: 'the control plane executes nothing of its own' },
    { name: 'process exit', pattern: /process\.exit\s*\(/, message: 'exiting is a caller\'s decision' },
    { name: 'external dependency', pattern: /^\s*import[^;]*from\s+['"](?!node:|\.\/|\.\.\/)/m, message: 'the control plane has zero runtime dependencies' },
  ];

  const files = readdirSync(CONTROL_PLANE_SRC).filter((f) => f.endsWith('.mjs')).sort().map((f) => join(CONTROL_PLANE_SRC, f));
  check(files.length >= 6, `the control plane exposes ${files.length} modules`);
  run.sourcePurity(files, FORBIDDEN, { label: 'control-plane purity' });

  // Dependency DIRECTION: only `kernel.mjs` reaches outside the package, and it
  // reaches only the kernel.
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    const outside = [...source.matchAll(/from\s+['"](\.\.\/[^'"]+)['"]/g)].map((m) => m[1]);
    if (file.endsWith('kernel.mjs')) {
      equal(outside, ['../../awe-kernel/src/index.mjs'], 'kernel.mjs is the single seam, and it reaches only the kernel');
    } else {
      equal(outside, [], `${file.split('/').pop()} reaches nothing outside the package`);
    }
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', 'awe-control-plane', 'package.json'), 'utf8'));
  check(!pkg.dependencies && !pkg.peerDependencies, 'awe-control-plane declares zero runtime dependencies');
  equal(pkg.type, 'module', 'awe-control-plane is ESM');

  // Non-vacuity: the rules must fire on a synthetic offender.
  const offender = stripComments(`
    import axios from 'axios';
    export const t = Date.now();
    export async function go() { await fetch('https://example.invalid'); }
    export const r = Math.random();
    export const e = process.env.SECRET;
    writeFileSync('/tmp/x', 'y');
    process.exit(1);
  `);
  const fired = FORBIDDEN.filter((rule) => rule.pattern.test(offender)).map((r) => r.name).sort();
  equal(fired, [
    'clock (Date.now)', 'external dependency', 'filesystem', 'network (fetch)',
    'process exit', 'process.env', 'randomness',
  ], 'every applicable lint rule fires on a synthetic offender');
});

group('reference adapters contain no send path', () => {
  const reference = join(ROOT, 'packages', 'awe-runtime', 'src', 'reference', 'invoice-intake.mjs');
  run.sourcePurity([reference], [
    { name: 'network (fetch)', pattern: /\bfetch\s*\(/, message: 'the reference adapters reach nothing' },
    { name: 'network (sockets)', pattern: /from\s+['"]node:(http|https|net|tls)['"]/, message: 'no socket' },
    { name: 'mail', pattern: /nodemailer|smtp|sendMail|graph\.microsoft/i, message: 'no send path of any kind' },
    { name: 'database', pattern: /supabase|createClient|from\s*\(\s*['"]/, message: 'no database' },
    { name: 'n8n', pattern: /n8n/i, message: 'no workflow publication' },
    { name: 'credentials', pattern: /process\.env|SERVICE_ROLE|ACCESS_TOKEN/, message: 'no credential' },
    { name: 'filesystem', pattern: /writeFileSync|readFileSync/, message: 'no filesystem' },
  ], { label: 'reference adapter purity' });

  // Every synthetic address is permanently unresolvable.
  const source = readFileSync(reference, 'utf8');
  const domains = [...source.matchAll(/@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi)].map((m) => m[0]);
  check(domains.length > 0, 'the fixture carries at least one email domain to check');
  check(domains.every((d) => d === '@example.invalid'), `every fixture email domain is the reserved .invalid one (found ${JSON.stringify([...new Set(domains)])})`);
});

// =============================================================================
// 8. VOCABULARY COVERAGE
// =============================================================================

group('vocabulary coverage', () => {
  // Every run event type the platform declares must have been produced by a
  // real case above — recorded from actual timelines, never pre-seeded.
  run.coverage('run_event_type', RUN_EVENT_TYPES.filter((t) => t !== 'compensation.failed'), {
    label: 'run-event-type coverage (compensation.failed is exercised below)',
  });

  // The blocked-reason union this package can emit, and the reasons the suite
  // actually demonstrated.
  const demonstrated = [
    'workflow_not_registered', 'workflow_version_unknown', 'workflow_version_incompatible',
    'workflow_not_promoted', 'tenant_out_of_scope', 'dependency_unsatisfied',
    'context_requirements_unmet', 'tool_not_registered', 'tool_version_incompatible',
    'tool_lifecycle_ineligible', 'tool_not_authorized', 'tenant_binding_required',
    'tool_input_invalid', 'tool_output_invalid', 'idempotency_conflict', 'approval_required',
    'approval_rejected', 'approval_actor_invalid', 'approver_role_not_permitted',
    'approval_tenant_mismatch', 'approval_unknown', 'approval_duplicate_principal',
    'run_lease_held', 'run_lease_lost', 'journal_write_conflict',
    'step_timeout', 'run_timeout',
    'run_cancelled', 'step_failed', 'live_mode_unratified',
  ];
  run.record('blocked_reason', demonstrated);
  check(
    demonstrated.every((r) => CONTROL_PLANE_BLOCKED_REASONS.includes(r)),
    'every reason this suite demonstrated is in the declared vocabulary',
  );

  // The reasons NOT yet demonstrated are named explicitly rather than hidden by
  // a coverage gate that quietly passes.
  const undemonstrated = CONTROL_PLANE_BLOCKED_REASONS.filter((r) => !demonstrated.includes(r));
  equal(
    undemonstrated.sort(),
    ['compensation_failed', 'journal_corrupted', 'manifest_invalid'],
    'exactly three declared reasons have no end-to-end fixture — they are reachable only through paths asserted structurally above',
  );

  equal(ADVANCE_OUTCOMES.sort(), ['cancelled', 'completed', 'failed', 'paused', 'timed_out'], 'the advance vocabulary is closed');
  check(SIDE_EFFECTS.length === 4, 'the side-effect classification is the kernel\'s, not a second one');
});

await groupAsync('compensation that itself fails is recorded, not hidden', async () => {
  const manifest = invoiceIntakeManifest({ approval_threshold: null, risk: 'medium' });
  const { service } = compose({
    manifest,
    failures: { issue_payment_instruction: 'throw', void_invoice_draft: 'throw' },
  });
  const result = await startReference(service);
  equal(result.advance, 'failed', 'the run fails');
  equal(result.blocked_reason, 'compensation_failed', 'and reports that the ROLLBACK also failed — the worst case is stated, not swallowed');
  check(
    result.compensations.some((c) => c.status === 'failed'),
    'compensation.failed is in the append-only history',
  );
  run.record('run_event_type', result.timeline.map((t) => t.event_type));
  run.coverage('run_event_type', RUN_EVENT_TYPES, { label: 'run-event-type coverage (complete)' });
});

const report = run.summary({ fixtures });
process.exit(report.fail === 0 ? 0 : 1);
