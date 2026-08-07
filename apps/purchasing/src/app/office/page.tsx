/* eslint-disable @typescript-eslint/no-explicit-any */
// The office workspace: every active order, what has arrived against it, and
// what is late. Office staff monitor and record; they do not decide purchasing.
//
// It shares screen 04's queue rather than owning a second one — the difference
// between the two workspaces is authority, not layout, and the row actions
// already come from what each viewer may do.
import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import * as S from '../../server/service.ts';
import { hasPermission } from '../../purchasing/domain/roles.mjs';
import { summarize } from '../../purchasing/domain/dashboard.mjs';
import { formatMoney } from '../../purchasing/domain/numbers.mjs';
import { ButtonLink, ButtonRow, KpiCard, PageHeader } from '../../components/pcc';
import { PurchasingQueue, type QueueSearchParams } from '../../components/pcc/PurchasingQueue';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Office — Lippolis Purchasing' };

export default async function OfficePage({ searchParams }: { searchParams: Promise<QueueSearchParams> }) {
  const actor = await requireAccess('/office');
  const params = await searchParams;
  const ctx = await purchasingRequestContext();
  const requests = await S.listRequests(ctx, actor);
  const now = new Date().toISOString();
  const cards = summarize(requests, now);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Office"
        description="Every active order, its tracking, and what has arrived against it."
        actions={
          <ButtonRow>
            <ButtonLink href="/dashboard" variant="secondary">
              Dashboard
            </ButtonLink>
            <ButtonLink href="/requests/new">New request</ButtonLink>
          </ButtonRow>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard label="Pending approval" value={cards.pending_workshop_review} tone="attention" href="/office?stage=NEEDS_REVIEW" />
        <KpiCard label="Waiting to order" value={cards.approved_no_po + cards.po_not_ordered} href="/office?stage=READY_TO_ORDER" />
        <KpiCard label="Open orders" value={cards.open_orders} tone="info" href="/office?stage=AWAITING_DELIVERY" />
        <KpiCard label="Overdue" value={cards.overdue_orders} tone={cards.overdue_orders ? 'bad' : 'neutral'} href="/office?overdue=1" />
        <KpiCard label="Partly received" value={cards.partially_received} tone={cards.partially_received ? 'warn' : 'neutral'} href="/office?stage=PARTIALLY_RECEIVED" />
        <KpiCard label="Open value" value={formatMoney(cards.open_order_value_cents)} />
      </div>

      <PurchasingQueue
        requests={requests}
        now={now}
        params={params}
        basePath="/office"
        canReceive={hasPermission(actor, 'receiving.record')}
      />
    </div>
  );
}
