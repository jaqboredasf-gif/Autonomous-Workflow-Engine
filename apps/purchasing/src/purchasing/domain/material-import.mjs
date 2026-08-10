// ---------------------------------------------------------------------------
// material-import.mjs — turning somebody's spreadsheet into catalogue rows.
//
// PURE. No file system, no XLSX library, no database. It takes a table — an
// array of rows of cells, which is what both a CSV parse and a sheet read
// reduce to — and returns records plus the problems it found.
//
// WHY THE PARSER IS NOT IN HERE
// A .xlsx is a zip of XML and needs a library; a .csv needs quote handling. Both
// produce the same thing: a header row and data rows. Keeping the FORMAT out of
// this module means the rules that matter — which column means what, what an
// alias is, when two rows are the same material — are testable without a
// fixture file, and identical whether the list arrived as CSV, as a sheet, or
// one day through an API.
//
// WHAT THIS REFUSES TO DO
// It does not invent a catalogue. Every record it emits comes from a row
// somebody wrote. A row it cannot understand is reported, not guessed at and
// not dropped silently — an import that quietly skips 40 of 900 lines is worse
// than one that fails, because nobody finds out until a material is missing
// mid-order.
// ---------------------------------------------------------------------------

import { normalizeDescription } from './catalog.mjs';

/**
 * Column aliases. The authoritative list is maintained by people, in Excel, and
 * will not have the headers a programmer would choose. Each canonical field
 * lists the header spellings seen in the wild; matching is case-insensitive and
 * ignores punctuation and spacing, so "Mfr. Part #" and "mfr part number" are
 * the same column.
 */
export const COLUMN_ALIASES = Object.freeze({
  materialId: ['material id', 'materialid', 'id', 'item id', 'item number', 'item no', 'sku', 'internal id'],
  canonicalDescription: ['description', 'canonical description', 'material', 'item', 'item description', 'name', 'material description'],
  aliases: ['aliases', 'alias', 'also known as', 'aka', 'other names', 'synonyms'],
  category: ['category', 'group', 'class'],
  subcategory: ['subcategory', 'sub category', 'sub-category', 'subgroup', 'type'],
  size: ['size', 'dimension', 'dimensions', 'gauge', 'length'],
  unit: ['unit', 'uom', 'unit of measure', 'units'],
  manufacturer: ['manufacturer', 'mfr', 'mfg', 'make', 'brand'],
  // "Mfr. Part #" folds to "mfr part" — the # and the period carry no
  // information once folded, so the abbreviated forms are listed too.
  manufacturerPartNumber: [
    'mpn', 'mfr part number', 'manufacturer part number', 'mfg part no', 'part number', 'part no',
    'mfr part', 'mfg part', 'manufacturer part', 'catalog number', 'cat no',
  ],
  preferredVendor: ['preferred vendor', 'default vendor', 'vendor', 'supplier'],
  vendorPartNumber: ['vendor part number', 'vendor part no', 'supplier part number', 'vendor sku'],
  active: ['active', 'in use', 'status', 'enabled'],
  lastUnitCost: ['last price', 'last cost', 'price', 'unit cost', 'cost'],
  purchaseFrequency: ['purchase frequency', 'frequency', 'times purchased', 'times requested', 'usage'],
});

/** Fold a header cell to its comparison form: lowercase, letters and digits. */
function foldHeader(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Map the sheet's header row onto canonical field names.
 *
 * Returns the mapping AND the headers it did not recognise. Unknown columns are
 * not an error — a maintenance spreadsheet carries columns purchasing has no
 * use for — but they are reported, because a column called "Preferred Supplier"
 * that nobody mapped is the difference between an import that worked and one
 * that looked like it did.
 */
export function mapColumns(headerRow = []) {
  const mapping = {};
  const unmapped = [];
  headerRow.forEach((header, index) => {
    const folded = foldHeader(header);
    if (!folded) return;
    const field = Object.keys(COLUMN_ALIASES).find((key) =>
      COLUMN_ALIASES[key].some((alias) => foldHeader(alias) === folded));
    if (field && mapping[field] === undefined) mapping[field] = index;
    else unmapped.push({ index, header: String(header) });
  });
  return { mapping, unmapped };
}

/** Units are written a dozen ways. One vocabulary, so quantities can be summed. */
const UNIT_CANONICAL = Object.freeze({
  ea: 'EA', each: 'EA', ' pc': 'EA', pc: 'EA', pcs: 'EA', piece: 'EA', pieces: 'EA', unit: 'EA',
  ft: 'FT', foot: 'FT', feet: 'FT', lf: 'FT', 'linear foot': 'FT', 'linear feet': 'FT',
  in: 'IN', inch: 'IN', inches: 'IN',
  box: 'BOX', bx: 'BOX', boxes: 'BOX',
  roll: 'ROLL', rolls: 'ROLL', rl: 'ROLL',
  case: 'CASE', cs: 'CASE', cases: 'CASE',
  bag: 'BAG', bags: 'BAG',
  pkg: 'PKG', package: 'PKG', pk: 'PKG', pack: 'PKG',
  lb: 'LB', lbs: 'LB', pound: 'LB', pounds: 'LB',
  gal: 'GAL', gallon: 'GAL', gallons: 'GAL',
  c: 'C', hundred: 'C', m: 'M', thousand: 'M',
});

export function normalizeUnit(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw) return null;
  return UNIT_CANONICAL[raw] ?? raw.toUpperCase();
}

/** "yes"/"y"/"true"/"1"/"active" are all yes. Blank means yes: most rows are live. */
function parseActive(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return true;
  if (['no', 'n', 'false', '0', 'inactive', 'discontinued', 'obsolete'].includes(raw)) return false;
  return true;
}

/**
 * Money as cents, from whatever a spreadsheet cell holds: "$12.50", "12.5",
 * 12.5, "1,250.00". Returns null rather than 0 for an empty or unreadable
 * cell — a price of zero is a claim, and "we do not know" is not that claim.
 */
export function parseMoneyCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).replace(/[$\s,]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  return Math.round(Number(raw) * 100);
}

function parseCount(value) {
  const raw = String(value ?? '').replace(/[\s,]/g, '');
  if (!/^\d+$/.test(raw)) return 0;
  return Number(raw);
}

/** Aliases arrive separated by any of the three things people reach for. */
function parseAliases(value) {
  return String(value ?? '')
    .split(/[;|\n]|,(?![^(]*\))/)
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * Normalize a whole table into catalogue records.
 *
 * @param {Array<Array<unknown>>} table  header row first, then data rows
 * @param {{ orgId?: string, source?: string }} [opts]
 * @returns {{ records: object[], problems: object[], unmappedColumns: object[], mapping: object }}
 *
 * A record is emitted only when the row has a description — the one field
 * nothing can be reconstructed without. Everything else is optional, because
 * the alternative is refusing a 900-line list over a missing category.
 *
 * Duplicates are detected on the normalized description (the same rule the
 * catalogue clusters history under) and reported with BOTH row numbers, so the
 * person maintaining the sheet can fix the sheet rather than have the importer
 * silently pick one.
 */
export function normalizeMaterialImport(table = [], opts = {}) {
  const [headerRow = [], ...rows] = table;
  const { mapping, unmapped } = mapColumns(headerRow);
  const problems = [];
  const records = [];

  if (mapping.canonicalDescription === undefined) {
    problems.push({
      row: 1,
      code: 'no_description_column',
      message: 'No description column was recognised. Rename the column to "Description".',
    });
    return { records, problems, unmappedColumns: unmapped, mapping };
  }

  const cell = (row, field) => (mapping[field] === undefined ? '' : row[mapping[field]]);
  const seen = new Map();

  rows.forEach((row, index) => {
    // +2: spreadsheets are 1-based and row 1 is the header, so this is the
    // number the person will see in Excel when they go to fix it.
    const rowNumber = index + 2;
    if (!Array.isArray(row) || row.every((c) => String(c ?? '').trim() === '')) return; // blank row

    const description = String(cell(row, 'canonicalDescription') ?? '').trim();
    if (!description) {
      problems.push({ row: rowNumber, code: 'missing_description', message: 'Row has no description; skipped.' });
      return;
    }

    const normalized = normalizeDescription(description);
    const previous = seen.get(normalized);
    if (previous) {
      problems.push({
        row: rowNumber,
        code: 'duplicate_material',
        message: `Same material as row ${previous} ("${description}").`,
      });
      return;
    }
    seen.set(normalized, rowNumber);

    const vendorPart = String(cell(row, 'vendorPartNumber') ?? '').trim();
    const preferredVendor = String(cell(row, 'preferredVendor') ?? '').trim();

    records.push({
      materialId: String(cell(row, 'materialId') ?? '').trim() || null,
      canonicalDescription: description,
      normalizedDescription: normalized,
      aliases: parseAliases(cell(row, 'aliases')),
      category: String(cell(row, 'category') ?? '').trim() || null,
      subcategory: String(cell(row, 'subcategory') ?? '').trim() || null,
      size: String(cell(row, 'size') ?? '').trim() || null,
      unit: normalizeUnit(cell(row, 'unit')),
      manufacturer: String(cell(row, 'manufacturer') ?? '').trim() || null,
      manufacturerPartNumber: String(cell(row, 'manufacturerPartNumber') ?? '').trim() || null,
      // Keyed by vendor NAME at import time. Resolving a name to a vendor id is
      // a lookup against this organization's vendor directory, and it belongs
      // to the import use case, which can report "no vendor called that"
      // instead of inventing one here.
      vendorPartNumbers: vendorPart && preferredVendor ? { [preferredVendor]: vendorPart } : null,
      preferredVendorName: preferredVendor || null,
      active: parseActive(cell(row, 'active')),
      lastUnitCostCents: parseMoneyCents(cell(row, 'lastUnitCost')),
      timesRequested: parseCount(cell(row, 'purchaseFrequency')),
      sourceRow: rowNumber,
      source: opts.source ?? 'import',
    });
  });

  return { records, problems, unmappedColumns: unmapped, mapping };
}

/**
 * Parse delimited text into a table. RFC-4180 quoting: doubled quotes inside a
 * quoted field, newlines allowed inside quotes.
 *
 * Here rather than in a route because a hand-rolled CSV split on "," is the
 * classic way a description containing a comma silently shifts every column
 * after it — which produces a plausible-looking catalogue that is wrong.
 */
export function parseDelimited(text = '', delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
