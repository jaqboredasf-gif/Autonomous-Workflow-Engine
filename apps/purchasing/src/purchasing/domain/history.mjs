// ---------------------------------------------------------------------------
// history.mjs — what a purchase LOOKED LIKE at the moment it ended.
//
// PURE. No I/O, no clock, no storage, no randomness. Both providers must
// produce byte-identical history rows from the same facts, so the rule lives
// here and the repositories only supply rows and write them.
//
// WHY THIS MODULE EXISTS
// `purchase_line_history` (migration 0018) was a VIEW over live entities. A
// view resolves `vendor_id` and `description` at READ time, so renaming a
// vendor silently rewrote every historical row that mentioned it, and a request
// that was cancelled or rejected — never becoming a purchase order — was
// invisible to it entirely because it INNER JOINed purchase_orders.
//
// History that changes when the present changes is not history. BR-012 says
// completed purchasing activity becomes immutable evidence, and evidence that
// can be edited by renaming something else is not evidence.
//
// THE RULE: A HISTORY ROW CARRIES BOTH THE ID AND THE VALUE.
//   * the ID keeps the row joinable to whatever the entity is called TODAY
//   * the SNAPSHOT keeps the row true about what was bought at the TIME
// Neither is derived from the other on read. A renamed vendor changes the
// entity; the row still says what the purchase order said.
//
// ONE ROW PER REQUEST LINE, written ONCE, when the request reaches a terminal
// state (COMPLETED, CANCELLED, REJECTED). Not at order time: quantities,
// receipts, exceptions and the actual cost are not known until the end, and a
// row that is written early and updated later is a mutable record wearing an
// immutable name.
// ---------------------------------------------------------------------------

import { NORMALIZER_VERSION, normalizeDescription } from './catalog.mjs';

/**
 * The states in which history is written. These are exactly the terminal
 * statuses of domain/status.mjs — nothing else ends a request, and a request
 * that has not ended has no history yet, it has a current state.
 */
export const HISTORY_TERMINAL_STATES = Object.freeze(['COMPLETED', 'CANCELLED', 'REJECTED']);

/**
 * What became of an ordered line, as one coarse label. The QUANTITIES are the
 * truth; this is the word a person reads first.
 *
 * Precedence is deliberate: an exception outranks a completion, because a line
 * that was fully received AND had a damaged unit is a line something went wrong
 * on, and that is what the reader needs to see. The quantities beside it say
 * exactly how much of each.
 */
export const RECEIPT_OUTCOMES = Object.freeze([
  'NOT_ORDERED',        // the workshop filled it from stock, or the request ended first
  'WRITTEN_OFF',        // some quantity was written off
  'DAMAGED',            // some quantity arrived damaged
  'BACKORDERED',        // some quantity is still owed by the vendor
  'NOT_RECEIVED',       // ordered, nothing ever arrived
  'PARTIALLY_RECEIVED', // some arrived, some never resolved
  'RECEIVED',           // everything ordered was accounted for, cleanly
]);

/**
 * The fields every history row carries. Exported so a schema test asserts the
 * shape rather than a person remembering it, and so a provider that forgets one
 * fails a check instead of silently storing less than the other.
 *
 * `HISTORY_FIELDS` in catalog.mjs is the older, smaller contract for what a
 * LINE ITEM preserves. This is the contract for the historical record itself.
 */
export const HISTORY_LINE_FIELDS = Object.freeze([
  'orgId',
  // --- when, and under what final state ------------------------------------
  'terminalState',            // COMPLETED | CANCELLED | REJECTED
  'terminalReason',           // the cancellation or rejection reason, verbatim
  'recordedAt',
  'recordedBy',
  // --- identifiers, so the row stays joinable to current data ---------------
  'requestId',
  'requestNumber',            // SNAPSHOT: numbers can be re-sequenced
  'requestItemId',
  'lineNo',
  'purchaseOrderId',
  'poNumber',                 // SNAPSHOT
  'purchaseOrderItemId',
  'jobId',                    // the directory row, when the job was in it
  'jobNumber',                // SNAPSHOT: what the field typed and the vendor saw
  'catalogItemId',
  // --- what was bought, as it was described THEN ----------------------------
  'normalizedDescription',
  'normalizerVersion',
  'requestedDescription',     // SNAPSHOT: what the person typed
  'orderedDescription',       // SNAPSHOT: what the purchase order said, substitutes included
  'unit',
  'requestedQty',
  'orderedQty',
  // --- who it was bought from, as they were called THEN ---------------------
  'vendorId',
  'vendorName',               // SNAPSHOT — this is the field the view got wrong
  'vendorPartNumber',         // SNAPSHOT; arrives with the Phase B catalog import
  // --- money ----------------------------------------------------------------
  'estimatedUnitCostCents',   // what the workshop thought. null = unknown
  'estimatedLineTotalCents',
  'actualUnitCostCents',      // what the invoice said. null = not reconciled
  'actualLineTotalCents',
  // --- people, as they were named THEN --------------------------------------
  'requestorId',
  'requestorName',            // SNAPSHOT
  'approverId',
  'approverName',             // SNAPSHOT
  // --- the timeline ---------------------------------------------------------
  'requestedAt',
  'poGeneratedAt',            // when the PO document was produced
  'orderedAt',                // when it was actually placed with the vendor
  'receivedAt',
  'completedAt',
  // --- what became of it ----------------------------------------------------
  'receivedQty',
  'damagedQty',
  'backorderedQty',
  'writtenOffQty',
  'outcome',
]);

/**
 * Classify one line's fulfilment. See RECEIPT_OUTCOMES for why exceptions win.
 *
 * @param {{orderedQty:number, receivedQty:number, damagedQty:number,
 *          backorderedQty:number, writtenOffQty:number}} line
 * @returns {string} one of RECEIPT_OUTCOMES
 */
export function receiptOutcome(line = {}) {
  const ordered = num(line.orderedQty);
  const received = num(line.receivedQty);
  const damaged = num(line.damagedQty);
  const backordered = num(line.backorderedQty);
  const writtenOff = num(line.writtenOffQty);

  if (ordered <= 0) return 'NOT_ORDERED';
  if (writtenOff > 0) return 'WRITTEN_OFF';
  if (damaged > 0) return 'DAMAGED';
  if (backordered > 0) return 'BACKORDERED';
  if (received <= 0) return 'NOT_RECEIVED';
  if (received + damaged + writtenOff >= ordered) return 'RECEIVED';
  return 'PARTIALLY_RECEIVED';
}

// ---------------------------------------------------------------------------
// CANCELLATION AND REJECTION — the policy, stated once, in the place the rules
// that depend on it live.
//
// THE DECISION:
//   1. A cancelled or rejected request IS recorded. Its lines become history
//      rows carrying `terminalState` and the reason given. Deleting the record
//      of a request somebody raised, reviewed and turned down would make the
//      history a record of successes rather than of what happened, and "we
//      asked for this and were refused" is exactly the fact a manager
//      reconstructing a decision needs.
//   2. Whether a row counts toward money and timing follows from the FACTS on
//      the row, not from its label:
//        * pricing needs the line to have actually been ORDERED — `orderedAt`
//          present and `orderedQty` above zero. A rejected request never
//          reaches ORDERED (the transition graph makes it unreachable), so it
//          is excluded by construction rather than by a special case.
//        * a request CANCELLED AFTER it was placed with a vendor did commit
//          money at a real price, so it is real price evidence and counts.
//        * lead time needs both `orderedAt` and `receivedAt`. A line that was
//          never received reports nothing — never a zero, never an estimate.
//   3. Demand is a different question from purchasing. Every row counts as
//      DEMAND ("this was asked for"), including the rejected ones, and the read
//      model must label the two separately. Silence here is how a rejected
//      request quietly inflates a purchase-frequency count.
// ---------------------------------------------------------------------------

/** Was this line actually placed with a vendor? The basis of every money rule. */
export function wasActuallyOrdered(line = {}) {
  return Boolean(line.orderedAt) && num(line.orderedQty) > 0;
}

/**
 * May this row inform a price? Only if it was ordered AND a price is known.
 * An unknown cost is unknown — it is never zero, and never an average of one.
 */
export function countsTowardPricing(line = {}) {
  if (!wasActuallyOrdered(line)) return false;
  return line.actualUnitCostCents !== null && line.actualUnitCostCents !== undefined
    ? true
    : line.estimatedUnitCostCents !== null && line.estimatedUnitCostCents !== undefined;
}

/** May this row count as "this organization buys that"? Ordered lines only. */
export function countsTowardPurchaseFrequency(line = {}) {
  return wasActuallyOrdered(line);
}

/** Every row is demand: somebody asked for it, whatever the answer was. */
export function countsTowardDemand() {
  return true;
}

/**
 * The price this row is evidence of: the invoice where there is one, the
 * estimate otherwise. Returns null when neither is known — the caller must show
 * nothing rather than a zero.
 */
export function evidencedUnitCostCents(line = {}) {
  if (line.actualUnitCostCents !== null && line.actualUnitCostCents !== undefined) return line.actualUnitCostCents;
  if (line.estimatedUnitCostCents !== null && line.estimatedUnitCostCents !== undefined) return line.estimatedUnitCostCents;
  return null;
}

/**
 * Observed lead time in whole days, or null when it is not measurable.
 *
 * "Where measurable" is load-bearing: a line with no received timestamp has no
 * lead time, and reporting 0 for it would be a fabricated observation.
 */
export function leadTimeDays(line = {}) {
  if (!line.orderedAt || !line.receivedAt) return null;
  const from = Date.parse(line.orderedAt);
  const to = Date.parse(line.receivedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / 86_400_000);
}

// ---------------------------------------------------------------------------
// BUILDING THE ROWS
// ---------------------------------------------------------------------------

/**
 * Build the history rows for one request that has just ended.
 *
 * Everything it needs is passed in, already loaded and already snapshot-shaped
 * by the caller; this function decides only what a history row SAYS. That is
 * what makes the two providers agree — neither of them writes this rule.
 *
 * One row per REQUEST LINE, not per order line: a line the workshop filled from
 * stock never became an order line, and it is still part of what happened.
 *
 * @param {{
 *   request: object,
 *   requestItems: Array<object>,
 *   reviewLines?: Array<object>,
 *   order?: object|null,
 *   orderItems?: Array<object>,
 *   progress?: Array<object>,
 *   vendor?: {id?: string|null, name?: string|null}|null,
 *   job?: {id?: string|null, jobNumber?: string|null}|null,
 *   requestor?: {id?: string|null, name?: string|null}|null,
 *   approver?: {id?: string|null, name?: string|null}|null,
 *   terminalState: string,
 *   terminalReason?: string|null,
 *   recordedAt: string,
 *   recordedBy: string,
 * }} input
 * @returns {Array<object>} history rows, in line order
 */
export function buildHistoryLines(input) {
  const {
    request, requestItems = [], reviewLines = [], order = null, orderItems = [],
    progress = [], vendor = null, job = null, requestor = null, approver = null,
    terminalState, terminalReason = null, recordedAt, recordedBy,
  } = input ?? {};

  if (!request) throw historyError('history_without_request', 'a history row needs the request it describes');
  if (!HISTORY_TERMINAL_STATES.includes(terminalState)) {
    throw historyError('history_before_terminal', `${terminalState} is not a state history is written in`);
  }

  const reviewBy = index(reviewLines, (l) => l.requestItemId);
  const orderItemBy = index(orderItems, (l) => l.request_item_id ?? l.requestItemId);
  const progressBy = index(progress, (p) => p.requestItemId);

  return requestItems.map((item, idx) => {
    const review = reviewBy.get(item.id) ?? null;
    const orderItem = orderItemBy.get(item.id) ?? null;
    const state = progressBy.get(item.id) ?? null;

    // What was ordered may differ from what was asked for — a substitute is a
    // different item, and history has to be able to see that.
    const orderedDescription = orderItem
      ? (orderItem.substitute_description || orderItem.description || null)
      : null;

    // The matching key is the one the line was MATCHED under, kept as it was
    // stored. Only a line that never had one is normalized here, and the
    // version in force at that moment is recorded beside it — history must not
    // re-cluster because someone improved a regex later.
    const normalized =
      orderItem?.normalized_description
      || item.normalizedDescription
      || normalizeDescription(orderedDescription || item.description);

    const orderedQty = orderItem ? num(orderItem.order_qty ?? orderItem.orderQty) : 0;
    const quantities = {
      orderedQty,
      receivedQty: num(state?.receivedQty),
      damagedQty: num(state?.damagedQty),
      backorderedQty: num(state?.backorderedQty),
      writtenOffQty: num(state?.writtenOffQty),
    };

    // WHO THIS LINE WAS BOUGHT FROM — which is a question only a line that
    // became an order line can answer. A line the workshop filled from stock
    // sits on a request that may well have a purchase order for its OTHER
    // lines, and naming that vendor here would say this material came from
    // them. It did not. What is recorded instead is the vendor the workshop had
    // chosen, if any: an intention, and labelled as such by the fact that the
    // row has no ordered_at and no ordered quantity.
    const vendorId = (orderItem ? order?.vendorId : review?.vendorId) ?? null;
    const vendorName = (orderItem ? vendor?.name : review?.vendorName) ?? null;

    return {
      orgId: request.orgId,

      terminalState,
      terminalReason: emptyToNull(terminalReason),
      recordedAt,
      recordedBy,

      requestId: request.id,
      requestNumber: request.requestNumber,
      requestItemId: item.id,
      lineNo: Number(item.lineNo ?? idx + 1),
      purchaseOrderId: order?.id ?? null,
      poNumber: order?.poNumber ?? null,
      purchaseOrderItemId: orderItem?.id ?? null,
      jobId: job?.id ?? null,
      jobNumber: request.jobNumber,
      catalogItemId: orderItem?.catalog_item_id ?? item.catalogItemId ?? null,

      normalizedDescription: normalized,
      normalizerVersion: NORMALIZER_VERSION,
      requestedDescription: item.description,
      orderedDescription,
      unit: orderItem?.unit ?? item.unit,
      requestedQty: num(item.requestedQty),
      orderedQty,

      vendorId,
      vendorName,
      // Nothing produces this yet. It is in the row from the start because a
      // column added later is a column that is null for all of history.
      vendorPartNumber: orderItem?.vendor_part_number ?? null,

      estimatedUnitCostCents: nullableNum(orderItem?.unit_cost_cents ?? review?.estimatedUnitCostCents),
      estimatedLineTotalCents: nullableNum(orderItem?.line_total_cents ?? review?.estimatedLineTotalCents),
      actualUnitCostCents: nullableNum(orderItem?.actual_unit_cost_cents),
      actualLineTotalCents: nullableNum(orderItem?.actual_line_total_cents),

      requestorId: request.requestorId,
      requestorName: requestor?.name ?? request.requestorName ?? null,
      approverId: request.approverId ?? null,
      approverName: approver?.name ?? request.approverName ?? null,

      requestedAt: request.createdAt ?? null,
      poGeneratedAt: order?.generatedAt ?? null,
      orderedAt: request.orderedAt ?? null,
      receivedAt: request.receivedAt ?? null,
      completedAt: request.completedAt ?? null,

      ...quantities,
      outcome: receiptOutcome(quantities),
    };
  });
}

// ---------------------------------------------------------------------------
// DERIVED READ MODEL
//
// Recomputable from the rows above and NEVER written back into them (BR-012).
// Every function here is a pure fold over history rows: run it twice, get the
// same answer, and history is untouched either way.
//
// BR-013: what this produces is OBSERVED. "Last ordered from Graybar" is not
// "our preferred vendor is Graybar" — the second is a configured preference a
// human sets and can be wrong about. The read model must never be read as one.
// ---------------------------------------------------------------------------

/**
 * What an organization's history says about one material.
 *
 * Sample sizes are reported beside every average, because an average of one
 * observation is an observation, not a trend.
 *
 * @param {Array<object>} lines history rows for ONE normalized description
 */
export function summarizeMaterial(lines = []) {
  const purchases = lines.filter(countsTowardPurchaseFrequency);
  const priced = lines.filter(countsTowardPricing);
  const latest = [...purchases].sort(byOrderedAtDesc)[0] ?? null;
  const leadTimes = purchases.map(leadTimeDays).filter((d) => d !== null);

  return {
    // OBSERVED, not configured. See BR-013.
    lastVendorId: latest?.vendorId ?? null,
    lastVendorName: latest?.vendorName ?? null,
    lastUnitCostCents: latest ? evidencedUnitCostCents(latest) : null,
    lastOrderedAt: latest?.orderedAt ?? null,
    timesPurchased: purchases.length,
    timesRequested: lines.length,
    totalQtyPurchased: purchases.reduce((t, l) => t + num(l.orderedQty), 0),
    averageUnitCostCents: average(priced.map(evidencedUnitCostCents)),
    /** How many observations the average is made of. Never omit it. */
    priceSampleSize: priced.length,
    averageLeadTimeDays: average(leadTimes),
    leadTimeSampleSize: leadTimes.length,
  };
}

/**
 * The same fold, grouped by normalized description — the shape the catalogue's
 * "last ordered from / last price / last ordered" columns read.
 *
 * @param {Array<object>} lines every history row for an organization
 * @returns {Map<string, object>}
 */
export function summarizeByMaterial(lines = []) {
  const grouped = new Map();
  for (const line of lines) {
    const key = String(line.normalizedDescription ?? '');
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(line);
  }
  const out = new Map();
  for (const [key, group] of grouped) out.set(key, summarizeMaterial(group));
  return out;
}

// --- helpers ----------------------------------------------------------------

function byOrderedAtDesc(a, b) {
  return String(b?.orderedAt ?? '').localeCompare(String(a?.orderedAt ?? ''));
}

/** Integer mean, or null for an empty sample. Never 0 for "no data". */
function average(values) {
  const usable = values.filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)));
  if (!usable.length) return null;
  return Math.round(usable.reduce((t, v) => t + Number(v), 0) / usable.length);
}

function index(rows, keyOf) {
  const map = new Map();
  for (const row of rows ?? []) {
    const key = keyOf(row);
    if (key !== null && key !== undefined && !map.has(key)) map.set(key, row);
  }
  return map;
}

function num(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function nullableNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function emptyToNull(value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text === '' ? null : text;
}

function historyError(reason, message) {
  const err = new Error(message);
  err.name = 'DomainError';
  err.reason = reason;
  return err;
}
