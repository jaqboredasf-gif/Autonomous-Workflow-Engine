/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// fulfilment.ts — everything after the approval.
//
//   generatePurchaseOrder · generateVendorEmailDraft · editVendorEmailDraft
//   advanceVendorEmailDraft · markOrderPlaced · updateTracking
//   recordReceipt (partial or final) · completePurchaseRequest
//
// The gates that live here, and nowhere else:
//   * a PO requires an APPROVED request, and asking twice returns the same
//     permanent number without burning a sequence value
//   * a vendor email requires a generated PO
//   * a draft's words freeze at review, and "sent" is a human's statement
//   * receiving accumulates; the request completes only when every ordered
//     quantity is resolved
// ---------------------------------------------------------------------------

import { emit, loadRequest, must, PurchasingError, transitionTo, type PurchasingContext } from './context.ts';
import type { Actor } from './ports.ts';
import { events } from '../domain/events.mjs';
import { draftGuard } from '../domain/email.mjs';
import { parseMoney, parseQty, receiptGuard } from '../domain/numbers.mjs';
import { assertSingleVendor, purchaseOrderFromReview } from '../domain/entities.mjs';

// --- purchase order ---------------------------------------------------------

export async function generatePurchaseOrder(ctx: PurchasingContext, actor: Actor, requestId: string) {
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'po.generate', request);

  // Idempotency first: a request that already has a purchase order returns the
  // same permanent number, whatever it has done since. Asking twice must never
  // burn a sequence value and must never be an error.
  const already = await ctx.orders.findByRequest(requestId);
  if (already) return { poNumber: already.poNumber, purchaseOrderId: already.id, reused: true };

  if (request.status !== 'APPROVED') {
    throw new PurchasingError('po_before_approval', `a ${request.status} request cannot produce a purchase order`);
  }

  return ctx.uow.run(async () => {
    const now = ctx.clock.now();
    const lines = (await ctx.reviews.linesFor(requestId)).filter((l) => l.finalOrderQty > 0);
    if (!lines.length) throw new PurchasingError('nothing_to_order', 'no line has a final order quantity');

    const vendorId = assertSingleVendor([...new Set(lines.map((l) => l.vendorId))]);
    const contact = await ctx.reference.primaryContact(vendorId);

    // The domain builds the order from the review; this layer only persists it.
    const order = purchaseOrderFromReview({
      request,
      lines: lines.map((l) => ({
        original: { id: l.requestItemId, lineNo: l.lineNo, description: l.description, unit: l.unit },
        quantities: { finalOrder: l.finalOrderQty },
        unitCostCents: l.estimatedUnitCostCents,
        vendorPartNumber: l.vendorPartNumber,
        lineTotalCents: l.estimatedLineTotalCents,
        substituteDescription: l.substituteDescription,
        expectedArrivalDate: l.expectedArrivalDate,
      })),
      poNumber: '', sequenceValue: 0, vendorId,
      approverId: request.approverId ?? actor.id, generatedBy: actor.id,
    });

    // The number comes from the sequence, inside this transaction, under the
    // write lock. Nothing above infrastructure may invent one.
    const { poNumber, sequenceValue } = await ctx.poNumbers.allocate(actor.orgId, now);

    const saved = await ctx.orders.insert(
      { ...order, poNumber, sequenceValue, vendorContactId: contact?.id ?? null, notes: request.decisionNotes ?? null },
      now,
    );

    await transitionTo(ctx, actor, request, 'PO_GENERATED');
    const document = await renderAndStore(ctx, actor, saved.id, now);

    await emit(ctx, actor, actor.orgId, [
      events.poGenerated(request, { ...order, id: saved.id, poNumber }),
      events.poDocumentGenerated(requestId, document),
    ]);
    return { poNumber, purchaseOrderId: saved.id, documentId: document.id, reused: false };
  });
}

/** Render the PO through the DocumentRenderer port and store it as evidence. */
export async function renderAndStore(ctx: PurchasingContext, actor: Actor, purchaseOrderId: string, now: string) {
  const view = await ctx.orders.view(purchaseOrderId);
  if (!view) throw new PurchasingError('not_found', 'purchase order not found');
  const bytes = ctx.renderer.renderPurchaseOrder(view);
  return await ctx.documents.store(
    {
      purchaseOrderId,
      kind: 'PDF',
      filename: `${view.purchaseOrder.poNumber}.pdf`,
      contentType: 'application/pdf',
      bytes,
      templateKey: (await ctx.reference.settings(actor.orgId)).poTemplateKey ?? ctx.renderer.templateKey,
      generatedBy: actor.id,
    },
    now,
  );
}

// --- vendor email draft -----------------------------------------------------

export async function generateVendorEmailDraft(ctx: PurchasingContext, actor: Actor, requestId: string) {
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'email.draft', request);

  const order = await ctx.orders.findByRequest(requestId);
  if (!order) throw new PurchasingError('email_before_po', 'a vendor email needs a purchase order first');

  return ctx.uow.run(async () => {
    const now = ctx.clock.now();
    const draftKey = `po:${order.poNumber}:vendor`;

    const existing = await ctx.drafts.findByKey(actor.orgId, draftKey);
    if (existing) {
      if (request.status === 'PO_GENERATED') await transitionTo(ctx, actor, request, 'EMAIL_DRAFTED');
      return { id: existing.id, reused: true };
    }

    const view = await ctx.orders.view(order.id);
    const document = (await ctx.documents.listFor(order.id))[0];
    const template = await ctx.reference.emailTemplate(actor.orgId, 'VENDOR_PURCHASE_ORDER');

    const composed = ctx.email.compose(
      'VENDOR_PURCHASE_ORDER',
      {
        ...view,
        sender: { id: actor.id, name: actor.name, email: actor.email },
        to: [view.vendorContact?.email].filter(Boolean),
        attachments: document
          ? [{ filename: document.filename, contentType: document.content_type, documentId: document.id }]
          : [],
        draftKey,
      },
      template,
    );

    const saved = await ctx.drafts.insert(
      {
        orgId: actor.orgId, requestId, purchaseOrderId: order.id, templateKey: 'VENDOR_PURCHASE_ORDER',
        status: 'GENERATED', subject: composed.subject, body: composed.body,
        to: composed.to, cc: composed.cc, attachments: composed.attachments,
        draftKey, generatedBy: actor.id,
      },
      now,
    );

    await transitionTo(ctx, actor, request, 'EMAIL_DRAFTED');
    await emit(ctx, actor, actor.orgId, [
      events.emailDraftGenerated(requestId, { id: saved.id, templateKey: 'VENDOR_PURCHASE_ORDER', to: composed.to }, order.poNumber),
    ]);
    return { id: saved.id, reused: false };
  });
}

export async function editVendorEmailDraft(
  ctx: PurchasingContext, actor: Actor, draftId: string, patch: { subject?: string; body?: string },
) {
  const draft = await ctx.drafts.findById(draftId);
  if (!draft || draft.orgId !== actor.orgId) throw new PurchasingError('not_found', 'draft not found');
  const request = await loadRequest(ctx, actor, draft.requestId);
  await must(ctx, actor, 'email.draft', request);
  if (draft.status !== 'GENERATED') {
    throw new PurchasingError('draft_frozen', 'a reviewed draft is frozen — the review refers to these words');
  }
  await ctx.drafts.updateContent(draftId, patch, ctx.clock.now());
  return { ok: true };
}

export async function advanceVendorEmailDraft(
  ctx: PurchasingContext, actor: Actor, draftId: string,
  to: 'REVIEWED' | 'APPROVED_TO_SEND' | 'SENT' | 'CANCELLED' | 'FAILED', notes?: string,
) {
  const draft = await ctx.drafts.findById(draftId);
  if (!draft || draft.orgId !== actor.orgId) throw new PurchasingError('not_found', 'draft not found');
  const request = await loadRequest(ctx, actor, draft.requestId);
  await must(ctx, actor, 'email.review', request);

  const guard = draftGuard(draft.status, to, {
    reviewedBy: draft.reviewedBy,
    markedBy: to === 'SENT' ? actor.id : null,
  });
  if (!guard.ok) throw new PurchasingError(guard.reason ?? 'illegal_transition', guard.message ?? 'illegal draft transition');

  const now = ctx.clock.now();
  const columns: Record<string, unknown> = { status: to, updated_at: now };
  if (to === 'REVIEWED') { columns.reviewed_at = now; columns.reviewed_by = actor.id; }
  if (to === 'APPROVED_TO_SEND') { columns.approved_to_send_at = now; columns.approved_to_send_by = actor.id; }
  // SENT means: a human copied this into their own mail client and sent it.
  // Nothing in this codebase transmits anything.
  if (to === 'SENT') { columns.sent_at = now; columns.sent_marked_by = actor.id; }
  if (to === 'CANCELLED') columns.cancelled_at = now;
  if (to === 'FAILED') columns.failure_reason = notes ?? 'unspecified';

  await ctx.drafts.updateStatus(draftId, columns);
  await emit(ctx, actor, actor.orgId, [events.emailDraftAdvanced(draft.requestId, draftId, draft.status, to, notes ?? null)]);
  return { status: to };
}

// --- ordering and tracking --------------------------------------------------

export async function markOrderPlaced(ctx: PurchasingContext, actor: Actor, requestId: string, input: { orderedAt?: string; notes?: string } = {}) {
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'order.mark_ordered', request);
  return ctx.uow.run(async () => {
    await transitionTo(ctx, actor, request, 'ORDERED', { ordered_at: input.orderedAt ?? ctx.clock.now() });
    await emit(ctx, actor, actor.orgId, [events.orderPlaced(request, input.notes ?? null)]);
    return { status: 'ORDERED' };
  });
}

export async function updateTracking(
  ctx: PurchasingContext, actor: Actor, requestId: string,
  input: { trackingNumber?: string; carrier?: string; expectedArrivalDate?: string },
) {
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'order.track', request);
  await ctx.requests.patch(requestId, {
    tracking_number: input.trackingNumber ?? request.trackingNumber,
    tracking_carrier: input.carrier ?? request.trackingCarrier,
    expected_arrival_date: input.expectedArrivalDate ?? request.expectedArrivalDate,
    updated_at: ctx.clock.now(),
    updated_by: actor.id,
  });
  await emit(ctx, actor, actor.orgId, [
    events.trackingUpdated(
      requestId,
      { trackingNumber: request.trackingNumber, carrier: request.trackingCarrier, expectedArrivalDate: request.expectedArrivalDate },
      input,
    ),
  ]);
  return { ok: true };
}

// --- receiving --------------------------------------------------------------

export type ReceiptLineInput = {
  purchaseOrderItemId: string;
  receivedQty?: string | number;
  damagedQty?: string | number;
  backorderedQty?: string | number;
  writtenOffQty?: string | number;
  overrideReason?: string | null;
  notes?: string | null;
};

export async function recordReceipt(
  ctx: PurchasingContext, actor: Actor, requestId: string,
  input: {
    receivedDate: string; packingSlipNumber?: string; notes?: string;
    lines: ReceiptLineInput[]; attachments?: Array<{ filename: string; dataBase64?: string; caption?: string }>;
  },
) {
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'receiving.record', request);
  if (!['ORDERED', 'PARTIALLY_RECEIVED'].includes(request.status)) {
    throw new PurchasingError('not_receivable', `a ${request.status} request is not awaiting delivery`);
  }
  if (!input.receivedDate) throw new PurchasingError('validation_failed', 'a receipt needs the date it arrived');

  // A provider that can do the whole receipt in one transaction server-side
  // does so. The local provider has no `atomic` — its unit of work IS a
  // transaction, so composing the steps below is already atomic there.
  if (ctx.atomic) {
    const parsed = input.lines.map((line) => ({
      purchaseOrderItemId: line.purchaseOrderItemId,
      receivedQty: optional(line.receivedQty),
      damagedQty: optional(line.damagedQty),
      backorderedQty: optional(line.backorderedQty),
      writtenOffQty: optional(line.writtenOffQty),
      overrideReason: line.overrideReason ?? null,
      notes: line.notes ?? null,
    }));
    const result = await ctx.atomic.recordReceipt({
      requestId,
      receivedDate: input.receivedDate,
      packingSlipNumber: input.packingSlipNumber ?? null,
      notes: input.notes ?? null,
      lines: parsed,
    });

    // The events are still emitted from here: the RPC owns the WRITE, the
    // domain owns what the write means.
    const emitted: any[] = [
      events.receiptRecorded(requestId, result.receiptId, {
        lines: input.lines.length, packingSlip: input.packingSlipNumber ?? null,
      }),
    ];
    if (result.outstandingLines === 0) {
      emitted.push(
        events.receiptCompleted(requestId, result.receiptId, input.receivedDate),
        events.materialReady(requestId),
      );
    } else {
      emitted.push(events.receiptPartial(requestId, result.receiptId, result.outstandingLines));
    }
    await emit(ctx, actor, actor.orgId, emitted);
    return result;
  }

  return ctx.uow.run(async () => {
    const now = ctx.clock.now();
    const order = await ctx.orders.findByRequest(requestId);
    const progress = new Map((await ctx.orders.progressFor(requestId)).map((p) => [p.purchaseOrderItemId, p]));

    const receipt = await ctx.receipts.insert(
      {
        orgId: actor.orgId, requestId, purchaseOrderId: order?.id ?? null,
        receivedDate: input.receivedDate, receivedBy: actor.id,
        packingSlipNumber: input.packingSlipNumber ?? null, notes: input.notes ?? null,
      },
      now,
    );

    const emitted: any[] = [];

    for (const line of input.lines) {
      const state = progress.get(line.purchaseOrderItemId);
      if (!state) throw new PurchasingError('unknown_line', 'that line is not on this purchase order');

      const received = optional(line.receivedQty);
      const damaged = optional(line.damagedQty);
      const backordered = optional(line.backorderedQty);
      const writtenOff = optional(line.writtenOffQty);
      if (received + damaged + backordered + writtenOff === 0) continue;

      if (received > 0) {
        const check = receiptGuard({
          orderedQty: state.finalOrderQty,
          alreadyReceivedQty: state.receivedQty + state.damagedQty + state.writtenOffQty,
          incomingQty: received,
          override: Boolean(line.overrideReason),
        });
        if (!check.ok) throw new PurchasingError(check.reason ?? 'over_receipt', check.message ?? 'receipt refused');
      }

      await ctx.receipts.insertLine(
        receipt.id,
        { purchaseOrderItemId: line.purchaseOrderItemId, receivedQty: received, damagedQty: damaged,
          backorderedQty: backordered, writtenOffQty: writtenOff, overrideReason: line.overrideReason ?? null,
          notes: line.notes ?? null },
        now,
      );

      for (const [qty, reason] of [[received, 'RECEIVED'], [-damaged, 'DAMAGE']] as Array<[number, string]>) {
        if (qty === 0) continue;
        await ctx.inventory.adjust(
          {
            orgId: actor.orgId, requestId, requestItemId: state.requestItemId, description: state.description,
            deltaQty: qty, unit: state.unit, reason, adjustedBy: actor.id,
          },
          now,
        );
        emitted.push(events.inventoryAdjusted(requestId, state.requestItemId, { description: state.description, delta: qty, unit: state.unit, reason }));
      }
    }

    for (const file of input.attachments ?? []) {
      await ctx.attachments.attachToReceipt(receipt.id, file, actor.id, now);
    }

    const outstanding = (await ctx.orders.progressFor(requestId)).filter((p) => p.outstandingQty > 0).length;
    const fresh = await loadRequest(ctx, actor, requestId);

    if (outstanding === 0) {
      await transitionTo(ctx, actor, fresh, 'RECEIVED', { received_at: now });
      await ctx.receipts.markFinal(receipt.id);
      emitted.push(events.receiptCompleted(requestId, receipt.id, input.receivedDate), events.materialReady(requestId));
    } else {
      if (fresh.status !== 'PARTIALLY_RECEIVED') await transitionTo(ctx, actor, fresh, 'PARTIALLY_RECEIVED');
      emitted.push(events.receiptPartial(requestId, receipt.id, outstanding));
    }

    emitted.push(
      events.receiptRecorded(requestId, receipt.id, { lines: input.lines.length, packingSlip: input.packingSlipNumber ?? null }),
    );
    await emit(ctx, actor, actor.orgId, emitted);
    return { receiptId: receipt.id, outstandingLines: outstanding };
  });
}

export async function completePurchaseRequest(ctx: PurchasingContext, actor: Actor, requestId: string, notes?: string) {
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'request.complete', request);
  return ctx.uow.run(async () => {
    await transitionTo(ctx, actor, request, 'COMPLETED', { completed_at: ctx.clock.now() });
    await emit(ctx, actor, actor.orgId, [events.requestCompleted(request, notes ?? null)]);
    return { status: 'COMPLETED' };
  });
}

/**
 * Record what was actually paid.
 *
 * THE RULE THIS ENCODES: estimated cost and actual cost are different facts
 * that arrive at different times from different people, and neither is ever
 * required to move a purchase forward. A purchaser orders material before
 * knowing the invoice price; accounting learns the price weeks later. So this
 * is its own act, gated on accounting's permission rather than purchasing's,
 * and it does not transition the request.
 *
 * Passing an empty value CLEARS the figure back to unknown. That is deliberate:
 * a wrong number that cannot be withdrawn is worse than no number.
 */
export async function recordActualCost(
  ctx: PurchasingContext, actor: Actor, requestId: string,
  input: { actualTotal?: string | number | null; source?: string; reference?: string } = {},
) {
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'accounting.read', request);

  const order = await ctx.orders.findByRequest(requestId);
  if (!order) throw new PurchasingError('not_found', 'this request has no purchase order to cost');

  const raw = input.actualTotal;
  let cents: number | null = null;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const parsed = parseMoney(raw);
    if (!parsed.ok) throw new PurchasingError('validation_failed', parsed.error as string);
    cents = parsed.value;
  }

  const now = ctx.clock.now();
  await ctx.orders.recordActualCost(actor.orgId, order.id, {
    actualTotalCents: cents,
    source: (input.source ?? '').trim() || null,
    reference: (input.reference ?? '').trim() || null,
  }, actor.id, now);

  await emit(ctx, actor, actor.orgId, [
    events.actualCostRecorded(
      order.id,
      { actualTotalCents: order.actual_total_cents ?? null },
      { actualTotalCents: cents, reference: (input.reference ?? '').trim() || null },
      cents === null ? 'cleared the recorded actual cost' : 'recorded the actual cost',
    ),
  ]);
  return { ok: true, actualTotalCents: cents };
}

function optional(value: string | number | undefined | null): number {
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const parsed = parseQty(value);
  if (!parsed.ok) throw new PurchasingError('validation_failed', parsed.error as string);
  return parsed.value;
}
