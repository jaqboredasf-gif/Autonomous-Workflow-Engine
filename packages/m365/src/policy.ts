// ---------------------------------------------------------------------------
// policy.ts — the seam to AWE's EXISTING policy and approval contracts.
//
// This package deliberately does not contain a policy engine. AWE already has
// one — the approval matrix (message_policies rows, routed by
// scripts/lib/approval-matrix.mjs and its SQL twin route_outbound() in migration
// 0015) — and adding a second would create exactly the drift the repo's
// engine/SQL parity checks exist to prevent.
//
// So the Microsoft plane declares two interfaces and asks to be handed
// implementations. The deterministic runner binds them to the real engines
// (scripts/lib/m365-policy-bridge.mjs); a deployment binds them to the database.
// Either way the Microsoft plane cannot decide its own authority.
// ---------------------------------------------------------------------------

import type {
  ActingPrincipal,
  ApprovalRef,
  CapabilityName,
  PolicyDecisionRef,
  TargetResource,
} from './contracts.ts';

export interface PolicyQuery {
  readonly aweTenantId: string;
  readonly capability: CapabilityName;
  readonly targetResource: TargetResource;
  readonly executionId: string;
  readonly objectiveId: string;
  readonly actingPrincipal: ActingPrincipal;
  /** Money the action commits the company to, when there is any. */
  readonly amountCents?: number | null;
  /** Business message type, when the action maps to one (approval-matrix input). */
  readonly messageType?: string;
  readonly atIso: string;
}

export interface PolicyEngine {
  /**
   * Returns a decision reference bound to THIS capability, resource and
   * execution. Implementations must fail closed: no applicable rule is a deny,
   * never a permit.
   */
  decide(query: PolicyQuery): PolicyDecisionRef;
}

export interface ApprovalQuery {
  readonly aweTenantId: string;
  readonly capability: CapabilityName;
  readonly targetResource: TargetResource;
  readonly executionId: string;
  readonly objectiveId: string;
  readonly approverRole: string;
  readonly reason: string;
  readonly atIso: string;
}

export interface ApprovalStore {
  /** Create a pending approval. Creating one never grants anything. */
  request(query: ApprovalQuery): ApprovalRef;
  get(approvalId: string): ApprovalRef | null;
  /**
   * Record a human decision. Implementations MUST refuse a service principal
   * (automation never approves) and MUST refuse a second decision on the same
   * approval — the same one-decision-per-message rule record_approval() enforces
   * in migration 0015.
   */
  decide(approvalId: string, decision: 'approved' | 'rejected', by: ActingPrincipal, atIso: string): ApprovalRef;
  all(): readonly ApprovalRef[];
}

export class ApprovalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

/**
 * In-memory approval store with the same invariants as the database one. Used by
 * the deterministic tests to stand in for a human queue; the synthetic decision
 * it records is explicitly synthetic and can only ever unlock TEST-mode
 * capabilities against allowlisted development resources.
 */
export function createInMemoryApprovalStore(validityMs = 3_600_000): ApprovalStore {
  const rows = new Map<string, ApprovalRef>();
  let seq = 0;

  return {
    request(query) {
      seq += 1;
      const id = `apr_${query.executionId}_${seq}`;
      const ref: ApprovalRef = {
        id,
        state: 'pending',
        capability: query.capability,
        resourceId: query.targetResource.id,
        executionId: query.executionId,
        approvedBy: null,
        approvedAt: null,
        expiresAt: new Date(Date.parse(query.atIso) + validityMs).toISOString(),
        reason: query.reason,
      };
      rows.set(id, ref);
      return ref;
    },

    get: (id) => rows.get(id) ?? null,

    decide(approvalId, decision, by, atIso) {
      const current = rows.get(approvalId);
      if (!current) throw new ApprovalError('unknown_approval', `no approval '${approvalId}'`);
      if (current.state !== 'pending') {
        throw new ApprovalError('already_decided', `approval '${approvalId}' is already '${current.state}'`);
      }
      if (by.kind !== 'user') {
        throw new ApprovalError('approval_by_service_principal', 'automation never approves');
      }
      const next: ApprovalRef = {
        ...current,
        state: decision,
        approvedBy: by,
        approvedAt: atIso,
        expiresAt: new Date(Date.parse(atIso) + validityMs).toISOString(),
      };
      rows.set(approvalId, next);
      return next;
    },

    all: () => [...rows.values()],
  };
}
