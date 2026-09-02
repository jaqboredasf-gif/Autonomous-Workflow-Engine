// CSV bulk-entry for baseline POs — pure, offline, no I/O.
//
// Typing 15 purchase orders as 15 JSON files is the friction that stops a
// baseline from ever being captured. A spreadsheet is the right tool for that
// bulk step, so this module exists — but ONLY documentary fields are importable
// this way. Testimony, estimates and observations never come through a
// spreadsheet, because a spreadsheet has no place to say how a number is known,
// and a column of numbers with no confidence class is exactly how estimates get
// laundered into facts.
//
// A blank cell becomes {"value": null, "confidence": "unknown"}. It never
// becomes zero, and it never becomes a guess.

import { typeSpec } from './spec.mjs';

export function csvColumns() {
  const s = typeSpec('baseline_po');
  return [
    'po_number',
    ...s.fields.filter((d) => d.csv && d.key !== 'po_number').map((d) => d.key),
    'source_identifier', 'physical_location', 'photographed', 'photo_ref', 'notes',
  ];
}

/** RFC4180-ish parser: quoted cells, doubled quotes, CRLF, blank-line skipping. */
export function parseCSV(text) {
  const rows = [];
  let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Map parsed CSV rows to baseline_po records.
 * @returns {{ records: object[], problems: string[] }}
 */
export function rowsToRecords(rows, { baselineId, capturedBy, capturedAt }) {
  const problems = [];
  const records = [];
  if (!rows.length) return { records, problems: ['csv is empty'] };

  const header = rows[0].map((h) => h.trim());
  const defs = new Map(typeSpec('baseline_po').fields.map((d) => [d.key, d]));

  for (let i = 1; i < rows.length; i++) {
    const r = Object.fromEntries(header.map((h, j) => [h, (rows[i][j] ?? '').trim()]));
    if (!r.po_number) { problems.push(`row ${i + 1}: no po_number — skipped`); continue; }

    const fields = {};
    for (const [key, d] of defs) {
      const raw = r[key] ?? '';
      if (raw === '') { fields[key] = { value: null, confidence: 'unknown' }; continue; }
      let v = raw;
      if (d.kind === 'integer') v = Number.parseInt(raw, 10);
      else if (d.kind === 'number') v = Number.parseFloat(raw.replace(/[$,\s]/g, ''));
      if ((d.kind === 'integer' || d.kind === 'number') && !Number.isFinite(v)) {
        problems.push(`row ${i + 1} ${key}: "${raw}" is not a number — imported as unknown, NOT as zero`);
        fields[key] = { value: null, confidence: 'unknown' };
        continue;
      }
      fields[key] = { value: v, confidence: 'documentary' };
    }

    records.push({
      record_id: `po-${String(r.po_number).replace(/[^a-z0-9._-]/gi, '-')}`,
      record_type: 'baseline_po',
      record_class: 'production',
      baseline_id: baselineId,
      captured_by: capturedBy,
      captured_at: capturedAt,
      awe_involved: false,
      source_document: {
        kind: 'paper_purchase_order',
        identifier: r.source_identifier || `PO ${r.po_number}`,
        physical_location: r.physical_location || null,
        photographed: /^(y|yes|true|1)$/i.test(r.photographed || ''),
        photo_ref: r.photo_ref || null,
      },
      fields,
      notes: r.notes || '',
    });
  }
  return { records, problems };
}
