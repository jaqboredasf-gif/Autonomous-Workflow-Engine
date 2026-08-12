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
import { BrandMark, PrintButton } from '../../../../components/pcc';
import { generateEmailDraftAction } from '../../../actions.ts';

export const dynamic = 'force-dynamic';

export default async function PoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAccess('/requests');

  const ctx = await purchasingRequestContext();
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

  // Print the money columns only when somebody actually recorded money. A
  // column of "$0.00" is not information; it is three inches of paper telling
  // the reader nothing, on a sheet whose whole job is to be scannable.
  const showCosts = view.items.some((i: any) => Number(i.estimatedUnitCostCents ?? 0) > 0);

  // Job name and address, when the job is in the directory. The job NUMBER is
  // what the record carries and what the vendor sees; the name and address are
  // what makes the paper useful to a person holding it.
  const job = await S.listJobs(ctx, actor)
    .then((js: any[]) => js.find((j) => String(j.job_number ?? j.jobNumber) === String(view.request.jobNumber)) ?? null)
    .catch(() => null);

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-900">Purchase order {view.purchaseOrder.poNumber}</h1>
        <div className="flex flex-wrap gap-2">
          {/* FIRST-CLASS, and first in the row: he prints every PO and files the
              vendor's receipt against the paper. */}
          <PrintButton />
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
          {/* The vendor's copy carries the mark. This sheet leaves the building
              — printed, or saved to PDF and attached to an email — so it is the
              one place the logo is doing a job rather than decorating one. */}
          <div className="flex items-start gap-3">
            <BrandMark size={40} />
            <div>
              <div className="text-lg font-semibold">{view.org.name}</div>
              <div className="text-xs text-slate-600">{view.org.address}</div>
              <div className="text-xs text-slate-600">{view.org.phone}</div>
            </div>
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
            {/* He chooses the vendor himself, often at the counter or on the
                phone. When the record does not name one, the sheet prints a
                RULED LINE to write on rather than the word "none" — the paper
                has to work whether or not the database was told. */}
            {view.vendor?.name ? (
              <div>{view.vendor.name}</div>
            ) : (
              <div className="mt-4 border-b border-slate-400" style={{ minWidth: '14rem' }} aria-label="Vendor (write in)" />
            )}
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

        <div className="mt-6 border-t border-slate-200 pt-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="font-medium">
              Job {view.request.jobNumber}
              {job?.name ? ` — ${job.name}` : ''}
            </div>
            <div className="text-slate-600">Request {view.request.requestNumber}</div>
          </div>
          {job?.site_address ?? job?.siteAddress ? (
            <div className="text-slate-600">{job.site_address ?? job.siteAddress}</div>
          ) : null}
        </div>

        <table className="mt-4 min-w-full text-left text-sm">
          <thead className="border-y border-slate-300 text-xs uppercase text-slate-600">
            <tr>
              <th className="py-2 pr-2">#</th>
              <th className="py-2 pr-2">Description</th>
              <th className="py-2 pr-2 text-right">Qty</th>
              <th className="py-2 pr-2">Unit</th>
              {showCosts ? <th className="py-2 pr-2 text-right">Unit cost</th> : null}
              {showCosts ? <th className="py-2 text-right">Line total</th> : null}
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
                {showCosts ? <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(i.estimatedUnitCostCents)}</td> : null}
                {showCosts ? <td className="py-2 text-right tabular-nums">{formatMoney(i.lineTotalCents)}</td> : null}
              </tr>
            ))}
          </tbody>
          {showCosts ? (
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
          ) : null}
        </table>

        {view.purchaseOrder.notes ? (
          <div className="mt-4 text-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</div>
            <div>{view.purchaseOrder.notes}</div>
          </div>
        ) : null}

        {/* THE FILING BLOCK. The vendor's receipt gets stapled to this sheet and
            the pair goes in the office file, so the paper needs somewhere to
            write what happened. This is the part of the workflow the software
            is not replacing, and designing for it is the point. */}
        <div className="print-keep-together mt-8 border-t border-slate-200 pt-3">
          <div className="grid grid-cols-3 gap-6 text-xs text-slate-600">
            <div>
              <div className="mb-5">Ordered by</div>
              <div className="border-b border-slate-400" />
            </div>
            <div>
              <div className="mb-5">Date ordered</div>
              <div className="border-b border-slate-400" />
            </div>
            <div>
              <div className="mb-5">Receipt attached</div>
              <div className="border-b border-slate-400" />
            </div>
          </div>
          <p className="mt-4 text-xs text-slate-600">
            Reference the PO number on all packing slips and invoices.
          </p>
        </div>
      </div>
    </div>
  );
}
