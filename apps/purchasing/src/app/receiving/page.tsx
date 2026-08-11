/* eslint-disable @typescript-eslint/no-explicit-any */
// Screen 06's index — everything this person may receive against.
//
// Cards, not a table: this is opened on a phone at least as often as at a
// desk, and a nine-column table squeezed onto 390px is not information, it is
// a shape. Each card carries the identity a receiver checks (PO, job, vendor)
// and what is still owed.
import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import { describeLocations } from '../../purchasing/domain/navigation.mjs';
import { receivableForActor } from '../../purchasing/application/queries.ts';
import { formatQty } from '../../purchasing/domain/numbers.mjs';
import { isOverdue } from '../../purchasing/domain/dashboard.mjs';
import { Badge, ButtonLink, EmptyState, PageHeader, Panel, StatusBadge } from '../../components/pcc';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Receiving — Lippolis Purchasing' };

export default async function ReceivingPage() {
  const actor = await requireAccess('/receiving');
  const ctx = await purchasingRequestContext();
  const orders = await receivableForActor(ctx, actor);
  const now = new Date().toISOString();

  // Resolve every order's progress BEFORE rendering: a React tree cannot await
  // inside a map, and one round trip per row is the shape to avoid once the
  // provider is remote.
  const progressByRequest = new Map(
    await Promise.all(orders.map(async (r: any) => [r.id, await ctx.orders.progressFor(r.id)] as const)),
  );

  const partial = orders.filter((r: any) => r.status === 'PARTIALLY_RECEIVED');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Receiving"
        description={
          actor.assignedJobNumbers.length
            ? `You sign for: ${describeLocations(actor.assignedJobNumbers)}`
            : 'Orders on their way in. Open one when the truck arrives.'
        }
        meta={partial.length ? <Badge tone="warn">{partial.length} partly received</Badge> : null}
      />

      {orders.length === 0 ? (
        <Panel title="Nothing on its way" bodyClassName="">
          <EmptyState
            title="No open orders to receive"
            description="Orders appear here once purchasing marks them placed with the vendor."
          />
        </Panel>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {orders.map((r: any) => {
            const progress = progressByRequest.get(r.id) ?? [];
            const outstanding = progress.filter((p: any) => Number(p.outstandingQty ?? 0) > 0);
            const late = isOverdue(r, now);
            return (
              <li key={r.id} className="rounded-lg border border-line bg-surface p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-ink">{r.poNumber ?? r.requestNumber}</p>
                    <p className="text-sm text-muted">
                      Job {r.jobNumber}
                      {r.vendorName ? ` · ${r.vendorName}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={r.status} />
                    {late ? <Badge tone="bad">Overdue</Badge> : null}
                  </div>
                </div>

                <ul className="mt-3 space-y-0.5 text-sm text-ink-soft">
                  {outstanding.slice(0, 3).map((p: any) => (
                    <li key={p.purchaseOrderItemId}>
                      <span className="font-medium tabular-nums text-ink">{formatQty(p.outstandingQty)}</span> {p.unit}{' '}
                      — {p.description}
                    </li>
                  ))}
                  {outstanding.length > 3 ? (
                    <li className="text-muted">+{outstanding.length - 3} more lines outstanding</li>
                  ) : null}
                  {outstanding.length === 0 ? <li className="text-muted">Nothing outstanding.</li> : null}
                </ul>

                <div className="mt-4">
                  <ButtonLink href={`/requests/${r.id}/receive`} size="l" className="w-full sm:w-auto">
                    Confirm what arrived
                  </ButtonLink>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
