/* eslint-disable @typescript-eslint/no-explicit-any */
// Screen 08 — Vendor profile.
//
// Everything numeric on this page is COUNTED from this organization's own
// purchase records. Nothing is scored or predicted. Where there is too little
// history to say something true — fewer than three completed deliveries — the
// figure is withheld and the screen says why, which is more useful than a lead
// time derived from one delivery.
import { notFound } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../server/session.ts';
import { vendorProfile } from '../../../purchasing/application/queries.ts';
import { formatMoney, formatQty } from '../../../purchasing/domain/numbers.mjs';
import {
  Alert,
  Badge,
  ButtonLink,
  DataGrid,
  DataPoint,
  EmptyState,
  KpiCard,
  PageHeader,
  Panel,
  StatusBadge,
  Table,
  TableFrame,
  TBody,
  TD,
  TDLink,
  TH,
  THead,
  TR,
} from '../../../components/pcc';

export const dynamic = 'force-dynamic';

export default async function VendorProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAccess('/vendors');
  const ctx = await purchasingRequestContext();

  const profile = await vendorProfile(ctx, actor, id);
  if (!profile) notFound();

  const { vendor, contact, materials, history, stats } = profile as any;
  const email = contact?.email ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={[{ label: 'Vendors', href: '/vendors' }, { label: vendor.name }]}
        title={vendor.name}
        description={vendor.account_number ? `Account ${vendor.account_number}` : 'No account number recorded'}
        meta={vendor.is_active ? null : <Badge tone="neutral">Inactive</Badge>}
        actions={
          email ? (
            <a
              href={`mailto:${email}`}
              className="inline-flex h-10 items-center justify-center rounded-md bg-action px-4 text-sm font-medium text-white shadow-sm hover:bg-action-hover"
            >
              Email {contact?.name ?? 'this vendor'}
            </a>
          ) : undefined
        }
      />

      <section aria-label="Vendor summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Orders placed" value={stats.totalOrders} hint="From this company's records" />
        <KpiCard
          label="Open orders"
          value={stats.openOrders}
          tone={stats.openOrders ? 'info' : 'neutral'}
          hint={formatMoney(stats.committedCents) + ' committed'}
        />
        <KpiCard
          label="Typical lead time"
          value={stats.typicalLeadTimeDays === null ? '—' : `${stats.typicalLeadTimeDays}d`}
          hint={
            stats.typicalLeadTimeDays === null
              ? `Needs 3 completed deliveries (${stats.deliveriesMeasured} so far)`
              : `Median of ${stats.deliveriesMeasured} deliveries`
          }
        />
        <KpiCard
          label="Delivered by need-by"
          value={stats.deliveriesMeasured ? `${stats.deliveriesOnTime}/${stats.deliveriesMeasured}` : '—'}
          tone={
            stats.deliveriesMeasured && stats.deliveriesOnTime < stats.deliveriesMeasured ? 'warn' : 'neutral'
          }
          hint={stats.deliveriesMeasured ? 'Counted, not scored' : 'No completed deliveries yet'}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Contact" className="lg:col-span-1">
          <DataGrid className="grid-cols-1 sm:grid-cols-1 lg:grid-cols-1">
            <DataPoint label="Contact name">{contact?.name}</DataPoint>
            <DataPoint label="Email">
              {email ? (
                <a href={`mailto:${email}`} className="text-action hover:underline">
                  {email}
                </a>
              ) : null}
            </DataPoint>
            <DataPoint label="Phone">{contact?.phone ?? vendor.phone}</DataPoint>
            <DataPoint label="Address">{vendor.address}</DataPoint>
            <DataPoint label="Last ordered">{(stats.lastOrderedAt ?? '').slice(0, 10)}</DataPoint>
          </DataGrid>
          {vendor.notes ? (
            <div className="mt-4 border-t border-line pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Operational notes</p>
              <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">{vendor.notes}</p>
            </div>
          ) : null}
        </Panel>

        <Panel
          title="Commonly bought from them"
          subtitle="Ranked by how often it has appeared on an order"
          className="lg:col-span-2"
          bodyClassName=""
        >
          {materials.length === 0 ? (
            <EmptyState
              title="Nothing ordered from this vendor yet"
              description="Materials appear here once a purchase order names them."
            />
          ) : (
            <TableFrame className="rounded-none border-0 shadow-none">
              <Table>
                <THead sticky={false}>
                  <tr>
                    <TH>Material</TH>
                    <TH align="right">Times ordered</TH>
                    <TH align="right" className="hidden sm:table-cell">
                      Total qty
                    </TH>
                    <TH align="right" className="hidden md:table-cell">
                      Last unit price
                    </TH>
                    <TH className="hidden lg:table-cell">Last ordered</TH>
                  </tr>
                </THead>
                <TBody>
                  {materials.map((m: any) => (
                    <TR key={m.normalizedDescription}>
                      <TD className="text-ink">{m.canonicalDescription}</TD>
                      <TD align="right" numeric>
                        {m.timesRequested}
                      </TD>
                      <TD align="right" numeric className="hidden sm:table-cell">
                        {formatQty(m.totalQtyRequested)} {m.defaultUnit ?? ''}
                      </TD>
                      <TD align="right" numeric className="hidden md:table-cell">
                        {m.lastUnitCostCents === null ? '—' : formatMoney(m.lastUnitCostCents)}
                      </TD>
                      <TD className="hidden lg:table-cell">{(m.lastOrderedAt ?? '—').slice(0, 10)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Panel>
      </div>

      <Panel title="Order history" subtitle="The 25 most recent requests naming this vendor" bodyClassName="">
        {history.length === 0 ? (
          <EmptyState title="No orders yet" description="Nothing has been bought from this vendor." />
        ) : (
          <TableFrame className="rounded-none border-0 shadow-none">
            <Table>
              <THead sticky={false}>
                <tr>
                  <TH>Request / PO</TH>
                  <TH>Job</TH>
                  <TH>Status</TH>
                  <TH className="hidden sm:table-cell">Needed by</TH>
                  <TH className="hidden md:table-cell">Ordered</TH>
                  <TH className="hidden md:table-cell">Received</TH>
                  <TH align="right" className="hidden lg:table-cell">
                    Estimated
                  </TH>
                </tr>
              </THead>
              <TBody>
                {history.map((r: any) => (
                  <TR key={r.id}>
                    <TDLink href={`/requests/${r.id}`}>{r.poNumber ?? r.requestNumber}</TDLink>
                    <TD>{r.jobNumber}</TD>
                    <TD>
                      <StatusBadge status={r.status} />
                    </TD>
                    <TD className="hidden sm:table-cell">{r.needByDate ?? '—'}</TD>
                    <TD className="hidden md:table-cell">{(r.orderedAt ?? '—').slice(0, 10)}</TD>
                    <TD className="hidden md:table-cell">{(r.receivedAt ?? '—').slice(0, 10)}</TD>
                    <TD align="right" numeric className="hidden lg:table-cell">
                      {formatMoney(r.estimatedTotalCents ?? 0)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Panel>

      <Alert tone="info" title="Not recorded yet: categories, emergency availability, delivery vs pickup capability">
        These are vendor attributes the schema does not carry. They are left as gaps rather than guesses — a
        purchaser deciding who to call at 6am needs a fact, not a default.
      </Alert>

      <ButtonLink href="/vendors" variant="secondary">
        Back to vendors
      </ButtonLink>
    </div>
  );
}
