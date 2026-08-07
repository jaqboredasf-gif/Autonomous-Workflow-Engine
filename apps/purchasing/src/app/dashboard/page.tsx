/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Screen 02 — Dashboard.
//
// The question this screen answers is "what is the state of purchasing, and
// what is waiting on me", in about five seconds. So it leads with four counts,
// then the exceptions (the things that are wrong), then a preview of the queue
// ordered by when the material is needed, then what has just happened.
//
// Nothing here is a new source of truth: the counts come from the domain's
// summarize(), the ordering from the same need-by rule the queue sorts on, and
// the activity from the recorded log rather than from current state.
// ---------------------------------------------------------------------------
import Link from 'next/link';

import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import * as S from '../../server/service.ts';
import { recentPurchasingActivity } from '../../purchasing/application/queries.ts';
import { hasPermission } from '../../purchasing/domain/roles.mjs';
import { summarize, isOverdue } from '../../purchasing/domain/dashboard.mjs';
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
} from '../../components/pcc';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard — Lippolis Purchasing' };

const QUEUE_PREVIEW_LIMIT = 8;

export default async function DashboardPage() {
  const actor = await requireAccess('/dashboard');
  const ctx = await purchasingRequestContext();
  const requests = await S.listRequests(ctx, actor);
  const now = new Date().toISOString();
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Purchasing dashboard"
        description={`${requests.length} purchase requests in view · ${formatMoney(counts.open_order_value_cents)} committed on open orders`}
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

        <Panel title="Recent activity" subtitle="What has happened across purchasing" bodyClassName="">
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
