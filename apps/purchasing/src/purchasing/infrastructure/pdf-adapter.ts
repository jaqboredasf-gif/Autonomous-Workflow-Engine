/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// pdf.ts — the purchase order PDF, written by hand.
//
// WHY NO LIBRARY: this file has to run on a workshop PC with no npm install,
// no network and no native build step, and it has to produce the SAME bytes for
// the same purchase order every time (the document is hashed and stored with
// the request as evidence). A ~200-line writer over the two base-14 fonts every
// PDF reader already has does that; a dependency does not.
//
// TEMPLATE ADAPTER: `renderPoPdf` lays out the "lippolis_default" template. The
// layout is data — LAYOUT below — so mapping the real Lippolis PO form later is
// an edit to one object plus (optionally) a background page, not a rewrite.
// Spec §6: "the existing Lippolis PO format or a clearly isolated template
// adapter that can later be mapped to the final template".
// ---------------------------------------------------------------------------

import { formatMoney, formatQty } from '../domain/numbers.mjs';

const PAGE = { width: 612, height: 792, margin: 54 }; // US Letter, 0.75in margin

type Op = { text: string; x: number; y: number; size: number; bold: boolean };

class Page {
  ops: Op[] = [];
  lines: Array<{ x1: number; y1: number; x2: number; y2: number; width: number }> = [];

  text(text: string, x: number, y: number, { size = 10, bold = false } = {}) {
    this.ops.push({ text: String(text ?? ''), x, y, size, bold });
  }

  right(text: string, xRight: number, y: number, { size = 10, bold = false } = {}) {
    this.text(text, xRight - textWidth(String(text ?? ''), size, bold), y, { size, bold });
  }

  rule(x1: number, y: number, x2: number, width = 0.75) {
    this.lines.push({ x1, y1: y, x2, y2: y, width });
  }

  stream(): string {
    const parts: string[] = [];
    for (const l of this.lines) {
      parts.push(`${l.width} w ${fmt(l.x1)} ${fmt(l.y1)} m ${fmt(l.x2)} ${fmt(l.y2)} l S`);
    }
    for (const op of this.ops) {
      parts.push(
        `BT /${op.bold ? 'F2' : 'F1'} ${op.size} Tf ${fmt(op.x)} ${fmt(op.y)} Td (${escapeText(op.text)}) Tj ET`,
      );
    }
    return parts.join('\n');
  }
}

/** Helvetica advance widths are close enough to 0.5em for right-alignment. */
function textWidth(text: string, size: number, bold: boolean): number {
  const factor = bold ? 0.55 : 0.5;
  return text.length * size * factor;
}

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // The base-14 fonts are single-byte; anything outside Latin-1 becomes '?'
    // rather than a corrupt glyph in a document a vendor has to read.
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

function buildPdf(pages: Page[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // object numbers are 1-based
  };

  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const pagesObjNumber = objects.length + 1 + pages.length * 2;
  const pageObjNumbers: number[] = [];
  for (const page of pages) {
    const stream = page.stream();
    const contentNum = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageObjNumbers.push(
      add(
        `<< /Type /Page /Parent ${pagesObjNumber} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
          `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentNum} 0 R >>`,
      ),
    );
  }
  const pagesNum = add(
    `<< /Type /Pages /Kids [${pageObjNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  const catalogNum = add(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, idx) => {
    offsets[idx] = Buffer.byteLength(out, 'latin1');
    out += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}

/** Column geometry for the item table. Edit here to match the printed form. */
const LAYOUT = {
  templateKey: 'lippolis_default',
  columns: {
    line: PAGE.margin,
    description: PAGE.margin + 34,
    qty: PAGE.margin + 330,
    unit: PAGE.margin + 375,
    unitCost: PAGE.margin + 440,
    lineTotal: PAGE.width - PAGE.margin,
  },
  rowHeight: 16,
  footerNote:
    'Confirm price and delivery date on receipt of this order. Reference the PO number on all packing slips and invoices.',
};

export function renderPoPdf(view: any): Buffer {
  const page = new Page();
  const right = PAGE.width - PAGE.margin;
  let y = PAGE.height - PAGE.margin;

  // --- header
  page.text(view.org.name, PAGE.margin, y, { size: 18, bold: true });
  page.right('PURCHASE ORDER', right, y, { size: 16, bold: true });
  y -= 16;
  if (view.org.address) page.text(view.org.address, PAGE.margin, y, { size: 9 });
  page.right(`PO ${view.purchaseOrder.poNumber}`, right, y, { size: 12, bold: true });
  y -= 12;
  if (view.org.phone) page.text(view.org.phone, PAGE.margin, y, { size: 9 });
  page.right(`Issued ${String(view.purchaseOrder.generatedAt).slice(0, 10)}`, right, y, { size: 9 });
  y -= 14;
  page.rule(PAGE.margin, y, right, 1.2);
  y -= 22;

  // --- vendor / ship-to, side by side
  const colRight = PAGE.margin + 280;
  const topY = y;
  page.text('VENDOR', PAGE.margin, y, { size: 9, bold: true });
  page.text(view.request.deliveryMethod === 'PICKUP' ? 'PICK UP FROM' : 'DELIVER TO', colRight, y, { size: 9, bold: true });
  y -= 14;
  const vendorLines = [
    view.vendor.name,
    view.vendorContact?.name ? `Attn: ${view.vendorContact.name}` : null,
    view.vendorContact?.email ?? null,
    view.vendor.phone ?? null,
    view.vendor.address ?? null,
    view.vendor.accountNumber ? `Account ${view.vendor.accountNumber}` : null,
  ].filter(Boolean);
  const shipLines = [
    view.request.deliveryLocationName,
    view.request.deliveryAddress || null,
    `Needed by ${view.request.needByDate} at ${view.request.needByTime}`,
    `Requested by ${view.request.requestorName}`,
  ].filter(Boolean);

  let vy = y;
  for (const l of vendorLines) { page.text(l as string, PAGE.margin, vy, { size: 10 }); vy -= 13; }
  let sy = y;
  for (const l of shipLines) { page.text(l as string, colRight, sy, { size: 10 }); sy -= 13; }
  y = Math.min(vy, sy) - 8;

  // --- job block
  page.rule(PAGE.margin, y, right, 0.6);
  y -= 16;
  page.text(`Job number: ${view.request.jobNumber}`, PAGE.margin, y, { size: 11, bold: true });
  page.text(`Request ${view.request.requestNumber}`, colRight, y, { size: 10 });
  y -= 14;
  page.text(`Approved by: ${view.approver.name}`, PAGE.margin, y, { size: 10 });
  y -= 18;

  // --- item table
  const C = LAYOUT.columns;
  page.rule(PAGE.margin, y + 10, right, 0.6);
  page.text('#', C.line, y, { size: 9, bold: true });
  page.text('DESCRIPTION', C.description, y, { size: 9, bold: true });
  page.right('QTY', C.qty, y, { size: 9, bold: true });
  page.text('UNIT', C.unit, y, { size: 9, bold: true });
  page.right('UNIT COST', C.unitCost, y, { size: 9, bold: true });
  page.right('LINE TOTAL', C.lineTotal, y, { size: 9, bold: true });
  y -= 6;
  page.rule(PAGE.margin, y, right, 0.6);
  y -= LAYOUT.rowHeight;

  const pages = [page];
  let current = page;
  for (const item of view.items) {
    if (y < PAGE.margin + 90) {
      current = new Page();
      pages.push(current);
      y = PAGE.height - PAGE.margin;
      current.text(`${view.org.name} — PO ${view.purchaseOrder.poNumber} (continued)`, PAGE.margin, y, { size: 10, bold: true });
      y -= 24;
    }
    current.text(String(item.lineNo), C.line, y, { size: 10 });
    current.text(truncate(item.description, 52), C.description, y, { size: 10 });
    current.right(formatQty(item.finalOrderQty), C.qty, y, { size: 10 });
    current.text(item.unit, C.unit, y, { size: 10 });
    current.right(formatMoney(item.estimatedUnitCostCents), C.unitCost, y, { size: 10 });
    current.right(formatMoney(item.lineTotalCents), C.lineTotal, y, { size: 10 });
    y -= LAYOUT.rowHeight;
    if (item.vendorPartNumber) {
      current.text(`vendor part: ${truncate(item.vendorPartNumber, 60)}`, C.description, y, { size: 8 });
      y -= 12;
    }
    if (item.substituteFor) {
      current.text(`substitute for: ${truncate(item.substituteFor, 60)}`, C.description, y, { size: 8 });
      y -= 12;
    }
    if (item.expectedArrivalDate) {
      current.text(`expected ${item.expectedArrivalDate}`, C.description, y, { size: 8 });
      y -= 12;
    }
  }

  // --- totals
  y -= 4;
  current.rule(C.unitCost - 60, y + 10, right, 0.6);
  current.right('ESTIMATED TOTAL', C.unitCost, y, { size: 11, bold: true });
  current.right(formatMoney(view.purchaseOrder.estimatedTotalCents), C.lineTotal, y, { size: 11, bold: true });
  y -= 26;

  if (view.purchaseOrder.notes) {
    current.text('Notes', PAGE.margin, y, { size: 9, bold: true });
    y -= 13;
    for (const line of wrap(String(view.purchaseOrder.notes), 95)) {
      current.text(line, PAGE.margin, y, { size: 9 });
      y -= 12;
    }
    y -= 6;
  }

  current.rule(PAGE.margin, PAGE.margin + 34, right, 0.6);
  current.text(LAYOUT.footerNote, PAGE.margin, PAGE.margin + 20, { size: 8 });
  current.right(`${view.purchaseOrder.poNumber} · page ${pages.length}`, right, PAGE.margin + 20, { size: 8 });

  return buildPdf(pages);
}

function truncate(text: string, max: number): string {
  const s = String(text ?? '');
  // Plain '...' rather than an ellipsis glyph: the base-14 fonts are Latin-1,
  // and a vendor should never receive a '?' where a word was cut.
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

function wrap(text: string, width: number): string[] {
  const words = String(text).split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

export const PO_TEMPLATE_KEY = LAYOUT.templateKey;
