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
 * The separators an organization may choose between.
 *
 * A CLOSED SET, on purpose. The separator ends up inside an identifier that is
 * printed on a supplier's paperwork, used in a filename, and typed back into a
 * search box, so it may not be a space, a slash-that-is-a-path-separator
 * surprise, a quote, or anything a spreadsheet will treat as a formula. Two
 * characters cover both organizations we have; a third is a one-line change and
 * a conversation, which is the right cost for a decision that is permanent once
 * a number has left the building.
 */
export const ALLOWED_SEPARATORS = Object.freeze(['-', '/']);

/**
 * The separator, or a refusal.
 *
 * Refused rather than defaulted. An organization that declared `po_separator`
 * as something this build will not put in an identifier has told us something
 * specific about its paperwork, and quietly substituting a hyphen would issue
 * numbers that do not match the book the office is reconciling against.
 */
export function requireSeparator(separator) {
  const sep = separator === undefined || separator === null ? PO_NUMBER_SEPARATOR : String(separator);
  if (!ALLOWED_SEPARATORS.includes(sep)) {
    const err = new Error(
      `purchase order number separator ${JSON.stringify(separator)} is not one this build will put in an identifier. ` +
        `Allowed: ${ALLOWED_SEPARATORS.map((c) => JSON.stringify(c)).join(', ')}. ` +
        'Set the organization profile\'s purchasing.po_separator, and if the organization genuinely uses ' +
        'another character, add it to ALLOWED_SEPARATORS deliberately — purchasing will not substitute one.',
    );
    err.reason = 'po_separator_not_allowed';
    throw err;
  }
  return sep;
}

/**
 * Build a Lippolis purchase order number.
 *
 * No zero-padding: `1234-COOPER-1`, not `1234-COOPER-0001`. The examples came
 * from the people who write these by hand and they are unpadded.
 */
export function formatPoNumber({ jobNumber, vendorCode, sequence, separator = PO_NUMBER_SEPARATOR }) {
  const sep = requireSeparator(separator);
  const job = normalizeJobSegment(jobNumber);
  const code = String(vendorCode ?? '').toUpperCase();
  const n = Number(sequence);

  if (!job) throw new Error(`a purchase order number needs a job number (got ${JSON.stringify(jobNumber)})`);
  if (!isValidVendorCode(code)) throw new Error(`invalid vendor code for a purchase order number: ${JSON.stringify(vendorCode)}`);
  if (!Number.isSafeInteger(n) || n < FIRST_SEQUENCE) throw new Error(`invalid PO sequence value: ${sequence}`);

  return `${job}${sep}${code}${sep}${n}`;
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
export const JOB_VENDOR_SEQUENCE = jobVendorSequence();

/**
 * The Lippolis rule, built for a given separator.
 *
 * The separator is the organization's — `purchasing.po_separator` — and the
 * default is Lippolis's hyphen, so `jobVendorSequence()` is byte-for-byte the
 * strategy that has always been here. That equality is asserted by test rather
 * than trusted: see scripts/eval-second-customer.mjs.
 */
export function jobVendorSequence({ separator = PO_NUMBER_SEPARATOR } = {}) {
  const sep = requireSeparator(separator);
  return definePoNumberStrategy({
    id: 'job-vendor-sequence',
    sequenceScope: ({ jobNumber, vendorId }) => ({
      jobKey: normalizeJobSegment(jobNumber),
      vendorKey: vendorId,
    }),
    format: ({ jobNumber, vendorCode, sequence }) => formatPoNumber({ jobNumber, vendorCode, sequence, separator: sep }),
  });
}

// --- the second rule --------------------------------------------------------
//
// A CONTRACTOR THAT DOES NOT COUNT PER JOB. The synthetic second organization
// numbers per vendor: every purchase order to Cooper is the next Cooper number,
// whichever job it is for.
//
//     COOPER/1
//     COOPER/2      — a different job, the same counter
//     GRAYBAR/1
//
// THIS EXISTS BECAUSE ITS ABSENCE WAS A SOURCE-CODE BLOCKER. The org-002
// profile has declared `vendor-sequence` since the numbering seam landed, and
// no build could perform it — so provisioning a second organization refused at
// startup and the fix was for Jack to edit this file. That is precisely the
// class of blocker the second-customer work exists to remove. The seam did not
// change; only the number of rules behind it did, which is the seam working.
//
// NOTE WHAT IS NOT CLAIMED: this is not "per-vendor numbering for any business".
// It is one more rule in an explicit map. A third organization that counts per
// month, or pads to four digits, adds a third entry. There is still no DSL.

/** A sequence that counts within the VENDOR alone — the job does not scope it. */
export function vendorSequence({ separator = PO_NUMBER_SEPARATOR } = {}) {
  const sep = requireSeparator(separator);
  return definePoNumberStrategy({
    id: 'vendor-sequence',
    // No jobKey at all. The counter table is keyed on the vendor, which
    // sequenceKeyFor already permits — a rule that does not count per job says
    // so by leaving it out.
    sequenceScope: ({ vendorId }) => ({ vendorKey: vendorId }),
    format: ({ vendorCode, sequence }) => formatVendorPoNumber({ vendorCode, sequence, separator: sep }),
  });
}

export const VENDOR_SEQUENCE = vendorSequence();

/**
 * Build a vendor-scoped purchase order number.
 *
 * Same validation as the Lippolis rule, minus the job it does not use. A blank
 * or malformed component throws rather than producing `undefined/1`.
 */
export function formatVendorPoNumber({ vendorCode, sequence, separator = PO_NUMBER_SEPARATOR }) {
  const sep = requireSeparator(separator);
  const code = String(vendorCode ?? '').toUpperCase();
  const n = Number(sequence);

  if (!isValidVendorCode(code)) throw new Error(`invalid vendor code for a purchase order number: ${JSON.stringify(vendorCode)}`);
  if (!Number.isSafeInteger(n) || n < FIRST_SEQUENCE) throw new Error(`invalid PO sequence value: ${sequence}`);

  return `${code}${sep}${n}`;
}

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
  [VENDOR_SEQUENCE.id]: VENDOR_SEQUENCE,
});

/**
 * The same rules, as BUILDERS that accept the organization's separator.
 *
 * `IMPLEMENTED` above stays exactly what it was — instances built with the
 * default separator — because it is the vocabulary an error message quotes and
 * the thing `env.ts` validates a declared id against. This map is what the
 * composition root uses when it knows the organization's separator.
 */
export const BUILDERS = Object.freeze({
  'job-vendor-sequence': jobVendorSequence,
  'vendor-sequence': vendorSequence,
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
export function poNumberStrategyFor(id, orgId, options = {}) {
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
  const build = BUILDERS[key];
  if (!build) {
    const err = new Error(
      `purchase order numbering rule "${key}" is not implemented in this build. ` +
        `Implemented: ${IMPLEMENTED_IDS.join(', ')}. Implement the organization's rule in ` +
        'organization/po-numbering.mjs — purchasing will not approximate it.',
    );
    err.reason = 'po_numbering_not_implemented';
    throw err;
  }
  // The separator is the organization's, and `requireSeparator` refuses one this
  // build will not print rather than substituting a hyphen. Omitted, it is
  // Lippolis's hyphen, which is what every existing installation declares.
  return build({ separator: options.separator });
}
