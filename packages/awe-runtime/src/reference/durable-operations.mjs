import { digest } from '../../../awe-kernel/src/index.mjs';
import {
  createInMemoryRecordStore,
  createLexicalMemoryAdapter,
  defineMemoryManifest,
  defineMemoryRecord,
} from '../../../awe-memory/src/index.mjs';
import { createMemoryService } from '../memory-service.mjs';
import {
  OPERATIONS_ORG,
  createOperationsAgentFixture,
  operationsAgentContext,
  operationsRunRequest,
} from './operations-agent.mjs';

export function createSyntheticEffectAdapter({ calls = [], compensationCalls = [] } = {}) {
  const confirmed = new Map();
  return {
    name: 'synthetic_operations_effect',
    async execute({ input, idempotency_key, action_digest, org_id }) {
      if (!confirmed.has(idempotency_key)) {
        calls.push({ input, idempotency_key, action_digest, org_id });
        confirmed.set(idempotency_key, {
          receipt_ref: `fixture-receipt:${idempotency_key}`,
          accepted: true,
        });
      }
      return { status: 'confirmed', result: confirmed.get(idempotency_key) };
    },
    async compensate({ input, effect_id, idempotency_key, org_id }) {
      compensationCalls.push({ input, effect_id, idempotency_key, org_id });
      return { compensated: true, effect_id };
    },
    metrics() {
      return {
        calls,
        compensation_calls: compensationCalls,
        unique_effects: confirmed.size,
      };
    },
  };
}

export function createDurableOperationsMemory({ clock }) {
  const manifest = defineMemoryManifest({
    memory_id: 'operations_memory',
    version: '1.0.0',
    title: 'Synthetic Operations Memory',
    description: 'Approved synthetic facts used by the durable execution demonstration.',
    lifecycle: 'active',
    tenant_scope: { mode: 'named_tenants', org_ids: [OPERATIONS_ORG] },
    context: {
      kind: 'domain_facts',
      source: 'memory_layer',
      trusted: false,
      priority: 650,
      max_sensitivity: 'confidential',
    },
    write_policy: { mode: 'approval_required', approver_roles: ['memory_steward'] },
    retention: { allowed_classes: ['standard'], max_ttl_days: 30 },
    retrieval: { profile: 'lexical_default', max_results: 3, min_score: 0.1 },
    metadata: { reference: true, synthetic: true },
  });
  const record = defineMemoryRecord({
    memory_id: 'operations_memory',
    record_id: 'access_identity_policy',
    version: 1,
    org_id: OPERATIONS_ORG,
    content: 'Access cases require identity confirmation before an outbound action.',
    sensitivity: 'internal',
    retention_class: 'standard',
    created_at: '2026-07-28T13:00:00.000Z',
    expires_at: '2026-08-20T13:00:00.000Z',
    provenance: {
      source_type: 'human_decision',
      source_ref: 'fixture_approval_001',
      run_id: null,
      captured_at: '2026-07-28T13:00:00.000Z',
      actor: 'human',
    },
    metadata: { approved: true, synthetic: true },
    supersedes_version: null,
  });
  return createMemoryService({
    manifests: [manifest],
    store: createInMemoryRecordStore([record]),
    adapters: [createLexicalMemoryAdapter()],
    clock,
  });
}

/**
 * Complete synthetic agent executor:
 *   first attempt -> Memory retrieval + bounded Agent Runtime safe reads ->
 *                    durable digest-bound approval pause
 *   resumed attempt -> approved synthetic action proposal -> execution-plane
 *                      effect adapter (the worker executes it exactly once)
 */
export function createDurableOperationsExecutor({
  clock,
  effectAdapter = createSyntheticEffectAdapter(),
  agentCalls = [],
  memory = createDurableOperationsMemory({ clock }),
} = {}) {
  return Object.freeze({
    async execute({ job, run, checkpoint }) {
      if (checkpoint === null) {
        const retrieved = await memory.retrieve({
          query_id: `query:${run.run_id}`,
          memory_id: 'operations_memory',
          memory_version: '1.0.0',
          org_id: job.org_id,
          text: 'identity confirmation access action',
          requested_at: clock(),
          retrieved_at: clock(),
        });
        const fixture = createOperationsAgentFixture({
          clock,
          calls: agentCalls,
          org_id: job.org_id,
        });
        const agentResult = await fixture.service.submit({
          ...operationsRunRequest({
            org_id: job.org_id,
            run_id: `agent:${run.run_id}`,
          }),
          started_at: clock(),
          finished_at: clock(),
          trace_id: run.trace_id,
          context_items: [
            ...operationsAgentContext({ org_id: job.org_id }),
            ...retrieved.context_items,
          ],
        });
        const action = {
          kind: 'synthetic_outbound_proposal',
          case_id: agentResult.outcome.data.result.case_id,
          recommended_action: agentResult.outcome.data.result.recommended_action,
          recipient: 'customer@example.invalid',
          body: 'Synthetic identity-confirmation request. No message is sent.',
        };
        const actionDigest = digest(action);
        return {
          kind: 'paused',
          reason_code: 'approval_required',
          checkpoint: {
            agent_loop_state: {
              result: agentResult.outcome.data.result,
              summary: agentResult.outcome.data.summary,
              transcript_digest: agentResult.transcript.transcript_digest,
              proposed_action: action,
              action_digest: actionDigest,
            },
            completed_steps: ['agent_safe_reads'],
            pending_step: 'approved_synthetic_action',
            context_snapshot_ref: agentResult.context_bundle.bundle_digest,
            memory_snapshot_refs: [retrieved.snapshot.snapshot_digest],
            transcript_position: agentResult.transcript.entries.length,
            tool_receipts: agentResult.transcript.entries
              .filter((entry) => entry.event.event_type === 'agent.tool.completed')
              .map((entry) => entry.entry_digest),
            policy_decisions: [{ decision: 'require_approval', action_digest: actionDigest }],
            approval_requests: [{ action_digest: actionDigest, approver_roles: ['operations_owner'] }],
            runtime_versions: {
              agent_runtime: 'awe.agent_runtime/v1',
              memory_layer: 'awe.memory_retrieval_snapshot/v1',
            },
            content_digests: {
              transcript: agentResult.transcript.transcript_digest,
              memory: retrieved.snapshot.snapshot_digest,
              action: actionDigest,
            },
          },
          wake: {
            kind: 'approval',
            action_digest: actionDigest,
            available_at: clock(),
            expires_at: job.deadline_at,
          },
        };
      }

      const state = checkpoint.agent_loop_state;
      return {
        kind: 'completed',
        reason_code: 'approved_action_ready',
        output: {
          case_id: state.result.case_id,
          completed: true,
          action_digest: state.action_digest,
        },
        checkpoint: {
          ...checkpoint,
          completed_steps: [...checkpoint.completed_steps, 'approved_synthetic_action'],
          pending_step: null,
        },
        effects: [{
          idempotency_key: `${run.run_id}:${state.action_digest}`,
          action_digest: state.action_digest,
          input: state.proposed_action,
          adapter: effectAdapter,
          compensation_mode: 'supported',
          approval_evidence_digest: digest({ run_id: run.run_id, action_digest: state.action_digest, decision: 'approve' }),
          policy_evidence_digest: digest({ decision: 'require_approval', action_digest: state.action_digest }),
        }],
      };
    },
    metrics() {
      return {
        agent_calls: agentCalls,
        effects: effectAdapter.metrics(),
      };
    },
  });
}

export { OPERATIONS_ORG };
