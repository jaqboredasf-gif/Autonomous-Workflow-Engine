'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// The searchable, filterable request table (§8). Filtering is the pure
// applyFilters() from domain/dashboard.mjs, so the columns the table shows and
// the rules it filters by are the same ones the harness asserts.
import { useMemo, useState } from 'react';
import Link from 'next/link';

import { applyFilters, isOverdue, lifecycleBoard } from '../purchasing/domain/dashboard.mjs';
import { REQUEST_STATUSES, statusLabel } from '../purchasing/domain/status.mjs';
import { formatMoney, formatQty } from '../purchasing/domain/numbers.mjs';
import { StatusBadge, inputClass } from './ui';

// English labels for the lifecycle stages. The stage keys carry `labelKey` for
// translation; these are the fallbacks, same pattern as statusLabel().
const STAGE_LABELS: Record<string, string> = {
  NEEDS_REVIEW: 'Needs review',
  WAITING_ON_REQUESTOR: 'Waiting on requester',
  READY_TO_ORDER: 'Ready to order',
  AWAITING_DELIVERY: 'Awaiting delivery',
  PARTIALLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received',
  DRAFTS: 'Drafts',
  CLOSED: 'Closed',
};

const STAGE_TONES: Record<string, string> = {
  attention: 'border-amber-300 bg-amber-50 text-amber-900',
  warn: 'border-orange-300 bg-orange-50 text-orange-900',
  good: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  neutral: 'border-slate-300 bg-white text-slate-700',
};

export default function RequestTable({ requests, now }: { requests: any[]; now: string }) {
  const [filters, setFilters] = useState<Record<string, string | boolean>>({ status: 'ALL' });
  const [stage, setStage] = useState<string>('ALL');
  const set = (key: string, value: string | boolean) => setFilters((f) => ({ ...f, [key]: value }));

  const board = useMemo(() => lifecycleBoard(requests), [requests]);

  // The stage tab narrows first, then the detailed filters apply to what is
  // left. Picking a stage clears any conflicting single-status filter, so the
  // two controls cannot silently produce an empty table together.
  const rows = useMemo(() => {
    const stageStatuses = stage === 'ALL'
      ? null
      : (board.find((b: any) => b.key === stage)?.statuses ?? []);
    const scoped = stageStatuses ? requests.filter((r) => stageStatuses.includes(r.status)) : requests;
    const effective = stageStatuses ? { ...filters, status: 'ALL' } : filters;
    return applyFilters(scoped, effective, now);
  }, [requests, filters, stage, board, now]);

  const requestors = uniqueBy(requests, 'requestorId', 'requestorName');
  const vendors = uniqueBy(requests, 'vendorId', 'vendorName');
  const approvers = uniqueBy(requests, 'approverId', 'approverName');

  return (
    <div className="space-y-3">
      {/* The lifecycle board. Every stage is shown even when empty: "nothing is
          waiting to be ordered" is information, and a tab that disappears
          teaches people the pile does not exist. */}
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Lifecycle stage">
        <button
          type="button"
          role="tab"
          aria-selected={stage === 'ALL'}
          onClick={() => setStage('ALL')}
          className={`shrink-0 rounded-lg border px-3 py-2 text-left text-xs ${
            stage === 'ALL' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700'
          }`}
        >
          <span className="block font-medium">Everything</span>
          <span className="block text-base font-semibold tabular-nums">{requests.length}</span>
        </button>
        {board.map((b: any) => (
          <button
            key={b.key}
            type="button"
            role="tab"
            aria-selected={stage === b.key}
            onClick={() => setStage(b.key)}
            className={`shrink-0 rounded-lg border px-3 py-2 text-left text-xs ${
              stage === b.key ? 'border-slate-900 bg-slate-900 text-white' : STAGE_TONES[b.tone] ?? STAGE_TONES.neutral
            }`}
          >
            <span className="block font-medium">
              {STAGE_LABELS[b.key] ?? b.key}
              {b.actionable && b.count > 0 && stage !== b.key && (
                <span aria-label="needs attention" className="ml-1 text-rose-600">•</span>
              )}
            </span>
            <span className="block text-base font-semibold tabular-nums">{b.count}</span>
          </button>
        ))}
      </div>

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
