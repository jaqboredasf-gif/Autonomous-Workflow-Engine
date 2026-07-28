import {
  createContextItem, defineTool,
} from '../../../awe-kernel/src/index.mjs';
import {
  defineToolGrant, defineWorkflowManifest,
} from '../../../awe-control-plane/src/index.mjs';
import {
  defineAgentManifest, defineModelAdapter,
} from '../../../awe-agent-runtime/src/index.mjs';
import { createAgentService } from '../agent-service.mjs';
import { createSteppingClock } from '../clock.mjs';

export const OPERATIONS_ORG = 'org_operations_fixture';
export const OTHER_OPERATIONS_ORG = 'org_operations_other';

const CASES = Object.freeze({
  [OPERATIONS_ORG]: Object.freeze({
    case_id: 'case_1042',
    status: 'waiting_customer',
    priority: 'high',
    category: 'access',
  }),
  [OTHER_OPERATIONS_ORG]: Object.freeze({
    case_id: 'case_9911',
    status: 'legal_hold',
    priority: 'critical',
    category: 'privacy',
  }),
});

const POLICIES = Object.freeze({
  [OPERATIONS_ORG]: Object.freeze({
    category: 'access',
    next_action: 'request_identity_confirmation',
    owner: 'support_lead',
  }),
  [OTHER_OPERATIONS_ORG]: Object.freeze({
    category: 'privacy',
    next_action: 'escalate_to_counsel',
    owner: 'privacy_officer',
  }),
});

export function operationsAgentContext({ org_id = OPERATIONS_ORG } = {}) {
  return [createContextItem({
    id: `task:${org_id}:case`,
    kind: 'workflow_state',
    source: 'operations_queue',
    org_id,
    sensitivity: 'internal',
    trusted: true,
    priority: 1000,
    occurred_at: '2026-07-28T13:00:00.000Z',
    content: `Investigate case ${CASES[org_id]?.case_id ?? 'case_unknown'} and recommend the policy-compliant next action.`,
  })];
}

export function operationsTools({ calls = [] } = {}) {
  return [
    {
      descriptor: defineTool({
        name: 'lookup_case',
        version: '1.0.0',
        description: 'Read one tenant-bound operations case.',
        workflow_id: 'operations_investigation',
        input_schema: 'awe.operations.case_input/v1',
        output_schema: 'awe.operations.case/v1',
        side_effect: 'read',
        requires_tenant: true,
        lifecycle: 'active',
      }),
      adapter(input, { context }) {
        calls.push({ tool: 'lookup_case', org_id: context.org_id, input });
        const found = CASES[context.org_id];
        if (found === undefined || found.case_id !== input.case_id) return { found: false, case: null };
        return { found: true, case: found };
      },
    },
    {
      descriptor: defineTool({
        name: 'lookup_policy',
        version: '1.0.0',
        description: 'Read tenant policy for one operations category.',
        workflow_id: 'operations_investigation',
        input_schema: 'awe.operations.policy_input/v1',
        output_schema: 'awe.operations.policy/v1',
        side_effect: 'read',
        requires_tenant: true,
        lifecycle: 'active',
      }),
      adapter(input, { context }) {
        calls.push({ tool: 'lookup_policy', org_id: context.org_id, input });
        const found = POLICIES[context.org_id];
        if (found === undefined || found.category !== input.category) return { found: false, policy: null };
        return { found: true, policy: found };
      },
    },
  ];
}

export const operationsValidators = Object.freeze({
  'awe.operations.case_input/v1': (value) => ({
    ok: typeof value?.case_id === 'string',
    errors: typeof value?.case_id === 'string' ? [] : ['case_id is required'],
  }),
  'awe.operations.case/v1': (value) => ({
    ok: typeof value?.found === 'boolean' && Object.prototype.hasOwnProperty.call(value, 'case'),
    errors: [],
  }),
  'awe.operations.policy_input/v1': (value) => ({
    ok: typeof value?.category === 'string',
    errors: typeof value?.category === 'string' ? [] : ['category is required'],
  }),
  'awe.operations.policy/v1': (value) => ({
    ok: typeof value?.found === 'boolean' && Object.prototype.hasOwnProperty.call(value, 'policy'),
    errors: [],
  }),
});

export const operationsWorkflow = defineWorkflowManifest({
  workflow_id: 'operations_investigation',
  version: '1.0.0',
  title: 'Operations Investigation',
  description: 'Gather tenant-bound case and policy facts before recommending a next action.',
  tenant_scope: { mode: 'any_tenant', org_ids: [] },
  required_tools: [
    { name: 'lookup_case', version: '1.0.0', max_side_effect: 'read' },
    { name: 'lookup_policy', version: '1.0.0', max_side_effect: 'read' },
  ],
  required_context: [
    { kind: 'workflow_state', source: 'operations_queue', min_items: 1, max_sensitivity: 'internal' },
  ],
  approval_policy: {
    requires_approval_at_or_above: null,
    approver_roles: [],
    quorum: 1,
  },
  limits: {
    step_timeout_ms: 1000,
    run_timeout_ms: 30000,
    max_attempts: 1,
    retry_backoff_ms: 0,
  },
  dependencies: [],
  risk: 'low',
  promotion: {
    status: 'promoted',
    promoted_at: '2026-07-28T12:00:00.000Z',
    promoted_by: 'platform_architect',
  },
  steps: [
    { id: 'case_lookup', tool: 'lookup_case', input: {} },
    { id: 'policy_lookup', tool: 'lookup_policy', input: {} },
  ],
  metadata: { reference: true, synthetic: true },
});

export const operationsAgent = defineAgentManifest({
  agent_id: 'operations_investigator',
  version: '1.0.0',
  title: 'Operations Investigator',
  description: 'Collects case and policy facts and returns a bounded recommendation.',
  lifecycle: 'active',
  workflow: { workflow_id: 'operations_investigation', version: '1.0.0' },
  model_profile: 'operations_fixture',
  instructions: {
    version: '1.0.0',
    text: 'Use the registered read tools to gather the case and applicable policy. Finish with a concise next-action recommendation.',
  },
  allowed_tools: ['lookup_case', 'lookup_policy'],
  context: { max_tokens: 4000, max_items: 20, max_sensitivity: 'confidential' },
  limits: { max_turns: 4, max_model_calls: 4, max_tool_calls: 2, max_total_tokens: 1000 },
  metadata: { reference: true, synthetic: true },
});

export function operationsModelAdapter() {
  return defineModelAdapter({
    profile: 'operations_fixture',
    invoke(request) {
      const common = {
        model_ref: 'fixture:operations:v1',
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      };
      if (request.turn === 1) {
        return {
          ...common,
          action: {
            kind: 'tool',
            reason_code: 'case_facts_needed',
            tool: 'lookup_case',
            input: { case_id: 'case_1042' },
          },
        };
      }
      if (request.turn === 2) {
        return {
          ...common,
          action: {
            kind: 'tool',
            reason_code: 'policy_facts_needed',
            tool: 'lookup_policy',
            input: { category: 'access' },
          },
        };
      }
      return {
        ...common,
        action: {
          kind: 'finish',
          reason_code: 'evidence_complete',
          result: {
            case_id: 'case_1042',
            recommended_action: 'request_identity_confirmation',
            owner: 'support_lead',
          },
          summary: 'The case should request identity confirmation and remain with the support lead.',
        },
      };
    },
  });
}

export function operationsGrants({ org_id = OPERATIONS_ORG } = {}) {
  return ['lookup_case', 'lookup_policy'].map((tool) => defineToolGrant({
    org_id,
    workflow_id: 'operations_investigation',
    tool,
    version: '1.0.0',
    max_side_effect: 'read',
    requires_approval_at_or_above: null,
    approver_roles: [],
  }));
}

export function createOperationsAgentFixture({
  clock = createSteppingClock(),
  calls = [],
  models = [operationsModelAdapter()],
  org_id = OPERATIONS_ORG,
  artifacts = null,
  audit = null,
  run_store = null,
} = {}) {
  const service = createAgentService({
    agents: [operationsAgent],
    workflows: [operationsWorkflow],
    tools: operationsTools({ calls }),
    grants: operationsGrants({ org_id }),
    validators: operationsValidators,
    models,
    clock,
    artifacts,
    audit,
    run_store,
  });
  return { service, clock, calls };
}

export function operationsRunRequest({
  org_id = OPERATIONS_ORG,
  run_id = 'agent_run_operations_001',
} = {}) {
  return {
    agent_id: 'operations_investigator',
    version: '1.0.0',
    run_id,
    org_id,
    actor: 'service',
    mode: 'TEST',
    is_fixture: true,
    started_at: '2026-07-28T13:00:00.000Z',
    finished_at: '2026-07-28T13:01:00.000Z',
    trace_id: 'trace_operations_001',
    attributes: { source: 'reference_example' },
    context_items: operationsAgentContext({ org_id }),
    approvals: [],
    deps: {},
  };
}
