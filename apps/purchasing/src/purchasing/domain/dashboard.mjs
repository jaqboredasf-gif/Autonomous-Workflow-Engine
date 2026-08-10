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

// ---------------------------------------------------------------------------
// THE OPERATIONAL PANELS — purchasing status, receiving status, vendor
// activity, recent purchase orders.
//
// All four are DERIVED, here, from the request records the caller is already
// allowed to see. That is the whole design rule for this section: a dashboard
// panel may only count, sum or sort things that exist. There is no trend, no
// forecast, no "vs last month", and no placeholder series — a number nobody can
// click through to and reconcile is worse than an empty panel, because it gets
// believed.
//
// Pure and total: an empty request list yields empty panels, never zeros
// dressed up as data.
// ---------------------------------------------------------------------------

const ORDERED_ONWARD = ['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'COMPLETED'];

/**
 * The purchasing pipeline: how much work sits in each stage a purchaser can
 * act on, with the money committed alongside the count. Closed and draft
 * stages are excluded — this panel answers "what is in flight".
 */
export function purchasingStatus(requests = []) {
  const inFlight = LIFECYCLE_STAGES.filter((s) => !['CLOSED', 'DRAFTS'].includes(s.key));
  const rows = inFlight.map((stage) => {
    const inStage = requests.filter((r) => stage.statuses.includes(r.status));
    return {
      key: stage.key,
      labelKey: stage.labelKey,
      tone: stage.tone,
      actionable: stage.actionable,
      count: inStage.length,
      valueCents: inStage.reduce((t, r) => t + Number(r.estimatedTotalCents ?? 0), 0),
    };
  });
  const total = rows.reduce((t, r) => t + r.count, 0);
  // The share is of what is in flight, so the bars in the UI add up to the
  // panel's own total rather than to some other screen's denominator.
  return rows.map((r) => ({ ...r, share: total === 0 ? 0 : r.count / total }));
}

/**
 * Receiving, from the receiver's point of view: what is on its way, what
 * arrived incomplete, and what landed recently. `overdueArrivals` counts
 * ordered material whose need-by has passed — the reason someone walks to the
 * shop counter to ask.
 */
export function receivingStatus(requests = [], now = '1970-01-01T00:00:00') {
  const month = String(now).slice(0, 7);
  const awaiting = requests.filter((r) => r.status === 'ORDERED');
  const partial = requests.filter((r) => r.status === 'PARTIALLY_RECEIVED');
  const receivedThisMonth = requests.filter(
    (r) => ['RECEIVED', 'COMPLETED'].includes(r.status) && String(r.receivedAt ?? '').slice(0, 7) === month,
  );
  return {
    awaiting: awaiting.length,
    awaitingValueCents: awaiting.reduce((t, r) => t + Number(r.estimatedTotalCents ?? 0), 0),
    partiallyReceived: partial.length,
    receivedThisMonth: receivedThisMonth.length,
    overdueArrivals: [...awaiting, ...partial].filter((r) => isOverdue(r, now)).length,
    // Ready to close: everything received in full and not yet completed.
    awaitingCompletion: requests.filter((r) => r.status === 'RECEIVED').length,
  };
}

/**
 * Who we are actually buying from. One row per vendor that appears on a real
 * request, with open work, committed value and the last time an order went
 * out. Requests with no vendor yet are not a vendor called "Unassigned" — they
 * are simply not in this panel.
 */
export function vendorActivity(requests = [], limit = 5) {
  const byVendor = new Map();
  for (const r of requests) {
    if (!r.vendorId && !r.vendorName) continue;
    const key = r.vendorId ?? r.vendorName;
    const row = byVendor.get(key) ?? {
      vendorId: r.vendorId ?? null,
      vendorName: r.vendorName ?? null,
      requests: 0,
      openOrders: 0,
      openValueCents: 0,
      lastOrderedAt: null,
    };
    row.requests += 1;
    if (OPEN_ORDER_STATUSES.includes(r.status)) {
      row.openOrders += 1;
      row.openValueCents += Number(r.estimatedTotalCents ?? 0);
    }
    if (r.orderedAt && (!row.lastOrderedAt || r.orderedAt > row.lastOrderedAt)) row.lastOrderedAt = r.orderedAt;
    byVendor.set(key, row);
  }
  // Busiest first, by open work then by total dealings — a vendor with three
  // open orders outranks one with a bigger historical footprint and nothing
  // outstanding, because the panel is about what is live.
  return [...byVendor.values()]
    .sort((a, b) => b.openOrders - a.openOrders || b.openValueCents - a.openValueCents || b.requests - a.requests)
    .slice(0, limit);
}

/**
 * The purchase orders most recently placed with a vendor. Ordered by when the
 * order actually went out; a request that has a PO number but was never
 * ordered has not happened yet as far as a vendor is concerned, so it sorts
 * behind on its decision time rather than jumping the list.
 */
export function recentPurchaseOrders(requests = [], limit = 6) {
  return requests
    .filter((r) => r.poNumber && ORDERED_ONWARD.includes(r.status))
    .map((r) => ({
      id: r.id,
      poNumber: r.poNumber,
      requestNumber: r.requestNumber,
      jobNumber: r.jobNumber,
      vendorName: r.vendorName ?? null,
      status: r.status,
      orderedAt: r.orderedAt ?? null,
      valueCents: Number(r.estimatedTotalCents ?? 0),
    }))
    .sort((a, b) => String(b.orderedAt ?? '').localeCompare(String(a.orderedAt ?? '')))
    .slice(0, limit);
}
