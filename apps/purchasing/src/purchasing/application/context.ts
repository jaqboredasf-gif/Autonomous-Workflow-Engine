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
  PoNumberAllocator, PurchaseHistoryRepository, PurchaseOrderRepository, PurchaseRequestRepository,
  ReceiptRepository, ReferenceRepository, WorkshopReviewRepository,
} from '../domain/repositories.ts';
import type {
  Actor, AtomicOperations, AttachmentPort, AuditPort, AuthPort, Clock, DocumentPort,
  DocumentRenderer, EmailDraftPort, IdentityPort, NotificationPort, UnitOfWork,
} from './ports.ts';
import type { IntegrationProviders } from './integrations.ts';

import { executeTransition } from '@awe/workflow';

import { authorize } from '../domain/roles.mjs';
import { PURCHASING_WORKFLOW } from '../domain/purchasing-workflow.mjs';
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
  /**
   * The immutable record of what was actually purchased. Written once, when a
   * request reaches a terminal state; never updated, never deleted. Everything
   * derived from it (autocomplete ranking, last price, observed lead time) is a
   * read model computed on top — see application/history.ts and BR-012.
   */
  history: PurchaseHistoryRepository;
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
   * The seams where external systems attach — jobs, materials, vendors, the
   * vendor-email handoff, labour hours. Separate from the ports above because
   * these are OTHER PRODUCTS (QuickBooks, Microsoft 365, Exact Time) rather
   * than platform capabilities, and because the point of naming them is that a
   * use case can never reach one of those products directly.
   * See application/integrations.ts.
   */
  integrations: IntegrationProviders;
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
    // REQUIRED FOR THE SAME REASON, and missing for longer.
    //
    // mayReceiveAt() decides on the DESTINATION, not only the job: material
    // delivered to the shop counter is signed for by whoever holds the workshop
    // assignment, and NOT by a foreman assigned only to the job the material is
    // destined for — he is not standing there. Without this field that rule
    // could not be evaluated here, so `must()` and `allowed()` answered the
    // question with the destination missing while transitionTo() and
    // queries.ts answered it with the destination in hand.
    //
    // The two disagreed exactly where it mattered: `must()` waved a job-site
    // foreman past the gate for a workshop delivery, and the state machine then
    // refused him with "recordPartialReceipt requires receiving.record" — a
    // message naming the permission rather than the reason. It failed closed,
    // so nothing was ever wrongly received; what it cost was a truthful refusal.
    deliveryLocationKind: request.deliveryLocationKind ?? null,
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
 * 3. TAKE THE ACTION. Every state change in purchasing goes through here, and
 *    from here through the AWE workflow engine.
 *
 * WHAT THE ENGINE DECIDES: whether the action exists, whether it is legal from
 * this state, whether the actor holds its permission, whether its evidence is
 * present, and what it must record. All of that is one row of
 * PURCHASING_WORKFLOW rather than three fragments in three files.
 *
 * WHAT THIS FUNCTION STILL OWNS: the facts (five repository reads the engine
 * must never make), the policy (roles.mjs, which the engine must never import),
 * and the write itself. Those are the three boundaries that let the engine be
 * reused by an application that stores nothing the way this one does.
 *
 * The engine calls `recordEvent` after the state write and cannot be made to
 * skip it, which is the guarantee: a purchase request cannot reach a new state
 * without the workflow event that says how it got there. The RICH domain event
 * — with its payload, its notification target and its audit shape — is still
 * emitted by the use case through emit(); this is the skeletal one the engine
 * insists on, and the two are reconciled by a test asserting every workflow
 * action's event kind is a known activity action.
 */
export async function transitionTo(
  ctx: PurchasingContext, actor: Actor, request: any, action: string, patch: Record<string, unknown> = {},
) {
  const facts = {
    ...(await transitionFacts(ctx, request)),
    // Ownership is a FACT about the pairing of this actor and this record, so
    // it travels with the other facts rather than being a second argument the
    // engine would have to understand.
    isOwner: request.requestorId === actor.id || request.createdBy === actor.id,
  };
  const result = await executeTransition({
    workflow: PURCHASING_WORKFLOW,
    action,
    from: request.status,
    facts,
    // THE POLICY BOUNDARY. The engine asks a question and believes the answer;
    // it never learns what a role is. Ownership-scoped permissions are resolved
    // against this record, so cancelling your own request works exactly as it
    // did — authorize() is still the only thing deciding.
    can: (permission: string) => authorize(actor, permission, { request }).ok,
    effects: {
      applyState: async (to: string) => {
        await ctx.requests.update(request.id, request.version, {
          status: to,
          updated_at: ctx.clock.now(),
          updated_by: actor.id,
          ...patch,
        });
      },
      // The engine's own record that the transition happened. Written to the
      // same append-only activity log every other event goes to.
      recordEvent: async (event: any) => {
        await ctx.audit.record(actor.orgId, actor, {
          action: event.kind,
          entityType: 'purchase_request',
          entityId: request.id,
          requestId: request.id,
          before: { status: event.from },
          after: { status: event.to },
          payload: { workflowAction: event.action },
        });
      },
    },
  });

  if (!result.ok) {
    throw new PurchasingError(result.reason ?? 'illegal_transition', result.message ?? 'illegal transition');
  }
  return { ...request, status: result.to, version: request.version + 1 };
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
