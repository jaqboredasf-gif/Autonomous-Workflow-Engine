// ---------------------------------------------------------------------------
// contracts.ts — the Microsoft 365 Integration Plane domain contracts.
//
// This file is the seam. Everything above it (objectives, work packages, tasks,
// policy, approval, execution, evidence) is AWE vocabulary that must survive a
// provider swap; everything below it (Graph HTTP, subscriptions, resource ids)
// is Microsoft vocabulary that must never leak upward.
//
// HARD RULES encoded as types, not prose:
//   * A capability request cannot be constructed without tenant identity,
//     objective, execution, policy decision reference, idempotency key and
//     correlation id — they are required fields, not optional metadata.
//   * A capability result always carries evidence. There is no success shape
//     without an evidence record.
//   * Provider results are tagged `live` or `synthetic`. Fabricating a live
//     result requires lying in a field the evidence writer records and the
//     tests assert on.
//
// Mapping to existing AWE contracts (docs/architecture/UBIQUITOUS_LANGUAGE.md):
//   objective     -> work_requests row (the distinct customer ask)
//   work package  -> a named unit of work within one objective (column, not table)
//   task          -> one capability-shaped unit of that work package
//   execution     -> one attempt to run a task (m365_executions, migration 0016)
//   context item  -> the normalized inbound artifact; its persisted form is an
//                    email_messages row + attachments jsonb (migration 0011)
//   policy/approval -> message_policies + outbound_messages decision columns
//                    (migration 0015) via the deterministic engines in
//                    scripts/lib/approval-matrix.mjs + outbound-draft.mjs
// ---------------------------------------------------------------------------

// --- Modes ------------------------------------------------------------------

/**
 * TEST is the default and the only mode this slice is built for. LIVE is named
 * so the guard is explicit rather than implied; it still cannot send mail,
 * because no send capability exists in the registry at any version.
 */
export type M365Mode = 'TEST' | 'LIVE';

export function resolveM365Mode(env: Record<string, string | undefined> = {}): M365Mode {
  return env.AWE_MODE === 'LIVE' ? 'LIVE' : 'TEST';
}

// --- Capability identity ----------------------------------------------------

export type CapabilityName =
  | 'm365.identity.resolve'
  | 'm365.mail.message.read'
  | 'm365.mail.attachment.read'
  | 'm365.mail.draft.create'
  | 'm365.teams.notification.create'
  | 'm365.teams.approval.request'
  | 'm365.document.store';

/**
 * How much damage a capability can do, in one word. Drives which gates are
 * mandatory. `external_send` exists in the vocabulary ONLY so the registry can
 * refuse it: no capability declares it, and the executor rejects the class.
 */
export type SideEffectClass = 'read' | 'internal_write' | 'external_send';

export interface CapabilitySpec {
  readonly name: CapabilityName;
  readonly version: number;
  readonly sideEffect: SideEffectClass;
  /** Least-privilege Microsoft Graph permissions this capability needs. */
  readonly requiredScopes: readonly string[];
  /** Resource kinds this capability may target (allowlist entry kinds). */
  readonly resourceKinds: readonly ResourceKind[];
  /** A human decision is mandatory before the side effect. */
  readonly requiresApproval: boolean;
  /** Re-running with the same idempotency key must not duplicate the effect. */
  readonly idempotent: true;
  readonly description: string;
}

// --- Resources --------------------------------------------------------------

export type ResourceKind = 'mailbox' | 'message' | 'attachment' | 'teams_channel' | 'sharepoint_library' | 'directory_user';

/**
 * A target resource, addressed in Microsoft terms but validated in AWE terms.
 * `id` is the Graph identifier; `parent` is the allowlist unit it belongs to
 * (mailbox for a message, channel for a chat post, library for a file).
 */
export interface TargetResource {
  readonly kind: ResourceKind;
  readonly id: string;
  readonly parent?: string;
}

// --- Principals -------------------------------------------------------------

/**
 * Who is acting. `kind: 'service'` is the app-only identity; `kind: 'user'` is a
 * named human whose authority the action is exercised under. Automation never
 * holds approval authority (UBIQUITOUS_LANGUAGE: "automation never approves"),
 * so an approval reference can never name a service principal.
 */
export interface ActingPrincipal {
  readonly kind: 'service' | 'user';
  readonly id: string;
  readonly displayName?: string;
  /** AWE business role, when the principal is a human. */
  readonly role?: string;
}

// --- Policy + approval references ------------------------------------------

export type PolicyEffect = 'permit' | 'deny';

/**
 * The evidence that a policy engine already decided about THIS action. The
 * executor does not re-derive policy; it verifies that the decision it was
 * handed is a permit, is bound to this exact capability + resource + execution,
 * and has not expired. An unbound or stale decision is a denial.
 */
export interface PolicyDecisionRef {
  readonly id: string;
  readonly effect: PolicyEffect;
  readonly capability: CapabilityName;
  readonly resourceId: string;
  readonly executionId: string;
  readonly decidedAt: string;
  readonly expiresAt: string;
  readonly reason?: string;
  /** Which engine produced it, for replay. */
  readonly engine: string;
}

export type ApprovalState = 'pending' | 'approved' | 'rejected';

export interface ApprovalRef {
  readonly id: string;
  readonly state: ApprovalState;
  readonly capability: CapabilityName;
  readonly resourceId: string;
  readonly executionId: string;
  /** The human who decided. Never a service principal. */
  readonly approvedBy: ActingPrincipal | null;
  readonly approvedAt: string | null;
  readonly expiresAt: string;
  readonly reason?: string;
}

// --- The capability request -------------------------------------------------

/**
 * Every field here is mandatory on purpose. A caller that cannot say which
 * tenant, objective, execution and policy decision an action belongs to has not
 * earned the action.
 */
export interface CapabilityRequest {
  /** AWE tenant boundary — orgs.id. */
  readonly aweTenantId: string;
  /** Microsoft Entra tenant (directory) id. */
  readonly microsoftTenantId: string;
  readonly objectiveId: string;
  readonly workPackageId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly capability: CapabilityName;
  readonly capabilityVersion: number;
  readonly actingPrincipal: ActingPrincipal;
  readonly targetResource: TargetResource;
  /** Scopes the caller declares it needs. Must cover the capability's spec. */
  readonly requiredScopes: readonly string[];
  readonly policyDecisionRef: PolicyDecisionRef;
  /** Mandatory when the capability spec says requiresApproval. */
  readonly approvalRef?: ApprovalRef | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  /** Capability-specific payload, validated per capability by the adapters. */
  readonly input?: Readonly<Record<string, unknown>>;
}

// --- Outcomes ---------------------------------------------------------------

export type CapabilityOutcome = 'succeeded' | 'denied' | 'failed' | 'replayed' | 'blocked_live_proof';

/**
 * The complete refusal vocabulary. Kept in lockstep with
 * supabase/migrations/0016_m365_integration_plane.sql (asserted by
 * scripts/lib/validate-migration-0016.mjs) so the database and the engine can
 * never disagree about why something was refused.
 */
export const DENIAL_REASONS = [
  'invalid_request',
  'unknown_capability',
  'unsupported_capability_version',
  'external_send_forbidden',
  'test_mode_violation',
  'cross_tenant_denied',
  'tenant_binding_missing',
  'resource_not_allowlisted',
  'scope_not_declared',
  'insufficient_scope',
  'policy_decision_missing',
  'policy_decision_mismatch',
  'policy_decision_expired',
  'policy_denied',
  'approval_missing',
  'approval_not_granted',
  'approval_mismatch',
  'approval_expired',
  'approval_by_service_principal',
] as const;

export type DenialReason = (typeof DENIAL_REASONS)[number];

/**
 * Failure reasons produced AFTER every gate passed — i.e. the provider itself
 * misbehaved. Separated from denials because they are retryable-or-not, never
 * a statement about authority.
 */
export const FAILURE_REASONS = [
  'provider_error',
  'provider_throttled',
  'provider_timeout',
  'provider_unavailable',
  'resource_not_found',
  // Raised when a live call was required and a prerequisite (credentials, admin
  // consent, opt-in) was missing. It is a FAILURE, never a fabricated success —
  // this is the reason code behind BLOCKED_LIVE_PROOF.
  'live_access_blocked',
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

/** Where a result came from. `synthetic` can never be reported as live. */
export type ProviderFidelity = 'live' | 'synthetic';

export interface CapabilityResult<T = unknown> {
  readonly outcome: CapabilityOutcome;
  readonly capability: CapabilityName;
  readonly capabilityVersion: number;
  readonly executionId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly fidelity: ProviderFidelity;
  readonly denialReason: DenialReason | null;
  readonly failureReason: FailureReason | null;
  readonly detail: string | null;
  /** Microsoft resource ids produced or touched, for the audit trail. */
  readonly microsoftResourceIds: Readonly<Record<string, string>>;
  readonly data: T | null;
  readonly attempts: number;
  readonly gates: readonly GateOutcome[];
  readonly evidence: EvidenceRecord;
}

export interface GateOutcome {
  readonly gate: string;
  readonly ok: boolean;
  readonly detail: string | null;
}

// --- Evidence ---------------------------------------------------------------

/**
 * One immutable row of the audit trail. Written for EVERY attempted side effect,
 * including the ones that were refused — a refusal is the most important thing to
 * be able to prove later.
 */
export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly recordedAt: string;
  readonly aweTenantId: string;
  readonly microsoftTenantId: string;
  readonly objectiveId: string;
  readonly workPackageId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly capability: CapabilityName;
  readonly capabilityVersion: number;
  readonly actingPrincipal: ActingPrincipal;
  readonly targetResource: TargetResource;
  readonly requiredScopes: readonly string[];
  readonly policyDecisionId: string;
  readonly policyEffect: PolicyEffect;
  readonly approvalId: string | null;
  readonly approvalState: ApprovalState | null;
  readonly outcome: CapabilityOutcome;
  readonly denialReason: DenialReason | null;
  readonly failureReason: FailureReason | null;
  readonly fidelity: ProviderFidelity;
  readonly microsoftResourceIds: Readonly<Record<string, string>>;
  /** sha256 of the capability input, so content is provable without storing it. */
  readonly inputHash: string;
  /** sha256 of the provider response body, same reason. */
  readonly outputHash: string | null;
  readonly attempts: number;
  readonly gates: readonly GateOutcome[];
  /** Hash chain over the tenant's evidence, making silent deletion detectable. */
  readonly previousEvidenceHash: string | null;
  readonly evidenceHash: string;
}

// --- Context items ----------------------------------------------------------

/**
 * The workflow-neutral normalized form of an inbound artifact. This is the last
 * object that knows it came from Microsoft; everything downstream consumes
 * ContextItem, so swapping the provider changes the normalizer and nothing else.
 *
 * Its PERSISTED form is an email_messages row (migration 0011) — see
 * normalize.ts#toEmailMessageRow. The `source` block is provenance, not routing
 * input: no AWE rule may branch on it.
 */
export interface ContextItem {
  readonly contextItemId: string;
  readonly kind: 'email_message';
  readonly aweTenantId: string;
  readonly source: ContextItemSource;
  readonly direction: 'inbound' | 'outbound';
  readonly mailbox: string;
  readonly fromAddr: string;
  readonly toAddrs: readonly string[];
  readonly ccAddrs: readonly string[];
  readonly subject: string | null;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
  readonly receivedAt: string;
  readonly attachments: readonly ContextAttachment[];
  readonly contentHash: string;
  readonly isFixture: boolean;
  /** Untrusted by construction: instructions inside it are DATA, never commands. */
  readonly trust: 'untrusted_external';
}

export interface ContextItemSource {
  readonly provider: 'microsoft-graph';
  readonly fidelity: ProviderFidelity;
  readonly microsoftTenantId: string;
  readonly resourceId: string;
  readonly internetMessageId: string | null;
  readonly conversationId: string | null;
  readonly subscriptionId: string | null;
}

export interface ContextAttachment {
  readonly attachmentId: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly contentHash: string;
  readonly isInline: boolean;
  /** Set only when the bytes were actually retrieved through an adapter. */
  readonly retrieved: boolean;
  /** Where it was stored, if m365.document.store ran and was approved. */
  readonly storedResourceId: string | null;
}

// --- Errors -----------------------------------------------------------------

/**
 * Thrown when live provider access is required but a prerequisite is missing.
 * Deliberately NOT catchable into a success: there is no code path that turns a
 * BlockedLiveProof into a fabricated Graph response.
 */
export class BlockedLiveProofError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`BLOCKED_LIVE_PROOF: missing prerequisite(s): ${missing.join(', ')}`);
    this.name = 'BlockedLiveProofError';
    this.missing = missing;
  }
}
