/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// decisions.ts — approve, reject, return for clarification.
//
// The three use cases share one entry point (`decidePurchaseRequest`) because
// they share one gate: the same approval capability, the same "is this request
// even awaiting a decision", the same self-approval audit stamp, and the same
// frozen record of what changed relative to the original request. Splitting
// them into three copies of that gate is how one of them ends up missing a
// check.
// ---------------------------------------------------------------------------

import { emit, loadRequest, must, PurchasingError, transitionTo, type PurchasingContext } from './context.ts';
import type { Actor } from './ports.ts';
import { changesFromOriginal, saveWorkshopReview } from './review.ts';
import { generatePurchaseOrder } from './fulfilment.ts';
import { recordPurchaseHistory } from './history.ts';
import { events } from '../domain/events.mjs';
import { isSelfApproval } from '../domain/roles.mjs';
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
  // BOTH of these are awaited, and the order between them is the rule this
  // function exists to enforce.
  //
  // They were previously called without `await`, which broke the rule in two
  // ways at once: the decision raced the save rather than following it, so
  // approve() read the review lines before they existed and threw
  // `nothing_to_order` — into a floating promise nobody was holding. The
  // caller got `{decided: true}` (spreading a pending promise contributes no
  // properties), reported success, and the request stayed in the queue.
  //
  // Pressing Approve twice appeared to work, because the second attempt found
  // the numbers the first attempt had saved.
  const totals = await saveWorkshopReview(ctx, actor, requestId, input);
  if (decision === 'SAVE') return { decided: false, ...totals };
  const result = await decidePurchaseRequest(ctx, actor, requestId, decision, decisionInput);
  return { decided: true, ...totals, ...result };
}

export async function decidePurchaseRequest(
  ctx: PurchasingContext, actor: Actor, requestId: string, decision: Decision,
  input: { notes?: string; reason?: string; question?: string } = {},
) {
  const request = await loadRequest(ctx, actor, requestId);
  // BR-011: the whole authorization question is "does this actor hold the
  // approval capability". Raising the request neither grants nor removes it.
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
    // A rejection ends the request, so it writes history here too. The RPC owns
    // the decision's transaction; this is a second statement against a request
    // that is already terminal, and it is idempotent, so a retry after a failure
    // between the two completes the record rather than duplicating it.
    if (decision === 'REJECT') {
      await recordPurchaseHistory(ctx, actor, requestId, 'REJECTED', input.reason ?? null);
    }

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
  // BR-011: an approver may decide their own request. The row records both
  // sides — requestor_id stays on the request, approver_id goes here — and the
  // stamp says explicitly when they are the same person.
  await ctx.approvals.record(request.id, actor.id, 'APPROVED', notes, null, changes, now, isSelfApproval(actor, request));

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
  await ctx.approvals.record(request.id, actor.id, 'REJECTED', notes, why, changes, now, isSelfApproval(actor, request));

  // REJECTED is terminal, so this is where the request's history is written.
  // The row records that the material was asked for and refused, and why — a
  // rejected request that vanished from history would make the record a list
  // of successes rather than of what happened.
  await recordPurchaseHistory(ctx, actor, request.id, 'REJECTED', why);

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
  await ctx.approvals.record(request.id, actor.id, 'CLARIFICATION_REQUESTED', notes, asked, changes, now, isSelfApproval(actor, request));
  await emit(ctx, actor, actor.orgId, [events.clarificationRequested(request, asked)]);
  return { status: 'CLARIFICATION_REQUESTED' };
}

/**
 * ONE PURCHASER ACTION: record the stock check, approve, and produce the
 * purchase order.
 *
 * WHY THIS EXISTS. The pilot found the workflow, not the rules, to be the
 * problem: the purchaser had to save a review, then choose a decision, then
 * navigate to another screen and press "generate PO" — three deliberate
 * operations to express one physical act ("I have counted the shelf, order the
 * difference, give me the paper"). The state machine was leaking into his
 * hands.
 *
 * So the composition moves DOWN here, where it can be tested and where each
 * step still runs its own authorization check, its own transition guard and
 * its own audit rows. Nothing is skipped and nothing is relaxed:
 *
 *   saveWorkshopReview  -> review.record_stock + review.set_quantities
 *   decidePurchaseRequest(APPROVE) -> review.decide, BR-011, transition guard
 *   generatePurchaseOrder -> po.generate, PO number allocation, the PDF
 *
 * A caller lacking any one of the three permissions is refused at that step,
 * exactly as before. The purchaser simply stops having to know there are three.
 *
 * IDEMPOTENT where it matters: generatePurchaseOrder() already returns the
 * existing order rather than burning a sequence value, so a double-click
 * produces one purchase order and one PO number.
 *
 * NOT INCLUDED, deliberately: marking the order placed with the vendor.
 * Printing paper is not ordering, and the moment the order actually goes to a
 * vendor is a distinct fact that drives receiving and every lead-time figure.
 * Folding it in here would record a purchase that had not happened yet.
 */
export async function reviewApproveAndCreatePo(
  ctx: PurchasingContext, actor: Actor, requestId: string,
  input: { workshopNotes?: string | null; lines: any[] },
  decisionInput: { notes?: string } = {},
) {
  // AUTHORIZE BEFORE ACTING, not only inside each step. Each of the three does
  // check its own permission, so this is redundant for security — and it is not
  // redundant for BEHAVIOUR: without it, somebody holding review.record_stock
  // but not review.decide would have their stock check written and then be
  // refused at the decision, leaving half the act done. Refusing first means
  // the request is untouched.
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'review.decide', request);
  await must(ctx, actor, 'po.generate', request);

  const decided = await saveReviewAndDecide(ctx, actor, requestId, input, 'APPROVE', decisionInput);
  const po = await generatePurchaseOrder(ctx, actor, requestId);
  return { ...decided, poNumber: po.poNumber, purchaseOrderId: po.purchaseOrderId, reusedPo: Boolean(po.reused) };
}
