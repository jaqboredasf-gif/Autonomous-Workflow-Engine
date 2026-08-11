// ---------------------------------------------------------------------------
// purchasing-workflow.mjs — what a purchase request DOES, as one table.
//
// This is the PCC side of the workflow boundary. The engine (@awe/workflow)
// owns the mechanics — legality, ordering of checks, evidence, the guarantee
// that a transition records its event. This file owns the MEANING: that
// approving needs a completed workshop review, that ordering needs a human to
// have read the vendor email first, that nothing may be marked received before
// a receipt exists.
//
// WHAT CHANGED, AND WHY IT MATTERS
//
// Before, one transition was three fragments in three files:
//
//   the permission     `must(ctx, actor, 'review.decide')`   in decisions.ts
//   the precondition   `to === 'APPROVED' && !facts.hasReview`  inside transitionGuard()
//   the event          `events.approved(...)` passed to emit()  by the caller
//
// Nothing bound them, so an action could be added with two of the three and
// nothing would notice. Here they are one row, and the engine refuses a row
// with a hole in it at definition time — this module cannot load if an action
// forgets to say what it records.
//
// THE STATES AND EDGES ARE STILL status.mjs's. They are imported rather than
// restated: two lists of statuses is how a state machine starts disagreeing
// with itself, and status.mjs is what the database CHECK constraints and
// migration 0016's parity lint are written against.
// ---------------------------------------------------------------------------

import { defineWorkflow } from '@awe/workflow';

import { REQUEST_STATUSES, TERMINAL_STATUSES } from './status.mjs';

/**
 * Cancellation is reachable from every non-terminal state, including the ones
 * that already committed money — an order placed with a vendor still has to be
 * cancellable somewhere, and the audit trail is the point.
 */
const CANCELLABLE_FROM = REQUEST_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));

/**
 * A line still owed is the one condition shared by two actions, so it is
 * written once. `outstandingLines` is supplied by the caller's fact gathering;
 * the engine never counts anything itself.
 */
const nothingOutstanding = (facts) =>
  Number(facts.outstandingLines ?? 0) === 0
    ? true
    : { reason: 'lines_outstanding', message: `${facts.outstandingLines} line(s) are not fully resolved` };

export const PURCHASING_WORKFLOW = defineWorkflow({
  name: 'purchasing.request',
  states: REQUEST_STATUSES,
  terminal: TERMINAL_STATUSES,
  actions: {
    submit: {
      from: 'DRAFT',
      to: 'SUBMITTED',
      permission: 'request.submit',
      event: 'request.submitted',
      description: 'The field sends the request in.',
    },
    // Submission lands in the queue as a second, automatic step. It is a
    // distinct transition rather than one edge because the audit trail
    // distinguishes "he sent it" from "it reached the workshop".
    queue: {
      from: ['SUBMITTED', 'RESUBMITTED'],
      to: 'PENDING_WORKSHOP_REVIEW',
      // SYSTEM. Nobody decides to queue a request; it is the consequence of
      // submitting or answering, taken by the application in the same unit of
      // work. Asking for `request.submit` here would refuse the submitter
      // himself — the request is no longer a draft by the time this runs, and
      // request.submit is defined by ownership OF A DRAFT.
      permission: null,
      event: 'request.submitted',
    },
    approve: {
      // PENDING_WORKSHOP_REVIEW only. A RESUBMITTED request is queued first —
      // that is what the status graph has always said, and widening it here
      // would have let a decision skip the queue.
      from: 'PENDING_WORKSHOP_REVIEW',
      to: 'APPROVED',
      permission: 'review.decide',
      event: 'decision.approved',
      // BR-011 lives in the policy function, not here: whoever holds
      // review.decide may approve ANY request including their own, and who
      // raised it is recorded rather than consulted.
      requires: ['hasReview'],
    },
    reject: {
      from: 'PENDING_WORKSHOP_REVIEW',
      to: 'REJECTED',
      permission: 'review.decide',
      event: 'decision.rejected',
    },
    requestClarification: {
      from: 'PENDING_WORKSHOP_REVIEW',
      to: 'CLARIFICATION_REQUESTED',
      permission: 'review.decide',
      event: 'clarification.requested',
    },
    answerClarification: {
      from: 'CLARIFICATION_REQUESTED',
      to: 'RESUBMITTED',
      permission: 'request.respond_clarification',
      event: 'clarification.answered',
    },
    generatePo: {
      from: 'APPROVED',
      to: 'PO_GENERATED',
      permission: 'po.generate',
      event: 'po.generated',
    },
    draftEmail: {
      from: 'PO_GENERATED',
      to: 'EMAIL_DRAFTED',
      permission: 'email.draft',
      event: 'email.draft_generated',
      requires: ['hasPurchaseOrder'],
    },
    markOrdered: {
      from: 'EMAIL_DRAFTED',
      to: 'ORDERED',
      permission: 'order.mark_ordered',
      event: 'order.placed',
      // A human must have read what goes to the vendor. This is the rule that
      // stops a purchase being recorded as placed before anybody looked.
      requires: ['hasReviewedEmailDraft'],
    },
    recordPartialReceipt: {
      from: ['ORDERED', 'PARTIALLY_RECEIVED'],
      to: 'PARTIALLY_RECEIVED',
      permission: 'receiving.record',
      event: 'receipt.partial',
      requires: ['hasReceipt'],
    },
    recordFullReceipt: {
      from: ['ORDERED', 'PARTIALLY_RECEIVED'],
      to: 'RECEIVED',
      permission: 'receiving.record',
      event: 'receipt.completed',
      requires: ['hasReceipt'],
      guard: nothingOutstanding,
    },
    complete: {
      from: 'RECEIVED',
      to: 'COMPLETED',
      permission: 'request.complete',
      event: 'request.completed',
      guard: nothingOutstanding,
    },
    cancel: {
      from: CANCELLABLE_FROM,
      to: 'CANCELLED',
      // Ownership WIDENS access to a cheaper permission; it never subtracts.
      // Whoever raised it may cancel it with `request.cancel.own`; anybody else
      // needs `request.cancel.any`, which purchasing staff hold. One action,
      // one rule, resolved from the record rather than duplicated as two
      // actions the caller would have to choose between.
      permission: (facts) => (facts.isOwner ? 'request.cancel.own' : 'request.cancel.any'),
      event: 'request.cancelled',
    },
  },
});

/**
 * The action a target state corresponds to, for the states reachable by exactly
 * one action.
 *
 * A bridge, and a deliberately narrow one. Fifteen call sites named a target
 * state before this existed; they now name an action, and this exists so the
 * two vocabularies can be checked against each other by a test rather than
 * trusted. It is NOT for production dispatch — `PARTIALLY_RECEIVED` and
 * `RECEIVED` are both reachable from `ORDERED`, and choosing between them is a
 * decision about quantities that belongs in the receiving use case.
 */
export function actionForTargetState(to) {
  const matches = Object.values(PURCHASING_WORKFLOW.actions).filter((a) => a.to === to);
  return matches.length === 1 ? matches[0].name : null;
}
