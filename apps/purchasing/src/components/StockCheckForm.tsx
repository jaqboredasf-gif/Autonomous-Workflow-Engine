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
// The other seven fields are not deleted — they are behind "More", they keep
// their columns, their validation and their audit, and the office still uses
// them. Hidden, not removed: that distinction is the whole design.
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
            Type how many you already have. We work out what to buy.
          </p>
        </div>

        <ul className="divide-y divide-line">
          {lines.map((line) => {
            const toOrder = orderQtyFor(line);
            return (
              <li key={line.requestItemId} className="p-4">
                <input type="hidden" name="lineRequestItemId" value={line.requestItemId} />
                {/* The approved quantity is not asked for: the workshop approves what
                    the field asked for unless somebody says otherwise, and the server
                    defaults it the same way. */}
                <input type="hidden" name="lineFinalOrderQty" value={formatQty(toOrder)} />

                <p className="text-base font-medium text-ink">{line.description}</p>

                <div className="mt-3 grid grid-cols-3 items-end gap-3">
                  <div>
                    <span className="block text-xs font-medium uppercase tracking-wide text-muted">Asked for</span>
                    <span className="mt-1 block text-xl font-semibold tabular-nums text-ink">
                      {formatQty(line.requestedQty)}{' '}
                      <span className="text-sm font-normal text-muted">{line.unit}</span>
                    </span>
                  </div>

                  <label className="block">
                    <span className="block text-xs font-medium uppercase tracking-wide text-muted">In the shop</span>
                    <input
                      name="lineUsableStock"
                      value={line.stock}
                      onChange={(e) => update(line.requestItemId, { stock: e.target.value })}
                      inputMode="decimal"
                      // A phone keyboard and a thumb: this is counted standing at a
                      // shelf, not typed at a desk.
                      className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-xl tabular-nums text-ink focus:border-accent focus:outline-none"
                      placeholder="0"
                      aria-label={`Stock in the shop for ${line.description}`}
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
                      <span className="mt-1 block text-[11px] text-muted">asked for − in the shop</span>
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
                {toOrder > 0 ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs">
                      <span className="text-muted">Buying it from</span>
                      <select
                        name="lineVendorId"
                        value={line.vendorId}
                        onChange={(e) => update(line.requestItemId, { vendorId: e.target.value })}
                        className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm text-ink"
                      >
                        <option value="">Choose a vendor…</option>
                        {vendors.map((v) => (
                          <option key={v.id} value={v.id}>{v.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs">
                      <span className="text-muted">Price each</span>
                      <input
                        name="lineUnitCost" value={line.unitCost} inputMode="decimal" placeholder="0.00"
                        onChange={(e) => update(line.requestItemId, { unitCost: e.target.value })}
                        className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-sm tabular-nums text-ink"
                      />
                    </label>
                  </div>
                ) : (
                  <>
                    <input type="hidden" name="lineVendorId" value={line.vendorId} />
                    <input type="hidden" name="lineUnitCost" value={line.unitCost} />
                  </>
                )}

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
