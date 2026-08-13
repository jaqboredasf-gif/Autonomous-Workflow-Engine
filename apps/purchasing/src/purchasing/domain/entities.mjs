// ---------------------------------------------------------------------------
// entities.mjs — the Purchasing domain's entities and value objects.
//
// PURE. No I/O, no clock, no framework. These functions build and validate the
// shapes the domain reasons about, so an invariant is expressed ONCE, here, and
// the application layer cannot construct an illegal one by forgetting a rule.
//
// They are plain factories rather than classes on purpose: the records travel
// through repositories, server actions and React props, and a class with
// methods does not survive that trip. Behaviour lives in exported functions;
// the data stays serializable.
//
// The six quantities the spec insists must never overwrite each other are
// modelled as one value object, `LineQuantities`, so "which number is this?"
// is answered by the type and not by a comment.
// ---------------------------------------------------------------------------

import { REQUESTOR_FORBIDDEN_FIELDS } from './roles.mjs';
import {
  lineTotalCents,
  replenishmentQty,
  stockAppliedQty,
  suggestedOrderQty,
  lineOutstandingQty,
} from './numbers.mjs';

export class DomainError extends Error {
  constructor(reason, message, details = null) {
    super(message);
    this.name = 'DomainError';
    this.reason = reason;
    this.details = details;
  }
}

// --- value object: the six quantities ---------------------------------------

/**
 * The six quantities of a purchased line, kept apart by construction.
 *
 *   requested — what the field asked for. IMMUTABLE after submission.
 *   observedStock — what the workshop actually had on the shelf, at review time.
 *   approved — what the workshop agrees the job needs.
 *   suggested — DERIVED: approved - observedStock, never below zero.
 *   finalOrder — what is actually being bought. May override the suggestion.
 *   received — what has physically arrived, accumulated over partial receipts.
 *
 * Nothing here writes one from another; only the definitionally-derived values
 * are computed, and a new frozen object is returned.
 *
 * @param {{requested?: number, observedStock?: number, approved?: number|null,
 *          finalOrder?: number|null, received?: number, damaged?: number,
 *          backordered?: number, writtenOff?: number}} [quantities]
 */
export function lineQuantities({
  requested = 0,
  observedStock = 0,
  approved = null,
  finalOrder = null,
  received = 0,
  damaged = 0,
  backordered = 0,
  writtenOff = 0,
} = {}) {
  const approvedQty = approved === null || approved === undefined ? requested : approved;
  const suggested = suggestedOrderQty(approvedQty, observedStock);
  const finalQty = finalOrder === null || finalOrder === undefined ? suggested : finalOrder;

  for (const [name, value] of Object.entries({ requested, observedStock, approved: approvedQty, finalOrder: finalQty, received })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new DomainError('invalid_quantity', `${name} quantity must be zero or more`);
    }
  }

  return Object.freeze({
    requested,
    observedStock,
    approved: approvedQty,
    suggested,
    finalOrder: finalQty,
    received,
    damaged,
    backordered,
    writtenOff,
    // Derived, and reported separately so "why 18 when we needed 14" is data.
    stockApplied: stockAppliedQty(approvedQty, observedStock),
    replenishment: replenishmentQty(finalQty, suggested),
    overridden: finalQty !== suggested,
    outstanding: lineOutstandingQty({
      finalOrderQty: finalQty,
      receivedQty: received,
      damagedQty: damaged,
      writtenOffQty: writtenOff,
    }),
  });
}

/** Money value object. Cents in, cents out — never a float, never a string. */
export function money(cents) {
  const value = Number(cents ?? 0);
  if (!Number.isSafeInteger(value)) throw new DomainError('invalid_money', 'money must be whole cents');
  if (value < 0) throw new DomainError('invalid_money', 'money cannot be negative');
  return value;
}

// --- entity: purchase request line ------------------------------------------

export function requestLine({ lineNo, description, requestedQty, unit, stockNumber = null, notes = null }) {
  if (!String(description ?? '').trim()) throw new DomainError('line_incomplete', `line ${lineNo}: a description is required`);
  if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
    throw new DomainError('line_incomplete', `line ${lineNo}: quantity must be greater than zero`);
  }
  if (!String(unit ?? '').trim()) throw new DomainError('line_incomplete', `line ${lineNo}: a unit of measure is required`);
  return Object.freeze({
    lineNo,
    description: String(description).trim(),
    requestedQty,
    unit: String(unit).trim(),
    stockNumber: stockNumber || null,
    notes: notes || null,
  });
}

// --- entity: purchase request -----------------------------------------------

/**
 * Build a NEW purchase request. Enforces the two intake invariants that cannot
 * be delegated: one request belongs to one job, and the requestor may not
 * express a purchasing decision.
 *
 * @param {{orgId: string, requestNumber: string, jobNumber: string, requestorId: string,
 *          needByDate: string, needByTime: string, deliveryLocationId: string,
 *          deliveryMethod?: string, reason?: string|null, notes?: string|null,
 *          items?: Array<any>}} spec
 */
export function newPurchaseRequest({
  orgId, requestNumber, jobNumber, requestorId, needByDate, needByTime,
  deliveryLocationId, deliveryMethod = 'DELIVERY', reason = null, notes = null, items = [],
}) {
  const job = String(jobNumber ?? '').trim();
  if (!job) throw new DomainError('job_number_required', 'a job number is required');

  const lineJobs = new Set(items.map((i) => String(i.jobNumber ?? '').trim()).filter(Boolean));
  lineJobs.add(job);
  if (lineJobs.size > 1) {
    throw new DomainError('multiple_job_numbers', `a request covers exactly one job (found ${[...lineJobs].join(', ')})`);
  }
  if (items.length === 0) throw new DomainError('items_required', 'a request needs at least one item');

  return Object.freeze({
    orgId,
    requestNumber,
    jobNumber: job,
    requestorId,
    status: 'DRAFT',
    needByDate,
    needByTime,
    deliveryLocationId,
    deliveryMethod: deliveryMethod === 'PICKUP' ? 'PICKUP' : 'DELIVERY',
    reason,
    notes,
    version: 1,
    items: items.map((item, idx) => requestLine({ ...item, lineNo: idx + 1, requestedQty: item.requestedQty })),
  });
}

/**
 * The immutability rule, as a function rather than a hope: after submission the
 * requestor's own numbers are frozen. Everything the workshop decides lives on
 * the review, alongside them.
 */
export const REQUESTOR_EDITABLE_STATUSES = ['DRAFT', 'CLARIFICATION_REQUESTED'];

export function assertOriginalMutable(request) {
  if (!REQUESTOR_EDITABLE_STATUSES.includes(request.status)) {
    throw new DomainError(
      'original_frozen',
      `the original request is read-only once submitted (status ${request.status})`,
    );
  }
}

/** The field firewall as a domain rule, not a controller concern. */
export function assertNoPurchasingFields(payload) {
  const offending = Object.keys(payload ?? {}).filter((k) => REQUESTOR_FORBIDDEN_FIELDS.includes(k));
  if (offending.length) {
    throw new DomainError('purchasing_field_on_request', `purchasing decisions are not part of a request: ${offending.join(', ')}`);
  }
}

// --- entity: workshop review line -------------------------------------------

/**
 * Apply the workshop's numbers to one requested line. Returns BOTH the original
 * line (untouched) and the review values, so the caller physically cannot
 * collapse them into one record.
 *
 * @param {{original: any, observedStock?: number, approved?: number|null,
 *          finalOrder?: number|null, vendorId?: string|null, unitCostCents?: number|null,
 *          substituteDescription?: string|null, expectedArrivalDate?: string|null,
 *          notes?: string|null, overrideReason?: string|null}} spec
 */
export function reviewLine({ original, observedStock = 0, approved = null, finalOrder = null, vendorId = null, unitCostCents = null, substituteDescription = null, expectedArrivalDate = null, notes = null, overrideReason = null }) {
  const quantities = lineQuantities({
    requested: original.requestedQty,
    observedStock,
    approved,
    finalOrder,
  });

  if (quantities.finalOrder > 0 && !vendorId) {
    throw new DomainError('vendor_required', `line ${original.lineNo}: a line being ordered needs a vendor`);
  }
  if (quantities.finalOrder > 0 && unitCostCents === null) {
    throw new DomainError('cost_required', `line ${original.lineNo}: a line being ordered needs an estimated unit cost`);
  }

  return Object.freeze({
    original,
    quantities,
    vendorId,
    unitCostCents: unitCostCents === null ? null : money(unitCostCents),
    lineTotalCents: lineTotalCents(unitCostCents ?? 0, quantities.finalOrder),
    substituteDescription: substituteDescription || null,
    expectedArrivalDate: expectedArrivalDate || null,
    notes: notes || null,
    // An override is recorded WITH its reason or it is not an override, it is
    // an unexplained number on a purchase order.
    overrideReason: quantities.overridden ? (overrideReason || 'workshop override') : null,
  });
}

/** A review is ready to be decided on when it can produce a purchase order. */
export function assertReviewReadyForApproval(lines) {
  const ordering = lines.filter((l) => l.quantities.finalOrder > 0);
  if (ordering.length === 0) {
    throw new DomainError('nothing_to_order', 'approve with at least one line to order, or reject the request');
  }
  if (ordering.some((l) => !l.vendorId)) throw new DomainError('vendor_required', 'every ordered line needs a vendor');
  if (ordering.some((l) => l.unitCostCents === null)) {
    throw new DomainError('cost_required', 'every ordered line needs an estimated unit cost');
  }
  const vendors = [...new Set(ordering.map((l) => l.vendorId))];
  return { ordering, vendorIds: vendors };
}

/**
 * One purchase order, one vendor — for this milestone. Splitting a request
 * across vendors is a designed extension point, and this is where it hangs.
 */
export function assertSingleVendor(vendorIds) {
  if (vendorIds.length !== 1 || !vendorIds[0]) {
    throw new DomainError('single_vendor_required', 'this milestone issues one purchase order to one vendor');
  }
  return vendorIds[0];
}

// --- entity: purchase order --------------------------------------------------

export function purchaseOrderFromReview({ request, lines, poNumber, sequenceValue, vendorId, vendorCode, approverId, generatedBy }) {
  const ordering = lines.filter((l) => l.quantities.finalOrder > 0);
  const estimatedTotalCents = ordering.reduce((t, l) => t + l.lineTotalCents, 0);
  return Object.freeze({
    orgId: request.orgId,
    requestId: request.id,
    poNumber,
    sequenceValue,
    vendorId,
    // The vendor's code AS AT ISSUANCE, kept beside the job number: these two
    // and the sequence ARE the purchase order number, and a later rename must
    // not be able to change what a supplier was sent.
    vendorCode,
    jobNumber: request.jobNumber,
    approverId,
    generatedBy,
    deliveryLocationId: request.deliveryLocationId,
    deliveryMethod: request.deliveryMethod,
    needByDate: request.needByDate,
    needByTime: request.needByTime,
    estimatedTotalCents,
    items: ordering.map((l, idx) => ({
      lineNo: idx + 1,
      requestItemId: l.original.id,
      description: l.original.description,
      substituteDescription: l.substituteDescription,
      orderQty: l.quantities.finalOrder,
      unit: l.original.unit,
      unitCostCents: l.unitCostCents ?? 0,
      lineTotalCents: l.lineTotalCents,
      expectedArrivalDate: l.expectedArrivalDate,
    })),
  });
}

// --- receiving ---------------------------------------------------------------

/** Is every ordered quantity resolved — received, damaged, or written off? */
export function outstandingLines(progress) {
  return progress.filter((p) => p.outstandingQty > 0);
}

export function assertFullyResolved(progress) {
  const open = outstandingLines(progress);
  if (open.length) {
    throw new DomainError('lines_outstanding', `${open.length} line(s) are not fully resolved`);
  }
}

// --- how a request describes itself in one line -------------------------------

/**
 * The material, in a phrase — for a list row, a queue entry, and the text a
 * search matches against.
 *
 * WHY IT EXISTS. A list row carried a request number, a job number and a
 * status, and nothing about what was actually asked for. Reading the queue
 * meant opening every row to find the one about cable, and searching for "MC
 * cable" matched nothing at all, because no field on the row held the words.
 *
 * The first line plus a count of the rest, because that is what fits and
 * because the first line is what the requester typed first.
 *
 * TWO ENTRY POINTS, one rule. A provider that has the lines passes them; one
 * that has only the first description and a count passes those. Both end here,
 * so a row means the same thing whichever provider loaded it.
 */
export function itemSummary(firstDescription, itemCount = 1) {
  const first = String(firstDescription ?? '').trim();
  if (!first) return '';
  const extra = Math.max(0, Number(itemCount ?? 1) - 1);
  return extra > 0 ? `${first} +${extra} more` : first;
}

export function summarizeItems(items = []) {
  const lines = [...items]
    .filter((i) => String(i?.description ?? '').trim())
    .sort((a, b) => Number(a.lineNo ?? 0) - Number(b.lineNo ?? 0));
  if (!lines.length) return '';
  return itemSummary(lines[0].description, lines.length);
}
