// ---------------------------------------------------------------------------
// @exattime/awe-kernel — the deterministic workflow kernel for the Autonomous
// Workflow Engine.
//
// What it is: the small set of primitives every AWE workflow and every runner
// was re-implementing by hand — a shared outcome envelope, a blocked-reason
// registry, an audit-event envelope with content-addressed idempotency, Verify
// Steps as data, labelled fixture corpora, gate runs, and the suite registry
// that drives regression. On top of those, the run scaffolding: an execution
// context, a durable run-report schema, the artifact/audit sink boundaries, and
// `runWorkflow`, which turns "receive a request → gate → execute → report →
// persist → terminate" into one call that never throws.
//
// What it is NOT (deliberately, per AGENT_HARNESS.md doctrine): an agent
// runtime, a tool dispatcher, a prompt engine, a queue worker, or anything with
// its own tables. It has no model, no loop, and no memory.
//
// Guarantees this package holds itself to, enforced by the layering lint in
// scripts/eval-kernel.mjs:
//   * zero runtime dependencies — node stdlib only;
//   * no network (`fetch`, http, sockets) anywhere;
//   * no clock (`Date.now`, `new Date()`) and no randomness — a kernel that
//     reads the clock cannot be part of a determinism gate;
//   * no filesystem WRITES (two modules read files: corpus loading and source
//     purity scanning);
//   * no imports from `apps/`, `scripts/` or any other package — the kernel is
//     the bottom layer and depends on nothing above it.
// ---------------------------------------------------------------------------

export {
  DIGEST_ALGORITHM, DEFAULT_DIGEST_LENGTH,
  canonicalJson, canonicalClone, digest, stableEqual, deepFreeze, get, isPlainObject,
} from './canonical.mjs';

export { ERROR_CODES, KernelError, isKernelError, invariant } from './errors.mjs';

export { createReasonRegistry, isValidReason } from './reasons.mjs';

export {
  OUTCOME_STATUSES, OUTCOME_KEYS,
  succeeded, blocked, failed, fromError, createOutcome, assertOutcome, assertNoEvents,
} from './outcome.mjs';

export {
  EVENT_ENVELOPE_KEYS, REDACTED,
  createEvent, assertEvent, sequence, eventTypes, redact, isInstant, instantDate,
} from './events.mjs';

export {
  RUN_METADATA_KEYS, ACTORS, RUN_MODES,
  createExecutionContext, assertExecutionContext, runMetadata, deriveRunId,
} from './context.mjs';

export {
  ARTIFACT_SINK_METHODS, AUDIT_SINK_METHODS, CONTEXT_PROVIDER_METHODS, CONTEXT_ITEM_KINDS,
  createArtifactSink, memoryArtifactSink, nullArtifactSink,
  createAuditSink, memoryAuditSink, defineContextProvider,
} from './sinks.mjs';

export {
  REPORT_SCHEMA, REPORT_KEYS, FINAL_STATES,
  buildReport, assertReport, reportPath, serializeReport, finalStateFor,
} from './report.mjs';

export { runWorkflow } from './execute.mjs';

export { CHECK_KINDS, defineVerify, runVerify, explain } from './verify.mjs';

export { corpusParity, buildCorpus, loadCorpus } from './corpus.mjs';

export { createGateRun, stripComments } from './gates.mjs';

export { SUITE_KINDS, defineSuite, createSuiteRegistry, planRegression } from './suite.mjs';

export { SUITES, registry } from './registry.mjs';
