// ---------------------------------------------------------------------------
// catalog.mjs — turning what people typed into what an organization buys.
//
// PURE. No I/O, no clock, no storage. Two providers must agree on the result
// byte for byte, so the rule lives here and nowhere else.
//
// WHAT THIS IS FOR (and what it is NOT)
// A company types the same thing many ways: "2x4 LED Troffer 4000K",
// "2X4 led troffer, 4000k", "troffer 2x4 (4000K)". Normalization is what lets
// those collapse into one catalog entry, which is the substrate for the future
// features named in the brief — autocomplete, frequently-purchased ranking,
// recent items, preferred vendor, reorder suggestions, analytics.
//
// NONE of those features are built here. This is the data rule they will need,
// added now because retrofitting it means reprocessing history that was never
// captured.
//
// TWO THINGS ARE ALWAYS KEPT SEPARATELY:
//   description             what the person actually typed. Never rewritten.
//   normalized_description  what it matched on, stored AT THE TIME.
//
// The normalized form is stored rather than recomputed on read, because these
// rules will change. When they do, new lines normalize differently and old
// lines keep the key they were matched under — history does not silently
// re-cluster because someone improved a regex. That is what NORMALIZER_VERSION
// records.
// ---------------------------------------------------------------------------

/**
 * Bump when the rules below change in a way that produces different output.
 * Stored alongside the normalized value so a later migration can tell which
 * rows were computed under which rules.
 */
export const NORMALIZER_VERSION = 1;

/** Words that carry no matching signal in a materials description. */
const NOISE_WORDS = new Set(['the', 'a', 'an', 'of', 'for', 'with', 'and']);

/**
 * Normalize a free-text material description into a matching key.
 *
 * Deterministic, and deliberately conservative: it collapses typography and
 * spacing, not meaning. "4000K" and "3500K" are different items and stay
 * different; "2x4" and "2 x 4" are the same and converge.
 *
 * @param {string} description what the person typed
 * @returns {string} the matching key, or '' when there is nothing to match on
 */
export function normalizeDescription(description) {
  const text = String(description ?? '');
  if (!text.trim()) return '';

  return (
    text
      // Accents fold: "Válvula" and "Valvula" are the same item. This also
      // matters for the Spanish interface the product will support.
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      // Dimensions converge: "2 x 4" -> "2x4", "1/2 in" keeps its fraction.
      .replace(/(\d)\s*[x×]\s*(\d)/g, '$1x$2')
      // Punctuation becomes space, EXCEPT the marks that carry meaning in a
      // materials description: / for fractions, . for decimals, - inside a part
      // number.
      .replace(/[^\p{L}\p{N}\s/.\-]/gu, ' ')
      // A trailing or leading dash/dot is punctuation, not part number.
      .replace(/(^|\s)[-.]+|[-.]+(\s|$)/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 0 && !NOISE_WORDS.has(word))
      .join(' ')
      .trim()
  );
}

/**
 * The catalog entry a line item should match, given what was typed.
 * Returns null when there is nothing to match on — an empty description is not
 * a catalog entry, it is a validation problem that belongs upstream.
 *
 * @param {{orgId: string, description: string, unit?: string|null,
 *          vendorId?: string|null, catalogNumber?: string|null}} line
 */
export function catalogKeyFor(line) {
  const normalized = normalizeDescription(line?.description);
  if (!normalized) return null;
  return {
    orgId: line.orgId,
    normalizedDescription: normalized,
    // What the organization sees offered, if this is the first time the item
    // is seen. Curation can change it later; the raw text is never lost.
    canonicalDescription: String(line.description).trim(),
    defaultUnit: line.unit ?? null,
    defaultVendorId: line.vendorId ?? null,
    catalogNumber: line.catalogNumber ?? null,
    normalizerVersion: NORMALIZER_VERSION,
  };
}

/**
 * Do two descriptions refer to the same catalogued item?
 * Used by tests and by any future de-duplication tool. Not used to REWRITE
 * history — matching is recorded when the line is written, not re-derived.
 */
export function isSameItem(a, b) {
  const left = normalizeDescription(a);
  return left !== '' && left === normalizeDescription(b);
}

/**
 * The fields a historical line must carry for the later features to work.
 * Exported so a schema test can assert the shape rather than a person
 * remembering it.
 *
 * Cross-tenant mixing is prevented by `orgId` being part of every one of these
 * rows AND part of the catalog's unique key — two organizations that buy the
 * same troffer have two catalog entries, and neither can see the other's.
 */
export const HISTORY_FIELDS = Object.freeze([
  'orgId',                  // tenant ownership, on the row itself
  'normalizedDescription',  // what it matched on, at the time
  'description',            // what the person actually typed
  'quantity',
  'unit',
  'vendorId',               // vendor relationship, when known
  'jobNumber',              // job context
  'requestId',
  'purchaseOrderId',
  'poNumber',
  'estimatedUnitCostCents', // what the workshop thought — may be unknown
  'actualUnitCostCents',    // what the invoice said — may be unknown
  'receivedQty',
  'orderedAt',
  'createdAt',
]);
