'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import FilterBar, { EMPTY_FILTERS, type Filters } from '@/components/FilterBar';
import RequestTable from '@/components/RequestTable';
import { formatMoney } from '@/lib/format';
import { usePurchasing } from '@/lib/store-context';

export default function Dashboard() {
  const { state } = usePurchasing();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  const visible = useMemo(() => {
    return state.requests
      .filter((r) => !filters.status || r.status === filters.status)
      .filter((r) => !filters.jobId || r.jobId === filters.jobId)
      .filter((r) => !filters.vendorId || r.vendorId === filters.vendorId)
      .filter((r) => !filters.requestorId || r.requestorId === filters.requestorId)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [state.requests, filters]);

  const pendingApproval = state.requests.filter((r) => r.status === 'Pending Approval');
  const awaitingPo = state.requests.filter((r) => r.status === 'Approved' && !r.poNumber);
  const openValue = state.requests
    .filter((r) => !['Completed', 'Rejected', 'Canceled'].includes(r.status))
    .reduce((sum, r) => sum + r.estimatedCost, 0);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900">
            Purchasing Dashboard
          </h1>
          <p className="mt-1 text-sm text-neutral-600">
            Material requests, approvals, and purchase orders.
          </p>
        </div>
        <Link
          href="/requests/new"
          className="inline-flex items-center justify-center rounded-md bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New Purchase Request
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total requests" value={String(state.requests.length)} />
        <Stat label="Pending approval" value={String(pendingApproval.length)} accent="amber" />
        <Stat label="Approved, no PO" value={String(awaitingPo.length)} accent="blue" />
        <Stat label="Open estimated value" value={formatMoney(openValue)} />
      </div>

      <div className="mt-6">
        <FilterBar
          filters={filters}
          onChange={setFilters}
          jobs={state.jobs}
          vendors={state.vendors}
          requestors={state.requestors}
        />
      </div>

      <div className="mt-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-700">
          Recent requests
          <span className="ml-2 font-normal text-neutral-500">
            showing {visible.length} of {state.requests.length}
          </span>
        </h2>
      </div>

      <div className="mt-2">
        <RequestTable
          requests={visible}
          jobs={state.jobs}
          vendors={state.vendors}
          requestors={state.requestors}
        />
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'amber' | 'blue';
}) {
  const accentClass =
    accent === 'amber'
      ? 'text-amber-700'
      : accent === 'blue'
        ? 'text-blue-700'
        : 'text-neutral-900';
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${accentClass}`}>{value}</p>
    </div>
  );
}
