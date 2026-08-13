// ---------------------------------------------------------------------------
// po-number.mjs — the parts of purchase order numbering that belong to
// PURCHASING rather than to any particular organization.
//
// WHAT LIVES HERE: vendor codes, the job segment sanitizer, where a counter
// starts, and the rule for lining a counter up with a paper book. Every one of
// these is true of purchasing wherever it runs — a vendor code has to be safe
// to type into an invoice and a filename no matter what shape the finished
// identifier takes, and a counter starts at one because a pair nothing has been
// issued against has issued nothing.
//
// WHAT NO LONGER LIVES HERE: the SHAPE of the identifier. How the components
// are assembled — job + vendor + sequence, joined by a hyphen — is one
// organization's rule, and it moved to organization/po-numbering.mjs behind the
// interface in domain/po-number-strategy.mjs. Purchasing above that interface
// does not know a number contains a job.
//
// WHAT HAS NEVER LIVED HERE: the number itself. The sequence is ALLOCATED by
// the database, inside the transaction that writes the purchase order — an
// upsert that increments and returns in one statement (SQLite) or the same
// under a row lock (Postgres). A counter in application code cannot be made
// safe against two people pressing Approve in the same second, so there isn't
// one, and no strategy is permitted to invent one.
// ---------------------------------------------------------------------------

/**
 * The value every counter begins at, whatever the organization's rule scopes
 * that counter to. One, not zero, and not a configured starting point: a scope
 * PCC has never issued against has issued nothing. Where the office has already
 * written purchase orders on paper, an administrator initializes that scope
 * explicitly — see application/administration.ts, `initializePoSequence`.
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
 * A job number, made safe to carry inside an identifier and to key a counter
 * on. Used to compare a stored job number against a counter's scope, whether or
 * not the organization's rule puts the job in the number at all.
 *
 * Lippolis job numbers are already identifier-shaped ("1234", "24-118"), and the
 * hyphen inside "24-118" is theirs — it is preserved rather than stripped,
 * because 24-118 is what is written on the drawing. Everything else — spaces,
 * slashes, periods — is removed. A strategy that uses this as part of an
 * identifier is responsible for staying able to read its own output back.
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
