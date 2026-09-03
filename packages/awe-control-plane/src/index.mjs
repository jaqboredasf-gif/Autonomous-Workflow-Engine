// ---------------------------------------------------------------------------
// @exattime/awe-control-plane — the AWE execution control plane.
//
// The layer between the deterministic kernel (which executes) and the platform
// runtime (which persists and exposes). It answers the questions the kernel
// deliberately refuses to answer:
//
//   WHICH workflow, at which version?      -> manifest.mjs, workflow-registry.mjs
//   MAY this tenant run it?                -> workflow-registry.mjs, policy.mjs
//   MAY this tool run, and does a human
//     have to say yes first?               -> policy.mjs, dispatch.mjs
//   WHAT actually happened, provably?      -> journal.mjs
//   WHAT happens on failure, timeout,
//     cancellation or denial?              -> engine.mjs
//
// Dependency direction, enforced by the layering lint in
// scripts/eval-control-plane.mjs:
//
//   awe-kernel  <-  awe-control-plane  <-  awe-runtime  <-  surfaces
//                        (this)
//
// This package imports the kernel and NOTHING else — not the runtime, not the
// MCP server, not `apps/`, not `scripts/`. It has no network, no filesystem, no
// clock and no ambient environment; every one of those arrives as an injected
// argument.
//
// FAIL-CLOSED SUMMARY, all mechanically asserted by Runner P:
//   * an invalid or incomplete manifest is refused, not defaulted;
//   * only the registry produces something executable — there is no parameter
//     anywhere in this package that accepts a workflow definition;
//   * an unpromoted, out-of-scope or dependency-unsatisfied workflow does not
//     run;
//   * a tool with no tenant grant does not run (deny by default);
//   * a consequential tool does not run without a human approval, and an
//     approval submitted by `actor: 'service'` is refused (doctrine G4);
//   * `mode: 'LIVE'` is refused outright until ADR-0002 is ratified;
//   * a tampered run journal is refused rather than resumed.
// ---------------------------------------------------------------------------

export {
  WORKFLOW_MANIFEST_SCHEMA, MANIFEST_KEYS, RISK_CLASSES, PROMOTION_STATES,
  TENANT_SCOPE_MODES, STEP_FAILURE_POLICIES,
  assertWorkflowManifest, compareVersionsDesc, defineWorkflowManifest,
  requiresApproval, satisfiesVersion, stepById, tenantInScope, toolRequirement,
  validateContextRequirements,
} from './manifest.mjs';

export { RESOLUTION_REASONS, createWorkflowRegistry } from './workflow-registry.mjs';

export {
  APPROVAL_DECISIONS, CONTROL_PLANE_BLOCKED_REASONS, POLICY_DECISIONS,
  createPolicyEngine, defineToolGrant, evaluateApprovalDecision,
} from './policy.mjs';

export {
  AGENT_EVENT_TYPES, RUN_EVENT_TYPES, RUN_JOURNAL_SCHEMA, RUN_STATES, TERMINAL_STATES,
  TRANSITIONS, WORKFLOW_EVENT_TYPES,
  createRunJournal, genesisDigest, loadRunJournal, projectRunState, verifyChain,
} from './journal.mjs';

export {
  EXECUTABLE_LIFECYCLES, INVOCATION_STATUSES, createToolDispatcher,
} from './dispatch.mjs';

export { ADVANCE_OUTCOMES, createRunEngine, isRetryable } from './engine.mjs';

export {
  MISSING, PREDICATE_OPS, PREDICATE_ROOTS,
  definePredicate, evaluatePredicate, isMissing, predicateDigest, predicateScope, resolvePath,
} from './predicate.mjs';

export {
  CLAIM_MODES, RUN_LEASE_SCHEMA,
  assertRunLease, defineRunLease, evaluateClaim, evaluateHold, evaluateRelease,
  isExpired, remainingMs,
} from './lease.mjs';
