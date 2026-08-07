/* eslint-disable @typescript-eslint/no-explicit-any */
// Reports.
//
// The handoff lists Reports as a sidebar destination without specifying one,
// so this ships the reports that can be COUNTED honestly from the records that
// exist — spend by job and by vendor, and the throughput of the queue — and
// says plainly what it is not. It does not invent a savings figure or a
// forecast; there is no data behind either.
import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import * as S from '../../server/service.ts';
import { summarize } from '../../purchasing/domain/dashboard.mjs';
import { formatMoney } from '../../purchasing/domain/numbers.mjs';
import {
  Alert,
  EmptyState,
  KpiCard,
  PageHeader,
  Panel,
  Table,
  TableFrame,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../../components/pcc';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reports — Lippolis Purchasing' };

export default async function ReportsPage() {
  const actor = await requireAccess('/reports');
  const ctx = await purchasingRequestContext();
  const requests = (await S.listRequests(ctx, actor)) as any[];
  const now = new Date().toISOString();
  const counts = summarize(requests, now);

  const byJob = group(requests, (r) => r.jobNumber ?? 'unassigned');
  const byVendor = group(
    requests.filter((r) => r.vendorName),
    (r) => r.vendorName as string,
  );

  const month = now.slice(0, 7);
  const raisedThisMonth = requests.filter((r) => String(r.createdAt ?? '').slice(0, 7) === month).length;

  return (
    <div className="space-y-5">
      <PageHeader title="Reports" description="Counted from purchase records. Nothing here is estimated." />

      <section aria-label="Totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Requests in view" value={requests.length} />
        <KpiCard label="Raised this month" value={raisedThisMonth} />
        <KpiCard label="Received this month" value={counts.received_this_month} tone="good" />
        <KpiCard label="Committed on open orders" value={formatMoney(counts.open_order_value_cents)} tone="info" />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By job" subtitle="Estimated value of everything raised against each job" bodyClassName="">
          <Breakdown rows={byJob} label="Job" />
        </Panel>
        <Panel title="By vendor" subtitle="Estimated value of everything assigned to each vendor" bodyClassName="">
          <Breakdown rows={byVendor} label="Vendor" />
        </Panel>
      </div>

      <Alert tone="info" title="What these numbers are">
        Amounts are the workshop's ESTIMATED totals, which is what the records hold for most orders — an actual cost
        is only known once an invoice is reconciled. A report that silently mixed the two would be worse than no
        report.
      </Alert>
    </div>
  );
}

function Breakdown({ rows, label }: { rows: Array<{ key: string; count: number; cents: number }>; label: string }) {
  if (rows.length === 0) {
    return <EmptyState title="Nothing to report yet" description="Figures appear as purchasing records accumulate." />;
  }
  return (
    <TableFrame className="rounded-none border-0 shadow-none">
      <Table>
        <THead sticky={false}>
          <tr>
            <TH>{label}</TH>
            <TH align="right">Requests</TH>
            <TH align="right">Estimated value</TH>
          </tr>
        </THead>
        <TBody>
          {rows.slice(0, 12).map((row) => (
            <TR key={row.key}>
              <TD className="text-ink">{row.key}</TD>
              <TD align="right" numeric>
                {row.count}
              </TD>
              <TD align="right" numeric>
                {formatMoney(row.cents)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableFrame>
  );
}

function group(requests: any[], keyOf: (r: any) => string) {
  const map = new Map<string, { key: string; count: number; cents: number }>();
  for (const r of requests) {
    const key = keyOf(r);
    const acc = map.get(key) ?? { key, count: 0, cents: 0 };
    acc.count += 1;
    acc.cents += Number(r.estimatedTotalCents ?? 0);
    map.set(key, acc);
  }
  return [...map.values()].sort((a, b) => b.cents - a.cents || b.count - a.count);
}
