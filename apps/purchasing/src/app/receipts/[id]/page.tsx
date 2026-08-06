/* eslint-disable @typescript-eslint/no-explicit-any */
// /receipts/:id — one delivery, and the evidence that it happened.
//
// This is what the office shows a vendor who says they delivered, and what
// accounting reads before paying: who signed, when, against which PO, what
// arrived, what did not, and the photos and packing slip attached at the time.
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../server/session.ts';
import { receiptEvidence } from '../../../purchasing/application/queries.ts';
import { Qty, ReadOnly, Section } from '../../../components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Receipt — Lippolis Purchasing' };

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAccess('/receipts');
  const ctx = purchasingRequestContext();

  let evidence: any;
  try {
    evidence = receiptEvidence(ctx, actor, id);
  } catch {
    notFound();
  }
  if (!evidence) notFound();

  const { receipt, request, purchaseOrder, progress, attachments } = evidence;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Receipt · {receipt.receivedDate}
            {receipt.isFinal ? '' : ' (partial)'}
          </h1>
          <p className="text-sm text-slate-600">
            {purchaseOrder?.poNumber ? `PO ${purchaseOrder.poNumber} · ` : ''}job {request.jobNumber} ·{' '}
            {request.vendorName ?? 'vendor not recorded'}
          </p>
        </div>
        <Link
          href={`/requests/${request.id}`}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
        >
          Full request history
        </Link>
      </div>

      <Section title="Who signed for it" subtitle="Recorded at the moment of receipt.">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <ReadOnly label="Received by" value={receipt.receivedByName} />
          <ReadOnly label="Date received" value={receipt.receivedDate} />
          <ReadOnly label="Recorded at" value={String(receipt.createdAt).slice(0, 16).replace('T', ' ')} />
          <ReadOnly label="Packing slip" value={receipt.packingSlipNumber} />
          <ReadOnly
            label="Location"
            value={`${request.deliveryMethod === 'PICKUP' ? 'Picked up from' : 'Delivered to'} ${request.deliveryLocationName}`}
          />
          <ReadOnly label="Notes" value={receipt.notes} />
        </div>
      </Section>

      <Section title="What arrived">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
              <tr>
                <th className="py-2 pr-3">Item</th>
                <th className="py-2 pr-3 text-right">Ordered</th>
                <th className="py-2 pr-3 text-right">Received to date</th>
                <th className="py-2 pr-3 text-right">Damaged</th>
                <th className="py-2 pr-3 text-right">Backordered</th>
                <th className="py-2 pr-3 text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {progress.map((p: any) => (
                <tr key={p.purchaseOrderItemId}>
                  <td className="py-2 pr-3">{p.description}</td>
                  <td className="py-2 pr-3 text-right"><Qty value={p.finalOrderQty} unit={p.unit} /></td>
                  <td className="py-2 pr-3 text-right"><Qty value={p.receivedQty} /></td>
                  <td className="py-2 pr-3 text-right"><Qty value={p.damagedQty} /></td>
                  <td className="py-2 pr-3 text-right"><Qty value={p.backorderedQty} /></td>
                  <td className={`py-2 pr-3 text-right ${p.outstandingQty > 0 ? 'font-medium text-amber-700' : 'text-emerald-700'}`}>
                    <Qty value={p.outstandingQty} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Evidence" subtitle="Photos and delivery tickets attached when it was received.">
        {attachments.length === 0 ? (
          <p className="text-sm text-slate-500">No photo or delivery ticket was attached to this receipt.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {attachments.map((a: any) => (
              <li key={a.id} className="rounded-md border border-slate-200 p-2 text-xs">
                <div className="font-medium text-slate-800">{a.filename}</div>
                {a.caption ? <div className="text-slate-600">{a.caption}</div> : null}
                <div className="text-slate-500">{Math.round(Number(a.byte_size ?? 0) / 1024)} KB</div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
