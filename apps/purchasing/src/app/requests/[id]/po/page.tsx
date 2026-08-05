'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { formatDate, formatMoney } from '@/lib/format';
import { usePurchasing } from '@/lib/store-context';

/** Blank rows so the printed sheet keeps the proportions of the paper form. */
const MIN_ROWS = 12;

export default function PoPreview() {
  const params = useParams<{ id: string }>();
  const { requestById, jobById, vendorById, requestorById, generatePo, hydrated } =
    usePurchasing();

  // Today's date is read after mount — computing it during render would bake
  // the prerender date into the markup and mismatch on hydration.
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => setToday(new Date().toISOString()), []);

  const request = requestById(params.id);

  if (!request) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-neutral-900">
          {hydrated ? 'Request not found' : 'Loading…'}
        </h1>
      </main>
    );
  }

  const job = jobById(request.jobId);
  const vendor = vendorById(request.vendorId);
  const requestor = requestorById(request.requestorId);
  const blanks = Math.max(0, MIN_ROWS - request.lines.length);

  // The PO carries the date its number was issued; unissued POs show today.
  const issuedAt = request.history.find((h) => h.action === 'PO generated')?.at ?? today;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/requests/${request.id}`}
          className="text-sm font-medium text-neutral-600 hover:text-neutral-900"
        >
          ← Back to request
        </Link>
        <div className="flex flex-wrap gap-2">
          {!request.poNumber && (
            <button
              type="button"
              onClick={() => generatePo(request.id)}
              className="rounded-md bg-blue-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-800"
            >
              Generate PO number
            </button>
          )}
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-md border border-neutral-300 bg-white px-3.5 py-2 text-sm font-semibold text-neutral-800 hover:bg-neutral-50"
          >
            Print
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-md border border-neutral-300 bg-white px-3.5 py-2 text-sm font-semibold text-neutral-800 hover:bg-neutral-50"
          >
            Save as PDF
          </button>
        </div>
      </div>

      {!request.poNumber && (
        <p className="no-print mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          No PO number assigned yet. Generate one to fill in the form — numbers are handed out
          in sequence and never reused.
        </p>
      )}
      <p className="no-print mt-4 text-xs text-neutral-500">
        Save as PDF opens the same browser print dialog — choose &ldquo;Save as PDF&rdquo; as the
        destination. Nothing is uploaded.
      </p>

      {/* ---------- The printable sheet ---------- */}
      <article className="print-sheet mx-auto mt-4 max-w-3xl border border-neutral-300 bg-white p-8 text-neutral-900 shadow-sm">
        <header className="flex items-start justify-between border-b-2 border-neutral-900 pb-3">
          <div>
            <h1 className="text-2xl font-black uppercase tracking-tight">Lippolis Electric</h1>
            <p className="mt-0.5 text-xs text-neutral-600">
              Electrical Contractor · Company address placeholder · (555) 000-0000
            </p>
          </div>
          <div className="text-right">
            <h2 className="text-lg font-bold uppercase tracking-widest">Purchase Order</h2>
            <table className="mt-2 ml-auto text-sm">
              <tbody>
                <tr>
                  <td className="pr-3 text-right font-semibold uppercase text-neutral-600">P.O. No.</td>
                  <td className="border-b border-neutral-400 px-2 font-mono font-bold">
                    {request.poNumber ?? '—'}
                  </td>
                </tr>
                <tr>
                  <td className="pr-3 pt-1 text-right font-semibold uppercase text-neutral-600">Date</td>
                  <td className="border-b border-neutral-400 px-2 pt-1">
                    {formatDate(issuedAt)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </header>

        <section className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div className="border border-neutral-300 p-3">
            <p className="text-xs font-bold uppercase tracking-wide text-neutral-500">Vendor</p>
            <p className="mt-1 font-semibold">{vendor?.name ?? '—'}</p>
            <p className="text-neutral-700">{vendor?.contact.branch ?? ''}</p>
            <p className="text-neutral-700">
              Attn: {vendor?.contact.name ?? '—'} · {vendor?.contact.phone ?? ''}
            </p>
          </div>
          <div className="border border-neutral-300 p-3">
            <p className="text-xs font-bold uppercase tracking-wide text-neutral-500">Job</p>
            <p className="mt-1 font-semibold">
              {job?.number ?? '—'} — {job?.name ?? '—'}
            </p>
            <p className="text-neutral-700">{job?.address ?? '—'}</p>
            <p className="text-neutral-700">
              Needed by: {formatDate(request.neededBy)} · Priority: {request.priority}
            </p>
          </div>
        </section>

        <table className="mt-4 w-full border-collapse text-sm">
          <thead>
            <tr className="bg-neutral-100">
              <th className="w-20 border border-neutral-400 px-2 py-1 text-left text-xs font-bold uppercase">
                Quantity
              </th>
              <th className="w-32 border border-neutral-400 px-2 py-1 text-left text-xs font-bold uppercase">
                Stock No.
              </th>
              <th className="border border-neutral-400 px-2 py-1 text-left text-xs font-bold uppercase">
                Description
              </th>
            </tr>
          </thead>
          <tbody>
            {request.lines.map((l) => (
              <tr key={l.id}>
                <td className="border border-neutral-400 px-2 py-1 tabular-nums">
                  {l.quantity} {l.unit}
                </td>
                <td className="border border-neutral-400 px-2 py-1 font-mono text-xs">
                  {l.stockNumber || ''}
                </td>
                <td className="border border-neutral-400 px-2 py-1">{l.description}</td>
              </tr>
            ))}
            {Array.from({ length: blanks }).map((_, i) => (
              <tr key={`blank-${i}`}>
                <td className="border border-neutral-400 px-2 py-1">&nbsp;</td>
                <td className="border border-neutral-400 px-2 py-1">&nbsp;</td>
                <td className="border border-neutral-400 px-2 py-1">&nbsp;</td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="mt-4 grid grid-cols-3 gap-4 text-sm">
          <div className="col-span-2 border border-neutral-300 p-3">
            <p className="text-xs font-bold uppercase tracking-wide text-neutral-500">Notes</p>
            <p className="mt-1 min-h-12 whitespace-pre-wrap">{request.notes || '—'}</p>
          </div>
          <div className="border border-neutral-300 p-3">
            <p className="text-xs font-bold uppercase tracking-wide text-neutral-500">
              Estimated total
            </p>
            <p className="mt-1 text-lg font-bold tabular-nums">
              {formatMoney(request.estimatedCost)}
            </p>
            <p className="text-xs text-neutral-500">
              Requestor estimate. Tax, freight, and final pricing not included.
            </p>
          </div>
        </section>

        <section className="mt-8 grid grid-cols-2 gap-8 text-sm">
          <div>
            <div className="h-8 border-b border-neutral-500" />
            <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-neutral-600">
              Authorized by
            </p>
          </div>
          <div>
            <div className="h-8 border-b border-neutral-500" />
            <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-neutral-600">
              Date
            </p>
          </div>
        </section>

        <footer className="mt-6 border-t border-neutral-300 pt-2 text-center text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
          Demo prototype — not a valid purchase order. Requested by{' '}
          {requestor?.name ?? 'unknown'} · Request {request.id}
        </footer>
      </article>
    </main>
  );
}
