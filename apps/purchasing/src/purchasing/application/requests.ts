/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// requests.ts — use cases owned by the requestor side of purchasing.
//
//   createPurchaseRequest · updatePurchaseRequest · submitPurchaseRequest
//   respondToClarification · cancelPurchaseRequest · addNote · attachFile
//
// Each one: authorize, apply domain rules, write through repositories, emit
// events. No SQL, no HTTP, no React.
// ---------------------------------------------------------------------------

import { emit, loadRequest, must, PurchasingError, transitionTo, type PurchasingContext } from './context.ts';
import type { Actor } from './ports.ts';
import { events } from '../domain/events.mjs';
import { formatQty, parseQty } from '../domain/numbers.mjs';
import { stripRequestorFields, validateRequestDraft } from '../domain/validation.mjs';
import { newPurchaseRequest } from '../domain/entities.mjs';

export type RequestDraftInput = {
  jobNumber: string;
  needByDate: string;
  needByTime: string;
  deliveryLocationId: string;
  deliveryMethod?: string;
  reason?: string;
  notes?: string;
  items: Array<{ description: string; qty: string | number; unit: string; stockNumber?: string; notes?: string }>;
};

export function createPurchaseRequest(ctx: PurchasingContext, actor: Actor, payload: RequestDraftInput & Record<string, unknown>) {
  must(ctx, actor, 'request.create');

  // The field firewall. An approver raising a request is bound by it too:
  // vendor and cost are decided in review, whoever is typing.
  const { cleaned, rejected } = stripRequestorFields(payload);
  const draft = cleaned as RequestDraftInput;

  const validation = validateRequestDraft(draft);
  if (!validation.ok) throw new PurchasingError('validation_failed', 'the request is incomplete', validation.errors);

  return ctx.uow.run(() => {
    const now = ctx.clock.now();
    const requestNumber = ctx.requests.nextRequestNumber(actor.orgId);

    // The domain builds it — one job per request, lines validated — and only
    // then does the repository see anything.
    const entity = newPurchaseRequest({
      orgId: actor.orgId,
      requestNumber,
      jobNumber: draft.jobNumber,
      requestorId: actor.id,
      needByDate: draft.needByDate,
      needByTime: draft.needByTime,
      deliveryLocationId: draft.deliveryLocationId,
      deliveryMethod: draft.deliveryMethod,
      reason: draft.reason ?? null,
      notes: draft.notes ?? null,
      items: draft.items.map((i) => ({ ...i, requestedQty: qty(i.qty, 'quantity') })),
    });

    const saved = ctx.requests.insert({ ...entity, createdBy: actor.id, now });

    emit(ctx, actor, actor.orgId, [
      events.requestCreated(saved, { items: entity.items.length }),
      rejected.length ? events.purchasingFieldsRejected(saved.id, rejected) : null,
    ]);

    return { id: saved.id, requestNumber, rejectedFields: rejected };
  });
}

export function updatePurchaseRequest(ctx: PurchasingContext, actor: Actor, requestId: string, payload: Record<string, unknown>) {
  const request = loadRequest(ctx, actor, requestId);
  must(ctx, actor, 'request.update.own', request);

  const { cleaned, rejected } = stripRequestorFields(payload);
  const before = currentDraft(ctx, request);
  const draft = { ...before, ...cleaned } as RequestDraftInput;

  const validation = validateRequestDraft(draft);
  if (!validation.ok) throw new PurchasingError('validation_failed', 'the request is incomplete', validation.errors);

  return ctx.uow.run(() => {
    const now = ctx.clock.now();
    ctx.requests.update(requestId, request.version, {
      job_number: draft.jobNumber,
      need_by_date: draft.needByDate,
      need_by_time: draft.needByTime,
      delivery_location_id: draft.deliveryLocationId,
      delivery_method: draft.deliveryMethod === 'PICKUP' ? 'PICKUP' : 'DELIVERY',
      reason: draft.reason ?? null,
      notes: draft.notes ?? null,
      updated_at: now,
      updated_by: actor.id,
    });

    if (Array.isArray((cleaned as any).items)) {
      ctx.requests.replaceItems(
        requestId,
        (cleaned as any).items.map((i: any) => ({ ...i, requestedQty: qty(i.qty, 'quantity') })),
        actor.id,
        now,
      );
    }

    emit(ctx, actor, actor.orgId, [
      events.requestUpdated(requestId, before, draft),
      rejected.length ? events.purchasingFieldsRejected(requestId, rejected) : null,
    ]);
    return { id: requestId };
  });
}

export function submitPurchaseRequest(ctx: PurchasingContext, actor: Actor, requestId: string) {
  const request = loadRequest(ctx, actor, requestId);
  must(ctx, actor, 'request.submit', request);

  const validation = validateRequestDraft(currentDraft(ctx, request));
  if (!validation.ok) throw new PurchasingError('validation_failed', 'the request is incomplete', validation.errors);

  return ctx.uow.run(() => {
    const submitted = transitionTo(ctx, actor, request, 'SUBMITTED', { submitted_at: ctx.clock.now() });
    emit(ctx, actor, actor.orgId, [events.requestSubmitted(request)]);

    // A submitted request does not sit in SUBMITTED waiting for someone to
    // notice: it enters the workshop queue in the same transaction, so there is
    // no state in which a request is submitted and nobody owns it.
    transitionTo(ctx, actor, submitted, 'PENDING_WORKSHOP_REVIEW');
    emit(ctx, actor, actor.orgId, [events.awaitingReview(request)]);
    return { status: 'PENDING_WORKSHOP_REVIEW' };
  });
}

export function respondToClarification(ctx: PurchasingContext, actor: Actor, requestId: string, answer: string) {
  const request = loadRequest(ctx, actor, requestId);
  must(ctx, actor, 'request.respond_clarification', request);
  if (request.status !== 'CLARIFICATION_REQUESTED') {
    throw new PurchasingError('not_in_clarification', 'this request is not waiting on an answer');
  }
  if (!answer.trim()) throw new PurchasingError('validation_failed', 'an answer cannot be empty');

  return ctx.uow.run(() => {
    const resubmitted = transitionTo(ctx, actor, request, 'RESUBMITTED', { clarification_answer: answer.trim() });
    emit(ctx, actor, actor.orgId, [events.clarificationAnswered(request, answer.trim())]);
    // Straight back into the queue: an answered question never waits for
    // someone to remember to re-queue it.
    transitionTo(ctx, actor, resubmitted, 'PENDING_WORKSHOP_REVIEW');
    return { status: 'PENDING_WORKSHOP_REVIEW' };
  });
}

export function cancelPurchaseRequest(ctx: PurchasingContext, actor: Actor, requestId: string, reason: string) {
  const request = loadRequest(ctx, actor, requestId);
  const owns = request.requestorId === actor.id || request.createdBy === actor.id;
  must(ctx, actor, owns ? 'request.cancel.own' : 'request.cancel.any', request);
  if (!reason || !reason.trim()) throw new PurchasingError('reason_required', 'a cancellation must record a reason');

  return ctx.uow.run(() => {
    transitionTo(ctx, actor, request, 'CANCELLED', { cancelled_at: ctx.clock.now(), cancel_reason: reason.trim() });
    emit(ctx, actor, actor.orgId, [events.requestCancelled(request, reason.trim())]);
    return { status: 'CANCELLED' };
  });
}

export function addNote(ctx: PurchasingContext, actor: Actor, requestId: string, note: string) {
  const request = loadRequest(ctx, actor, requestId);
  must(ctx, actor, 'request.note', request);
  if (!note.trim()) throw new PurchasingError('validation_failed', 'a note cannot be empty');
  emit(ctx, actor, actor.orgId, [events.noteAdded(requestId, note.trim())]);
  return { ok: true };
}

export function attachFile(
  ctx: PurchasingContext, actor: Actor, requestId: string,
  file: { filename: string; contentType?: string; dataBase64?: string; caption?: string; byteSize?: number },
) {
  const request = loadRequest(ctx, actor, requestId);
  must(ctx, actor, 'request.attach', request);
  const stored = ctx.attachments.attachToRequest(requestId, file, actor.id, ctx.clock.now());
  emit(ctx, actor, actor.orgId, [events.attachmentAdded(requestId, stored)]);
  return { id: stored.id };
}

// --- helpers ----------------------------------------------------------------

function qty(value: string | number, label: string): number {
  const parsed = parseQty(value);
  if (!parsed.ok) throw new PurchasingError('validation_failed', `${label}: ${parsed.error}`);
  return parsed.value;
}

/** The request as the requestor last stated it — the shape validation expects. */
function currentDraft(ctx: PurchasingContext, request: any): RequestDraftInput {
  const items = ctx.requests.itemsFor(request.id);
  return {
    jobNumber: request.jobNumber,
    needByDate: request.needByDate,
    needByTime: request.needByTime,
    deliveryLocationId: request.deliveryLocationId,
    deliveryMethod: request.deliveryMethod,
    reason: request.reason ?? '',
    notes: request.notes ?? '',
    items: items.map((i) => ({
      description: i.description,
      qty: formatQty(i.requestedQty),
      unit: i.unit,
      stockNumber: i.stockNumber ?? undefined,
      notes: i.notes ?? undefined,
    })),
  };
}
