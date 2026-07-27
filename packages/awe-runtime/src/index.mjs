// ---------------------------------------------------------------------------
// @exattime/awe-runtime — the AWE platform service layer.
//
// One layer, one job: compose the pure kernel with injected, impure boundaries
// (artifact sink, audit sink, checkpoint store, clock) into the operations any
// surface needs — submit a run, inspect its outcome, retrieve its report and
// audit trail, assemble and compact context, checkpoint and resume.
//
// It has no transport. An app server, a CLI worker, a scheduled job and the MCP
// server all call the SAME service rather than each re-implementing the run
// loop; adding a surface should mean adding a caller, not adding orchestration.
//
// Depends on `@exattime/awe-kernel` and nothing else — no database driver, no
// HTTP framework, no model provider. Which of those it eventually reaches is
// decided by what a caller injects, which is what keeps ADR-0002 open.
// ---------------------------------------------------------------------------

export { createPlatformService } from './service.mjs';

export {
  DEFAULT_ARTIFACT_ROOT,
  createFileArtifactSink,
  createFileAuditSink,
  createFileDocumentSink,
  listArtifacts,
  readArtifact,
} from './file-sinks.mjs';
