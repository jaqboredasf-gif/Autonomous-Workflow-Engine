/* eslint-disable @typescript-eslint/no-explicit-any */
// The office workspace: every active order, what has arrived against it, and
// what is late. Office staff monitor and record; they do not decide purchasing.
import Link from 'next/link';

import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import * as S from '../../server/service.ts';
import RequestTable from '../../components/RequestTable';
import { Card, Section } from '../../components/ui';
import { summarize } from '../../purchasing/domain/dashboard.mjs';
import { formatMoney } from '../../purchasing/domain/numbers.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Office — Lippolis Purchasing' };

export default async function OfficePage() {
  const actor = await requireAccess('/office');
  const ctx = purchasingRequestContext();
  const requests = S.listRequests(ctx, actor);
  const now = new Date().toISOString();
  const cards = summarize(requests, now);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-900">Office</h1>
        <Link href="/requests/new" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white">
          New request
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Card title="Pending review" value={cards.pending_workshop_review} tone="attention" />
        <Card title="PO not ordered" value={cards.po_not_ordered} />
        <Card title="Open orders" value={cards.open_orders} />
        <Card title="Overdue" value={cards.overdue_orders} tone="bad" />
        <Card title="Partially received" value={cards.partially_received} tone="warn" />
        <Card title="Received this month" value={cards.received_this_month} tone="good" />
        <Card title="Open order value" value={formatMoney(cards.open_order_value_cents)} />
      </div>

      <Section title="All requests" subtitle="Search, filter, and open any request to see its evidence.">
        <RequestTable requests={requests} now={now} />
      </Section>
    </div>
  );
}
