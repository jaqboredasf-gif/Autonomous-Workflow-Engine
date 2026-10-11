/* eslint-disable @typescript-eslint/no-explicit-any */
// Screen 04 — the purchasing queue. Mike's and Rick's front door.
//
// The route keeps its path: sign-in lands approvers here and the website
// acceptance tests pin that. What changed is the surface — the queue is now
// URL-driven, so a filtered view is a link somebody can send.
import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import * as S from '../../server/service.ts';
import { hasPermission } from '../../purchasing/domain/roles.mjs';
import { summarize } from '../../purchasing/domain/dashboard.mjs';
import { formatMoney } from '../../purchasing/domain/numbers.mjs';
import { ButtonLink, ButtonRow, KpiCard, PageHeader } from '../../components/pcc';
import { PurchasingQueue, type QueueSearchParams } from '../../components/pcc/PurchasingQueue';
import { pageTitle } from '../../purchasing/organization/identity.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: pageTitle('Purchasing queue') };

export default async function WorkshopPage({
  searchParams,
}: {
  searchParams: Promise<QueueSearchParams>;
}) {
  const actor = await requireAccess('/workshop');
  const params = await searchParams;
  const ctx = await purchasingRequestContext();
  const requests = await S.listRequests(ctx, actor);
  const now = new Date().toISOString();
  const cards = summarize(requests, now);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Purchasing queue"
        description={
          actor.isPrimaryApprover
            ? 'You are the primary approver.'
            : actor.isBackupApprover
              ? 'You are the authorized backup approver.'
              : 'You hold approval authority by grant.'
        }
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
        <KpiCard
          label="To review"
          value={cards.pending_workshop_review}
          tone={cards.pending_workshop_review ? 'attention' : 'neutral'}
          href="/workshop?stage=NEEDS_REVIEW"
        />
        <KpiCard
          label="Clarification"
          value={cards.clarification_requested}
          tone={cards.clarification_requested ? 'warn' : 'neutral'}
          href="/workshop?stage=WAITING_ON_REQUESTOR"
        />
        <KpiCard label="Ready to order" value={cards.approved_no_po + cards.po_not_ordered} href="/workshop?stage=READY_TO_ORDER" />
        <KpiCard label="Open orders" value={cards.open_orders} tone="info" href="/workshop?stage=AWAITING_DELIVERY" />
        <KpiCard
          label="Overdue"
          value={cards.overdue_orders}
          tone={cards.overdue_orders ? 'bad' : 'neutral'}
          href="/workshop?overdue=1"
        />
        <KpiCard label="Open value" value={formatMoney(cards.open_order_value_cents)} />
      </div>

      <PurchasingQueue
        requests={requests}
        now={now}
        params={params}
        basePath="/workshop"
        canReceive={hasPermission(actor, 'receiving.record')}
      />
    </div>
  );
}
