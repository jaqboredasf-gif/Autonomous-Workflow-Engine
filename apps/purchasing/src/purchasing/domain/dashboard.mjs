// ---------------------------------------------------------------------------
// dashboard.mjs — the purchasing dashboard's summary cards and filters.
//
// PURE, and deliberately clock-free: "overdue" needs a NOW, so callers pass one
// (`now` as an ISO string). A module that reads the clock cannot be tested for
// the boundary case, and the boundary case is the one that matters.
// ---------------------------------------------------------------------------

import { OPEN_ORDER_STATUSES, QUEUE_STATUSES } from './status.mjs';
import { countOutstandingLines, estimatedTotalCents } from './numbers.mjs';

export const SUMMARY_CARDS = [
  'pending_workshop_review',
  'clarification_requested',
  'approved_no_po',
  'po_not_ordered',
  'open_orders',
  'overdue_orders',
  'partially_received',
  'received_this_month',
  'open_order_value_cents',
];

/**
 * A request is overdue when the need-by moment has passed and the material is
 * not yet in hand. Cancelled and rejected requests are not overdue; they are
 * over.
 */
export function isOverdue(request, now) {
  if (!request.needByDate) return false;
  if (['RECEIVED', 'COMPLETED', 'CANCELLED', 'REJECTED'].includes(request.status)) return false;
  const needBy = `${request.needByDate}T${request.needByTime ?? '23:59'}:00`;
  return needBy < String(now);
}

export function summarize(requests = [], now = '1970-01-01T00:00:00') {
  const month = String(now).slice(0, 7);
  const counts = Object.fromEntries(SUMMARY_CARDS.map((k) => [k, 0]));

  for (const r of requests) {
    if (QUEUE_STATUSES.includes(r.status)) counts.pending_workshop_review++;
    if (r.status === 'CLARIFICATION_REQUESTED') counts.clarification_requested++;
    if (r.status === 'APPROVED') counts.approved_no_po++;
    if (r.status === 'PO_GENERATED' || r.status === 'EMAIL_DRAFTED') counts.po_not_ordered++;
    if (OPEN_ORDER_STATUSES.includes(r.status)) {
      counts.open_orders++;
      counts.open_order_value_cents += Number(r.estimatedTotalCents ?? 0);
    }
    if (r.status === 'PARTIALLY_RECEIVED') counts.partially_received++;
    if (isOverdue(r, now)) counts.overdue_orders++;
    if (
      (r.status === 'RECEIVED' || r.status === 'COMPLETED') &&
      String(r.receivedAt ?? '').slice(0, 7) === month
    ) {
      counts.received_this_month++;
    }
  }
  return counts;
}

export const FILTER_KEYS = [
  'status',
  'requestorId',
  'jobNumber',
  'vendorId',
  'approverId',
  'needByFrom',
  'needByTo',
  'createdFrom',
  'createdTo',
  'overdueOnly',
  'search',
];

/**
 * Apply the dashboard filters. Unknown keys are ignored rather than throwing —
 * a stale bookmark should still render a table.
 */
export function applyFilters(requests = [], filters = {}, now = '1970-01-01T00:00:00') {
  const f = filters ?? {};
  const text = String(f.search ?? '').trim().toLowerCase();
  return requests.filter((r) => {
    if (f.status && f.status !== 'ALL' && r.status !== f.status) return false;
    if (f.requestorId && r.requestorId !== f.requestorId) return false;
    if (f.jobNumber && !String(r.jobNumber ?? '').toLowerCase().includes(String(f.jobNumber).toLowerCase())) return false;
    if (f.vendorId && r.vendorId !== f.vendorId) return false;
    if (f.approverId && r.approverId !== f.approverId) return false;
    if (f.needByFrom && String(r.needByDate ?? '') < f.needByFrom) return false;
    if (f.needByTo && String(r.needByDate ?? '') > f.needByTo) return false;
    if (f.createdFrom && String(r.createdAt ?? '').slice(0, 10) < f.createdFrom) return false;
    if (f.createdTo && String(r.createdAt ?? '').slice(0, 10) > f.createdTo) return false;
    if (f.overdueOnly && !isOverdue(r, now)) return false;
    if (text) {
      const hay = [
        r.requestNumber, r.poNumber, r.jobNumber, r.requestorName,
        r.vendorName, r.trackingNumber, r.itemSummary,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
}

/** Row shape the request table renders. Keeps the columns in one place (§8). */
export const TABLE_COLUMNS = [
  'requestNumber',
  'poNumber',
  'jobNumber',
  'requestorName',
  'needBy',
  'requestedQty',
  'workshopStockQty',
  'finalOrderQty',
  'vendorName',
  'estimatedTotalCents',
  'status',
  'approverName',
  'expectedArrival',
  'trackingNumber',
];

/** Roll a request + its lines into a table row. */
export function toTableRow(request, lines = []) {
  const sum = (key) => lines.reduce((t, l) => t + Number(l[key] ?? 0), 0);
  return {
    id: request.id,
    requestNumber: request.requestNumber,
    poNumber: request.poNumber ?? null,
    jobNumber: request.jobNumber,
    requestorName: request.requestorName,
    needBy: request.needByDate ? `${request.needByDate} ${request.needByTime ?? ''}`.trim() : null,
    requestedQty: sum('requestedQty'),
    workshopStockQty: sum('usableStockQty'),
    finalOrderQty: sum('finalOrderQty'),
    vendorName: request.vendorName ?? null,
    estimatedTotalCents: request.estimatedTotalCents ?? estimatedTotalCents(lines),
    status: request.status,
    approverName: request.approverName ?? null,
    expectedArrival: request.expectedArrivalDate ?? null,
    trackingNumber: request.trackingNumber ?? null,
    outstandingLines: countOutstandingLines(lines),
  };
}

// ---------------------------------------------------------------------------
// THE LIFECYCLE BOARD — "what do I need to do next?"
//
// The status filter answers "show me X". This answers the question a purchasing
// manager actually opens the screen with, which is not a filter but a triage:
// which pile is mine, right now, and how big is it.
//
// Every status belongs to exactly one stage, and every stage is always shown
// even when empty. A request that advances MOVES between piles; it never
// vanishes, which is the failure mode this replaces — a queue that only showed
// what needed review, so an approved-but-unordered request became invisible at
// the exact moment someone should have been ordering it.
//
// `actionable` marks the stages where a human is the blocker rather than a
// supplier. That is what the workspace leads with.
// ---------------------------------------------------------------------------

export const LIFECYCLE_STAGES = [
  {
    key: 'NEEDS_REVIEW',
    labelKey: 'purchasing.stage.needs_review',
    statuses: ['SUBMITTED', 'PENDING_WORKSHOP_REVIEW', 'RESUBMITTED'],
    actionable: true,
    tone: 'attention',
  },
  {
    key: 'WAITING_ON_REQUESTOR',
    labelKey: 'purchasing.stage.waiting_on_requestor',
    statuses: ['CLARIFICATION_REQUESTED'],
    actionable: false,
    tone: 'warn',
  },
  {
    key: 'READY_TO_ORDER',
    labelKey: 'purchasing.stage.ready_to_order',
    statuses: ['APPROVED', 'PO_GENERATED', 'EMAIL_DRAFTED'],
    actionable: true,
    tone: 'attention',
  },
  {
    key: 'AWAITING_DELIVERY',
    labelKey: 'purchasing.stage.awaiting_delivery',
    statuses: ['ORDERED'],
    actionable: false,
    tone: 'neutral',
  },
  {
    key: 'PARTIALLY_RECEIVED',
    labelKey: 'purchasing.stage.partially_received',
    statuses: ['PARTIALLY_RECEIVED'],
    actionable: true,
    tone: 'warn',
  },
  {
    key: 'RECEIVED',
    labelKey: 'purchasing.stage.received',
    statuses: ['RECEIVED'],
    actionable: true,
    tone: 'good',
  },
  {
    key: 'DRAFTS',
    labelKey: 'purchasing.stage.drafts',
    statuses: ['DRAFT'],
    actionable: false,
    tone: 'neutral',
  },
  {
    key: 'CLOSED',
    labelKey: 'purchasing.stage.closed',
    statuses: ['COMPLETED', 'REJECTED', 'CANCELLED'],
    actionable: false,
    tone: 'neutral',
  },
];

/** The stage a status belongs to, or null if the vocabulary has drifted. */
export function stageForStatus(status) {
  return LIFECYCLE_STAGES.find((s) => s.statuses.includes(status))?.key ?? null;
}

/**
 * Every stage with its count, in board order. Stages with nothing in them are
 * still returned: "nothing is waiting to be ordered" is information, and a tab
 * that disappears when empty teaches people the pile does not exist.
 */
export function lifecycleBoard(requests = []) {
  return LIFECYCLE_STAGES.map((stage) => ({
    ...stage,
    count: requests.filter((r) => stage.statuses.includes(r.status)).length,
  }));
}

/**
 * How many things are waiting on a HUMAN here, across every actionable stage.
 * The single number a workspace header leads with.
 */
export function needsAttentionCount(requests = []) {
  const actionable = LIFECYCLE_STAGES.filter((s) => s.actionable).flatMap((s) => s.statuses);
  return requests.filter((r) => actionable.includes(r.status)).length;
}
