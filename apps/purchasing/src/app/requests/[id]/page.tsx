'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import ActionBar from '@/components/ActionBar';
import StatusBadge from '@/components/StatusBadge';
import StatusTimeline from '@/components/StatusTimeline';
import { inputClass } from '@/components/Field';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { explainApproval } from '@/lib/status';
import { usePurchasing } from '@/lib/store-context';

export default function RequestDetail() {
  const params = useParams<{ id: string }>();
  const { state, requestById, jobById, vendorById, requestorById, addNote, hydrated } =
    usePurchasing();
  const [note, setNote] = useState('');

  const request = requestById(params.id);

  if (!request) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-neutral-900">
          {hydrated ? 'Request not found' : 'Loading…'}
        </h1>
        {hydrated && (
          <p className="mt-2 text-sm text-neutral-600">
            No request with ID {params.id}.{' '}
            <Link href="/" className="font-medium text-blue-700 hover:underline">
              Back to the dashboard
            </Link>
          </p>
        )}
      </main>
    );
  }

  const job = jobById(request.jobId);
  const vendor = vendorById(request.vendorId);
  const requestor = requestorById(request.requestorId);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <Link href="/" className="no-print text-sm font-medium text-neutral-600 hover:text-neutral-900">
        ← Back to dashboard
      </Link>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900">{request.id}</h1>
          <StatusBadge status={request.status} />
          {request.poNumber && (
            <span className="rounded bg-neutral-900 px-2 py-1 font-mono text-xs font-semibold text-white">
              {request.poNumber}
            </span>
          )}
        </div>
        <p className="text-sm text-neutral-500">
          Created {formatDateTime(request.createdAt)} · Updated {formatDateTime(request.updatedAt)}
        </p>
      </div>

      <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Status</h2>
        <StatusTimeline status={request.status} />
        <p className="mt-3 text-xs text-neutral-500">
          {explainApproval(request, state.settings)}
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="rounded-lg border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-900">Request information</h2>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Detail label="Requestor" value={`${requestor?.name ?? '—'}${requestor ? ` (${requestor.role})` : ''}`} />
              <Detail label="Priority" value={request.priority} />
              <Detail label="Job number" value={job?.number ?? '—'} />
              <Detail label="Job name" value={job?.name ?? '—'} />
              <Detail label="Job address" value={job?.address ?? '—'} span />
              <Detail label="Vendor" value={vendor?.name ?? '—'} />
              <Detail
                label="Supplier contact"
                value={vendor ? `${vendor.contact.name} · ${vendor.contact.branch}` : '—'}
              />
              <Detail label="Needed by" value={formatDate(request.neededBy)} />
              <Detail label="Estimated cost" value={formatMoney(request.estimatedCost)} />
              <Detail label="Notes" value={request.notes || '—'} span />
            </dl>
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white">
            <h2 className="border-b border-neutral-200 px-4 py-3 text-sm font-semibold text-neutral-900">
              Material items ({request.lines.length})
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] border-collapse text-sm">
                <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-4 py-2 text-left">Qty</th>
                    <th className="px-4 py-2 text-left">Unit</th>
                    <th className="px-4 py-2 text-left">Description</th>
                    <th className="px-4 py-2 text-left">Stock no.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {request.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-4 py-2 tabular-nums">{l.quantity}</td>
                      <td className="px-4 py-2 text-neutral-600">{l.unit}</td>
                      <td className="px-4 py-2">{l.description}</td>
                      <td className="px-4 py-2 font-mono text-xs text-neutral-600">
                        {l.stockNumber || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-900">History</h2>
            <ol className="mt-3 space-y-3">
              {request.history
                .slice()
                .reverse()
                .map((h) => (
                  <li key={h.id} className="flex gap-3 text-sm">
                    <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-neutral-300" />
                    <div>
                      <p className="font-medium text-neutral-900">
                        {h.action}
                        <span className="ml-2 font-normal text-neutral-500">
                          {h.actor} · {formatDateTime(h.at)}
                        </span>
                      </p>
                      {h.detail && <p className="text-neutral-600">{h.detail}</p>}
                    </div>
                  </li>
                ))}
            </ol>

            <div className="no-print mt-4 border-t border-neutral-100 pt-4">
              <label htmlFor="note" className="block text-xs font-semibold uppercase tracking-wide text-neutral-600">
                Add a note
              </label>
              <textarea
                id="note"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className={`mt-1.5 ${inputClass}`}
                placeholder="Anything the next person needs to know."
              />
              <button
                type="button"
                disabled={!note.trim()}
                onClick={() => {
                  addNote(request.id, note);
                  setNote('');
                }}
                className="mt-2 rounded-md border border-neutral-300 px-3.5 py-2 text-sm font-semibold text-neutral-800 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:text-neutral-400"
              >
                Add note
              </button>
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <ActionBar request={request} />

          <section className="no-print rounded-lg border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-900">Documents</h2>
            <div className="mt-3 flex flex-col gap-2">
              <Link
                href={`/requests/${request.id}/po`}
                className="rounded-md border border-neutral-300 px-3.5 py-2 text-center text-sm font-semibold text-neutral-800 hover:bg-neutral-50"
              >
                Purchase order preview
              </Link>
              <Link
                href={`/requests/${request.id}/email`}
                className="rounded-md border border-neutral-300 px-3.5 py-2 text-center text-sm font-semibold text-neutral-800 hover:bg-neutral-50"
              >
                Email draft preview
              </Link>
            </div>
            <p className="mt-3 text-xs text-neutral-500">
              Both are previews. The PO prints from the browser; the email opens in your own
              mail client with nothing sent.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}

function Detail({ label, value, span }: { label: string; value: string; span?: boolean }) {
  return (
    <div className={span ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-neutral-900">{value}</dd>
    </div>
  );
}
