'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// StockCheckForm — the purchaser's screen, after the pilot.
//
// WHAT THE PILOT FOUND. The review screen asked for nine values per line:
// usable stock, approved quantity, final order quantity, vendor, unit cost,
// expected arrival, substitute, notes, override reason. The purchaser's actual
// job at that moment is ONE of them: he walks to the shelf, counts what is
// there, and the difference is what he buys. Everything else was a field he had
// to skip past, and skipping past eight fields to reach the one that matters is
// how software teaches somebody that it was not built for them.
//
// So: ONE input per line. Stock. The quantity to order is derived in front of
// him and stays editable, because sometimes he buys a full box anyway.
//
// THREE QUANTITIES, AND THEY STAY THREE.
//
//   job needs        what the field asked for — never altered by anything here
//   workshop stock   what Mike counted on the shelf
//   to order         max(job needs − workshop stock, 0)
//
// Workshop stock is NOT a receipt. Nothing has arrived; this is material
// Lippolis already owned. Typing 2 here does not turn a request for 10 into a
// request for 8 — the job still needs 10, and the record still says so.
//
// The other seven fields are not deleted — they are behind "More", they keep
// their columns, their validation and their audit, and the office still uses
// them. Hidden, not removed: that distinction is the whole design.
//
// NO PRICE FIELD. It was here because the domain refused to order a line
// without one; it no longer does. Mike does not estimate cost — the vendor
// bills, accounting reconciles, and `recordActualCost` is where that lands.
//
// ONE SUPPLIER, ONE SELECTOR. The vendor used to be a dropdown per line, which
// let the purchaser pick two suppliers for one purchase order — something the
// domain refuses, and refused only after the approval had been recorded. It is
// now asked once, above the button.
//
// THE ARITHMETIC IS THE DOMAIN'S. `suggestedOrderQty` is the same pure function
// the server recomputes with, so the number he sees before pressing the button
// is the number that gets written. This screen shows it sooner; it never
// invents it.
// ---------------------------------------------------------------------------
import { useActionState, useState } from 'react';

import { approveAndCreatePoAction } from '../app/actions.ts';
import { formatQty, parseQty, suggestedOrderQty } from '../purchasing/domain/numbers.mjs';
import { Alert, Button } from './pcc';

type Line = {
  requestItemId: string;
  lineNo: number;
  description: string;
  unit: string;
  requestedQty: number;
  stock: string;
  toOrder: string;
  /** True once he types a quantity himself, so the derived value stops overwriting it. */
  overridden: boolean;
  vendorId: string;
  unitCost: string;
  substitute: string;
  notes: string;
};

export default function StockCheckForm({
  request,
  items,
  reviewLines,
  vendors,
}: {
  request: any;
  items: any[];
  reviewLines: any[];
  vendors: Array<{ id: string; name: string }>;
}) {
  const [state, formAction, pending] = useActionState(approveAndCreatePoAction, null as any);
  const [advanced, setAdvanced] = useState(false);
  // ONE SUPPLIER FOR THE REQUEST, not one per line.
  //
  // The domain refuses a purchase order whose lines name more than one vendor
  // (`assertSingleVendor`), so a dropdown on every line offered a choice the
  // system would reject — and rejected it at PO time, AFTER the approval, with
  // an error about a milestone limitation. Whatever a previous save recorded
  // seeds it; every line posts it as a hidden field, so the server contract is
  // untouched and the impossible option is gone.
  const [vendorId, setVendorId] = useState<string>(
    () => reviewLines.find((l: any) => l.vendorId)?.vendorId ?? '',
  );
  const [lines, setLines] = useState<Line[]>(() =>
    items.map((item) => {
      const saved = reviewLines.find((l) => l.requestItemId === item.id) ?? {};
      return {
        requestItemId: item.id,
        lineNo: item.lineNo,
        description: item.description,
        unit: item.unit,
        requestedQty: item.requestedQty,
        stock: saved.usableStockQty ? formatQty(saved.usableStockQty) : '',
        toOrder: saved.finalOrderQty ? formatQty(saved.finalOrderQty) : '',
        overridden: Boolean(saved.finalOrderQty),
        vendorId: saved.vendorId ?? '',
        unitCost: saved.estimatedUnitCostCents ? (saved.estimatedUnitCostCents / 100).toFixed(2) : '',
        substitute: saved.substituteDescription ?? '',
        notes: saved.lineNotes ?? '',
      };
    }),
  );

  const update = (id: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.requestItemId === id ? { ...l, ...patch } : l)));

  /** What each line will order: derived from the count, unless he said otherwise. */
  const orderQtyFor = (line: Line) => {
    if (line.overridden) {
      const typed = parseQty(line.toOrder || '0');
      return typed.ok ? typed.value : 0;
    }
    const stock = parseQty(line.stock || '0');
    return suggestedOrderQty(line.requestedQty, stock.ok ? stock.value : 0);
  };

  const totalToOrder = lines.reduce((n, l) => n + (orderQtyFor(l) > 0 ? 1 : 0), 0);
  const nothingToOrder = totalToOrder === 0;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="requestId" value={request.id} />

      {state && state.ok === false ? <Alert tone="danger" title="That did not save">{state.error}</Alert> : null}

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Check the shelf</h2>
          <p className="text-xs text-muted">
            Type how many are already in the workshop. What to order works itself out — the job still needs the
            full amount, and PCC only buys the difference.
          </p>
        </div>

        <ul className="divide-y divide-line">
          {lines.map((line) => {
            const toOrder = orderQtyFor(line);
            return (
              <li key={line.requestItemId} className="p-4">
                <input type="hidden" name="lineRequestItemId" value={line.requestItemId} />
                {/* THE SERVER DOES THE ARITHMETIC, not this page.
                    
                    A blank final quantity means "however much the shelf leaves
                    short", and `saveWorkshopReview` computes exactly that from
                    the stock figure. So nothing is posted unless the purchaser
                    typed a quantity of his own.

                    This used to post a hidden value React had computed, which
                    is correct in a hydrated browser and silently wrong in one
                    where the JavaScript has not run: the field held its
                    server-rendered value — the full requested amount — so a
                    shelf count of 2 against a job needing 10 ordered 10. Wrong
                    quantity, no error, on a purchase order sent to a supplier.
                    The approved quantity is not asked for at all; the workshop
                    approves what the field asked for unless somebody says
                    otherwise, and the server defaults that the same way. */}
                {line.overridden ? (
                  <input type="hidden" name="lineFinalOrderQty" value={line.toOrder} />
                ) : (
                  <input type="hidden" name="lineFinalOrderQty" value="" />
                )}

                <p className="text-base font-medium text-ink">{line.description}</p>

                <div className="mt-3 grid grid-cols-3 items-end gap-3">
                  <div>
                    <span className="block text-xs font-medium uppercase tracking-wide text-muted">Job needs</span>
                    <span className="mt-1 block text-xl font-semibold tabular-nums text-ink">
                      {formatQty(line.requestedQty)}{' '}
                      <span className="text-sm font-normal text-muted">{line.unit}</span>
                    </span>
                  </div>

                  <label className="block">
                    <span className="block text-xs font-medium uppercase tracking-wide text-muted">Workshop stock</span>
                    <input
                      name="lineUsableStock"
                      value={line.stock}
                      onChange={(e) => update(line.requestItemId, { stock: e.target.value })}
                      inputMode="decimal"
                      // A phone keyboard and a thumb: this is counted standing at a
                      // shelf, not typed at a desk.
                      className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-xl tabular-nums text-ink focus:border-accent focus:outline-none"
                      placeholder="0"
                      aria-label={`Workshop stock for ${line.description}`}
                    />
                  </label>

                  <div>
                    <span className="block text-xs font-medium uppercase tracking-wide text-muted">To order</span>
                    <input
                      value={line.overridden ? line.toOrder : formatQty(toOrder)}
                      onChange={(e) => update(line.requestItemId, { toOrder: e.target.value, overridden: true })}
                      inputMode="decimal"
                      className={`mt-1 w-full rounded-md border px-3 py-2 text-xl font-semibold tabular-nums focus:outline-none ${
                        toOrder > 0
                          ? 'border-accent/40 bg-accent/5 text-ink focus:border-accent'
                          : 'border-line bg-canvas text-muted focus:border-accent'
                      }`}
                      aria-label={`Quantity to order for ${line.description}`}
                    />
                    {line.overridden ? (
                      <button
                        type="button"
                        onClick={() => update(line.requestItemId, { overridden: false, toOrder: '' })}
                        className="mt-1 text-[11px] text-accent underline"
                      >
                        use {formatQty(orderQtyFor({ ...line, overridden: false }))} instead
                      </button>
                    ) : (
                      <span className="mt-1 block text-[11px] text-muted">job needs − workshop stock</span>
                    )}
                  </div>
                </div>

                {/* VENDOR AND COST STAY VISIBLE, and that is a deliberate
                    retreat from "one field per line". The domain refuses to
                    order a line without them (application/decisions.ts), and it
                    is right to: a purchase order with no supplier and no price
                    is not a purchase order. Hiding them behind "More" made the
                    single button fail with a validation error the purchaser had
                    no way to see the cause of — worse than asking for two more
                    values. Only lines actually being ordered need them. */}
                {/* The supplier is chosen once, below. Every line carries it so
                    the server sees exactly what it saw before. */}
                <input type="hidden" name="lineVendorId" value={toOrder > 0 ? vendorId : ''} />

                {/* NO PRICE. Lippolis does not price a purchase order when it
                    raises one — the vendor's invoice arrives later and
                    accounting reconciles it. Whatever a previous save recorded
                    is carried through untouched rather than blanked. */}
                <input type="hidden" name="lineUnitCost" value={line.unitCost} />

                {advanced ? (
                  <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
                    <label className="block text-xs">
                      <span className="text-muted">Substitute</span>
                      <input
                        name="lineSubstitute" value={line.substitute}
                        onChange={(e) => update(line.requestItemId, { substitute: e.target.value })}
                        className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
                      />
                    </label>
                    <label className="block text-xs">
                      <span className="text-muted">Note</span>
                      <input
                        name="lineNotes" value={line.notes}
                        onChange={(e) => update(line.requestItemId, { notes: e.target.value })}
                        className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
                      />
                    </label>
                  </div>
                ) : (
                  <>
                    {/* The advanced fields still POST when hidden, so opening the
                        panel is not required to preserve what was saved before. */}
                    <input type="hidden" name="lineSubstitute" value={line.substitute} />
                    <input type="hidden" name="lineNotes" value={line.notes} />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="text-sm text-muted underline decoration-dotted underline-offset-4"
        >
          {advanced ? 'Hide' : 'More'} — substitutes and notes
        </button>
        <p className="text-sm text-muted" role="status">
          {nothingToOrder
            ? 'Everything is in stock — nothing to buy.'
            : `${totalToOrder} of ${lines.length} ${lines.length === 1 ? 'line' : 'lines'} to buy.`}
        </p>
      </div>

      {/* WHO IT IS GOING TO — one answer for the whole purchase order, sitting
          directly above the button that sends it. Only shown when something is
          actually being bought; a request filled entirely from stock has no
          supplier to choose. */}
      {nothingToOrder ? null : (
        <div className="rounded-lg border border-line bg-surface p-4">
          <label className="block">
            <span className="block text-xs font-medium uppercase tracking-wide text-muted">Buying it from</span>
            {/* NAMED, so the form works as plain HTML. The per-line hidden
                inputs below mirror this for the server's positional parser —
                but they are written by React, and a page whose JavaScript has
                not hydrated would post an empty vendor and fail approval with a
                message about a missing supplier the purchaser had just chosen.
                The server prefers this field when it is present. */}
            <select
              name="vendorId"
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-base text-ink sm:max-w-sm"
              aria-label="Supplier for this purchase order"
            >
              <option value="">Choose a supplier…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-xs text-muted">One supplier per purchase order.</p>
        </div>
      )}

      {/* ONE BUTTON. It approves, creates the purchase order and opens the
          printable sheet — three operations he used to perform by hand, each
          still checked and audited exactly as before. */}
      <Button type="submit" size="l" disabled={pending} className="w-full sm:w-auto">
        {pending ? 'Working…' : 'Approve and print PO'}
      </Button>

      {nothingToOrder ? (
        <p className="text-xs text-muted">
          You can still approve with nothing to order — the request is recorded as filled
          from stock, which is exactly what happened.
        </p>
      ) : null}
    </form>
  );
}
