// ---------------------------------------------------------------------------
// approval-queue.ts  (Task B5 — approval queue: the decidable logic, extracted)
//
// PURE, OFFLINE, DETERMINISTIC. No React, no Supabase client, no fetch, no
// clock, no randomness — every function is a function of its arguments. The
// page (src/app/approvals/page.tsx) is the shell around this module; Runner 5
// (scripts/eval-approval-queue.mjs) is the test harness in front of it.
//
// WHAT THIS MODULE IS NOT:
//   * It is NOT a second approval system. The authority is 0015's
//     `record_approval()` RPC plus RLS; everything here is the browser-side
//     mirror that decides what to OFFER a human. Every guard it applies is
//     already enforced in the database — if the two ever disagree, the database
//     wins and the UI shows the raised error verbatim.
//   * It has NO send capability. There is no mark_message_sent() call in this
//     module or in the page that consumes it (asserted by Runner 5's source
//     purity gate). B5 is approve/reject only.
//
// The TEST-mode contract and the shared vocabulary are IMPORTED from
// scripts/lib/approval-matrix.mjs (the B3 engine) rather than restated, so
// there is one definition of "@example.invalid" and one definition of a
// fixture-safe recipient in the repo.
//
// Contract + rationale: docs/testing/APPROVAL_QUEUE.md
// ---------------------------------------------------------------------------

import {
  enforceTestMode,
  resolveMode,
  FIXTURE_EMAIL_DOMAIN,
  BUSINESS_ROLES,
  MESSAGE_TYPES,
} from '../../../../scripts/lib/approval-matrix.mjs';

export { FIXTURE_EMAIL_DOMAIN, BUSINESS_ROLES, MESSAGE_TYPES };

// The engine is plain JS: its default-valued parameters infer as `never[]`
// under TS, so the two functions this module consumes are re-declared with the
// signature they actually have. Behavior is the engine's — this names it.
const testModeGate = enforceTestMode as (a: {
  recipients: string[];
  isFixture: boolean;
  mode: string;
}) => { ok: boolean; violations: string[]; mode: string };

const modeOf = resolveMode as (env: { AWE_MODE?: string }) => string;

// --- Vocabulary (mirrors 0015's enums; asserted in lockstep by Runner 5) -----

export const OUTBOUND_STATUSES = [
  'draft',
  'approved',
  'rejected',
  'sent',
  'failed',
  'blocked',
] as const;

export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

/** The only status a human may decide on. 0015: "only a draft can be decided". */
export const DECIDABLE_STATUSES: readonly OutboundStatus[] = ['draft'];

/** Statuses that still need a human's eyes, in queue order. */
export const QUEUE_TABS = ['pending', 'blocked', 'decided'] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

/**
 * Why the UI refuses to offer a decision. Deliberately distinct from the B3
 * engine's BLOCKED_REASONS (which describe why a message could not be ROUTED);
 * 'test_mode_violation' is the one shared name, and it is shared on purpose —
 * it means exactly what enforceTestMode() means by it.
 */
export const GUARD_REASONS = [
  'not_pending', // already decided — duplicate-decision protection
  'unassigned_approver', // blocked row: nobody is accountable, nothing to approve
  'unauthorized_approver', // signed-in user does not hold the assigned role
  'test_mode_violation', // TEST mode, row is not fixture-safe
  'fixture_in_live_mode', // LIVE mode, row is a fixture
  'missing_rejection_reason', // reject without the required reason
  'unknown_decision', // decision verb outside {approve, reject}
] as const;

export type GuardReason = (typeof GUARD_REASONS)[number];

export const DECISIONS = ['approve', 'reject'] as const;
export type Decision = (typeof DECISIONS)[number];

// --- Row shape --------------------------------------------------------------

export interface NamedUser {
  full_name: string | null;
}

export interface QueuePolicy {
  message_type: string;
  mode: 'draft' | 'auto';
  approver_role: string | null;
  backup_approver_role: string | null;
  escalation_role: string | null;
  approval_limit_cents: number | null;
  active: boolean;
}

export interface QueueEmail {
  from_addr: string | null;
  subject: string | null;
  received_at: string | null;
  mailbox: string | null;
}

export interface QueueRequest {
  id: string;
  customer_name: string | null;
  customer_email: string | null;
  classification: string | null;
  status: string | null;
  county: string | null;
  zip: string | null;
  created_at: string | null;
  email_messages: QueueEmail | null;
}

/** One row of the approval queue, exactly as QUEUE_SELECT returns it. */
export interface QueueRow {
  id: string;
  message_type: string;
  status: OutboundStatus;
  subject: string | null;
  body_text: string | null;
  to_addrs: string[] | null;
  cc_addrs: string[] | null;
  bcc_addrs: string[] | null;
  amount_cents: number | null;
  assigned_approver_role: string | null;
  routing_path: string | null;
  escalated: boolean;
  escalation_reason: string | null;
  blocked_reason: string | null;
  draft_key: string;
  is_fixture: boolean;
  created_at: string;
  updated_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  sent_at: string | null;
  graph_message_id: string | null;
  approver: NamedUser | null;
  rejector: NamedUser | null;
  sender: NamedUser | null;
  message_policies: QueuePolicy | null;
  work_requests: QueueRequest | null;
}

/**
 * The exact PostgREST projection the queue reads. Exported so the page and
 * scripts/acceptance-slice5.sh use ONE string — a drifted acceptance test that
 * queries different columns than the UI proves nothing about the UI.
 *
 * Three separate FKs point at `users`, so each embed names its constraint.
 * Nothing here is service-role-only: every table in it (outbound_messages,
 * message_policies, work_requests, email_messages, users) has an org-scoped
 * admin SELECT policy. integration_events is deliberately absent — it has NO
 * client policy, and B5 does not add one (see buildAuditTrail).
 */
export const QUEUE_SELECT = [
  'id, message_type, status, subject, body_text, to_addrs, cc_addrs, bcc_addrs',
  'amount_cents, assigned_approver_role, routing_path, escalated, escalation_reason',
  'blocked_reason, draft_key, is_fixture, created_at, updated_at',
  'approved_at, rejected_at, rejection_reason, sent_at, graph_message_id',
  'approver:users!outbound_messages_approved_by_fkey(full_name)',
  'rejector:users!outbound_messages_rejected_by_fkey(full_name)',
  'sender:users!outbound_messages_sent_marked_by_fkey(full_name)',
  'message_policies(message_type, mode, approver_role, backup_approver_role, escalation_role, approval_limit_cents, active)',
  // work_requests <-> email_messages has TWO foreign keys (the originating
  // email, and every email later attached to the request), so the embed names
  // the one it means: the email the request was born from.
  'work_requests(id, customer_name, customer_email, classification, status, county, zip, created_at, email_messages!work_requests_email_message_id_fkey(from_addr, subject, received_at, mailbox))',
].join(', ');

/** Newest-last ordering, so the oldest waiting approval is at the top. */
export const QUEUE_ORDER_COLUMN = 'created_at';
export const QUEUE_LIMIT = 200;

// --- Mode -------------------------------------------------------------------

export interface QueueEnv {
  AWE_MODE?: string;
}

export type QueueMode = 'TEST' | 'LIVE';

/**
 * TEST unless explicitly told otherwise — the same fail-closed default as the
 * B3 engine, and the reason an unconfigured deployment cannot decide on real
 * customer mail.
 */
export function resolveQueueMode(env: QueueEnv = {}): QueueMode {
  return modeOf(env) as QueueMode;
}

// --- Capabilities -----------------------------------------------------------

/**
 * What the signed-in human may do, as resolved by the DATABASE. `roles` is the
 * result of calling 0015's business_role_matches(auth.uid(), <role>) once per
 * distinct role in the queue — the UI never re-implements the role mapping, it
 * asks the same function record_approval() will ask.
 *
 * Absent/unknown => false. A capability the UI could not resolve is a
 * capability the user does not have.
 */
export interface Capabilities {
  userId: string | null;
  roles: Record<string, boolean>;
}

export const NO_CAPABILITIES: Capabilities = { userId: null, roles: {} };

export function holdsRole(caps: Capabilities | null | undefined, role: string | null): boolean {
  if (!caps || !caps.userId || !role) return false;
  return caps.roles[role] === true;
}

/** The distinct approver roles a capability lookup must cover for these rows. */
export function requiredRoles(rows: readonly QueueRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.assigned_approver_role) seen.add(r.assigned_approver_role);
  }
  return [...seen].sort();
}

// --- The guard --------------------------------------------------------------

export interface GuardResult {
  allowed: boolean;
  reason: GuardReason | null;
  detail: string | null;
}

const ALLOW: GuardResult = { allowed: true, reason: null, detail: null };

const deny = (reason: GuardReason, detail: string): GuardResult => ({
  allowed: false,
  reason,
  detail,
});

/**
 * May this human decide on this row, right now, in this mode?
 *
 * Ordered so the most fundamental refusal wins, and every refusal names itself:
 *   1. not a draft            -> duplicate-decision protection
 *   2. no assigned approver   -> a blocked row has nothing to approve
 *   3. role not held          -> unauthorized approver
 *   4. TEST-mode safety       -> fixture-safety in both directions
 *
 * Every one of these is ALSO enforced by record_approval()/RLS. This function
 * exists to explain the refusal in the UI, never to be the only thing enforcing
 * it — hiding a button is not a security control.
 */
export function decisionGuard({
  row,
  mode = 'TEST',
  capabilities = NO_CAPABILITIES,
}: {
  row: QueueRow;
  mode?: QueueMode;
  capabilities?: Capabilities | null;
}): GuardResult {
  if (!DECIDABLE_STATUSES.includes(row.status)) {
    // A blocked row says why it is unroutable; a decided one says what it became.
    const what = row.blocked_reason ? `${row.status} (${row.blocked_reason})` : row.status;
    return deny('not_pending', `message is ${what}; only a draft can be decided`);
  }

  if (!row.assigned_approver_role) {
    return deny(
      'unassigned_approver',
      row.blocked_reason
        ? `no approver assigned (${row.blocked_reason})`
        : 'no approver assigned',
    );
  }

  if (!holdsRole(capabilities, row.assigned_approver_role)) {
    return deny(
      'unauthorized_approver',
      `requires the ${row.assigned_approver_role} role`,
    );
  }

  // Fixture-safety, both directions. In TEST the queue may only act on fixture
  // rows addressed to the unresolvable domain; in LIVE a fixture must never be
  // decided as though it were a real customer message.
  const recipients = [
    ...(row.to_addrs ?? []),
    ...(row.cc_addrs ?? []),
    ...(row.bcc_addrs ?? []),
  ];

  if (mode === 'TEST') {
    const test = testModeGate({
      recipients,
      isFixture: row.is_fixture === true,
      mode: 'TEST',
    });
    if (!test.ok) {
      return deny('test_mode_violation', test.violations.join('; '));
    }
  } else if (row.is_fixture === true) {
    return deny('fixture_in_live_mode', 'fixture rows are not decidable in LIVE mode');
  }

  return ALLOW;
}

export interface DecisionInput {
  row: QueueRow;
  decision: string;
  reason?: string | null;
  mode?: QueueMode;
  capabilities?: Capabilities | null;
}

export interface DecisionPlan {
  ok: boolean;
  reason: GuardReason | null;
  detail: string | null;
  /** Exactly the arguments record_approval() will be called with. */
  rpc: { p_message: string; p_decision: Decision; p_reason: string | null } | null;
}

const refusePlan = (reason: GuardReason, detail: string): DecisionPlan => ({
  ok: false,
  reason,
  detail,
  rpc: null,
});

/**
 * Validate a decision and produce the exact RPC payload for it. The page calls
 * NOTHING that this function did not return: if `rpc` is null there is no call
 * to make, so an unauthorized/duplicate/reasonless decision never leaves the
 * browser.
 *
 * A rejection reason is required (0015: "a rejection must record a reason") and
 * is trimmed — whitespace is not a reason.
 */
export function planDecision({
  row,
  decision,
  reason = null,
  mode = 'TEST',
  capabilities = NO_CAPABILITIES,
}: DecisionInput): DecisionPlan {
  const guard = decisionGuard({ row, mode, capabilities });
  if (!guard.allowed) return refusePlan(guard.reason as GuardReason, guard.detail ?? '');

  if (decision !== 'approve' && decision !== 'reject') {
    return refusePlan('unknown_decision', `expected approve|reject, got '${decision}'`);
  }

  const trimmed = (reason ?? '').trim();
  if (decision === 'reject' && trimmed === '') {
    return refusePlan('missing_rejection_reason', 'a rejection must record a reason');
  }

  return {
    ok: true,
    reason: null,
    detail: null,
    rpc: {
      p_message: row.id,
      p_decision: decision,
      p_reason: decision === 'reject' ? trimmed : null,
    },
  };
}

// --- Deterministic post-decision refresh ------------------------------------

export interface RefreshVerdict {
  settled: boolean;
  status: OutboundStatus | null;
  message: string;
}

/**
 * After a decision the page re-reads the queue and asks this: did the row
 * actually move? A decision that reports success but leaves the row in `draft`
 * is a failure the human must see, not a green toast. (Same posture as B2's
 * Verify Step: success is what the re-read says, never what the call said.)
 */
export function verifyDecisionApplied({
  rows,
  messageId,
  decision,
}: {
  rows: readonly QueueRow[];
  messageId: string;
  decision: Decision;
}): RefreshVerdict {
  const expected: OutboundStatus = decision === 'approve' ? 'approved' : 'rejected';
  const row = rows.find((r) => r.id === messageId) ?? null;

  if (!row) {
    return {
      settled: false,
      status: null,
      message: `decision recorded, but message ${messageId} was not found on refresh — reload and confirm`,
    };
  }
  if (row.status === expected) {
    return { settled: true, status: row.status, message: `Message ${expected}.` };
  }
  return {
    settled: false,
    status: row.status,
    message: `decision did not apply: message is still ${row.status} (expected ${expected})`,
  };
}

// --- View state -------------------------------------------------------------

export const QUEUE_STATES = ['loading', 'error', 'signed_out', 'empty', 'ready'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/**
 * One place decides which of the five screens is showing, so "loading",
 * "failed fetch", "signed out", "empty queue" and "ready" are testable without
 * rendering React.
 */
export function queueState({
  loading,
  error,
  signedIn,
  rows,
}: {
  loading: boolean;
  error: string | null;
  signedIn: boolean;
  rows: readonly QueueRow[] | null;
}): QueueState {
  if (loading) return 'loading';
  if (!signedIn) return 'signed_out';
  if (error) return 'error';
  if (!rows || rows.length === 0) return 'empty';
  return 'ready';
}

export function tabOf(row: QueueRow): QueueTab {
  if (row.status === 'draft') return 'pending';
  if (row.status === 'blocked' || row.status === 'failed') return 'blocked';
  return 'decided';
}

export function filterTab(rows: readonly QueueRow[], tab: QueueTab): QueueRow[] {
  return rows.filter((r) => tabOf(r) === tab);
}

export interface QueueSummary {
  total: number;
  pending: number;
  blocked: number;
  decided: number;
  escalated: number;
  fixtures: number;
}

export function summarizeQueue(rows: readonly QueueRow[] | null): QueueSummary {
  const list = rows ?? [];
  return {
    total: list.length,
    pending: list.filter((r) => tabOf(r) === 'pending').length,
    blocked: list.filter((r) => tabOf(r) === 'blocked').length,
    decided: list.filter((r) => tabOf(r) === 'decided').length,
    escalated: list.filter((r) => r.escalated === true).length,
    fixtures: list.filter((r) => r.is_fixture === true).length,
  };
}

// --- Audit history ----------------------------------------------------------

export interface AuditEntry {
  step: string;
  at: string | null;
  actor: string;
  detail: string | null;
}

/**
 * The audit history of one message, reconstructed from the row's own
 * write-once attribution columns.
 *
 * WHY NOT integration_events: that table is service-role-only by design (0009 —
 * RLS enabled, zero client policies). Reading it from the browser would mean
 * either weakening its RLS or shipping a service-role key to the client, and B5
 * does neither. The columns below carry the same facts the message.* events
 * carry (who, when, why), and the DB guards make them write-once, so this is
 * evidence rather than a retelling. The event log remains the system of record
 * for n8n and for the acceptance slices, which read it as service role.
 */
export function buildAuditTrail(row: QueueRow): AuditEntry[] {
  const entries: AuditEntry[] = [];

  if (row.status === 'blocked' && !row.approved_at && !row.rejected_at) {
    entries.push({
      step: 'blocked',
      at: row.created_at,
      actor: 'automation',
      detail: row.blocked_reason ? `routing failed closed: ${row.blocked_reason}` : 'routing failed closed',
    });
  } else {
    entries.push({
      step: 'draft_created',
      at: row.created_at,
      actor: 'automation',
      detail: row.assigned_approver_role
        ? `routed to ${row.assigned_approver_role} (${row.routing_path ?? 'primary'})`
        : 'no approver assigned',
    });
  }

  if (row.escalated) {
    entries.push({
      step: 'escalated',
      at: row.created_at,
      actor: 'automation',
      detail: row.escalation_reason ?? 'escalated by the approval matrix',
    });
  }

  if (row.approved_at) {
    entries.push({
      step: 'approved',
      at: row.approved_at,
      actor: row.approver?.full_name ?? 'unknown approver',
      detail: null,
    });
  }

  if (row.rejected_at) {
    entries.push({
      step: 'rejected',
      at: row.rejected_at,
      actor: row.rejector?.full_name ?? 'unknown approver',
      detail: row.rejection_reason,
    });
  }

  if (row.sent_at) {
    entries.push({
      step: 'sent',
      at: row.sent_at,
      actor: row.sender?.full_name ?? 'unknown user',
      // B5 has no send action; a sent row can only have been marked elsewhere.
      detail: 'marked manually sent (recorded outside this queue)',
    });
  }

  return entries;
}

// --- Presentation helpers (pure) --------------------------------------------

export function formatAmount(cents: number | null): string {
  if (cents == null) return '—';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function messageTypeLabel(t: string): string {
  return t.replace(/_/g, ' ');
}

/** Who this message goes to, as one string. Never mutates the row's arrays. */
export function recipientLine(row: QueueRow): string {
  const to = row.to_addrs ?? [];
  return to.length > 0 ? to.join(', ') : '—';
}

/** Who asked for the work: the customer on the originating request/email. */
export function requesterLine(row: QueueRow): string {
  const wr = row.work_requests;
  if (!wr) return '—';
  const name = wr.customer_name?.trim();
  const email = wr.customer_email?.trim() || wr.email_messages?.from_addr?.trim();
  if (name && email) return `${name} <${email}>`;
  return name || email || '—';
}

/** Human-readable escalation state for the row. */
export function escalationLine(row: QueueRow): string {
  if (!row.escalated) return row.routing_path ? `${row.routing_path} approver` : 'not escalated';
  return row.escalation_reason ? `escalated — ${row.escalation_reason}` : 'escalated';
}

/** True when this row must be visually marked as non-production data. */
export function isTestRow(row: QueueRow): boolean {
  return row.is_fixture === true;
}
