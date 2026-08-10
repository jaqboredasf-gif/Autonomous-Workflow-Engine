'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// The receiving line control. MOBILE-FIRST: this is operated one-handed, in a
// yard, on a phone.
//
// It shows the four numbers a person needs — ordered, already received,
// receiving now, remaining — and it does the arithmetic live, because "how
// many are still coming?" is the question receiving exists to answer and
// nobody should be doing it in their head over a pallet.
//
// The exception vocabulary (missing / damaged / incorrect / backordered) maps
// onto the quantities the domain already records. It adds no field and no new
// write path:
//
//   OK           → receivedQty
//   Damaged      → receivedQty with damagedQty as a subset (it arrived, part is unusable)
//   Backordered  → backorderedQty                (the vendor still owes it)
//   Missing      → writtenOffQty                 (short-shipped, not coming)
//   Incorrect    → writtenOffQty + a required note naming what turned up
//
// Every input is always rendered, including the ones the chosen condition
// hides, because recordReceiptAction reads the fields as positional arrays and
// a conditionally-absent input would silently shift every later line's values.
import { useState } from 'react';

import { formatQty } from '../../purchasing/domain/numbers.mjs';
import { Badge } from './Badge';

export type Condition = 'OK' | 'DAMAGED' | 'BACKORDERED' | 'MISSING' | 'INCORRECT';

const CONDITIONS: Array<{ key: Condition; label: string; help: string }> = [
  { key: 'OK', label: 'Arrived', help: 'Everything entered below arrived in good order.' },
  { key: 'DAMAGED', label: 'Damaged', help: 'It arrived but cannot be used. Enter how many are damaged.' },
  { key: 'BACKORDERED', label: 'Backordered', help: 'The vendor still owes it and has given a date.' },
  { key: 'MISSING', label: 'Missing', help: 'Short-shipped and not coming. This closes the line short.' },
  { key: 'INCORRECT', label: 'Wrong item', help: 'Something else turned up. Say what, in the note.' },
];

const qtyClass =
  'h-12 w-full rounded-md border border-line-strong bg-surface px-3 text-center text-lg font-semibold tabular-nums text-ink ' +
  'focus:border-action focus:outline-none focus:ring-1 focus:ring-action';

export function ReceivingItem({ line, index }: { line: any; index: number }) {
  const ordered = Number(line.finalOrderQty ?? 0);
  const previously = Number(line.receivedQty ?? 0);
  const outstanding = Number(line.outstandingQty ?? 0);

  const [condition, setCondition] = useState<Condition>('OK');
  const [receiving, setReceiving] = useState('');
  const [damaged, setDamaged] = useState('');
  const [backordered, setBackordered] = useState('');
  const [writtenOff, setWrittenOff] = useState('');
  const [note, setNote] = useState('');

  // Damaged is "of which damaged": it is already inside receiving and must
  // not reduce Remaining a second time.
  const entered =
    num(receiving) + (condition === 'MISSING' || condition === 'INCORRECT' ? num(writtenOff) : 0);
  const remaining = Math.max(0, outstanding - entered);
  const overReceiving = num(receiving) > outstanding && outstanding > 0;
  const noteRequired = condition === 'INCORRECT' && !note.trim();

  const chosen = CONDITIONS.find((c) => c.key === condition)!;

  return (
    <li className="rounded-lg border border-line bg-surface p-4 shadow-card">
      {/* Positional fields the server action reads with getAll(). Always present. */}
      <input type="hidden" name="receiptPoItemId" value={line.purchaseOrderItemId} />

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-base font-semibold text-ink">{line.description}</p>
          <p className="mt-0.5 text-xs text-muted">
            Line {index + 1}
            {line.catalogNumber ? ` · part ${line.catalogNumber}` : ''}
          </p>
        </div>
        {outstanding === 0 ? <Badge tone="good">Fully received</Badge> : null}
      </div>

      {/* The four numbers. Text labels, not colour alone. */}
      <dl className="mt-3 grid grid-cols-4 gap-2 rounded-md bg-subtle p-2 text-center">
        <Figure label="Ordered" value={`${formatQty(ordered)}`} unit={line.unit} />
        <Figure label="Already in" value={`${formatQty(previously)}`} unit={line.unit} />
        <Figure label="Entering" value={`${formatQty(entered)}`} unit={line.unit} tone="action" />
        <Figure label="Remaining" value={`${formatQty(remaining)}`} unit={line.unit} tone={remaining > 0 ? 'warn' : 'good'} />
      </dl>

      <div className="mt-4">
        <label className="mb-1 block text-xs font-semibold text-ink-soft" htmlFor={`condition-${line.purchaseOrderItemId}`}>
          Condition
        </label>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Condition of this line">
          {CONDITIONS.map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={condition === c.key}
              onClick={() => setCondition(c.key)}
              className={`h-11 rounded-md border px-3 text-sm font-medium transition ${
                condition === c.key
                  ? 'border-action bg-action text-white'
                  : 'border-line-strong bg-surface text-ink-soft hover:bg-subtle'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">{chosen.help}</p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-ink-soft">
            Receiving now ({line.unit})
          </span>
          <input
            name="receiptReceivedQty"
            inputMode="decimal"
            value={receiving}
            onChange={(e) => setReceiving(e.target.value)}
            placeholder="0"
            className={qtyClass}
          />
        </label>

        <label className={condition === 'DAMAGED' ? 'block' : 'hidden'}>
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Of the received quantity, damaged</span>
          <input
            name="receiptDamagedQty"
            inputMode="decimal"
            value={damaged}
            onChange={(e) => setDamaged(e.target.value)}
            placeholder="0"
            className={qtyClass}
          />
        </label>
        {condition !== 'DAMAGED' ? <input type="hidden" name="receiptDamagedQty" value="" /> : null}

        <label className={condition === 'BACKORDERED' ? 'block' : 'hidden'}>
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Backordered</span>
          <input
            name="receiptBackorderedQty"
            inputMode="decimal"
            value={backordered}
            onChange={(e) => setBackordered(e.target.value)}
            placeholder="0"
            className={qtyClass}
          />
        </label>
        {condition !== 'BACKORDERED' ? <input type="hidden" name="receiptBackorderedQty" value="" /> : null}

        <label className={condition === 'MISSING' || condition === 'INCORRECT' ? 'block' : 'hidden'}>
          <span className="mb-1 block text-xs font-semibold text-ink-soft">
            {condition === 'INCORRECT' ? 'Wrong item quantity' : 'Not coming'}
          </span>
          <input
            name="receiptWrittenOffQty"
            inputMode="decimal"
            value={writtenOff}
            onChange={(e) => setWrittenOff(e.target.value)}
            placeholder="0"
            className={qtyClass}
          />
        </label>
        {condition !== 'MISSING' && condition !== 'INCORRECT' ? (
          <input type="hidden" name="receiptWrittenOffQty" value="" />
        ) : null}
      </div>

      {/* Accepting more than was ordered is allowed, but it needs a reason on
          the record — the server refuses it otherwise. */}
      <div className={overReceiving ? 'mt-3 block' : 'hidden'}>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-danger">
            More than outstanding — say why this is being accepted
          </span>
          <input name="receiptOverrideReason" className={`${qtyClass} text-left text-base font-normal`} />
        </label>
      </div>
      {!overReceiving ? <input type="hidden" name="receiptOverrideReason" value="" /> : null}

      <label className="mt-3 block">
        <span className="mb-1 block text-xs font-semibold text-ink-soft">
          Note{condition === 'INCORRECT' ? ' (required — what actually arrived?)' : ''}
        </span>
        <input
          name="receiptLineNotes"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-invalid={noteRequired || undefined}
          className={`h-11 w-full rounded-md border bg-surface px-3 text-base text-ink focus:outline-none focus:ring-1 ${
            noteRequired ? 'border-danger focus:border-danger focus:ring-danger' : 'border-line-strong focus:border-action focus:ring-action'
          }`}
        />
      </label>
      {noteRequired ? (
        <p role="alert" className="mt-1 text-xs font-medium text-danger">
          Say what turned up instead, so purchasing can chase the vendor.
        </p>
      ) : null}
    </li>
  );
}

function Figure({
  label,
  value,
  unit,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: 'neutral' | 'action' | 'warn' | 'good';
}) {
  const colour = {
    neutral: 'text-ink',
    action: 'text-action',
    warn: 'text-warning',
    good: 'text-success',
  }[tone];
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`text-lg font-bold tabular-nums ${colour}`}>
        {value}
        {unit ? <span className="ml-0.5 text-xs font-medium text-muted">{unit}</span> : null}
      </dd>
    </div>
  );
}

function num(value: string) {
  const n = Number(String(value).trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}
