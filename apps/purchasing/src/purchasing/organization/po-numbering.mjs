// ---------------------------------------------------------------------------
// organization/po-numbering.mjs — which numbering rule this installation uses,
// and the implementation of the one rule we have been given.
//
// THE ARRANGEMENT:
//
//   purchasing capability          allocator, use cases, screens
//        ↓ depends on
//   PO number strategy interface   domain/po-number-strategy.mjs
//        ↑ implemented by
//   this file, selected by         the organization profile's
//                                  purchasing.po_numbering
//
// Purchasing above the interface does not know that a number contains a job, or
// a vendor code, or a hyphen. It knows there is a counter, that the counter is
// scoped to something the organization chose, and that some organization-owned
// function turns a consumed value into the identifier a supplier will see.
//
// SELECTION IS BY NAME, FROM AN EXPLICIT MAP. There is no directory scan, no
// dynamic import, no plugin protocol: adding an organization's rule means
// writing its function and putting it in `IMPLEMENTED` where it can be read.
// An id nobody has implemented is refused — see `poNumberStrategyFor`.
// ---------------------------------------------------------------------------

import { definePoNumberStrategy } from '../domain/po-number-strategy.mjs';
import { FIRST_SEQUENCE, isValidVendorCode, normalizeJobSegment } from '../domain/po-number.mjs';

// --- the Lippolis rule ------------------------------------------------------
//
// From Mike and Paul (2026-08-12): job number + vendor + sequential number, and
// the sequence is scoped to the PAIR. Job 1234 with Cooper counts 1, 2, 3. Job
// 1234 with Graybar starts again at 1. Job 5678 with Cooper starts again at 1.
//
//     1234-COOPER-1
//     1234-COOPER-2
//     1234-GRAYBAR-1
//     5678-COOPER-1
//
// This is stakeholder-established production behaviour and its output is fixed
// by test. Nothing here may change without an instruction from the office.

/** The separator between the three components. Lippolis's, not purchasing's. */
export const PO_NUMBER_SEPARATOR = '-';

/**
 * Build a Lippolis purchase order number.
 *
 * No zero-padding: `1234-COOPER-1`, not `1234-COOPER-0001`. The examples came
 * from the people who write these by hand and they are unpadded.
 */
export function formatPoNumber({ jobNumber, vendorCode, sequence }) {
  const job = normalizeJobSegment(jobNumber);
  const code = String(vendorCode ?? '').toUpperCase();
  const n = Number(sequence);

  if (!job) throw new Error(`a purchase order number needs a job number (got ${JSON.stringify(jobNumber)})`);
  if (!isValidVendorCode(code)) throw new Error(`invalid vendor code for a purchase order number: ${JSON.stringify(vendorCode)}`);
  if (!Number.isSafeInteger(n) || n < FIRST_SEQUENCE) throw new Error(`invalid PO sequence value: ${sequence}`);

  return `${job}${PO_NUMBER_SEPARATOR}${code}${PO_NUMBER_SEPARATOR}${n}`;
}

/**
 * Read a Lippolis number back into its components — for audit, for the legacy
 * import, and for an administrator typing "what did we last send Cooper on this
 * job" into a box.
 *
 * Split from the right, because the JOB may contain hyphens ("24-118" is what
 * is written on the drawing) and the vendor code may not. Returns null rather
 * than throwing: this parses input a human typed.
 */
export function parsePoNumber(poNumber) {
  const text = String(poNumber ?? '').trim().toUpperCase();
  const lastDash = text.lastIndexOf(PO_NUMBER_SEPARATOR);
  if (lastDash <= 0) return null;
  const secondDash = text.lastIndexOf(PO_NUMBER_SEPARATOR, lastDash - 1);
  if (secondDash <= 0) return null;

  const jobNumber = text.slice(0, secondDash);
  const vendorCode = text.slice(secondDash + 1, lastDash);
  const digits = text.slice(lastDash + 1);

  if (!jobNumber || !isValidVendorCode(vendorCode) || !/^\d+$/.test(digits)) return null;
  const sequence = Number(digits);
  if (!Number.isSafeInteger(sequence) || sequence < FIRST_SEQUENCE) return null;
  return { jobNumber, vendorCode, sequence };
}

/** Lippolis: job + vendor + a sequence that counts within that pair. */
export const JOB_VENDOR_SEQUENCE = definePoNumberStrategy({
  id: 'job-vendor-sequence',
  sequenceScope: ({ jobNumber, vendorId }) => ({
    jobKey: normalizeJobSegment(jobNumber),
    vendorKey: vendorId,
  }),
  format: ({ jobNumber, vendorCode, sequence }) => formatPoNumber({ jobNumber, vendorCode, sequence }),
});

// --- selection --------------------------------------------------------------

/**
 * Every numbering rule this build can actually perform.
 *
 * One entry, because one organization has told us their rule. A second customer
 * adds a second entry — a `definePoNumberStrategy` call and a line here — and
 * changes nothing above the interface.
 */
export const IMPLEMENTED = Object.freeze({
  [JOB_VENDOR_SEQUENCE.id]: JOB_VENDOR_SEQUENCE,
});

/** The ids this build can perform, for an error message worth reading. */
export const IMPLEMENTED_IDS = Object.freeze(Object.keys(IMPLEMENTED));

/**
 * The strategy named by an organization's profile.
 *
 * BOTH FAILURES ARE LOUD, AND BOTH ARE PROVISIONING FAILURES:
 *
 *   * no id at all — the organization was stood up without anybody establishing
 *     how it numbers purchase orders, and
 *   * an id nobody has implemented — the organization's rule is KNOWN and this
 *     build cannot perform it. `vendor-sequence` in the org-002 profile is
 *     exactly this case.
 *
 * Neither is answered with a substitute. There is no fallback rule, and there is
 * no placeholder number: a purchase order named `TEMP-001` or by a UUID would
 * leave the building on a supplier's paperwork and be reconciled against an
 * invoice months later, at which point the missing decision has become data.
 * Refusing to start is recoverable. Fabricated numbers are not.
 */
export function poNumberStrategyFor(id, orgId) {
  const key = typeof id === 'string' ? id.trim() : '';
  if (!key) {
    const err = new Error(
      `this installation has not been told how ${orgId ? `organization ${orgId}` : 'its organization'} numbers purchase orders. ` +
        'Set the organization profile\'s purchasing.po_numbering (and PCC_PO_NUMBERING) to one of: ' +
        `${IMPLEMENTED_IDS.join(', ')}.`,
    );
    err.reason = 'po_numbering_unconfigured';
    throw err;
  }
  const strategy = IMPLEMENTED[key];
  if (!strategy) {
    const err = new Error(
      `purchase order numbering rule "${key}" is not implemented in this build. ` +
        `Implemented: ${IMPLEMENTED_IDS.join(', ')}. Implement the organization's rule in ` +
        'organization/po-numbering.mjs — purchasing will not approximate it.',
    );
    err.reason = 'po_numbering_not_implemented';
    throw err;
  }
  return strategy;
}
