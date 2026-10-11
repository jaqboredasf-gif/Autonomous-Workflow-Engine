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
import { recordPurchaseHistory } from './history.ts';
import type { Actor } from './ports.ts';
import { events } from '../domain/events.mjs';
import { executeTransition } from '@awe/workflow';

import { authorize } from '../domain/roles.mjs';
import { EMAIL_DRAFT_WORKFLOW, emailDraftActionFor } from '../domain/email-workflow.mjs';
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

    // THE TWO COMPONENTS THE NUMBER IS BUILT FROM, resolved here and captured
    // on the order. A purchase order number is job + vendor + sequence, so the
    // vendor's code has to exist before one can be issued; a vendor without one
    // is a directory row that predates the migration, and it is better to refuse
    // than to invent a code on a supplier's paperwork.
    //
    // Loaded by id rather than from the active vendor list: the review already
    // chose this vendor, and somebody retiring it in between must not turn an
    // approved request into a purchase order that cannot be numbered.
    const vendor = await ctx.reference.vendorById(actor.orgId, vendorId);
    const vendorCode = vendor?.code ? String(vendor.code).toUpperCase() : null;
    if (!vendorCode) {
      throw new PurchasingError(
        'vendor_code_missing',
        `${vendor?.name ?? 'that vendor'} has no purchase order code, and a purchase order number is built from one. ` +
          'An administrator can set it in Administration → Vendors.',
      );
    }
    if (!request.jobNumber) {
      throw new PurchasingError('po_job_missing', 'a purchase order number is built from the job number, and this request has none');
    }

    // The domain builds the order from the review; this layer only persists it.
    const order = purchaseOrderFromReview({
      request,
      lines: lines.map((l) => ({
        original: { id: l.requestItemId, lineNo: l.lineNo, description: l.description, unit: l.unit },
        quantities: { finalOrder: l.finalOrderQty },
        unitCostCents: l.estimatedUnitCostCents,
        lineTotalCents: l.estimatedLineTotalCents,
        substituteDescription: l.substituteDescription,
        expectedArrivalDate: l.expectedArrivalDate,
      })),
      poNumber: '', sequenceValue: 0, vendorId, vendorCode,
      approverId: request.approverId ?? actor.id, generatedBy: actor.id,
    });

    // THE NUMBER IS ALLOCATED HERE AND NOWHERE ELSE, inside this transaction,
    // under the write lock, from the counter that belongs to THIS job and THIS
    // vendor. Nothing above infrastructure may invent one.
    //
    // Allocation happens at issuance, not at draft: this line is reached only
    // once the request is APPROVED and the order rows are about to be written,
    // and the idempotency check at the top of this function returns the
    // existing number without touching the counter. Viewing a request, refreshing
    // the page or abandoning a draft therefore burns nothing.
    //
    // If anything below fails, the whole transaction rolls back and the counter
    // goes back with it — the number was never issued, so re-running allocates
    // the same one. What is never done is the reverse: a number that HAS been
    // committed is never re-used, whatever happens to the order afterwards.
    const { poNumber, sequenceValue } = await ctx.poNumbers.allocate(
      { orgId: actor.orgId, jobNumber: request.jobNumber, vendorId, vendorCode },
      now,
    );

    const saved = await ctx.orders.insert(
      { ...order, poNumber, sequenceValue, vendorContactId: contact?.id ?? null, notes: request.decisionNotes ?? null },
      now,
    );

    await transitionTo(ctx, actor, request, 'generatePo');
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
  // ONE key decides both the bytes and the record. It used to decide only the
  // record: the organization's template was stamped onto a document drawn from
  // the build's default form, so the evidence named a form that had not been
  // used. A renderer that cannot draw the declared form throws here, before
  // anything is stored.
  const templateKey = (await ctx.reference.settings(actor.orgId)).poTemplateKey ?? ctx.renderer.templateKey;
  const bytes = ctx.renderer.renderPurchaseOrder(view, templateKey);
  return await ctx.documents.store(
    {
      purchaseOrderId,
      kind: 'PDF',
      filename: `${view.purchaseOrder.poNumber}.pdf`,
      contentType: 'application/pdf',
      bytes,
      templateKey,
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
      if (request.status === 'PO_GENERATED') await transitionTo(ctx, actor, request, 'draftEmail');
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

    await transitionTo(ctx, actor, request, 'draftEmail');
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

  // THE SAME ENGINE the purchasing status machine runs on. The draft's own
  // graph, its own legality check and its own refusal vocabulary are gone; this
  // is one table in domain/email-workflow.mjs and one call.
  const action = emailDraftActionFor(to);
  if (!action) throw new PurchasingError('illegal_transition', `no draft action reaches ${to}`);

  const now = ctx.clock.now();
  const columns: Record<string, unknown> = { updated_at: now };
  if (to === 'REVIEWED') { columns.reviewed_at = now; columns.reviewed_by = actor.id; }
  if (to === 'APPROVED_TO_SEND') { columns.approved_to_send_at = now; columns.approved_to_send_by = actor.id; }
  // SENT means: a human copied this into their own mail client and sent it.
  // Nothing in this codebase transmits anything.
  if (to === 'SENT') { columns.sent_at = now; columns.sent_marked_by = actor.id; }
  if (to === 'CANCELLED') columns.cancelled_at = now;
  if (to === 'FAILED') columns.failure_reason = notes ?? 'unspecified';

  const result = await executeTransition({
    workflow: EMAIL_DRAFT_WORKFLOW,
    action,
    from: draft.status,
    facts: {
      reviewedBy: draft.reviewedBy,
      // Only a SENT transition needs an attributable sender; asking for one on
      // every step would refuse a review nobody has claimed to have sent.
      markedBy: to === 'SENT' ? actor.id : null,
      // Somebody to send it to. Read from the stored row rather than
      // recomputed, because the draft froze at review and the vendor's contact
      // may have been filled in since — what was approved is what was read.
      hasRecipient: (draft.to ?? []).length > 0,
    },
    can: (permission: string) => authorize(actor, permission, { request }).ok,
    effects: {
      applyState: async (next: string) => {
        await ctx.drafts.updateStatus(draftId, { ...columns, status: next });
      },
      recordEvent: async () => {
        await emit(ctx, actor, actor.orgId, [
          events.emailDraftAdvanced(draft.requestId, draftId, draft.status, to, notes ?? null),
        ]);
      },
    },
  });
  if (!result.ok) {
    throw new PurchasingError(result.reason ?? 'illegal_transition', result.message ?? 'illegal draft transition');
  }
  return { status: to };
}

// --- ordering and tracking --------------------------------------------------

export async function markOrderPlaced(ctx: PurchasingContext, actor: Actor, requestId: string, input: { orderedAt?: string; notes?: string } = {}) {
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'order.mark_ordered', request);

  return ctx.uow.run(async () => {
    // RE-READ INSIDE THE TRANSACTION.
    //
    // The status checked above was read BEFORE this call joined the write
    // queue, and a second press — a double click, an impatient refresh, two
    // tabs — arrives holding the same stale EMAIL_DRAFTED. Handing that stale
    // record to the transition means the guard is evaluated against a status
    // that is no longer true, and the second press is judged on what the
    // request looked like before the first one moved it.
    //
    // Reading the row again here means the second caller sees ORDERED and is
    // refused with `illegal_transition`, which is what the state machine is
    // for. The status was never wrong either way — the write is idempotent —
    // but "refused because it is already ordered" and "allowed because we were
    // looking at an old copy" are different systems, and only one of them stays
    // correct when the next transition is not idempotent.
    const fresh = await loadRequest(ctx, actor, requestId);
    await transitionTo(ctx, actor, fresh, 'markOrdered', { ordered_at: input.orderedAt ?? ctx.clock.now() });
    await emit(ctx, actor, actor.orgId, [events.orderPlaced(fresh, input.notes ?? null)]);
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

  // A RECEIPT RECORDS SOMETHING ARRIVING. Both write paths skip a line whose
  // four quantities are all zero, but neither refused a receipt where EVERY
  // line was zero — so pressing "Record receipt" with nothing filled in wrote
  // a receipt header with no lines under it, reported success, and left a row
  // on the order saying a delivery had been signed for that had not happened.
  // On the shop counter that is worse than an error message: the next person
  // to look sees a receipt and believes it.
  //
  // Checked HERE, before the provider branch, so the local and the atomic path
  // cannot disagree about what an empty receipt means.
  const total = input.lines.reduce(
    (sum, line) =>
      sum + optional(line.receivedQty) + optional(line.damagedQty)
          + optional(line.backorderedQty) + optional(line.writtenOffQty),
    0,
  );
  if (total === 0) {
    throw new PurchasingError(
      'nothing_recorded',
      'enter how many arrived — a receipt with no quantities on it records nothing',
    );
  }

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
      await transitionTo(ctx, actor, fresh, 'recordFullReceipt', { received_at: now });
      await ctx.receipts.markFinal(receipt.id);
      emitted.push(events.receiptCompleted(requestId, receipt.id, input.receivedDate), events.materialReady(requestId));
    } else {
      if (fresh.status !== 'PARTIALLY_RECEIVED') await transitionTo(ctx, actor, fresh, 'recordPartialReceipt');
      emitted.push(events.receiptPartial(requestId, receipt.id, outstanding));
    }

    emitted.push(
      events.receiptRecorded(requestId, receipt.id, { lines: input.lines.length, packingSlip: input.packingSlipNumber ?? null }),
    );
    await emit(ctx, actor, actor.orgId, emitted);
    return { receiptId: receipt.id, outstandingLines: outstanding };
  });
}

/**
 * "It arrived." — the whole delivery, in one act.
 *
 * WHAT MIKE ACTUALLY DOES. The truck turns up, he checks it against the printed
 * purchase order in his hand, and the paperwork goes in the packet. He does not
 * re-key the quantities: PCC already knows what was ordered, and asking him to
 * type it again is asking him to copy a document into the computer that the
 * computer produced.
 *
 * So this receives every outstanding quantity at once. It is NOT a second way
 * to write a receipt — it builds the same input `recordReceipt` takes and calls
 * it, so every guard behind that (authorization, the over-receipt check, the
 * inventory movements, the events, the status transition) applies exactly as it
 * did when the quantities were typed by hand. The receipt row still exists;
 * the operator simply never has to know it does.
 *
 * COMPLETION IS ATTEMPTED, NOT ASSUMED. Receiving authority is deliberately
 * wider than completion authority — a foreman signs for material on his own job
 * but does not close the purchase. If this actor cannot complete, the request
 * stops at RECEIVED and somebody who can finishes it. Doing otherwise would
 * quietly widen an authority boundary to save a click.
 */
export async function receiveEverything(
  ctx: PurchasingContext, actor: Actor, requestId: string,
  input: { receivedDate?: string; notes?: string } = {},
) {
  // AUTHORIZE FIRST, before reading anything. `recordReceipt` below checks the
  // same permission and is the fence that matters — but this function reads the
  // order's outstanding quantities on the way there, and "how much is still
  // owed on this order" should not be answerable, even through an error
  // message, by somebody who may not receive against it.
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'receiving.record', request);

  const progress = await ctx.orders.progressFor(requestId);
  const outstanding = progress.filter((line) => Number(line.outstandingQty) > 0);
  if (!outstanding.length) {
    throw new PurchasingError('nothing_outstanding', 'everything on this order has already been accounted for');
  }

  const receipt = await recordReceipt(ctx, actor, requestId, {
    receivedDate: (input.receivedDate ?? ctx.clock.now()).slice(0, 10),
    notes: input.notes ?? null,
    lines: outstanding.map((line) => ({
      purchaseOrderItemId: line.purchaseOrderItemId,
      // Thousandths on the record, whole units on the wire — the same shape a
      // typed receipt produces.
      receivedQty: String(Number(line.outstandingQty) / 1000),
    })),
  } as any);

  // The record of what was bought is written at the terminal transition, so a
  // delivery that nobody can close leaves no history. Try, and say what
  // happened rather than failing the receipt that already succeeded.
  let completed = false;
  if (authorize(actor, 'request.complete', { request }).ok) {
    await completePurchaseRequest(ctx, actor, requestId, input.notes ?? undefined);
    completed = true;
  }

  return { ...receipt, completed };
}

export async function completePurchaseRequest(ctx: PurchasingContext, actor: Actor, requestId: string, notes?: string) {
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'request.complete', request);
  return ctx.uow.run(async () => {
    await transitionTo(ctx, actor, request, 'complete', { completed_at: ctx.clock.now() });

    // THE HISTORY WRITE POINT. Inside the transition's unit of work and after
    // the transition, because `completed_at` is part of what history records.
    // If this fails, the completion fails: a completed purchase nobody can
    // reconstruct is worse than one that has to be retried. See BR-012 and
    // application/history.ts.
    const history = await recordPurchaseHistory(ctx, actor, requestId, 'COMPLETED');

    await emit(ctx, actor, actor.orgId, [events.requestCompleted(request, notes ?? null)]);
    return { status: 'COMPLETED', historyLines: history.inserted };
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
