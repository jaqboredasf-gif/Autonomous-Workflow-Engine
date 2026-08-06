/* eslint-disable @typescript-eslint/no-explicit-any */
// The workshop workspace — Mike's and Rick's front door.
import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import * as S from '../../server/service.ts';
import WorkshopQueue from '../../components/WorkshopQueue';
import { Card } from '../../components/ui';
import { summarize } from '../../purchasing/domain/dashboard.mjs';
import { formatMoney } from '../../purchasing/domain/numbers.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Workshop queue — Lippolis Purchasing' };

export default async function WorkshopPage() {
  const actor = await requireAccess('/workshop');
  const ctx = purchasingRequestContext();
  const requests = S.listRequests(ctx, actor);
  const now = new Date().toISOString();
  const cards = summarize(requests, now);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Workshop queue</h1>
        <p className="mt-1 text-sm text-slate-600">
          {actor.isPrimaryApprover
            ? 'You are the primary approver.'
            : actor.isBackupApprover
              ? 'You are the authorized backup approver.'
              : 'You hold approval authority by grant.'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card title="To review" value={cards.pending_workshop_review} tone="attention" />
        <Card title="Clarification" value={cards.clarification_requested} tone="warn" />
        <Card title="Needs a PO" value={cards.approved_no_po} />
        <Card title="Open orders" value={cards.open_orders} />
        <Card title="Overdue" value={cards.overdue_orders} tone="bad" />
        <Card title="Open value" value={formatMoney(cards.open_order_value_cents)} />
      </div>

      <WorkshopQueue requests={requests} now={now} />
    </div>
  );
}
