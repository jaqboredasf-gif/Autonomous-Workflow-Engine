// ---------------------------------------------------------------------------
// @exattime/awe-agent — the AWE Governed Agent Execution Plane.
//
// The layer that lets a SPECIALIZED AGENT do real business work through AWE
// while remaining tenant-bound, capability-limited, policy-constrained,
// approval-aware, durable, observable and replayable.
//
// It answers the questions the control plane deliberately does not, because the
// control plane executes a DECLARED step list and an agent's steps are proposed
// at runtime:
//
//   WHICH agent, at which version, in what state?  -> agent-registry.mjs
//   WHAT is it permitted to do, as a business
//     permission rather than a tool handle?        -> capability.mjs
//   WHAT is its complete, finite action space?     -> surface.mjs
//   WHAT may a planner ask for, and in what shape? -> proposal.mjs
//   MAY THIS action happen, and on whose evidence? -> authorization.mjs
//   WHAT does a model get to see?                  -> planner.mjs
//   HOW LONG may it go on?                         -> budget.mjs
//   WHAT actually happened, in what order?         -> harness.mjs
//   HOW DO WE KNOW IT IS GETTING BETTER, without
//     letting it change itself?                    -> evaluation.mjs
//
// Dependency direction, enforced by the layering lint in
// scripts/eval-governed-agent.mjs:
//
//   awe-kernel <- awe-control-plane <- awe-agent <- awe-runtime <- surfaces
//                                        (this)
//
// This package imports the kernel and the control plane through ONE seam
// (`kernel.mjs`) and nothing else. No network, no filesystem, no clock, no
// randomness, no ambient environment, no model client, no vendor name.
//
// FAIL-CLOSED SUMMARY, all mechanically asserted by Runner G:
//   * an agent is never resolved to "whatever version is current"; a draft or
//     disabled agent never runs, and `disabled` has no override;
//   * a capability is a business permission, not a tool handle: tool access
//     alone authorizes nothing;
//   * a proposal is untrusted input — unknown keys, unversioned dependencies and
//     reserved envelope arguments are refused by the grammar itself;
//   * the runtime, not the planner, decides authorization and approval; a
//     planner that understates an approval requirement is recorded doing so;
//   * an approval binds to the exact arguments, capability version, tool version
//     and tenant it was granted for, and expires;
//   * a paused run re-authorizes from scratch and fails closed on definition or
//     surface drift;
//   * every budget is NOT NULL and > 0 — an unbounded agent cannot be
//     configured;
//   * evaluation measures and changes nothing; promotion produces a DRAFT and
//     needs two named humans and a redeploy before anything executes.
// ---------------------------------------------------------------------------

export {
  CAPABILITY_SCHEMA, CAPABILITY_KEYS, CAPABILITY_RISKS, CAPABILITY_RESOLUTION_REASONS,
  IDEMPOTENCY_MODES, AUDIT_MODES,
  assertCapability, bindingFor, capabilityAdmitsSensitivity, capabilityPermitsActor,
  capabilityRequiresApproval, capabilityTenantInScope, createCapabilityRegistry, defineCapability,
} from './capability.mjs';

export {
  AGENT_DEFINITION_SCHEMA, AGENT_DEFINITION_KEYS, AGENT_STATUSES, APPROVAL_BINDING_MODES,
  MEMORY_WRITE_MODES, PLANNER_KINDS,
  activateAgentDefinition, agentTenantInScope, assertAgentDefinition, declaredCapability,
  declaredTool, defineAgentDefinition, deniedCapability,
} from './agent-definition.mjs';

export { AGENT_RESOLUTION_REASONS, createAgentRegistry } from './agent-registry.mjs';

export { SURFACE_COMPILE_REASONS, bindingStepId, compileAgentSurface } from './surface.mjs';

export {
  ACTION_PROPOSAL_SCHEMA, ACTION_PROPOSAL_KEYS, EVIDENCE_KINDS,
  assertActionProposal, bindingDigest, defineActionProposal, parseActionProposal,
} from './proposal.mjs';

export {
  AGENT_POLICY_DECISIONS, ARGUMENT_GUARD_KEYS, POLICY_DECISION_KEYS, POLICY_DECISION_SCHEMA,
  assertPolicyDecision, authorizeProposal, createPolicyDecision, simulateProposal,
} from './authorization.mjs';

export {
  PLANNING_VIEW_SCHEMA, PLANNING_VIEW_KEYS,
  assertPlanner, assertPlanningView, buildPlanningView, createModelPlanner,
  defineDeterministicPlanner, defineModelPort, definePlanner, runPlanner,
} from './planner.mjs';

export {
  BUDGET_DIMENSIONS, createBudgetLedger, segmentStartedAt, spentFromJournal,
} from './budget.mjs';

export {
  AGENT_ADVANCE_OUTCOMES, AGENT_PHASES,
  approvalsOf, createGovernedAgentHarness, decisionsOf, failureClassFor, projectAgentPhase,
  recordedContextIndex,
} from './harness.mjs';

export {
  CANDIDATE_KINDS, CANDIDATE_STATUSES, EVALUATION_RECORD_SCHEMA, EVALUATION_RECORD_KEYS,
  FAILURE_CLASSES, IMPROVEMENT_CANDIDATE_SCHEMA,
  assertEvaluationRecord, assertImprovementCandidate, createEvaluationRecord, defineEvaluator,
  promoteCandidate, proposeImprovement, reviewCandidate,
} from './evaluation.mjs';

export {
  AGENT_BLOCKED_REASONS, AGENT_REGISTRY_REASONS, APPROVAL_BINDING_REASONS, BUDGET_REASONS,
  CAPABILITY_REASONS, IDENTITY_REASONS, IMPROVEMENT_REASONS, PROPOSAL_REASONS,
  isAgentReason,
} from './reasons.mjs';
