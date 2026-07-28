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
// Depends on `@exattime/awe-kernel` and `@exattime/awe-control-plane` and
// nothing else — no database driver, no HTTP framework, no model provider.
// Which of those it eventually reaches is decided by what a caller injects,
// which is what keeps ADR-0002 open.
//
// Two services live here, and the split is the point:
//
//   createPlatformService       run ONE registered tool through the kernel.
//   createControlPlaneService   run a REGISTERED WORKFLOW: resolve, authorize,
//                               validate context, walk steps through the
//                               controlled tool boundary, pause for a human,
//                               resume, compensate, and persist a verifiable
//                               journal of all of it.
// ---------------------------------------------------------------------------

export { createPlatformService } from './service.mjs';

export { createControlPlaneService } from './control-plane-service.mjs';

export { createAgentService } from './agent-service.mjs';

export {
  DEFAULT_ARTIFACT_ROOT,
  createFileArtifactSink,
  createFileAuditSink,
  createFileDocumentSink,
  listArtifacts,
  readArtifact,
} from './file-sinks.mjs';

export {
  DEFAULT_JOURNAL_ROOT,
  createFileJournalStore,
  createMemoryJournalStore,
} from './journal-store.mjs';

export {
  RESULT_DOCUMENT_SCHEMA,
  createFileResultStore,
  createMemoryResultStore,
} from './result-store.mjs';

export { createFixedClock, createSteppingClock } from './clock.mjs';

export {
  OPERATIONS_ORG,
  OTHER_OPERATIONS_ORG,
  createOperationsAgentFixture,
  operationsAgent,
  operationsAgentContext,
  operationsGrants,
  operationsModelAdapter,
  operationsRunRequest,
  operationsTools,
  operationsValidators,
  operationsWorkflow,
} from './reference/operations-agent.mjs';
