// ---------------------------------------------------------------------------
// artifact-store.mjs — the runners' import path for the local-filesystem sinks.
//
// The implementation moved to `packages/awe-runtime/src/file-sinks.mjs` when the
// MCP server started persisting a run report for every call: a deployable
// package cannot import from `scripts/`, and duplicating an atomic writer is how
// two writers end up disagreeing about containment.
//
// This file stays as the runners' entry point so that Runner 4, Runner 5,
// Runner E and `runner-report.mjs` are untouched by that move. It adds nothing
// and decides nothing.
// ---------------------------------------------------------------------------

export {
  DEFAULT_ARTIFACT_ROOT,
  createFileArtifactSink,
  createFileAuditSink,
  createFileDocumentSink,
  listArtifacts,
  readArtifact,
} from '../../packages/awe-runtime/src/file-sinks.mjs';
