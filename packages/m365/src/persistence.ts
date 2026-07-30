// ---------------------------------------------------------------------------
// persistence.ts — the rows this slice would write, as data.
//
// The Microsoft plane does not open a database connection. It produces a
// PERSISTENCE PLAN: the exact rows, column for column, that migration 0016 (and
// 0011 for email_messages) defines. The caller — a runner, an MCP tool, an n8n
// consumer — is what writes them, through the same triggers and RLS every other
// AWE write goes through.
//
// Two reasons this is a plan and not a client:
//   1. AGENTS.md: live migrations need explicit human approval, and 0016 has not
//      been applied. Code that assumed the tables exist would be untestable
//      fiction; a plan is verifiable against the migration file today
//      (scripts/lib/validate-migration-0016.mjs asserts column parity).
//   2. It keeps the provider plane free of persistence concerns, which is the
//      same separation that lets the provider be swapped.
// ---------------------------------------------------------------------------

import type { EvidenceRecord } from './contracts.ts';
import type { EmailMessageRow } from './normalize.ts';
import { toEmailMessageRow } from './normalize.ts';
import type { SliceResult } from './pipeline.ts';
import type { SubscriptionRecord } from './subscriptions.ts';

export interface M365SubscriptionRow {
  readonly org_id: string;
  readonly subscription_id: string;
  readonly microsoft_tenant_id: string;
  readonly resource: string;
  readonly resource_kind: string;
  readonly resource_unit_id: string;
  readonly change_types: readonly string[];
  readonly notification_url: string;
  /** Hash only. The clientState secret itself never reaches the database. */
  readonly client_state_hash: string;
  readonly expires_at: string;
  readonly state: string;
}

export interface M365NotificationRow {
  readonly org_id: string;
  readonly delivery_key: string | null;
  readonly subscription_id: string;
  readonly microsoft_tenant_id: string;
  readonly resource: string;
  readonly change_type: string;
  readonly accepted: boolean;
  readonly rejection_reason: string | null;
  readonly detail: string | null;
  readonly execution_id: string | null;
  readonly delivery_count: number;
  readonly received_at: string;
}

export interface M365ExecutionRow {
  readonly org_id: string;
  readonly execution_id: string;
  readonly microsoft_tenant_id: string;
  readonly objective_id: string;
  readonly work_package_id: string;
  readonly task_id: string;
  readonly correlation_id: string;
  readonly delivery_key: string;
  readonly subscription_id: string;
  readonly status: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly detail: string | null;
}

export interface M365InvocationRow {
  readonly org_id: string;
  readonly evidence_id: string;
  readonly recorded_at: string;
  readonly microsoft_tenant_id: string;
  readonly objective_id: string;
  readonly work_package_id: string;
  readonly task_id: string;
  readonly execution_id: string;
  readonly correlation_id: string;
  readonly idempotency_key: string;
  readonly capability: string;
  readonly capability_version: number;
  readonly acting_principal: Record<string, unknown>;
  readonly target_resource: Record<string, unknown>;
  readonly required_scopes: readonly string[];
  readonly policy_decision_id: string;
  readonly policy_effect: string;
  readonly approval_id: string | null;
  readonly approval_state: string | null;
  readonly outcome: string;
  readonly denial_reason: string | null;
  readonly failure_reason: string | null;
  readonly fidelity: string;
  readonly microsoft_resource_ids: Record<string, string>;
  readonly input_hash: string;
  readonly output_hash: string | null;
  readonly attempts: number;
  readonly gates: readonly Record<string, unknown>[];
  readonly previous_evidence_hash: string | null;
  readonly evidence_hash: string;
}

export interface PersistencePlan {
  readonly email_messages: readonly EmailMessageRow[];
  readonly m365_notifications: readonly M365NotificationRow[];
  readonly m365_executions: readonly M365ExecutionRow[];
  readonly m365_capability_invocations: readonly M365InvocationRow[];
}

export function subscriptionRow(sub: SubscriptionRecord, clientStateHash: string): M365SubscriptionRow {
  return {
    org_id: sub.aweTenantId,
    subscription_id: sub.subscriptionId,
    microsoft_tenant_id: sub.microsoftTenantId,
    resource: sub.resource,
    resource_kind: sub.resourceKind,
    resource_unit_id: sub.resourceUnitId,
    change_types: sub.changeTypes,
    notification_url: sub.notificationUrl,
    client_state_hash: clientStateHash,
    expires_at: sub.expiresAt,
    state: sub.state,
  };
}

export function evidenceRow(e: EvidenceRecord): M365InvocationRow {
  return {
    org_id: e.aweTenantId,
    evidence_id: e.evidenceId,
    recorded_at: e.recordedAt,
    microsoft_tenant_id: e.microsoftTenantId,
    objective_id: e.objectiveId,
    work_package_id: e.workPackageId,
    task_id: e.taskId,
    execution_id: e.executionId,
    correlation_id: e.correlationId,
    idempotency_key: e.idempotencyKey,
    capability: e.capability,
    capability_version: e.capabilityVersion,
    acting_principal: { ...e.actingPrincipal },
    target_resource: { ...e.targetResource },
    required_scopes: e.requiredScopes,
    policy_decision_id: e.policyDecisionId,
    policy_effect: e.policyEffect,
    approval_id: e.approvalId,
    approval_state: e.approvalState,
    outcome: e.outcome,
    denial_reason: e.denialReason,
    failure_reason: e.failureReason,
    fidelity: e.fidelity,
    microsoft_resource_ids: { ...e.microsoftResourceIds },
    input_hash: e.inputHash,
    output_hash: e.outputHash,
    attempts: e.attempts,
    gates: e.gates.map((g) => ({ ...g })),
    previous_evidence_hash: e.previousEvidenceHash,
    evidence_hash: e.evidenceHash,
  };
}

/**
 * Build the full plan for one slice run. `evidence` is the evidence log filtered
 * to this execution — every attempted side effect, in order, including refusals.
 */
export function buildPersistencePlan(
  slice: SliceResult,
  evidence: readonly EvidenceRecord[],
): PersistencePlan {
  const a = slice.notificationAudit;

  const notifications: M365NotificationRow[] = [{
    org_id: a.aweTenantId,
    delivery_key: a.deliveryKey,
    subscription_id: a.subscriptionId,
    microsoft_tenant_id: a.microsoftTenantId,
    resource: a.resource,
    change_type: a.changeType,
    accepted: a.accepted,
    rejection_reason: a.rejection,
    detail: a.detail,
    execution_id: a.executionId,
    delivery_count: a.deliveryCount,
    received_at: a.receivedAt,
  }];

  const executions: M365ExecutionRow[] = slice.execution
    ? [{
        org_id: slice.execution.aweTenantId,
        execution_id: slice.execution.executionId,
        microsoft_tenant_id: slice.execution.microsoftTenantId,
        objective_id: slice.execution.objectiveId,
        work_package_id: slice.execution.workPackageId,
        task_id: slice.execution.taskId,
        correlation_id: slice.execution.correlationId,
        delivery_key: slice.execution.deliveryKey,
        subscription_id: slice.execution.subscriptionId,
        status: slice.execution.status,
        started_at: slice.execution.startedAt,
        ended_at: slice.execution.endedAt,
        detail: slice.execution.detail,
      }]
    : [];

  return {
    // A duplicate delivery contributes a notification row and NOTHING else —
    // no email_messages row, no execution, no invocation. That is the whole
    // point of the ledger, expressed as data.
    email_messages: slice.contextItem ? [toEmailMessageRow(slice.contextItem)] : [],
    m365_notifications: notifications,
    m365_executions: executions,
    m365_capability_invocations: evidence.map(evidenceRow),
  };
}
