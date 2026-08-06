// ---------------------------------------------------------------------------
// status.mjs — the purchase-request status model and its transition graph.
//
// PURE. No React, no database, no clock, no randomness, no I/O. Every function
// is a function of its arguments, so the same module runs in the Next server
// action, in the browser (for deciding what to OFFER a human) and in the
// offline eval harness (scripts/eval-purchasing.mjs).
//
// This module is the *vocabulary*. It is NOT the authority: the authority is
// the server transaction in src/server/service.ts (pilot) and migration
// 0016_purchasing_control.sql's guard trigger (Supabase). Both call into these
// same tables of legal transitions, and scripts/lib/validate-migration-0016.mjs
// asserts the SQL enum and the guard list here stay in lockstep.
//
// Follows the 0015 idiom: a closed transition graph, terminal states, and
// "corrections after a terminal state are a new row", never a silent mutation.
// ---------------------------------------------------------------------------

/** Every status a purchase request can hold. Order = rough lifecycle order. */
export const REQUEST_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'PENDING_WORKSHOP_REVIEW',
  'CLARIFICATION_REQUESTED',
  'RESUBMITTED',
  'REJECTED',
  'APPROVED',
  'PO_GENERATED',
  'EMAIL_DRAFTED',
  'ORDERED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'COMPLETED',
  'CANCELLED',
];

/** Statuses from which nothing further may happen. */
export const TERMINAL_STATUSES = ['REJECTED', 'COMPLETED', 'CANCELLED'];

/**
 * The closed transition graph. A transition not listed here is illegal and the
 * server raises rather than writing it — there is no "force" path.
 *
 * CANCELLED is reachable from every non-terminal state EXCEPT the states that
 * already committed money to a vendor by hand (ORDERED and beyond keep it, on
 * purpose: an order placed with a vendor still has to be cancelled *somewhere*,
 * and the audit trail is the point).
 */
export const TRANSITIONS = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['PENDING_WORKSHOP_REVIEW', 'CANCELLED'],
  PENDING_WORKSHOP_REVIEW: ['CLARIFICATION_REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED'],
  CLARIFICATION_REQUESTED: ['RESUBMITTED', 'CANCELLED'],
  RESUBMITTED: ['PENDING_WORKSHOP_REVIEW', 'CANCELLED'],
  APPROVED: ['PO_GENERATED', 'CANCELLED'],
  PO_GENERATED: ['EMAIL_DRAFTED', 'CANCELLED'],
  EMAIL_DRAFTED: ['ORDERED', 'CANCELLED'],
  ORDERED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  RECEIVED: ['COMPLETED', 'CANCELLED'],
  REJECTED: [],
  COMPLETED: [],
  CANCELLED: [],
};

/** Statuses that put a request in the workshop approval queue. */
export const QUEUE_STATUSES = ['PENDING_WORKSHOP_REVIEW', 'RESUBMITTED'];

/** Statuses that mean "money is committed, materials not yet all in hand". */
export const OPEN_ORDER_STATUSES = ['ORDERED', 'PARTIALLY_RECEIVED'];

/** Statuses in which the requestor may still edit the request body. */
export const REQUESTOR_EDITABLE_STATUSES = ['DRAFT', 'CLARIFICATION_REQUESTED'];

export function isStatus(s) {
  return REQUEST_STATUSES.includes(s);
}

export function isTerminal(s) {
  return TERMINAL_STATUSES.includes(s);
}

/** True iff `from -> to` is in the graph. Unknown statuses are never legal. */
export function canTransition(from, to) {
  if (!isStatus(from) || !isStatus(to)) return false;
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * The single guard every state change passes through.
 *
 * Returns {ok:true} or {ok:false, reason, message}. Reasons are a closed
 * vocabulary so the UI, the server and the harness all name failures the same
 * way (same discipline as 0015's BLOCKED_REASONS).
 */
export function transitionGuard(from, to, ctx = {}) {
  if (!isStatus(from)) return deny('unknown_status', `unknown current status ${from}`);
  if (!isStatus(to)) return deny('unknown_status', `unknown target status ${to}`);
  if (isTerminal(from)) {
    return deny('terminal_status', `${from} is terminal; a correction is a new request`);
  }
  if (!canTransition(from, to)) {
    return deny('illegal_transition', `illegal transition ${from} -> ${to}`);
  }

  // Content preconditions. These are the rules the spec states in prose;
  // stating them here means the UI cannot offer an action the server refuses.
  if (to === 'APPROVED' && !ctx.hasReview) {
    return deny('review_incomplete', 'approval requires a completed workshop review');
  }
  if (to === 'PO_GENERATED' && from !== 'APPROVED') {
    return deny('po_before_approval', 'a purchase order requires an approved request');
  }
  if (to === 'EMAIL_DRAFTED' && !ctx.hasPurchaseOrder) {
    return deny('email_before_po', 'a vendor email draft requires a purchase order');
  }
  if (to === 'ORDERED' && !ctx.hasReviewedEmailDraft) {
    return deny('order_before_email_review', 'the vendor email draft must be reviewed by a human first');
  }
  if ((to === 'RECEIVED' || to === 'PARTIALLY_RECEIVED') && !ctx.hasReceipt) {
    return deny('receipt_missing', 'receiving requires a recorded receipt');
  }
  if (to === 'RECEIVED' && ctx.outstandingLines > 0) {
    return deny('lines_outstanding', `${ctx.outstandingLines} line(s) are not fully resolved`);
  }
  if (to === 'COMPLETED' && ctx.outstandingLines > 0) {
    return deny('lines_outstanding', `${ctx.outstandingLines} line(s) are not fully resolved`);
  }
  return { ok: true, reason: null, message: null };
}

function deny(reason, message) {
  return { ok: false, reason, message };
}

/** Closed vocabulary of guard denials — asserted complete by the harness. */
export const GUARD_REASONS = [
  'unknown_status',
  'terminal_status',
  'illegal_transition',
  'review_incomplete',
  'po_before_approval',
  'email_before_po',
  'order_before_email_review',
  'receipt_missing',
  'lines_outstanding',
];

/** Human label for a status, for badges and timelines. */
export function statusLabel(s) {
  return String(s)
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Coarse bucket used for badge colour and dashboard grouping. */
export function statusTone(s) {
  if (s === 'REJECTED' || s === 'CANCELLED') return 'bad';
  if (s === 'COMPLETED' || s === 'RECEIVED') return 'good';
  if (s === 'CLARIFICATION_REQUESTED') return 'warn';
  if (QUEUE_STATUSES.includes(s)) return 'attention';
  return 'neutral';
}
