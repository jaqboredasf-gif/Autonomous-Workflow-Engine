'use client';

import { REQUEST_STATUSES } from '@/lib/types';
import type { Job, Requestor, Vendor } from '@/lib/types';

export interface Filters {
  status: string;
  jobId: string;
  vendorId: string;
  requestorId: string;
}

export const EMPTY_FILTERS: Filters = { status: '', jobId: '', vendorId: '', requestorId: '' };

const selectClass =
  'w-full rounded-md border border-neutral-300 bg-white px-2.5 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none';

export default function FilterBar({
  filters,
  onChange,
  jobs,
  vendors,
  requestors,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  jobs: Job[];
  vendors: Vendor[];
  requestors: Requestor[];
}) {
  const active = Object.values(filters).some(Boolean);

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs font-medium text-neutral-600">
          Status
          <select
            className={`mt-1 ${selectClass}`}
            value={filters.status}
            onChange={(e) => onChange({ ...filters, status: e.target.value })}
          >
            <option value="">All statuses</option>
            {REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-medium text-neutral-600">
          Job number
          <select
            className={`mt-1 ${selectClass}`}
            value={filters.jobId}
            onChange={(e) => onChange({ ...filters, jobId: e.target.value })}
          >
            <option value="">All jobs</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.number} — {j.name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-medium text-neutral-600">
          Vendor
          <select
            className={`mt-1 ${selectClass}`}
            value={filters.vendorId}
            onChange={(e) => onChange({ ...filters, vendorId: e.target.value })}
          >
            <option value="">All vendors</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-medium text-neutral-600">
          Requestor
          <select
            className={`mt-1 ${selectClass}`}
            value={filters.requestorId}
            onChange={(e) => onChange({ ...filters, requestorId: e.target.value })}
          >
            <option value="">All requestors</option>
            {requestors.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {active && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="mt-3 text-xs font-medium text-neutral-600 underline underline-offset-2 hover:text-neutral-900"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
