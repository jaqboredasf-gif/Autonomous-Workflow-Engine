#!/usr/bin/env node
// Runner A — provider-neutral autonomous agent runtime.
// Pure offline: fixture adapters only, virtual clocks, no credentials/network/DB.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleContext, canonicalJson, createExecutionContext, createGateRun,
  defineTool, memoryArtifactSink, memoryAuditSink,
} from '../packages/awe-kernel/src/index.mjs';
import {
  defineToolGrant, defineWorkflowManifest,
} from '../packages/awe-control-plane/src/index.mjs';
import {
  AGENT_ACTION_KINDS,
  AGENT_EVENT_TYPES,
  AGENT_RUNTIME_BLOCKED_REASONS,
  createAgentRegistry,
  createModelRequest,
  createModelResponse,
  createReplayModelAdapter,
  defineAgentAction,
  defineAgentManifest,
  defineModelAdapter,
  projectAgentTranscript,
  verifyAgentTranscript,
} from '../packages/awe-agent-runtime/src/index.mjs';
import {
  createAgentService, createSteppingClock,
} from '../packages/awe-runtime/src/index.mjs';
import {
  OPERATIONS_ORG,
  OTHER_OPERATIONS_ORG,
  createOperationsAgentFixture,
  operationsAgent,
  operationsAgentContext,
  operationsGrants,
  operationsRunRequest,
  operationsTools,
  operationsValidators,
  operationsWorkflow,
} from '../packages/awe-runtime/src/reference/operations-agent.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_SRC = join(ROOT, 'packages', 'awe-agent-runtime', 'src');
const run = createGateRun({ name: 'eval-agent-runtime (Runner A, offline, deterministic)' });
const { check, equal, section } = run;
let fixtures = 0;

function group(title, body) {
  section(title);
  try { body(); } catch (e) { check(false, `${title}: threw unexpectedly — ${e?.stack ?? e}`); }
}
async function groupAsync(title, body) {
  section(title);
  try { await body(); } catch (e) { check(false, `${title}: threw unexpectedly — ${e?.stack ?? e}`); }
}
function withoutDigest(value, key) {
  const copy = JSON.parse(canonicalJson(value));
  delete copy[key];
  return copy;
}
function sequenceModel(actions, {
  profile = 'operations_fixture',
  usage = { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
  model_ref = 'fixture:sequence:v1',
} = {}) {
  return defineModelAdapter({
    profile,
    invoke(request) {
      const action = actions[Math.min(request.turn - 1, actions.length - 1)];
      return { model_ref, action, usage };
    },
  });
}
function compose({
  agent = operationsAgent,
  workflow = operationsWorkflow,
  models = null,
  grants = operationsGrants(),
  tools = null,
  clock = createSteppingClock(),
  calls = [],
  run_store = null,
} = {}) {
  fixtures += 1;
  const service = createAgentService({
    agents: [agent],
    workflows: [workflow],
    tools: tools ?? operationsTools({ calls }),
    grants,
    validators: operationsValidators,
    models: models ?? [sequenceModel([
      { kind: 'finish', reason_code: 'done', result: { ok: true }, summary: 'Done.' },
    ])],
    clock,
    artifacts: memoryArtifactSink(),
    audit: memoryAuditSink(),
    run_store,
  });
  return { service, clock, calls };
}
function recordEvents(result) {
  run.record('agent_event_type', result.transcript.entries.map((entry) => entry.event.event_type));
  return result;
}

group('agent manifest — versioned, closed and self-authenticating', () => {
  equal(operationsAgent.schema, 'awe.agent_manifest/v1', 'manifest schema is pinned');
  equal(operationsAgent.version, '1.0.0', 'agent version is pinned');
  equal(operationsAgent.workflow, { workflow_id: 'operations_investigation', version: '1.0.0' }, 'workflow contract is pinned');
  equal(operationsAgent.allowed_tools, ['lookup_case', 'lookup_policy'], 'tool allow-list is explicit and sorted');
  check(operationsAgent.manifest_digest.length > 0, 'manifest has a content digest');
  check(Object.isFrozen(operationsAgent), 'manifest is deeply frozen');
  run.deterministic(
    () => defineAgentManifest(withoutDigest(operationsAgent, 'manifest_digest')),
    'agent manifest construction is deterministic',
  );

  const base = () => withoutDigest(operationsAgent, 'manifest_digest');
  run.throwsKernel(() => defineAgentManifest({ ...base(), unknown: true }), 'invalid_input', 'unknown manifest keys are refused');
  run.throwsKernel(() => defineAgentManifest({ ...base(), lifecycle: undefined }), 'invalid_input', 'lifecycle is required');
  run.throwsKernel(() => defineAgentManifest({ ...base(), version: '1.0' }), 'invalid_input', 'unpinned version is refused');
  run.throwsKernel(() => defineAgentManifest({ ...base(), allowed_tools: [] }), 'invalid_input', 'empty tool surface is refused');
  run.throwsKernel(() => defineAgentManifest({ ...base(), allowed_tools: ['lookup_case', 'lookup_case'] }), 'invalid_input', 'duplicate allowed tool is refused');
  run.throwsKernel(
    () => defineAgentManifest({ ...base(), limits: { ...base().limits, max_model_calls: 5, max_turns: 4 } }),
    'invalid_input', 'incoherent turn/model limits are refused',
  );
});

group('agent action and model envelopes — every boundary validates at runtime', () => {
  const tool = defineAgentAction({
    kind: 'tool', reason_code: 'facts_needed', tool: 'lookup_case', input: { case_id: 'case_1042' },
  });
  const finish = defineAgentAction({
    kind: 'finish', reason_code: 'complete', result: { answer: 42 }, summary: 'Complete.',
  });
  const human = defineAgentAction({
    kind: 'request_human', reason_code: 'ambiguity', prompt: 'Which account should be used?',
  });
  equal([tool.kind, finish.kind, human.kind], AGENT_ACTION_KINDS, 'all action kinds build');
  check(tool.action_digest !== finish.action_digest, 'different actions have different identities');
  run.throwsKernel(
    () => defineAgentAction({ kind: 'tool', reason_code: 'x', tool: 'lookup_case', input: {}, reasoning: 'hidden chain' }),
    'invalid_input', 'free-form reasoning is not part of the action contract',
  );
  run.throwsKernel(
    () => defineAgentAction({ kind: 'finish', reason_code: 'x', result: undefined, summary: 'x' }),
    'invalid_input', 'undefined result is refused',
  );

  const request = createModelRequest({
    run_id: 'model_contract_1',
    agent: { agent_id: 'a', version: '1.0.0', manifest_digest: 'manifest_1' },
    turn: 1,
    instructions: { version: '1.0.0', text: 'Finish.' },
    context_bundle: assembleContext({
      context: createExecutionContext({
        run_id: 'model_contract_1',
        workflow_id: 'operations_investigation',
        org_id: OPERATIONS_ORG,
        actor: 'service',
        mode: 'TEST',
        is_fixture: true,
        started_at: '2026-07-28T13:00:00.000Z',
      }),
      items: operationsAgentContext(),
      assembled_at: '2026-07-28T13:00:00.000Z',
    }),
    tools: [operationsTools()[0].descriptor],
    budget: {
      turns_remaining: 1, model_calls_remaining: 1, tool_calls_remaining: 0, tokens_remaining: 10,
    },
  });
  const response = createModelResponse({
    request_digest: request.request_digest,
    model_ref: 'fixture:model:v1',
    action: finish,
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });
  equal(response.request_digest, request.request_digest, 'response is bound to its request');
  check(response.response_digest.length > 0, 'response is content-addressed');
  run.throwsKernel(
    () => createModelResponse({
      request_digest: request.request_digest,
      model_ref: 'x',
      action: finish,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 99 },
    }),
    'invalid_input', 'inconsistent usage accounting is refused',
  );
});

group('agent registry — version and lifecycle resolution', () => {
  const draft = defineAgentManifest({
    ...withoutDigest(operationsAgent, 'manifest_digest'),
    version: '1.1.0',
    lifecycle: 'draft',
  });
  const registry = createAgentRegistry([operationsAgent, draft]);
  equal(registry.resolve({ agent_id: 'operations_investigator' }).manifest.version, '1.0.0', 'newer draft cannot displace active agent');
  equal(registry.resolve({ agent_id: 'missing' }).reason, 'agent_not_registered', 'unknown agent is a resolution refusal');
  equal(registry.resolve({ agent_id: 'operations_investigator', version: '9.0.0' }).reason, 'agent_version_unknown', 'unknown version is refused');
  equal(registry.resolve({ agent_id: 'operations_investigator', version: '1.1.0' }).reason, 'agent_not_executable', 'draft agent is not executable');
  run.throwsKernel(() => createAgentRegistry([operationsAgent, operationsAgent]), 'invalid_input', 'duplicate agent version is refused');
});

await groupAsync('end to end — context → model → controlled tools → result', async () => {
  const calls = [];
  const { service } = createOperationsAgentFixture({
    clock: createSteppingClock(),
    calls,
    artifacts: memoryArtifactSink(),
    audit: memoryAuditSink(),
  });
  const result = recordEvents(await service.submit(operationsRunRequest()));
  equal(result.outcome.status, 'ok', 'reference agent completes');
  equal(result.final_state, 'completed', 'kernel run report reaches completed');
  equal(result.projection.state, 'completed', 'transcript projection reaches completed');
  equal(result.projection.counts, { turns: 3, model_calls: 3, tool_calls: 2, total_tokens: 90 }, 'all budgets are metered');
  equal(calls.map((call) => call.tool), ['lookup_case', 'lookup_policy'], 'model actions invoked the expected tools');
  check(calls.every((call) => call.org_id === OPERATIONS_ORG), 'every tool invocation carries the run tenant');
  equal(result.context_bundle.items.filter((item) => item.kind === 'tool_result').length, 2, 'tool outputs re-enter context');
  check(
    result.context_bundle.items.filter((item) => item.kind === 'tool_result').every((item) => item.trusted === false && item.org_id === OPERATIONS_ORG),
    'tool-derived context stays tenant-bound and untrusted',
  );
  equal(result.persistence.ok, true, 'agent transcript and replay records persist');
  equal(service.inspect({ run_id: result.report.run_id, org_id: OPERATIONS_ORG }).run_id, result.report.run_id, 'run is inspectable by its tenant');
  equal(service.inspect({ run_id: result.report.run_id, org_id: OTHER_OPERATIONS_ORG }), null, 'another tenant cannot inspect the run');
  equal(service.list({ org_id: OPERATIONS_ORG }), [result.report.run_id], 'tenant list contains its run');
  verifyAgentTranscript(result.transcript);
  equal(projectAgentTranscript(result.transcript), result.projection, 'projection is derived from transcript, not stored state');
  check(result.outcome.events.every((event) => typeof event.event_key === 'string'), 'every path emits canonical structured events');
});

await groupAsync('deterministic replay — no model or tool implementation is consulted', async () => {
  const firstFixture = createOperationsAgentFixture({ clock: createSteppingClock() });
  const first = recordEvents(await firstFixture.service.submit(operationsRunRequest({ run_id: 'agent_replay_001' })));
  const replayAdapter = createReplayModelAdapter({
    profile: 'operations_fixture',
    records: first.model_records,
  });
  const secondCalls = [];
  const secondFixture = createOperationsAgentFixture({
    clock: createSteppingClock(),
    calls: secondCalls,
    models: [replayAdapter],
  });
  const second = recordEvents(await secondFixture.service.submit(operationsRunRequest({ run_id: 'agent_replay_001' })));
  equal(second.outcome.data, first.outcome.data, 'replayed outcome is exact');
  equal(second.transcript.transcript_digest, first.transcript.transcript_digest, 'replayed transcript is byte-identical');
  equal(second.model_records, first.model_records, 'captured model records are exact');
  equal(secondCalls.length, 2, 'full simulation reruns fixture tools through the controlled boundary');
  equal(firstFixture.service.replay(first.transcript), first.projection, 'transcript-only replay invokes neither models nor tools');
});

await groupAsync('bounded execution — token, tool and human limits terminate explicitly', async () => {
  const highUsage = sequenceModel([
    { kind: 'finish', reason_code: 'done', result: {}, summary: 'Done.' },
  ], { usage: { input_tokens: 6, output_tokens: 6, total_tokens: 12 } });
  const tinyBudgetAgent = defineAgentManifest({
    ...withoutDigest(operationsAgent, 'manifest_digest'),
    limits: { ...operationsAgent.limits, max_total_tokens: 10 },
  });
  const exhausted = recordEvents(await compose({
    agent: tinyBudgetAgent,
    models: [highUsage],
  }).service.submit(operationsRunRequest({ run_id: 'agent_budget_tokens' })));
  equal(exhausted.outcome.blocked_reason, 'agent_budget_exhausted', 'token overflow blocks explicitly');

  const zeroToolAgent = defineAgentManifest({
    ...withoutDigest(operationsAgent, 'manifest_digest'),
    limits: { ...operationsAgent.limits, max_tool_calls: 0 },
  });
  const toolAttempt = recordEvents(await compose({
    agent: zeroToolAgent,
    models: [sequenceModel([
      { kind: 'tool', reason_code: 'need_case', tool: 'lookup_case', input: { case_id: 'case_1042' } },
    ])],
  }).service.submit(operationsRunRequest({ run_id: 'agent_budget_tools' })));
  equal(toolAttempt.outcome.blocked_reason, 'agent_budget_exhausted', 'tool budget is enforced before dispatch');

  const human = recordEvents(await compose({
    models: [sequenceModel([
      { kind: 'request_human', reason_code: 'ambiguous', prompt: 'Choose the customer account.' },
    ])],
  }).service.submit(operationsRunRequest({ run_id: 'agent_human_001' })));
  equal(human.outcome.blocked_reason, 'human_input_required', 'agent can make a typed human handoff');
  equal(human.projection.state, 'blocked', 'human handoff projects as blocked');
});

await groupAsync('fail closed — resolution, tenant, policy, allow-list and model contracts', async () => {
  const unknown = recordEvents(await compose().service.submit({
    ...operationsRunRequest({ run_id: 'agent_unknown_001' }),
    agent_id: 'missing_agent',
  }));
  equal(unknown.outcome.blocked_reason, 'agent_not_registered', 'unknown agent is a structured blocked outcome');

  const wrongModelAgent = defineAgentManifest({
    ...withoutDigest(operationsAgent, 'manifest_digest'),
    model_profile: 'unregistered_model',
  });
  const noModel = recordEvents(await compose({ agent: wrongModelAgent }).service.submit(
    operationsRunRequest({ run_id: 'agent_model_missing' }),
  ));
  equal(noModel.outcome.blocked_reason, 'agent_model_unavailable', 'unregistered model profile is refused');

  const live = recordEvents(await compose().service.submit({
    ...operationsRunRequest({ run_id: 'agent_live_refused' }),
    mode: 'LIVE',
    is_fixture: false,
  }));
  equal(live.outcome.blocked_reason, 'live_mode_unratified', 'agent runtime inherits the control-plane LIVE refusal');

  const foreignContext = recordEvents(await compose().service.submit({
    ...operationsRunRequest({ run_id: 'agent_foreign_context' }),
    context_items: operationsAgentContext({ org_id: OTHER_OPERATIONS_ORG }),
  }));
  equal(foreignContext.outcome.status, 'failed', 'cross-tenant context fails the run');
  equal(foreignContext.outcome.error.code, 'contract_violation', 'cross-tenant context is a contract violation');

  const denied = recordEvents(await compose({
    grants: operationsGrants({ org_id: OTHER_OPERATIONS_ORG }),
    models: [sequenceModel([
      { kind: 'tool', reason_code: 'need_case', tool: 'lookup_case', input: { case_id: 'case_1042' } },
    ])],
  }).service.submit(operationsRunRequest({ run_id: 'agent_policy_denied' })));
  equal(denied.outcome.blocked_reason, 'tool_not_authorized', 'tool dispatcher remains deny by default');

  const unlisted = recordEvents(await compose({
    models: [sequenceModel([
      { kind: 'tool', reason_code: 'delete_it', tool: 'delete_case', input: { case_id: 'case_1042' } },
    ])],
  }).service.submit(operationsRunRequest({ run_id: 'agent_unlisted_tool' })));
  equal(unlisted.outcome.blocked_reason, 'agent_tool_not_allowed', 'agent allow-list blocks invented tools before dispatch');

  const mismatchedTools = operationsTools().map((entry) => (entry.descriptor.name === 'lookup_case'
    ? {
      descriptor: defineTool({
        ...withoutDigest(entry.descriptor, 'descriptor_digest'),
        workflow_id: 'different_workflow',
      }),
      adapter: entry.adapter,
    }
    : entry));
  const mismatched = recordEvents(await compose({ tools: mismatchedTools }).service.submit(
    operationsRunRequest({ run_id: 'agent_descriptor_mismatch' }),
  ));
  equal(mismatched.outcome.blocked_reason, 'agent_contract_incompatible', 'tool descriptors bound to another workflow are refused');

  const malformed = defineModelAdapter({
    profile: 'operations_fixture',
    invoke: () => ({
      model_ref: 'fixture:malformed',
      action: { kind: 'finish', result: {}, summary: 'Missing reason code.' },
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  });
  const badModel = recordEvents(await compose({ models: [malformed] }).service.submit(
    operationsRunRequest({ run_id: 'agent_bad_model' }),
  ));
  equal(badModel.outcome.status, 'failed', 'malformed model action cannot escape as success');
  equal(badModel.outcome.error.code, 'invalid_input', 'model contract failure is typed');
});

await groupAsync('tool failures — output validation and adapter exceptions are events', async () => {
  const baseTools = operationsTools();
  const badOutputTools = baseTools.map((entry) => (entry.descriptor.name === 'lookup_case'
    ? { descriptor: entry.descriptor, adapter: () => ({ unexpected: true }) }
    : entry));
  const action = { kind: 'tool', reason_code: 'need_case', tool: 'lookup_case', input: { case_id: 'case_1042' } };
  const invalidOutput = recordEvents(await compose({
    tools: badOutputTools,
    models: [sequenceModel([action])],
  }).service.submit(operationsRunRequest({ run_id: 'agent_bad_tool_output' })));
  equal(invalidOutput.outcome.blocked_reason, 'tool_output_invalid', 'invalid tool output is blocked');

  const throwingTools = baseTools.map((entry) => (entry.descriptor.name === 'lookup_case'
    ? { descriptor: entry.descriptor, adapter: () => { throw new Error('fixture adapter failed'); } }
    : entry));
  const thrown = recordEvents(await compose({
    tools: throwingTools,
    models: [sequenceModel([action])],
  }).service.submit(operationsRunRequest({ run_id: 'agent_tool_throw' })));
  equal(thrown.outcome.status, 'failed', 'adapter exception fails explicitly');
  check(thrown.transcript.entries.some((entry) => entry.event.event_type === 'agent.tool.failed'), 'tool failure is a structured event');
});

await groupAsync('approval integration — agents pause; only a valid human receipt proceeds', async () => {
  const gatedWorkflow = defineWorkflowManifest({
    ...withoutDigest(operationsWorkflow, 'manifest_digest'),
    approval_policy: {
      requires_approval_at_or_above: 'read',
      approver_roles: ['owner'],
      quorum: 1,
    },
    risk: 'medium',
  });
  const gatedGrants = ['lookup_case', 'lookup_policy'].map((tool) => defineToolGrant({
    org_id: OPERATIONS_ORG,
    workflow_id: 'operations_investigation',
    tool,
    version: '1.0.0',
    max_side_effect: 'read',
    requires_approval_at_or_above: 'read',
    approver_roles: ['owner'],
  }));
  const firstAction = defineAgentAction({
    kind: 'tool', reason_code: 'need_case', tool: 'lookup_case', input: { case_id: 'case_1042' },
  });
  const model = sequenceModel([
    firstAction,
    { kind: 'finish', reason_code: 'done', result: { approved: true }, summary: 'Approved lookup completed.' },
  ]);

  const paused = recordEvents(await compose({
    workflow: gatedWorkflow, grants: gatedGrants, models: [model],
  }).service.submit(operationsRunRequest({ run_id: 'agent_approval_pause' })));
  equal(paused.outcome.blocked_reason, 'approval_required', 'consequential action pauses for approval');
  check(paused.transcript.entries.some((entry) => entry.event.event_type === 'agent.human.requested'), 'approval pause emits human request');

  const selfApproval = recordEvents(await compose({
    workflow: gatedWorkflow, grants: gatedGrants, models: [model],
  }).service.submit({
    ...operationsRunRequest({ run_id: 'agent_self_approval' }),
    approvals: [{
      action_digest: firstAction.action_digest,
      decision: 'approve',
      actor: 'service',
      principal: 'automation',
      principal_roles: ['owner'],
      org_id: OPERATIONS_ORG,
    }],
  }));
  equal(selfApproval.outcome.blocked_reason, 'approval_actor_invalid', 'automation cannot approve its own tool action');

  const calls = [];
  const approved = recordEvents(await compose({
    workflow: gatedWorkflow, grants: gatedGrants, models: [model], calls,
  }).service.submit({
    ...operationsRunRequest({ run_id: 'agent_human_approval' }),
    approvals: [{
      action_digest: firstAction.action_digest,
      decision: 'approve',
      actor: 'human',
      principal: 'fixture_owner',
      principal_roles: ['owner'],
      org_id: OPERATIONS_ORG,
    }],
  }));
  equal(approved.outcome.status, 'ok', 'valid human approval lets the action proceed');
  equal(calls.length, 1, 'approved tool executes exactly once');
});

group('transcript integrity — chain tampering and identity drift are refused', () => {
  const transcript = {
    schema: 'awe.agent_transcript/v1',
    run_id: 'x',
    agent_id: 'a',
    agent_version: '1.0.0',
    org_id: OPERATIONS_ORG,
    entries: [],
    entry_count: 0,
    head_digest: null,
  };
  // A hand-built digest still cannot validate malformed body fields through a
  // public API; the real tamper case below starts with an actual run.
  run.throwsKernel(() => verifyAgentTranscript({ ...transcript, transcript_digest: 'fake' }), 'contract_violation', 'invented transcript digest is refused');
});

await groupAsync('transcript integrity — an altered historical payload is detected', async () => {
  const result = await createOperationsAgentFixture({ clock: createSteppingClock() }).service.submit(
    operationsRunRequest({ run_id: 'agent_tamper_001' }),
  );
  const tampered = JSON.parse(canonicalJson(result.transcript));
  tampered.entries[1].event.payload.item_count = 999;
  run.throwsKernel(() => verifyAgentTranscript(tampered), 'contract_violation', 'tampered event payload breaks the transcript');
});

group('layering and fixture purity — provider neutrality is structural', () => {
  const files = readdirSync(AGENT_SRC).filter((file) => file.endsWith('.mjs')).map((file) => join(AGENT_SRC, file));
  run.sourcePurity(files, [
    { name: 'network', pattern: /\bfetch\s*\(|from\s+['"]node:(http|https|net|tls)['"]/, message: 'runtime reaches no provider or network' },
    { name: 'filesystem', pattern: /from\s+['"]node:fs['"]|writeFileSync|readFileSync/, message: 'runtime performs no filesystem I/O' },
    { name: 'ambient clock', pattern: /\bDate\.now\s*\(|new\s+Date\s*\(/, message: 'time is injected' },
    { name: 'ambient environment', pattern: /process\.env/, message: 'runtime reads no credentials or config' },
    { name: 'database', pattern: /supabase|createClient|postgres/i, message: 'runtime owns no persistence provider' },
    { name: 'provider SDK', pattern: /anthropic|openai|gemini|bedrock/i, message: 'model providers stay behind adapters' },
    { name: 'upper layer import', pattern: /from\s+['"][^'"]*(apps|scripts|awe-runtime)/, message: 'agent runtime depends only downward' },
  ], { label: 'agent-runtime purity' });

  const reference = join(ROOT, 'packages', 'awe-runtime', 'src', 'reference', 'operations-agent.mjs');
  const source = readFileSync(reference, 'utf8');
  check(!/\bfetch\s*\(|process\.env|supabase|n8n|writeFile/i.test(source), 'reference example has no network, credentials, DB, n8n or writes');
});

group('vocabulary coverage', () => {
  run.coverage('agent_event_type', AGENT_EVENT_TYPES, { label: 'agent-event-type coverage' });
  equal(
    AGENT_RUNTIME_BLOCKED_REASONS,
    [
      'agent_not_registered', 'agent_version_unknown', 'agent_not_executable',
      'agent_workflow_unavailable', 'agent_contract_incompatible',
      'agent_model_unavailable', 'agent_tool_not_allowed',
      'agent_budget_exhausted', 'human_input_required',
    ],
    'agent-owned blocked reason vocabulary is closed',
  );
});

const report = run.summary({ fixtures });
process.exit(report.fail === 0 ? 0 : 1);
