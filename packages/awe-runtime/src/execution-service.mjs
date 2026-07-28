import { invariant } from '../../awe-kernel/src/index.mjs';
import {
  createExecutionService,
  createInMemoryExecutionRepository,
  createSequenceIdentifiers,
} from '../../awe-execution/src/index.mjs';

function lastEvent(transcript, eventType) {
  return [...(transcript?.entries ?? [])]
    .reverse()
    .find((entry) => entry.event?.event_type === eventType)?.event ?? null;
}

/**
 * Compose the provider-neutral durable execution core with runtime boundaries.
 * Storage, clocks, identifiers, workflow/agent runtimes and providers are all
 * injected; this service selects none of them.
 */
export function createDurableExecutionService({
  repository = createInMemoryExecutionRepository(),
  clock,
  ids = createSequenceIdentifiers(),
  ...options
} = {}) {
  invariant(typeof clock === 'function', 'invalid_input', 'durable execution service needs an injected clock', {});
  return createExecutionService({ repository, clock, ids, ...options });
}

/**
 * Adapt the existing bounded Agent Runtime to a durable worker executor.
 *
 * A blocked approval becomes a durable wake. A completed agent result remains a
 * control decision; optional `effectPlan` translates the approved proposal into
 * execution-plane effect requests so external-effect receipts and fencing stay
 * owned by the durable plane.
 */
export function createAgentRuntimeExecutionAdapter({
  agentService,
  buildRequest,
  effectPlan = null,
  memory = null,
} = {}) {
  invariant(agentService !== null && typeof agentService?.submit === 'function', 'invalid_input', 'agent execution adapter needs Agent Service', {});
  invariant(typeof buildRequest === 'function', 'invalid_input', 'agent execution adapter needs buildRequest()', {});
  invariant(effectPlan === null || typeof effectPlan === 'function', 'invalid_input', 'effectPlan must be a function', {});

  return Object.freeze({
    async execute(context) {
      let retrieval = null;
      if (memory !== null && context.checkpoint === null) {
        invariant(typeof memory.retrieve === 'function', 'invalid_input', 'memory integration needs retrieve()', {});
        retrieval = await memory.retrieve({ ...context.job.metadata.memory_query, org_id: context.job.org_id });
        invariant(retrieval.ok === true, retrieval.reason ?? 'memory_retrieval_failed', retrieval.detail ?? 'memory retrieval failed', {});
      }
      const request = await buildRequest({
        ...context,
        memory: retrieval,
      });
      const result = await agentService.submit(request);
      const actionEvent = lastEvent(result.transcript, 'agent.human.requested');
      const checkpoint = {
        agent_loop_state: {
          projection: result.projection,
          outcome_status: result.outcome.status,
          blocked_reason: result.outcome.blocked_reason,
        },
        completed_steps: result.transcript.entries
          .filter((entry) => entry.event.event_type === 'agent.tool.completed')
          .map((entry) => `${entry.event.payload.turn}:${entry.event.payload.tool}`),
        pending_step: actionEvent?.payload?.action_digest ?? null,
        context_snapshot_ref: result.context_bundle?.bundle_digest ?? null,
        memory_snapshot_refs: retrieval === null ? (context.checkpoint?.memory_snapshot_refs ?? []) : [retrieval.snapshot.snapshot_digest],
        transcript_position: result.transcript.entries.length,
        tool_receipts: result.transcript.entries
          .filter((entry) => entry.event.event_type === 'agent.tool.completed')
          .map((entry) => entry.event.entry_digest),
        policy_decisions: result.transcript.entries
          .filter((entry) => entry.event.event_type === 'agent.tool.blocked')
          .map((entry) => entry.event.payload),
        approval_requests: actionEvent === null ? [] : [actionEvent.payload],
        runtime_versions: {
          agent_runtime: 'awe.agent_runtime/v1',
          agent_id: request.agent_id,
          agent_version: request.version,
        },
        content_digests: {
          transcript: result.transcript.transcript_digest,
          context: result.context_bundle?.bundle_digest ?? null,
        },
      };

      if (result.outcome.status === 'blocked' && ['approval_required', 'human_input_required'].includes(result.outcome.blocked_reason)) {
        const actionDigest = actionEvent?.payload?.action_digest
          ?? result.outcome.data?.action_digest
          ?? result.outcome.data?.invocation?.input_digest;
        invariant(typeof actionDigest === 'string', 'contract_violation', 'agent approval pause lacks an action digest', {});
        return {
          kind: 'paused',
          reason_code: result.outcome.blocked_reason,
          checkpoint,
          wake: {
            kind: 'approval',
            action_digest: actionDigest,
            available_at: context.job.updated_at,
            expires_at: context.job.deadline_at,
          },
        };
      }
      if (result.outcome.status === 'blocked') {
        return {
          kind: 'failed',
          reason_code: result.outcome.blocked_reason,
          error_class: 'non_retryable_policy',
          checkpoint,
        };
      }
      if (result.outcome.status === 'failed') {
        return {
          kind: 'retry',
          reason_code: result.outcome.error?.code ?? 'agent_runtime_failed',
          error_class: 'retryable_infrastructure',
          checkpoint,
        };
      }
      return {
        kind: 'completed',
        reason_code: 'agent_runtime_completed',
        output: result.outcome.data,
        checkpoint,
        effects: effectPlan === null ? [] : await effectPlan({ context, result, checkpoint }),
      };
    },
  });
}

/**
 * Adapt the existing Workflow Runtime / control-plane service. Its own journal
 * remains the workflow semantic record; the execution plane owns scheduling,
 * leasing, attempts, checkpoints and worker recovery around it.
 */
export function createWorkflowRuntimeExecutionAdapter({
  workflowService,
  buildStartRequest,
  buildResumeRequest,
} = {}) {
  invariant(workflowService !== null && typeof workflowService?.startRun === 'function', 'invalid_input', 'workflow execution adapter needs Control Plane Service', {});
  invariant(typeof buildStartRequest === 'function', 'invalid_input', 'workflow adapter needs buildStartRequest()', {});
  invariant(typeof buildResumeRequest === 'function', 'invalid_input', 'workflow adapter needs buildResumeRequest()', {});

  return Object.freeze({
    async execute(context) {
      const first = context.checkpoint === null;
      const result = first
        ? await workflowService.startRun(await buildStartRequest(context))
        : await workflowService.resumeRun(await buildResumeRequest(context));
      const checkpoint = {
        workflow_state: {
          control_run_id: result.run_id,
          state: result.state,
          journal_ref: result.journal_ref ?? null,
        },
        completed_steps: result.completed_steps?.map((entry) => entry.step_id) ?? [],
        pending_step: result.pending_approval?.step_id ?? null,
        context_snapshot_ref: result.context_bundle?.bundle_digest ?? null,
        runtime_versions: {
          control_plane: 'awe.run_journal/v1',
          workflow_id: result.workflow_id,
          workflow_version: result.workflow_version,
        },
        content_digests: {
          journal: result.journal_head ?? null,
          manifest: result.manifest_digest ?? null,
        },
      };
      if (result.advance === 'paused') {
        return {
          kind: 'paused',
          reason_code: result.blocked_reason,
          checkpoint,
          wake: {
            kind: 'approval',
            action_digest: result.pending_approval?.action_digest ?? result.pending_approval?.approval_id,
            available_at: context.job.updated_at,
            expires_at: context.job.deadline_at,
          },
        };
      }
      if (result.advance === 'completed') return { kind: 'completed', reason_code: 'workflow_completed', output: result.outcome?.data ?? null, checkpoint, effects: [] };
      if (['cancelled', 'timed_out'].includes(result.advance)) return { kind: 'cancelled', reason_code: result.blocked_reason ?? result.advance, checkpoint };
      return {
        kind: 'failed',
        reason_code: result.blocked_reason ?? 'workflow_failed',
        error_class: result.blocked_reason === 'step_timeout' ? 'retryable_timeout' : 'non_retryable_policy',
        checkpoint,
      };
    },
  });
}
