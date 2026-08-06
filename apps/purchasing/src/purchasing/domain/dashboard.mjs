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
