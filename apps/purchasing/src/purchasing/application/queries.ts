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
import { availableActions, isApprover, isFieldOnly } from '../domain/roles.mjs';
import { QUEUE_STATUSES } from '../domain/status.mjs';
import { rankObservedVendors } from '../domain/history.mjs';

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
  // Three ways to be allowed to read one request, in order of breadth:
  //   1. you may read everything in the organization
  //   2. it is yours
  //   3. you may be asked to SIGN for it — a foreman on the destination job
  //
  // The third is not a courtesy. A foreman holds neither `request.read.all`
  // nor ownership of a request the shop raised, so without it the person the
  // receiving workflow exists for cannot open the order they are receiving.
  // `authorize()` scopes it to their assigned jobs, and migration 0027 states
  // the same rule as an RLS policy so the database agrees.
  if (
    !(await allowed(ctx, actor, 'request.read.all', request)) &&
    !(await allowed(ctx, actor, 'receiving.record', request))
  ) {
    await must(ctx, actor, 'request.read.own', request);
  }

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
    // The vendor's contact, resolved here rather than on the screen. BR-010
    // requires vendor email to be reachable from the purchase order workflow
    // without navigating back to the request that started it, and a mailto
    // with no address is not reachable.
    vendorContact: order?.vendorId ? await ctx.reference.primaryContact(order.vendorId) : null,
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

/** Line-level completed-purchase context for the approval screen (BR-012/013). */
export async function reviewMaterialHistory(ctx: PurchasingContext, actor: Actor, requestId: string) {
  const request = await loadRequest(ctx, actor, requestId);
  await must(ctx, actor, 'review.decide', request);
  const items = await ctx.requests.itemsFor(requestId);
  return Object.fromEntries(await Promise.all(items.map(async (item: any) => {
    if (!item.normalizedDescription) {
      return [item.id, { evidence: null, observedVendors: [], configuredDefaultVendor: null }];
    }
    const [rows, lines, catalog] = await Promise.all([
      ctx.history.materialIntelligence(actor.orgId, item.normalizedDescription),
      ctx.history.listLines(actor.orgId, { normalizedDescription: item.normalizedDescription }),
      ctx.catalog.findByNormalized(actor.orgId, item.normalizedDescription),
    ]);
    return [item.id, {
      evidence: rows[0] ?? null,
      observedVendors: rankObservedVendors(lines, item.normalizedDescription),
      configuredDefaultVendor: catalog?.configuredDefaultVendorId
        ? {
            id: catalog.configuredDefaultVendorId,
            name: catalog.configuredDefaultVendorName,
          }
        : null,
    }];
  })));
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

// ---------------------------------------------------------------------------
// The materials catalogue.
//
// Two different reads with two different audiences, so two different
// permissions. Suggestions are part of RAISING a request, and every requester
// holds `request.create`; browsing the whole catalogue is a management view of
// what the organization buys, and that is `request.read.all`.
// ---------------------------------------------------------------------------

export async function suggestMaterials(ctx: PurchasingContext, actor: Actor, query: string, limit = 8) {
  await must(ctx, actor, 'request.create');
  return await ctx.catalog.suggest(actor.orgId, query, limit);
}

export async function materialCatalog(
  ctx: PurchasingContext,
  actor: Actor,
  options: { search?: string; limit?: number; activeOnly?: boolean } = {},
) {
  await must(ctx, actor, 'request.read.all');
  return await ctx.catalog.list(actor.orgId, options);
}

/** What a vendor is actually bought for. The vendor profile's materials list. */
export async function vendorMaterials(ctx: PurchasingContext, actor: Actor, vendorId: string, limit = 25) {
  await must(ctx, actor, 'request.read.all');
  return await ctx.catalog.forVendor(vendorId, limit);
}

/**
 * Screen 08 — one vendor, and what this organization's own history says about
 * them.
 *
 * Every number below is COUNTED from purchase records. Nothing is scored,
 * rated or predicted: the handoff is explicit that reliability metrics must
 * not be fabricated, and a lead time computed from two deliveries would be a
 * fabrication with a decimal point on it. Where there is not enough history to
 * say something true, this returns null and the screen says so.
 */
export async function vendorProfile(ctx: PurchasingContext, actor: Actor, vendorId: string) {
  await must(ctx, actor, 'request.read.all');

  const vendors = await ctx.reference.vendors(actor.orgId);
  const vendor = vendors.find((v: any) => String(v.id) === String(vendorId)) ?? null;
  if (!vendor) return null;

  const contact = await ctx.reference.primaryContact(vendorId);
  const requests = (await ctx.requests.listForOrg(actor.orgId)).filter(
    (r: any) => String(r.vendorId ?? '') === String(vendorId),
  );

  const ordered = requests.filter((r: any) => r.orderedAt);
  const received = requests.filter((r: any) => r.receivedAt && r.orderedAt);

  // Lead time: ordered-to-received, in whole days, over completed deliveries.
  // MEDIAN rather than mean — one vendor holiday should not move the number a
  // purchaser plans around.
  const leadTimes = received
    .map((r: any) => (Date.parse(r.receivedAt) - Date.parse(r.orderedAt)) / 86_400_000)
    .filter((d: number) => Number.isFinite(d) && d >= 0)
    .sort((a: number, b: number) => a - b);
  const typicalLeadTimeDays = leadTimes.length >= 3 ? Math.round(leadTimes[Math.floor(leadTimes.length / 2)]) : null;

  // "On time" is against the need-by the job actually had, not against a
  // promise the vendor never made.
  const onTime = received.filter((r: any) => String(r.receivedAt).slice(0, 10) <= String(r.needByDate ?? '')).length;

  return {
    vendor,
    contact,
    materials: await ctx.catalog.forVendor(vendorId, 20),
    history: requests
      .slice()
      .sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 25),
    stats: {
      totalOrders: ordered.length,
      openOrders: requests.filter((r: any) => ['ORDERED', 'PARTIALLY_RECEIVED'].includes(r.status)).length,
      committedCents: requests
        .filter((r: any) => ['ORDERED', 'PARTIALLY_RECEIVED'].includes(r.status))
        .reduce((t: number, r: any) => t + Number(r.estimatedTotalCents ?? 0), 0),
      lastOrderedAt: ordered.map((r: any) => r.orderedAt).sort().pop() ?? null,
      typicalLeadTimeDays,
      // Both halves are returned so the screen can say "3 of 4" rather than
      // "75%", which reads like a measurement when it is four data points.
      deliveriesMeasured: received.length,
      deliveriesOnTime: onTime,
    },
  };
}

export async function listUsers(ctx: PurchasingContext, actor: Actor) {
  return await ctx.identity.listUsers(actor.orgId);
}

export async function listNotifications(ctx: PurchasingContext, actor: Actor) {
  return await ctx.notifications.inboxFor(actor.id);
}

export async function auditLog(ctx: PurchasingContext, actor: Actor, limit = 200) {
  await must(ctx, actor, 'admin.audit');
  return (await ctx.audit.orgLog(actor.orgId, limit)).map(normalizeActivityRow);
}

/**
 * Actions that belong to the purchasing story of a record, as opposed to the
 * administration of the system. The dashboard's activity feed shows only
 * these: a purchasing manager should see that an order was placed, and should
 * NOT see who changed somebody's roles or who was refused a permission. Those
 * are the administrator's audit log (`auditLog`, gated on `admin.audit`).
 */
const OPERATIONAL_ACTIONS = new Set([
  'request.created', 'request.updated', 'request.submitted', 'request.item_added',
  'request.item_updated', 'request.item_removed', 'request.attachment_added',
  'request.note_added', 'request.cancelled', 'clarification.requested',
  'clarification.answered', 'review.stock_recorded', 'review.quantity_changed',
  'review.vendor_selected', 'review.cost_changed', 'review.substitute_set',
  'review.saved', 'decision.approved', 'decision.rejected', 'po.generated',
  'po.document_generated', 'email.draft_generated', 'email.draft_reviewed',
  'email.draft_approved_to_send', 'email.marked_sent', 'order.placed',
  'order.tracking_updated', 'receipt.recorded', 'receipt.partial',
  'receipt.completed', 'inventory.observed', 'inventory.adjusted',
  'request.completed', 'accounting.actual_cost_recorded',
]);

/**
 * The dashboard's "recent activity".
 *
 * Gated on `request.read.all`, not on `admin.audit`: these rows describe the
 * same organization-wide purchase requests that permission already grants
 * sight of, so requiring the administrator's permission would be theatre. The
 * administrative half of the log is filtered out above rather than being
 * relied on to be uninteresting.
 */
export async function recentPurchasingActivity(ctx: PurchasingContext, actor: Actor, limit = 12) {
  await must(ctx, actor, 'request.read.all');
  // Over-read then filter: the log interleaves administrative rows, so asking
  // for exactly `limit` would return fewer than `limit` operational ones.
  const rows = await ctx.audit.orgLog(actor.orgId, limit * 4);
  return rows
    .map(normalizeActivityRow)
    .filter((row) => OPERATIONAL_ACTIONS.has(row.action))
    .slice(0, limit);
}

/**
 * The two audit adapters return their rows exactly as the table holds them,
 * while `timelineFor()` returns a camel-cased view. Normalizing here means the
 * activity feed and the request timeline read the same shape, and neither
 * provider's column naming leaks into a component.
 */
function normalizeActivityRow(row: any) {
  return {
    id: row.id,
    at: row.at,
    seq: row.seq,
    requestId: row.request_id ?? row.requestId ?? null,
    actorId: row.actor_id ?? row.actorId ?? null,
    actorName: row.actor_name ?? row.actorName ?? null,
    action: row.action,
    entityType: row.entity_type ?? row.entityType ?? null,
    entityId: row.entity_id ?? row.entityId ?? null,
    previousValues: parseJson(row.previous_values ?? row.previousValues),
    newValues: parseJson(row.new_values ?? row.newValues),
    notes: row.notes ?? null,
  };
}

function parseJson(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Deliveries this person may confirm: open orders on the job sites they are
 * assigned to. Office and workshop staff are not assignment-scoped — receiving
 * at the shop counter is their job — so they see every open order.
 */
export async function deliveriesForActor(ctx: PurchasingContext, actor: Actor) {
  await must(ctx, actor, 'deliveries.confirm');
  // The domain's rule, not a second copy of it — see SHOP_COUNTER_ROLES.
  const fieldOnly = isFieldOnly(actor);
  const all = await ctx.requests.listForOrg(actor.orgId);
  return all
    .filter((r) => ['ORDERED', 'PARTIALLY_RECEIVED'].includes(r.status))
    .filter((r) => !fieldOnly || actor.assignedJobNumbers.includes(r.jobNumber));
}

/**
 * Open orders this person may RECORD a receipt against — screen 06's index.
 *
 * Distinct from deliveriesForActor() by one permission. `deliveries.confirm`
 * is the field grant: a foreman signing for what lands on his site.
 * `receiving.record` is the clerical act of writing down what arrived, which
 * purchasing and office staff do at the shop counter without ever holding the
 * field grant. Both are scoped the same way — a field-only user sees only the
 * jobs they are assigned to, and authorize() refuses the rest per record.
 */
export async function receivableForActor(ctx: PurchasingContext, actor: Actor) {
  await must(ctx, actor, 'receiving.record');
  // The domain's rule, not a second copy of it — see SHOP_COUNTER_ROLES.
  const fieldOnly = isFieldOnly(actor);
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
  // Throws for a request this viewer may not see. AWAITED — without the await
  // this line was decoration: the rejection floated free, the function
  // returned the bytes anyway, and the record-level check the comment promises
  // never happened. The organization check above is not a substitute; a
  // requester may read their OWN requests, not a colleague's.
  await getRequestDetail(ctx, actor, order.requestId);
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
    // REQUIRED. authorize() scopes `receiving.record` and `deliveries.confirm`
    // to the caller's assigned jobs, and it reads the job from HERE. Dropping
    // it made the assignment check compare against undefined, which is never
    // in anybody's assignment list — so a foreman was refused receiving on his
    // own job site, every time. It failed closed, which is the safe direction
    // and the reason it was survivable, but the feature could not work.
    jobNumber: request.jobNumber,
  };
}
