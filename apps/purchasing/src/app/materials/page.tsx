/* eslint-disable @typescript-eslint/no-explicit-any */
// Screen 09 — Material catalog.
//
// The catalogue is READ FROM HISTORY, not from a separately maintained list.
// Every request line stores the normalized form of what was typed
// (domain/catalog.mjs) at the moment it was written, so "2x4 LED troffer" and
// "2 x 4 led troffer, 4000K" collapse to one entry with two aliases — and the
// counts are a query rather than a column that drifts.
//
// That is why this screen has data on the day it ships: nothing had to be
// entered twice, and nothing has to be backfilled.
import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import { materialCatalog } from '../../purchasing/application/queries.ts';
import { formatMoney, formatQty } from '../../purchasing/domain/numbers.mjs';
import {
  Alert,
  Badge,
  EmptyState,
  KpiCard,
  PageHeader,
  Table,
  TableCount,
  TableFrame,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../../components/pcc';
import { VendorFilters } from '../../components/pcc/VendorFilters';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Materials — Lippolis Purchasing' };

export default async function MaterialsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; active?: string }>;
}) {
  const actor = await requireAccess('/materials');
  const params = await searchParams;
  const ctx = await purchasingRequestContext();

  const search = params.search ?? '';
  const activeOnly = params.active !== 'inactive';
  const all = await materialCatalog(ctx, actor, { limit: 500 });
  const rows = await materialCatalog(ctx, actor, { search, limit: 500, activeOnly });

  const withPrice = rows.filter((m: any) => m.lastUnitCostCents !== null).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Material catalog"
        description="What this company actually buys, built from its own purchase history."
      />

      <section aria-label="Catalogue summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Distinct items" value={all.length} hint="Collapsed by matching key" />
        <KpiCard
          label="With a recorded price"
          value={withPrice}
          hint={rows.length ? `of ${rows.length} shown` : 'none shown'}
        />
        <KpiCard
          label="Ordered 5+ times"
          value={all.filter((m: any) => m.timesRequested >= 5).length}
          hint="The repeat-buy core"
        />
        <KpiCard
          label="Seen once"
          value={all.filter((m: any) => m.timesRequested === 1).length}
          hint="One-off or a spelling nobody reused"
        />
      </section>

      <VendorFilters
        action="/materials"
        placeholder="Search a name, an alias or a part number…"
        values={{ search, active: params.active ?? 'active' }}
      />

      {rows.length === 0 ? (
        <TableFrame>
          <EmptyState
            title={search ? 'Nothing matches that' : 'The catalogue is empty'}
            description={
              search
                ? 'Search matches the canonical name, any alias it has been typed as, or a part number.'
                : 'Entries appear as soon as requests are raised — nothing has to be entered twice.'
            }
          />
        </TableFrame>
      ) : (
        <TableFrame>
          <Table>
            <THead>
              <tr>
                <TH>Material</TH>
                <TH className="hidden xl:table-cell">Also typed as</TH>
                <TH className="hidden md:table-cell">Part no.</TH>
                <TH>Unit</TH>
                <TH align="right">Ordered</TH>
                <TH align="right" className="hidden sm:table-cell">
                  Typical qty
                </TH>
                <TH className="hidden lg:table-cell">Usual vendor</TH>
                <TH align="right" className="hidden md:table-cell">
                  Last price
                </TH>
                <TH className="hidden lg:table-cell">Last used</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((m: any) => {
                const typical = m.timesRequested > 0 ? m.totalQtyRequested / m.timesRequested : 0;
                return (
                  <TR key={m.normalizedDescription}>
                    <TD className="font-medium text-ink">
                      {m.canonicalDescription}
                      {!m.isActive ? (
                        <Badge tone="neutral" className="ml-2">
                          Inactive
                        </Badge>
                      ) : null}
                    </TD>
                    <TD className="hidden xl:table-cell text-xs text-muted">
                      {m.aliases.filter((a: string) => a !== m.canonicalDescription).slice(0, 2).join(' · ') || '—'}
                    </TD>
                    <TD className="hidden md:table-cell">{m.catalogNumber ?? '—'}</TD>
                    <TD>{m.defaultUnit ?? '—'}</TD>
                    <TD align="right" numeric>
                      {m.timesRequested}×
                    </TD>
                    <TD align="right" numeric className="hidden sm:table-cell">
                      {formatQty(Math.round(typical))}
                    </TD>
                    <TD className="hidden lg:table-cell">{m.lastVendorName ?? '—'}</TD>
                    <TD align="right" numeric className="hidden md:table-cell">
                      {m.lastUnitCostCents === null ? (
                        <span className="text-muted">not recorded</span>
                      ) : (
                        formatMoney(m.lastUnitCostCents)
                      )}
                    </TD>
                    <TD className="hidden lg:table-cell">{(m.lastRequestedAt ?? '—').slice(0, 10)}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableFrame>
      )}

      <TableCount shown={rows.length} total={all.length} noun="materials" />

      <Alert tone="info" title="Where these entries come from">
        Each row is one matching key — the normalized form of a description, computed when the request line was
        written and stored beside what the person actually typed. Aliases are the other spellings the same item has
        been ordered under. Curating a canonical name, a category or a preferred vendor writes to
        <code className="mx-1 rounded bg-subtle px-1 py-0.5 text-xs">purchase_item_catalog</code>, which this screen
        already reads and which nothing writes yet.
      </Alert>
    </div>
  );
}
