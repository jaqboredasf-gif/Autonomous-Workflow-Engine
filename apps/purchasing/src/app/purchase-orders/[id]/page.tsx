// /purchase-orders/:id — the canonical link to a purchase order.
//
// A PO belongs to exactly one request, and the request page already renders the
// printable sheet with its access rule applied. This route resolves the PO and
// hands over, so a PO number can be shared as a link without duplicating the
// page (or its authorization) in two places.
import { notFound, redirect } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../server/session.ts';

export const dynamic = 'force-dynamic';

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAccess('/purchase-orders');
  const ctx = await purchasingRequestContext();

  const order = await ctx.orders.findById(id);
  if (!order || order.orgId !== actor.orgId) notFound();
  redirect(`/requests/${order.requestId}/po`);
}
