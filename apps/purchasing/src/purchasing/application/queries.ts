/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// queries.ts — the read side.
//
// Reads are use cases too: what you may see is an authorization decision, and
// "my requests" versus "all requests" is that decision, not a UI preference.
// The detail view also returns `actions` — what this viewer may do — computed
// from the same authorize() the write path enforces with, so the UI cannot
// offer a button the server would refuse.
// ---------------------------------------------------------------------------

import { allowed, loadRequest, must, type PurchasingContext } from './context.ts';
import type { Actor } from './ports.ts';
import { availableActions, isApprover } from '../domain/roles.mjs';
import { QUEUE_STATUSES } from '../domain/status.mjs';

export function listRequests(ctx: PurchasingContext, actor: Actor) {
  return allowed(ctx, actor, 'request.read.all')
    ? ctx.requests.listForOrg(actor.orgId)
    : ctx.requests.listForRequestor(actor.orgId, actor.id);
}

export function approvalQueue(ctx: PurchasingContext, actor: Actor) {
  must(ctx, actor, 'review.read_queue');
  return listRequests(ctx, actor).filter((r) => QUEUE_STATUSES.includes(r.status));
}

export function getRequestDetail(ctx: PurchasingContext, actor: Actor, requestId: string) {
  const request = loadRequest(ctx, actor, requestId);
  if (!allowed(ctx, actor, 'request.read.all', request)) must(ctx, actor, 'request.read.own', request);

  const settings = ctx.reference.settings(actor.orgId);
  const order = ctx.orders.findByRequest(requestId);

  return {
    request,
    // Section A of the approval screen. Read-only, forever.
    originalItems: ctx.requests.itemsFor(requestId),
    // Section B. Nothing here can overwrite Section A.
    reviewLines: ctx.reviews.linesFor(requestId),
    attachments: ctx.requests.attachmentsFor(requestId),
    purchaseOrder: order
      ? {
          ...order,
          documents: ctx.documents.listFor(order.id),
          items: ctx.orders.itemsFor(order.id),
        }
      : null,
    emailDrafts: ctx.drafts.listForRequest(requestId),
    receipts: ctx.receipts.listForRequest(requestId),
    progress: ctx.orders.progressFor(requestId),
    approvals: ctx.approvals.listForRequest(requestId),
    timeline: ctx.audit.timelineFor(requestId),
    actions: availableActions(actor, authzView(request), { settings }),
    viewer: { id: actor.id, name: actor.name, roles: actor.roles, isApprover: isApprover(actor) },
  };
}

export function purchaseOrderView(ctx: PurchasingContext, purchaseOrderId: string) {
  return ctx.orders.view(purchaseOrderId);
}

export function orderProgress(ctx: PurchasingContext, requestId: string) {
  return ctx.orders.progressFor(requestId);
}

export function reviewLines(ctx: PurchasingContext, requestId: string) {
  return ctx.reviews.linesFor(requestId);
}

export function listVendors(ctx: PurchasingContext, actor: Actor) {
  return ctx.reference.vendors(actor.orgId);
}

export function listDeliveryLocations(ctx: PurchasingContext, actor: Actor) {
  return ctx.reference.deliveryLocations(actor.orgId);
}

export function listJobs(ctx: PurchasingContext, actor: Actor) {
  return ctx.reference.jobs(actor.orgId);
}

export function listUsers(ctx: PurchasingContext, actor: Actor) {
  return ctx.identity.listUsers(actor.orgId);
}

export function listNotifications(ctx: PurchasingContext, actor: Actor) {
  return ctx.notifications.inboxFor(actor.id);
}

export function auditLog(ctx: PurchasingContext, actor: Actor, limit = 200) {
  must(ctx, actor, 'admin.audit');
  return ctx.audit.orgLog(actor.orgId, limit);
}

export function listEmailTemplates(ctx: PurchasingContext, actor: Actor) {
  must(ctx, actor, 'admin.templates');
  return ctx.reference.emailTemplates(actor.orgId);
}

/**
 * A stored PO document, for download. Authorization is not skipped because it
 * is "just a file": the caller must be able to read the request the document
 * belongs to, and the document must be in their organization. Files are records.
 */
export function getDocumentForDownload(ctx: PurchasingContext, actor: Actor, documentId: string) {
  const document = ctx.documents.get(documentId);
  if (!document) return null;
  const order = ctx.orders.findById(document.purchase_order_id);
  if (!order || order.orgId !== actor.orgId) return null;
  // Throws not_found for a request this viewer may not see.
  getRequestDetail(ctx, actor, order.requestId);
  return {
    filename: document.filename,
    contentType: document.content_type,
    byteSize: Number(document.byte_size),
    bytes: Buffer.from(document.data_base64, 'base64'),
  };
}

function authzView(request: any) {
  return {
    id: request.id,
    orgId: request.orgId,
    requestorId: request.requestorId,
    createdBy: request.createdBy,
    status: request.status,
  };
}
