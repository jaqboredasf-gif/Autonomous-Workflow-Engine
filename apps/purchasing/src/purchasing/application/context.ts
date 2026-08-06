/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// context.ts — what every use case receives, and the three checks every use
// case makes before it writes.
//
// A use case takes (ctx, actor, input) and returns a result. It never imports a
// database handle, a React type, a Next request, or a table name. Everything it
// touches arrives through this context, which is why the whole application
// layer can be tested against in-memory fakes.
// ---------------------------------------------------------------------------

import type {
  ApprovalRepository, EmailDraftRepository, InventoryRepository, PoNumberAllocator,
  PurchaseOrderRepository, PurchaseRequestRepository, ReceiptRepository, ReferenceRepository,
  WorkshopReviewRepository,
} from '../domain/repositories.ts';
import type {
  Actor, AttachmentPort, AuditPort, AuthPort, Clock, DocumentPort, DocumentRenderer,
  EmailDraftPort, IdentityPort, NotificationPort, UnitOfWork,
} from './ports.ts';

import { authorize } from '../domain/roles.mjs';
import { transitionGuard } from '../domain/status.mjs';
import { events } from '../domain/events.mjs';

export type PurchasingContext = {
  clock: Clock;
  uow: UnitOfWork;
  requests: PurchaseRequestRepository;
  reviews: WorkshopReviewRepository;
  approvals: ApprovalRepository;
  orders: PurchaseOrderRepository;
  drafts: EmailDraftRepository;
  receipts: ReceiptRepository;
  inventory: InventoryRepository;
  reference: ReferenceRepository;
  poNumbers: PoNumberAllocator;
  identity: IdentityPort;
  auth: AuthPort;
  audit: AuditPort;
  notifications: NotificationPort;
  documents: DocumentPort;
  renderer: DocumentRenderer;
  attachments: AttachmentPort;
  email: EmailDraftPort;
};

/**
 * The error every use case throws. `reason` is from a closed vocabulary
 * (domain guards, authorization denials, validation codes) so callers — the UI,
 * the harness — can branch on the reason rather than parse a message.
 */
export class PurchasingError extends Error {
  reason: string;
  details: unknown;
  constructor(reason: string, message: string, details: unknown = null) {
    super(message);
    this.name = 'PurchasingError';
    this.reason = reason;
    this.details = details;
  }
}

/** Anything the domain threw (DomainError) becomes a PurchasingError as-is. */
export function rethrowDomain(err: any): never {
  if (err?.name === 'DomainError') throw new PurchasingError(err.reason, err.message, err.details);
  throw err;
}

// --- the three checks -------------------------------------------------------

/**
 * 1. AUTHORIZE. Runs before anything else, and a refusal is RECORDED before it
 *    is thrown: a probe should leave a trace, not just a 403.
 */
export function must(ctx: PurchasingContext, actor: Actor | null, permission: string, request: any = null): void {
  const settings = actor ? ctx.reference.settings(actor.orgId) : {};
  const decision = authorize(actor, permission, { request: authzView(request), settings });
  if (decision.ok) return;
  if (actor) {
    ctx.audit.record(actor.orgId, actor, events.accessDenied(request?.id ?? null, permission, decision.reason, decision.message));
  }
  throw new PurchasingError(decision.reason ?? 'denied', decision.message ?? 'not permitted');
}

export function allowed(ctx: PurchasingContext, actor: Actor | null, permission: string, request: any = null): boolean {
  const settings = actor ? ctx.reference.settings(actor.orgId) : {};
  return authorize(actor, permission, { request: authzView(request), settings }).ok;
}

function authzView(request: any) {
  if (!request) return null;
  return {
    id: request.id,
    orgId: request.orgId,
    requestorId: request.requestorId,
    createdBy: request.createdBy,
    status: request.status,
  };
}

/**
 * 2. LOAD WITHIN THE TENANT. A record from another organization is *not found*,
 *    never *forbidden* — the difference leaks whether it exists.
 */
export function loadRequest(ctx: PurchasingContext, actor: Actor, requestId: string) {
  const request = ctx.requests.findById(requestId);
  if (!request || request.orgId !== actor.orgId) {
    throw new PurchasingError('not_found', `purchase request ${requestId} not found`);
  }
  return request;
}

/**
 * 3. GUARD THE TRANSITION, then write. The guard's content preconditions are
 *    answered from repositories, so "can this move?" is one question with one
 *    answer wherever it is asked.
 */
export function transitionTo(
  ctx: PurchasingContext, actor: Actor, request: any, to: string, patch: Record<string, unknown> = {},
) {
  const guard = transitionGuard(request.status, to, transitionFacts(ctx, request));
  if (!guard.ok) throw new PurchasingError(guard.reason ?? 'illegal_transition', guard.message ?? 'illegal transition');
  ctx.requests.update(request.id, request.version, {
    status: to,
    updated_at: ctx.clock.now(),
    updated_by: actor.id,
    ...patch,
  });
  return { ...request, status: to, version: request.version + 1 };
}

export function transitionFacts(ctx: PurchasingContext, request: any) {
  const review = ctx.reviews.findByRequest(request.id);
  const order = ctx.orders.findByRequest(request.id);
  const reviewedDraft = ctx.drafts
    .listForRequest(request.id)
    .some((d: any) => d.templateKey === 'VENDOR_PURCHASE_ORDER' && d.reviewedAt);
  const receipts = ctx.receipts.listForRequest(request.id);
  const progress = ctx.orders.progressFor(request.id);
  return {
    hasReview: Boolean(review?.savedAt),
    hasPurchaseOrder: Boolean(order),
    hasReviewedEmailDraft: reviewedDraft,
    hasReceipt: receipts.length > 0,
    outstandingLines: progress.filter((p: any) => p.outstandingQty > 0).length,
  };
}

/** Publish a use case's domain events: audit first, then notification. */
export function emit(ctx: PurchasingContext, actor: Actor, orgId: string, list: any[]) {
  for (const event of list) {
    if (!event) continue;
    ctx.audit.record(orgId, actor, event);
    if (event.notify) ctx.notifications.publish(orgId, event.notify, event.requestId, event.payload);
  }
}
