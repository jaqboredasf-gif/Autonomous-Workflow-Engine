/* eslint-disable @typescript-eslint/no-explicit-any */
// Request detail — the one page everybody shares. What it OFFERS comes from
// availableActions(), which is the same authorize() the server enforces with.
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { currentActor } from '../../../server/session.ts';
import { getDb } from '../../../server/db.ts';
import * as S from '../../../server/service.ts';
import Timeline from '../../../components/Timeline';
import { Money, Qty, ReadOnly, Section, StatusBadge, buttonClass, inputClass, secondaryButtonClass } from '../../../components/ui';
import {
  addNoteAction,
  answerClarificationAction,
  cancelRequestAction,
  completeRequestAction,
  generateEmailDraftAction,
  generatePoAction,
  markOrderedAction,
  submitRequestAction,
  updateTrackingAction,
} from '../../actions.ts';

export const dynamic = 'force-dynamic';

export default async function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  if (!actor) redirect('/signin');

  let detail: any;
  try {
    detail = S.getRequestDetail(S.context(getDb()), actor, id);
  } catch {
    notFound();
  }

  const r = detail.request;
  const can = (a: string) => detail.actions.includes(a);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{r.requestNumber}</h1>
          <p className="text-sm text-slate-600">
            Job {r.jobNumber} · raised by {r.requestorName}
            {r.approverName ? ` · reviewed by ${r.approverName}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={r.status} />
          {can('review') ? (
            <Link href={`/requests/${id}/review`} className={buttonClass}>
              Open workshop review
            </Link>
          ) : null}
        </div>
      </div>

      {r.status === 'CLARIFICATION_REQUESTED' ? (
        <Section title="The workshop asked a question" subtitle={r.clarificationQuestion ?? ''}>
          {can('respond') ? (
            <form action={answerClarificationAction} className="space-y-2">
              <input type="hidden" name="requestId" value={id} />
              <textarea name="answer" rows={3} className={inputClass} placeholder="Your answer…" />
              <button className={buttonClass}>Answer and resubmit</button>
            </form>
          ) : (
            <p className="text-sm text-slate-600">Waiting on {r.requestorName}.</p>
          )}
        </Section>
      ) : null}

      <Section title="Section A — the original request" subtitle="Exactly as submitted. Never overwritten.">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <ReadOnly label="Requestor" value={r.requestorName} />
          <ReadOnly label="Job number" value={r.jobNumber} />
          <ReadOnly label="Need by" value={`${r.needByDate} ${r.needByTime}`} />
          <ReadOnly label="Submitted" value={r.submittedAt ? String(r.submittedAt).slice(0, 16).replace('T', ' ') : '—'} />
          <ReadOnly label={r.deliveryMethod === 'PICKUP' ? 'Pick up from' : 'Deliver to'} value={r.deliveryLocationName} />
          <ReadOnly label="Reason" value={r.reason} />
          <ReadOnly label="Notes" value={r.notes} />
          <ReadOnly label="Attachments" value={detail.attachments.length || '—'} />
        </div>
        <table className="mt-4 min-w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
            <tr>
              <th className="py-2 pr-3">#</th>
              <th className="py-2 pr-3">Item</th>
              <th className="py-2 pr-3 text-right">Requested</th>
              <th className="py-2 pr-3">Unit</th>
              <th className="py-2 pr-3">Part no.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {detail.originalItems.map((i: any) => (
              <tr key={i.id}>
                <td className="py-2 pr-3">{i.lineNo}</td>
                <td className="py-2 pr-3">{i.description}</td>
                <td className="py-2 pr-3 text-right">
                  <Qty value={i.requestedQty} />
                </td>
                <td className="py-2 pr-3">{i.unit}</td>
                <td className="py-2 pr-3">{i.stockNumber ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {detail.reviewLines.some((l: any) => l.finalOrderQty > 0 || l.usableStockQty > 0) ? (
        <Section title="Section B — workshop and purchasing" subtitle="Recorded by the workshop. Separate from the request above.">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2 pr-3">Item</th>
                  <th className="py-2 pr-3 text-right">Requested</th>
                  <th className="py-2 pr-3 text-right">Stock</th>
                  <th className="py-2 pr-3 text-right">Approved</th>
                  <th className="py-2 pr-3 text-right">Suggested</th>
                  <th className="py-2 pr-3 text-right">Ordering</th>
                  <th className="py-2 pr-3">Vendor</th>
                  <th className="py-2 pr-3 text-right">Unit cost</th>
                  <th className="py-2 pr-3 text-right">Line total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {detail.reviewLines.map((l: any) => (
                  <tr key={l.requestItemId}>
                    <td className="py-2 pr-3">
                      {l.description}
                      {l.substituteDescription ? (
                        <span className="block text-xs text-slate-500">substitute: {l.substituteDescription}</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-right"><Qty value={l.requestedQty} /></td>
                    <td className="py-2 pr-3 text-right"><Qty value={l.usableStockQty} /></td>
                    <td className="py-2 pr-3 text-right"><Qty value={l.approvedQty} /></td>
                    <td className="py-2 pr-3 text-right text-slate-500"><Qty value={l.suggestedOrderQty} /></td>
                    <td className="py-2 pr-3 text-right font-medium">
                      <Qty value={l.finalOrderQty} />
                      {l.replenishmentQty > 0 ? (
                        <span className="block text-xs font-normal text-slate-500">
                          incl. <Qty value={l.replenishmentQty} /> for stock
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">{l.vendorName ?? '—'}</td>
                    <td className="py-2 pr-3 text-right"><Money cents={l.estimatedUnitCostCents} /></td>
                    <td className="py-2 pr-3 text-right"><Money cents={l.estimatedLineTotalCents} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200">
                  <td colSpan={8} className="py-2 pr-3 text-right text-sm font-medium">Estimated total</td>
                  <td className="py-2 pr-3 text-right text-sm font-semibold"><Money cents={r.estimatedTotalCents} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Section>
      ) : null}

      {detail.approvals.length ? (
        <Section title="Section C — decisions">
          <ul className="space-y-2 text-sm">
            {detail.approvals.map((a: any) => (
              <li key={a.id} className="rounded-md border border-slate-200 p-3">
                <div className="font-medium text-slate-900">
                  {a.decision} · {a.approverName} · {String(a.decidedAt).slice(0, 16).replace('T', ' ')}
                </div>
                {a.reason ? <div className="text-slate-700">Reason: {a.reason}</div> : null}
                {a.notes ? <div className="text-slate-600">Notes: {a.notes}</div> : null}
                {a.changes.length ? (
                  <ul className="mt-1 text-xs text-slate-600">
                    {a.changes.map((c: any, i: number) => (
                      <li key={i}>
                        Line {c.lineNo}: requested <Qty value={c.requestedQty} />, ordering <Qty value={c.finalOrderQty} />
                        {c.overrideReason ? ` — ${c.overrideReason}` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Processing" subtitle="Purchase order, vendor email, order and receiving.">
        <div className="flex flex-wrap gap-2">
          {can('submit') ? (
            <form action={submitRequestAction}>
              <input type="hidden" name="requestId" value={id} />
              <button className={buttonClass}>Submit to workshop</button>
            </form>
          ) : null}
          {can('generate_po') ? (
            <form action={generatePoAction}>
              <input type="hidden" name="requestId" value={id} />
              <button className={buttonClass}>Generate purchase order</button>
            </form>
          ) : null}
          {detail.purchaseOrder ? (
            <Link href={`/requests/${id}/po`} className={secondaryButtonClass}>
              View PO {detail.purchaseOrder.poNumber}
            </Link>
          ) : null}
          {can('draft_email') ? (
            <form action={generateEmailDraftAction}>
              <input type="hidden" name="requestId" value={id} />
              <button className={buttonClass}>Draft vendor email</button>
            </form>
          ) : null}
          {detail.emailDrafts.length ? (
            <Link href={`/requests/${id}/email`} className={secondaryButtonClass}>
              Review email draft
            </Link>
          ) : null}
          {can('mark_ordered') ? (
            <form action={markOrderedAction}>
              <input type="hidden" name="requestId" value={id} />
              <button className={buttonClass}>Mark ordered</button>
            </form>
          ) : null}
          {can('receive') ? (
            <Link href={`/requests/${id}/receive`} className={buttonClass}>
              Record receiving
            </Link>
          ) : null}
          {can('complete') ? (
            <form action={completeRequestAction}>
              <input type="hidden" name="requestId" value={id} />
              <button className={buttonClass}>Complete request</button>
            </form>
          ) : null}
        </div>

        {['ORDERED', 'PARTIALLY_RECEIVED', 'EMAIL_DRAFTED'].includes(r.status) && can('add_tracking') ? (
          <form action={updateTrackingAction} className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-4">
            <input type="hidden" name="requestId" value={id} />
            <input name="trackingNumber" className={inputClass} placeholder="Tracking number" defaultValue={r.trackingNumber ?? ''} />
            <input name="carrier" className={inputClass} placeholder="Carrier" defaultValue={r.trackingCarrier ?? ''} />
            <input type="date" name="expectedArrivalDate" className={inputClass} defaultValue={r.expectedArrivalDate ?? ''} />
            <button className={secondaryButtonClass}>Save tracking</button>
          </form>
        ) : null}

        {detail.progress.length ? (
          <table className="mt-4 min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
              <tr>
                <th className="py-2 pr-3">Item</th>
                <th className="py-2 pr-3 text-right">Ordered</th>
                <th className="py-2 pr-3 text-right">Received</th>
                <th className="py-2 pr-3 text-right">Damaged</th>
                <th className="py-2 pr-3 text-right">Backordered</th>
                <th className="py-2 pr-3 text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detail.progress.map((p: any) => (
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
        ) : null}
      </Section>

      <Section title="Activity" subtitle="Every meaningful action, with who did it and when.">
        <Timeline entries={detail.timeline} />
        <form action={addNoteAction} className="mt-4 flex gap-2">
          <input type="hidden" name="requestId" value={id} />
          <input name="note" className={inputClass} placeholder="Add a note to the record…" />
          <button className={secondaryButtonClass}>Add note</button>
        </form>
      </Section>

      {can('cancel') || can('cancel_any') ? (
        <form action={cancelRequestAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="requestId" value={id} />
          <input name="reason" className={`${inputClass} max-w-sm`} placeholder="Reason for cancelling" />
          <button className="rounded-md border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700">
            Cancel request
          </button>
        </form>
      ) : null}
    </div>
  );
}
