/* eslint-disable @typescript-eslint/no-explicit-any */
// Deliveries — a foreman signing for what turned up on his site, on a phone,
// with gloves on. Only the jobs assigned to him appear here, and the server
// refuses the confirmation for any other job even if the URL is guessed.
import Link from 'next/link';

import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import { deliveriesForActor } from '../../purchasing/application/queries.ts';
import { Empty, StatusBadge } from '../../components/ui';
import { formatQty } from '../../purchasing/domain/numbers.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Deliveries — Lippolis Purchasing' };

export default async function DeliveriesPage() {
  const actor = await requireAccess('/deliveries');
  const ctx = await purchasingRequestContext();
  const deliveries = await deliveriesForActor(ctx, actor);
  // Resolve the per-order progress BEFORE rendering: a React tree cannot await
  // inside a map, and one round trip per row is the shape to avoid once the
  // provider is remote.
  const progressByRequest = new Map(
    await Promise.all(
      deliveries.map(async (r: any) => [r.id, await ctx.orders.progressFor(r.id)] as const),
    ),
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Deliveries</h1>
        <p className="mt-1 text-sm text-slate-600">
          {actor.assignedJobNumbers.length
            ? `Your job sites: ${actor.assignedJobNumbers.join(', ')}`
            : 'You are not assigned to a job site yet. The office can assign you.'}
        </p>
      </div>

      {deliveries.length === 0 ? (
        <Empty>Nothing is on its way to your sites right now.</Empty>
      ) : (
        <ul className="space-y-3">
          {deliveries.map((r: any) => {
            const progress = progressByRequest.get(r.id) ?? [];
            const outstanding = progress.filter((p: any) => p.outstandingQty > 0);
            return (
              <li key={r.id}>
                <Link
                  href={`/requests/${r.id}/receive`}
                  className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm active:border-slate-400"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-base font-medium text-slate-900">
                      Job {r.jobNumber} · {r.poNumber ?? r.requestNumber}
                    </span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="mt-1 text-sm text-slate-600">{r.vendorName ?? 'vendor not recorded'}</div>
                  <ul className="mt-2 space-y-0.5 text-sm text-slate-700">
                    {outstanding.slice(0, 3).map((p: any) => (
                      <li key={p.purchaseOrderItemId}>
                        {formatQty(p.outstandingQty)} {p.unit} — {p.description}
                      </li>
                    ))}
                    {outstanding.length > 3 ? (
                      <li className="text-slate-500">+{outstanding.length - 3} more</li>
                    ) : null}
                  </ul>
                  <span className="mt-3 inline-flex rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white">
                    Confirm what arrived
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
