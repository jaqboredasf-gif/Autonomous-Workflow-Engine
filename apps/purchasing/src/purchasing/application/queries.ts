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

export async function listRequests(ctx: PurchasingContext, actor: Actor) {
  return await allowed(ctx, actor, 'request.read.all')
    ? await ctx.requests.listForOrg(actor.orgId)
    : await ctx.requests.listForRequestor(actor.orgId, actor.id);
}

export async function approvalQueue(ctx: PurchasingContext, actor: Actor) {
  await must(ctx, actor, 'review.read_queue');
  return (await listRequests(ctx, actor)).filter((r) => QUEUE_STATUSES.includes(r.status));
}

export async function getRequestDetail(ctx: PurchasingContext, actor: Actor, requestId: string) {
  const request = await loadRequest(ctx, actor, requestId);
  if (!await allowed(ctx, actor, 'request.read.all', request)) await must(ctx, actor, 'request.read.own', request);

  const settings = await ctx.reference.settings(actor.orgId);
  const order = await ctx.orders.findByRequest(requestId);

  return {
    request,
    // Section A of the approval screen. Read-only, forever.
    originalItems: await ctx.requests.itemsFor(requestId),
    // Section B. Nothing here can overwrite Section A.
    reviewLines: await ctx.reviews.linesFor(requestId),
    attachments: await ctx.requests.attachmentsFor(requestId),
    purchaseOrder: order
      ? {
          ...order,
          documents: await ctx.documents.listFor(order.id),
          items: await ctx.orders.itemsFor(order.id),
        }
      : null,
    emailDrafts: await ctx.drafts.listForRequest(requestId),
    receipts: await ctx.receipts.listForRequest(requestId),
    progress: await ctx.orders.progressFor(requestId),
    approvals: await ctx.approvals.listForRequest(requestId),
    timeline: await ctx.audit.timelineFor(requestId),
    actions: availableActions(actor, authzView(request), { settings }),
    viewer: { id: actor.id, name: actor.name, roles: actor.roles, isApprover: isApprover(actor) },
  };
}

export async function purchaseOrderView(ctx: PurchasingContext, purchaseOrderId: string) {
  return await ctx.orders.view(purchaseOrderId);
}

export async function orderProgress(ctx: PurchasingContext, requestId: string) {
  return await ctx.orders.progressFor(requestId);
}

export async function reviewLines(ctx: PurchasingContext, requestId: string) {
  return await ctx.reviews.linesFor(requestId);
}

export async function listVendors(ctx: PurchasingContext, actor: Actor) {
  return await ctx.reference.vendors(actor.orgId);
}

export async function listDeliveryLocations(ctx: PurchasingContext, actor: Actor) {
  return await ctx.reference.deliveryLocations(actor.orgId);
}

export async function listJobs(ctx: PurchasingContext, actor: Actor) {
  return await ctx.reference.jobs(actor.orgId);
}

export async function listUsers(ctx: PurchasingContext, actor: Actor) {
  return await ctx.identity.listUsers(actor.orgId);
}

export async function listNotifications(ctx: PurchasingContext, actor: Actor) {
  return await ctx.notifications.inboxFor(actor.id);
}

export async function auditLog(ctx: PurchasingContext, actor: Actor, limit = 200) {
  await must(ctx, actor, 'admin.audit');
  return await ctx.audit.orgLog(actor.orgId, limit);
}

/**
 * Deliveries this person may confirm: open orders on the job sites they are
 * assigned to. Office and workshop staff are not assignment-scoped — receiving
 * at the shop counter is their job — so they see every open order.
 */
export async function deliveriesForActor(ctx: PurchasingContext, actor: Actor) {
  await must(ctx, actor, 'deliveries.confirm');
  const fieldOnly = !actor.roles.some((r) => ['OFFICE', 'ACCOUNTING', 'WORKSHOP_APPROVER', 'ADMIN'].includes(r));
  const all = await ctx.requests.listForOrg(actor.orgId);
  return all
    .filter((r) => ['ORDERED', 'PARTIALLY_RECEIVED'].includes(r.status))
    .filter((r) => !fieldOnly || actor.assignedJobNumbers.includes(r.jobNumber));
}

/**
 * The accounting-ready packet for a request: the purchase order, what was
 * ordered against it, every receipt with who signed and when, the evidence
 * attached to each, and the discrepancies worth a human's attention before an
 * invoice is paid.
 */
export async function accountingPacket(ctx: PurchasingContext, actor: Actor, requestId: string) {
  await must(ctx, actor, 'accounting.read');
  const detail = await getRequestDetail(ctx, actor, requestId);
  // One identity lookup per receipt, resolved together rather than in series.
  const receipts = await Promise.all(
    detail.receipts.map(async (receipt: any) => ({
      ...receipt,
      receivedByName: (await ctx.identity.load(receipt.receivedBy ?? ''))?.name ?? null,
    })),
  );

  const discrepancies: Array<{ line: string; kind: string; detail: string }> = [];
  for (const line of detail.progress) {
    if (line.outstandingQty > 0) {
      discrepancies.push({ line: line.description, kind: 'short', detail: `${line.outstandingQty / 1000} not yet received` });
    }
    if (line.damagedQty > 0) {
      discrepancies.push({ line: line.description, kind: 'damaged', detail: `${line.damagedQty / 1000} damaged` });
    }
    if (line.backorderedQty > 0) {
      discrepancies.push({ line: line.description, kind: 'backordered', detail: `${line.backorderedQty / 1000} backordered` });
    }
    if (line.receivedQty > line.finalOrderQty) {
      discrepancies.push({ line: line.description, kind: 'over', detail: 'more received than ordered' });
    }
  }

  return { ...detail, receipts, discrepancies };
}

/** One receipt, with its evidence — the office and accounting view. */
export async function receiptEvidence(ctx: PurchasingContext, actor: Actor, receiptId: string) {
  const receipt = await ctx.receipts.findById(receiptId);
  if (!receipt || receipt.orgId !== actor.orgId) return null;
  // Reuses the request's own access rule: if you may not see the request, you
  // may not see what arrived against it.
  const detail = await getRequestDetail(ctx, actor, receipt.requestId);
  return {
    receipt: { ...receipt, receivedByName: (await ctx.identity.load(receipt.receivedBy))?.name ?? null },
    request: detail.request,
    purchaseOrder: detail.purchaseOrder,
    progress: detail.progress,
    attachments: await ctx.receipts.attachmentsFor(receiptId),
  };
}

export async function listEmailTemplates(ctx: PurchasingContext, actor: Actor) {
  await must(ctx, actor, 'admin.templates');
  return await ctx.reference.emailTemplates(actor.orgId);
}

/**
 * A stored PO document, for download. Authorization is not skipped because it
 * is "just a file": the caller must be able to read the request the document
 * belongs to, and the document must be in their organization. Files are records.
 */
export async function getDocumentForDownload(ctx: PurchasingContext, actor: Actor, documentId: string) {
  const document = await ctx.documents.get(documentId);
  if (!document) return null;
  const order = await ctx.orders.findById(document.purchase_order_id);
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
