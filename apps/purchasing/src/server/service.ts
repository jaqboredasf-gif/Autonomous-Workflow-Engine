/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// service.ts — the module's PUBLIC FACADE, and nothing else.
//
// This file used to be the whole purchasing system: 1,755 lines of use cases,
// SQL, PDF calls, audit writes and notification fan-out in one place. It is now
// a thin surface over the bounded context:
//
//   src/purchasing/domain/         entities, value objects, rules, transitions,
//                                  domain events, repository interfaces
//   src/purchasing/application/    use cases + the ports for the shared AWE
//                                  capabilities purchasing consumes
//   src/purchasing/infrastructure/ SQLite repositories, PDF, documents, audit,
//                                  notifications, attachments, identity
//   src/app + src/components       the UI
//
// It exists for two reasons, both deliberate:
//   1. the UI and the test harness import ONE module and keep working across
//      the refactor — no screen and no assertion had to change;
//   2. it is the seam where a caller is handed a composed context, so nothing
//      outside `src/purchasing/` ever constructs a repository or an adapter.
//
// New code should import the use case it needs from src/purchasing/application
// directly. This facade will not grow.
// ---------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';

import { getDb } from '../purchasing/infrastructure/sqlite/database.ts';
import { purchasingContext } from '../purchasing/composition.ts';
import { PurchasingError, type PurchasingContext } from '../purchasing/application/context.ts';
import type { Actor } from '../purchasing/application/ports.ts';

import * as requests from '../purchasing/application/requests.ts';
import * as review from '../purchasing/application/review.ts';
import * as decisions from '../purchasing/application/decisions.ts';
import * as fulfilment from '../purchasing/application/fulfilment.ts';
import * as queries from '../purchasing/application/queries.ts';
import * as history from '../purchasing/application/history.ts';
import * as administration from '../purchasing/application/administration.ts';

import { identityAdapter } from '../purchasing/infrastructure/adapters.ts';
import { sqliteReferenceRepository } from '../purchasing/infrastructure/sqlite/repositories.ts';

export type { Actor };
export type RequestDraft = requests.RequestDraftInput;
export type ReviewLineInput = review.ReviewLineInput;
export type ReceiptLineInput = fulfilment.ReceiptLineInput;

/** The error callers branch on. `reason` is a closed vocabulary. */
export { PurchasingError as ServiceError };

/** Compose a purchasing context. `now` is injectable for deterministic tests. */
export function context(db: DatabaseSync = getDb(), now?: string): PurchasingContext {
  return purchasingContext(db, now);
}

// --- identity + settings (through the ports, never the tables) --------------

export async function loadActor(db: DatabaseSync, userId: string): Promise<Actor | null> {
  return identityAdapter(db).load(userId);
}

export async function loadSettings(db: DatabaseSync, orgId: string) {
  return sqliteReferenceRepository(db).settings(orgId);
}

// --- requestor use cases ----------------------------------------------------

export const createRequest = (ctx: PurchasingContext, actor: Actor, payload: any) =>
  requests.createPurchaseRequest(ctx, actor, payload);

export const updateRequest = (ctx: PurchasingContext, actor: Actor, requestId: string, payload: any) =>
  requests.updatePurchaseRequest(ctx, actor, requestId, payload);

export const submitRequest = (ctx: PurchasingContext, actor: Actor, requestId: string) =>
  requests.submitPurchaseRequest(ctx, actor, requestId);

export const answerClarification = (ctx: PurchasingContext, actor: Actor, requestId: string, answer: string) =>
  requests.respondToClarification(ctx, actor, requestId, answer);

export const cancelRequest = (ctx: PurchasingContext, actor: Actor, requestId: string, reason: string) =>
  requests.cancelPurchaseRequest(ctx, actor, requestId, reason);

export const addNote = (ctx: PurchasingContext, actor: Actor, requestId: string, note: string) =>
  requests.addNote(ctx, actor, requestId, note);

export const addAttachment = (ctx: PurchasingContext, actor: Actor, requestId: string, file: any) =>
  requests.attachFile(ctx, actor, requestId, file);

// --- workshop use cases -----------------------------------------------------

export const saveReview = (ctx: PurchasingContext, actor: Actor, requestId: string, input: any) =>
  review.saveWorkshopReview(ctx, actor, requestId, input);

export const changesFromOriginal = (ctx: PurchasingContext, requestId: string) =>
  review.changesFromOriginal(ctx, requestId);

export const decide = (
  ctx: PurchasingContext, actor: Actor, requestId: string,
  decision: decisions.Decision, input: any = {},
) => decisions.decidePurchaseRequest(ctx, actor, requestId, decision, input);

// --- fulfilment use cases ---------------------------------------------------

export const generatePurchaseOrder = (ctx: PurchasingContext, actor: Actor, requestId: string) =>
  fulfilment.generatePurchaseOrder(ctx, actor, requestId);

export const generatePoDocument = (ctx: PurchasingContext, actor: Actor, purchaseOrderId: string) =>
  fulfilment.renderAndStore(ctx, actor, purchaseOrderId, ctx.clock.now());

export const generateVendorEmailDraft = (ctx: PurchasingContext, actor: Actor, requestId: string) =>
  fulfilment.generateVendorEmailDraft(ctx, actor, requestId);

export const updateEmailDraft = (ctx: PurchasingContext, actor: Actor, draftId: string, patch: any) =>
  fulfilment.editVendorEmailDraft(ctx, actor, draftId, patch);

export const advanceEmailDraft = (ctx: PurchasingContext, actor: Actor, draftId: string, to: any, notes?: string) =>
  fulfilment.advanceVendorEmailDraft(ctx, actor, draftId, to, notes);

export const markOrdered = (ctx: PurchasingContext, actor: Actor, requestId: string, input: any = {}) =>
  fulfilment.markOrderPlaced(ctx, actor, requestId, input);

export const updateTracking = (ctx: PurchasingContext, actor: Actor, requestId: string, input: any) =>
  fulfilment.updateTracking(ctx, actor, requestId, input);

export const recordReceipt = (ctx: PurchasingContext, actor: Actor, requestId: string, input: any) =>
  fulfilment.recordReceipt(ctx, actor, requestId, input);

export const completeRequest = (ctx: PurchasingContext, actor: Actor, requestId: string, notes?: string) =>
  fulfilment.completePurchaseRequest(ctx, actor, requestId, notes);

/**
 * PO number allocation, exposed because the concurrency gate drives it directly
 * from worker threads. It is a repository call: the number comes from the
 * database under a write lock, never from this process.
 */
export const allocatePoNumber = (ctx: PurchasingContext, orgId: string) =>
  ctx.poNumbers.allocate(orgId, ctx.clock.now());

// --- reads ------------------------------------------------------------------

export const listRequests = queries.listRequests;
export const approvalQueue = queries.approvalQueue;
export const getRequestDetail = queries.getRequestDetail;
export const purchaseOrderView = queries.purchaseOrderView;
export const orderProgress = queries.orderProgress;
export const reviewLines = queries.reviewLines;
export const listVendors = queries.listVendors;
export const listDeliveryLocations = queries.listDeliveryLocations;
export const listJobs = queries.listJobs;
export const listUsers = queries.listUsers;
export const listNotifications = queries.listNotifications;
export const auditLog = queries.auditLog;

/**
 * The immutable record of what was actually purchased. READ ONLY through this
 * facade on purpose: history is written by the use cases that end a request,
 * and there is no path here — or anywhere above infrastructure — that edits it.
 */
export const purchaseHistory = history.purchaseHistory;
export const requestHistory = history.purchaseHistoryForRequest;

// --- administration ---------------------------------------------------------

export const poConfig = administration.poConfig;

export const updatePoConfig = (ctx: PurchasingContext, actor: Actor, input: any) =>
  administration.updatePoConfig(ctx, actor, input);

export const setApprovalAuthority = (ctx: PurchasingContext, actor: Actor, userId: string, canApprove: boolean) =>
  administration.setApprovalAuthority(ctx, actor, userId, canApprove);
