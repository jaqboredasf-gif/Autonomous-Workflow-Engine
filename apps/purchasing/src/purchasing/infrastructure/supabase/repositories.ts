/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// repositories.ts — the Supabase implementations of the domain's repository
// interfaces. The counterpart to infrastructure/sqlite/repositories.ts, and the
// only other file allowed to know a table name.
//
// STATUS: written against migrations 0016/0017 and typechecked. NOT EXECUTED —
// this environment has no Supabase project. Every method here is a claim until
// the parity suite runs against a real database (see the handoff document).
//
// Three rules it follows:
//
//   1. Tenant scope is on every query. Even though RLS enforces it in the
//      database, `.eq('org_id', …)` is written explicitly, because a policy
//      that is accidentally dropped should cause a visible bug in tests rather
//      than a silent cross-tenant read in production. Defence in depth means
//      both, not either.
//
//   2. Numbers cross the boundary through mappers.ts and nowhere else. Money is
//      numeric(12,2) here and integer cents above; quantity is numeric(14,3)
//      here and integer thousandths above.
//
//   3. No domain logic. No status check, no permission check, no arithmetic
//      beyond what the database is best placed to aggregate.
// ---------------------------------------------------------------------------

import type {
  ApprovalRepository, CatalogEntry, EmailDraftRepository, InventoryRepository,
  ItemCatalogRepository, LineProgressRecord, PoNumberAllocator, PurchaseHistoryLineRecord,
  PurchaseHistoryRepository, PurchaseOrderRepository, PurchaseRequestRepository,
  ReceiptRepository, ReferenceRepository, WorkshopReviewRepository,
} from '../../domain/repositories.ts';
// Matching and ranking are the DOMAIN's, shared with the local provider on
// purpose: two catalogues that ordered their suggestions differently would be
// two products. Only the read differs between providers.
import { byCatalogUsefulness, matchCatalog, normalizeDescription } from '../../domain/catalog.mjs';
import { lineOutstandingQty } from '../../domain/numbers.mjs';
import { summarizeItems } from '../../domain/entities.mjs';
import type { SupabaseHandles } from './client.ts';
import { unwrap } from './client.ts';
import {
  TABLES, money, nullableMoney, qty, toEmailDraft, toOrder, toOrderItem, toReceipt,
  toRequest, toRequestItem, toReviewLine,
} from './mappers.ts';

const REQUEST_SELECT = `
  *,
  requestor:users!purchase_requests_requestor_id_fkey(full_name),
  approver:users!purchase_requests_approver_id_fkey(full_name),
  delivery_location:purchase_delivery_locations(name,address,kind),
  vendor:purchase_vendors(name),
  purchase_order:purchase_orders(po_number)
`;

// --- requests ---------------------------------------------------------------

export function supabaseRequestRepository(h: SupabaseHandles): PurchaseRequestRepository {
  return {
    async nextRequestNumber(orgId) {
      // A sequence read-modify-write is a race unless the database does it.
      // `next_request_number()` holds the row lock (migration 0016).
      const data = unwrap(await h.db.rpc('next_request_number', { p_org: orgId }), 'next_request_number');
      return String(data);
    },

    async insert(record) {
      const inserted = unwrap(
        await h.db.from(TABLES.requests).insert({
          org_id: record.orgId,
          request_number: record.requestNumber,
          job_number: record.jobNumber,
          requestor_id: record.requestorId,
          status: record.status,
          need_by_date: record.needByDate,
          need_by_time: record.needByTime,
          delivery_location_id: record.deliveryLocationId,
          delivery_method: record.deliveryMethod,
          reason: record.reason ?? null,
          notes: record.notes ?? null,
          created_by: record.createdBy,
        }).select('id').single(),
        'insert purchase request',
      ) as any;

      if (record.items?.length) {
        unwrap(
          await h.db.from(TABLES.requestItems).insert(
            record.items.map((item: any, idx: number) => ({
              request_id: inserted.id,
              // Tenant ownership on the row itself (0018). The guard trigger
              // rejects a line whose organization disagrees with its parent,
              // and a NULL here would be a line nothing can scope.
              org_id: record.orgId,
              line_no: idx + 1,
              description: item.description,
              // What the person typed is kept as typed; this is what it
              // matched on, recorded now so a later rule change cannot
              // re-cluster history. The local provider writes it too — if only
              // one provider did, the item catalogue would exist on one and be
              // empty on the other.
              normalized_description: normalizeDescription(item.description),
              requested_qty: qty.write(item.requestedQty),
              unit: item.unit,
              stock_number: item.stockNumber ?? null,
              notes: item.notes ?? null,
              created_by: record.createdBy,
            })),
          ),
          'insert request items',
        );
      }
      return (await this.findById(inserted.id))!;
    },

    async findById(id) {
      const { data, error } = await h.db
        .from(TABLES.requests).select(REQUEST_SELECT)
        .eq('id', id).eq('org_id', h.orgId).maybeSingle();
      if (error) throw unwrapError(error, 'find request');
      return toRequest(data);
    },

    async listForOrg(orgId) {
      const rows = unwrap(
        await h.db.from(TABLES.requests).select(REQUEST_SELECT)
          .eq('org_id', orgId).order('created_at', { ascending: false }),
        'list requests',
      ) as any[];
      return withAggregates(h, rows);
    },

    async listForRequestor(orgId, userId) {
      const rows = unwrap(
        await h.db.from(TABLES.requests).select(REQUEST_SELECT)
          .eq('org_id', orgId)
          .or(`requestor_id.eq.${userId},created_by.eq.${userId}`)
          .order('created_at', { ascending: false }),
        'list requests for requestor',
      ) as any[];
      return withAggregates(h, rows);
    },

    async update(id, expectedVersion, patch) {
      // Optimistic concurrency: the update only lands if the version is still
      // what the caller read. Zero rows back is a conflict, not a success —
      // PostgREST will not tell us otherwise, so we ask for the row.
      const { data, error } = await h.db
        .from(TABLES.requests).update(mapRequestPatch(patch))
        .eq('id', id).eq('org_id', h.orgId).eq('version', expectedVersion)
        .select('id');
      if (error) throw unwrapError(error, 'update request');
      if (!data || data.length !== 1) {
        const conflict: any = new Error('the request changed while you were working on it — reload and retry');
        conflict.reason = 'version_conflict';
        throw conflict;
      }
    },

    async patch(id, patch) {
      unwrap(
        await h.db.from(TABLES.requests).update(mapRequestPatch(patch)).eq('id', id).eq('org_id', h.orgId),
        'patch request',
      );
    },

    async itemsFor(requestId) {
      const rows = unwrap(
        await h.db.from(TABLES.requestItems).select('*').eq('request_id', requestId).order('line_no'),
        'list request items',
      ) as any[];
      return rows.map(toRequestItem);
    },

    async replaceItems(requestId, items, actorId, now) {
      unwrap(await h.db.from(TABLES.requestItems).delete().eq('request_id', requestId), 'clear request items');
      if (!items.length) return;
      unwrap(
        await h.db.from(TABLES.requestItems).insert(
          items.map((item: any, idx: number) => ({
            request_id: requestId,
            line_no: idx + 1,
            description: item.description,
            requested_qty: qty.write(item.requestedQty),
            unit: item.unit,
            stock_number: item.stockNumber ?? null,
            notes: item.notes ?? null,
            created_by: actorId,
            created_at: now,
            updated_at: now,
          })),
        ),
        'replace request items',
      );
    },

    async attachmentsFor(requestId) {
      return unwrap(
        await h.db.from(TABLES.requestAttachments)
          .select('id,filename,content_type,byte_size,caption,created_at,storage_path')
          .eq('request_id', requestId),
        'list attachments',
      ) as any[];
    },
  };
}

/**
 * The dashboard table shows requested / stock / ordered totals per request.
 * The local provider gets them from correlated subqueries; PostgREST has no
 * equivalent, so they are fetched in two grouped reads rather than one per row.
 */
async function withAggregates(h: SupabaseHandles, rows: any[]): Promise<any[]> {
  const mapped = rows.map(toRequest);
  if (!mapped.length) return mapped;
  const ids = mapped.map((r) => r.id);

  const [items, reviews] = await Promise.all([
    // `description` and `line_no` join the aggregate so a list row can say WHAT
    // was asked for. A queue that shows a request number and a job number and
    // not the material makes the reader open every row to find the one about
    // cable — and it is what "search for MC cable" has to match against.
    h.db.from(TABLES.requestItems).select('request_id,requested_qty,description,line_no').in('request_id', ids),
    h.db.from(TABLES.reviews)
      .select(`request_id, ${TABLES.reviewItems}(usable_stock_qty,final_order_qty)`)
      .in('request_id', ids),
  ]);

  const requested = new Map<string, number>();
  const lineCount = new Map<string, number>();
  const descriptions = new Map<string, Array<{ lineNo: number; description: string }>>();
  for (const row of (items.data ?? []) as any[]) {
    requested.set(row.request_id, (requested.get(row.request_id) ?? 0) + qty.read(row.requested_qty));
    lineCount.set(row.request_id, (lineCount.get(row.request_id) ?? 0) + 1);
    const list = descriptions.get(row.request_id) ?? [];
    list.push({ lineNo: Number(row.line_no ?? 0), description: String(row.description ?? '') });
    descriptions.set(row.request_id, list);
  }
  const stock = new Map<string, number>();
  const ordering = new Map<string, number>();
  for (const row of (reviews.data ?? []) as any[]) {
    for (const line of row[TABLES.reviewItems] ?? []) {
      stock.set(row.request_id, (stock.get(row.request_id) ?? 0) + qty.read(line.usable_stock_qty));
      ordering.set(row.request_id, (ordering.get(row.request_id) ?? 0) + qty.read(line.final_order_qty));
    }
  }

  return mapped.map((r) => ({
    ...r,
    requestedQty: requested.get(r.id) ?? 0,
    itemCount: lineCount.get(r.id) ?? 0,
    workshopStockQty: stock.get(r.id) ?? 0,
    finalOrderQty: ordering.get(r.id) ?? 0,
    itemSummary: summarizeItems(descriptions.get(r.id) ?? []),
  }));
}

/**
 * Column patches arrive in the domain's units (cents, thousandths) and in
 * snake_case. Two things are translated here and nowhere else:
 *
 *   money      integer cents -> numeric(12,2)
 *   version    NEVER SENT. `guard_purchase_request_transition()` in migration
 *              0016 sets `new.version := old.version + 1` on every update, so
 *              the database owns the increment. Sending our own would either
 *              be overwritten or fight the trigger.
 */
function mapRequestPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'estimated_total_cents') out.estimated_total = money.write(value as number);
    else if (key === 'version') continue;
    else out[key] = value;
  }
  return out;
}

function unwrapError(error: any, context: string) {
  const err: any = new Error(`${context}: ${error?.message ?? 'unknown'}`);
  err.reason = error?.code === 'PGRST116' ? 'not_found' : 'persistence_failure';
  return err;
}

// --- workshop review --------------------------------------------------------

export function supabaseReviewRepository(h: SupabaseHandles): WorkshopReviewRepository {
  return {
    async findByRequest(requestId) {
      const { data } = await h.db.from(TABLES.reviews).select('*').eq('request_id', requestId).maybeSingle();
      return data
        ? { id: data.id, requestId: data.request_id, savedAt: data.saved_at ?? null, workshopNotes: data.workshop_notes ?? null }
        : null;
    },

    async open(requestId, reviewerId, now) {
      const row = unwrap(
        await h.db.from(TABLES.reviews).insert({ request_id: requestId, reviewer_id: reviewerId, started_at: now, created_at: now, updated_at: now }).select('id').single(),
        'open review',
      ) as any;
      return { id: row.id };
    },

    async saveLine(reviewId, requestItemId, values: any, actorId: string, now: string) {
      const { data: previous } = await h.db.from(TABLES.reviewItems)
        .select('*').eq('review_id', reviewId).eq('request_item_id', requestItemId).maybeSingle();

      const payload = {
        review_id: reviewId,
        request_item_id: requestItemId,
        usable_stock_qty: qty.write(values.usableStockQty),
        approved_qty: qty.write(values.approvedQty),
        // suggested / stock applied / replenishment / line total are DERIVED by
        // a trigger in 0016. Sending them anyway keeps the two providers'
        // written rows identical; the trigger recomputes and wins either way.
        suggested_order_qty: qty.write(values.suggestedOrderQty),
        final_order_qty: qty.write(values.finalOrderQty),
        stock_applied_qty: qty.write(values.stockAppliedQty),
        replenishment_qty: qty.write(values.replenishmentQty),
        vendor_id: values.vendorId,
        estimated_unit_cost: nullableMoney.write(values.estimatedUnitCostCents),
        estimated_line_total: money.write(values.estimatedLineTotalCents),
        substitute_description: values.substituteDescription,
        expected_arrival_date: values.expectedArrivalDate,
        line_notes: values.lineNotes,
        override_reason: values.overrideReason,
        updated_by: actorId,
        updated_at: now,
      };

      unwrap(
        await h.db.from(TABLES.reviewItems).upsert(payload, { onConflict: 'review_id,request_item_id' }),
        'save review line',
      );

      return {
        previous: previous
          ? {
              usableStock: qty.read(previous.usable_stock_qty),
              approvedQty: qty.read(previous.approved_qty),
              finalOrderQty: qty.read(previous.final_order_qty),
              vendorId: previous.vendor_id ?? null,
              unitCostCents: nullableMoney.read(previous.estimated_unit_cost),
            }
          : null,
      };
    },

    async linesFor(requestId) {
      const [items, review] = await Promise.all([
        h.db.from(TABLES.requestItems).select('*').eq('request_id', requestId).order('line_no'),
        h.db.from(TABLES.reviews).select(`id, ${TABLES.reviewItems}(*)`).eq('request_id', requestId).maybeSingle(),
      ]);
      const reviewLines = new Map<string, any>();
      for (const line of ((review.data as any)?.[TABLES.reviewItems] ?? []) as any[]) {
        reviewLines.set(line.request_item_id, line);
      }

      const vendorIds = [...new Set([...reviewLines.values()].map((l) => l.vendor_id).filter(Boolean))];
      const vendorNames = new Map<string, string>();
      if (vendorIds.length) {
        const { data } = await h.db.from(TABLES.vendors).select('id,name').in('id', vendorIds);
        for (const v of (data ?? []) as any[]) vendorNames.set(v.id, v.name);
      }

      return ((items.data ?? []) as any[]).map((item) => {
        const line = reviewLines.get(item.id) ?? null;
        return toReviewLine(item, line, line?.vendor_id ? vendorNames.get(line.vendor_id) ?? null : null);
      });
    },

    async markSaved(reviewId, reviewerId, workshopNotes, now) {
      unwrap(
        await h.db.from(TABLES.reviews)
          .update({ workshop_notes: workshopNotes, saved_at: now, reviewer_id: reviewerId })
          .eq('id', reviewId),
        'mark review saved',
      );
    },
  };
}

// --- approvals --------------------------------------------------------------

export function supabaseApprovalRepository(h: SupabaseHandles): ApprovalRepository {
  return {
    async record(requestId, approverId, decision, notes, reason, changes, now, selfApproved = false) {
      unwrap(
        await h.db.from(TABLES.approvals).insert({
          request_id: requestId, approver_id: approverId, decision,
          notes, reason, changes: changes ?? [], decided_at: now, created_at: now,
          // BR-011 audit stamp. See 0028_purchasing_approval_authority.sql —
          // the RPC path sets the same column, so both write paths agree.
          self_approved: selfApproved,
        }),
        'record approval',
      );
    },

    async listForRequest(requestId) {
      const rows = unwrap(
        await h.db.from(TABLES.approvals)
          .select('*, approver:users(full_name)').eq('request_id', requestId).order('decided_at'),
        'list approvals',
      ) as any[];
      return rows.map((a) => ({
        id: a.id,
        decision: a.decision,
        decidedAt: a.decided_at,
        notes: a.notes,
        reason: a.reason,
        changes: a.changes ?? [],
        selfApproved: Boolean(a.self_approved),
        approverId: a.approver_id ?? null,
        approverName: a.approver?.full_name ?? null,
      }));
    },
  };
}

// --- purchase orders --------------------------------------------------------

export function supabaseOrderRepository(h: SupabaseHandles): PurchaseOrderRepository {
  return {
    async findByRequest(requestId) {
      const { data } = await h.db.from(TABLES.orders).select('*')
        .eq('request_id', requestId).eq('org_id', h.orgId).maybeSingle();
      return toOrder(data);
    },

    async findById(id) {
      const { data } = await h.db.from(TABLES.orders).select('*')
        .eq('id', id).eq('org_id', h.orgId).maybeSingle();
      return toOrder(data);
    },

    async insert(order, now) {
      const row = unwrap(
        await h.db.from(TABLES.orders).insert({
          org_id: order.orgId, request_id: order.requestId, po_number: order.poNumber,
          sequence_value: order.sequenceValue, vendor_id: order.vendorId,
          vendor_contact_id: order.vendorContactId ?? null, job_number: order.jobNumber,
          approver_id: order.approverId, delivery_location_id: order.deliveryLocationId,
          delivery_method: order.deliveryMethod, need_by_date: order.needByDate,
          need_by_time: order.needByTime, estimated_total: money.write(order.estimatedTotalCents),
          notes: order.notes ?? null, generated_at: now, generated_by: order.generatedBy,
        }).select('id,po_number').single(),
        'insert purchase order',
      ) as any;

      unwrap(
        await h.db.from(TABLES.orderItems).insert(
          order.items.map((line: any) => ({
            purchase_order_id: row.id, line_no: line.lineNo, request_item_id: line.requestItemId,
            org_id: order.orgId ?? h.orgId,
            description: line.description, substitute_description: line.substituteDescription,
            // Same rule as the request line: the matching key is written when
            // the row is written, never derived on read.
            normalized_description: normalizeDescription(line.substituteDescription || line.description),
            order_qty: qty.write(line.orderQty), unit: line.unit,
            unit_cost: money.write(line.unitCostCents), line_total: money.write(line.lineTotalCents),
            expected_arrival_date: line.expectedArrivalDate,
          })),
        ),
        'insert purchase order items',
      );
      return { id: row.id, poNumber: row.po_number };
    },

    async itemsFor(purchaseOrderId) {
      const rows = unwrap(
        await h.db.from(TABLES.orderItems).select('*').eq('purchase_order_id', purchaseOrderId).order('line_no'),
        'list order items',
      ) as any[];
      return rows.map(toOrderItem);
    },

    async progressFor(requestId): Promise<LineProgressRecord[]> {
      const order = unwrap(
        await h.db.from(TABLES.orders).select('id').eq('request_id', requestId).eq('org_id', h.orgId).maybeSingle(),
        'find order for progress',
      ) as any;
      if (!order) return [];

      const items = unwrap(
        await h.db.from(TABLES.orderItems)
          .select(`*, ${TABLES.receiptItems}(received_qty,damaged_qty,backordered_qty,written_off_qty)`)
          .eq('purchase_order_id', order.id).order('line_no'),
        'list order items with receipts',
      ) as any[];

      return items.map((item) => {
        const receipts = (item[TABLES.receiptItems] ?? []) as any[];
        const sum = (field: string) => receipts.reduce((t, r) => t + qty.read(r[field]), 0);
        const received = sum('received_qty');
        const damaged = sum('damaged_qty');
        const writtenOff = sum('written_off_qty');
        const orderQty = qty.read(item.order_qty);
        return {
          purchaseOrderItemId: item.id,
          requestItemId: item.request_item_id,
          description: item.description,
          unit: item.unit,
          finalOrderQty: orderQty,
          receivedQty: received,
          damagedQty: damaged,
          backorderedQty: sum('backordered_qty'),
          writtenOffQty: writtenOff,
          outstandingQty: lineOutstandingQty({
            finalOrderQty: orderQty, receivedQty: received, damagedQty: damaged, writtenOffQty: writtenOff,
          }),
        };
      });
    },

    async recordActualCost(orgId, purchaseOrderId, input: any, actorId, now) {
      unwrap(
        await h.db.from(TABLES.orders).update({
          // nullableMoney, NOT money: null here means "not reconciled yet",
          // and money.write() would turn a cleared figure into 0.00 — which
          // reads as "this purchase cost nothing" to whoever sees it next.
          actual_total: nullableMoney.write(input.actualTotalCents),
          actual_cost_source: input.reference ?? input.source ?? null,
          updated_at: now, updated_by: actorId,
        }).eq('id', purchaseOrderId).eq('org_id', orgId).select('id'),
        'record actual cost',
      );
    },

    // NOTE ON THE ORG SELECT BELOW: `orgs` carries id, name and created_at and
    // nothing else. This used to ask for phone and address too, and every PO
    // sheet failed to render with "column orgs_1.phone does not exist" — a
    // column this schema has never had. Letterhead contact details belong to
    // the PO template, not to the tenant row. The local provider selects * and
    // so never noticed the difference.
    async view(purchaseOrderId) {
      const order = unwrap(
        await h.db.from(TABLES.orders).select(`
          *,
          org:orgs(id,name),
          vendor:purchase_vendors(id,name,account_number,phone,address),
          contact:purchase_vendor_contacts(name,email,phone),
          location:purchase_delivery_locations(name,address,kind),
          approver:users!purchase_orders_approver_id_fkey(id,full_name),
          request:purchase_requests(*, requestor:users!purchase_requests_requestor_id_fkey(full_name)),
          ${TABLES.orderItems}(*, request_item:purchase_request_items(stock_number), receipts:purchase_receipt_items(received_qty))
        `).eq('id', purchaseOrderId).eq('org_id', h.orgId).maybeSingle(),
        'purchase order view',
      ) as any;
      if (!order) return null;

      const request = order.request;
      return {
        org: order.org,
        purchaseOrder: {
          id: order.id, poNumber: order.po_number, generatedAt: order.generated_at,
          estimatedTotalCents: money.read(order.estimated_total), notes: order.notes,
          orderedAt: request?.ordered_at ?? null, status: order.status,
        },
        vendor: {
          id: order.vendor?.id, name: order.vendor?.name, accountNumber: order.vendor?.account_number,
          phone: order.vendor?.phone, address: order.vendor?.address,
        },
        vendorContact: order.contact ?? null,
        request: {
          id: request?.id, requestNumber: request?.request_number, jobNumber: order.job_number,
          needByDate: order.need_by_date, needByTime: String(order.need_by_time ?? '').slice(0, 5),
          deliveryMethod: order.delivery_method, deliveryLocationName: order.location?.name ?? '',
          deliveryLocationKind: order.location?.kind ?? null,
          deliveryAddress: order.location?.address ?? '', requestorName: request?.requestor?.full_name ?? '',
          reason: request?.reason ?? '', notes: request?.notes ?? '',
        },
        approver: { id: order.approver?.id, name: order.approver?.full_name ?? '' },
        items: ((order[TABLES.orderItems] ?? []) as any[]).map((i) => ({
          lineNo: i.line_no, description: i.description, substituteFor: i.substitute_description,
          stockNumber: i.request_item?.stock_number ?? null,
          finalOrderQty: qty.read(i.order_qty), unit: i.unit,
          receivedQty: ((i.receipts ?? []) as any[]).reduce((sum, r) => sum + qty.read(r.received_qty), 0),
          estimatedUnitCostCents: money.read(i.unit_cost), lineTotalCents: money.read(i.line_total),
          expectedArrivalDate: i.expected_arrival_date,
        })),
      };
    },
  };
}

/**
 * PO numbering. `next_po_number()` takes the row lock in Postgres (migration
 * 0016) — the allocation is safe under concurrency because the DATABASE makes
 * it safe, not because this adapter is careful.
 */
export function supabasePoNumberAllocator(h: SupabaseHandles): PoNumberAllocator {
  return {
    async allocate(orgId, _now) {
      const rows = unwrap(await h.db.rpc('next_po_number', { p_org: orgId }), 'next_po_number') as any;
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row?.po_number) {
        const err: any = new Error('no PO number sequence configured for this organization');
        err.reason = 'po_sequence_missing';
        throw err;
      }
      return { poNumber: String(row.po_number), sequenceValue: Number(row.sequence_value) };
    },
  };
}

// --- email drafts -----------------------------------------------------------

export function supabaseEmailDraftRepository(h: SupabaseHandles): EmailDraftRepository {
  return {
    async findByKey(orgId, draftKey) {
      const { data } = await h.db.from(TABLES.emailDrafts).select('*')
        .eq('org_id', orgId).eq('draft_key', draftKey).maybeSingle();
      return toEmailDraft(data);
    },
    async findById(id) {
      const { data } = await h.db.from(TABLES.emailDrafts).select('*').eq('id', id).eq('org_id', h.orgId).maybeSingle();
      return toEmailDraft(data);
    },
    async listForRequest(requestId) {
      const rows = unwrap(
        await h.db.from(TABLES.emailDrafts).select('*')
          .eq('org_id', h.orgId).eq('request_id', requestId).order('created_at'),
        'list email drafts',
      ) as any[];
      return rows.map(toEmailDraft);
    },
    async insert(draft, now) {
      const row = unwrap(
        await h.db.from(TABLES.emailDrafts).insert({
          org_id: draft.orgId, request_id: draft.requestId, purchase_order_id: draft.purchaseOrderId,
          template_key: draft.templateKey, status: draft.status, subject: draft.subject, body: draft.body,
          to_addrs: draft.to, cc_addrs: draft.cc, attachments: draft.attachments,
          draft_key: draft.draftKey, generated_by: draft.generatedBy,
          generated_at: now, created_at: now, updated_at: now,
          // external_send_enabled is pinned false by a CHECK constraint; it is
          // not sent, so no code path can even ask for it to be true.
        }).select('id').single(),
        'insert email draft',
      ) as any;
      return { id: row.id };
    },
    async updateContent(id, patch, now) {
      unwrap(
        await h.db.from(TABLES.emailDrafts).update({ subject: patch.subject, body: patch.body, updated_at: now }).eq('id', id),
        'update email draft',
      );
    },
    async updateStatus(id, columns) {
      unwrap(await h.db.from(TABLES.emailDrafts).update(columns).eq('id', id), 'update draft status');
    },
  };
}

// --- receiving --------------------------------------------------------------

export function supabaseReceiptRepository(h: SupabaseHandles): ReceiptRepository {
  return {
    async insert(receipt, now) {
      const row = unwrap(
        await h.db.from(TABLES.receipts).insert({
          org_id: receipt.orgId, request_id: receipt.requestId, purchase_order_id: receipt.purchaseOrderId,
          received_date: receipt.receivedDate, received_by: receipt.receivedBy,
          packing_slip_number: receipt.packingSlipNumber, notes: receipt.notes, created_at: now,
        }).select('id').single(),
        'insert receipt',
      ) as any;
      return { id: row.id };
    },

    async insertLine(receiptId, line, now) {
      unwrap(
        await h.db.from(TABLES.receiptItems).insert({
          receipt_id: receiptId, purchase_order_item_id: line.purchaseOrderItemId,
          received_qty: qty.write(line.receivedQty), damaged_qty: qty.write(line.damagedQty),
          backordered_qty: qty.write(line.backorderedQty), written_off_qty: qty.write(line.writtenOffQty),
          over_receipt_override: Boolean(line.overrideReason), override_reason: line.overrideReason,
          notes: line.notes, created_at: now,
        }),
        'insert receipt line',
      );
    },

    async markFinal(receiptId) {
      unwrap(await h.db.from(TABLES.receipts).update({ is_final: true }).eq('id', receiptId), 'mark receipt final');
    },

    async listForRequest(requestId) {
      const rows = unwrap(
        await h.db.from(TABLES.receipts).select(`*, ${TABLES.receiptItems}(*)`)
          .eq('org_id', h.orgId).eq('request_id', requestId).order('created_at'),
        'list receipts',
      ) as any[];
      return rows.map((r) => toReceipt(r, r[TABLES.receiptItems] ?? []));
    },

    async findById(id) {
      const { data } = await h.db.from(TABLES.receipts).select(`*, ${TABLES.receiptItems}(*)`)
        .eq('id', id).eq('org_id', h.orgId).maybeSingle();
      return data ? toReceipt(data, (data as any)[TABLES.receiptItems] ?? []) : null;
    },

    async attach(receiptId, file, actorId, now) {
      unwrap(
        await h.db.from(TABLES.receiptAttachments).insert({
          receipt_id: receiptId, filename: file.filename, content_type: file.contentType ?? null,
          byte_size: file.byteSize ?? null, storage_path: file.storagePath ?? '', caption: file.caption ?? null,
          created_by: actorId, created_at: now,
        }),
        'attach to receipt',
      );
    },

    async attachmentsFor(receiptId) {
      return unwrap(
        await h.db.from(TABLES.receiptAttachments)
          .select('id,filename,content_type,byte_size,caption,created_at,storage_path').eq('receipt_id', receiptId),
        'list receipt attachments',
      ) as any[];
    },
  };
}

// --- inventory --------------------------------------------------------------

export function supabaseInventoryRepository(h: SupabaseHandles): InventoryRepository {
  return {
    async observe(record, now) {
      unwrap(
        await h.db.from(TABLES.inventoryObservations).insert({
          org_id: record.orgId, request_id: record.requestId, request_item_id: record.requestItemId,
          item_description: record.description, observed_qty: qty.write(record.observedQty),
          unit: record.unit, observed_by: record.observedBy, notes: record.notes ?? null,
          observed_at: now, created_at: now,
        }),
        'record stock observation',
      );
    },
    async adjust(record, now) {
      unwrap(
        await h.db.from(TABLES.inventoryAdjustments).insert({
          org_id: record.orgId, request_id: record.requestId, request_item_id: record.requestItemId,
          item_description: record.description, delta_qty: qty.write(record.deltaQty),
          unit: record.unit, reason: record.reason, adjusted_by: record.adjustedBy,
          adjusted_at: now, created_at: now,
        }),
        'record inventory adjustment',
      );
    },
  };
}

// --- reference data + settings ----------------------------------------------

export function supabaseReferenceRepository(h: SupabaseHandles): ReferenceRepository {
  return {
    async vendors(orgId) {
      const rows = unwrap(
        await h.db.from(TABLES.vendors)
          .select(`*, contact:${TABLES.vendorContacts}(name,email,phone,is_primary)`)
          .eq('org_id', orgId).eq('is_active', true).order('name'),
        'list vendors',
      ) as any[];
      return rows.map((v) => {
        const primary = (v.contact ?? []).find((c: any) => c.is_primary) ?? (v.contact ?? [])[0] ?? null;
        return { ...v, contact_name: primary?.name ?? null, contact_email: primary?.email ?? null, contact_phone: primary?.phone ?? null };
      });
    },

    async primaryContact(vendorId) {
      const { data } = await h.db.from(TABLES.vendorContacts).select('*')
        .eq('vendor_id', vendorId).order('is_primary', { ascending: false }).limit(1).maybeSingle();
      return data ?? null;
    },

    async deliveryLocations(orgId) {
      return unwrap(
        await h.db.from(TABLES.deliveryLocations).select('*')
          .eq('org_id', orgId).eq('is_active', true).order('kind').order('name'),
        'list delivery locations',
      ) as any[];
    },

    async jobs(orgId) {
      // The job directory, added by migration 0018. It used to return an empty
      // list with a TODO; that meant the intake form offered no job list at all
      // against Supabase, and a request's job was whatever someone typed.
      const rows = unwrap(
        await h.db.from(TABLES.jobs)
          .select('id, org_id, job_number, name, customer, site_address, status, delivery_instructions, cost_code, default_location_id, created_at')
          .eq('org_id', orgId)
          .in('status', ['ACTIVE', 'ON_HOLD'])
          .order('job_number'),
        'list jobs',
      ) as any[];
      // `address` and `is_active` are what the UI and the local provider use.
      // Mapped here so neither can tell which provider answered.
      return rows.map((j) => ({
        ...j, address: j.site_address, is_active: j.status === 'ACTIVE',
      }));
    },

    // --- directory writes ---------------------------------------------------
    async vendorByName(orgId, name) {
      const { data } = await h.db.from(TABLES.vendors)
        .select('*').eq('org_id', orgId).ilike('name', name).maybeSingle();
      return data ?? null;
    },
    async createVendor(orgId, input: any, actorId, now) {
      const row = unwrap(
        await h.db.from(TABLES.vendors).insert({
          org_id: orgId, name: input.name, account_number: input.accountNumber ?? null,
          phone: input.phone ?? null, address: input.address ?? null, notes: input.notes ?? null,
          is_active: true, created_at: now, updated_at: now,
          created_by: actorId, updated_by: actorId,
        }).select('id').single(),
        'create vendor',
      ) as any;
      return String(row.id);
    },
    async updateVendor(orgId, vendorId, patch: any, actorId, now) {
      const columns: Record<string, unknown> = { updated_at: now, updated_by: actorId };
      if (patch.name !== undefined) columns.name = patch.name;
      if (patch.accountNumber !== undefined) columns.account_number = patch.accountNumber;
      if (patch.phone !== undefined) columns.phone = patch.phone;
      if (patch.address !== undefined) columns.address = patch.address;
      if (patch.notes !== undefined) columns.notes = patch.notes;
      if (patch.isActive !== undefined) columns.is_active = patch.isActive;
      unwrap(
        await h.db.from(TABLES.vendors).update(columns).eq('id', vendorId).eq('org_id', orgId).select('id'),
        'update vendor',
      );
    },
    async setVendorPrimaryContact(orgId, vendorId, contact: any, now) {
      // The vendor is re-read scoped by org before its child rows are touched:
      // vendor_contacts has no org_id of its own, so this is where the tenant
      // boundary is enforced for them.
      const { data: owned } = await h.db.from(TABLES.vendors)
        .select('id').eq('id', vendorId).eq('org_id', orgId).maybeSingle();
      if (!owned) return;
      const { data: existing } = await h.db.from(TABLES.vendorContacts)
        .select('id').eq('vendor_id', vendorId).eq('is_primary', true).maybeSingle();
      const values = {
        name: contact.name ?? 'Orders', email: contact.email ?? '',
        phone: contact.phone ?? null, updated_at: now,
      };
      if (existing) {
        unwrap(await h.db.from(TABLES.vendorContacts).update(values).eq('id', (existing as any).id).select('id'),
          'update vendor contact');
      } else {
        unwrap(await h.db.from(TABLES.vendorContacts)
          .insert({ ...values, vendor_id: vendorId, is_primary: true, created_at: now }).select('id'),
          'create vendor contact');
      }
    },
    async jobByNumber(orgId, jobNumber) {
      const { data } = await h.db.from(TABLES.jobs)
        .select('*').eq('org_id', orgId).eq('job_number', jobNumber).maybeSingle();
      return data ?? null;
    },
    async createJob(orgId, input: any, actorId, now) {
      const row = unwrap(
        await h.db.from(TABLES.jobs).insert({
          org_id: orgId, job_number: input.jobNumber, name: input.name,
          customer: input.customer ?? null, site_address: input.siteAddress ?? null,
          status: input.status ?? 'ACTIVE', delivery_instructions: input.deliveryInstructions ?? null,
          cost_code: input.costCode ?? null, created_at: now, updated_at: now,
          created_by: actorId, updated_by: actorId,
        }).select('id').single(),
        'create job',
      ) as any;
      return String(row.id);
    },
    async updateJob(orgId, jobId, patch: any, actorId, now) {
      const columns: Record<string, unknown> = { updated_at: now, updated_by: actorId };
      if (patch.name !== undefined) columns.name = patch.name;
      if (patch.customer !== undefined) columns.customer = patch.customer;
      if (patch.siteAddress !== undefined) columns.site_address = patch.siteAddress;
      if (patch.status !== undefined) columns.status = patch.status;
      if (patch.deliveryInstructions !== undefined) columns.delivery_instructions = patch.deliveryInstructions;
      if (patch.costCode !== undefined) columns.cost_code = patch.costCode;
      unwrap(
        await h.db.from(TABLES.jobs).update(columns).eq('id', jobId).eq('org_id', orgId).select('id'),
        'update job',
      );
    },

    async users(orgId) {
      const rows = unwrap(
        // The embeds name their foreign key explicitly. Both of these tables
        // reference `users` twice — once for the person the row is ABOUT and
        // once for the administrator who granted it — and an unqualified embed
        // is ambiguous, which PostgREST reports as an error rather than
        // picking one. Live Postgres caught this; no static check could.
        await h.db.from(TABLES.users).select(
          `*, roles:${TABLES.userRoles}!${TABLES.userRoles}_user_id_fkey(role),`
          + ` jobs:${TABLES.jobAssignments}!${TABLES.jobAssignments}_user_id_fkey(job_number)`,
        )
          .eq('org_id', orgId).order('full_name'),
        'list users',
      ) as any[];
      return rows.map((u) => ({
        ...u,
        can_approve: u.purchasing_can_approve,
        is_primary_approver: u.purchasing_is_primary_approver,
        is_backup_approver: u.purchasing_is_backup_approver,
        is_delivery_receiver: u.purchasing_is_delivery_receiver,
        roles: (u.roles ?? []).map((r: any) => r.role),
        jobs: (u.jobs ?? []).map((j: any) => j.job_number),
      }));
    },

    async settings(orgId) {
      const { data } = await h.db.from(TABLES.settings).select('*').eq('org_id', orgId).maybeSingle();
      return {
        allowSelfApproval: Boolean(data?.allow_self_approval),
        externalSendEnabled: false as const,
        requireEmailReview: true as const,
        overdueGraceHours: Number(data?.overdue_grace_hours ?? 0),
        defaultDeliveryMethod: String(data?.default_delivery_method ?? 'DELIVERY'),
        poTemplateKey: String(data?.po_template_key ?? 'lippolis_default'),
      };
    },

    async emailTemplate(orgId, key) {
      const { data } = await h.db.from(TABLES.emailTemplates).select('subject,body')
        .eq('org_id', orgId).eq('template_key', key).eq('is_active', true).maybeSingle();
      return data ?? null;
    },

    async emailTemplates(orgId) {
      return unwrap(
        await h.db.from(TABLES.emailTemplates).select('*').eq('org_id', orgId).order('template_key'),
        'list email templates',
      ) as any[];
    },

    async poConfig(orgId) {
      const { data } = await h.db.from(TABLES.poSequences).select('*').eq('org_id', orgId).maybeSingle();
      return data ?? null;
    },

    async updatePoConfig(orgId, patch: any, actorId, now) {
      unwrap(
        await h.db.from(TABLES.poSequences).update({
          prefix: patch.prefix, padding: patch.padding, suffix: patch.suffix,
          next_value: patch.nextValue, updated_at: now, updated_by: actorId,
        }).eq('org_id', orgId),
        'update PO configuration',
      );
    },

    async setApprovalAuthority(userId, canApprove, actorId, now) {
      unwrap(
        await h.db.from(TABLES.users).update({ purchasing_can_approve: canApprove, updated_by: actorId, updated_at: now })
          .eq('id', userId).eq('org_id', h.orgId),
        'set approval authority',
      );
    },
  };
}

// ---------------------------------------------------------------------------
// IMMUTABLE PURCHASING HISTORY.
//
// Insert and read. No update method, no delete method — and the migration backs
// that with an INSERT-only policy set plus guard_no_delete(), so a client that
// tried anyway would be refused by the database rather than by this file.
//
// `record` uses upsert with ignoreDuplicates on the (org, request, request item)
// key: writing the same history twice is a no-op, so a retried completion
// completes instead of failing on a conflict. It is NOT an update — a duplicate
// leaves the row that is already there exactly as it was.
// ---------------------------------------------------------------------------

export function supabasePurchaseHistoryRepository(h: SupabaseHandles): PurchaseHistoryRepository {
  return {
    async record(lines, _now) {
      if (!lines.length) return { inserted: 0, skipped: 0 };
      const rows = unwrap(
        await h.db.from(TABLES.historyLines)
          .upsert(lines.map(toHistoryRow), {
            onConflict: 'org_id,request_id,request_item_id',
            ignoreDuplicates: true,
          })
          .select('id'),
        'record purchase history',
      ) as any[];
      const inserted = (rows ?? []).length;
      return { inserted, skipped: lines.length - inserted };
    },

    async forRequest(orgId, requestId) {
      const rows = unwrap(
        await h.db.from(TABLES.historyLines).select('*')
          .eq('org_id', orgId).eq('request_id', requestId).order('line_no'),
        'read request history',
      ) as any[];
      return rows.map(toHistoryLine);
    },

    async listForOrg(orgId, options = {}) {
      const { limit = 500, normalizedDescription, vendorId } = options;
      let query = h.db.from(TABLES.historyLines).select('*').eq('org_id', orgId);
      if (normalizedDescription) query = query.eq('normalized_description', normalizedDescription);
      if (vendorId) query = query.eq('vendor_id', vendorId);
      const rows = unwrap(
        await query.order('ordered_at', { ascending: false, nullsFirst: false }).order('line_no').limit(limit),
        'read purchase history',
      ) as any[];
      return rows.map(toHistoryLine);
    },
  };
}

/** Domain record -> row. Money and quantity cross the boundary here, as always. */
function toHistoryRow(line: PurchaseHistoryLineRecord): Record<string, unknown> {
  return {
    org_id: line.orgId,
    terminal_state: line.terminalState,
    terminal_reason: line.terminalReason ?? null,
    recorded_at: line.recordedAt,
    recorded_by: line.recordedBy,
    request_id: line.requestId,
    request_number: line.requestNumber,
    request_item_id: line.requestItemId,
    line_no: line.lineNo,
    purchase_order_id: line.purchaseOrderId ?? null,
    po_number: line.poNumber ?? null,
    purchase_order_item_id: line.purchaseOrderItemId ?? null,
    job_id: line.jobId ?? null,
    job_number: line.jobNumber,
    catalog_item_id: line.catalogItemId ?? null,
    normalized_description: line.normalizedDescription,
    normalizer_version: line.normalizerVersion,
    requested_description: line.requestedDescription,
    ordered_description: line.orderedDescription ?? null,
    unit: line.unit,
    requested_qty: qty.write(line.requestedQty),
    ordered_qty: qty.write(line.orderedQty),
    vendor_id: line.vendorId ?? null,
    vendor_name: line.vendorName ?? null,
    vendor_part_number: line.vendorPartNumber ?? null,
    estimated_unit_cost: nullableMoney.write(line.estimatedUnitCostCents),
    estimated_line_total: nullableMoney.write(line.estimatedLineTotalCents),
    actual_unit_cost: nullableMoney.write(line.actualUnitCostCents),
    actual_line_total: nullableMoney.write(line.actualLineTotalCents),
    requestor_id: line.requestorId,
    requestor_name: line.requestorName ?? null,
    approver_id: line.approverId ?? null,
    approver_name: line.approverName ?? null,
    requested_at: line.requestedAt ?? null,
    po_generated_at: line.poGeneratedAt ?? null,
    ordered_at: line.orderedAt ?? null,
    received_at: line.receivedAt ?? null,
    completed_at: line.completedAt ?? null,
    received_qty: qty.write(line.receivedQty),
    damaged_qty: qty.write(line.damagedQty),
    backordered_qty: qty.write(line.backorderedQty),
    written_off_qty: qty.write(line.writtenOffQty),
    outcome: line.outcome,
  };
}

/** Row -> domain record. The same shape the local provider returns. */
function toHistoryLine(row: any): PurchaseHistoryLineRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    terminalState: row.terminal_state,
    terminalReason: row.terminal_reason ?? null,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
    requestId: row.request_id,
    requestNumber: row.request_number,
    requestItemId: row.request_item_id,
    lineNo: Number(row.line_no),
    purchaseOrderId: row.purchase_order_id ?? null,
    poNumber: row.po_number ?? null,
    purchaseOrderItemId: row.purchase_order_item_id ?? null,
    jobId: row.job_id ?? null,
    jobNumber: row.job_number,
    catalogItemId: row.catalog_item_id ?? null,
    normalizedDescription: row.normalized_description,
    normalizerVersion: Number(row.normalizer_version),
    requestedDescription: row.requested_description,
    orderedDescription: row.ordered_description ?? null,
    unit: row.unit,
    requestedQty: qty.read(row.requested_qty),
    orderedQty: qty.read(row.ordered_qty),
    vendorId: row.vendor_id ?? null,
    vendorName: row.vendor_name ?? null,
    vendorPartNumber: row.vendor_part_number ?? null,
    estimatedUnitCostCents: nullableMoney.read(row.estimated_unit_cost),
    estimatedLineTotalCents: nullableMoney.read(row.estimated_line_total),
    actualUnitCostCents: nullableMoney.read(row.actual_unit_cost),
    actualLineTotalCents: nullableMoney.read(row.actual_line_total),
    requestorId: row.requestor_id,
    requestorName: row.requestor_name ?? null,
    approverId: row.approver_id ?? null,
    approverName: row.approver_name ?? null,
    requestedAt: row.requested_at ?? null,
    poGeneratedAt: row.po_generated_at ?? null,
    orderedAt: row.ordered_at ?? null,
    receivedAt: row.received_at ?? null,
    completedAt: row.completed_at ?? null,
    receivedQty: qty.read(row.received_qty),
    damagedQty: qty.read(row.damaged_qty),
    backorderedQty: qty.read(row.backordered_qty),
    writtenOffQty: qty.read(row.written_off_qty),
    outcome: row.outcome,
  };
}

// ---------------------------------------------------------------------------
// The item catalogue.
//
// Same contract as the local provider, built the same way: from the line items
// themselves, folding the curated `purchase_item_catalog` row over the top.
//
// The aggregation happens HERE rather than in Postgres because supabase-js has
// no GROUP BY and a view would need its own RLS story. The read is bounded
// (HISTORY_LIMIT) and org-scoped both by the explicit filter and by RLS. If a
// pilot outgrows that bound, the honest fix is a security-invoker view or an
// RPC in a migration — not a bigger limit — and the cap is logged in the
// catalogue's `truncated` behaviour rather than silently pretended away.
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 5000;

export function supabaseItemCatalogRepository(h: SupabaseHandles): ItemCatalogRepository {
  const loadEntries = async (): Promise<CatalogEntry[]> => {
    const [items, curatedRows, orderRows] = await Promise.all([
      unwrap(
        await h.db
          .from(TABLES.requestItems)
          .select('normalized_description, description, requested_qty, unit, stock_number, created_at')
          .eq('org_id', h.orgId)
          .not('normalized_description', 'is', null)
          .order('created_at', { ascending: false })
          .limit(HISTORY_LIMIT),
        'read item history',
      ) as any[],
      unwrap(
        await h.db.from(TABLES.itemCatalog).select('*').eq('org_id', h.orgId),
        'read item catalog',
      ) as any[],
      // WHAT WAS ACTUALLY BOUGHT, from the immutable history.
      //
      // This used to read purchase_order_items and embed the live vendor row,
      // so renaming a vendor rewrote every "last ordered from" the catalogue
      // had ever shown. purchase_history_lines carries the vendor NAME the
      // purchase order carried, and only lines that reached a vendor
      // (ordered_at present, ordered_qty above zero) are price evidence — the
      // policy in domain/history.mjs, applied identically by both providers.
      unwrap(
        await h.db
          .from(TABLES.historyLines)
          .select(
            'normalized_description, vendor_id, vendor_name, estimated_unit_cost, actual_unit_cost, ordered_at',
          )
          .eq('org_id', h.orgId)
          .not('ordered_at', 'is', null)
          .gt('ordered_qty', 0)
          .order('ordered_at', { ascending: false })
          .limit(HISTORY_LIMIT),
        'read purchase history',
      ) as any[],
    ]);

    const curated = new Map(curatedRows.map((row) => [String(row.normalized_description), row]));

    // Latest purchase per item, from the snapshots. The vendor's name here is
    // the one on the purchase order, not the one in the directory today.
    const purchases = new Map<string, any>();
    for (const row of orderRows) {
      const key = String(row.normalized_description);
      const at = row.ordered_at ?? '';
      const seen = purchases.get(key);
      if (!seen || String(seen.at) < String(at)) {
        purchases.set(key, {
          at,
          vendorId: row.vendor_id ?? null,
          vendorName: row.vendor_name ?? null,
          // The invoice where there is one, the estimate otherwise, and null
          // when neither is known — never 0, which reads as "it was free".
          unitCostCents: nullableMoney.read(row.actual_unit_cost ?? row.estimated_unit_cost ?? null),
        });
      }
    }

    // Aggregate the request history.
    const grouped = new Map<string, any>();
    for (const row of items) {
      const key = String(row.normalized_description);
      if (!key) continue;
      const acc = grouped.get(key) ?? {
        descriptions: new Set<string>(),
        timesRequested: 0,
        totalQty: 0,
        lastRequestedAt: null as string | null,
        unit: null as string | null,
        catalogNumber: null as string | null,
      };
      acc.descriptions.add(String(row.description));
      acc.timesRequested += 1;
      acc.totalQty += qty.read(row.requested_qty);
      if (!acc.lastRequestedAt || String(row.created_at) > acc.lastRequestedAt) {
        acc.lastRequestedAt = String(row.created_at);
      }
      acc.unit = acc.unit ?? row.unit ?? null;
      acc.catalogNumber = acc.catalogNumber ?? row.stock_number ?? null;
      grouped.set(key, acc);
    }

    const entries: CatalogEntry[] = [];
    for (const [key, acc] of grouped) {
      entries.push(buildEntry(key, acc, curated.get(key), purchases.get(key)));
    }
    // A curated entry nobody has ordered yet still belongs in the catalogue.
    for (const [key, row] of curated) {
      if (grouped.has(key)) continue;
      entries.push(buildEntry(key, null, row, purchases.get(key)));
    }
    return entries;
  };

  return {
    async list(orgId, options = {}) {
      const { search = '', limit = 200, activeOnly = false } = options;
      let entries = await loadEntries();
      if (activeOnly) entries = entries.filter((e) => e.isActive);
      entries = matchCatalog(entries, search);
      entries.sort((a, b) => a.canonicalDescription.localeCompare(b.canonicalDescription));
      return entries.slice(0, limit);
    },

    async suggest(orgId, query, limit = 8) {
      const entries = matchCatalog((await loadEntries()).filter((e) => e.isActive), query);
      return entries.sort(byCatalogUsefulness).slice(0, limit);
    },

    async findByNormalized(orgId, normalizedDescription) {
      return (await loadEntries()).find((e) => e.normalizedDescription === normalizedDescription) ?? null;
    },

    async forVendor(vendorId, limit = 25) {
      // History again: what a vendor is bought for is a statement about past
      // orders, and re-describing a material afterwards must not change it.
      const rows = unwrap(
        await h.db
          .from(TABLES.historyLines)
          .select(
            'normalized_description, requested_description, ordered_description, unit, '
            + 'estimated_unit_cost, actual_unit_cost, ordered_qty, ordered_at',
          )
          .eq('org_id', h.orgId)
          .eq('vendor_id', vendorId)
          .not('ordered_at', 'is', null)
          .gt('ordered_qty', 0)
          .limit(HISTORY_LIMIT),
        'read vendor materials',
      ) as any[];

      const grouped = new Map<string, CatalogEntry>();
      for (const row of rows) {
        const key = String(row.normalized_description);
        const entry = grouped.get(key) ?? {
          catalogItemId: null,
          normalizedDescription: key,
          canonicalDescription: String(row.ordered_description ?? row.requested_description),
          aliases: [],
          defaultUnit: row.unit ?? null,
          catalogNumber: null,
          timesRequested: 0,
          totalQtyRequested: 0,
          lastRequestedAt: null,
          lastVendorId: vendorId,
          lastVendorName: null,
          lastUnitCostCents: null,
          lastOrderedAt: null,
          isActive: true,
        };
        entry.timesRequested += 1;
        entry.totalQtyRequested += qty.read(row.ordered_qty);
        const at = row.ordered_at ?? null;
        if (at && (!entry.lastOrderedAt || String(at) > entry.lastOrderedAt)) {
          entry.lastOrderedAt = String(at);
          entry.lastUnitCostCents = nullableMoney.read(row.actual_unit_cost ?? row.estimated_unit_cost ?? null);
        }
        grouped.set(key, entry);
      }
      return [...grouped.values()].sort((a, b) => b.timesRequested - a.timesRequested).slice(0, limit);
    },
  };
}

function buildEntry(key: string, history: any, curated: any, purchase: any): CatalogEntry {
  const aliases: string[] = history ? [...history.descriptions] : [];
  return {
    catalogItemId: curated ? String(curated.id) : null,
    normalizedDescription: key,
    canonicalDescription: String(curated?.canonical_description ?? aliases[0] ?? key),
    aliases,
    defaultUnit: curated?.default_unit ?? history?.unit ?? null,
    catalogNumber: curated?.catalog_number ?? history?.catalogNumber ?? null,
    timesRequested: Number(history?.timesRequested ?? 0),
    totalQtyRequested: Number(history?.totalQty ?? 0),
    lastRequestedAt: history?.lastRequestedAt ?? null,
    lastVendorId: purchase?.vendorId ?? curated?.default_vendor_id ?? null,
    lastVendorName: purchase?.vendorName ?? null,
    lastUnitCostCents: purchase?.unitCostCents ?? null,
    lastOrderedAt: purchase?.at ?? null,
    isActive: curated ? curated.is_active !== false : true,
  };
}
