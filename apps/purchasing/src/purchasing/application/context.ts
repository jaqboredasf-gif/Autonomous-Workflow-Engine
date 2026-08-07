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
  ApprovalRepository, EmailDraftRepository, InventoryRepository, ItemCatalogRepository,
  PoNumberAllocator, PurchaseOrderRepository, PurchaseRequestRepository, ReceiptRepository,
  ReferenceRepository, WorkshopReviewRepository,
} from '../domain/repositories.ts';
import type {
  Actor, AtomicOperations, AttachmentPort, AuditPort, AuthPort, Clock, DocumentPort,
  DocumentRenderer, EmailDraftPort, IdentityPort, NotificationPort, UnitOfWork,
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
  /** The organization's own materials vocabulary, read from its history. */
  catalog: ItemCatalogRepository;
  poNumbers: PoNumberAllocator;
  identity: IdentityPort;
  auth: AuthPort;
  audit: AuditPort;
  notifications: NotificationPort;
  documents: DocumentPort;
  renderer: DocumentRenderer;
  attachments: AttachmentPort;
  email: EmailDraftPort;
  /**
   * Present only when the provider can do a multi-write operation atomically
   * server-side. Absent on the local provider, whose unit of work is already a
   * real transaction.
   */
  atomic?: AtomicOperations;
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
export async function must(
  ctx: PurchasingContext, actor: Actor | null, permission: string, request: any = null,
): Promise<void> {
  const settings = actor ? await ctx.reference.settings(actor.orgId) : {};
  // The decision itself is a pure domain call and stays synchronous; only
  // fetching what it needs to decide with is asynchronous.
  const decision = authorize(actor, permission, { request: authzView(request), settings });
  if (decision.ok) return;
  if (actor) {
    await ctx.audit.record(
      actor.orgId, actor,
      events.accessDenied(request?.id ?? null, permission, decision.reason, decision.message),
    );
  }
  throw new PurchasingError(decision.reason ?? 'denied', decision.message ?? 'not permitted');
}

export async function allowed(
  ctx: PurchasingContext, actor: Actor | null, permission: string, request: any = null,
): Promise<boolean> {
  const settings = actor ? await ctx.reference.settings(actor.orgId) : {};
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
    // REQUIRED. authorize() scopes `receiving.record` and `deliveries.confirm`
    // to the caller's assigned jobs, and it reads the job from HERE. Dropping
    // it made the assignment check compare against undefined, which is never
    // in anybody's assignment list — so a foreman was refused receiving on his
    // own job site, every time. It failed closed, which is the safe direction
    // and the reason it was survivable, but the feature could not work.
    jobNumber: request.jobNumber,
  };
}

/**
 * 2. LOAD WITHIN THE TENANT. A record from another organization is *not found*,
 *    never *forbidden* — the difference leaks whether it exists.
 */
export async function loadRequest(ctx: PurchasingContext, actor: Actor, requestId: string) {
  const request = await ctx.requests.findById(requestId);
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
export async function transitionTo(
  ctx: PurchasingContext, actor: Actor, request: any, to: string, patch: Record<string, unknown> = {},
) {
  // The guard is pure; the FACTS it judges come from persistence.
  const guard = transitionGuard(request.status, to, await transitionFacts(ctx, request));
  if (!guard.ok) throw new PurchasingError(guard.reason ?? 'illegal_transition', guard.message ?? 'illegal transition');
  await ctx.requests.update(request.id, request.version, {
    status: to,
    updated_at: ctx.clock.now(),
    updated_by: actor.id,
    ...patch,
  });
  return { ...request, status: to, version: request.version + 1 };
}

export async function transitionFacts(ctx: PurchasingContext, request: any) {
  // Independent reads, so they go together rather than in a queue of round
  // trips — this is the shape that matters once the provider is remote.
  const [review, order, drafts, receipts, progress] = await Promise.all([
    ctx.reviews.findByRequest(request.id),
    ctx.orders.findByRequest(request.id),
    ctx.drafts.listForRequest(request.id),
    ctx.receipts.listForRequest(request.id),
    ctx.orders.progressFor(request.id),
  ]);
  const reviewedDraft = drafts.some((d: any) => d.templateKey === 'VENDOR_PURCHASE_ORDER' && d.reviewedAt);
  return {
    hasReview: Boolean(review?.savedAt),
    hasPurchaseOrder: Boolean(order),
    hasReviewedEmailDraft: reviewedDraft,
    hasReceipt: receipts.length > 0,
    outstandingLines: progress.filter((p: any) => p.outstandingQty > 0).length,
  };
}

/** Publish a use case's domain events: audit first, then notification. */
export async function emit(ctx: PurchasingContext, actor: Actor, orgId: string, list: any[]) {
  // Sequential on purpose: the audit trail is ordered, and a notification must
  // never be published for an event that failed to record.
  for (const event of list) {
    if (!event) continue;
    await ctx.audit.record(orgId, actor, event);
    if (event.notify) await ctx.notifications.publish(orgId, event.notify, event.requestId, event.payload);
  }
}
