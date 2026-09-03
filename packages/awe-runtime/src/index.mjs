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

// The third service, and the split is again the point:
//
//   createPlatformService        run ONE registered tool through the kernel.
//   createControlPlaneService    run a REGISTERED WORKFLOW — a declared step list.
//   createGovernedAgentService   run a REGISTERED AGENT — steps PROPOSED at
//                                runtime by a planner and authorized one at a
//                                time by the governed agent plane.
export { createGovernedAgentService } from './agent-service.mjs';

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

export {
  DEFAULT_LEASE_TTL_MS,
  createFileLeaseStore,
  createMemoryLeaseStore,
  leaseGranted,
  leaseRefused,
} from './lease-store.mjs';

// The durable, cross-process implementations of the same three ports. They are
// exported from the same package as the memory and file stores on purpose: an
// application chooses a store, not a storage strategy, and the choice is one
// argument at composition (see `selectStores` below and ADR-0010).
//
// The package STILL depends on no database driver. Every one of these takes an
// injected executor — `call(fn, payload)` and nothing else — so what is
// underneath is the caller's decision and this package holds no credential, no
// URL and no connection.
export {
  RPC_FUNCTIONS,
  StoreUnavailableError,
  assertExecutor,
  createSupabaseRpcExecutor,
  isStoreUnavailable,
} from './postgres/executor.mjs';

export { createPostgresJournalStore } from './postgres/journal-store.mjs';
export { createPostgresLeaseStore } from './postgres/lease-store.mjs';
export { createPostgresResultStore } from './postgres/result-store.mjs';

export { STORE_BACKENDS, selectStores } from './store-selection.mjs';

export { createFixedClock, createSteppingClock, instantPlus } from './clock.mjs';
