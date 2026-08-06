'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// The searchable, filterable request table (§8). Filtering is the pure
// applyFilters() from domain/dashboard.mjs, so the columns the table shows and
// the rules it filters by are the same ones the harness asserts.
import { useMemo, useState } from 'react';
import Link from 'next/link';

import { applyFilters, isOverdue } from '../domain/dashboard.mjs';
import { REQUEST_STATUSES, statusLabel } from '../domain/status.mjs';
import { formatMoney, formatQty } from '../domain/numbers.mjs';
import { StatusBadge, inputClass } from './ui';

export default function RequestTable({ requests, now }: { requests: any[]; now: string }) {
  const [filters, setFilters] = useState<Record<string, string | boolean>>({ status: 'ALL' });
  const set = (key: string, value: string | boolean) => setFilters((f) => ({ ...f, [key]: value }));

  const rows = useMemo(() => applyFilters(requests, filters, now), [requests, filters, now]);

  const requestors = uniqueBy(requests, 'requestorId', 'requestorName');
  const vendors = uniqueBy(requests, 'vendorId', 'vendorName');
  const approvers = uniqueBy(requests, 'approverId', 'approverName');

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <input
          className={inputClass}
          placeholder="Search request, PO, job, tracking…"
          value={String(filters.search ?? '')}
          onChange={(e) => set('search', e.target.value)}
        />
        <select className={inputClass} value={String(filters.status)} onChange={(e) => set('status', e.target.value)}>
          <option value="ALL">All statuses</option>
          {REQUEST_STATUSES.map((s: string) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        <select className={inputClass} value={String(filters.requestorId ?? '')} onChange={(e) => set('requestorId', e.target.value)}>
          <option value="">All requestors</option>
          {requestors.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select className={inputClass} value={String(filters.vendorId ?? '')} onChange={(e) => set('vendorId', e.target.value)}>
          <option value="">All vendors</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <select className={inputClass} value={String(filters.approverId ?? '')} onChange={(e) => set('approverId', e.target.value)}>
          <option value="">All approvers</option>
          {approvers.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <input
          className={inputClass}
          placeholder="Job number"
          value={String(filters.jobNumber ?? '')}
          onChange={(e) => set('jobNumber', e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <span className="whitespace-nowrap">Need-by from</span>
          <input type="date" className={inputClass} value={String(filters.needByFrom ?? '')} onChange={(e) => set('needByFrom', e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={Boolean(filters.overdueOnly)} onChange={(e) => set('overdueOnly', e.target.checked)} />
          Overdue only
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-3">Request</th>
              <th className="py-2 pr-3">PO</th>
              <th className="py-2 pr-3">Job</th>
              <th className="py-2 pr-3">Requestor</th>
              <th className="py-2 pr-3">Need by</th>
              <th className="py-2 pr-3 text-right">Req</th>
              <th className="py-2 pr-3 text-right">Stock</th>
              <th className="py-2 pr-3 text-right">Order</th>
              <th className="py-2 pr-3">Vendor</th>
              <th className="py-2 pr-3 text-right">Estimated</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3">Approver</th>
              <th className="py-2 pr-3">Expected</th>
              <th className="py-2 pr-3">Tracking</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r: any) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="py-2 pr-3 font-medium">
                  <Link href={`/requests/${r.id}`} className="text-slate-900 underline-offset-2 hover:underline">
                    {r.requestNumber}
                  </Link>
                </td>
                <td className="py-2 pr-3 tabular-nums">{r.poNumber ?? '—'}</td>
                <td className="py-2 pr-3">{r.jobNumber}</td>
                <td className="py-2 pr-3">{r.requestorName}</td>
                <td className={`py-2 pr-3 whitespace-nowrap ${isOverdue(r, now) ? 'font-medium text-rose-700' : ''}`}>
                  {r.needByDate} {r.needByTime}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatQty(r.requestedQty)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatQty(r.workshopStockQty)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatQty(r.finalOrderQty)}</td>
                <td className="py-2 pr-3">{r.vendorName ?? '—'}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(r.estimatedTotalCents)}</td>
                <td className="py-2 pr-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="py-2 pr-3">{r.approverName ?? '—'}</td>
                <td className="py-2 pr-3">{r.expectedArrivalDate ?? '—'}</td>
                <td className="py-2 pr-3">{r.trackingNumber ?? '—'}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={14} className="py-6 text-center text-sm text-slate-500">
                  No requests match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        {rows.length} of {requests.length} requests
      </p>
    </div>
  );
}

function uniqueBy(rows: any[], idKey: string, nameKey: string) {
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r[idKey]) map.set(r[idKey], r[nameKey] ?? r[idKey]);
  }
  return [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
