/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// decisions.ts — approve, reject, return for clarification.
//
// The three use cases share one entry point (`decidePurchaseRequest`) because
// they share one gate: the same permission, the same self-approval refusal, the
// same "is this request even awaiting a decision", and the same frozen record
// of what changed relative to the original request. Splitting them into three
// copies of that gate is how one of them ends up missing a check.
// ---------------------------------------------------------------------------

import { emit, loadRequest, must, PurchasingError, transitionTo, type PurchasingContext } from './context.ts';
import type { Actor } from './ports.ts';
import { changesFromOriginal, saveWorkshopReview } from './review.ts';
import { events } from '../domain/events.mjs';
import { QUEUE_STATUSES } from '../domain/status.mjs';

export type Decision = 'APPROVE' | 'REJECT' | 'CLARIFY';

/**
 * Save the workshop's numbers and, if a decision was pressed, decide — in that
 * order, in one call. The decision must refer to SAVED numbers, so "approve"
 * can never be recorded against values still sitting in a browser form. This
 * lives here rather than in a server action because the ordering is a domain
 * rule, not a UI convenience.
 */
export async function saveReviewAndDecide(
  ctx: PurchasingContext, actor: Actor, requestId: string,
  input: { workshopNotes?: string | null; lines: any[] },
  decision: Decision | 'SAVE',
  decisionInput: { notes?: string; reason?: string; question?: string } = {},
) {
  const totals = saveWorkshopReview(ctx, actor, requestId, input);
  if (decision === 'SAVE') return { decided: false, ...totals };
  const result = decidePurchaseRequest(ctx, actor, requestId, decision, decisionInput);
  return { decided: true, ...totals, ...result };
}

export async function decidePurchaseRequest(
  ctx: PurchasingContext, actor: Actor, requestId: string, decision: Decision,
  input: { notes?: string; reason?: string; question?: string } = {},
) {
  const request = await loadRequest(ctx, actor, requestId);
  // Carries the self-approval refusal: a request cannot be decided by the
  // person who raised it unless the org explicitly allows it.
  await must(ctx, actor, 'review.decide', request);
  if (!QUEUE_STATUSES.includes(request.status)) {
    throw new PurchasingError('not_in_review', `a ${request.status} request is not awaiting a decision`);
  }

  // A provider that can decide atomically server-side does so; the local
  // provider's unit of work already gives the same guarantee.
  if (ctx.atomic) {
    const changes = await changesFromOriginal(ctx, requestId);
    const mapped = decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'CLARIFICATION_REQUESTED';
    const result = await ctx.atomic.recordDecision({
      requestId,
      decision: mapped as 'APPROVED' | 'REJECTED' | 'CLARIFICATION_REQUESTED',
      notes: input.notes ?? null,
      reason: decision === 'CLARIFY' ? (input.question ?? '') : (input.reason ?? ''),
    });
    const emitted =
      decision === 'APPROVE' ? [events.approved(request, changes, input.notes ?? null)]
      : decision === 'REJECT' ? [events.rejected(request, input.reason ?? '')]
      : [events.clarificationRequested(request, input.question ?? '')];
    await emit(ctx, actor, actor.orgId, emitted);
    return { status: result.status };
  }

  return ctx.uow.run(async () => {
    const now = ctx.clock.now();
    const changes = await changesFromOriginal(ctx, requestId);

    if (decision === 'APPROVE') return await approve(ctx, actor, request, changes, input.notes ?? null, now);
    if (decision === 'REJECT') return await reject(ctx, actor, request, changes, input.notes ?? null, input.reason ?? '', now);
    return await clarify(ctx, actor, request, changes, input.notes ?? null, input.question ?? '', now);
  });
}

async function approve(
  ctx: PurchasingContext, actor: Actor, request: any, changes: any[], notes: string | null, now: string) {
  const lines = await ctx.reviews.linesFor(request.id);
  const ordering = lines.filter((l) => l.finalOrderQty > 0);
  if (ordering.length === 0) {
    throw new PurchasingError('nothing_to_order', 'approve with at least one line to order, or reject the request');
  }
  if (ordering.some((l) => !l.vendorId)) throw new PurchasingError('vendor_required', 'every ordered line needs a vendor');
  if (ordering.some((l) => l.estimatedUnitCostCents === null)) {
    throw new PurchasingError('cost_required', 'every ordered line needs an estimated unit cost');
  }

  await transitionTo(ctx, actor, request, 'APPROVED', { approver_id: actor.id, decided_at: now, decision_notes: notes });
  await ctx.approvals.record(request.id, actor.id, 'APPROVED', notes, null, changes, now);

  // Stock the workshop gives up to this job is an inventory movement, and it
  // gets its own auditable row. Inventory never changes silently.
  const emitted: any[] = [events.approved(request, changes, notes)];
  for (const line of lines.filter((l) => l.stockAppliedQty > 0)) {
    await ctx.inventory.adjust(
      {
        orgId: actor.orgId, requestId: request.id, requestItemId: line.requestItemId,
        description: line.description, deltaQty: -line.stockAppliedQty, unit: line.unit,
        reason: 'STOCK_APPLIED', adjustedBy: actor.id,
      },
      now,
    );
    emitted.push(
      events.inventoryAdjusted(request.id, line.requestItemId, {
        description: line.description, delta: -line.stockAppliedQty, unit: line.unit, reason: 'STOCK_APPLIED',
      }),
    );
  }

  await emit(ctx, actor, actor.orgId, emitted);
  return { status: 'APPROVED' };
}

async function reject(
  ctx: PurchasingContext, actor: Actor, request: any, changes: any[], notes: string | null, reason: string, now: string) {
  const why = reason.trim();
  if (!why) throw new PurchasingError('reason_required', 'a rejection must record a reason');

  await transitionTo(ctx, actor, request, 'REJECTED', {
    approver_id: actor.id, decided_at: now, decision_notes: notes, rejection_reason: why,
  });
  await ctx.approvals.record(request.id, actor.id, 'REJECTED', notes, why, changes, now);
  await emit(ctx, actor, actor.orgId, [events.rejected(request, why)]);
  return { status: 'REJECTED' };
}

async function clarify(
  ctx: PurchasingContext, actor: Actor, request: any, changes: any[], notes: string | null, question: string, now: string) {
  const asked = question.trim();
  if (!asked) throw new PurchasingError('reason_required', 'a clarification must ask something');

  await transitionTo(ctx, actor, request, 'CLARIFICATION_REQUESTED', {
    approver_id: actor.id, clarification_question: asked, clarification_answer: null,
  });
  await ctx.approvals.record(request.id, actor.id, 'CLARIFICATION_REQUESTED', notes, asked, changes, now);
  await emit(ctx, actor, actor.orgId, [events.clarificationRequested(request, asked)]);
  return { status: 'CLARIFICATION_REQUESTED' };
}
