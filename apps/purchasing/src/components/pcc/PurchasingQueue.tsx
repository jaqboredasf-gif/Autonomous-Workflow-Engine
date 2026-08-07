/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Screen 04 — the purchasing queue.
//
// The most operationally important desktop surface, and the one BR-006 is
// about: a request that becomes Email Drafted or Ordered has NOT left the
// queue. It has moved to a different pile. Every stage is a tab, every tab is
// always present, and "Everything active" spans all of them — so no status
// change can make work disappear at the moment somebody should be chasing it.
//
// A server component. Filtering happens here, through the domain's own
// applyFilters(), so the browser is never handed rows the caller may not see
// and the rules the harness asserts are the rules the screen uses.
// ---------------------------------------------------------------------------
import { applyFilters, isOverdue, lifecycleBoard } from '../../purchasing/domain/dashboard.mjs';
import { REQUEST_STATUSES } from '../../purchasing/domain/status.mjs';
import { formatMoney, formatQty } from '../../purchasing/domain/numbers.mjs';
import { ButtonLink } from './Button';
import { StatusBadge, UrgencyBadge } from './Badge';
import { QueueFilters } from './QueueFilters';
import { Tabs, type TabItem } from './Tabs';
import {
  Table,
  TableCount,
  TableEmpty,
  TableFrame,
  TBody,
  TD,
  TDLink,
  TH,
  THead,
  TR,
} from './Table';
import { displayStatus, nextActionFor, urgencyOf, URGENCY_LABELS, type Urgency } from './status-display';

const STAGE_LABELS: Record<string, string> = {
  NEEDS_REVIEW: 'Needs approval',
  WAITING_ON_REQUESTOR: 'Waiting on requester',
  READY_TO_ORDER: 'Ready to order',
  AWAITING_DELIVERY: 'Ordered',
  PARTIALLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received',
  DRAFTS: 'Drafts',
  CLOSED: 'Closed',
};

export type QueueSearchParams = {
  stage?: string;
  search?: string;
  status?: string;
  jobNumber?: string;
  vendorId?: string;
  requestorId?: string;
  priority?: string;
  needByFrom?: string;
  needByTo?: string;
  overdue?: string;
};

/** Age in whole days since the request was raised. */
function ageDays(createdAt: string | null | undefined, now: string): number | null {
  if (!createdAt) return null;
  const from = Date.parse(String(createdAt));
  const to = Date.parse(String(now));
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

export function PurchasingQueue({
  requests,
  now,
  params,
  basePath,
  canReceive = false,
}: {
  requests: any[];
  now: string;
  params: QueueSearchParams;
  basePath: string;
  canReceive?: boolean;
}) {
  const board = lifecycleBoard(requests);

  // "Everything active" is the default view and it deliberately includes the
  // ordered and email-drafted piles.
  const stage = params.stage ?? 'ACTIVE';
  const stageStatuses =
    stage === 'ACTIVE' || stage === 'ALL'
      ? null
      : (board.find((b: any) => b.key === stage)?.statuses ?? null);

  const scoped = stageStatuses
    ? requests.filter((r) => stageStatuses.includes(r.status))
    : stage === 'ALL'
      ? requests
      : requests.filter((r) => !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(r.status));

  // The domain's filter, given the URL's values. A stage tab and a single
  // status filter would fight, so picking a stage neutralizes the status box.
  const filtered = applyFilters(
    scoped,
    {
      search: params.search ?? '',
      status: stageStatuses ? 'ALL' : params.status || 'ALL',
      jobNumber: params.jobNumber ?? '',
      vendorId: params.vendorId ?? '',
      requestorId: params.requestorId ?? '',
      needByFrom: params.needByFrom ?? '',
      needByTo: params.needByTo ?? '',
      overdueOnly: params.overdue === '1',
    },
    now,
  );

  // Priority is derived, so it filters here rather than in applyFilters —
  // the domain has no priority field to filter on. See status-display.ts.
  const rows = (params.priority
    ? filtered.filter((r: any) => urgencyOf(r, now) === params.priority)
    : filtered
  ).sort((a: any, b: any) =>
    `${a.needByDate ?? '9999-12-31'}${a.needByTime ?? ''}`.localeCompare(
      `${b.needByDate ?? '9999-12-31'}${b.needByTime ?? ''}`,
    ),
  );

  const hrefFor = (key: string) => {
    const query = new URLSearchParams();
    if (key !== 'ACTIVE') query.set('stage', key);
    // Carry the filters across a tab change: switching pile should not throw
    // away the job somebody is looking at.
    for (const [name, value] of Object.entries(params)) {
      if (name === 'stage' || !value) continue;
      if (stageStatuses && name === 'status') continue;
      query.set(name, String(value));
    }
    const qs = query.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const tabs: TabItem[] = [
    {
      key: 'ACTIVE',
      label: 'Everything active',
      count: requests.filter((r: any) => !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(r.status)).length,
    },
    ...board.map((b: any) => ({
      key: b.key,
      label: STAGE_LABELS[b.key] ?? b.key,
      count: b.count,
      actionable: b.actionable,
    })),
  ];

  return (
    <div className="space-y-4">
      <Tabs items={tabs} active={stage} hrefFor={hrefFor} ariaLabel="Lifecycle stage" />

      <QueueFilters
        action={basePath}
        hidden={{ stage: stage === 'ACTIVE' ? '' : stage }}
        values={{
          search: params.search ?? '',
          status: stageStatuses ? '' : (params.status ?? ''),
          jobNumber: params.jobNumber ?? '',
          vendorId: params.vendorId ?? '',
          requestorId: params.requestorId ?? '',
          priority: params.priority ?? '',
          needByFrom: params.needByFrom ?? '',
          needByTo: params.needByTo ?? '',
          overdue: params.overdue ?? '',
        }}
        statuses={REQUEST_STATUSES.map((s: string) => ({ value: s, label: displayStatus(s) }))}
        priorities={(['EMERGENCY', 'URGENT', 'NORMAL'] as Urgency[]).map((u) => ({
          value: u,
          label: URGENCY_LABELS[u],
        }))}
        jobs={distinct(requests, 'jobNumber', 'jobNumber')}
        vendors={distinct(requests, 'vendorId', 'vendorName')}
        requesters={distinct(requests, 'requestorId', 'requestorName')}
      />

      <TableFrame>
        <Table>
          <THead>
            <tr>
              <TH>Request / PO</TH>
              <TH>Job</TH>
              <TH className="hidden lg:table-cell">Vendor</TH>
              <TH className="hidden xl:table-cell">Requester</TH>
              <TH>Priority</TH>
              <TH>Status</TH>
              <TH align="right" className="hidden sm:table-cell">
                Age
              </TH>
              <TH align="right" className="hidden md:table-cell">
                Items
              </TH>
              <TH align="right" className="hidden lg:table-cell">
                Amount
              </TH>
              <TH>Next action</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((r: any) => {
              const next = nextActionFor(r);
              const late = isOverdue(r, now);
              const age = ageDays(r.createdAt, now);
              return (
                <TR key={r.id} highlight={late}>
                  <TDLink href={`/requests/${r.id}`}>
                    {r.poNumber ?? r.requestNumber}
                    {r.poNumber ? (
                      <span className="ml-1 block text-xs font-normal text-muted">{r.requestNumber}</span>
                    ) : null}
                  </TDLink>
                  <TD>
                    {r.jobNumber}
                    <span className="block whitespace-nowrap text-xs text-muted">
                      {r.needByDate ?? 'no date'}
                      {late ? <span className="font-medium text-danger"> · overdue</span> : null}
                    </span>
                  </TD>
                  <TD className="hidden lg:table-cell">{r.vendorName ?? '—'}</TD>
                  <TD className="hidden xl:table-cell">{r.requestorName ?? '—'}</TD>
                  <TD>
                    <UrgencyBadge request={r} now={now} />
                  </TD>
                  <TD>
                    <StatusBadge status={r.status} />
                  </TD>
                  <TD align="right" numeric className="hidden sm:table-cell">
                    {age === null ? '—' : `${age}d`}
                  </TD>
                  <TD align="right" numeric className="hidden md:table-cell">
                    {r.itemCount ?? '—'}
                    {r.requestedQty ? (
                      <span className="block text-xs text-muted">{formatQty(r.requestedQty)} total</span>
                    ) : null}
                  </TD>
                  <TD align="right" numeric className="hidden lg:table-cell">
                    {r.estimatedTotalCents ? formatMoney(r.estimatedTotalCents) : '—'}
                  </TD>
                  <TD>
                    {next.href ? (
                      <ButtonLink
                        href={next.href}
                        variant={next.actionable ? 'primary' : 'secondary'}
                        className="h-8 px-3 text-xs"
                      >
                        {next.label}
                      </ButtonLink>
                    ) : (
                      <span className="text-xs text-muted">{next.label}</span>
                    )}
                  </TD>
                </TR>
              );
            })}
            {rows.length === 0 ? (
              <TableEmpty colSpan={10}>
                Nothing matches these filters. Clearing them shows everything active — including work that is
                already ordered.
              </TableEmpty>
            ) : null}
          </TBody>
        </Table>
      </TableFrame>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableCount shown={rows.length} total={requests.length} noun="requests" />
        {canReceive ? (
          <ButtonLink href="/receiving" variant="secondary">
            Open receiving
          </ButtonLink>
        ) : null}
      </div>
    </div>
  );
}

function distinct(rows: any[], valueKey: string, labelKey: string) {
  const map = new Map<string, string>();
  for (const row of rows) {
    const value = row[valueKey];
    if (value) map.set(String(value), String(row[labelKey] ?? value));
  }
  return [...map]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
