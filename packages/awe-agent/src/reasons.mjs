// ---------------------------------------------------------------------------
// reasons.mjs — the governed agent plane's blocked-reason vocabulary.
//
// Registered as the `agent` namespace in scripts/lib/awe-reasons.mjs. Every
// refusal this package can produce is here, and Runner G asserts that no code
// path emits a reason outside this list.
//
// It deliberately holds NO reason the control plane already owns. When the
// policy engine refuses a tool (`tool_not_authorized`, `tenant_binding_required`,
// `approval_required`, `live_mode_unratified`, …) the agent plane reports that
// reason UNCHANGED, because re-spelling another layer's refusal is how two
// vocabularies end up meaning almost the same thing.
// ---------------------------------------------------------------------------

// Resolving WHICH agent, at which version, in what state.
export const AGENT_REGISTRY_REASONS = [
  'agent_not_registered',
  'agent_version_unknown',
  'agent_version_incompatible',
  'agent_not_active',
  'agent_disabled',
  'agent_deprecated',
  'agent_tenant_out_of_scope',
  'agent_definition_drift',
  'agent_definition_invalid',
];

// Resolving WHICH business permission, and whether this agent, tenant and actor
// may exercise it.
export const CAPABILITY_REASONS = [
  'capability_not_registered',
  'capability_version_unknown',
  'capability_version_incompatible',
  'capability_not_declared',
  'capability_denied',
  'capability_tenant_out_of_scope',
  'capability_actor_not_permitted',
  'capability_tool_not_bound',
  'capability_operation_not_permitted',
  'capability_data_classification_exceeded',
];

// The proposal itself: what a planner may not ask for, however it asks.
export const PROPOSAL_REASONS = [
  'planner_output_malformed',
  'planner_unavailable',
  'proposal_arguments_invalid',
  'proposal_cross_tenant_reference',
  'proposal_evidence_unknown',
  'proposal_evidence_required',
  'proposal_idempotency_required',
  'proposal_side_effect_not_permitted',
  'proposal_privilege_escalation',
  'proposal_output_contract_unmet',
];

// Who is asking. Both fail closed and both are checked before anything is read.
export const IDENTITY_REASONS = [
  'tenant_identity_required',
  'actor_identity_required',
];

// The approval binding — what makes an approval an approval OF SOMETHING rather
// than a boolean.
export const APPROVAL_BINDING_REASONS = [
  'approval_binding_mismatch',
  'approval_expired',
  'approval_not_in_force',
];

// Bounded execution. Four separate reasons rather than one `budget_exhausted`,
// because "it ran out of turns" and "it ran out of wall clock" call for
// different fixes and an operator should not have to read a detail string to
// tell them apart.
export const BUDGET_REASONS = [
  'budget_turns_exhausted',
  'budget_steps_exhausted',
  'budget_tool_calls_exhausted',
  'budget_time_exhausted',
];

// Improvement, and the line it may not cross.
export const IMPROVEMENT_REASONS = [
  'evaluation_evidence_missing',
  'candidate_activation_refused',
  'promotion_reviewer_invalid',
];

export const AGENT_RUN_REASONS = [
  'agent_run_cancelled',
  'agent_no_action_proposed',
];

export const AGENT_BLOCKED_REASONS = [
  ...AGENT_REGISTRY_REASONS,
  ...CAPABILITY_REASONS,
  ...PROPOSAL_REASONS,
  ...IDENTITY_REASONS,
  ...APPROVAL_BINDING_REASONS,
  ...BUDGET_REASONS,
  ...IMPROVEMENT_REASONS,
  ...AGENT_RUN_REASONS,
];

export function isAgentReason(reason) {
  return AGENT_BLOCKED_REASONS.includes(reason);
}
