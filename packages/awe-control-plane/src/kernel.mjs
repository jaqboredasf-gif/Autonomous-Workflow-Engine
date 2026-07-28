// ---------------------------------------------------------------------------
// kernel.mjs — the control plane's single seam onto @exattime/awe-kernel.
//
// Every other module in this package imports the kernel THROUGH here and never
// directly. Two reasons, and both are enforced by the layering lint in
// scripts/eval-control-plane.mjs:
//
//   1. Dependency direction is checkable in one place. The control plane sits
//      strictly above the kernel and strictly below the runtime; if a module
//      ever reaches sideways into `packages/mcp-server`, `apps/` or `scripts/`,
//      the lint sees an import that is not `./kernel.mjs` and fails.
//   2. The kernel's package boundary stays a boundary. When the workspace gains
//      real package resolution, this is the one file whose relative path
//      changes.
//
// Nothing is redefined here. This file re-exports and adds no behaviour, so it
// cannot become a place where the kernel's contracts are quietly relaxed.
// ---------------------------------------------------------------------------

export {
  // canonical form and identity
  canonicalClone, canonicalJson, deepFreeze, digest, stableEqual,
  // failure taxonomy
  ERROR_CODES, KernelError, isKernelError, invariant,
  // outcome envelope
  OUTCOME_STATUSES, assertOutcome, blocked, createOutcome, failed, fromError, succeeded,
  // audit events
  REDACTED, assertEvent, createEvent, eventTypes, instantEpochSeconds, isInstant, redact, sequence,
  // execution context
  ACTORS, RUN_MODES, assertExecutionContext, createExecutionContext, deriveRunId, runMetadata,
  // context primitives
  CONTEXT_ITEM_KINDS, CONTEXT_SENSITIVITIES, assertContextItem, createContextItem,
  maxSensitivity, sensitivityRank,
  CONTEXT_BUNDLE_SCHEMA, assembleContext, assertContextBundle, loadContext, renderContext,
  CONTEXT_CHECKPOINT_SCHEMA, assertCheckpoint, compactContext, createCheckpoint, restoreCheckpoint,
  // tool registry primitives
  SIDE_EFFECTS, SIDE_EFFECT_RANK, LIFECYCLE_STATES, assertToolDescriptor, compareSideEffect,
  createToolCatalog, defineTool,
  // run scaffolding
  buildReport, finalStateFor, reportPath, runWorkflow,
} from '../../awe-kernel/src/index.mjs';
