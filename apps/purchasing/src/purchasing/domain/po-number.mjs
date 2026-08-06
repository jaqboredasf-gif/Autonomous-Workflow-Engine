// ---------------------------------------------------------------------------
// po-number.mjs — purchase order number FORMATTING only.
//
// The number itself is ALLOCATED by the database, never here: the pilot store
// allocates inside a SQLite IMMEDIATE transaction (src/server/po-sequence.ts)
// and the Supabase path uses next_po_number() with a row lock
// (0016_purchasing_control.sql). A frontend counter cannot be made safe under
// two people pressing Approve at the same second, so there isn't one.
//
// This module turns an allocated integer into the string a vendor sees, and
// knows how to read one back. PURE.
// ---------------------------------------------------------------------------

/** Defaults; overridable per org from system_settings (Admin -> PO Config). */
export const DEFAULT_PO_CONFIG = {
  prefix: 'LE-',
  nextNumber: 52901,
  padding: 5,
  suffix: '',
};

/** Format an allocated sequence value into the permanent PO number. */
export function formatPoNumber(sequenceValue, config = {}) {
  const cfg = { ...DEFAULT_PO_CONFIG, ...config };
  const n = Number(sequenceValue);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid PO sequence value: ${sequenceValue}`);
  return `${cfg.prefix}${String(n).padStart(cfg.padding, '0')}${cfg.suffix}`;
}

/** Recover the sequence value from a formatted number (audit / import). */
export function parsePoNumber(poNumber, config = {}) {
  const cfg = { ...DEFAULT_PO_CONFIG, ...config };
  const text = String(poNumber ?? '');
  if (!text.startsWith(cfg.prefix) || !text.endsWith(cfg.suffix)) return null;
  const digits = text.slice(cfg.prefix.length, text.length - (cfg.suffix.length || 0));
  if (!/^\d+$/.test(digits)) return null;
  return Number(digits);
}

export function validatePoConfig(config = {}) {
  const errors = [];
  const padding = Number(config.padding);
  if (!Number.isInteger(padding) || padding < 1 || padding > 12) {
    errors.push({ field: 'padding', message: 'Padding must be between 1 and 12 digits.' });
  }
  const next = Number(config.nextNumber);
  if (!Number.isInteger(next) || next < 1) {
    errors.push({ field: 'nextNumber', message: 'Next number must be a positive whole number.' });
  }
  if (String(config.prefix ?? '').length > 12) {
    errors.push({ field: 'prefix', message: 'Prefix must be 12 characters or fewer.' });
  }
  return { ok: errors.length === 0, errors };
}
