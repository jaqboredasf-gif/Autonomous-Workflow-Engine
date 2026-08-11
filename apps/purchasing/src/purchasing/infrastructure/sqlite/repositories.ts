/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// repositories.ts — SQLite implementations of the domain's repository
// interfaces. THE ONLY FILE IN THE PURCHASING MODULE THAT KNOWS TABLE NAMES.
//
// Every method maps rows to domain-shaped records (camelCase, cents,
// thousandths) on the way out and back on the way in, so nothing above this
// layer sees `snake_case`, a `DatabaseSync`, or an integer boolean.
//
// These make no decisions. There is no status check, no permission check and no
// arithmetic in this file beyond the sums the database is best placed to do —
// the rules live in domain/, and the orchestration in application/.
//
// The methods are `async` to satisfy the repository contract, but the work
// inside is synchronous and settles in the same tick. There are no artificial
// delays: a local file store has nothing to wait for, and pretending otherwise
// would only make tests slower and less deterministic.
//
// The Supabase implementation of the same interfaces is the production
// counterpart (migration 0016 provides the tables, RLS and RPCs); swapping it in
// is a change to composition.ts and nothing else.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type {
  ApprovalRepository, CatalogEntry, EmailDraftRepository, InventoryRepository,
  ItemCatalogRepository, LineProgressRecord, PoNumberAllocator, PurchaseHistoryLineRecord,
  PurchaseHistoryRepository, PurchaseOrderRepository, PurchaseRequestRecord,
  PurchaseRequestRepository, ReceiptRepository, ReferenceRepository,
  RequestItemRecord, ReviewLineRecord, WorkshopReviewRepository,
} from '../../domain/repositories.ts';
import { formatPoNumber } from '../../domain/po-number.mjs';
import { lineOutstandingQty } from '../../domain/numbers.mjs';
import { byCatalogUsefulness, matchCatalog, normalizeDescription } from '../../domain/catalog.mjs';

const uuid = () => randomUUID();

/**
 * The organization a line item belongs to, read from its parent. Postgres does
 * this in a trigger (migration 0018); the local store has no trigger, so the
 * repository is the one place that sets it — and it always sets it from the
 * parent, never from an argument, so it cannot be spoofed.
 */
function orgOfReview(db: DatabaseSync, reviewId: string): string {
  const row = db.prepare(
    `select r.org_id from purchase_reviews rv
       join purchase_requests r on r.id = rv.request_id
      where rv.id = ?`,
  ).get(reviewId) as any;
  return row?.org_id;
}

function orgOfReceipt(db: DatabaseSync, receiptId: string): string {
  const row = db.prepare('select org_id from purchase_receipts where id = ?').get(receiptId) as any;
  return row?.org_id;
}

// --- mappers ----------------------------------------------------------------

function toRequest(row: any): PurchaseRequestRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    requestNumber: row.request_number,
    jobNumber: row.job_number,
    requestorId: row.requestor_id,
    requestorName: row.requestor_name ?? undefined,
    createdBy: row.created_by,
    status: row.status,
    needByDate: row.need_by_date,
    needByTime: row.need_by_time,
    deliveryLocationId: row.delivery_location_id,
    deliveryLocationName: row.delivery_location_name ?? undefined,
    deliveryLocationKind: row.delivery_location_kind ?? null,
    deliveryAddress: row.delivery_address ?? undefined,
    deliveryMethod: row.delivery_method,
    reason: row.reason ?? null,
    notes: row.notes ?? null,
    submittedAt: row.submitted_at ?? null,
    approverId: row.approver_id ?? null,
    approverName: row.approver_name ?? null,
    decidedAt: row.decided_at ?? null,
    decisionNotes: row.decision_notes ?? null,
    rejectionReason: row.rejection_reason ?? null,
    clarificationQuestion: row.clarification_question ?? null,
    clarificationAnswer: row.clarification_answer ?? null,
    vendorId: row.vendor_id ?? null,
    vendorName: row.vendor_name ?? null,
    estimatedTotalCents: Number(row.estimated_total_cents ?? 0),
    expectedArrivalDate: row.expected_arrival_date ?? null,
    trackingNumber: row.tracking_number ?? null,
    trackingCarrier: row.tracking_carrier ?? null,
    orderedAt: row.ordered_at ?? null,
    receivedAt: row.received_at ?? null,
    completedAt: row.completed_at ?? null,
    cancelReason: row.cancel_reason ?? null,
    version: Number(row.version ?? 1),
    createdAt: row.created_at,
    poNumber: row.po_number ?? null,
    // Aggregates used by the dashboard table; absent on a single-row read.
    ...(row.requested_qty === undefined
      ? {}
      : {
          requestedQty: Number(row.requested_qty ?? 0),
          itemCount: Number(row.item_count ?? 0),
          workshopStockQty: Number(row.stock_qty ?? 0),
          finalOrderQty: Number(row.final_qty ?? 0),
        }),
  } as PurchaseRequestRecord;
}

function toItem(row: any): RequestItemRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    lineNo: Number(row.line_no),
    description: row.description,
    requestedQty: Number(row.requested_qty),
    unit: row.unit,
    stockNumber: row.stock_number ?? null,
    notes: row.notes ?? null,
  };
}

const LIST_SELECT = `
  select r.*, u.full_name as requestor_name, a.full_name as approver_name, v.name as vendor_name,
         p.po_number,
         (select coalesce(sum(i.requested_qty), 0) from purchase_request_items i
           where i.request_id = r.id) as requested_qty,
         (select count(*) from purchase_request_items i where i.request_id = r.id) as item_count,
         (select coalesce(sum(ri.usable_stock_qty), 0) from purchase_review_items ri
            join purchase_reviews rv on rv.id = ri.review_id where rv.request_id = r.id) as stock_qty,
         (select coalesce(sum(ri.final_order_qty), 0) from purchase_review_items ri
            join purchase_reviews rv on rv.id = ri.review_id where rv.request_id = r.id) as final_qty
    from purchase_requests r
    join users u on u.id = r.requestor_id
    left join users a on a.id = r.approver_id
    left join vendors v on v.id = r.vendor_id
    left join purchase_orders p on p.request_id = r.id`;

// --- requests ---------------------------------------------------------------

export function sqliteRequestRepository(db: DatabaseSync): PurchaseRequestRepository {
  return {
    async nextRequestNumber(orgId) {
      const seq = db.prepare('select * from request_number_sequences where org_id = ?').get(orgId) as any;
      if (!seq) throw new Error('no request number sequence configured');
      const value = Number(seq.next_value);
      const res = db
        .prepare('update request_number_sequences set next_value = ?, updated_at = ? where org_id = ? and next_value = ?')
        .run(value + 1, new Date().toISOString(), orgId, value);
      if (Number(res.changes) !== 1) throw new Error('request number sequence was advanced concurrently; retry');
      return `${seq.prefix}${String(value).padStart(Number(seq.padding), '0')}${seq.suffix}`;
    },

    async insert(record) {
      const id = record.id ?? uuid();
      db.prepare(
        `insert into purchase_requests
           (id, org_id, request_number, job_number, requestor_id, status, need_by_date, need_by_time,
            delivery_location_id, delivery_method, reason, notes, version, created_at, updated_at, created_by)
         values (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
      ).run(
        id, record.orgId, record.requestNumber, record.jobNumber, record.requestorId, record.status,
        record.needByDate, record.needByTime, record.deliveryLocationId, record.deliveryMethod,
        record.reason ?? null, record.notes ?? null, record.now, record.now, record.createdBy,
      );
      record.items.forEach((item: any, idx: number) => {
        db.prepare(
          `insert into purchase_request_items
             (id, request_id, org_id, line_no, description, normalized_description,
              requested_qty, unit, stock_number, notes, created_at, updated_at, created_by)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(uuid(), id, record.orgId, idx + 1, item.description,
              // What the person typed is kept as typed; this is what it matched
              // on, recorded now so a later rule change cannot re-cluster history.
              normalizeDescription(item.description),
              item.requestedQty, item.unit,
              item.stockNumber ?? null, item.notes ?? null, record.now, record.now, record.createdBy);
      });
      return (await this.findById(id))!;
    },

    async findById(id) {
      const row = db
        .prepare(
          `select r.*, u.full_name as requestor_name, a.full_name as approver_name,
                  l.name as delivery_location_name, l.address as delivery_address,
                  l.kind as delivery_location_kind,
                  v.name as vendor_name, p.po_number
             from purchase_requests r
             join users u on u.id = r.requestor_id
             left join users a on a.id = r.approver_id
             left join delivery_locations l on l.id = r.delivery_location_id
             left join vendors v on v.id = r.vendor_id
             left join purchase_orders p on p.request_id = r.id
            where r.id = ?`,
        )
        .get(id) as any;
      return row ? toRequest(row) : null;
    },

    async listForOrg(orgId) {
      return (db.prepare(`${LIST_SELECT} where r.org_id = ? order by r.created_at desc`).all(orgId) as any[]).map(toRequest);
    },

    async listForRequestor(orgId, userId) {
      return (
        db
          .prepare(`${LIST_SELECT} where r.org_id = ? and (r.requestor_id = ? or r.created_by = ?) order by r.created_at desc`)
          .all(orgId, userId, userId) as any[]
      ).map(toRequest);
    },

    async update(id, expectedVersion, patch) {
      const columns = Object.keys(patch);
      const sets = [...columns.map((c) => `${c} = ?`), 'version = version + 1'].join(', ');
      const res = db
        .prepare(`update purchase_requests set ${sets} where id = ? and version = ?`)
        .run(...(Object.values(patch) as any[]), id, expectedVersion);
      if (Number(res.changes) !== 1) {
        const err: any = new Error('the request changed while you were working on it — reload and retry');
        err.reason = 'version_conflict';
        throw err;
      }
    },

    async patch(id, patch) {
      const sets = Object.keys(patch).map((c) => `${c} = ?`).join(', ');
      db.prepare(`update purchase_requests set ${sets} where id = ?`).run(...(Object.values(patch) as any[]), id);
    },

    async itemsFor(requestId) {
      return (db.prepare('select * from purchase_request_items where request_id = ? order by line_no').all(requestId) as any[]).map(toItem);
    },

    async replaceItems(requestId, items, actorId, now) {
      db.prepare('delete from purchase_request_items where request_id = ?').run(requestId);
      items.forEach((item: any, idx: number) => {
        const parent = db.prepare('select org_id from purchase_requests where id = ?').get(requestId) as any;
        db.prepare(
          `insert into purchase_request_items
             (id, request_id, org_id, line_no, description, normalized_description,
              requested_qty, unit, stock_number, notes, created_at, updated_at, created_by)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(uuid(), requestId, parent?.org_id, idx + 1, item.description,
              normalizeDescription(item.description), item.requestedQty, item.unit,
              item.stockNumber ?? null, item.notes ?? null, now, now, actorId);
      });
    },

    async attachmentsFor(requestId) {
      return db
        .prepare('select id, filename, content_type, byte_size, caption, created_at from purchase_request_attachments where request_id = ?')
        .all(requestId) as any[];
    },
  };
}

// --- workshop review --------------------------------------------------------

export function sqliteReviewRepository(db: DatabaseSync): WorkshopReviewRepository {
  return {
    async findByRequest(requestId) {
      const row = db.prepare('select * from purchase_reviews where request_id = ?').get(requestId) as any;
      return row ? { id: row.id, requestId: row.request_id, savedAt: row.saved_at ?? null, workshopNotes: row.workshop_notes ?? null } : null;
    },

    async open(requestId, reviewerId, now) {
      const id = uuid();
      db.prepare(
        `insert into purchase_reviews (id, request_id, reviewer_id, started_at, created_at, updated_at)
         values (?,?,?,?,?,?)`,
      ).run(id, requestId, reviewerId, now, now, now);
      return { id };
    },

    async saveLine(reviewId, requestItemId, values, actorId, now) {
      const previous = db
        .prepare('select * from purchase_review_items where review_id = ? and request_item_id = ?')
        .get(reviewId, requestItemId) as any;
      const v = values as any;
      if (previous) {
        db.prepare(
          `update purchase_review_items set
             usable_stock_qty=?, approved_qty=?, suggested_order_qty=?, final_order_qty=?,
             stock_applied_qty=?, replenishment_qty=?, vendor_id=?, estimated_unit_cost_cents=?,
             estimated_line_total_cents=?, substitute_description=?, expected_arrival_date=?,
             line_notes=?, override_reason=?, updated_at=?, updated_by=?
           where id = ?`,
        ).run(
          v.usableStockQty, v.approvedQty, v.suggestedOrderQty, v.finalOrderQty, v.stockAppliedQty,
          v.replenishmentQty, v.vendorId, v.estimatedUnitCostCents, v.estimatedLineTotalCents,
          v.substituteDescription, v.expectedArrivalDate, v.lineNotes, v.overrideReason, now, actorId, previous.id,
        );
      } else {
        db.prepare(
          `insert into purchase_review_items
             (id, review_id, org_id, request_item_id, usable_stock_qty, approved_qty, suggested_order_qty,
              final_order_qty, stock_applied_qty, replenishment_qty, vendor_id, estimated_unit_cost_cents,
              estimated_line_total_cents, substitute_description, expected_arrival_date, line_notes,
              override_reason, created_at, updated_at, updated_by)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          uuid(), reviewId, orgOfReview(db, reviewId), requestItemId, v.usableStockQty, v.approvedQty, v.suggestedOrderQty,
          v.finalOrderQty, v.stockAppliedQty, v.replenishmentQty, v.vendorId, v.estimatedUnitCostCents,
          v.estimatedLineTotalCents, v.substituteDescription, v.expectedArrivalDate, v.lineNotes,
          v.overrideReason, now, now, actorId,
        );
      }
      return {
        previous: previous
          ? {
              usableStock: Number(previous.usable_stock_qty),
              approvedQty: Number(previous.approved_qty),
              finalOrderQty: Number(previous.final_order_qty),
              vendorId: previous.vendor_id ?? null,
              unitCostCents: previous.estimated_unit_cost_cents ?? null,
            }
          : null,
      };
    },

    /**
     * The requestor's line and the workshop's line, side by side, joined but
     * never merged: `requestedQty` comes from purchase_request_items and cannot
     * be written through this shape.
     */
    async linesFor(requestId): Promise<ReviewLineRecord[]> {
      return (
        db
          .prepare(
            `select ri.*, i.description, i.unit, i.requested_qty, i.line_no, i.id as request_item_id, v.name as vendor_name
               from purchase_request_items i
               left join purchase_reviews r on r.request_id = i.request_id
               left join purchase_review_items ri on ri.request_item_id = i.id and ri.review_id = r.id
               left join vendors v on v.id = ri.vendor_id
              where i.request_id = ?
              order by i.line_no`,
          )
          .all(requestId) as any[]
      ).map((row) => ({
        id: row.id ?? null,
        requestItemId: row.request_item_id,
        lineNo: Number(row.line_no),
        description: row.description,
        unit: row.unit,
        requestedQty: Number(row.requested_qty),
        usableStockQty: Number(row.usable_stock_qty ?? 0),
        approvedQty: Number(row.approved_qty ?? row.requested_qty),
        suggestedOrderQty: Number(row.suggested_order_qty ?? 0),
        finalOrderQty: Number(row.final_order_qty ?? 0),
        stockAppliedQty: Number(row.stock_applied_qty ?? 0),
        replenishmentQty: Number(row.replenishment_qty ?? 0),
        vendorId: row.vendor_id ?? null,
        vendorName: row.vendor_name ?? null,
        estimatedUnitCostCents: row.estimated_unit_cost_cents ?? null,
        estimatedLineTotalCents: Number(row.estimated_line_total_cents ?? 0),
        substituteDescription: row.substitute_description ?? null,
        expectedArrivalDate: row.expected_arrival_date ?? null,
        lineNotes: row.line_notes ?? null,
        overrideReason: row.override_reason ?? null,
      }));
    },

    async markSaved(reviewId, reviewerId, workshopNotes, now) {
      db.prepare('update purchase_reviews set workshop_notes = ?, saved_at = ?, updated_at = ?, reviewer_id = ? where id = ?')
        .run(workshopNotes, now, now, reviewerId, reviewId);
    },
  };
}

// --- approvals --------------------------------------------------------------

export function sqliteApprovalRepository(db: DatabaseSync): ApprovalRepository {
  return {
    async record(requestId, approverId, decision, notes, reason, changes, now, selfApproved = false) {
      db.prepare(
        `insert into purchase_approvals (id, request_id, approver_id, decision, decided_at, notes, reason, changes_json, self_approved, created_at)
         values (?,?,?,?,?,?,?,?,?,?)`,
      ).run(uuid(), requestId, approverId, decision, now, notes, reason, JSON.stringify(changes ?? []), selfApproved ? 1 : 0, now);
    },

    async listForRequest(requestId) {
      return (db.prepare('select * from purchase_approvals where request_id = ? order by decided_at').all(requestId) as any[]).map((a) => ({
        id: a.id,
        decision: a.decision,
        decidedAt: a.decided_at,
        notes: a.notes,
        reason: a.reason,
        changes: JSON.parse(a.changes_json ?? '[]'),
        selfApproved: Boolean(a.self_approved),
        approverId: a.approver_id,
        approverName: (db.prepare('select full_name from users where id = ?').get(a.approver_id) as any)?.full_name,
      }));
    },
  };
}

// --- purchase orders --------------------------------------------------------

export function sqliteOrderRepository(db: DatabaseSync): PurchaseOrderRepository {
  const map = (row: any) =>
    row
      ? {
          id: row.id,
          orgId: row.org_id,
          requestId: row.request_id,
          poNumber: row.po_number,
          sequenceValue: Number(row.sequence_value),
          vendorId: row.vendor_id,
          vendorContactId: row.vendor_contact_id ?? null,
          jobNumber: row.job_number,
          approverId: row.approver_id,
          estimatedTotalCents: Number(row.estimated_total_cents ?? 0),
          status: row.status,
          generatedAt: row.generated_at,
        }
      : null;

  return {
    async findByRequest(requestId) {
      return map(db.prepare('select * from purchase_orders where request_id = ?').get(requestId));
    },

    async findById(id) {
      return map(db.prepare('select * from purchase_orders where id = ?').get(id));
    },

    async insert(order, now) {
      const id = uuid();
      db.prepare(
        `insert into purchase_orders
           (id, org_id, request_id, po_number, sequence_value, vendor_id, vendor_contact_id, job_number,
            approver_id, delivery_location_id, delivery_method, need_by_date, need_by_time,
            estimated_total_cents, notes, status, generated_at, generated_by, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, order.orgId, order.requestId, order.poNumber, order.sequenceValue, order.vendorId,
        order.vendorContactId ?? null, order.jobNumber, order.approverId, order.deliveryLocationId,
        order.deliveryMethod, order.needByDate, order.needByTime, order.estimatedTotalCents,
        order.notes ?? null, 'ISSUED', now, order.generatedBy, now, now,
      );
      order.items.forEach((line: any) => {
        db.prepare(
          `insert into purchase_order_items
             (id, purchase_order_id, org_id, line_no, request_item_id, description,
              normalized_description, substitute_description, order_qty, unit,
              unit_cost_cents, line_total_cents, expected_arrival_date, created_at)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(uuid(), id, order.orgId, line.lineNo, line.requestItemId, line.description,
              // The ORDERED description is normalized too: a substitute is a
              // different item, and history should be able to see that.
              normalizeDescription(line.substituteDescription || line.description),
              line.substituteDescription,
              line.orderQty, line.unit, line.unitCostCents, line.lineTotalCents,
              line.expectedArrivalDate, now);
      });
      return { id, poNumber: order.poNumber };
    },

    async itemsFor(purchaseOrderId) {
      return db.prepare('select * from purchase_order_items where purchase_order_id = ? order by line_no').all(purchaseOrderId) as any[];
    },

    async progressFor(requestId): Promise<LineProgressRecord[]> {
      const po = db.prepare('select * from purchase_orders where request_id = ?').get(requestId) as any;
      if (!po) return [];
      const items = db.prepare('select * from purchase_order_items where purchase_order_id = ? order by line_no').all(po.id) as any[];
      return items.map((item) => {
        const totals = db
          .prepare(
            `select coalesce(sum(received_qty),0) as received,
                    coalesce(sum(damaged_qty),0) as damaged,
                    coalesce(sum(backordered_qty),0) as backordered,
                    coalesce(sum(written_off_qty),0) as written_off
               from purchase_receipt_items where purchase_order_item_id = ?`,
          )
          .get(item.id) as any;
        return {
          purchaseOrderItemId: item.id,
          requestItemId: item.request_item_id,
          description: item.description,
          unit: item.unit,
          finalOrderQty: Number(item.order_qty),
          receivedQty: Number(totals.received),
          damagedQty: Number(totals.damaged),
          backorderedQty: Number(totals.backordered),
          writtenOffQty: Number(totals.written_off),
          outstandingQty: lineOutstandingQty({
            finalOrderQty: item.order_qty,
            receivedQty: totals.received,
            damagedQty: totals.damaged,
            writtenOffQty: totals.written_off,
          }),
        };
      });
    },

    async recordActualCost(orgId, purchaseOrderId, input: any, actorId, now) {
      // Scoped by org_id as well as id: the caller's organization is never
      // taken on trust, even when the id came from a record they just read.
      db.prepare(
        `update purchase_orders
            set actual_total_cents = ?, actual_cost_source = ?, updated_at = ?, updated_by = ?
          where id = ? and org_id = ?`,
      ).run(
        input.actualTotalCents, input.reference ?? input.source ?? null,
        now, actorId, purchaseOrderId, orgId,
      );
    },

    async view(purchaseOrderId) {
      const po = db.prepare('select * from purchase_orders where id = ?').get(purchaseOrderId) as any;
      if (!po) return null;
      const org = db.prepare('select * from orgs where id = ?').get(po.org_id) as any;
      const vendor = db.prepare('select * from vendors where id = ?').get(po.vendor_id) as any;
      const contact = po.vendor_contact_id
        ? (db.prepare('select * from vendor_contacts where id = ?').get(po.vendor_contact_id) as any)
        : null;
      const location = db.prepare('select * from delivery_locations where id = ?').get(po.delivery_location_id) as any;
      const approver = db.prepare('select * from users where id = ?').get(po.approver_id) as any;
      const request = db.prepare('select * from purchase_requests where id = ?').get(po.request_id) as any;
      const requestor = db.prepare('select * from users where id = ?').get(request.requestor_id) as any;
      const items = db.prepare('select * from purchase_order_items where purchase_order_id = ? order by line_no').all(purchaseOrderId) as any[];

      return {
        org: { id: org.id, name: org.name, phone: org.phone, address: org.address },
        purchaseOrder: {
          id: po.id, poNumber: po.po_number, generatedAt: po.generated_at,
          estimatedTotalCents: Number(po.estimated_total_cents), notes: po.notes,
          orderedAt: request.ordered_at ?? null, status: po.status,
        },
        vendor: { id: vendor.id, name: vendor.name, accountNumber: vendor.account_number, phone: vendor.phone, address: vendor.address },
        vendorContact: contact ? { name: contact.name, email: contact.email, phone: contact.phone } : null,
        request: {
          id: request.id, requestNumber: request.request_number, jobNumber: request.job_number,
          needByDate: request.need_by_date, needByTime: request.need_by_time,
          deliveryMethod: request.delivery_method, deliveryLocationName: location?.name ?? '',
          deliveryAddress: location?.address ?? '', requestorName: requestor?.full_name ?? '',
          reason: request.reason ?? '', notes: request.notes ?? '',
        },
        approver: { id: approver?.id, name: approver?.full_name ?? '' },
        items: items.map((i) => ({
          lineNo: i.line_no, description: i.description, substituteFor: i.substitute_description,
          finalOrderQty: Number(i.order_qty), unit: i.unit,
          estimatedUnitCostCents: Number(i.unit_cost_cents), lineTotalCents: Number(i.line_total_cents),
          expectedArrivalDate: i.expected_arrival_date,
        })),
      };
    },
  };
}

/**
 * PO numbering. The compare-and-set is the whole safety property: even if two
 * callers read the same value, only one update lands, and the caller running
 * inside the unit of work holds the write lock while it happens.
 */
export function sqlitePoNumberAllocator(db: DatabaseSync): PoNumberAllocator {
  return {
    async allocate(orgId, now) {
      const seq = db.prepare('select * from po_number_sequences where org_id = ?').get(orgId) as any;
      if (!seq) {
        const err: any = new Error('no PO number sequence configured for this organization');
        err.reason = 'po_sequence_missing';
        throw err;
      }
      const value = Number(seq.next_value);
      const res = db
        .prepare('update po_number_sequences set next_value = ?, updated_at = ? where org_id = ? and next_value = ?')
        .run(value + 1, now, orgId, value);
      if (Number(res.changes) !== 1) {
        const err: any = new Error('PO number sequence was advanced concurrently; retry');
        err.reason = 'po_sequence_contended';
        throw err;
      }
      return {
        poNumber: formatPoNumber(value, { prefix: seq.prefix, padding: seq.padding, suffix: seq.suffix }),
        sequenceValue: value,
      };
    },
  };
}

// --- email drafts -----------------------------------------------------------

export function sqliteEmailDraftRepository(db: DatabaseSync): EmailDraftRepository {
  const map = (d: any) =>
    d
      ? {
          id: d.id,
          orgId: d.org_id,
          requestId: d.request_id,
          purchaseOrderId: d.purchase_order_id ?? null,
          templateKey: d.template_key,
          status: d.status,
          subject: d.subject,
          body: d.body,
          to: JSON.parse(d.to_addrs),
          cc: JSON.parse(d.cc_addrs),
          attachments: JSON.parse(d.attachments),
          draftKey: d.draft_key,
          generatedAt: d.generated_at,
          reviewedAt: d.reviewed_at ?? null,
          reviewedBy: d.reviewed_by ?? null,
          sentAt: d.sent_at ?? null,
          externalSendEnabled: Boolean(d.external_send_enabled),
        }
      : null;

  return {
    async findByKey(orgId, draftKey) {
      return map(db.prepare('select * from purchase_email_drafts where org_id = ? and draft_key = ?').get(orgId, draftKey));
    },
    async findById(id) {
      return map(db.prepare('select * from purchase_email_drafts where id = ?').get(id));
    },
    async listForRequest(requestId) {
      return (db.prepare('select * from purchase_email_drafts where request_id = ? order by created_at').all(requestId) as any[]).map(map);
    },
    async insert(draft, now) {
      const id = uuid();
      db.prepare(
        `insert into purchase_email_drafts
           (id, org_id, request_id, purchase_order_id, template_key, status, subject, body,
            to_addrs, cc_addrs, attachments, draft_key, generated_at, generated_by,
            external_send_enabled, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      ).run(
        id, draft.orgId, draft.requestId, draft.purchaseOrderId, draft.templateKey, draft.status,
        draft.subject, draft.body, JSON.stringify(draft.to), JSON.stringify(draft.cc),
        JSON.stringify(draft.attachments), draft.draftKey, now, draft.generatedBy, now, now,
      );
      return { id };
    },
    async updateContent(id, patch, now) {
      const current = db.prepare('select * from purchase_email_drafts where id = ?').get(id) as any;
      db.prepare('update purchase_email_drafts set subject = ?, body = ?, updated_at = ? where id = ?')
        .run(patch.subject ?? current.subject, patch.body ?? current.body, now, id);
    },
    async updateStatus(id, columns) {
      const sets = Object.keys(columns).map((c) => `${c} = ?`).join(', ');
      db.prepare(`update purchase_email_drafts set ${sets} where id = ?`).run(...(Object.values(columns) as any[]), id);
    },
  };
}

// --- receiving --------------------------------------------------------------

export function sqliteReceiptRepository(db: DatabaseSync): ReceiptRepository {
  const mapReceipt = (r: any) => ({
    id: r.id,
    orgId: r.org_id,
    requestId: r.request_id,
    purchaseOrderId: r.purchase_order_id ?? null,
    receivedDate: r.received_date,
    receivedBy: r.received_by,
    packingSlipNumber: r.packing_slip_number,
    notes: r.notes,
    isFinal: Boolean(r.is_final),
    createdAt: r.created_at,
    items: db.prepare('select * from purchase_receipt_items where receipt_id = ?').all(r.id),
  });

  return {
    async insert(receipt, now) {
      const id = uuid();
      db.prepare(
        `insert into purchase_receipts
           (id, org_id, request_id, purchase_order_id, received_date, received_by, packing_slip_number, notes, is_final, created_at)
         values (?,?,?,?,?,?,?,?,0,?)`,
      ).run(id, receipt.orgId, receipt.requestId, receipt.purchaseOrderId ?? null, receipt.receivedDate,
            receipt.receivedBy, receipt.packingSlipNumber ?? null, receipt.notes ?? null, now);
      return { id };
    },

    async insertLine(receiptId, line, now) {
      db.prepare(
        `insert into purchase_receipt_items
           (id, receipt_id, org_id, purchase_order_item_id, received_qty, damaged_qty, backordered_qty,
            written_off_qty, over_receipt_override, override_reason, notes, created_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(uuid(), receiptId, orgOfReceipt(db, receiptId), line.purchaseOrderItemId, line.receivedQty, line.damagedQty,
            line.backorderedQty, line.writtenOffQty, line.overrideReason ? 1 : 0,
            line.overrideReason ?? null, line.notes ?? null, now);
    },

    async markFinal(receiptId) {
      db.prepare('update purchase_receipts set is_final = 1 where id = ?').run(receiptId);
    },

    async listForRequest(requestId) {
      return (db.prepare('select * from purchase_receipts where request_id = ? order by created_at').all(requestId) as any[]).map(mapReceipt);
    },

    async findById(id) {
      const row = db.prepare('select * from purchase_receipts where id = ?').get(id) as any;
      return row ? mapReceipt(row) : null;
    },

    async attachmentsFor(receiptId) {
      return db
        .prepare('select id, filename, content_type, byte_size, caption, created_at from purchase_receipt_attachments where receipt_id = ?')
        .all(receiptId) as any[];
    },

    async attach(receiptId, file, actorId, now) {
      db.prepare(
        `insert into purchase_receipt_attachments (id, receipt_id, filename, content_type, byte_size, data_base64, caption, created_at, created_by)
         values (?,?,?,?,?,?,?,?,?)`,
      ).run(uuid(), receiptId, file.filename, file.contentType ?? null,
            file.dataBase64 ? Math.floor((file.dataBase64.length * 3) / 4) : null,
            file.dataBase64 ?? null, file.caption ?? null, now, actorId);
    },
  };
}

// --- inventory --------------------------------------------------------------

export function sqliteInventoryRepository(db: DatabaseSync): InventoryRepository {
  return {
    async observe(record, now) {
      db.prepare(
        `insert into inventory_observations
           (id, org_id, request_id, request_item_id, item_description, observed_qty, unit,
            observed_at, observed_by, notes, created_at)
         values (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(uuid(), record.orgId, record.requestId, record.requestItemId, record.description,
            record.observedQty, record.unit, now, record.observedBy, record.notes ?? null, now);
    },

    async adjust(record, now) {
      db.prepare(
        `insert into inventory_adjustments
           (id, org_id, request_id, request_item_id, item_description, delta_qty, unit, reason, adjusted_at, adjusted_by, created_at)
         values (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(uuid(), record.orgId, record.requestId, record.requestItemId, record.description,
            record.deltaQty, record.unit, record.reason, now, record.adjustedBy, now);
    },
  };
}

// --- reference data + settings ----------------------------------------------

export function sqliteReferenceRepository(db: DatabaseSync): ReferenceRepository {
  return {
    async vendors(orgId) {
      return db
        .prepare(
          `select v.*, c.name as contact_name, c.email as contact_email, c.phone as contact_phone
             from vendors v
             left join vendor_contacts c on c.vendor_id = v.id and c.is_primary = 1
            where v.org_id = ? and v.is_active = 1 order by v.name`,
        )
        .all(orgId) as any[];
    },
    async primaryContact(vendorId) {
      return db.prepare('select * from vendor_contacts where vendor_id = ? order by is_primary desc limit 1').get(vendorId) as any;
    },
    async deliveryLocations(orgId) {
      return db.prepare('select * from delivery_locations where org_id = ? and is_active = 1 order by kind, name').all(orgId) as any[];
    },
    async jobs(orgId) {
      // The job DIRECTORY (0018). `jobs` was the pilot's original table and is
      // still read as a fallback so an existing database keeps working until
      // its rows are migrated across.
      const directory = db.prepare(
        `select id, org_id, job_number, name, customer, site_address as address, status,
                case when status = 'ACTIVE' then 1 else 0 end as is_active,
                default_location_id, created_at
           from purchase_jobs
          where org_id = ? and status in ('ACTIVE','ON_HOLD')
          order by job_number`,
      ).all(orgId) as any[];
      if (directory.length) return directory;
      return db.prepare('select * from jobs where org_id = ? and is_active = 1 order by job_number').all(orgId) as any[];
    },
    // --- directory writes ---------------------------------------------------
    async vendorByName(orgId, name) {
      return (db.prepare('select * from vendors where org_id = ? and lower(name) = lower(?)')
        .get(orgId, name) as any) ?? null;
    },
    async createVendor(orgId, input: any, actorId, now) {
      const id = uuid();
      db.prepare(
        `insert into vendors (id, org_id, name, account_number, phone, address, notes,
                              is_active, created_at, updated_at, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      ).run(id, orgId, input.name, input.accountNumber ?? null, input.phone ?? null,
            input.address ?? null, input.notes ?? null, now, now, actorId, actorId);
      return id;
    },
    async updateVendor(orgId, vendorId, patch: any, actorId, now) {
      // Only the keys present are written, so a partial update (retiring a
      // vendor, say) cannot blank the fields it did not mention.
      const columns: Record<string, string | number | null> = {};
      if (patch.name !== undefined) columns.name = patch.name;
      if (patch.accountNumber !== undefined) columns.account_number = patch.accountNumber;
      if (patch.phone !== undefined) columns.phone = patch.phone;
      if (patch.address !== undefined) columns.address = patch.address;
      if (patch.notes !== undefined) columns.notes = patch.notes;
      if (patch.isActive !== undefined) columns.is_active = patch.isActive ? 1 : 0;
      const keys = Object.keys(columns);
      if (!keys.length) return;
      db.prepare(
        `update vendors set ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?, updated_by = ?
          where id = ? and org_id = ?`,
      ).run(...keys.map((k) => columns[k]), now, actorId, vendorId, orgId);
    },
    async setVendorPrimaryContact(orgId, vendorId, contact: any, now) {
      const owned = db.prepare('select id from vendors where id = ? and org_id = ?').get(vendorId, orgId);
      if (!owned) return;
      const existing = db.prepare('select id from vendor_contacts where vendor_id = ? and is_primary = 1')
        .get(vendorId) as any;
      // The pilot schema requires an email on a contact. A contact with only a
      // phone number is real, so an empty string stands in rather than the row
      // being refused outright.
      const email = contact.email ?? '';
      const name = contact.name ?? 'Orders';
      if (existing) {
        db.prepare('update vendor_contacts set name = ?, email = ?, phone = ?, updated_at = ? where id = ?')
          .run(name, email, contact.phone ?? null, now, existing.id);
      } else {
        db.prepare(
          `insert into vendor_contacts (id, vendor_id, name, email, phone, is_primary, created_at, updated_at)
           values (?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(uuid(), vendorId, name, email, contact.phone ?? null, now, now);
      }
    },
    async jobByNumber(orgId, jobNumber) {
      return (db.prepare('select * from purchase_jobs where org_id = ? and job_number = ?')
        .get(orgId, jobNumber) as any) ?? null;
    },
    async createJob(orgId, input: any, actorId, now) {
      const id = uuid();
      db.prepare(
        `insert into purchase_jobs (id, org_id, job_number, name, customer, site_address, status,
                                    delivery_instructions, cost_code, created_at, updated_at, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, orgId, input.jobNumber, input.name, input.customer ?? null, input.siteAddress ?? null,
            input.status ?? 'ACTIVE', input.deliveryInstructions ?? null, input.costCode ?? null,
            now, now, actorId, actorId);
      return id;
    },
    async updateJob(orgId, jobId, patch: any, actorId, now) {
      const columns: Record<string, string | number | null> = {};
      if (patch.name !== undefined) columns.name = patch.name;
      if (patch.customer !== undefined) columns.customer = patch.customer;
      if (patch.siteAddress !== undefined) columns.site_address = patch.siteAddress;
      if (patch.status !== undefined) columns.status = patch.status;
      if (patch.deliveryInstructions !== undefined) columns.delivery_instructions = patch.deliveryInstructions;
      if (patch.costCode !== undefined) columns.cost_code = patch.costCode;
      const keys = Object.keys(columns);
      if (!keys.length) return;
      db.prepare(
        `update purchase_jobs set ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?, updated_by = ?
          where id = ? and org_id = ?`,
      ).run(...keys.map((k) => columns[k]), now, actorId, jobId, orgId);
    },

    async users(orgId) {
      const rows = db.prepare('select * from users where org_id = ? order by full_name').all(orgId) as any[];
      return rows.map((u) => ({
        ...u,
        roles: (db.prepare('select role_key from user_roles where user_id = ?').all(u.id) as any[]).map((r) => r.role_key),
      }));
    },
    async settings(orgId) {
      const s = db.prepare('select * from system_settings where org_id = ?').get(orgId) as any;
      return {
        allowSelfApproval: Boolean(s?.allow_self_approval),
        externalSendEnabled: false as const,
        requireEmailReview: true as const,
        overdueGraceHours: Number(s?.overdue_grace_hours ?? 0),
        defaultDeliveryMethod: String(s?.default_delivery_method ?? 'DELIVERY'),
        poTemplateKey: String(s?.po_template_key ?? 'lippolis_default'),
      };
    },
    async emailTemplate(orgId, key) {
      const row = db
        .prepare('select * from email_templates where org_id = ? and template_key = ? and is_active = 1')
        .get(orgId, key) as any;
      return row ? { subject: row.subject, body: row.body } : null;
    },
    async emailTemplates(orgId) {
      return db.prepare('select * from email_templates where org_id = ? order by template_key').all(orgId) as any[];
    },
    async poConfig(orgId) {
      return db.prepare('select * from po_number_sequences where org_id = ?').get(orgId) as any;
    },
    async updatePoConfig(orgId, patch: any, actorId, now) {
      db.prepare(
        'update po_number_sequences set prefix = ?, padding = ?, suffix = ?, next_value = ?, updated_at = ?, updated_by = ? where org_id = ?',
      ).run(patch.prefix, patch.padding, patch.suffix, patch.nextValue, now, actorId, orgId);
    },
    async setApprovalAuthority(userId, canApprove, actorId, now) {
      db.prepare('update users set can_approve = ?, updated_at = ?, updated_by = ? where id = ?')
        .run(canApprove ? 1 : 0, now, actorId, userId);
    },
  };
}

// ---------------------------------------------------------------------------
// The item catalogue.
//
// Built from the line items themselves rather than from a counter column: the
// rows already carry `normalized_description`, written by domain/catalog.mjs
// when the request was raised, and migration 0018 is explicit that ranking is
// a query. The curated `purchase_item_catalog` row is folded over the top when
// one exists, so curation wins on the name and history supplies everything
// else.
// ---------------------------------------------------------------------------

export function sqliteItemCatalogRepository(db: DatabaseSync): ItemCatalogRepository {
  /**
   * One row per normalized item, from history. The aggregates are the
   * database's work; the shaping is this file's.
   */
  const HISTORY = `
    select ri.normalized_description                       as normalized_description,
           min(ri.description)                             as first_description,
           group_concat(distinct ri.description)           as aliases,
           count(*)                                        as times_requested,
           sum(ri.requested_qty)                           as total_qty,
           max(r.created_at)                               as last_requested_at,
           max(ri.unit)                                    as default_unit,
           max(ri.stock_number)                            as catalog_number
      from purchase_request_items ri
      join purchase_requests r on r.id = ri.request_id
     where ri.org_id = ?
       and ri.normalized_description is not null
       and ri.normalized_description <> ''
     group by ri.normalized_description`;

  /**
   * What each item was last actually bought as, and from whom — read from the
   * IMMUTABLE HISTORY, not from a join to the live vendor row.
   *
   * This is the rename bug, closed. The previous query joined `vendors` at read
   * time, so renaming a vendor rewrote every "last ordered from" the catalogue
   * had ever shown. `purchase_history_lines.vendor_name` is the name the
   * purchase order carried, and it does not move.
   *
   * Only lines that were ACTUALLY ORDERED are price evidence — `ordered_at`
   * present and a quantity above zero. A rejected or never-placed request has
   * neither, so it is excluded by the facts rather than by a special case. See
   * domain/history.mjs for the policy this implements.
   */
  const PURCHASE = `
    select h.normalized_description                              as normalized_description,
           h.vendor_id                                           as vendor_id,
           h.vendor_name                                         as vendor_name,
           coalesce(h.actual_unit_cost_cents,
                    h.estimated_unit_cost_cents)                 as unit_cost_cents,
           h.ordered_at                                          as ordered_at
      from purchase_history_lines h
     where h.org_id = ?
       and h.ordered_at is not null
       and h.ordered_qty > 0
     order by h.ordered_at desc`;

  const curatedFor = (orgId: string) => {
    const rows = db
      .prepare('select * from purchase_item_catalog where org_id = ?')
      .all(orgId) as any[];
    return new Map(rows.map((row) => [String(row.normalized_description), row]));
  };

  const purchasesFor = (orgId: string) => {
    const rows = db.prepare(PURCHASE).all(orgId) as any[];
    // Ordered newest first, so the FIRST row seen for a key is the latest.
    const latest = new Map<string, any>();
    for (const row of rows) {
      if (!latest.has(String(row.normalized_description))) {
        latest.set(String(row.normalized_description), row);
      }
    }
    return latest;
  };

  const entriesFor = (orgId: string): CatalogEntry[] => {
    const curated = curatedFor(orgId);
    const purchases = purchasesFor(orgId);
    const history = db.prepare(HISTORY).all(orgId) as any[];

    const entries = history.map((row) => {
      const key = String(row.normalized_description);
      const c = curated.get(key);
      const p = purchases.get(key);
      return toCatalogEntry({ history: row, curated: c, purchase: p });
    });

    // A curated entry nobody has ordered yet still belongs in the catalogue:
    // that is what curating one ahead of time is FOR.
    for (const [key, row] of curated) {
      if (entries.some((e) => e.normalizedDescription === key)) continue;
      entries.push(toCatalogEntry({ history: null, curated: row, purchase: purchases.get(key) }));
    }
    return entries;
  };

  return {
    async list(orgId, options = {}) {
      const { search = '', limit = 200, activeOnly = false } = options;
      let entries = entriesFor(orgId);
      if (activeOnly) entries = entries.filter((e) => e.isActive);
      entries = matchCatalog(entries, search);
      // Alphabetical: a catalogue is browsed, not triaged.
      entries.sort((a, b) => a.canonicalDescription.localeCompare(b.canonicalDescription));
      return entries.slice(0, limit);
    },

    async suggest(orgId, query, limit = 8) {
      const entries = matchCatalog(entriesFor(orgId).filter((e) => e.isActive), query);
      return entries.sort(byCatalogUsefulness).slice(0, limit);
    },

    async findByNormalized(orgId, normalizedDescription) {
      return entriesFor(orgId).find((e) => e.normalizedDescription === normalizedDescription) ?? null;
    },

    async forVendor(vendorId, limit = 25) {
      // History, again: what this vendor was bought for is a statement about
      // past orders, and it must not change because a material was re-described
      // afterwards. `ordered_description` is what the purchase order said.
      const rows = db
        .prepare(
          `select h.normalized_description                            as normalized_description,
                  min(coalesce(h.ordered_description,
                               h.requested_description))              as first_description,
                  count(*)                                            as times_requested,
                  sum(h.ordered_qty)                                  as total_qty,
                  max(h.ordered_at)                                   as last_ordered_at,
                  max(h.unit)                                         as default_unit,
                  max(coalesce(h.actual_unit_cost_cents,
                               h.estimated_unit_cost_cents))          as unit_cost_cents
             from purchase_history_lines h
            where h.vendor_id = ?
              and h.ordered_at is not null
              and h.ordered_qty > 0
              and h.normalized_description <> ''
            group by h.normalized_description
            order by count(*) desc
            limit ?`,
        )
        .all(vendorId, limit) as any[];
      return rows.map((row) => ({
        catalogItemId: null,
        normalizedDescription: String(row.normalized_description),
        canonicalDescription: String(row.first_description),
        aliases: [],
        defaultUnit: row.default_unit ?? null,
        catalogNumber: null,
        timesRequested: Number(row.times_requested ?? 0),
        totalQtyRequested: Number(row.total_qty ?? 0),
        lastRequestedAt: null,
        lastVendorId: vendorId,
        lastVendorName: null,
        lastUnitCostCents: row.unit_cost_cents === null || row.unit_cost_cents === undefined
          ? null
          : Number(row.unit_cost_cents),
        lastOrderedAt: row.last_ordered_at ?? null,
        isActive: true,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// IMMUTABLE PURCHASING HISTORY.
//
// Insert-only. There is no update statement and no delete statement in this
// repository, and the schema carries triggers that refuse both anyway — the
// repository not offering them is a design statement, the triggers are the
// guarantee.
// ---------------------------------------------------------------------------

const HISTORY_COLUMNS = [
  'id', 'org_id', 'terminal_state', 'terminal_reason', 'recorded_at', 'recorded_by',
  'request_id', 'request_number', 'request_item_id', 'line_no',
  'purchase_order_id', 'po_number', 'purchase_order_item_id', 'job_id', 'job_number', 'catalog_item_id',
  'normalized_description', 'normalizer_version', 'requested_description', 'ordered_description',
  'unit', 'requested_qty', 'ordered_qty',
  'vendor_id', 'vendor_name', 'vendor_part_number',
  'estimated_unit_cost_cents', 'estimated_line_total_cents',
  'actual_unit_cost_cents', 'actual_line_total_cents',
  'requestor_id', 'requestor_name', 'approver_id', 'approver_name',
  'requested_at', 'po_generated_at', 'ordered_at', 'received_at', 'completed_at',
  'received_qty', 'damaged_qty', 'backordered_qty', 'written_off_qty', 'outcome',
];

export function sqlitePurchaseHistoryRepository(db: DatabaseSync): PurchaseHistoryRepository {
  const INSERT = `insert or ignore into purchase_history_lines (${HISTORY_COLUMNS.join(', ')})
                  values (${HISTORY_COLUMNS.map(() => '?').join(',')})`;

  return {
    async record(lines, _now) {
      let inserted = 0;
      for (const line of lines) {
        // `insert or ignore` on the (org, request, request item) unique key:
        // writing history twice is a no-op, so a retried completion completes
        // rather than failing on a duplicate.
        const result = db.prepare(INSERT).run(
          line.id ?? uuid(), line.orgId, line.terminalState, line.terminalReason ?? null,
          line.recordedAt, line.recordedBy,
          line.requestId, line.requestNumber, line.requestItemId, line.lineNo,
          line.purchaseOrderId ?? null, line.poNumber ?? null, line.purchaseOrderItemId ?? null,
          line.jobId ?? null, line.jobNumber, line.catalogItemId ?? null,
          line.normalizedDescription, line.normalizerVersion, line.requestedDescription,
          line.orderedDescription ?? null, line.unit, line.requestedQty, line.orderedQty,
          line.vendorId ?? null, line.vendorName ?? null, line.vendorPartNumber ?? null,
          line.estimatedUnitCostCents ?? null, line.estimatedLineTotalCents ?? null,
          line.actualUnitCostCents ?? null, line.actualLineTotalCents ?? null,
          line.requestorId, line.requestorName ?? null, line.approverId ?? null, line.approverName ?? null,
          line.requestedAt ?? null, line.poGeneratedAt ?? null, line.orderedAt ?? null,
          line.receivedAt ?? null, line.completedAt ?? null,
          line.receivedQty, line.damagedQty, line.backorderedQty, line.writtenOffQty, line.outcome,
        );
        inserted += Number(result.changes);
      }
      return { inserted, skipped: lines.length - inserted };
    },

    async forRequest(orgId, requestId) {
      const rows = db
        .prepare('select * from purchase_history_lines where org_id = ? and request_id = ? order by line_no')
        .all(orgId, requestId) as any[];
      return rows.map(toHistoryLine);
    },

    async listForOrg(orgId, options = {}) {
      const { limit = 500, normalizedDescription, vendorId } = options;
      const where = ['org_id = ?'];
      const args: any[] = [orgId];
      if (normalizedDescription) { where.push('normalized_description = ?'); args.push(normalizedDescription); }
      if (vendorId) { where.push('vendor_id = ?'); args.push(vendorId); }
      const rows = db
        .prepare(
          `select * from purchase_history_lines
            where ${where.join(' and ')}
            order by coalesce(ordered_at, recorded_at) desc, line_no
            limit ?`,
        )
        .all(...args, limit) as any[];
      return rows.map(toHistoryLine);
    },
  };
}

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
    requestedQty: Number(row.requested_qty),
    orderedQty: Number(row.ordered_qty),
    vendorId: row.vendor_id ?? null,
    vendorName: row.vendor_name ?? null,
    vendorPartNumber: row.vendor_part_number ?? null,
    estimatedUnitCostCents: nullableNumber(row.estimated_unit_cost_cents),
    estimatedLineTotalCents: nullableNumber(row.estimated_line_total_cents),
    actualUnitCostCents: nullableNumber(row.actual_unit_cost_cents),
    actualLineTotalCents: nullableNumber(row.actual_line_total_cents),
    requestorId: row.requestor_id,
    requestorName: row.requestor_name ?? null,
    approverId: row.approver_id ?? null,
    approverName: row.approver_name ?? null,
    requestedAt: row.requested_at ?? null,
    poGeneratedAt: row.po_generated_at ?? null,
    orderedAt: row.ordered_at ?? null,
    receivedAt: row.received_at ?? null,
    completedAt: row.completed_at ?? null,
    receivedQty: Number(row.received_qty),
    damagedQty: Number(row.damaged_qty),
    backorderedQty: Number(row.backordered_qty),
    writtenOffQty: Number(row.written_off_qty),
    outcome: row.outcome,
  };
}

/** An unknown cost stays unknown. 0 is a recorded price of zero, not "no idea". */
function nullableNumber(value: any): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Fold history, curation and the last purchase into one entry. */
function toCatalogEntry({ history, curated, purchase }: { history: any; curated: any; purchase: any }): CatalogEntry {
  const normalized = String(history?.normalized_description ?? curated?.normalized_description ?? '');
  const aliases = String(history?.aliases ?? '')
    .split(',')
    .map((a: string) => a.trim())
    .filter(Boolean);
  return {
    catalogItemId: curated ? String(curated.id) : null,
    normalizedDescription: normalized,
    // Curation wins on the NAME and only on the name: it is the one field a
    // human is expected to improve.
    canonicalDescription: String(curated?.canonical_description ?? history?.first_description ?? normalized),
    aliases: [...new Set(aliases)],
    defaultUnit: curated?.default_unit ?? history?.default_unit ?? null,
    catalogNumber: curated?.catalog_number ?? history?.catalog_number ?? null,
    timesRequested: Number(history?.times_requested ?? 0),
    totalQtyRequested: Number(history?.total_qty ?? 0),
    lastRequestedAt: history?.last_requested_at ?? null,
    lastVendorId: purchase?.vendor_id ?? curated?.default_vendor_id ?? null,
    lastVendorName: purchase?.vendor_name ?? null,
    lastUnitCostCents:
      purchase?.unit_cost_cents === null || purchase?.unit_cost_cents === undefined
        ? null
        : Number(purchase.unit_cost_cents),
    lastOrderedAt: purchase?.ordered_at ?? null,
    // Only a curated row can be switched off. An item somebody bought last
    // week is active whether or not anyone has curated it.
    isActive: curated ? Boolean(Number(curated.is_active ?? 1)) : true,
  };
}
