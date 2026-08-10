'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// The workshop approval screen: Section A read-only, Section B editable,
// Section C the decision. The arithmetic shown here is the SAME pure functions
// the server recomputes with — the screen never invents a number the server
// would disagree with, it just shows it sooner.
import { useActionState, useState } from 'react';

import { reviewAndDecideAction } from '../app/actions.ts';
import { formatMoney, formatQty, lineTotalCents, parseMoney, parseQty, suggestedOrderQty } from '../purchasing/domain/numbers.mjs';
import { Field, ReadOnly, Section, buttonClass, inputClass, secondaryButtonClass } from './ui';

type LineState = {
  requestItemId: string;
  lineNo: number;
  description: string;
  unit: string;
  requestedQty: number;
  usableStock: string;
  approvedQty: string;
  finalOrderQty: string;
  finalTouched: boolean;
  vendorId: string;
  unitCost: string;
  substitute: string;
  expectedArrival: string;
  notes: string;
  overrideReason: string;
};

export default function ReviewForm({
  request,
  originalItems,
  reviewLines,
  vendors,
  materialHistory,
}: {
  request: any;
  originalItems: any[];
  reviewLines: any[];
  vendors: Array<{ id: string; name: string }>;
  materialHistory: Record<string, any>;
}) {
  const [state, formAction, pending] = useActionState(reviewAndDecideAction, null as any);
  const [lines, setLines] = useState<LineState[]>(() =>
    originalItems.map((item) => {
      const existing = reviewLines.find((l) => l.requestItemId === item.id) ?? {};
      return {
        requestItemId: item.id,
        lineNo: item.lineNo,
        description: item.description,
        unit: item.unit,
        requestedQty: item.requestedQty,
        usableStock: existing.usableStockQty ? formatQty(existing.usableStockQty) : '0',
        approvedQty: formatQty(existing.approvedQty ?? item.requestedQty),
        finalOrderQty: existing.finalOrderQty ? formatQty(existing.finalOrderQty) : '',
        finalTouched: Boolean(existing.finalOrderQty),
        vendorId: existing.vendorId ?? '',
        unitCost: existing.estimatedUnitCostCents ? (existing.estimatedUnitCostCents / 100).toFixed(2) : '',
        substitute: existing.substituteDescription ?? '',
        expectedArrival: existing.expectedArrivalDate ?? '',
        notes: existing.lineNotes ?? '',
        overrideReason: existing.overrideReason ?? '',
      };
    }),
  );

  const update = (id: string, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.requestItemId === id ? { ...l, ...patch } : l)));

  const computed = lines.map((l) => {
    const stock = parseQty(l.usableStock || '0');
    const approved = parseQty(l.approvedQty || '0');
    const suggested = suggestedOrderQty(approved.ok ? approved.value : 0, stock.ok ? stock.value : 0);
    const finalParsed = parseQty(l.finalOrderQty || formatQty(suggested));
    const finalQty = finalParsed.ok ? finalParsed.value : 0;
    const cost = parseMoney(l.unitCost || '0');
    return {
      suggested,
      finalQty,
      total: lineTotalCents(cost.ok ? cost.value : 0, finalQty),
      overridden: finalQty !== suggested,
    };
  });
  const estimatedTotal = computed.reduce((t, c) => t + c.total, 0);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="requestId" value={request.id} />

      {state && state.ok === false ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{state.error}</div>
      ) : null}

      <Section title="Section A — the original request" subtitle="Read-only. Nothing below can change it.">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <ReadOnly label="Requestor" value={request.requestorName} />
          <ReadOnly label="Job number" value={request.jobNumber} />
          <ReadOnly label="Need by" value={`${request.needByDate} ${request.needByTime}`} />
          <ReadOnly label="Submitted" value={String(request.submittedAt ?? '').slice(0, 16).replace('T', ' ')} />
          <ReadOnly
            label={request.deliveryMethod === 'PICKUP' ? 'Pick up from' : 'Deliver to'}
            value={request.deliveryLocationName}
          />
          <ReadOnly label="Reason" value={request.reason} />
          <ReadOnly label="Notes" value={request.notes} />
          <ReadOnly label="Clarification answer" value={request.clarificationAnswer} />
        </div>
        <ul className="mt-3 space-y-1 text-sm text-slate-800">
          {originalItems.map((i) => (
            <li key={i.id}>
              Line {i.lineNo}: <strong>{formatQty(i.requestedQty)} {i.unit}</strong> — {i.description}
              {i.stockNumber ? ` (part ${i.stockNumber})` : ''}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Section B — workshop and purchasing"
        subtitle="Stock, vendor, cost and how much to actually order."
      >
        <div className="space-y-4">
          {lines.map((l, idx) => (
            <div key={l.requestItemId} className="rounded-md border border-slate-200 p-3">
              <input type="hidden" name="lineRequestItemId" value={l.requestItemId} />
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium text-slate-900">
                  Line {l.lineNo}: {l.description}
                </h3>
                <span className="text-xs text-slate-500">
                  field requested {formatQty(l.requestedQty)} {l.unit}
                </span>
              </div>

              {materialHistory[l.requestItemId] ? (
                <div className="mt-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-950">
                  Last ordered from <strong>{materialHistory[l.requestItemId].lastVendorNameSnapshot}</strong>
                  {' on '}{String(materialHistory[l.requestItemId].lastOrderedAt).slice(0, 10)}
                  {materialHistory[l.requestItemId].lastUnitPriceCents === null
                    ? ''
                    : ` at ${formatMoney(materialHistory[l.requestItemId].lastUnitPriceCents)}`}
                  {' · '}{materialHistory[l.requestItemId].completedOrderCount} completed order(s)
                  {materialHistory[l.requestItemId].commonQuantity === null
                    ? ''
                    : ` · common quantity ${formatQty(materialHistory[l.requestItemId].commonQuantity)}`}
                </div>
              ) : (
                <div className="mt-2 text-xs text-slate-500">No completed purchase history for this material yet.</div>
              )}

              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Usable stock in workshop" required>
                  <input
                    name="lineUsableStock"
                    className={inputClass}
                    inputMode="decimal"
                    value={l.usableStock}
                    onChange={(e) => update(l.requestItemId, { usableStock: e.target.value })}
                  />
                </Field>
                <Field label="Approved quantity needed">
                  <input
                    name="lineApprovedQty"
                    className={inputClass}
                    inputMode="decimal"
                    value={l.approvedQty}
                    onChange={(e) => update(l.requestItemId, { approvedQty: e.target.value })}
                  />
                </Field>
                <div>
                  <span className="mb-1 block text-xs font-medium text-slate-700">Suggested to order</span>
                  <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-base tabular-nums text-slate-700">
                    {formatQty(computed[idx].suggested)}
                  </div>
                  <span className="mt-1 block text-xs text-slate-500">approved − stock, never below zero</span>
                </div>
                <Field label="Final quantity to order" hint="Override the suggestion to restock the workshop.">
                  <input
                    name="lineFinalOrderQty"
                    className={inputClass}
                    inputMode="decimal"
                    value={l.finalTouched ? l.finalOrderQty : formatQty(computed[idx].suggested)}
                    onChange={(e) => update(l.requestItemId, { finalOrderQty: e.target.value, finalTouched: true })}
                  />
                </Field>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Vendor">
                  <select
                    name="lineVendorId"
                    className={inputClass}
                    value={l.vendorId}
                    onChange={(e) => update(l.requestItemId, { vendorId: e.target.value })}
                  >
                    <option value="">Choose a vendor…</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Estimated unit cost">
                  <input
                    name="lineUnitCost"
                    className={inputClass}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={l.unitCost}
                    onChange={(e) => update(l.requestItemId, { unitCost: e.target.value })}
                  />
                </Field>
                <div>
                  <span className="mb-1 block text-xs font-medium text-slate-700">Estimated line total</span>
                  <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-base tabular-nums text-slate-900">
                    {formatMoney(computed[idx].total)}
                  </div>
                </div>
                <Field label="Expected vendor arrival">
                  <input
                    type="date"
                    name="lineExpectedArrival"
                    className={inputClass}
                    value={l.expectedArrival}
                    onChange={(e) => update(l.requestItemId, { expectedArrival: e.target.value })}
                  />
                </Field>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Substitute item" hint="If you are ordering something different.">
                  <input
                    name="lineSubstitute"
                    className={inputClass}
                    value={l.substitute}
                    onChange={(e) => update(l.requestItemId, { substitute: e.target.value })}
                  />
                </Field>
                <Field label="Workshop notes">
                  <input
                    name="lineNotes"
                    className={inputClass}
                    value={l.notes}
                    onChange={(e) => update(l.requestItemId, { notes: e.target.value })}
                  />
                </Field>
                <Field
                  label="Why the override"
                  hint={computed[idx].overridden ? 'Recorded with the approval.' : 'Only needed if you change the suggestion.'}
                >
                  <input
                    name="lineOverrideReason"
                    className={inputClass}
                    value={l.overrideReason}
                    onChange={(e) => update(l.requestItemId, { overrideReason: e.target.value })}
                    placeholder={computed[idx].overridden ? 'e.g. four spare back into stock' : ''}
                  />
                </Field>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3">
          <Field label="Workshop notes for this request">
            <input name="workshopNotes" className={`${inputClass} sm:w-96`} />
          </Field>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-slate-500">Estimated total</div>
            <div className="text-xl font-semibold tabular-nums">{formatMoney(estimatedTotal)}</div>
          </div>
        </div>
      </Section>

      <Section title="Section C — decision" subtitle="Approve, reject, or send it back with a question.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Decision notes">
            <input name="notes" className={inputClass} />
          </Field>
          <Field label="Reason (required to reject)">
            <input name="reason" className={inputClass} />
          </Field>
          <Field label="Question (required to send back)">
            <input name="question" className={inputClass} />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="submit" name="intent" value="save" className={secondaryButtonClass} disabled={pending}>
            Save review
          </button>
          <button type="submit" name="intent" value="APPROVE" className={buttonClass} disabled={pending}>
            Approve
          </button>
          <button
            type="submit"
            name="intent"
            value="CLARIFY"
            className="rounded-md border border-amber-400 bg-white px-4 py-2 text-sm font-medium text-amber-800"
            disabled={pending}
          >
            Return for clarification
          </button>
          <button
            type="submit"
            name="intent"
            value="REJECT"
            className="rounded-md border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700"
            disabled={pending}
          >
            Reject
          </button>
        </div>
      </Section>
    </form>
  );
}
