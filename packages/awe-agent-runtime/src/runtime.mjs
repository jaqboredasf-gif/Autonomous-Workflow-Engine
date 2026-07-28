import {
  ERROR_CODES,
  assertContextBundle,
  assertOutcome,
  assertReport,
  assembleContext,
  blocked,
  canonicalJson,
  createContextItem,
  createExecutionContext,
  createToolCatalog,
  deepFreeze,
  digest,
  failed,
  invariant,
  isPlainObject,
  redact,
  runWorkflow,
  succeeded,
} from '../../awe-kernel/src/index.mjs';
import {
  createPolicyEngine,
  createToolDispatcher,
  createWorkflowRegistry,
  evaluateApprovalDecision,
  validateContextRequirements,
} from '../../awe-control-plane/src/index.mjs';
import { createAgentRegistry } from './agent-registry.mjs';
import { assertAgentAction } from './action.mjs';
import { assertModelResponse, createModelRegistry, createModelRequest } from './model.mjs';
import {
  AGENT_RUN_DOCUMENT_SCHEMA, createMemoryAgentRunStore, defineAgentRunStore,
} from './run-store.mjs';
import {
  createAgentTranscript, projectAgentTranscript, verifyAgentTranscript,
} from './transcript.mjs';

export const AGENT_RUNTIME_BLOCKED_REASONS = [
  'agent_not_registered',
  'agent_version_unknown',
  'agent_not_executable',
  'agent_workflow_unavailable',
  'agent_contract_incompatible',
  'agent_model_unavailable',
  'agent_tool_not_allowed',
  'agent_budget_exhausted',
  'human_input_required',
];
export const AGENT_RUN_RESULT_SCHEMA = 'awe.agent_run_result/v1';
export const AGENT_RUN_RESULT_KEYS = [
  'schema', 'outcome', 'report', 'artifact', 'audit_result', 'final_state',
  'duplicates', 'context_bundle', 'transcript', 'projection', 'model_records',
  'persistence',
];

const RUN_REQUEST_KEYS = [
  'agent_id', 'version', 'run_id', 'org_id', 'actor', 'mode', 'is_fixture',
  'started_at', 'deadline_at', 'finished_at', 'trace_id', 'attributes',
  'context_items', 'approvals', 'deps',
];
const APPROVAL_KEYS = [
  'action_digest', 'decision', 'actor', 'principal', 'principal_roles', 'org_id',
];

function validateRunRequest(request) {
  invariant(isPlainObject(request), 'invalid_input', 'agent run request must be a plain object', {});
  const unknown = Object.keys(request).filter((key) => !RUN_REQUEST_KEYS.includes(key));
  invariant(unknown.length === 0, 'invalid_input', `agent run request has unknown key(s) ${JSON.stringify(unknown.sort())}`, { unknown });
  for (const key of ['agent_id', 'run_id', 'org_id']) invariant(typeof request[key] === 'string' && request[key].length > 0, 'invalid_input', `agent run request needs ${key}`, {});
  invariant(request.version === undefined || request.version === null || typeof request.version === 'string', 'invalid_input', 'agent version must be a string or null', {});
  invariant(Array.isArray(request.context_items ?? []), 'invalid_input', 'context_items must be an array', {});
  invariant(Array.isArray(request.approvals ?? []), 'invalid_input', 'approvals must be an array', {});
  for (const approval of request.approvals ?? []) {
    invariant(isPlainObject(approval), 'invalid_input', 'approval receipt must be a plain object', {});
    invariant(Object.keys(approval).every((key) => APPROVAL_KEYS.includes(key)), 'invalid_input', 'approval receipt has unknown keys', {});
    for (const key of APPROVAL_KEYS) invariant(Object.prototype.hasOwnProperty.call(approval, key), 'invalid_input', `approval receipt missing '${key}'`, {});
    invariant(typeof approval.action_digest === 'string' && approval.action_digest.length > 0, 'invalid_input', 'approval receipt needs action_digest', {});
    invariant(['approve', 'reject'].includes(approval.decision), 'invalid_input', `approval decision '${approval.decision}' is invalid`, {});
    invariant(['human', 'service'].includes(approval.actor), 'invalid_input', `approval actor '${approval.actor}' is invalid`, {});
    invariant(approval.principal === null || (typeof approval.principal === 'string' && approval.principal.length > 0), 'invalid_input', 'approval principal must be a string or null', {});
    invariant(Array.isArray(approval.principal_roles), 'invalid_input', 'approval principal_roles must be an array', {});
    invariant(approval.principal_roles.every((role) => typeof role === 'string' && /^[a-z][a-z0-9_]*$/.test(role)), 'invalid_input', 'approval roles must be snake_case strings', {});
    invariant(typeof approval.org_id === 'string' && approval.org_id.length > 0, 'invalid_input', 'approval receipt needs org_id', {});
  }
  invariant(isPlainObject(request.attributes ?? {}), 'invalid_input', 'attributes must be a plain object', {});
  invariant(isPlainObject(request.deps ?? {}), 'invalid_input', 'deps must be a plain object', {});
  return request;
}

function safeFailure(e) {
  const code = ERROR_CODES.includes(e?.code) ? e.code : 'contract_violation';
  const detail = String(redact(String(e?.message ?? e))).slice(0, 500);
  return { code, detail };
}

export function assertAgentRunResult(result, where = {}) {
  invariant(isPlainObject(result), 'contract_violation', 'agent run result must be a plain object', where);
  for (const key of AGENT_RUN_RESULT_KEYS) {
    invariant(Object.prototype.hasOwnProperty.call(result, key), 'contract_violation', `agent run result missing '${key}'`, {
      ...where, key,
    });
  }
  invariant(Object.keys(result).every((key) => AGENT_RUN_RESULT_KEYS.includes(key)), 'contract_violation', 'agent run result has unknown keys', where);
  invariant(result.schema === AGENT_RUN_RESULT_SCHEMA, 'contract_violation', 'agent run result schema is invalid', where);
  assertOutcome(result.outcome, { context: where });
  assertReport(result.report, where);
  if (result.context_bundle !== null) assertContextBundle(result.context_bundle, where);
  verifyAgentTranscript(result.transcript, where);
  invariant(isPlainObject(result.projection) && result.projection.run_id === result.report.run_id, 'contract_violation', 'agent run projection identity is invalid', where);
  invariant(Array.isArray(result.model_records), 'contract_violation', 'agent run model_records must be an array', where);
  result.model_records.forEach((record, index) => {
    invariant(isPlainObject(record) && typeof record.request_digest === 'string', 'contract_violation', `agent run model record ${index} is invalid`, where);
    assertModelResponse(record.response, { ...where, request_digest: record.request_digest, index });
  });
  invariant(isPlainObject(result.persistence) && typeof result.persistence.ok === 'boolean', 'contract_violation', 'agent run persistence result is invalid', where);
  return result;
}

function toolResultItem({ context, action, invocation, turn, occurred_at }) {
  return createContextItem({
    id: `tool:${turn}:${action.tool}:${digest(invocation.idempotency_key ?? action.action_digest)}`,
    kind: 'tool_result',
    source: 'agent_runtime',
    org_id: context.org_id,
    sensitivity: 'confidential',
    trusted: false,
    priority: 800,
    occurred_at,
    content: canonicalJson({
      tool: action.tool,
      action_digest: action.action_digest,
      result: invocation.data,
      replayed: invocation.replayed,
    }),
    provenance: {
      run_id: context.run_id,
      tool: action.tool,
      descriptor_digest: invocation.descriptor.descriptor_digest,
      idempotency_key: invocation.idempotency_key,
    },
  });
}

export function createAgentRuntime(options = {}) {
  invariant(isPlainObject(options), 'invalid_input', 'agent runtime options must be a plain object', {});
  const optionKeys = [
    'agents', 'workflows', 'tools', 'grants', 'validators', 'models', 'clock',
    'artifacts', 'audit', 'run_store',
  ];
  const unknownOptions = Object.keys(options).filter((key) => !optionKeys.includes(key));
  invariant(unknownOptions.length === 0, 'invalid_input', `agent runtime options have unknown key(s) ${JSON.stringify(unknownOptions.sort())}`, {
    unknown: unknownOptions.sort(),
  });
  const {
    agents = [],
    workflows = [],
    tools = [],
    grants = [],
    validators = {},
    models = [],
    clock,
    artifacts = null,
    audit = null,
    run_store = null,
  } = options;
  for (const [label, value] of Object.entries({ agents, workflows, tools, grants, models })) {
    invariant(Array.isArray(value), 'invalid_input', `agent runtime ${label} must be an array`, {});
  }
  invariant(typeof clock === 'function', 'invalid_input', 'agent runtime requires an injected clock()', {});
  invariant(isPlainObject(validators), 'invalid_input', 'agent runtime validators must be a plain object', {});
  const agentRegistry = createAgentRegistry(agents);
  const workflowRegistry = createWorkflowRegistry(workflows);
  const toolCatalog = createToolCatalog(tools);
  const modelRegistry = createModelRegistry(models);
  const policy = createPolicyEngine({ grants, allow_live: false });
  const dispatcher = createToolDispatcher({ catalog: toolCatalog, policy, validators, clock });
  const store = run_store === null
    ? createMemoryAgentRunStore()
    : defineAgentRunStore(run_store);

  function resolveContract(agent, org_id) {
    const workflow = workflowRegistry.resolve({
      workflow_id: agent.workflow.workflow_id,
      version: agent.workflow.version,
      org_id,
    });
    if (!workflow.ok) return { ok: false, reason: 'agent_workflow_unavailable', detail: `${workflow.reason}: ${workflow.detail}` };
    const required = new Set(workflow.manifest.required_tools.map((tool) => tool.name));
    const missingFromWorkflow = agent.allowed_tools.filter((tool) => !required.has(tool));
    const missingFromCatalog = agent.allowed_tools.filter((tool) => !toolCatalog.has(tool));
    const wrongWorkflow = agent.allowed_tools.filter(
      (tool) => toolCatalog.has(tool) && toolCatalog.descriptor(tool).workflow_id !== workflow.manifest.workflow_id,
    );
    if (missingFromWorkflow.length > 0 || missingFromCatalog.length > 0 || wrongWorkflow.length > 0) {
      return {
        ok: false,
        reason: 'agent_contract_incompatible',
        detail: `agent tool contract does not resolve (workflow=${JSON.stringify(missingFromWorkflow)}, catalog=${JSON.stringify(missingFromCatalog)}, descriptor_workflow=${JSON.stringify(wrongWorkflow)})`,
      };
    }
    if (!modelRegistry.has(agent.model_profile)) {
      return { ok: false, reason: 'agent_model_unavailable', detail: `model profile '${agent.model_profile}' is not registered` };
    }
    return { ok: true, workflow: workflow.manifest };
  }

  async function run(rawRequest = {}) {
    const request = validateRunRequest(rawRequest);
    const agentResolution = agentRegistry.resolve({
      agent_id: request.agent_id,
      version: request.version ?? null,
    });
    const workflow_id = agentResolution.ok ? agentResolution.manifest.workflow.workflow_id : 'agent_runtime';
    const context = createExecutionContext({
      run_id: request.run_id,
      workflow_id,
      org_id: request.org_id,
      actor: request.actor ?? 'service',
      mode: request.mode ?? 'TEST',
      is_fixture: request.is_fixture ?? true,
      started_at: request.started_at ?? clock(),
      deadline_at: request.deadline_at ?? null,
      trace_id: request.trace_id ?? null,
      attributes: {
        ...(request.attributes ?? {}),
        agent_id: request.agent_id,
        agent_version: agentResolution.ok ? agentResolution.manifest.version : request.version ?? null,
      },
    });
    const transcript = createAgentTranscript({
      run_id: context.run_id,
      agent_id: request.agent_id,
      agent_version: agentResolution.ok ? agentResolution.manifest.version : request.version ?? null,
      org_id: context.org_id,
    });
    const modelRecords = [];
    let finalBundle = null;

    const executed = await runWorkflow({
      context,
      artifacts,
      audit,
      finished_at: request.finished_at ?? clock(),
      summary: {
        subsystem: 'agent_runtime',
        agent_id: request.agent_id,
        agent_manifest_digest: agentResolution.manifest?.manifest_digest ?? null,
      },
      body: async () => {
        transcript.append('agent.run.started', {
          agent_id: request.agent_id,
          agent_version: agentResolution.manifest?.version ?? request.version ?? null,
        }, clock());

        if (context.mode === 'LIVE') {
          transcript.append('agent.resolution.blocked', {
            reason: 'live_mode_unratified',
            detail: 'agent runtime follows the control-plane LIVE refusal until ADR-0002 is ratified',
          }, clock());
          transcript.append('agent.run.blocked', { reason: 'live_mode_unratified' }, clock());
          return blocked('live_mode_unratified', {
            data: { detail: 'LIVE execution is not ratified for the agent runtime' },
            events: transcript.events(),
          });
        }

        if (!agentResolution.ok) {
          transcript.append('agent.resolution.blocked', {
            reason: agentResolution.reason,
            detail: agentResolution.detail,
          }, clock());
          transcript.append('agent.run.blocked', { reason: agentResolution.reason }, clock());
          return blocked(agentResolution.reason, {
            data: { detail: agentResolution.detail },
            events: transcript.events(),
          });
        }
        const agent = agentResolution.manifest;
        const contract = resolveContract(agent, context.org_id);
        if (!contract.ok) {
          transcript.append('agent.resolution.blocked', { reason: contract.reason, detail: contract.detail }, clock());
          transcript.append('agent.run.blocked', { reason: contract.reason }, clock());
          return blocked(contract.reason, { data: { detail: contract.detail }, events: transcript.events() });
        }
        const manifest = contract.workflow;
        const contextItems = [...(request.context_items ?? [])];
        const counts = { turns: 0, model_calls: 0, tool_calls: 0, total_tokens: 0 };

        const assemble = () => {
          finalBundle = assembleContext({
            context,
            items: contextItems,
            budget: { max_tokens: agent.context.max_tokens, max_items: agent.context.max_items },
            max_sensitivity: agent.context.max_sensitivity,
            assembled_at: clock(),
          });
          transcript.append('agent.context.assembled', {
            bundle_digest: finalBundle.bundle_digest,
            item_count: finalBundle.item_count,
            token_count: finalBundle.token_count,
            exclusion_count: finalBundle.exclusions.length,
          }, clock());
          return finalBundle;
        };

        try {
          assemble();
          const requirements = validateContextRequirements(manifest, finalBundle);
          if (!requirements.ok) {
            transcript.append('agent.resolution.blocked', {
              reason: 'context_requirements_unmet',
              unmet: requirements.unmet,
            }, clock());
            transcript.append('agent.run.blocked', { reason: 'context_requirements_unmet' }, clock());
            return blocked('context_requirements_unmet', {
              data: { unmet: requirements.unmet },
              events: transcript.events(),
            });
          }

          while (counts.turns < agent.limits.max_turns) {
            if (
              counts.model_calls >= agent.limits.max_model_calls
              || counts.total_tokens >= agent.limits.max_total_tokens
            ) {
              transcript.append('agent.budget.exhausted', {
                reason: 'agent_budget_exhausted',
                counts,
                limits: agent.limits,
              }, clock());
              return blocked('agent_budget_exhausted', { data: { counts }, events: transcript.events() });
            }
            counts.turns += 1;
            counts.model_calls += 1;
            const modelRequest = createModelRequest({
              run_id: context.run_id,
              agent: {
                agent_id: agent.agent_id,
                version: agent.version,
                manifest_digest: agent.manifest_digest,
              },
              turn: counts.turns,
              instructions: agent.instructions,
              context_bundle: finalBundle,
              tools: agent.allowed_tools.map((name) => toolCatalog.descriptor(name)),
              budget: {
                turns_remaining: agent.limits.max_turns - counts.turns,
                model_calls_remaining: agent.limits.max_model_calls - counts.model_calls,
                tool_calls_remaining: agent.limits.max_tool_calls - counts.tool_calls,
                tokens_remaining: Math.max(0, agent.limits.max_total_tokens - counts.total_tokens),
              },
            });
            transcript.append('agent.model.requested', {
              turn: counts.turns,
              request_digest: modelRequest.request_digest,
              context_digest: finalBundle.bundle_digest,
              tool_catalog_digest: digest(modelRequest.tools),
            }, clock());

            let response;
            try {
              response = await modelRegistry.get(agent.model_profile).invoke(modelRequest);
              counts.total_tokens += response.usage.total_tokens;
              modelRecords.push(deepFreeze({ request_digest: modelRequest.request_digest, response }));
              transcript.append('agent.model.responded', {
                turn: counts.turns,
                request_digest: modelRequest.request_digest,
                response_digest: response.response_digest,
                action_digest: response.action.action_digest,
                action_kind: response.action.kind,
                usage_units: response.usage.total_tokens,
                model_ref: response.model_ref,
              }, clock());
            } catch (e) {
              const error = safeFailure(e);
              transcript.append('agent.model.failed', { turn: counts.turns, reason: error.code, detail: error.detail }, clock());
              transcript.append('agent.run.failed', { reason: 'model_invocation_failed' }, clock());
              return failed(error.code, error.detail, { events: transcript.events() });
            }

            if (counts.total_tokens > agent.limits.max_total_tokens) {
              transcript.append('agent.budget.exhausted', {
                reason: 'agent_budget_exhausted',
                counts,
                limits: agent.limits,
              }, clock());
              return blocked('agent_budget_exhausted', { data: { counts }, events: transcript.events() });
            }

            const action = assertAgentAction(response.action, { at: 'agent_runtime' });
            if (action.kind === 'finish') {
              transcript.append('agent.run.completed', {
                result_digest: digest(action.result),
                summary: action.summary,
                counts,
              }, clock());
              return succeeded({
                result: action.result,
                summary: action.summary,
                counts,
                agent: { agent_id: agent.agent_id, version: agent.version },
              }, { events: transcript.events() });
            }
            if (action.kind === 'request_human') {
              transcript.append('agent.human.requested', {
                reason: 'human_input_required',
                reason_code: action.reason_code,
                prompt: action.prompt,
                action_digest: action.action_digest,
              }, clock());
              return blocked('human_input_required', {
                data: { prompt: action.prompt, action_digest: action.action_digest },
                events: transcript.events(),
              });
            }

            if (!agent.allowed_tools.includes(action.tool)) {
              transcript.append('agent.tool.blocked', {
                reason: 'agent_tool_not_allowed',
                tool: action.tool,
                action_digest: action.action_digest,
              }, clock());
              transcript.append('agent.run.blocked', { reason: 'agent_tool_not_allowed' }, clock());
              return blocked('agent_tool_not_allowed', { data: { tool: action.tool }, events: transcript.events() });
            }
            if (counts.tool_calls >= agent.limits.max_tool_calls) {
              transcript.append('agent.budget.exhausted', {
                reason: 'agent_budget_exhausted',
                dimension: 'tool_calls',
                counts,
                limits: agent.limits,
              }, clock());
              return blocked('agent_budget_exhausted', { data: { counts }, events: transcript.events() });
            }
            counts.tool_calls += 1;
            transcript.append('agent.tool.requested', {
              turn: counts.turns,
              tool: action.tool,
              action_digest: action.action_digest,
              input_digest: digest(action.input),
            }, clock());
            const step = {
              id: `agent_turn_${counts.turns}`,
              tool: action.tool,
              description: `Agent action ${counts.turns}`,
              input: action.input,
              compensates: null,
              on_failure: 'fail',
              idempotency_key: `${context.run_id}:${action.action_digest}`,
            };
            let invocation = await dispatcher.invoke({
              manifest,
              step,
              tool: action.tool,
              input: action.input,
              context,
              deps: request.deps ?? {},
              approved: false,
            });

            if (invocation.status === 'blocked' && invocation.reason === 'approval_required') {
              const receipt = (request.approvals ?? []).find((entry) => entry.action_digest === action.action_digest);
              if (receipt !== undefined) {
                const approval = evaluateApprovalDecision({
                  manifest,
                  pending: { org_id: context.org_id, step_id: step.id },
                  decision: receipt.decision,
                  actor: receipt.actor,
                  principal: receipt.principal,
                  principal_roles: receipt.principal_roles,
                  org_id: receipt.org_id,
                });
                if (approval.ok && receipt.decision === 'approve') {
                  invocation = await dispatcher.invoke({
                    manifest, step, tool: action.tool, input: action.input, context,
                    deps: request.deps ?? {}, approved: true,
                  });
                } else if (approval.ok && receipt.decision === 'reject') {
                  transcript.append('agent.tool.blocked', {
                    reason: 'approval_rejected', tool: action.tool, action_digest: action.action_digest,
                  }, clock());
                  transcript.append('agent.run.blocked', { reason: 'approval_rejected' }, clock());
                  return blocked('approval_rejected', { data: { action_digest: action.action_digest }, events: transcript.events() });
                } else {
                  transcript.append('agent.tool.blocked', {
                    reason: approval.reason, detail: approval.detail, tool: action.tool,
                  }, clock());
                  transcript.append('agent.run.blocked', { reason: approval.reason }, clock());
                  return blocked(approval.reason, { data: { detail: approval.detail }, events: transcript.events() });
                }
              }
            }

            if (invocation.status === 'blocked') {
              transcript.append('agent.tool.blocked', {
                reason: invocation.reason,
                detail: invocation.detail,
                tool: action.tool,
                action_digest: action.action_digest,
                obligations: invocation.obligations,
              }, clock());
              if (invocation.reason === 'approval_required') {
                transcript.append('agent.human.requested', {
                  reason: 'approval_required',
                  prompt: invocation.detail,
                  action_digest: action.action_digest,
                  obligations: invocation.obligations,
                }, clock());
              } else {
                transcript.append('agent.run.blocked', { reason: invocation.reason }, clock());
              }
              return blocked(invocation.reason, { data: { invocation }, events: transcript.events() });
            }
            if (invocation.status === 'failed') {
              transcript.append('agent.tool.failed', {
                reason: invocation.reason,
                detail: invocation.detail,
                tool: action.tool,
                action_digest: action.action_digest,
              }, clock());
              transcript.append('agent.run.failed', { reason: invocation.reason }, clock());
              return failed('contract_violation', invocation.detail ?? `tool '${action.tool}' failed`, {
                events: transcript.events(),
              });
            }
            transcript.append('agent.tool.completed', {
              turn: counts.turns,
              tool: action.tool,
              action_digest: action.action_digest,
              result_digest: digest(invocation.data),
              idempotency_key: invocation.idempotency_key,
              replayed: invocation.replayed,
            }, clock());
            contextItems.push(toolResultItem({
              context,
              action,
              invocation,
              turn: counts.turns,
              occurred_at: clock(),
            }));
            assemble();
          }

          transcript.append('agent.budget.exhausted', {
            reason: 'agent_budget_exhausted',
            dimension: 'turns',
            counts,
            limits: agent.limits,
          }, clock());
          return blocked('agent_budget_exhausted', { data: { counts }, events: transcript.events() });
        } catch (e) {
          const error = safeFailure(e);
          transcript.append('agent.run.failed', { reason: error.code, detail: error.detail }, clock());
          return failed(error.code, error.detail, { events: transcript.events() });
        }
      },
    });

    const transcriptSnapshot = transcript.snapshot();
    verifyAgentTranscript(transcriptSnapshot, { at: 'agent_runtime.run' });
    const document = deepFreeze({
      schema: AGENT_RUN_DOCUMENT_SCHEMA,
      run_id: context.run_id,
      org_id: context.org_id,
      agent_id: request.agent_id,
      transcript: transcriptSnapshot,
      model_records: modelRecords,
      outcome: executed.outcome,
    });
    let persistence;
    try {
      const stored = await store.write(document);
      persistence = {
        ok: stored?.ok === true,
        ref: typeof stored?.ref === 'string' ? stored.ref : null,
        error: stored?.ok === true ? null : String(redact(String(stored?.error ?? 'agent run store returned no success result'))).slice(0, 500),
      };
    } catch (e) {
      persistence = { ok: false, ref: null, error: safeFailure(e).detail };
    }
    const result = deepFreeze({
      schema: AGENT_RUN_RESULT_SCHEMA,
      ...executed,
      context_bundle: finalBundle,
      transcript: transcriptSnapshot,
      projection: projectAgentTranscript(transcriptSnapshot),
      model_records: modelRecords,
      persistence,
    });
    return assertAgentRunResult(result, { at: 'agent_runtime.run' });
  }

  function replay(transcript) {
    verifyAgentTranscript(transcript, { at: 'agent_runtime.replay' });
    return projectAgentTranscript(transcript);
  }

  return Object.freeze({
    run,
    replay,
    inspect({ run_id, org_id } = {}) { return store.read({ run_id, org_id }); },
    list({ org_id } = {}) { return store.list({ org_id }); },
    describe() {
      return deepFreeze({
        schema: 'awe.agent_runtime_description/v1',
        agents: agentRegistry.describe(),
        workflows: workflowRegistry.describe(),
        tools: toolCatalog.describe(),
        model_profiles: modelRegistry.profiles(),
        digests: {
          agents: agentRegistry.registry_digest(),
          workflows: workflowRegistry.registry_digest(),
          tools: toolCatalog.catalog_digest(),
          policy: policy.policy_digest(),
        },
      });
    },
  });
}
