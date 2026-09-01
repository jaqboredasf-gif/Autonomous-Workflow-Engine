/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// The job directory.
//
// This screen is the FIRST CONSUMER of JobDirectoryProvider, and it exists as
// much to prove the seam as to be looked at: it never touches a jobs table, a
// repository or a query. It asks the provider, and renders what comes back
// alongside the purchasing this organization has actually done against each
// job.
//
// When QuickBooks becomes the source of truth, composition binds a different
// provider and this file does not change — including the "where these come
// from" line below, which reads the provider's own `source`.
//
// Read-only by design. Jobs are created in Administration today and will be
// created in QuickBooks tomorrow; a second place to invent one is how two
// systems end up with two spellings of the same job.
// ---------------------------------------------------------------------------
import Link from 'next/link';

import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import * as S from '../../server/service.ts';
import { formatMoney } from '../../purchasing/domain/numbers.mjs';
import { OPEN_ORDER_STATUSES } from '../../purchasing/domain/status.mjs';
import {
  Alert,
  Badge,
  EmptyState,
  PageHeader,
  Table,
  TableCount,
  TableFrame,
  TBody,
  TD,
  TH,
  THead,
  TR,
  fieldStyle,
  buttonStyle,
} from '../../components/pcc';
import { pageTitle } from '../../purchasing/organization/identity.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: pageTitle('Jobs') };

const SOURCE_LABELS: Record<string, string> = {
  local: 'this system',
  quickbooks: 'QuickBooks',
  microsoft365: 'Microsoft 365',
  exacttime: 'Exact Time',
  import: 'an import',
};

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const actor = await requireAccess('/jobs');
  const params = await searchParams;
  const search = (params.search ?? '').trim();
  const ctx = await purchasingRequestContext();

  const provider = ctx.integrations.jobs;
  // `search` with no text returns the whole list, ranked — so one call covers
  // both the browse and the find case.
  const allJobs = await provider.list(actor.orgId);
  const jobs = search ? await provider.search(actor.orgId, search, 200) : allJobs;

  // Purchasing activity per job, from the requests this person may already see.
  // Counting here rather than asking the provider is deliberate: how much this
  // company has bought against a job is PURCHASING's fact, and no external job
  // directory should be asked for it.
  const requests = await S.listRequests(ctx, actor);
  const activity = new Map<string, { requests: number; openOrders: number; committedCents: number; lastAt: string | null }>();
  for (const r of requests as any[]) {
    const key = String(r.jobNumber ?? '');
    if (!key) continue;
    const row = activity.get(key) ?? { requests: 0, openOrders: 0, committedCents: 0, lastAt: null };
    row.requests += 1;
    if (OPEN_ORDER_STATUSES.includes(r.status)) {
      row.openOrders += 1;
      row.committedCents += Number(r.estimatedTotalCents ?? 0);
    }
    const at = r.orderedAt ?? r.submittedAt ?? r.createdAt ?? null;
    if (at && (!row.lastAt || at > row.lastAt)) row.lastAt = at;
    activity.set(key, row);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Jobs"
        description={`The job directory, from ${SOURCE_LABELS[provider.source] ?? provider.source}. Purchasing activity is counted from this company's own requests.`}
      />

      {!provider.available ? (
        // A directory that cannot be reached says so. An empty table would read
        // as "this company has no jobs", which is a different and wrong claim.
        <Alert tone="warning" title="The job directory is not available">
          {provider.unavailableReason ?? 'The connected job system did not answer. Job numbers already on requests are unaffected.'}
        </Alert>
      ) : null}

      <form action="/jobs" method="get" className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-2.5 shadow-card">
        <div className="min-w-0 flex-1 basis-64">
          <input
            name="search"
            type="search"
            defaultValue={search}
            placeholder="Search job number, name or customer…"
            aria-label="Search jobs"
            className={fieldStyle()}
          />
        </div>
        <button type="submit" className={buttonStyle('primary', 'm')}>
          Search
        </button>
        {search ? (
          <a href="/jobs" className={buttonStyle('ghost', 'm')}>
            Clear
          </a>
        ) : null}
      </form>

      <TableFrame>
        <TableCount shown={jobs.length} total={allJobs.length} noun="job" />
        <Table>
          <THead>
            <tr>
              <TH>Job</TH>
              <TH>Name</TH>
              <TH className="hidden md:table-cell">Customer</TH>
              <TH className="hidden lg:table-cell">Site</TH>
              <TH>Requests</TH>
              <TH>Open orders</TH>
              <TH className="hidden sm:table-cell">Committed</TH>
            </tr>
          </THead>
          <TBody>
            {jobs.map((job: any) => {
              const a = activity.get(job.jobNumber);
              return (
                <TR key={job.sourceId}>
                  <TD className="whitespace-nowrap font-medium">
                    {/* Straight into the dashboard filtered to this job — the
                        answer to "what are we buying for 24-118" is one click
                        from the place people look the job up. */}
                    <Link
                      href={`/dashboard?jobNumber=${encodeURIComponent(job.jobNumber)}`}
                      className="text-brand hover:underline"
                    >
                      {job.jobNumber}
                    </Link>
                    {!job.active ? <Badge tone="neutral" className="ml-2">Inactive</Badge> : null}
                  </TD>
                  <TD>{job.name || '—'}</TD>
                  <TD className="hidden md:table-cell">{job.customerName ?? '—'}</TD>
                  <TD className="hidden lg:table-cell text-muted">{job.address ?? '—'}</TD>
                  <TD className="tabular-nums">{a?.requests ?? 0}</TD>
                  <TD className="tabular-nums">{a?.openOrders ?? 0}</TD>
                  <TD className="hidden sm:table-cell tabular-nums">
                    {a?.committedCents ? formatMoney(a.committedCents) : '—'}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
        {jobs.length === 0 ? (
          <EmptyState
            title={search ? 'No job matches that' : 'No jobs yet'}
            description={
              search
                ? 'Try the job number on its own, or clear the search.'
                : 'Jobs are added in Administration, and will come from the connected accounting system once it is linked.'
            }
          />
        ) : null}
      </TableFrame>
    </div>
  );
}
