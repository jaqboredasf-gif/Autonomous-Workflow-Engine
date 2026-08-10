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

// ---------------------------------------------------------------------------
// URGENCY — the handoff's "Priority".
//
// The handoff asks for Normal / Urgent / Emergency. The domain deliberately
// has no priority field: `priority` is in REQUESTOR_FORBIDDEN_FIELDS and the
// spec it implements replaced it with need_by_date + need_by_time, because a
// self-declared priority flag drifts and a date does not.
//
// So urgency is DERIVED from the need-by moment rather than stored. It is a
// reading of the data, which means it cannot disagree with the data, and it
// adds no column, no migration and no new write path.
// ---------------------------------------------------------------------------

export type Urgency = 'EMERGENCY' | 'URGENT' | 'NORMAL' | 'NONE';

export const URGENCY_LABELS: Record<Urgency, string> = {
  EMERGENCY: 'Emergency',
  URGENT: 'Urgent',
  NORMAL: 'Normal',
  NONE: 'No date',
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * How urgent this request reads, given a clock.
 *
 * EMERGENCY — the need-by moment has passed, or is inside the next 12 hours.
 * URGENT    — inside the next 48 hours.
 * NORMAL    — later than that.
 * NONE      — no need-by recorded (drafts, mostly).
 *
 * Closed requests are never urgent: they are over.
 */
export function urgencyOf(
  request: { needByDate?: string | null; needByTime?: string | null; status?: string },
  now: string,
): Urgency {
  if (!request?.needByDate) return 'NONE';
  if (['RECEIVED', 'COMPLETED', 'CANCELLED', 'REJECTED'].includes(String(request.status))) return 'NORMAL';

  const needBy = Date.parse(`${request.needByDate}T${request.needByTime ?? '23:59'}:00`);
  const at = Date.parse(String(now));
  if (Number.isNaN(needBy) || Number.isNaN(at)) return 'NORMAL';

  const hoursLeft = (needBy - at) / HOUR_MS;
  if (hoursLeft <= 12) return 'EMERGENCY';
  if (hoursLeft <= 48) return 'URGENT';
  return 'NORMAL';
}

export function urgencyTone(urgency: Urgency): Tone {
  if (urgency === 'EMERGENCY') return 'bad';
  if (urgency === 'URGENT') return 'warn';
  return 'neutral';
}

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
