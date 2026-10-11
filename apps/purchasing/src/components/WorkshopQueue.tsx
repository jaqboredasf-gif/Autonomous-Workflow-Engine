'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// The workshop's working surface: tabs by what has to happen next, search, job
// and vendor filters, need-by sorting and overdue highlighting. Built for a
// desktop or a shop tablet, and still usable on a phone (the table scrolls in
// its own container; nothing overflows the page).
//
// Filtering is the pure applyFilters() from the domain, so the list a person
// sees and the rules the tests assert are the same code.
import { useMemo, useState } from 'react';
import Link from 'next/link';

import { applyFilters, isOverdue } from '../purchasing/domain/dashboard.mjs';
import { formatMoney, formatQty } from '../purchasing/domain/numbers.mjs';
import { StatusBadge, inputClass } from './ui';

const TABS = [
  { key: 'REVIEW', label: 'To review', statuses: ['PENDING_WORKSHOP_REVIEW', 'RESUBMITTED'], next: 'Review and decide' },
  { key: 'CLARIFY', label: 'Waiting on the field', statuses: ['CLARIFICATION_REQUESTED'], next: 'Awaiting an answer' },
  { key: 'PO', label: 'Needs a PO', statuses: ['APPROVED'], next: 'Generate the purchase order' },
  { key: 'EMAIL', label: 'Needs sending', statuses: ['PO_GENERATED', 'EMAIL_DRAFTED'], next: 'Review the vendor email' },
  { key: 'OPEN', label: 'Open orders', statuses: ['ORDERED', 'PARTIALLY_RECEIVED'], next: 'Receive what arrives' },
  { key: 'DONE', label: 'Received', statuses: ['RECEIVED'], next: 'Complete the request' },
  { key: 'ALL', label: 'Everything active', statuses: null, next: '' },
];

export default function WorkshopQueue({ requests, now }: { requests: any[]; now: string }) {
  const [tab, setTab] = useState('REVIEW');
  const [filters, setFilters] = useState<Record<string, string | boolean>>({});
  const set = (key: string, value: string | boolean) => setFilters((f) => ({ ...f, [key]: value }));

  const active = TABS.find((t) => t.key === tab)!;

  const rows = useMemo(() => {
    const filtered = applyFilters(requests, filters, now).filter((r: any) =>
      active.statuses
        ? active.statuses.includes(r.status)
        : !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(r.status),
    );
    // Need-by first: the workshop works to a date, not to an inbox order.
    return [...filtered].sort((a: any, b: any) =>
      `${a.needByDate}${a.needByTime}`.localeCompare(`${b.needByDate}${b.needByTime}`),
    );
  }, [requests, filters, now, active]);

  const countFor = (t: (typeof TABS)[number]) =>
    requests.filter((r: any) =>
      t.statuses ? t.statuses.includes(r.status) : !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(r.status),
    ).length;

  const vendors = [...new Set(requests.map((r: any) => r.vendorName).filter(Boolean))].sort();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Workshop queue">
        {TABS.map((t) => {
          const count = countFor(t);
          const selected = t.key === tab;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(t.key)}
              className={`rounded-full px-3 py-2 text-sm font-medium transition ${
                selected ? 'bg-slate-900 text-white' : 'border border-slate-300 bg-white text-slate-700 hover:border-slate-500'
              }`}
            >
              {t.label}
              <span className={`ml-2 tabular-nums ${selected ? 'text-white/70' : 'text-slate-500'}`}>{count}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <input
          className={inputClass}
          placeholder="Search request, PO, job, tracking…"
          value={String(filters.search ?? '')}
          onChange={(e) => set('search', e.target.value)}
          aria-label="Search"
        />
        <input
          className={inputClass}
          placeholder="Job number"
          value={String(filters.jobNumber ?? '')}
          onChange={(e) => set('jobNumber', e.target.value)}
          aria-label="Filter by job number"
        />
        <select
          className={inputClass}
          value={String(filters.vendorName ?? '')}
          onChange={(e) => set('search', e.target.value)}
          aria-label="Filter by vendor"
        >
          <option value="">All vendors</option>
          {vendors.map((v) => (
            <option key={v as string} value={v as string}>
              {v as string}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={Boolean(filters.overdueOnly)}
            onChange={(e) => set('overdueOnly', e.target.checked)}
          />
          Overdue only
        </label>
      </div>

      {active.next ? <p className="text-xs uppercase tracking-wide text-slate-500">Next action: {active.next}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Request</th>
              <th className="px-3 py-2">Job</th>
              <th className="px-3 py-2">Requestor</th>
              <th className="px-3 py-2">Need by</th>
              <th className="px-3 py-2 text-right">Req</th>
              <th className="px-3 py-2 text-right">Order</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2 text-right">Estimated</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">PO</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r: any) => {
              const late = isOverdue(r, now);
              return (
                <tr key={r.id} className={late ? 'bg-rose-50/60' : undefined}>
                  <td className="px-3 py-2 font-medium">
                    <Link href={`/requests/${r.id}`} className="text-slate-900 underline-offset-2 hover:underline">
                      {r.requestNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{r.jobNumber}</td>
                  <td className="px-3 py-2">{r.requestorName}</td>
                  <td className={`whitespace-nowrap px-3 py-2 ${late ? 'font-medium text-rose-700' : ''}`}>
                    {r.needByDate} {r.needByTime}
                    {late ? ' · overdue' : ''}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQty(r.requestedQty ?? 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQty(r.finalOrderQty ?? 0)}</td>
                  <td className="px-3 py-2">{r.vendorName ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(r.estimatedTotalCents)}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 tabular-nums">{r.poNumber ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={nextActionHref(r)}
                      className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white"
                    >
                      {nextActionLabel(r)}
                    </Link>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-sm text-slate-500">
                  Nothing here.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function nextActionHref(r: any) {
  if (['PENDING_WORKSHOP_REVIEW', 'RESUBMITTED'].includes(r.status)) return `/requests/${r.id}/review`;
  if (r.status === 'PO_GENERATED' || r.status === 'EMAIL_DRAFTED') return `/requests/${r.id}/email`;
  if (['ORDERED', 'PARTIALLY_RECEIVED'].includes(r.status)) return `/requests/${r.id}/receive`;
  return `/requests/${r.id}`;
}

function nextActionLabel(r: any) {
  if (['PENDING_WORKSHOP_REVIEW', 'RESUBMITTED'].includes(r.status)) return 'Review';
  if (r.status === 'APPROVED') return 'Generate PO';
  if (r.status === 'PO_GENERATED' || r.status === 'EMAIL_DRAFTED') return 'Email';
  if (['ORDERED', 'PARTIALLY_RECEIVED'].includes(r.status)) return 'Receive';
  if (r.status === 'RECEIVED') return 'Complete';
  return 'Open';
}
