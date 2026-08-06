/* eslint-disable @typescript-eslint/no-explicit-any */
// The landing page: the purchasing dashboard for anyone who can see all
// requests, and "my requests" for a foreman on a phone.
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { currentActor, purchasingRequestContext } from '../server/session.ts';
import * as S from '../server/service.ts';
import { hasPermission } from '../purchasing/domain/roles.mjs';
import { summarize, isOverdue } from '../purchasing/domain/dashboard.mjs';
import { formatMoney } from '../purchasing/domain/numbers.mjs';
import { Card, Empty, Section, StatusBadge } from '../components/ui';
import RequestTable from '../components/RequestTable';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const actor = await currentActor();
  if (!actor) redirect('/signin');

  const ctx = purchasingRequestContext();
  const requests = S.listRequests(ctx, actor);
  const now = new Date().toISOString();

  if (!hasPermission(actor, 'request.read.all')) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-900">My requests</h1>
          <Link href="/requests/new" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white">
            New request
          </Link>
        </div>
        {requests.length === 0 ? (
          <Empty>Nothing yet. Raise a request and it goes straight to the workshop queue.</Empty>
        ) : (
          <ul className="space-y-2">
            {requests.map((r: any) => (
              <li key={r.id}>
                <Link
                  href={`/requests/${r.id}`}
                  className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:border-slate-400"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-900">{r.requestNumber}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="mt-1 text-xs text-slate-600">
                    Job {r.jobNumber} · needed {r.needByDate} at {r.needByTime}
                    {isOverdue(r, now) ? <span className="ml-2 font-medium text-rose-700">overdue</span> : null}
                  </div>
                  {r.poNumber ? <div className="mt-1 text-xs text-slate-500">PO {r.poNumber}</div> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const cards = summarize(requests, now);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-900">Purchasing dashboard</h1>
        <div className="flex gap-2">
          <Link href="/requests/new" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white">
            New request
          </Link>
          {hasPermission(actor, 'review.read_queue') ? (
            <Link href="/queue" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium">
              Workshop queue
            </Link>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Card title="Pending review" value={cards.pending_workshop_review} tone="attention" href="/queue" />
        <Card title="Clarification" value={cards.clarification_requested} tone="warn" href="/requests?status=CLARIFICATION_REQUESTED" />
        <Card title="Approved, no PO" value={cards.approved_no_po} href="/requests?status=APPROVED" />
        <Card title="PO not ordered" value={cards.po_not_ordered} href="/requests?status=PO_GENERATED" />
        <Card title="Open orders" value={cards.open_orders} href="/requests?status=ORDERED" />
        <Card title="Overdue" value={cards.overdue_orders} tone="bad" href="/requests?overdueOnly=1" />
        <Card title="Partially received" value={cards.partially_received} href="/requests?status=PARTIALLY_RECEIVED" />
        <Card title="Received this month" value={cards.received_this_month} tone="good" />
        <Card
          title="Open order value"
          value={formatMoney(cards.open_order_value_cents)}
          hint="estimated, on open orders"
        />
      </div>

      <Section title="Requests" subtitle="Filter, search and open any request.">
        <RequestTable requests={requests} now={now} />
      </Section>
    </div>
  );
}
