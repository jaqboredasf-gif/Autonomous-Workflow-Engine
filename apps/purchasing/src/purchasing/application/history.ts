/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// history.ts — THE WRITE POINT for immutable purchasing history.
//
// One function, called from exactly three places: the three ways a purchase
// request ends.
//
//   completePurchaseRequest  -> COMPLETED   (fulfilment.ts)
//   cancelPurchaseRequest    -> CANCELLED   (requests.ts)
//   decidePurchaseRequest    -> REJECTED    (decisions.ts)
//
// WHY HERE AND NOT IN THE REPOSITORY, A TRIGGER, OR AN EVENT HANDLER
//   * a repository must not decide, and "what does this row say" is a decision
//   * a database trigger would have to be written twice, once per provider, in
//     two languages, and the two copies would drift — the failure this codebase
//     already has a 268-check conformance suite to prevent
//   * an event handler runs after the transaction, so a crash between the two
//     would leave a completed purchase with no history and nothing to notice it
//
// It runs INSIDE the terminal transition's unit of work. If history cannot be
// written, the request does not complete. That is the intended trade: a
// completion nobody can reconstruct is worse than a completion that failed
// loudly and can be retried.
//
// Retry is safe. The rows are keyed (orgId, requestId, requestItemId) and the
// repositories insert-or-ignore, so calling this twice writes nothing the
// second time. See PurchaseHistoryRepository.
// ---------------------------------------------------------------------------

import { must, PurchasingError, type PurchasingContext } from './context.ts';
import type { PurchaseHistoryLineRecord } from '../domain/repositories.ts';
import type { Actor } from './ports.ts';
import { buildHistoryLines, HISTORY_TERMINAL_STATES } from '../domain/history.mjs';

/**
 * Write the history of a request that has just reached a terminal state.
 *
 * `request` must be re-read AFTER the transition: `completed_at`, `received_at`
 * and the final status are part of what history records, and the caller's copy
 * predates the write that set them.
 */
export async function recordPurchaseHistory(
  ctx: PurchasingContext, actor: Actor, requestId: string,
  terminalState: 'COMPLETED' | 'CANCELLED' | 'REJECTED',
  terminalReason: string | null = null,
): Promise<{ inserted: number; skipped: number }> {
  if (!HISTORY_TERMINAL_STATES.includes(terminalState)) {
    throw new PurchasingError('history_before_terminal', `${terminalState} is not a state history is written in`);
  }

  const request = await ctx.requests.findById(requestId);
  if (!request || request.orgId !== actor.orgId) {
    throw new PurchasingError('not_found', `purchase request ${requestId} not found`);
  }

  // Independent reads, together: this runs on the completion path and the
  // provider may be remote.
  const [requestItems, reviewLines, order, progress, job] = await Promise.all([
    ctx.requests.itemsFor(requestId),
    ctx.reviews.linesFor(requestId),
    ctx.orders.findByRequest(requestId),
    ctx.orders.progressFor(requestId),
    ctx.reference.jobByNumber(actor.orgId, request.jobNumber).catch(() => null),
  ]);

  // The vendor NAME is read from the purchase order's own view rather than from
  // the vendor directory: a vendor that has since been deactivated is missing
  // from `reference.vendors()`, and history must still be able to say who the
  // material was bought from. When the request never became an order, the
  // workshop's line carries the name it chose.
  const [orderItems, view] = order
    ? await Promise.all([ctx.orders.itemsFor(order.id), ctx.orders.view(order.id)])
    : [[], null];

  const [requestor, approver] = await Promise.all([
    loadPerson(ctx, request.requestorId),
    request.approverId ? loadPerson(ctx, request.approverId) : Promise.resolve(null),
  ]);

  const lines = buildHistoryLines({
    request,
    requestItems,
    reviewLines,
    order,
    orderItems,
    progress,
    vendor: view?.vendor ?? null,
    job: job ? { id: job.id, jobNumber: job.job_number ?? job.jobNumber ?? request.jobNumber } : null,
    requestor,
    approver,
    terminalState,
    terminalReason,
    recordedAt: ctx.clock.now(),
    recordedBy: actor.id,
  });

  if (!lines.length) return { inserted: 0, skipped: 0 };
  // domain/history.mjs is plain JavaScript shared by both providers, so its
  // return type is `object[]` here. The shape is asserted instead — the domain
  // suite checks every row against HISTORY_LINE_FIELDS, which is a stronger
  // guarantee than a structural cast would be.
  return ctx.history.record(lines as PurchaseHistoryLineRecord[], ctx.clock.now());
}

/**
 * The name to snapshot for a person. A user who is later renamed, deactivated
 * or deleted must not change what a historical row says they were called, which
 * is why the name is copied INTO the row rather than joined at read time.
 */
async function loadPerson(ctx: PurchasingContext, userId: string) {
  const person = await ctx.identity.load(userId).catch(() => null);
  return person ? { id: person.id, name: person.name } : { id: userId, name: null };
}

// ---------------------------------------------------------------------------
// READS. Derived intelligence, computed from history and never written back.
// ---------------------------------------------------------------------------

/**
 * One organization's history, newest first.
 *
 * `request.read.all` — the same permission the materials catalogue asks for,
 * and for the same reason: this is a management view of what the company buys,
 * not part of raising a request.
 */
export async function purchaseHistory(
  ctx: PurchasingContext, actor: Actor,
  options: { limit?: number; normalizedDescription?: string; vendorId?: string } = {},
) {
  await must(ctx, actor, 'request.read.all');
  return ctx.history.listForOrg(actor.orgId, options);
}

/** The history rows one request produced. Empty until the request has ended. */
export async function purchaseHistoryForRequest(ctx: PurchasingContext, actor: Actor, requestId: string) {
  await must(ctx, actor, 'request.read.all');
  return ctx.history.forRequest(actor.orgId, requestId);
}
