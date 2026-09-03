// ---------------------------------------------------------------------------
// kernel.mjs — the agent plane's single seam onto the layers below it.
//
// Same rule the control plane holds itself to (`awe-control-plane/src/kernel.mjs`):
// every other module in this package imports the kernel and the control plane
// THROUGH here and never directly, so the layering lint in
// scripts/eval-governed-agent.mjs can check dependency direction in one place:
//
//   awe-kernel  <-  awe-control-plane  <-  awe-agent  <-  awe-runtime  <- surfaces
//                                            (this)
//
// This package imports those two and NOTHING else — not the runtime, not the
// MCP server, not `apps/`, not `scripts/`. It has no network, no filesystem, no
// clock, no randomness and no ambient environment; every one of those arrives
// as an injected argument.
//
// Nothing is redefined here. This file re-exports and adds no behaviour, so it
// cannot become a place where a contract is quietly relaxed.
// ---------------------------------------------------------------------------

export {
  // canonical form and identity
  canonicalClone, canonicalJson, deepFreeze, digest, stableEqual,
  // failure taxonomy
  ERROR_CODES, KernelError, isKernelError, invariant,
  // outcome envelope
  assertOutcome, blocked, createOutcome, failed, fromError, succeeded,
  // audit events
  REDACTED, assertEvent, createEvent, isInstant, instantEpochSeconds, redact,
  // execution context
  ACTORS, RUN_MODES, assertExecutionContext, createExecutionContext, deriveRunId,
  // context primitives
  CONTEXT_ITEM_KINDS, CONTEXT_SENSITIVITIES, assembleContext, assertContextBundle,
  assertContextItem, createContextItem, maxSensitivity, sensitivityRank,
  // tool registry primitives
  SIDE_EFFECTS, SIDE_EFFECT_RANK, LIFECYCLE_STATES, assertToolDescriptor,
  compareSideEffect, createToolCatalog, defineTool,
} from '../../awe-kernel/src/index.mjs';

export {
  // the workflow manifest the agent Execution Surface compiles to
  defineWorkflowManifest, assertWorkflowManifest, satisfiesVersion, tenantInScope,
  toolRequirement, validateContextRequirements, compareVersionsDesc,
  // the deterministic policy engine and the approval rules — reused, never restated
  CONTROL_PLANE_BLOCKED_REASONS, POLICY_DECISIONS,
  createPolicyEngine, defineToolGrant, evaluateApprovalDecision,
  // the append-only journal and its projection
  AGENT_EVENT_TYPES, RUN_EVENT_TYPES, RUN_STATES, TERMINAL_STATES, TRANSITIONS,
  createRunJournal, loadRunJournal, projectRunState, verifyChain,
  // the controlled tool-invocation boundary
  createToolDispatcher,
} from '../../awe-control-plane/src/index.mjs';
