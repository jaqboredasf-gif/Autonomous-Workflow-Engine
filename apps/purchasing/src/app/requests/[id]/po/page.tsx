/* eslint-disable @typescript-eslint/no-explicit-any */
// The purchase order: on screen, printable, and downloadable as the stored PDF.
// The PDF is generated once at approval time and kept with the request; this
// page renders the same data, it does not re-derive a second version of it.
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../../server/session.ts';
import * as S from '../../../../server/service.ts';
import { formatMoney, formatQty } from '../../../../purchasing/domain/numbers.mjs';
import { Empty, Section, buttonClass, secondaryButtonClass } from '../../../../components/ui';
import { generateEmailDraftAction } from '../../../actions.ts';

export const dynamic = 'force-dynamic';

export default async function PoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAccess('/requests');

  const ctx = purchasingRequestContext();
  let detail: any;
  try {
    detail = await S.getRequestDetail(ctx, actor, id);
  } catch {
    notFound();
  }
  if (!detail.purchaseOrder) {
    return (
      <Section title="Purchase order">
        <Empty>No purchase order has been generated for this request yet.</Empty>
      </Section>
    );
  }

  const view = await S.purchaseOrderView(ctx, detail.purchaseOrder.id);
  const doc = detail.purchaseOrder.documents[0];

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-900">Purchase order {view.purchaseOrder.poNumber}</h1>
        <div className="flex gap-2">
          {doc ? (
            <a href={`/api/documents/${doc.id}`} className={secondaryButtonClass}>
              Download PDF
            </a>
          ) : null}
          {/* The vendor email is reachable FROM the purchase order, which is
              where a person is standing when they decide to send it. Before
              this, the only create button lived back on the request page and
              this link led to a dead end. */}
          {detail.emailDrafts.length ? (
            <Link href={`/requests/${id}/email`} className={secondaryButtonClass}>
              View vendor email draft
            </Link>
          ) : (
            <form action={generateEmailDraftAction}>
              <input type="hidden" name="requestId" value={id} />
              <button className={buttonClass}>Create vendor email draft</button>
            </form>
          )}
          <Link href={`/requests/${id}`} className={secondaryButtonClass}>
            Back to request
          </Link>
        </div>
      </div>

      <div className="print-sheet mx-auto max-w-3xl rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-semibold">{view.org.name}</div>
            <div className="text-xs text-slate-600">{view.org.address}</div>
            <div className="text-xs text-slate-600">{view.org.phone}</div>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold tracking-wide">PURCHASE ORDER</div>
            <div className="text-sm font-medium">{view.purchaseOrder.poNumber}</div>
            <div className="text-xs text-slate-600">Issued {String(view.purchaseOrder.generatedAt).slice(0, 10)}</div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-6 text-sm">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Vendor</div>
            <div>{view.vendor.name}</div>
            {view.vendorContact ? <div>Attn: {view.vendorContact.name}</div> : null}
            {view.vendorContact ? <div className="text-slate-600">{view.vendorContact.email}</div> : null}
            <div className="text-slate-600">{view.vendor.phone}</div>
            <div className="text-slate-600">{view.vendor.address}</div>
            {view.vendor.accountNumber ? <div className="text-slate-600">Account {view.vendor.accountNumber}</div> : null}
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {view.request.deliveryMethod === 'PICKUP' ? 'Pick up from' : 'Deliver to'}
            </div>
            <div>{view.request.deliveryLocationName}</div>
            <div className="text-slate-600">{view.request.deliveryAddress}</div>
            <div className="mt-1">
              Needed by {view.request.needByDate} at {view.request.needByTime}
            </div>
            <div className="text-slate-600">Requested by {view.request.requestorName}</div>
          </div>
        </div>

        <div className="mt-6 flex justify-between border-t border-slate-200 pt-3 text-sm">
          <div className="font-medium">Job number: {view.request.jobNumber}</div>
          <div className="text-slate-600">Request {view.request.requestNumber}</div>
          <div className="text-slate-600">Approved by {view.approver.name}</div>
        </div>

        <table className="mt-4 min-w-full text-left text-sm">
          <thead className="border-y border-slate-300 text-xs uppercase text-slate-600">
            <tr>
              <th className="py-2 pr-2">#</th>
              <th className="py-2 pr-2">Description</th>
              <th className="py-2 pr-2 text-right">Qty</th>
              <th className="py-2 pr-2">Unit</th>
              <th className="py-2 pr-2 text-right">Unit cost</th>
              <th className="py-2 text-right">Line total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {view.items.map((i: any) => (
              <tr key={i.lineNo}>
                <td className="py-2 pr-2">{i.lineNo}</td>
                <td className="py-2 pr-2">
                  {i.description}
                  {i.substituteFor ? (
                    <span className="block text-xs text-slate-500">substitute for: {i.substituteFor}</span>
                  ) : null}
                  {i.expectedArrivalDate ? (
                    <span className="block text-xs text-slate-500">expected {i.expectedArrivalDate}</span>
                  ) : null}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatQty(i.finalOrderQty)}</td>
                <td className="py-2 pr-2">{i.unit}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(i.estimatedUnitCostCents)}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(i.lineTotalCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-300">
              <td colSpan={5} className="py-2 pr-2 text-right font-semibold">
                Estimated total
              </td>
              <td className="py-2 text-right font-semibold tabular-nums">
                {formatMoney(view.purchaseOrder.estimatedTotalCents)}
              </td>
            </tr>
          </tfoot>
        </table>

        {view.purchaseOrder.notes ? (
          <div className="mt-4 text-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</div>
            <div>{view.purchaseOrder.notes}</div>
          </div>
        ) : null}

        <p className="mt-8 border-t border-slate-200 pt-3 text-xs text-slate-600">
          Confirm price and delivery date on receipt of this order. Reference the PO number on all packing slips and
          invoices.
        </p>
      </div>
    </div>
  );
}
