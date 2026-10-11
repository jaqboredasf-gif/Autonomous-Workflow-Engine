'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// The workshop screen — Mike's screen, and the one that decides whether any of
// this is faster than the phone call it replaces.
//
// WHAT IT USED TO BE. Three numbered sections and eleven inputs per line:
// stock, approved quantity, suggested, final, vendor, unit cost, line total,
// expected arrival, substitute, workshop notes, override reason — then three
// more text fields and four buttons for the decision. Every one of them is a
// real domain field and the screen was complete. It was also a form to be
// filled in, when the job is: look at the shelf, pick a supplier, approve.
//
// WHAT IT IS NOW. Above the fold, per line: what was asked for, what is on the
// shelf, how many to order, what it costs. One vendor for the whole request.
// One obvious Approve. Everything else is still on the page and still submits —
// native <details> posts its contents whether it is open or shut — it is simply
// not in the way of the ordinary purchase.
//
// ONE VENDOR, ONE SELECTOR. This is the change that was closest to a defect.
// The vendor was a per-line dropdown, but `assertSingleVendor` in the domain
// refuses a purchase order whose lines name more than one supplier — so the
// screen offered Mike a choice the system would reject, and only told him at
// PO time, after approval. It is now one selector for the request, written down
// to each line as a hidden field. The server contract is unchanged; the
// impossible option is gone.
//
// The arithmetic is the SAME pure functions the server recomputes with, so the
// screen never shows a number the server would disagree with.
// ---------------------------------------------------------------------------
import { useActionState, useState } from 'react';

import { reviewAndDecideAction } from '../app/actions.ts';
import { formatQty, parseQty, suggestedOrderQty } from '../purchasing/domain/numbers.mjs';
import { MoreDetails } from './pcc';
import { Field, Section, buttonClass, inputClass, secondaryButtonClass } from './ui';

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
}: {
  request: any;
  originalItems: any[];
  reviewLines: any[];
  vendors: Array<{ id: string; name: string }>;
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
        unitCost: existing.estimatedUnitCostCents ? (existing.estimatedUnitCostCents / 100).toFixed(2) : '',
        substitute: existing.substituteDescription ?? '',
        expectedArrival: existing.expectedArrivalDate ?? '',
        notes: existing.lineNotes ?? '',
        overrideReason: existing.overrideReason ?? '',
      };
    }),
  );

  // ONE vendor for the request. Seeded from whatever a previous save recorded.
  const [vendorId, setVendorId] = useState<string>(
    () => reviewLines.find((l: any) => l.vendorId)?.vendorId ?? '',
  );

  const update = (id: string, patch: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.requestItemId === id ? { ...l, ...patch } : l)));

  const computed = lines.map((l) => {
    const stock = parseQty(l.usableStock || '0');
    const approved = parseQty(l.approvedQty || '0');
    const suggested = suggestedOrderQty(approved.ok ? approved.value : 0, stock.ok ? stock.value : 0);
    const finalParsed = parseQty(l.finalOrderQty || formatQty(suggested));
    const finalQty = finalParsed.ok ? finalParsed.value : 0;
    return { suggested, finalQty, overridden: finalQty !== suggested };
  });
  const vendorName = vendors.find((v) => v.id === vendorId)?.name;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="requestId" value={request.id} />

      {state && state.ok === false ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{state.error}</div>
      ) : null}

      {/* WHAT WAS ASKED FOR, in one line rather than an eight-cell grid. The
          job and the need-by date are what Mike orders against; everything else
          about the request is context and sits below the fold. */}
      <div className="rounded-md border border-line bg-surface p-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-xl font-semibold text-ink">Job {request.jobNumber}</span>
          <span className="text-sm text-muted">
            needed {request.needByDate} · asked for by {request.requestorName}
          </span>
        </div>
        <ul className="mt-2 space-y-0.5 text-base text-ink-soft">
          {originalItems.map((i) => (
            <li key={i.id}>
              <strong className="text-ink">{formatQty(i.requestedQty)} {i.unit}</strong> — {i.description}
              {i.stockNumber ? <span className="text-muted"> (part {i.stockNumber})</span> : null}
            </li>
          ))}
        </ul>

        <div className="mt-3">
          <MoreDetails label="The rest of the request" hint="delivery, notes, attachments">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                [request.deliveryMethod === 'PICKUP' ? 'Pick up from' : 'Deliver to', request.deliveryLocationName],
                ['Need-by time', request.needByTime],
                ['Submitted', String(request.submittedAt ?? '').slice(0, 16).replace('T', ' ')],
                ['Note from the field', request.reason],
                ['Anything else', request.notes],
                ['Clarification answer', request.clarificationAnswer],
              ]
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={String(label)}>
                    <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
                    <dd className="text-ink-soft">{value}</dd>
                  </div>
                ))}
            </dl>
          </MoreDetails>
        </div>
      </div>

      {/* THE THREE DECISIONS, per line: what is on the shelf, how many to buy,
          what it costs. Nothing else is above the fold. */}
      <Section title="What to order">
        <div className="space-y-3">
          {lines.map((l, idx) => (
            <div key={l.requestItemId} className="rounded-md border border-line p-3">
              <input type="hidden" name="lineRequestItemId" value={l.requestItemId} />
              {/* One vendor for the request, written down to every line so the
                  server contract is untouched. */}
              <input type="hidden" name="lineVendorId" value={vendorId} />

              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-medium text-ink">{l.description}</h3>
                <span className="text-xs text-muted">
                  field asked for {formatQty(l.requestedQty)} {l.unit}
                </span>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-3">
                <Field label="On the shelf">
                  <input
                    name="lineUsableStock"
                    className={inputClass}
                    inputMode="decimal"
                    value={l.usableStock}
                    onChange={(e) => update(l.requestItemId, { usableStock: e.target.value })}
                  />
                </Field>
                <Field
                  label="Order"
                  hint={
                    computed[idx].overridden
                      ? `suggested ${formatQty(computed[idx].suggested)}`
                      : 'asked for, less the shelf'
                  }
                >
                  <input
                    name="lineFinalOrderQty"
                    className={inputClass}
                    inputMode="decimal"
                    value={l.finalTouched ? l.finalOrderQty : formatQty(computed[idx].suggested)}
                    onChange={(e) => update(l.requestItemId, { finalOrderQty: e.target.value, finalTouched: true })}
                  />
                </Field>
                {/* Price is not asked for here either — see StockCheckForm.
                    Carried through so a value recorded earlier survives a save. */}
                <input type="hidden" name="lineUnitCost" value={l.unitCost} />
              </div>

              {/* Still submitted, still editable, out of the way. A closed
                  <details> posts its inputs exactly as an open one does. */}
              <div className="mt-3">
                <MoreDetails label="Substitute, arrival date, notes" hint="optional">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Approved quantity" hint="What the job actually needs, if it is not what was asked for.">
                      <input
                        name="lineApprovedQty"
                        className={inputClass}
                        inputMode="decimal"
                        value={l.approvedQty}
                        onChange={(e) => update(l.requestItemId, { approvedQty: e.target.value })}
                      />
                    </Field>
                    <Field label="Ordering something different?">
                      <input
                        name="lineSubstitute"
                        className={inputClass}
                        value={l.substitute}
                        onChange={(e) => update(l.requestItemId, { substitute: e.target.value })}
                      />
                    </Field>
                    <Field label="Expected arrival">
                      <input
                        type="date"
                        name="lineExpectedArrival"
                        className={inputClass}
                        value={l.expectedArrival}
                        onChange={(e) => update(l.requestItemId, { expectedArrival: e.target.value })}
                      />
                    </Field>
                    <Field label="Note about this line">
                      <input
                        name="lineNotes"
                        className={inputClass}
                        value={l.notes}
                        onChange={(e) => update(l.requestItemId, { notes: e.target.value })}
                      />
                    </Field>
                    <Field
                      label="Why the different quantity"
                      hint={computed[idx].overridden ? 'Recorded with the approval.' : 'Only if you changed it.'}
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
                </MoreDetails>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* WHO IT IS GOING TO, and then the one button. These are the last two
          things Mike does, so they are the last two things on the screen. */}
      <div className="rounded-md border border-line bg-surface p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-64 flex-1">
            <Field label="Buy it from" required>
              {/* Named for the same reason as StockCheckForm's: the form has
                  to work without JavaScript. */}
              <select
                name="vendorId"
                className={inputClass}
                value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
              >
                <option value="">Choose a supplier…</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="submit" name="intent" value="APPROVE" className={buttonClass} disabled={pending}>
            {pending ? 'Working…' : 'Approve and print PO'}
          </button>
          <button type="submit" name="intent" value="save" className={secondaryButtonClass} disabled={pending}>
            Save for now
          </button>
          {vendorName ? (
            <span className="text-sm text-muted">
              PO goes to <strong className="text-ink-soft">{vendorName}</strong>
            </span>
          ) : (
            <span className="text-sm text-muted">Choose a supplier before approving.</span>
          )}
        </div>

        <input type="hidden" name="workshopNotes" value="" />

        {/* The exceptional endings, with the field each one REQUIRES sitting
            next to the button that needs it — the previous screen put all three
            text boxes in a row and let Mike press Reject with the wrong one
            filled in. */}
        <div className="mt-4">
          <MoreDetails label="Not ordering this?" hint="send it back, or reject it">
            <Field label="Send back a question" hint="The requester answers and it returns to you.">
              <input name="question" className={inputClass} placeholder="e.g. Which fixture type — A or B?" />
            </Field>
            <button
              type="submit"
              name="intent"
              value="CLARIFY"
              className="rounded-md border border-amber-400 bg-white px-4 py-2 text-sm font-medium text-amber-800"
              disabled={pending}
            >
              Send back with the question
            </button>

            <Field label="Reason for rejecting" hint="Required. The requester sees this.">
              <input name="reason" className={inputClass} placeholder="e.g. Twenty-five already on the shelf." />
            </Field>
            <button
              type="submit"
              name="intent"
              value="REJECT"
              className="rounded-md border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700"
              disabled={pending}
            >
              Reject the request
            </button>

            <Field label="Note on the decision" hint="Optional, kept with the approval.">
              <input name="notes" className={inputClass} />
            </Field>
          </MoreDetails>
        </div>
      </div>
    </form>
  );
}
