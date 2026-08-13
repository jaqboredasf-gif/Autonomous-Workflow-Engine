// ---------------------------------------------------------------------------
// validation.mjs — what a valid purchase request is, and what a requestor is
// allowed to say. PURE.
//
// Two jobs:
//   1. validateRequestDraft() — the intake rules (§3): job number, need-by date
//      AND time, at least one line, one job number per request.
//   2. stripRequestorFields() — the field firewall (§2, §14): a requestor's
//      payload can never carry vendor, cost, stock or purchasing quantities,
//      even if the client sends them. The server strips and REPORTS, so an
//      attempt is visible in the audit log rather than silently ignored.
// ---------------------------------------------------------------------------

import { parseQty } from './numbers.mjs';
import { REQUESTOR_FORBIDDEN_FIELDS } from './roles.mjs';

/** Closed vocabulary of validation error codes. */
export const VALIDATION_CODES = [
  'job_number_required',
  'multiple_job_numbers',
  'need_by_date_required',
  'need_by_date_invalid',
  'need_by_time_required',
  'need_by_time_invalid',
  'delivery_location_required',
  'items_required',
  'item_description_required',
  'item_quantity_invalid',
  'item_unit_required',
  // Still raised — by a rejection, a cancellation and a clarification, which
  // are accountable acts. NOT by intake; asking for material needs no excuse.
  'reason_required',
  'forbidden_field',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * @param {object} draft {jobNumber, needByDate, needByTime, deliveryLocationId,
 *                        reason, notes, items:[{description, qty, unit, jobNumber?}]}
 * @returns {{ok:boolean, errors:Array<{code,field,message}>}}
 */
export function validateRequestDraft(draft = {}) {
  const errors = [];
  const add = (code, field, message) => errors.push({ code, field, message });

  const jobNumber = String(draft.jobNumber ?? '').trim();
  if (!jobNumber) add('job_number_required', 'jobNumber', 'A job number is required.');

  // One request, one job. A line carrying a different job number is the
  // multi-job purchase order this milestone explicitly refuses to build (§21).
  const lineJobs = new Set(
    (draft.items ?? [])
      .map((i) => String(i.jobNumber ?? '').trim())
      .filter((j) => j.length > 0),
  );
  if (jobNumber) lineJobs.add(jobNumber);
  if (lineJobs.size > 1) {
    add(
      'multiple_job_numbers',
      'jobNumber',
      `A request covers exactly one job. Found: ${[...lineJobs].join(', ')}.`,
    );
  }

  const needByDate = String(draft.needByDate ?? '').trim();
  if (!needByDate) add('need_by_date_required', 'needByDate', 'A need-by date is required.');
  else if (!DATE_RE.test(needByDate) || Number.isNaN(Date.parse(`${needByDate}T00:00:00Z`))) {
    add('need_by_date_invalid', 'needByDate', 'Need-by date must be a real date (YYYY-MM-DD).');
  }

  const needByTime = String(draft.needByTime ?? '').trim();
  if (!needByTime) add('need_by_time_required', 'needByTime', 'A need-by time is required.');
  else if (!TIME_RE.test(needByTime)) {
    add('need_by_time_invalid', 'needByTime', 'Need-by time must be 24-hour HH:MM.');
  }

  if (!String(draft.deliveryLocationId ?? '').trim()) {
    add('delivery_location_required', 'deliveryLocationId', 'Choose where the material should go.');
  }

  // NO REASON IS REQUIRED TO ASK FOR MATERIAL.
  //
  // It used to be, and it was the wrong question: a material request already
  // says why it exists — the work cannot continue without the material. Asking
  // a foreman to write a procurement justification in a parking lot slowed down
  // the one action the whole system exists to make fast, and what came back was
  // "needed for the job" often enough to prove the field was noise.
  //
  // `reason` remains on the request and remains editable; it is simply not a
  // precondition for asking. The reasons that ARE required are the ones a
  // person is accountable for: a rejection, a cancellation and a clarification
  // each still refuse without one (application/decisions.ts, requests.ts).

  const items = Array.isArray(draft.items) ? draft.items : [];
  if (items.length === 0) {
    add('items_required', 'items', 'Add at least one item.');
  }
  items.forEach((item, idx) => {
    if (!String(item.description ?? '').trim()) {
      add('item_description_required', `items[${idx}].description`, `Line ${idx + 1}: describe the item.`);
    }
    const qty = parseQty(item.qty);
    if (!qty.ok || qty.value <= 0) {
      add('item_quantity_invalid', `items[${idx}].qty`, `Line ${idx + 1}: ${qty.ok ? 'quantity must be greater than zero' : qty.error}.`);
    }
    if (!String(item.unit ?? '').trim()) {
      add('item_unit_required', `items[${idx}].unit`, `Line ${idx + 1}: choose a unit of measure.`);
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Remove every purchasing field from a requestor-supplied payload.
 *
 * Returns the cleaned object AND the list of fields that were present, so the
 * caller can record an activity entry. A client that sends a vendor is not an
 * attacker to be silently tolerated; it is a bug or a probe, and both deserve a
 * line in the log.
 */
export function stripRequestorFields(payload = {}) {
  const cleaned = {};
  const rejected = [];
  for (const [key, value] of Object.entries(payload)) {
    if (REQUESTOR_FORBIDDEN_FIELDS.includes(key)) {
      rejected.push(key);
      continue;
    }
    if (key === 'items' && Array.isArray(value)) {
      cleaned.items = value.map((item) => {
        const clean = {};
        for (const [k, v] of Object.entries(item ?? {})) {
          if (REQUESTOR_FORBIDDEN_FIELDS.includes(k)) {
            rejected.push(`items.${k}`);
            continue;
          }
          clean[k] = v;
        }
        return clean;
      });
      continue;
    }
    cleaned[key] = value;
  }
  return { cleaned, rejected: [...new Set(rejected)] };
}

/** Validation for the workshop review side (§4 Section B). */
export function validateReviewLine(line = {}, { requireVendor = true, requireCost = true } = {}) {
  const errors = [];
  const add = (code, field, message) => errors.push({ code, field, message });

  const stock = parseQty(line.usableStock ?? '0');
  if (!stock.ok) add('item_quantity_invalid', 'usableStock', `Workshop stock: ${stock.error}.`);

  const approved = parseQty(line.approvedQty);
  if (!approved.ok) add('item_quantity_invalid', 'approvedQty', `Approved quantity: ${approved.error}.`);

  const finalQty = parseQty(line.finalOrderQty ?? '0');
  if (!finalQty.ok) add('item_quantity_invalid', 'finalOrderQty', `Final order quantity: ${finalQty.error}.`);

  const ordering = finalQty.ok && finalQty.value > 0;
  if (ordering && requireVendor && !String(line.vendorId ?? '').trim()) {
    add('forbidden_field', 'vendorId', 'Choose a vendor for any line you are ordering.');
  }
  if (ordering && requireCost && !String(line.estimatedUnitCost ?? '').trim()) {
    add('forbidden_field', 'estimatedUnitCost', 'Enter an estimated unit cost for any line you are ordering.');
  }
  return { ok: errors.length === 0, errors };
}
