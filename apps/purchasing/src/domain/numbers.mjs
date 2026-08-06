// ---------------------------------------------------------------------------
// numbers.mjs — money and quantity arithmetic. No floats reach storage.
//
// Money is integer CENTS everywhere (column type numeric(12,2) in Postgres,
// INTEGER cents in the pilot SQLite store). Quantity is integer THOUSANDTHS,
// so "12.5 ft" is 12500 and the arithmetic below is exact — a purchase order
// that says 18 must never render 17.999999999999996.
//
// PURE. Parsing is strict: a value we cannot read exactly is an error, never a
// silent 0 (a silently-zeroed unit cost is a wrong purchase order).
// ---------------------------------------------------------------------------

export const QTY_SCALE = 1000;
export const CENTS_SCALE = 100;

/** Units of measure offered in the field form. Free text is still accepted. */
export const UNITS = ['ea', 'ft', 'box', 'roll', 'case', 'lb', 'gal', 'pkg', 'set', 'lot'];

/**
 * Parse a user-entered quantity into integer thousandths.
 * @returns {{ok:true, value:number}|{ok:false, error:string}}
 */
export function parseQty(input) {
  if (input === null || input === undefined || String(input).trim() === '') {
    return { ok: false, error: 'quantity is required' };
  }
  const text = String(input).trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,3})?$/.test(text)) {
    return { ok: false, error: 'quantity must be a positive number with at most 3 decimals' };
  }
  const [whole, frac = ''] = text.split('.');
  const value = Number(whole) * QTY_SCALE + Number((frac + '000').slice(0, 3));
  if (!Number.isSafeInteger(value)) return { ok: false, error: 'quantity is too large' };
  return { ok: true, value };
}

/** Render integer thousandths as a human quantity ("18", "12.5"). */
export function formatQty(thousandths) {
  const n = Number(thousandths ?? 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / QTY_SCALE);
  const frac = String(abs % QTY_SCALE).padStart(3, '0').replace(/0+$/, '');
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

/**
 * Parse a user-entered money amount into integer cents.
 * @returns {{ok:true, value:number}|{ok:false, error:string}}
 */
export function parseMoney(input) {
  if (input === null || input === undefined || String(input).trim() === '') {
    return { ok: false, error: 'amount is required' };
  }
  const text = String(input).trim().replace(/[$,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return { ok: false, error: 'amount must be a positive number with at most 2 decimals' };
  }
  const [whole, frac = ''] = text.split('.');
  const value = Number(whole) * CENTS_SCALE + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(value)) return { ok: false, error: 'amount is too large' };
  return { ok: true, value };
}

/** Render integer cents as "$1,234.56". */
export function formatMoney(cents) {
  const n = Number(cents ?? 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const dollars = Math.trunc(abs / CENTS_SCALE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(abs % CENTS_SCALE).padStart(2, '0')}`;
}

/**
 * Line total = unit cost x quantity, rounded half-up to the cent.
 * Both inputs are integers, so this is exact up to the final rounding.
 */
export function lineTotalCents(unitCostCents, qtyThousandths) {
  const unit = Number(unitCostCents ?? 0);
  const qty = Number(qtyThousandths ?? 0);
  if (!unit || !qty) return 0;
  const product = unit * qty; // cents x thousandths
  return Math.round(product / QTY_SCALE);
}

/**
 * The suggested order quantity: what the job needs, minus what the workshop
 * already has on the shelf. Never negative — a workshop with more stock than
 * the job needs suggests ordering nothing, not a credit.
 *
 * Mike and Rick may override the result upward (replenishment) or downward;
 * this function only produces the SUGGESTION. Spec §4 Section B.
 */
export function suggestedOrderQty(approvedQtyThousandths, usableStockThousandths) {
  const approved = Number(approvedQtyThousandths ?? 0);
  const stock = Number(usableStockThousandths ?? 0);
  return Math.max(0, approved - stock);
}

/**
 * Stock consumed from the workshop shelf to satisfy this line: whatever the job
 * needs, capped at what is actually there.
 */
export function stockAppliedQty(approvedQtyThousandths, usableStockThousandths) {
  const approved = Number(approvedQtyThousandths ?? 0);
  const stock = Number(usableStockThousandths ?? 0);
  return Math.max(0, Math.min(approved, stock));
}

/**
 * Quantity ordered ON TOP of the job requirement — the replenishment Mike chose.
 * Reported separately so "why did we buy 18 when we needed 14" is answerable
 * from data rather than from memory.
 */
export function replenishmentQty(finalOrderQtyThousandths, suggestedQtyThousandths) {
  return Math.max(0, Number(finalOrderQtyThousandths ?? 0) - Number(suggestedQtyThousandths ?? 0));
}

/** Sum of estimated line totals for a set of review lines. */
export function estimatedTotalCents(lines) {
  return (lines ?? []).reduce(
    (sum, l) => sum + lineTotalCents(l.estimatedUnitCostCents, l.finalOrderQty),
    0,
  );
}

/**
 * Receiving tolerance. Over-receipt beyond the ordered quantity is refused
 * unless a human explicitly overrides, and even the override is bounded — a
 * fat-fingered 1800 against an order of 18 is a data-entry error, not a
 * delivery. Spec §19 "cannot exceed reasonable validation rules without an
 * explicit override".
 */
export const OVER_RECEIPT_HARD_MULTIPLE = 2;

export function receiptGuard({ orderedQty, alreadyReceivedQty, incomingQty, override = false }) {
  const ordered = Number(orderedQty ?? 0);
  const already = Number(alreadyReceivedQty ?? 0);
  const incoming = Number(incomingQty ?? 0);
  if (incoming <= 0) return { ok: false, reason: 'non_positive', message: 'received quantity must be positive' };
  const total = already + incoming;
  if (total <= ordered) return { ok: true, reason: null, message: null };
  if (!override) {
    return {
      ok: false,
      reason: 'over_receipt',
      message: `receiving ${formatQty(total)} against an order of ${formatQty(ordered)} needs an explicit over-receipt override`,
    };
  }
  if (total > ordered * OVER_RECEIPT_HARD_MULTIPLE) {
    return {
      ok: false,
      reason: 'over_receipt_hard_limit',
      message: `${formatQty(total)} is more than ${OVER_RECEIPT_HARD_MULTIPLE}x the ordered quantity; correct the entry`,
    };
  }
  return { ok: true, reason: null, message: null };
}

/**
 * A line is resolved when everything ordered is accounted for: received,
 * recorded as damaged, or written off as short/backordered-and-cancelled.
 */
export function lineOutstandingQty(line) {
  const ordered = Number(line.finalOrderQty ?? 0);
  const accounted =
    Number(line.receivedQty ?? 0) + Number(line.damagedQty ?? 0) + Number(line.writtenOffQty ?? 0);
  return Math.max(0, ordered - accounted);
}

export function countOutstandingLines(lines) {
  return (lines ?? []).filter((l) => lineOutstandingQty(l) > 0).length;
}
