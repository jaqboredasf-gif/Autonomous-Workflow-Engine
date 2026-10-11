// ---------------------------------------------------------------------------
// status-display.ts — the presentation vocabulary.
//
// The domain's status identifiers are authoritative and are never renamed (see
// domain/status.mjs). The handoff names the same lifecycle differently, for
// people rather than for code. This module is the ONE place the two meet.
//
// Everything here is presentation. Nothing in it decides anything: no
// authorization, no transition, no persistence. If a rule wants to live here,
// it belongs in the domain instead.
// ---------------------------------------------------------------------------

import { statusLabel, statusTone } from '../../purchasing/domain/status.mjs';

/**
 * Handoff-facing labels, keyed by the domain identifier. A status missing from
 * this table falls back to statusLabel(), so adding a status to the domain
 * cannot make a screen render a blank cell.
 */
const LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Requested',
  PENDING_WORKSHOP_REVIEW: 'Needs Approval',
  CLARIFICATION_REQUESTED: 'Question Asked',
  RESUBMITTED: 'Needs Approval',
  REJECTED: 'Rejected',
  APPROVED: 'Approved',
  PO_GENERATED: 'PO Generated',
  EMAIL_DRAFTED: 'Email Drafted',
  ORDERED: 'Ordered',
  PARTIALLY_RECEIVED: 'Partially Received',
  RECEIVED: 'Received',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export function displayStatus(status: string): string {
  return LABELS[status] ?? statusLabel(status);
}

/**
 * Lifecycle STAGE labels — the pile a status belongs to, in words. The stages
 * themselves (and their `labelKey`) live in domain/dashboard.mjs; this is the
 * English fallback, same arrangement as displayStatus() above. Screens that
 * show a stage read it from here so the queue, the table and the dashboard
 * cannot end up calling the same pile three different things.
 */
const STAGE_LABELS: Record<string, string> = {
  NEEDS_REVIEW: 'Needs approval',
  WAITING_ON_REQUESTOR: 'Waiting on requester',
  READY_TO_ORDER: 'Ready to order',
  AWAITING_DELIVERY: 'Awaiting delivery',
  PARTIALLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received',
  DRAFTS: 'Drafts',
  CLOSED: 'Closed',
};

export function stageLabel(key: string): string {
  return STAGE_LABELS[key] ?? key;
}

export type Tone = 'neutral' | 'attention' | 'warn' | 'good' | 'bad' | 'info';

export function toneFor(status: string): Tone {
  // PARTIALLY_RECEIVED is a working state, not a finished one — the domain
  // tones it neutral, but on an operational board it is something a human has
  // to finish, so it reads as a warning here.
  if (status === 'PARTIALLY_RECEIVED') return 'warn';
  if (status === 'ORDERED' || status === 'EMAIL_DRAFTED' || status === 'PO_GENERATED') return 'info';
  return statusTone(status) as Tone;
}

// PRIORITY — REMOVED.
//
// There used to be a derived Emergency / Urgent / Normal reading here, shown as
// a badge on every row. It was honest — computed from the need-by moment, never
// stored, never declarable by a requester — and it was still useless: nearly
// all Lippolis purchasing is for the following day, so almost every row read
// "Normal" and the few that did not were not the ones that needed attention.
//
// What replaced it is `attentionBand()` in domain/dashboard.mjs, which asks a
// different and better question: not "how soon is this due" but "has this gone
// past its date while still needing somebody to act". Overdue and due-today
// work is elevated; ordinary next-day work is deliberately blank, so a colour
// on a row means something.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// NEXT ACTION — what a human has to do with this row, in words.
//
// The queue's whole purpose is that nobody has to memorize the lifecycle. Both
// the label and the destination come from here so the table cell and the
// button agree.
// ---------------------------------------------------------------------------

export type NextAction = { label: string; href: string | null; actionable: boolean };

export function nextActionFor(request: { id: string; status: string }): NextAction {
  const id = request.id;
  switch (request.status) {
    case 'DRAFT':
      return { label: 'Submit the request', href: `/requests/${id}`, actionable: true };
    case 'SUBMITTED':
    case 'PENDING_WORKSHOP_REVIEW':
    case 'RESUBMITTED':
      return { label: 'Review and decide', href: `/requests/${id}/review`, actionable: true };
    case 'CLARIFICATION_REQUESTED':
      return { label: 'Waiting on the requester', href: `/requests/${id}`, actionable: false };
    case 'APPROVED':
      return { label: 'Generate the purchase order', href: `/requests/${id}`, actionable: true };
    case 'PO_GENERATED':
      return { label: 'Draft the vendor email', href: `/requests/${id}/email`, actionable: true };
    case 'EMAIL_DRAFTED':
      return { label: 'Send it, then mark ordered', href: `/requests/${id}/email`, actionable: true };
    case 'ORDERED':
      return { label: 'Waiting on the vendor', href: `/requests/${id}/receive`, actionable: false };
    case 'PARTIALLY_RECEIVED':
      return { label: 'Receive the rest', href: `/requests/${id}/receive`, actionable: true };
    case 'RECEIVED':
      return { label: 'Complete the request', href: `/requests/${id}`, actionable: true };
    default:
      return { label: 'Closed', href: `/requests/${id}`, actionable: false };
  }
}

// ---------------------------------------------------------------------------
// WHO IT IS WAITING ON — the half of "what happens next" that was missing.
//
// nextActionFor() says what to DO. It never said who has to do it, and on
// every screen a requester or a foreman opens, that is the question. A field
// user looking at "Needs Approval" cannot tell whether somebody is dealing
// with it, whether it is stuck on them, or whether it has been forgotten; the
// honest answer — "the workshop has it" — is a fact the status already
// contains and the screen simply never said out loud.
//
// So each status maps to one owner and one operational sentence. Presentation,
// like the rest of this module: no rule is decided here, and the statuses are
// domain/status.mjs's.
// ---------------------------------------------------------------------------

export type NextOwner = 'REQUESTER' | 'PURCHASING' | 'VENDOR' | 'RECEIVER' | 'NOBODY';

export type NextStep = {
  /** The pile this is in, in the words the objective and the shop both use. */
  state: string;
  /** Who has to move it. */
  owner: NextOwner;
  /** "The workshop has it." — one short sentence, for a person. */
  waitingOn: string;
  /** What that person does, from nextActionFor(). */
  action: NextAction;
};

const OWNER_LABELS: Record<NextOwner, string> = {
  REQUESTER: 'the person who asked',
  PURCHASING: 'purchasing',
  VENDOR: 'the vendor',
  RECEIVER: 'whoever signs for it',
  NOBODY: 'nobody',
};

const STEPS: Record<string, { state: string; owner: NextOwner; waitingOn: string }> = {
  DRAFT: { state: 'Draft', owner: 'REQUESTER', waitingOn: 'Not sent yet — it is still yours to submit.' },
  SUBMITTED: { state: 'Awaiting purchasing review', owner: 'PURCHASING', waitingOn: 'The workshop has it.' },
  PENDING_WORKSHOP_REVIEW: { state: 'Awaiting purchasing review', owner: 'PURCHASING', waitingOn: 'The workshop has it.' },
  RESUBMITTED: { state: 'Awaiting purchasing review', owner: 'PURCHASING', waitingOn: 'Your answer went back to the workshop.' },
  CLARIFICATION_REQUESTED: { state: 'Awaiting your answer', owner: 'REQUESTER', waitingOn: 'The workshop asked a question and cannot go on until it is answered.' },
  APPROVED: { state: 'Awaiting order placement', owner: 'PURCHASING', waitingOn: 'Approved. Purchasing is raising the order.' },
  PO_GENERATED: { state: 'Awaiting order placement', owner: 'PURCHASING', waitingOn: 'The purchase order exists; it has not gone to the vendor yet.' },
  EMAIL_DRAFTED: { state: 'Awaiting order placement', owner: 'PURCHASING', waitingOn: 'The order is written and waiting to be sent.' },
  ORDERED: { state: 'Awaiting delivery', owner: 'VENDOR', waitingOn: 'Ordered. Waiting on the vendor to deliver.' },
  PARTIALLY_RECEIVED: { state: 'Awaiting the rest of the delivery', owner: 'RECEIVER', waitingOn: 'Part of it arrived. The rest is still owed.' },
  RECEIVED: { state: 'Awaiting completion', owner: 'PURCHASING', waitingOn: 'Everything arrived. Purchasing closes it off.' },
  COMPLETED: { state: 'Complete', owner: 'NOBODY', waitingOn: 'Finished. Nothing outstanding.' },
  CANCELLED: { state: 'Cancelled', owner: 'NOBODY', waitingOn: 'Cancelled. The record is kept.' },
  REJECTED: { state: 'Rejected', owner: 'NOBODY', waitingOn: 'Rejected. The reason is on the record.' },
};

export function nextStepFor(request: { id: string; status: string }): NextStep {
  const step = STEPS[request.status] ?? {
    state: displayStatus(request.status),
    owner: 'PURCHASING' as NextOwner,
    waitingOn: 'Open the record to see where it stands.',
  };
  return { ...step, action: nextActionFor(request) };
}

/** "Waiting on purchasing" — for a badge or a table cell. */
export function waitingOnLabel(request: { id: string; status: string }): string {
  const { owner, state } = nextStepFor(request);
  return owner === 'NOBODY' ? state : `Waiting on ${OWNER_LABELS[owner]}`;
}
