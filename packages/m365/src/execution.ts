// ---------------------------------------------------------------------------
// execution.ts — objective / work package / task / execution records.
//
// These are AWE concepts, expressed here in the shape the Microsoft plane needs
// to reference them. They are NOT a generic workflow engine (DECISION_LOG
// 2026-07-17: "no generic agent runtime, no engine tables") — an objective is a
// pointer at a real domain row (work_requests.id), and the work package and task
// are names, not tables. Only the execution is a record of its own, because
// "which attempt was this, and what did it touch" is the question the audit
// trail has to answer and no existing table answers.
//
// Ids are DERIVED from the delivery that caused them, so the same notification
// replayed produces the same execution id — a duplicate can be recognized as one
// even if the ledger were lost.
// ---------------------------------------------------------------------------

import { hashValue } from './evidence.ts';

export type ExecutionStatus = 'running' | 'succeeded' | 'partially_succeeded' | 'failed' | 'rejected' | 'duplicate';

export interface ObjectiveRef {
  /** work_requests.id once persisted; the derived id before that. */
  readonly objectiveId: string;
  readonly aweTenantId: string;
  /** How this objective came to exist, for provenance. */
  readonly originContextItemId: string;
  readonly createdAt: string;
  /** True when an existing objective was reused rather than created. */
  readonly reused: boolean;
}

export interface ExecutionRecord {
  readonly executionId: string;
  readonly aweTenantId: string;
  readonly microsoftTenantId: string;
  readonly objectiveId: string;
  /** A named unit of work inside the objective. A string, not a table. */
  readonly workPackageId: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly deliveryKey: string;
  readonly subscriptionId: string;
  readonly status: ExecutionStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly detail: string | null;
}

export function deriveExecutionId(aweTenantId: string, deliveryKey: string): string {
  return `exec_${hashValue({ t: aweTenantId, d: deliveryKey }).slice(0, 32)}`;
}

export function deriveObjectiveId(aweTenantId: string, contextItemId: string): string {
  return `obj_${hashValue({ t: aweTenantId, c: contextItemId }).slice(0, 32)}`;
}

export function deriveTaskId(executionId: string, capability: string): string {
  return `task_${hashValue({ e: executionId, c: capability }).slice(0, 24)}`;
}

export interface ExecutionStore {
  put(record: ExecutionRecord): void;
  get(executionId: string): ExecutionRecord | null;
  all(): readonly ExecutionRecord[];
  putObjective(objective: ObjectiveRef): void;
  /** Existing objective for this context item, if the message was seen before. */
  objectiveForContextItem(aweTenantId: string, contextItemId: string): ObjectiveRef | null;
}

export function createInMemoryExecutionStore(): ExecutionStore {
  const executions = new Map<string, ExecutionRecord>();
  const objectives = new Map<string, ObjectiveRef>();
  const okey = (t: string, c: string) => `${t}|${c}`;
  return {
    put: (r) => { executions.set(r.executionId, r); },
    get: (id) => executions.get(id) ?? null,
    all: () => [...executions.values()],
    putObjective: (o) => { objectives.set(okey(o.aweTenantId, o.originContextItemId), o); },
    objectiveForContextItem: (t, c) => objectives.get(okey(t, c)) ?? null,
  };
}
