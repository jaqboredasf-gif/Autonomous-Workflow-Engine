/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Screen 02 — Dashboard. The operational command centre.
//
// The question this screen answers is "what is the state of purchasing, and
// what is waiting on me", in about five seconds. Reading order is deliberate:
//
//   1. what can I narrow this to        — search and filters, in the URL
//   2. how much work is in each pile    — four counts
//   3. what is WRONG                    — exceptions, or an explicit all-clear
//   4. what should I touch next         — the queue, soonest need-by first
//   5. where is everything sitting      — purchasing and receiving status
//   6. who and what has been moving     — vendors, recent POs, recent activity
//
// EVERY NUMBER ON THIS PAGE IS DERIVED FROM RECORDS THIS USER MAY SEE. The
// counts come from the domain's summarize(); the panels from purchasingStatus(),
// receivingStatus(), vendorActivity() and recentPurchaseOrders(), which only
// count, sum and sort. There is no trend line, no comparison to last month and
// no sample series anywhere on this screen, because a purchasing dashboard that
// invents one figure cannot be trusted about the rest.
// ---------------------------------------------------------------------------
import Link from 'next/link';

import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import * as S from '../../server/service.ts';
import { recentPurchasingActivity } from '../../purchasing/application/queries.ts';
import { hasPermission } from '../../purchasing/domain/roles.mjs';
import {
  summarize,
  isOverdue,
  applyFilters,
  purchasingStatus,
  receivingStatus,
  vendorActivity,
  recentPurchaseOrders,
} from '../../purchasing/domain/dashboard.mjs';
import { formatMoney } from '../../purchasing/domain/numbers.mjs';
import { describeActivity } from '../../purchasing/domain/activity.mjs';
import {
  ActivityFeed,
  ActivityItem,
  Alert,
  ButtonLink,
  ButtonRow,
  EmptyState,
  KpiCard,
  PageHeader,
  Panel,
  StatusBadge,
  Table,
  TableEmpty,
  TableFrame,
  TBody,
  TD,
  TDLink,
  TH,
  THead,
  TR,
  UrgencyBadge,
  nextActionFor,
  stageLabel,
} from '../../components/pcc';
import { DashboardFilters } from './DashboardFilters';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard — Lippolis Purchasing' };

const QUEUE_PREVIEW_LIMIT = 8;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAccess('/dashboard');
  const ctx = await purchasingRequestContext();
  const all = await S.listRequests(ctx, actor);
  const now = new Date().toISOString();

  // Filters live in the URL, so a view is bookmarkable and sendable — the same
  // arrangement the purchasing queue uses, and the same pure applyFilters() the
  // domain harness pins. Everything below reads the FILTERED list, so the
  // counts always describe what is on screen.
  const params = (await searchParams) ?? {};
  const one = (key: string) => (Array.isArray(params[key]) ? params[key]?.[0] : params[key]) ?? '';
  const filters = {
    search: one('search'),
    jobNumber: one('jobNumber'),
    vendorId: one('vendorId'),
    // The domain's key is `overdueOnly`; the URL's is `overdue`, matching the
    // queue's links. Translating here keeps both stable.
    overdueOnly: one('overdue') === '1',
  };
  const filtered = applyFilters(all, filters, now);
  const isFiltered = Boolean(filters.search || filters.jobNumber || filters.vendorId || filters.overdueOnly);
  const requests = filtered;
  const counts = summarize(requests, now);

  const canRunQueue = hasPermission(actor, 'review.read_queue');
  const canReceive = hasPermission(actor, 'receiving.record');

  // The activity feed is a read this person is allowed but need not have — an
  // accounting user holds request.read.all and gets it; the panel simply does
  // not render if the read is refused, rather than taking the page down.
  let activity: any[] = [];
  try {
    activity = await recentPurchasingActivity(ctx, actor, 10);
  } catch {
    activity = [];
  }

  // The four KPIs the handoff names, expressed in this domain's statuses.
  const pendingApproval = counts.pending_workshop_review;
  const waitingToOrder = counts.approved_no_po + counts.po_not_ordered;
  const ordered = requests.filter((r: any) => r.status === 'ORDERED').length;
  const awaitingReceipt = counts.open_orders;

  // Exceptions: the things that are actually wrong, each with the count and a
  // way in. An empty exceptions block is a good day, and it says so.
  const overdue = requests.filter((r: any) => isOverdue(r, now));
  const partiallyReceived = requests.filter((r: any) => r.status === 'PARTIALLY_RECEIVED');
  const awaitingAnswer = requests.filter((r: any) => r.status === 'CLARIFICATION_REQUESTED');

  // The preview: active work only, soonest need-by first. Drafted and ordered
  // entries are in here on purpose (BR-006) — a transition is not a vanishing.
  const preview = requests
    .filter((r: any) => !['COMPLETED', 'CANCELLED', 'REJECTED', 'DRAFT'].includes(r.status))
    .sort((a: any, b: any) =>
      `${a.needByDate ?? '9999-12-31'}${a.needByTime ?? ''}`.localeCompare(
        `${b.needByDate ?? '9999-12-31'}${b.needByTime ?? ''}`,
      ),
    )
    .slice(0, QUEUE_PREVIEW_LIMIT);

  const queueHref = canRunQueue ? '/workshop' : '/office';

  // The operational panels. Each is a pure reading of `requests` — see the
  // header comment: counting, summing and sorting only.
  const pipeline = purchasingStatus(requests);
  const receiving = receivingStatus(requests, now);
  const vendors = vendorActivity(requests, 5);
  const recentPos = recentPurchaseOrders(requests, 6);

  // Filter options come from the UNFILTERED list, so narrowing to one job does
  // not remove every other job from the picker and strand the user.
  const jobOptions = [...new Set(all.map((r: any) => r.jobNumber).filter(Boolean))]
    .sort()
    .map((j) => ({ value: String(j), label: String(j) }));
  const vendorOptions = [
    ...new Map(
      all.filter((r: any) => r.vendorId && r.vendorName).map((r: any) => [r.vendorId, r.vendorName]),
    ).entries(),
  ]
    .map(([value, label]) => ({ value: String(value), label: String(label) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Purchasing dashboard"
        description={
          isFiltered
            ? `${requests.length} of ${all.length} requests in view · ${formatMoney(counts.open_order_value_cents)} committed on open orders in this view`
            : `${requests.length} purchase requests · ${formatMoney(counts.open_order_value_cents)} committed on open orders`
        }
        actions={
          <ButtonRow>
            <ButtonLink href="/requests/new" variant="primary">
              New request
            </ButtonLink>
            <ButtonLink href={queueHref} variant="secondary">
              Open queue
            </ButtonLink>
            {canReceive ? (
              <ButtonLink href="/receiving" variant="secondary">
                Open receiving
              </ButtonLink>
            ) : null}
          </ButtonRow>
        }
      />

      <DashboardFilters
        values={{
          search: filters.search,
          jobNumber: filters.jobNumber,
          vendorId: filters.vendorId,
          overdue: filters.overdueOnly,
        }}
        jobs={jobOptions}
        vendors={vendorOptions}
      />

      {/* --- KPIs ------------------------------------------------------- */}
      <section aria-label="Purchasing workload" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Pending approval"
          value={pendingApproval}
          tone={pendingApproval > 0 ? 'attention' : 'neutral'}
          hint="Waiting on a purchasing decision"
          href={`${queueHref}?stage=NEEDS_REVIEW`}
        />
        <KpiCard
          label="Waiting to order"
          value={waitingToOrder}
          tone={waitingToOrder > 0 ? 'attention' : 'neutral'}
          hint="Approved, PO generated or email drafted"
          href={`${queueHref}?stage=READY_TO_ORDER`}
        />
        <KpiCard
          label="Ordered"
          value={ordered}
          tone="info"
          hint="Placed with a vendor, nothing received"
          href={`${queueHref}?stage=AWAITING_DELIVERY`}
        />
        <KpiCard
          label="Awaiting receipt"
          value={awaitingReceipt}
          tone={counts.partially_received > 0 ? 'warn' : 'neutral'}
          hint={`${counts.partially_received} partly received`}
          href={`${queueHref}?stage=PARTIALLY_RECEIVED`}
        />
      </section>

      {/* --- Exceptions -------------------------------------------------- */}
      <section aria-label="Exceptions" className="space-y-3">
        {overdue.length ? (
          <Alert
            tone="danger"
            title={`${overdue.length} request${overdue.length === 1 ? ' is' : 's are'} past their need-by date`}
            actions={
              <ButtonLink href={`${queueHref}?overdue=1`} variant="danger">
                Show overdue
              </ButtonLink>
            }
          >
            The material was needed on site and is not in hand yet.
          </Alert>
        ) : null}

        {partiallyReceived.length ? (
          <Alert
            tone="warning"
            title={`${partiallyReceived.length} order${partiallyReceived.length === 1 ? '' : 's'} partly received`}
            actions={
              canReceive ? (
                <ButtonLink href="/receiving" variant="secondary">
                  Finish receiving
                </ButtonLink>
              ) : undefined
            }
          >
            Some lines are still outstanding. These stay open until every line is accounted for.
          </Alert>
        ) : null}

        {awaitingAnswer.length ? (
          <Alert tone="info" title={`${awaitingAnswer.length} waiting on the requester`}>
            The workshop has asked a question and cannot proceed until it is answered.
          </Alert>
        ) : null}

        {!overdue.length && !partiallyReceived.length && !awaitingAnswer.length ? (
          <Alert tone="success" title="No exceptions">
            Nothing is overdue, nothing is part-received, and nobody is waiting on an answer.
          </Alert>
        ) : null}
      </section>

      {/* --- Queue preview + activity ------------------------------------ */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          bodyClassName=""
          title="Queue — soonest first"
          subtitle="Active work, ordered by when the material is needed on site"
          actions={
            <Link href={queueHref} className="text-sm font-medium text-action hover:underline">
              Open the full queue
            </Link>
          }
        >
          <TableFrame className="rounded-none border-0 shadow-none">
            <Table>
              <THead>
                <tr>
                  <TH>Request</TH>
                  <TH>Job</TH>
                  <TH className="hidden md:table-cell">Vendor</TH>
                  <TH>Need by</TH>
                  <TH className="hidden sm:table-cell">Priority</TH>
                  <TH>Status</TH>
                  <TH className="hidden lg:table-cell">Next action</TH>
                </tr>
              </THead>
              <TBody>
                {preview.map((r: any) => {
                  const next = nextActionFor(r);
                  return (
                    <TR key={r.id} highlight={isOverdue(r, now)}>
                      <TDLink href={`/requests/${r.id}`}>{r.poNumber ?? r.requestNumber}</TDLink>
                      <TD>{r.jobNumber}</TD>
                      <TD className="hidden md:table-cell">{r.vendorName ?? '—'}</TD>
                      <TD className="whitespace-nowrap">
                        {r.needByDate ?? '—'}
                        {isOverdue(r, now) ? <span className="ml-1 font-medium text-danger">overdue</span> : null}
                      </TD>
                      <TD className="hidden sm:table-cell">
                        <UrgencyBadge request={r} now={now} />
                      </TD>
                      <TD>
                        <StatusBadge status={r.status} />
                      </TD>
                      <TD className="hidden lg:table-cell text-muted">{next.label}</TD>
                    </TR>
                  );
                })}
                {preview.length === 0 ? (
                  <TableEmpty colSpan={7}>
                    Nothing active. New requests appear here the moment they are submitted.
                  </TableEmpty>
                ) : null}
              </TBody>
            </Table>
          </TableFrame>
        </Panel>

        {/* --- Where everything is sitting ------------------------------- */}
        <div className="space-y-4">
          <Panel
            title="Purchasing status"
            subtitle="Work in flight, by stage"
            bodyClassName="px-4 py-3"
            headingLevel={3}
          >
            <ul className="space-y-2.5">
              {pipeline.map((stage: any) => (
                <li key={stage.key}>
                  <Link
                    href={`${queueHref}?stage=${stage.key}`}
                    className="group block rounded focus-visible:outline-none"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-ink-soft group-hover:text-brand">
                        {stageLabel(stage.key)}
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{stage.count}</span>
                    </div>
                    {/* The bar is the share of in-flight work, not a target and
                        not a trend. An empty stage draws an empty track, which
                        is the honest picture of nothing being there. */}
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle">
                      <div
                        className={stage.actionable ? 'h-full rounded-full bg-brand' : 'h-full rounded-full bg-line-strong'}
                        style={{ width: `${Math.round(stage.share * 100)}%` }}
                      />
                    </div>
                    {stage.valueCents > 0 ? (
                      <p className="mt-0.5 text-xs text-muted">{formatMoney(stage.valueCents)} estimated</p>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Receiving status" subtitle="What is due in" bodyClassName="p-4" headingLevel={3}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted">On its way</dt>
                <dd className="mt-0.5 text-2xl font-bold tabular-nums text-ink">{receiving.awaiting}</dd>
                {receiving.awaitingValueCents > 0 ? (
                  <p className="text-xs text-muted">{formatMoney(receiving.awaitingValueCents)}</p>
                ) : null}
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Part received</dt>
                <dd
                  className={`mt-0.5 text-2xl font-bold tabular-nums ${
                    receiving.partiallyReceived > 0 ? 'text-warning' : 'text-ink'
                  }`}
                >
                  {receiving.partiallyReceived}
                </dd>
                <p className="text-xs text-muted">Lines still outstanding</p>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Late arrivals</dt>
                <dd
                  className={`mt-0.5 text-2xl font-bold tabular-nums ${
                    receiving.overdueArrivals > 0 ? 'text-accent-strong' : 'text-ink'
                  }`}
                >
                  {receiving.overdueArrivals}
                </dd>
                <p className="text-xs text-muted">Ordered, need-by passed</p>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Received this month</dt>
                <dd className="mt-0.5 text-2xl font-bold tabular-nums text-ink">{receiving.receivedThisMonth}</dd>
                <p className="text-xs text-muted">{receiving.awaitingCompletion} ready to close</p>
              </div>
            </dl>
            {canReceive ? (
              <div className="mt-3 border-t border-line pt-3">
                <Link href="/receiving" className="text-sm font-medium text-brand hover:underline">
                  Open receiving
                </Link>
              </div>
            ) : null}
          </Panel>
        </div>
      </div>

      {/* --- Secondary: who we buy from, what went out, what happened ---- */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title="Vendor activity" subtitle="Busiest first, by open orders" bodyClassName="" headingLevel={3}>
          {vendors.length === 0 ? (
            <EmptyState
              title="No vendor on any request yet"
              description="A vendor is chosen during purchasing review; this fills in from there."
            />
          ) : (
            <ul className="divide-y divide-line">
              {vendors.map((v: any) => (
                <li key={v.vendorId ?? v.vendorName} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{v.vendorName ?? 'Unnamed vendor'}</p>
                    <p className="text-xs text-muted">
                      {v.requests} request{v.requests === 1 ? '' : 's'}
                      {v.lastOrderedAt ? ` · last ordered ${String(v.lastOrderedAt).slice(0, 10)}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold tabular-nums text-ink">{v.openOrders} open</p>
                    {v.openValueCents > 0 ? (
                      <p className="text-xs tabular-nums text-muted">{formatMoney(v.openValueCents)}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recent purchase orders" subtitle="Most recently placed" bodyClassName="" headingLevel={3}>
          {recentPos.length === 0 ? (
            <EmptyState
              title="No orders placed yet"
              description="A purchase order appears here once it has been sent to a vendor."
            />
          ) : (
            <ul className="divide-y divide-line">
              {recentPos.map((po: any) => (
                <li key={po.id} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <Link href={`/requests/${po.id}`} className="truncate text-sm font-semibold text-brand hover:underline">
                      {po.poNumber}
                    </Link>
                    <StatusBadge status={po.status} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {po.vendorName ?? 'No vendor'} · job {po.jobNumber}
                    {po.orderedAt ? ` · ${String(po.orderedAt).slice(0, 10)}` : ''}
                    {po.valueCents > 0 ? ` · ${formatMoney(po.valueCents)}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recent activity" subtitle="What has happened across purchasing" bodyClassName="" headingLevel={3}>
          {activity.length === 0 ? (
            <EmptyState title="Nothing recorded yet" description="Approvals, orders and receipts show up here." />
          ) : (
            <ActivityFeed>
              {activity.map((entry: any) => (
                <ActivityItem
                  key={entry.id}
                  description={describeActivity({ ...entry, details: entry.newValues ?? {} })}
                  at={entry.at}
                  href={entry.requestId ? `/requests/${entry.requestId}` : null}
                />
              ))}
            </ActivityFeed>
          )}
        </Panel>
      </div>
    </div>
  );
}
