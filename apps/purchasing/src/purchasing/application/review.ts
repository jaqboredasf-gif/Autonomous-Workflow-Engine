/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// review.ts — the workshop's use cases.
//
//   reviewWorkshopStock  — record what is actually on the shelf
//   selectVendorAndPricing — choose the supplier and the estimated cost
//
// Both are served by ONE transaction (`saveWorkshopReview`) because that is how
// Mike works: he counts the shelf, decides the quantity, picks the vendor and
// types the price in one pass, and a half-saved review is not a state anyone
// wants to resume from. The two named use cases exist because the SPEC names
// them and because they carry different permissions — `review.record_stock`
// and `review.set_vendor` / `review.set_cost` are checked separately, so an
// office user granted one and not the other is refused precisely.
//
// The invariant this file exists to protect: nothing here writes to
// purchase_request_items. The requestor's numbers are read, never touched.
// ---------------------------------------------------------------------------

import { emit, loadRequest, must, PurchasingError, type PurchasingContext } from './context.ts';
import type { Actor } from './ports.ts';
import { events } from '../domain/events.mjs';
import { QUEUE_STATUSES } from '../domain/status.mjs';
import { estimatedTotalCents, lineTotalCents, parseMoney, parseQty } from '../domain/numbers.mjs';
import { lineQuantities } from '../domain/entities.mjs';

export type ReviewLineInput = {
  requestItemId: string;
  usableStock?: string | number;
  approvedQty?: string | number;
  finalOrderQty?: string | number;
  vendorId?: string | null;
  estimatedUnitCost?: string | number | null;
  substituteDescription?: string | null;
  expectedArrivalDate?: string | null;
  lineNotes?: string | null;
  overrideReason?: string | null;
};

export async function saveWorkshopReview(
  ctx: PurchasingContext, actor: Actor, requestId: string,
  input: { workshopNotes?: string | null; lines: ReviewLineInput[] },
) {
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'review.record_stock', request);
  await must(ctx, actor, 'review.set_quantities', request);
  if (!QUEUE_STATUSES.includes(request.status)) {
    throw new PurchasingError('not_in_review', `a ${request.status} request is not in the review queue`);
  }

  return ctx.uow.run(async () => {
    const now = ctx.clock.now();
    const review = await ctx.reviews.findByRequest(requestId) ?? await ctx.reviews.open(requestId, actor.id, now);
    const items = await ctx.requests.itemsFor(requestId);
    const byId = new Map(items.map((i) => [i.id, i]));
    const emitted: any[] = [];

    for (const line of input.lines) {
      const item = byId.get(line.requestItemId);
      if (!item) throw new PurchasingError('unknown_line', `line ${line.requestItemId} is not on this request`);

      const observedStock = quantity(line.usableStock ?? 0, 'workshop stock');
      // Default: the workshop approves what the field asked for. Editable.
      const approved = blank(line.approvedQty) ? item.requestedQty : quantity(line.approvedQty!, 'approved quantity');

      // The domain computes the derived quantities; this layer never does the
      // arithmetic itself, so the suggestion cannot be negative here and
      // positive somewhere else.
      const provisional = lineQuantities({ requested: item.requestedQty, observedStock, approved });
      const finalOrder = blank(line.finalOrderQty)
        ? provisional.suggested
        : quantity(line.finalOrderQty!, 'final order quantity');
      const quantities = lineQuantities({ requested: item.requestedQty, observedStock, approved, finalOrder });

      let unitCostCents: number | null = null;
      if (!blank(line.estimatedUnitCost)) {
        const parsed = parseMoney(line.estimatedUnitCost);
        if (!parsed.ok) throw new PurchasingError('validation_failed', `estimated unit cost: ${parsed.error}`);
        unitCostCents = parsed.value;
      }

      // Vendor and cost are separate authorities from recording stock.
      if (line.vendorId) await must(ctx, actor, 'review.set_vendor', request);
      if (unitCostCents !== null) await must(ctx, actor, 'review.set_cost', request);

      const values = {
        usableStockQty: quantities.observedStock,
        approvedQty: quantities.approved,
        suggestedOrderQty: quantities.suggested,
        finalOrderQty: quantities.finalOrder,
        stockAppliedQty: quantities.stockApplied,
        replenishmentQty: quantities.replenishment,
        vendorId: line.vendorId ?? null,
        estimatedUnitCostCents: unitCostCents,
        estimatedLineTotalCents: lineTotalCents(unitCostCents ?? 0, quantities.finalOrder),
        substituteDescription: line.substituteDescription ?? null,
        expectedArrivalDate: line.expectedArrivalDate ?? null,
        lineNotes: line.lineNotes ?? null,
        overrideReason: quantities.overridden ? (line.overrideReason ?? 'workshop override') : null,
      };

      const { previous } = await ctx.reviews.saveLine(review.id, item.id, values, actor.id, now);

      // The stock reading is evidence in its own right: it is preserved with
      // the request even if the review is edited afterwards.
      await ctx.inventory.observe(
        {
          orgId: actor.orgId, requestId, requestItemId: item.id, description: item.description,
          observedQty: quantities.observedStock, unit: item.unit, observedBy: actor.id, notes: line.lineNotes ?? null,
        },
        now,
      );

      emitted.push(
        events.stockRecorded(
          requestId, item.id, previous,
          {
            usableStock: values.usableStockQty,
            approvedQty: values.approvedQty,
            suggestedOrderQty: values.suggestedOrderQty,
            finalOrderQty: values.finalOrderQty,
            vendorId: values.vendorId,
            unitCostCents: values.estimatedUnitCostCents,
            lineTotalCents: values.estimatedLineTotalCents,
          },
          values.overrideReason,
        ),
      );
      if (previous && previous.vendorId !== values.vendorId && values.vendorId) {
        const vendor = (await ctx.reference.vendors(actor.orgId)).find((v: any) => v.id === values.vendorId);
        emitted.push(events.vendorSelected(requestId, item.id, values.vendorId, vendor?.name));
      }
    }

    await ctx.reviews.markSaved(review.id, actor.id, input.workshopNotes ?? null, now);
    const totals = recomputeTotals(ctx, requestId);
    emitted.push(events.reviewSaved(requestId, review.id, totals));
    await emit(ctx, actor, actor.orgId, emitted);
    return totals;
  });
}

/**
 * Roll the review up onto the request: the estimated total, the vendor (when
 * there is exactly one) and the latest expected arrival. Derived values only —
 * the source of truth stays on the review lines.
 */
export async function recomputeTotals(ctx: PurchasingContext, requestId: string) {
  const lines = (await ctx.reviews.linesFor(requestId)).map((l) => ({
    ...l,
    estimatedUnitCostCents: l.estimatedUnitCostCents,
    finalOrderQty: l.finalOrderQty,
  }));
  const total = estimatedTotalCents(lines as any);
  const vendorIds = [...new Set(lines.filter((l) => l.finalOrderQty > 0).map((l) => l.vendorId).filter(Boolean))];
  const arrivals = lines.map((l) => l.expectedArrivalDate).filter(Boolean).sort();
  await ctx.requests.patch(requestId, {
    estimated_total_cents: total,
    vendor_id: vendorIds.length === 1 ? vendorIds[0] : null,
    expected_arrival_date: arrivals[arrivals.length - 1] ?? null,
    updated_at: ctx.clock.now(),
  });
  return {
    estimatedTotalCents: total,
    vendorId: vendorIds.length === 1 ? (vendorIds[0] as string) : null,
    vendorCount: vendorIds.length,
  };
}

/** What the workshop changed relative to what the field asked for. */
export async function changesFromOriginal(ctx: PurchasingContext, requestId: string) {
  const lines = await ctx.reviews.linesFor(requestId);
  return lines
    .filter((l) => l.requestedQty !== l.finalOrderQty || l.substituteDescription)
    .map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      requestedQty: l.requestedQty,
      approvedQty: l.approvedQty,
      usableStockQty: l.usableStockQty,
      suggestedOrderQty: l.suggestedOrderQty,
      finalOrderQty: l.finalOrderQty,
      substituteDescription: l.substituteDescription,
      overrideReason: l.overrideReason,
    }));
}

function blank(value: unknown) {
  return value === undefined || value === null || String(value) === '';
}

function quantity(value: string | number, label: string): number {
  const parsed = parseQty(value === '' ? '0' : value);
  if (!parsed.ok) throw new PurchasingError('validation_failed', `${label}: ${parsed.error}`);
  return parsed.value;
}
