/* eslint-disable @typescript-eslint/no-explicit-any */
// Accounting: the evidence behind a receipt, in the order AP asks for it —
// job, vendor, PO, who signed, when, where, and what did not match. Read-only
// by construction: the ACCOUNTING role carries no write permission at all.
import Link from 'next/link';

import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import * as S from '../../server/service.ts';
import { accountingPacket } from '../../purchasing/application/queries.ts';
import { Empty, Money, Section, StatusBadge } from '../../components/ui';
import { pageTitle } from '../../purchasing/organization/identity.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: pageTitle('Accounting') };

export default async function AccountingPage() {
  const actor = await requireAccess('/accounting');
  const ctx = await purchasingRequestContext();

  // Anything with a purchase order and at least one receipt is payable-ish;
  // anything with a discrepancy is the reason this screen exists.
  const candidates = (await S.listRequests(ctx, actor)).filter((r: any) =>
    ['PARTIALLY_RECEIVED', 'RECEIVED', 'COMPLETED'].includes(r.status),
  );
  const packets = await Promise.all(candidates.map((r: any) => accountingPacket(ctx, actor, r.id)));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Accounting</h1>
        <p className="mt-1 text-sm text-slate-600">
          Receipt evidence for invoice matching. Read-only — nothing here changes a purchasing decision.
        </p>
      </div>

      {packets.length === 0 ? (
        <Empty>Nothing has been received yet.</Empty>
      ) : (
        packets.map((packet: any) => (
          <Section
            key={packet.request.id}
            title={`${packet.purchaseOrder?.poNumber ?? packet.request.requestNumber} · job ${packet.request.jobNumber}`}
            subtitle={`${packet.request.vendorName ?? 'vendor not recorded'} · requested by ${packet.request.requestorName}`}
            actions={<StatusBadge status={packet.request.status} />}
          >
            <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Estimated total</div>
                <Money cents={packet.request.estimatedTotalCents} />
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Approved by</div>
                {packet.request.approverName ?? '—'}
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Ordered</div>
                {packet.request.orderedAt ? String(packet.request.orderedAt).slice(0, 10) : '—'}
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Received</div>
                {packet.request.receivedAt ? String(packet.request.receivedAt).slice(0, 10) : 'partial'}
              </div>
            </div>

            {packet.discrepancies.length ? (
              <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                  Check before paying
                </h3>
                <ul className="mt-1 space-y-0.5 text-sm text-amber-950">
                  {packet.discrepancies.map((d: any, i: number) => (
                    <li key={i}>
                      <strong>{d.kind}</strong> — {d.line}: {d.detail}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
                Everything ordered is accounted for.
              </p>
            )}

            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Receipts</h3>
            <ul className="mt-1 space-y-1 text-sm">
              {packet.receipts.map((receipt: any) => (
                <li key={receipt.id}>
                  <Link href={`/receipts/${receipt.id}`} className="text-slate-800 underline underline-offset-2">
                    {receipt.receivedDate}
                    {receipt.packingSlipNumber ? ` · packing slip ${receipt.packingSlipNumber}` : ''}
                    {receipt.receivedByName ? ` · signed by ${receipt.receivedByName}` : ''}
                    {receipt.isFinal ? ' · final' : ' · partial'}
                  </Link>
                </li>
              ))}
              {packet.receipts.length === 0 ? <li className="text-slate-500">No receipts recorded.</li> : null}
            </ul>

            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href={`/requests/${packet.request.id}`}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
              >
                Full history
              </Link>
              {packet.purchaseOrder?.documents?.[0] ? (
                <a
                  href={`/api/documents/${packet.purchaseOrder.documents[0].id}`}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800"
                >
                  Purchase order PDF
                </a>
              ) : null}
            </div>
          </Section>
        ))
      )}
    </div>
  );
}
