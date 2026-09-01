/* eslint-disable @typescript-eslint/no-explicit-any */
// Screen 07 — Vendors.
//
// The handoff asks for category, preferred status, lead time and reliability
// columns. This schema records none of those: `purchase_vendors` holds a name,
// an account number, a phone, an address and a note. So the columns that CAN
// be filled from records are filled, and the ones that cannot say "not
// recorded" rather than showing a plausible number nobody measured. The
// contract is explicit about that — do not fabricate intelligence metrics.
//
// Lead time and order counts on the profile ARE real: they are counted from
// this organization's own purchase history.
import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import * as S from '../../server/service.ts';
import { hasPermission } from '../../purchasing/domain/roles.mjs';
import {
  Alert,
  ButtonLink,
  EmptyState,
  PageHeader,
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
} from '../../components/pcc';
import { VendorFilters } from '../../components/pcc/VendorFilters';
import { pageTitle } from '../../purchasing/organization/identity.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: pageTitle('Vendors') };

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; active?: string }>;
}) {
  const actor = await requireAccess('/vendors');
  const params = await searchParams;
  const ctx = await purchasingRequestContext();

  const all = await S.listVendors(ctx, actor);
  const requests = await S.listRequests(ctx, actor);

  // Last order per vendor, counted from the requests this viewer can see.
  const lastOrder = new Map<string, string>();
  const orderCount = new Map<string, number>();
  for (const r of requests as any[]) {
    if (!r.vendorId) continue;
    const key = String(r.vendorId);
    orderCount.set(key, (orderCount.get(key) ?? 0) + (r.orderedAt ? 1 : 0));
    if (r.orderedAt && String(r.orderedAt) > (lastOrder.get(key) ?? '')) lastOrder.set(key, String(r.orderedAt));
  }

  const search = (params.search ?? '').trim().toLowerCase();
  const rows = (all as any[]).filter((v) => {
    if (params.active === 'inactive' && v.is_active) return false;
    if (params.active !== 'inactive' && !v.is_active) return false;
    if (!search) return true;
    return [v.name, v.account_number, v.contact_name, v.contact_email, v.phone, v.notes]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(search);
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Vendors"
        description="Who this company buys from, and what the purchase records say about them."
        actions={
          hasPermission(actor, 'admin.vendors') ? (
            <ButtonLink href="/admin#vendors" variant="secondary">
              Add or edit vendors
            </ButtonLink>
          ) : undefined
        }
      />

      <VendorFilters action="/vendors" values={{ search: params.search ?? '', active: params.active ?? 'active' }} />

      {rows.length === 0 ? (
        <TableFrame>
          <EmptyState
            title={search ? 'No vendor matches that' : 'No vendors yet'}
            description={
              search
                ? 'Try the account number, or clear the search.'
                : 'An administrator adds suppliers from the Administration screen.'
            }
          />
        </TableFrame>
      ) : (
        <TableFrame>
          <Table>
            <THead>
              <tr>
                <TH>Vendor</TH>
                <TH className="hidden md:table-cell">Account</TH>
                <TH>Contact</TH>
                <TH className="hidden lg:table-cell">Phone</TH>
                <TH align="right" className="hidden sm:table-cell">
                  Orders
                </TH>
                <TH className="hidden lg:table-cell">Last order</TH>
                <TH>
                  <span className="sr-only">Open</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((v: any) => (
                <TR key={v.id}>
                  <TDLink href={`/vendors/${v.id}`}>{v.name}</TDLink>
                  <TD className="hidden md:table-cell">{v.account_number ?? '—'}</TD>
                  <TD>
                    {v.contact_name ?? <span className="text-muted">not recorded</span>}
                    {v.contact_email ? (
                      <a href={`mailto:${v.contact_email}`} className="block text-xs text-action hover:underline">
                        {v.contact_email}
                      </a>
                    ) : null}
                  </TD>
                  <TD className="hidden lg:table-cell">{v.phone ?? '—'}</TD>
                  <TD align="right" numeric className="hidden sm:table-cell">
                    {orderCount.get(String(v.id)) ?? 0}
                  </TD>
                  <TD className="hidden lg:table-cell">{(lastOrder.get(String(v.id)) ?? '—').slice(0, 10)}</TD>
                  <TD align="right">
                    <ButtonLink href={`/vendors/${v.id}`} variant="secondary" className="h-8 px-3 text-xs">
                      Open profile
                    </ButtonLink>
                  </TD>
                </TR>
              ))}
              {rows.length === 0 ? <TableEmpty colSpan={7}>No vendors match.</TableEmpty> : null}
            </TBody>
          </Table>
        </TableFrame>
      )}

      <TableCount shown={rows.length} total={(all as any[]).length} noun="vendors" />

      <Alert tone="info" title="Categories, preferred status and lead-time filters are not recorded yet">
        The vendor table holds a name, account number, phone, address and notes. Until those fields exist, this screen
        shows what the purchase history can actually prove — order counts and last order date — rather than an
        estimate dressed up as a measurement.
      </Alert>
    </div>
  );
}
