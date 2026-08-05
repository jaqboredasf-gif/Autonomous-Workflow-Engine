'use client';

import Link from 'next/link';
import StatusBadge from './StatusBadge';
import { formatDate, formatMoney } from '@/lib/format';
import type { Job, PurchaseRequest, Requestor, Vendor } from '@/lib/types';

const TH = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500';
const TD = 'px-3 py-3 text-sm text-neutral-800';

export default function RequestTable({
  requests,
  jobs,
  vendors,
  requestors,
}: {
  requests: PurchaseRequest[];
  jobs: Job[];
  vendors: Vendor[];
  requestors: Requestor[];
}) {
  if (requests.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center">
        <p className="text-sm font-medium text-neutral-700">No requests match these filters.</p>
        <p className="mt-1 text-sm text-neutral-500">Clear a filter, or create a new request.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="w-full min-w-[64rem] border-collapse">
        <thead className="border-b border-neutral-200 bg-neutral-50">
          <tr>
            <th className={TH}>Request</th>
            <th className={TH}>PO number</th>
            <th className={TH}>Requestor</th>
            <th className={TH}>Job no.</th>
            <th className={TH}>Job name</th>
            <th className={TH}>Vendor</th>
            <th className={`${TH} text-right`}>Est. cost</th>
            <th className={TH}>Status</th>
            <th className={TH}>Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {requests.map((r) => {
            const job = jobs.find((j) => j.id === r.jobId);
            const vendor = vendors.find((v) => v.id === r.vendorId);
            const requestor = requestors.find((p) => p.id === r.requestorId);
            return (
              <tr key={r.id} className="hover:bg-neutral-50">
                <td className={`${TD} whitespace-nowrap`}>
                  <Link
                    href={`/requests/${r.id}`}
                    className="font-semibold text-blue-700 hover:underline"
                  >
                    {r.id}
                  </Link>
                </td>
                <td className={`${TD} whitespace-nowrap font-mono text-xs`}>
                  {r.poNumber ?? '—'}
                </td>
                <td className={TD}>{requestor?.name ?? '—'}</td>
                <td className={`${TD} font-medium`}>{job?.number ?? '—'}</td>
                <td className={TD}>{job?.name ?? '—'}</td>
                <td className={TD}>{vendor?.name ?? '—'}</td>
                <td className={`${TD} text-right tabular-nums`}>{formatMoney(r.estimatedCost)}</td>
                <td className={TD}>
                  <StatusBadge status={r.status} />
                </td>
                <td className={`${TD} whitespace-nowrap text-neutral-600`}>
                  {formatDate(r.createdAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
