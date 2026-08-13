// ---------------------------------------------------------------------------
// po-number.mjs — the Lippolis purchase order numbering rule, and NOTHING else.
//
// THE RULE, from Mike and Paul (2026-08-12):
//
//     job number + vendor + sequential number
//
// and the sequential number is scoped to the PAIR. Job 1234 with Cooper counts
// 1, 2, 3. Job 1234 with Graybar starts again at 1. Job 5678 with Cooper starts
// again at 1. There is no company-wide counter, and there never was one — the
// single per-organization sequence this module used to format (LE-52901…) was a
// placeholder standing in for an answer nobody had yet.
//
//     1234-COOPER-1
//     1234-COOPER-2
//     1234-GRAYBAR-1
//     5678-COOPER-1
//
// WHAT LIVES HERE: the shape of the identifier, and the two normalizations that
// make its components safe to put in one. Pure. Shared by both providers, by
// the PDF, by the vendor email and by the screens, so there is exactly one
// answer to "what is this purchase order called".
//
// WHAT DOES NOT LIVE HERE: the number itself. The sequence is ALLOCATED by the
// database, inside the transaction that writes the purchase order — an upsert
// that increments and returns in one statement (SQLite) or the same under a row
// lock (Postgres). A counter in application code cannot be made safe against
// two people pressing Approve in the same second, so there isn't one.
// ---------------------------------------------------------------------------

/** The separator between the three components. Stakeholder-established. */
export const PO_NUMBER_SEPARATOR = '-';

/**
 * The sequence every (job, vendor) pair begins at. One, not zero, and not a
 * configured starting point: a pair PCC has never issued against has issued
 * nothing. Where the office has already written paper purchase orders for a
 * pair, an administrator initializes that pair explicitly — see
 * application/administration.ts, `initializePoSequence`.
 */
export const FIRST_SEQUENCE = 1;

/** How long a vendor code may be. Long enough for a normalized real name. */
export const VENDOR_CODE_MAX = 32;

/**
 * The vendor's identifier AS IT APPEARS IN A PURCHASE ORDER NUMBER.
 *
 * Vendor display names contain spaces, ampersands, commas and periods —
 * "Cooper Electric Supply Co." — none of which belong in an identifier that
 * gets typed into an invoice, a subject line and a filename. So the code is a
 * separate, stored field: derived from the name the first time, and then FROZEN.
 * Renaming the vendor afterwards does not touch it, and does not touch any
 * purchase order already carrying it.
 *
 * This deliberately does NOT abbreviate. "Cooper Electric Supply Co." becomes
 * COOPERELECTRICSUPPLY, not CESC: an abbreviation this module invented would be
 * a name nobody at Lippolis chose, printed on a supplier's paperwork. Where the
 * office wants a shorter code — COOPER — an administrator sets it on the vendor,
 * and that is a decision with a person behind it.
 *
 * Hyphens are stripped rather than kept: the hyphen is the field separator.
 */
export function normalizeVendorCode(name) {
  const text = String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics; keep the letter
    .toUpperCase()
    .replace(/&/g, 'AND')
    .replace(/[^A-Z0-9]/g, '');
  return text.slice(0, VENDOR_CODE_MAX);
}

/**
 * The job's identifier as it appears in a purchase order number.
 *
 * Lippolis job numbers are already identifier-shaped ("1234", "24-118"), and the
 * hyphen inside "24-118" is theirs — it is preserved rather than stripped,
 * because 24-118 is what is written on the drawing. That makes the separator
 * ambiguous to the eye but not to the parser: a vendor code can never contain a
 * hyphen, so `parsePoNumber` splits from the RIGHT and the job takes what is
 * left. Everything else — spaces, slashes, periods — is removed.
 */
export function normalizeJobSegment(jobNumber) {
  return String(jobNumber ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * THE ONE PLACE A PURCHASE ORDER NUMBER IS BUILT.
 *
 * Nothing else in the codebase concatenates these three components — the PDF,
 * the email draft, the queue, the receipt screen and the file name all read the
 * stored `po_number` that this produced once, at issuance.
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
 * Read a formatted number back into its components — for audit, for the legacy
 * import, and for an administrator typing "what did we last send Cooper on this
 * job" into a box.
 *
 * Split from the right, because the JOB may contain hyphens and the vendor code
 * may not. Returns null rather than throwing: this parses input a human typed.
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

export function isValidVendorCode(code) {
  return typeof code === 'string' && /^[A-Z0-9]{1,32}$/.test(code);
}

/**
 * Validate a vendor code an administrator typed. Separate from
 * `normalizeVendorCode` on purpose: a derived code is always valid, and a typed
 * one has to be told why it is not.
 */
export function validateVendorCode(code) {
  const text = String(code ?? '').trim().toUpperCase();
  const errors = [];
  if (!text) {
    errors.push({ field: 'code', message: 'A vendor code is required — it appears in every purchase order number.' });
  } else if (!/^[A-Z0-9]+$/.test(text)) {
    errors.push({ field: 'code', message: 'A vendor code may contain only letters and digits. No spaces, no hyphens.' });
  } else if (text.length > VENDOR_CODE_MAX) {
    errors.push({ field: 'code', message: `A vendor code must be ${VENDOR_CODE_MAX} characters or fewer.` });
  }
  return { ok: errors.length === 0, errors, value: text };
}

/**
 * Give a vendor a code that is not already taken in this organization.
 *
 * Deterministic: the same name against the same set of taken codes always
 * yields the same answer, so a backfill run twice does not renumber anybody.
 * A collision appends a digit rather than truncating differently — the office
 * can see that COOPER2 is the second Cooper and go and give it a proper code.
 */
export function assignVendorCode(name, takenCodes = []) {
  const taken = new Set([...takenCodes].map((c) => String(c ?? '').toUpperCase()));
  const base = normalizeVendorCode(name) || 'VENDOR';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = String(n);
    const candidate = `${base.slice(0, VENDOR_CODE_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`cannot derive a free vendor code from ${JSON.stringify(name)}`);
}

/**
 * Validate an administrator lining a (job, vendor) pair up with the paper book.
 *
 * Two ways to say the same thing, because both are things a person actually
 * knows: "the last one I wrote was 3" and "the next one should be 4". Exactly
 * one must be given, so a form cannot half-say it.
 *
 * `issuedSequence` is the highest sequence PCC has ALREADY issued for the pair,
 * or 0. The result may never land at or below it: that would re-issue a number
 * a vendor already has.
 */
export function planSequenceInitialization({ lastIssuedSequence, nextSequence, issuedSequence = 0 }) {
  const hasLast = lastIssuedSequence !== undefined && lastIssuedSequence !== null && String(lastIssuedSequence).trim() !== '';
  const hasNext = nextSequence !== undefined && nextSequence !== null && String(nextSequence).trim() !== '';

  if (hasLast === hasNext) {
    return {
      ok: false,
      reason: 'validation_failed',
      message: 'Give either the last purchase order number the office issued for this job and vendor, or the next one — not both, and not neither.',
    };
  }

  const raw = hasLast ? lastIssuedSequence : nextSequence;
  const parsed = Number(String(raw).trim());
  if (!Number.isSafeInteger(parsed) || parsed < (hasLast ? 0 : FIRST_SEQUENCE)) {
    return {
      ok: false,
      reason: 'validation_failed',
      message: hasLast
        ? 'The last issued number must be a whole number, zero or greater.'
        : 'The next number must be a whole number of 1 or greater.',
    };
  }

  const nextValue = hasLast ? parsed + 1 : parsed;

  // NEVER BACKWARDS. `issuedSequence` is what PCC itself has already put on a
  // supplier's paperwork; a starting point at or below it would hand out a
  // number that is already on an invoice.
  if (nextValue <= Number(issuedSequence)) {
    return {
      ok: false,
      reason: 'sequence_rewind',
      message: `PCC has already issued sequence ${issuedSequence} for this job and vendor. The next number must be at least ${Number(issuedSequence) + 1} — a purchase order number cannot be issued twice.`,
    };
  }

  return { ok: true, nextValue };
}
