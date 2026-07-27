// ---------------------------------------------------------------------------
// approval-matrix.mjs  (Task B3 — approval matrix routing engine)
//
// PURE, OFFLINE, DETERMINISTIC. Given the matrix rows (message_policies) and one
// outbound request, decide WHO must approve it, WHETHER it escalates, and WHEN
// it is unroutable and must fail closed. Same input twice => same output.
//
// HARD BOUNDARIES (enforced by having zero of the machinery):
//   * No network, no fetch, no Microsoft Graph, no SMTP, no n8n. Nothing is
//     imported but node stdlib (in fact nothing is imported at all).
//   * No send capability of any kind, in any mode. `effective_mode` is ALWAYS
//     'draft' — the locked "zero v1 auto-sends" decision. A policy row may
//     already say mode='auto' (that is how graduation is meant to happen,
//     data-driven, no rebuild) and this engine will REPORT it while still
//     refusing to act on it.
//   * No clock. Any time-dependent input is passed in by the caller, so results
//     are reproducible byte-for-byte.
//
// This is the JS mirror of route_outbound() in
// supabase/migrations/0015_approval_matrix_outbound.sql. The two implementations
// are kept in lockstep by scripts/lib/validate-migration-0015.mjs, which asserts
// the blocked-reason vocabularies match exactly. Rules and their rationale:
// docs/testing/APPROVAL_MATRIX.md.
// ---------------------------------------------------------------------------

// Reasons produced by routing itself. MUST match route_outbound() in 0015.
export const ROUTE_BLOCKED_REASONS = [
  'no_policy',                // no matrix row for this message type
  'policy_inactive',          // row exists but is switched off
  'missing_approver_role',    // nobody is accountable ("missing owner")
  'no_backup_approver',       // primary unavailable and no usable backup
  'missing_approval_limit',   // amount-bearing message, no configured ceiling
  'missing_escalation_role',  // over the limit with nowhere to escalate to
];

// Reasons produced by the gate/runner around routing (no SQL counterpart —
// these are refusals that happen before a row is ever written).
export const GATE_BLOCKED_REASONS = [
  'duplicate_draft',              // idempotency: this draft_key already exists
  'unauthorized_external_action', // caller asked for an action outside the registry
  'test_mode_violation',          // fixture-safety rule broken (see TEST mode)
  'draft_build_failed',           // template could not produce a complete draft
  'forbidden_content',            // draft contained content we never send
];

export const BLOCKED_REASONS = [...ROUTE_BLOCKED_REASONS, ...GATE_BLOCKED_REASONS];

// The only side-effecting actions that exist in B3. Anything else — sending
// mail, touching Graph, publishing/activating an n8n workflow — is not merely
// unimplemented, it is explicitly refused (MVP_SPEC: "no side effect outside a
// registered tool").
export const ALLOWED_ACTIONS = ['route', 'create_draft', 'record_approval', 'mark_sent'];

// Recipient domain every fixture address must use. RFC 6761 reserves .invalid as
// permanently unresolvable, so a leaked draft cannot reach a real mailbox.
export const FIXTURE_EMAIL_DOMAIN = '@example.invalid';

export const BUSINESS_ROLES = [
  'owner', 'office_admin', 'dispatcher', 'estimator', 'project_manager',
  'accountant', 'crew_leader', 'field_employee', 'sysadmin',
];

export const MESSAGE_TYPES = [
  'out_of_territory_decline', 'service_call_confirmation', 'missing_info_request',
  'estimate_proposal', 'scheduling_confirmation', 'crew_dispatch',
  'change_order', 'completion_notice', 'final_invoice', 'uncertain_flagged',
];

// --- Mode -------------------------------------------------------------------

// TEST is the default and the only mode this slice is built for. LIVE is
// recognized so the guard is explicit rather than implied, but it changes
// nothing about sending: effective_mode is 'draft' either way.
export function resolveMode(env = {}) {
  return env.AWE_MODE === 'LIVE' ? 'LIVE' : 'TEST';
}

const blocked = (reason, extra = {}) => ({
  blocked: true,
  blocked_reason: reason,
  policy_id: null,
  approver_role: null,
  routing_path: null,
  escalated: false,
  escalation_reason: null,
  policy_mode: null,
  effective_mode: 'draft',
  ...extra,
});

// --- Matrix lookup ----------------------------------------------------------

// Policies may be given as an array of rows or an object keyed by message_type.
export function findPolicy(policies, messageType) {
  if (!policies) return null;
  const rows = Array.isArray(policies) ? policies : Object.values(policies);
  const hit = rows.find((p) => p && p.message_type === messageType);
  return hit || null;
}

// --- Routing (mirror of route_outbound() in 0015) ---------------------------

/**
 * route({policies, messageType, amountCents, unavailableRoles}) -> decision
 *
 * decision = {blocked, blocked_reason, policy_id, approver_role, routing_path,
 *             escalated, escalation_reason, policy_mode, effective_mode}
 *
 * Fail-closed by construction: every path that cannot name an accountable human
 * returns blocked with a specific reason. There is no "default approver".
 */
export function route({ policies, messageType, amountCents = null, unavailableRoles = [] } = {}) {
  const unavailable = new Set(Array.isArray(unavailableRoles) ? unavailableRoles : []);
  const p = findPolicy(policies, messageType);

  if (!p) return blocked('no_policy');
  if (p.active === false) return blocked('policy_inactive', { policy_id: p.id ?? null });
  // Missing owner: the matrix row exists but names nobody. Never guess.
  if (p.approver_role == null) return blocked('missing_approver_role', { policy_id: p.id ?? null });

  let role = p.approver_role;
  let path = 'primary';
  let escalated = false;
  let escalationReason = null;

  // Backup ownership. The primary seat being empty/out is a routing fact, not an
  // excuse to skip approval.
  if (unavailable.has(role)) {
    if (p.backup_approver_role == null || unavailable.has(p.backup_approver_role)) {
      return blocked('no_backup_approver', { policy_id: p.id ?? null });
    }
    role = p.backup_approver_role;
    path = 'backup';
  }

  // Approval limit. A message that commits money needs a configured ceiling;
  // absent one we block rather than invent authority.
  if (amountCents != null) {
    if (p.approval_limit_cents == null) {
      return blocked('missing_approval_limit', { policy_id: p.id ?? null });
    }
    if (amountCents > p.approval_limit_cents) {
      if (p.escalation_role == null) {
        return blocked('missing_escalation_role', { policy_id: p.id ?? null });
      }
      role = p.escalation_role;
      path = 'escalation';
      escalated = true;
      escalationReason =
        `amount ${amountCents} exceeds approval limit ${p.approval_limit_cents} for role ${p.approver_role}`;
    }
  }

  return {
    blocked: false,
    blocked_reason: null,
    policy_id: p.id ?? null,
    approver_role: role,
    routing_path: path,
    escalated,
    escalation_reason: escalationReason,
    policy_mode: p.mode ?? 'draft',
    // Locked: zero v1 auto-sends. A row that already says 'auto' is honored as a
    // RECORD of the graduation decision and still produces a draft.
    effective_mode: 'draft',
    auto_downgraded: (p.mode ?? 'draft') === 'auto',
  };
}

// --- Action authorization ---------------------------------------------------

/**
 * authorizeAction(action, {mode}) -> {allowed, reason}
 *
 * The registry gate. Sending mail, calling Graph, publishing or activating an
 * n8n workflow are refused here by name, so an attempt shows up as an explicit
 * 'unauthorized_external_action' rather than a missing function.
 */
export function authorizeAction(action, { mode = 'TEST' } = {}) {
  if (!ALLOWED_ACTIONS.includes(action)) {
    return { allowed: false, reason: 'unauthorized_external_action', action, mode };
  }
  return { allowed: true, reason: null, action, mode };
}

/**
 * enforceTestMode({recipients, isFixture, mode}) -> {ok, violations}
 *
 * TEST-mode contract for anything that could conceivably leave the building:
 *   1. every recipient address is @example.invalid (unresolvable by RFC 6761)
 *   2. the row is marked is_fixture (only fixtures may lack real provenance)
 *   3. at least one recipient exists (a draft with no addressee is not a draft)
 */
export function enforceTestMode({ recipients = [], isFixture = false, mode = 'TEST' } = {}) {
  const violations = [];
  if (mode !== 'TEST') return { ok: true, violations, mode };

  const list = Array.isArray(recipients) ? recipients : [recipients];
  if (list.length === 0) violations.push('no recipient');
  for (const r of list) {
    const addr = String(r ?? '').trim().toLowerCase();
    if (!addr.endsWith(FIXTURE_EMAIL_DOMAIN)) {
      violations.push(`recipient outside ${FIXTURE_EMAIL_DOMAIN}: ${addr || '(empty)'}`);
    }
  }
  if (!isFixture) violations.push('is_fixture must be true in TEST mode');

  return { ok: violations.length === 0, violations, mode };
}
