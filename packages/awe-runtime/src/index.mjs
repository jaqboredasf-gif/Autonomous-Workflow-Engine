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
// Depends on the pure platform packages (`@exattime/awe-kernel`,
// `@exattime/awe-control-plane`, `@exattime/awe-agent-runtime`, and
// `@exattime/awe-memory`) and no provider implementation — no database driver,
// HTTP framework, model SDK, or vector client. Concrete boundaries are injected.
//
// Four services live here, and the split is the point:
//
//   createPlatformService       run ONE registered tool through the kernel.
//   createControlPlaneService   run a REGISTERED WORKFLOW: resolve, authorize,
//                               validate context, walk steps through the
//                               controlled tool boundary, pause for a human,
//                               resume, compensate, and persist a verifiable
//                               journal of all of it.
//   createAgentService          run a bounded provider-neutral agent loop.
//   createMemoryService         manage tenant-bound versioned long-lived facts.
// ---------------------------------------------------------------------------

export { createPlatformService } from './service.mjs';

export { createControlPlaneService } from './control-plane-service.mjs';

export { createAgentService } from './agent-service.mjs';

export { createMemoryService } from './memory-service.mjs';

export {
  createAgentRuntimeExecutionAdapter,
  createDurableExecutionService,
  createWorkflowRuntimeExecutionAdapter,
} from './execution-service.mjs';

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

export {
  createDurableOperationsExecutor,
  createDurableOperationsMemory,
  createSyntheticEffectAdapter,
} from './reference/durable-operations.mjs';
