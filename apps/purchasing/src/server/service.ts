/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// service.ts — THE server boundary. Every write in the purchasing module goes
// through a function in this file, and every function here does the same four
// things in the same order:
//
//   1. resolve the actor from the SESSION (never from the request body)
//   2. authorize() — the pure permission decision from domain/roles.mjs
//   3. transitionGuard() — the pure state decision from domain/status.mjs
//   4. write + activity row + notification, inside ONE transaction
//
// A denial is written to the activity log before it is thrown, so a probe is
// visible rather than merely refused. Nothing in src/app/ writes to the
// database directly; the UI has no database handle at all.
//
// This is the pilot's enforcement point. The Supabase path enforces the same
// rules a second time in RLS + triggers (0016_purchasing_control.sql), because
// "the client is honest" is not a security model.
// ---------------------------------------------------------------------------

import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { getDb, inTransaction } from './db.ts';
import { renderPoPdf } from './pdf.ts';
import { authorize, availableActions, isApprover } from '../domain/roles.mjs';
import { transitionGuard, QUEUE_STATUSES } from '../domain/status.mjs';
import {
  estimatedTotalCents,
  formatQty,
  lineTotalCents,
  lineOutstandingQty,
  countOutstandingLines,
  parseMoney,
  parseQty,
  receiptGuard,
  replenishmentQty,
  stockAppliedQty,
  suggestedOrderQty,
} from '../domain/numbers.mjs';
import { stripRequestorFields, validateRequestDraft } from '../domain/validation.mjs';
import { composeDraft, draftGuard, EXTERNAL_SEND_ENABLED } from '../domain/email.mjs';
import { NOTIFICATION_AUDIENCE } from '../domain/activity.mjs';
import { formatPoNumber, validatePoConfig } from '../domain/po-number.mjs';

export class ServiceError extends Error {
  reason: string;
  details: unknown;
  constructor(reason: string, message: string, details: unknown = null) {
    super(message);
    this.name = 'ServiceError';
    this.reason = reason;
    this.details = details;
  }
}

export type Actor = {
  id: string;
  orgId: string;
  name: string;
  email: string;
  roles: string[];
  canApprove: boolean;
  isActive: boolean;
  isPrimaryApprover: boolean;
  isBackupApprover: boolean;
};

type Ctx = { db: DatabaseSync; now: string };

/** Injectable clock + database so the harness can drive this deterministically. */
export function context(db: DatabaseSync = getDb(), now: string = new Date().toISOString()): Ctx {
  return { db, now };
}

const uuid = () => randomUUID();

// --- actor + settings -------------------------------------------------------

export function loadActor(db: DatabaseSync, userId: string): Actor | null {
  const u = db.prepare('select * from users where id = ?').get(userId) as any;
  if (!u) return null;
  const roles = (db
    .prepare('select role_key from user_roles where user_id = ? order by role_key')
    .all(userId) as any[]).map((r) => r.role_key as string);
  return {
    id: u.id,
    orgId: u.org_id,
    name: u.full_name,
    email: u.email,
    roles,
    canApprove: Boolean(u.can_approve),
    isActive: Boolean(u.is_active),
    isPrimaryApprover: Boolean(u.is_primary_approver),
    isBackupApprover: Boolean(u.is_backup_approver),
  };
}

export function loadSettings(db: DatabaseSync, orgId: string) {
  const s = db.prepare('select * from system_settings where org_id = ?').get(orgId) as any;
  return {
    allowSelfApproval: Boolean(s?.allow_self_approval),
    externalSendEnabled: false as const,
    requireEmailReview: true as const,
    overdueGraceHours: Number(s?.overdue_grace_hours ?? 0),
    defaultDeliveryMethod: String(s?.default_delivery_method ?? 'DELIVERY'),
    poTemplateKey: String(s?.po_template_key ?? 'lippolis_default'),
  };
}

// --- audit ------------------------------------------------------------------

function nextSeq(db: DatabaseSync, requestId: string | null): number {
  const row = db
    .prepare('select coalesce(max(seq), 0) as m from purchase_activity_log where request_id is ?')
    .get(requestId) as any;
  return Number(row?.m ?? 0) + 1;
}

export function logActivity(
  ctx: Ctx,
  actor: Actor | null,
  args: {
    orgId: string;
    requestId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    previousValues?: unknown;
    newValues?: unknown;
    notes?: string | null;
  },
) {
  ctx.db
    .prepare(
      `insert into purchase_activity_log
         (id, org_id, request_id, actor_id, actor_name, action, entity_type, entity_id,
          previous_values, new_values, notes, at, seq)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      uuid(),
      args.orgId,
      args.requestId ?? null,
      actor?.id ?? null,
      actor?.name ?? 'system',
      args.action,
      args.entityType,
      args.entityId ?? null,
      args.previousValues === undefined ? null : JSON.stringify(args.previousValues),
      args.newValues === undefined ? null : JSON.stringify(args.newValues),
      args.notes ?? null,
      ctx.now,
      nextSeq(ctx.db, args.requestId ?? null),
    );
}

function notify(
  ctx: Ctx,
  args: { orgId: string; requestId: string | null; event: string; payload?: unknown },
) {
  const audience = (NOTIFICATION_AUDIENCE as Record<string, string[]>)[args.event] ?? [];
  const recipients = new Set<string>();

  for (const group of audience) {
    if (group === 'REQUESTOR_OF_RECORD') {
      if (args.requestId) {
        const r = ctx.db
          .prepare('select requestor_id from purchase_requests where id = ?')
          .get(args.requestId) as any;
        if (r?.requestor_id) recipients.add(r.requestor_id);
      }
      continue;
    }
    const rows = ctx.db
      .prepare(
        `select u.id from users u
           join user_roles ur on ur.user_id = u.id
          where u.org_id = ? and ur.role_key = ? and u.is_active = 1`,
      )
      .all(args.orgId, group) as any[];
    for (const row of rows) recipients.add(row.id);
  }

  const stmt = ctx.db.prepare(
    `insert into purchase_notifications (id, org_id, request_id, event, recipient_id, payload, created_at)
     values (?,?,?,?,?,?,?)`,
  );
  for (const recipient of recipients) {
    stmt.run(uuid(), args.orgId, args.requestId, args.event, recipient, JSON.stringify(args.payload ?? {}), ctx.now);
  }
}

// --- guards -----------------------------------------------------------------

function guard(ctx: Ctx, actor: Actor | null, permission: string, request: any = null): void {
  const settings = actor ? loadSettings(ctx.db, actor.orgId) : {};
  const decision = authorize(actor, permission, { request: toAuthzRequest(request), settings });
  if (decision.ok) return;
  if (actor) {
    logActivity(ctx, actor, {
      orgId: actor.orgId,
      requestId: request?.id ?? null,
      action: 'authz.denied',
      entityType: 'purchase_request',
      entityId: request?.id ?? null,
      newValues: { permission, reason: decision.reason },
      notes: decision.message,
    });
  }
  throw new ServiceError(decision.reason ?? 'denied', decision.message ?? 'not permitted');
}

function toAuthzRequest(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    requestorId: row.requestor_id,
    createdBy: row.created_by,
    status: row.status,
  };
}

function requireRequest(ctx: Ctx, actor: Actor, requestId: string): any {
  const row = ctx.db.prepare('select * from purchase_requests where id = ?').get(requestId) as any;
  if (!row) throw new ServiceError('not_found', `purchase request ${requestId} not found`);
  if (row.org_id !== actor.orgId) {
    // Cross-tenant reads look identical to "does not exist" from outside.
    throw new ServiceError('not_found', `purchase request ${requestId} not found`);
  }
  return row;
}

function transition(ctx: Ctx, actor: Actor, request: any, to: string, extra: Record<string, unknown> = {}) {
  const g = transitionGuard(request.status, to, transitionContext(ctx, request));
  if (!g.ok) throw new ServiceError(g.reason ?? 'illegal_transition', g.message ?? 'illegal transition');
  const sets = ['status = ?', 'updated_at = ?', 'updated_by = ?', 'version = version + 1'];
  const values: unknown[] = [to, ctx.now, actor.id];
  for (const [col, val] of Object.entries(extra)) {
    sets.push(`${col} = ?`);
    values.push(val as any);
  }
  values.push(request.id, request.version);
  const res = ctx.db
    .prepare(`update purchase_requests set ${sets.join(', ')} where id = ? and version = ?`)
    .run(...(values as any[]));
  if (Number(res.changes) !== 1) {
    throw new ServiceError('version_conflict', 'the request changed while you were working on it — reload and retry');
  }
  return to;
}

function transitionContext(ctx: Ctx, request: any) {
  const review = ctx.db.prepare('select * from purchase_reviews where request_id = ?').get(request.id) as any;
  const po = ctx.db.prepare('select * from purchase_orders where request_id = ?').get(request.id) as any;
  const reviewedDraft = ctx.db
    .prepare(
      `select 1 from purchase_email_drafts
        where request_id = ? and template_key = 'VENDOR_PURCHASE_ORDER'
          and reviewed_at is not null limit 1`,
    )
    .get(request.id) as any;
  const receipt = ctx.db.prepare('select 1 from purchase_receipts where request_id = ? limit 1').get(request.id) as any;
  return {
    hasReview: Boolean(review?.saved_at),
    hasPurchaseOrder: Boolean(po),
    hasReviewedEmailDraft: Boolean(reviewedDraft),
    hasReceipt: Boolean(receipt),
    outstandingLines: countOutstandingLines(orderProgress(ctx, request.id)),
  };
}

/** Ordered vs received, per line — the input to "is this request finished?". */
export function orderProgress(ctx: Ctx, requestId: string) {
  const po = ctx.db.prepare('select * from purchase_orders where request_id = ?').get(requestId) as any;
  if (!po) return [];
  const items = ctx.db
    .prepare('select * from purchase_order_items where purchase_order_id = ? order by line_no')
    .all(po.id) as any[];
  return items.map((item) => {
    const totals = ctx.db
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
}

// --- sequences --------------------------------------------------------------

/**
 * Allocate the next PO number. MUST be called inside a transaction that also
 * writes the purchase_orders row: the sequence bump and the row that consumes
 * it commit together or not at all.
 *
 * The `where next_value = ?` is a compare-and-set, so even if two callers
 * somehow read the same value, only one update lands.
 */
export function allocatePoNumber(ctx: Ctx, orgId: string): { poNumber: string; sequenceValue: number } {
  const seq = ctx.db.prepare('select * from po_number_sequences where org_id = ?').get(orgId) as any;
  if (!seq) throw new ServiceError('po_sequence_missing', 'no PO number sequence configured for this organization');
  const value = Number(seq.next_value);
  const res = ctx.db
    .prepare('update po_number_sequences set next_value = ?, updated_at = ? where org_id = ? and next_value = ?')
    .run(value + 1, ctx.now, orgId, value);
  if (Number(res.changes) !== 1) {
    throw new ServiceError('po_sequence_contended', 'PO number sequence was advanced concurrently; retry');
  }
  return {
    poNumber: formatPoNumber(value, { prefix: seq.prefix, padding: seq.padding, suffix: seq.suffix }),
    sequenceValue: value,
  };
}

function allocateRequestNumber(ctx: Ctx, orgId: string): string {
  const seq = ctx.db.prepare('select * from request_number_sequences where org_id = ?').get(orgId) as any;
  if (!seq) throw new ServiceError('request_sequence_missing', 'no request number sequence configured');
  const value = Number(seq.next_value);
  const res = ctx.db
    .prepare('update request_number_sequences set next_value = ?, updated_at = ? where org_id = ? and next_value = ?')
    .run(value + 1, ctx.now, orgId, value);
  if (Number(res.changes) !== 1) throw new ServiceError('request_sequence_contended', 'retry');
  return `${seq.prefix}${String(value).padStart(Number(seq.padding), '0')}${seq.suffix}`;
}

// --- requests ---------------------------------------------------------------

export type RequestDraft = {
  jobNumber: string;
  needByDate: string;
  needByTime: string;
  deliveryLocationId: string;
  deliveryMethod?: string;
  reason?: string;
  notes?: string;
  items: Array<{ description: string; qty: string | number; unit: string; stockNumber?: string; notes?: string }>;
};

export function createRequest(ctx: Ctx, actor: Actor, payload: RequestDraft & Record<string, unknown>) {
  guard(ctx, actor, 'request.create');

  // The field firewall: strip anything a requestor may not set, and RECORD the
  // attempt. An approver creating a request is bound by the same rule — vendor
  // and cost are decided in review, not intake, whoever is typing.
  const { cleaned, rejected } = stripRequestorFields(payload);
  const draft = cleaned as RequestDraft;

  const v = validateRequestDraft(draft);
  if (!v.ok) throw new ServiceError('validation_failed', 'the request is incomplete', v.errors);

  return inTransaction(ctx.db, () => {
    const requestNumber = allocateRequestNumber(ctx, actor.orgId);
    const id = uuid();
    ctx.db
      .prepare(
        `insert into purchase_requests
           (id, org_id, request_number, job_number, requestor_id, status, need_by_date, need_by_time,
            delivery_location_id, delivery_method, reason, notes, version, created_at, updated_at, created_by)
         values (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
      )
      .run(
        id,
        actor.orgId,
        requestNumber,
        String(draft.jobNumber).trim(),
        actor.id,
        'DRAFT',
        draft.needByDate,
        draft.needByTime,
        draft.deliveryLocationId,
        draft.deliveryMethod === 'PICKUP' ? 'PICKUP' : 'DELIVERY',
        draft.reason ?? null,
        draft.notes ?? null,
        ctx.now,
        ctx.now,
        actor.id,
      );

    draft.items.forEach((item, idx) => insertItem(ctx, actor, id, idx + 1, item));

    logActivity(ctx, actor, {
      orgId: actor.orgId,
      requestId: id,
      action: 'request.created',
      entityType: 'purchase_request',
      entityId: id,
      newValues: {
        requestNumber,
        jobNumber: draft.jobNumber,
        needByDate: draft.needByDate,
        needByTime: draft.needByTime,
        items: draft.items.length,
      },
    });
    if (rejected.length) {
      logActivity(ctx, actor, {
        orgId: actor.orgId,
        requestId: id,
        action: 'validation.rejected_fields',
        entityType: 'purchase_request',
        entityId: id,
        newValues: { fields: rejected },
        notes: 'purchasing fields are set in workshop review, not at intake',
      });
    }
    return { id, requestNumber, rejectedFields: rejected };
  });
}

function insertItem(ctx: Ctx, actor: Actor, requestId: string, lineNo: number, item: any) {
  const qty = parseQty(item.qty);
  if (!qty.ok) throw new ServiceError('validation_failed', `line ${lineNo}: ${qty.error}`);
  const id = uuid();
  ctx.db
    .prepare(
      `insert into purchase_request_items
         (id, request_id, line_no, description, requested_qty, unit, stock_number, notes, created_at, updated_at, created_by)
       values (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      requestId,
      lineNo,
      String(item.description).trim(),
      qty.value,
      String(item.unit).trim(),
      item.stockNumber ?? null,
      item.notes ?? null,
      ctx.now,
      ctx.now,
      actor.id,
    );
  return id;
}

export function updateRequest(ctx: Ctx, actor: Actor, requestId: string, payload: Record<string, unknown>) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'request.update.own', request);

  const { cleaned, rejected } = stripRequestorFields(payload);
  const draft = { ...toDraft(ctx, request), ...cleaned } as RequestDraft;
  const v = validateRequestDraft(draft);
  if (!v.ok) throw new ServiceError('validation_failed', 'the request is incomplete', v.errors);

  return inTransaction(ctx.db, () => {
    const before = toDraft(ctx, request);
    ctx.db
      .prepare(
        `update purchase_requests
            set job_number = ?, need_by_date = ?, need_by_time = ?, delivery_location_id = ?,
                delivery_method = ?, reason = ?, notes = ?, updated_at = ?, updated_by = ?, version = version + 1
          where id = ? and version = ?`,
      )
      .run(
        draft.jobNumber,
        draft.needByDate,
        draft.needByTime,
        draft.deliveryLocationId,
        draft.deliveryMethod === 'PICKUP' ? 'PICKUP' : 'DELIVERY',
        draft.reason ?? null,
        draft.notes ?? null,
        ctx.now,
        actor.id,
        requestId,
        request.version,
      );

    if (Array.isArray(cleaned.items)) {
      ctx.db.prepare('delete from purchase_request_items where request_id = ?').run(requestId);
      (cleaned.items as any[]).forEach((item, idx) => insertItem(ctx, actor, requestId, idx + 1, item));
    }

    logActivity(ctx, actor, {
      orgId: actor.orgId,
      requestId,
      action: 'request.updated',
      entityType: 'purchase_request',
      entityId: requestId,
      previousValues: before,
      newValues: draft,
    });
    if (rejected.length) {
      logActivity(ctx, actor, {
        orgId: actor.orgId,
        requestId,
        action: 'validation.rejected_fields',
        entityType: 'purchase_request',
        entityId: requestId,
        newValues: { fields: rejected },
      });
    }
    return { id: requestId };
  });
}

function toDraft(ctx: Ctx, request: any): RequestDraft {
  const items = ctx.db
    .prepare('select * from purchase_request_items where request_id = ? order by line_no')
    .all(request.id) as any[];
  return {
    jobNumber: request.job_number,
    needByDate: request.need_by_date,
    needByTime: request.need_by_time,
    deliveryLocationId: request.delivery_location_id,
    deliveryMethod: request.delivery_method,
    reason: request.reason ?? '',
    notes: request.notes ?? '',
    items: items.map((i) => ({
      description: i.description,
      qty: formatQty(i.requested_qty),
      unit: i.unit,
      stockNumber: i.stock_number ?? undefined,
      notes: i.notes ?? undefined,
    })),
  };
}

export function submitRequest(ctx: Ctx, actor: Actor, requestId: string) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'request.submit', request);

  const draft = toDraft(ctx, request);
  const v = validateRequestDraft(draft);
  if (!v.ok) throw new ServiceError('validation_failed', 'the request is incomplete', v.errors);

  return inTransaction(ctx.db, () => {
    transition(ctx, actor, request, 'SUBMITTED', { submitted_at: ctx.now });
    logActivity(ctx, actor, {
      orgId: actor.orgId,
      requestId,
      action: 'request.submitted',
      entityType: 'purchase_request',
      entityId: requestId,
      previousValues: { status: request.status },
      newValues: { status: 'SUBMITTED' },
    });
    // Submitted requests do not sit in SUBMITTED: they enter the workshop
    // queue in the same transaction, so there is no state in which a request is
    // submitted but nobody owns it.
    const submitted = { ...request, status: 'SUBMITTED', version: request.version + 1 };
    transition(ctx, actor, submitted, 'PENDING_WORKSHOP_REVIEW');
    notify(ctx, { orgId: actor.orgId, requestId, event: 'purchase_request.submitted', payload: { requestNumber: request.request_number } });
    notify(ctx, { orgId: actor.orgId, requestId, event: 'purchase_request.awaiting_review', payload: { requestNumber: request.request_number } });
    return { status: 'PENDING_WORKSHOP_REVIEW' };
  });
}

export function cancelRequest(ctx: Ctx, actor: Actor, requestId: string, reason: string) {
  const request = requireRequest(ctx, actor, requestId);
  const owns = request.requestor_id === actor.id || request.created_by === actor.id;
  guard(ctx, actor, owns ? 'request.cancel.own' : 'request.cancel.any', request);
  if (!reason || !reason.trim()) throw new ServiceError('reason_required', 'a cancellation must record a reason');

  return inTransaction(ctx.db, () => {
    transition(ctx, actor, request, 'CANCELLED', { cancelled_at: ctx.now, cancel_reason: reason.trim() });
    logActivity(ctx, actor, {
      orgId: actor.orgId,
      requestId,
      action: 'request.cancelled',
      entityType: 'purchase_request',
      entityId: requestId,
      previousValues: { status: request.status },
      newValues: { status: 'CANCELLED' },
      notes: reason.trim(),
    });
    return { status: 'CANCELLED' };
  });
}

export function addNote(ctx: Ctx, actor: Actor, requestId: string, note: string) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'request.note', request);
  if (!note.trim()) throw new ServiceError('validation_failed', 'a note cannot be empty');
  logActivity(ctx, actor, {
    orgId: actor.orgId,
    requestId,
    action: 'request.note_added',
    entityType: 'purchase_request',
    entityId: requestId,
    notes: note.trim(),
  });
  return { ok: true };
}

export function addAttachment(
  ctx: Ctx,
  actor: Actor,
  requestId: string,
  file: { filename: string; contentType?: string; dataBase64?: string; caption?: string; byteSize?: number },
) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'request.attach', request);
  const id = uuid();
  ctx.db
    .prepare(
      `insert into purchase_request_attachments
         (id, request_id, filename, content_type, byte_size, data_base64, caption, created_at, created_by)
       values (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      requestId,
      file.filename,
      file.contentType ?? null,
      file.byteSize ?? (file.dataBase64 ? Math.floor((file.dataBase64.length * 3) / 4) : null),
      file.dataBase64 ?? null,
      file.caption ?? null,
      ctx.now,
      actor.id,
    );
  logActivity(ctx, actor, {
    orgId: actor.orgId,
    requestId,
    action: 'request.attachment_added',
    entityType: 'purchase_request_attachment',
    entityId: id,
    newValues: { filename: file.filename },
  });
  return { id };
}

// --- workshop review --------------------------------------------------------

export type ReviewLineInput = {
  requestItemId: string;
  usableStock?: string | number;
  approvedQty?: string | number;
  finalOrderQty?: string | number;
  vendorId?: string | null;
  estimatedUnitCost?: string | number | null;
  substituteDescription?: string | null;
  expectedArrivalDate?: string | null;
  lineNotes?: string | null;
  overrideReason?: string | null;
};

/**
 * Save the workshop's numbers. This NEVER touches purchase_request_items — the
 * requestor's quantities stay exactly as submitted, forever. Everything the
 * workshop decides lands on purchase_review_items alongside them.
 */
export function saveReview(
  ctx: Ctx,
  actor: Actor,
  requestId: string,
  input: { workshopNotes?: string | null; lines: ReviewLineInput[] },
) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'review.record_stock', request);
  guard(ctx, actor, 'review.set_quantities', request);
  if (!QUEUE_STATUSES.includes(request.status)) {
    throw new ServiceError('not_in_review', `a ${request.status} request is not in the review queue`);
  }

  return inTransaction(ctx.db, () => {
    let review = ctx.db.prepare('select * from purchase_reviews where request_id = ?').get(requestId) as any;
    if (!review) {
      const id = uuid();
      ctx.db
        .prepare(
          `insert into purchase_reviews (id, request_id, reviewer_id, workshop_notes, started_at, created_at, updated_at)
           values (?,?,?,?,?,?,?)`,
        )
        .run(id, requestId, actor.id, input.workshopNotes ?? null, ctx.now, ctx.now, ctx.now);
      review = { id, request_id: requestId };
    }

    const items = ctx.db
      .prepare('select * from purchase_request_items where request_id = ? order by line_no')
      .all(requestId) as any[];
    const byId = new Map(items.map((i) => [i.id, i]));

    for (const line of input.lines) {
      const item = byId.get(line.requestItemId);
      if (!item) throw new ServiceError('unknown_line', `line ${line.requestItemId} is not on this request`);

      const stock = requiredQty(line.usableStock ?? 0, 'workshop stock');
      // Default: the workshop approves what the field asked for. Editable.
      const approved = line.approvedQty === undefined || line.approvedQty === null || line.approvedQty === ''
        ? Number(item.requested_qty)
        : requiredQty(line.approvedQty, 'approved quantity');
      const suggested = suggestedOrderQty(approved, stock);
      const finalQty = line.finalOrderQty === undefined || line.finalOrderQty === null || line.finalOrderQty === ''
        ? suggested
        : requiredQty(line.finalOrderQty, 'final order quantity');

      let unitCost: number | null = null;
      if (line.estimatedUnitCost !== undefined && line.estimatedUnitCost !== null && String(line.estimatedUnitCost) !== '') {
        const parsed = parseMoney(line.estimatedUnitCost);
        if (!parsed.ok) throw new ServiceError('validation_failed', `estimated unit cost: ${parsed.error}`);
        unitCost = parsed.value;
      }
      if (line.vendorId) guard(ctx, actor, 'review.set_vendor', request);
      if (unitCost !== null) guard(ctx, actor, 'review.set_cost', request);

      const total = lineTotalCents(unitCost ?? 0, finalQty);
      const prev = ctx.db
        .prepare('select * from purchase_review_items where review_id = ? and request_item_id = ?')
        .get(review.id, item.id) as any;

      const values = {
        usable_stock_qty: stock,
        approved_qty: approved,
        suggested_order_qty: suggested,
        final_order_qty: finalQty,
        stock_applied_qty: stockAppliedQty(approved, stock),
        replenishment_qty: replenishmentQty(finalQty, suggested),
        vendor_id: line.vendorId ?? null,
        estimated_unit_cost_cents: unitCost,
        estimated_line_total_cents: total,
        substitute_description: line.substituteDescription ?? null,
        expected_arrival_date: line.expectedArrivalDate ?? null,
        line_notes: line.lineNotes ?? null,
        override_reason: finalQty !== suggested ? (line.overrideReason ?? 'workshop override') : null,
      };

      if (prev) {
        ctx.db
          .prepare(
            `update purchase_review_items set
               usable_stock_qty=?, approved_qty=?, suggested_order_qty=?, final_order_qty=?,
               stock_applied_qty=?, replenishment_qty=?, vendor_id=?, estimated_unit_cost_cents=?,
               estimated_line_total_cents=?, substitute_description=?, expected_arrival_date=?,
               line_notes=?, override_reason=?, updated_at=?, updated_by=?
             where id = ?`,
          )
          .run(
            values.usable_stock_qty, values.approved_qty, values.suggested_order_qty, values.final_order_qty,
            values.stock_applied_qty, values.replenishment_qty, values.vendor_id, values.estimated_unit_cost_cents,
            values.estimated_line_total_cents, values.substitute_description, values.expected_arrival_date,
            values.line_notes, values.override_reason, ctx.now, actor.id, prev.id,
          );
      } else {
        ctx.db
          .prepare(
            `insert into purchase_review_items
               (id, review_id, request_item_id, usable_stock_qty, approved_qty, suggested_order_qty,
                final_order_qty, stock_applied_qty, replenishment_qty, vendor_id, estimated_unit_cost_cents,
                estimated_line_total_cents, substitute_description, expected_arrival_date, line_notes,
                override_reason, created_at, updated_at, updated_by)
             values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            uuid(), review.id, item.id, values.usable_stock_qty, values.approved_qty, values.suggested_order_qty,
            values.final_order_qty, values.stock_applied_qty, values.replenishment_qty, values.vendor_id,
            values.estimated_unit_cost_cents, values.estimated_line_total_cents, values.substitute_description,
            values.expected_arrival_date, values.line_notes, values.override_reason, ctx.now, ctx.now, actor.id,
          );
      }

      // The stock reading is evidence in its own right: it is preserved with
      // the request even if the review is edited afterwards.
      ctx.db
        .prepare(
          `insert into inventory_observations
             (id, org_id, request_id, request_item_id, item_description, observed_qty, unit,
              observed_at, observed_by, notes, created_at)
           values (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(uuid(), actor.orgId, requestId, item.id, item.description, stock, item.unit, ctx.now, actor.id, line.lineNotes ?? null, ctx.now);

      logActivity(ctx, actor, {
        orgId: actor.orgId,
        requestId,
        action: 'review.stock_recorded',
        entityType: 'purchase_review_item',
        entityId: item.id,
        previousValues: prev
          ? {
              usableStock: prev.usable_stock_qty,
              approvedQty: prev.approved_qty,
              finalOrderQty: prev.final_order_qty,
              vendorId: prev.vendor_id,
              unitCostCents: prev.estimated_unit_cost_cents,
            }
          : null,
        newValues: {
          usableStock: values.usable_stock_qty,
          approvedQty: values.approved_qty,
          suggestedOrderQty: values.suggested_order_qty,
          finalOrderQty: values.final_order_qty,
          vendorId: values.vendor_id,
          unitCostCents: values.estimated_unit_cost_cents,
          lineTotalCents: values.estimated_line_total_cents,
        },
        notes: values.override_reason,
      });
      if (prev && prev.vendor_id !== values.vendor_id && values.vendor_id) {
        const vendor = ctx.db.prepare('select name from vendors where id = ?').get(values.vendor_id) as any;
        logActivity(ctx, actor, {
          orgId: actor.orgId, requestId, action: 'review.vendor_selected',
          entityType: 'purchase_review_item', entityId: item.id,
          newValues: { vendorId: values.vendor_id, vendorName: vendor?.name },
        });
      }
    }

    ctx.db
      .prepare('update purchase_reviews set workshop_notes = ?, saved_at = ?, updated_at = ?, reviewer_id = ? where id = ?')
      .run(input.workshopNotes ?? null, ctx.now, ctx.now, actor.id, review.id);

    const totals = recomputeRequestTotals(ctx, requestId);
    logActivity(ctx, actor, {
      orgId: actor.orgId, requestId, action: 'review.saved',
      entityType: 'purchase_review', entityId: review.id,
      newValues: { estimatedTotalCents: totals.estimatedTotalCents, vendorId: totals.vendorId },
    });
    return totals;
  });
}

function requiredQty(value: string | number, label: string): number {
  const parsed = parseQty(value === '' ? '0' : value);
  if (!parsed.ok) throw new ServiceError('validation_failed', `${label}: ${parsed.error}`);
  return parsed.value;
}

function recomputeRequestTotals(ctx: Ctx, requestId: string) {
  const lines = reviewLines(ctx, requestId);
  const total = estimatedTotalCents(lines);
  const vendorIds = [...new Set(lines.filter((l) => l.finalOrderQty > 0).map((l) => l.vendorId).filter(Boolean))];
  const vendorId = vendorIds.length === 1 ? (vendorIds[0] as string) : null;
  const arrivals = lines.map((l) => l.expectedArrivalDate).filter(Boolean).sort();
  ctx.db
    .prepare('update purchase_requests set estimated_total_cents = ?, vendor_id = ?, expected_arrival_date = ?, updated_at = ? where id = ?')
    .run(total, vendorId, arrivals[arrivals.length - 1] ?? null, ctx.now, requestId);
  return { estimatedTotalCents: total, vendorId, vendorCount: vendorIds.length };
}

export function reviewLines(ctx: Ctx, requestId: string) {
  return (
    ctx.db
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
}

// --- decisions --------------------------------------------------------------

export function decide(
  ctx: Ctx,
  actor: Actor,
  requestId: string,
  decision: 'APPROVE' | 'REJECT' | 'CLARIFY',
  input: { notes?: string; reason?: string; question?: string } = {},
) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'review.decide', request);
  if (!QUEUE_STATUSES.includes(request.status)) {
    throw new ServiceError('not_in_review', `a ${request.status} request is not awaiting a decision`);
  }

  return inTransaction(ctx.db, () => {
    const changes = changesFromOriginal(ctx, requestId);

    if (decision === 'APPROVE') {
      const lines = reviewLines(ctx, requestId);
      if (!lines.some((l) => l.finalOrderQty > 0)) {
        throw new ServiceError('nothing_to_order', 'approve with at least one line to order, or reject the request');
      }
      const missingVendor = lines.filter((l) => l.finalOrderQty > 0 && !l.vendorId);
      if (missingVendor.length) throw new ServiceError('vendor_required', 'every ordered line needs a vendor');
      const missingCost = lines.filter((l) => l.finalOrderQty > 0 && l.estimatedUnitCostCents === null);
      if (missingCost.length) throw new ServiceError('cost_required', 'every ordered line needs an estimated unit cost');

      transition(ctx, actor, request, 'APPROVED', {
        approver_id: actor.id,
        decided_at: ctx.now,
        decision_notes: input.notes ?? null,
      });
      recordApproval(ctx, actor, requestId, 'APPROVED', input.notes ?? null, null, changes);
      // Stock the workshop is giving up to this job is an inventory movement
      // and gets its own auditable row — inventory never changes silently.
      for (const line of lines.filter((l) => l.stockAppliedQty > 0)) {
        recordAdjustment(ctx, actor, requestId, line.requestItemId, line.description, -line.stockAppliedQty, line.unit, 'STOCK_APPLIED');
      }
      logActivity(ctx, actor, {
        orgId: actor.orgId, requestId, action: 'decision.approved',
        entityType: 'purchase_request', entityId: requestId,
        previousValues: { status: request.status }, newValues: { status: 'APPROVED', changes },
        notes: input.notes ?? null,
      });
      notify(ctx, { orgId: actor.orgId, requestId, event: 'purchase_request.approved', payload: { requestNumber: request.request_number } });
      return { status: 'APPROVED' };
    }

    if (decision === 'REJECT') {
      const reason = (input.reason ?? '').trim();
      if (!reason) throw new ServiceError('reason_required', 'a rejection must record a reason');
      transition(ctx, actor, request, 'REJECTED', {
        approver_id: actor.id, decided_at: ctx.now,
        decision_notes: input.notes ?? null, rejection_reason: reason,
      });
      recordApproval(ctx, actor, requestId, 'REJECTED', input.notes ?? null, reason, changes);
      logActivity(ctx, actor, {
        orgId: actor.orgId, requestId, action: 'decision.rejected',
        entityType: 'purchase_request', entityId: requestId,
        previousValues: { status: request.status }, newValues: { status: 'REJECTED' }, notes: reason,
      });
      notify(ctx, { orgId: actor.orgId, requestId, event: 'purchase_request.rejected', payload: { reason } });
      return { status: 'REJECTED' };
    }

    const question = (input.question ?? '').trim();
    if (!question) throw new ServiceError('reason_required', 'a clarification must ask something');
    transition(ctx, actor, request, 'CLARIFICATION_REQUESTED', {
      approver_id: actor.id, clarification_question: question, clarification_answer: null,
    });
    recordApproval(ctx, actor, requestId, 'CLARIFICATION_REQUESTED', input.notes ?? null, question, changes);
    logActivity(ctx, actor, {
      orgId: actor.orgId, requestId, action: 'clarification.requested',
      entityType: 'purchase_request', entityId: requestId,
      previousValues: { status: request.status }, newValues: { status: 'CLARIFICATION_REQUESTED' }, notes: question,
    });
    notify(ctx, { orgId: actor.orgId, requestId, event: 'purchase_request.clarification_requested', payload: { question } });
    return { status: 'CLARIFICATION_REQUESTED' };
  });
}

function recordApproval(
  ctx: Ctx, actor: Actor, requestId: string,
  decision: string, notes: string | null, reason: string | null, changes: unknown,
) {
  ctx.db
    .prepare(
      `insert into purchase_approvals (id, request_id, approver_id, decision, decided_at, notes, reason, changes_json, created_at)
       values (?,?,?,?,?,?,?,?,?)`,
    )
    .run(uuid(), requestId, actor.id, decision, ctx.now, notes, reason, JSON.stringify(changes ?? []), ctx.now);
}

/** What the workshop changed relative to what the field asked for. */
export function changesFromOriginal(ctx: Ctx, requestId: string) {
  return reviewLines(ctx, requestId)
    .filter((l) => l.requestedQty !== l.finalOrderQty || l.substituteDescription)
    .map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      requestedQty: l.requestedQty,
      approvedQty: l.approvedQty,
      usableStockQty: l.usableStockQty,
      suggestedOrderQty: l.suggestedOrderQty,
      finalOrderQty: l.finalOrderQty,
      substituteDescription: l.substituteDescription,
      overrideReason: l.overrideReason,
    }));
}

export function answerClarification(ctx: Ctx, actor: Actor, requestId: string, answer: string) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'request.respond_clarification', request);
  if (request.status !== 'CLARIFICATION_REQUESTED') {
    throw new ServiceError('not_in_clarification', 'this request is not waiting on an answer');
  }
  if (!answer.trim()) throw new ServiceError('validation_failed', 'an answer cannot be empty');

  return inTransaction(ctx.db, () => {
    transition(ctx, actor, request, 'RESUBMITTED', { clarification_answer: answer.trim() });
    logActivity(ctx, actor, {
      orgId: actor.orgId, requestId, action: 'clarification.answered',
      entityType: 'purchase_request', entityId: requestId, notes: answer.trim(),
    });
    const resubmitted = { ...request, status: 'RESUBMITTED', version: request.version + 1 };
    // Back into the queue in the same transaction: an answered question never
    // waits for someone to remember to re-queue it.
    transition(ctx, actor, resubmitted, 'PENDING_WORKSHOP_REVIEW');
    notify(ctx, { orgId: actor.orgId, requestId, event: 'purchase_request.awaiting_review', payload: {} });
    return { status: 'PENDING_WORKSHOP_REVIEW' };
  });
}

// --- purchase order ---------------------------------------------------------

export function generatePurchaseOrder(ctx: Ctx, actor: Actor, requestId: string) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'po.generate', request);

  // Idempotency first: a request that already has a purchase order returns the
  // same permanent number, whatever it has done since. Asking twice must never
  // burn a sequence value and must never be an error.
  const already = ctx.db.prepare('select * from purchase_orders where request_id = ?').get(requestId) as any;
  if (already) return { poNumber: already.po_number, purchaseOrderId: already.id, reused: true };

  if (request.status !== 'APPROVED') {
    throw new ServiceError('po_before_approval', `a ${request.status} request cannot produce a purchase order`);
  }

  return inTransaction(ctx.db, () => {

    const lines = reviewLines(ctx, requestId).filter((l) => l.finalOrderQty > 0);
    if (!lines.length) throw new ServiceError('nothing_to_order', 'no line has a final order quantity');
    const vendorIds = [...new Set(lines.map((l) => l.vendorId))];
    if (vendorIds.length !== 1 || !vendorIds[0]) {
      throw new ServiceError('single_vendor_required', 'this milestone issues one purchase order to one vendor');
    }

    const { poNumber, sequenceValue } = allocatePoNumber(ctx, actor.orgId);
    const contact = ctx.db
      .prepare('select * from vendor_contacts where vendor_id = ? order by is_primary desc limit 1')
      .get(vendorIds[0]) as any;
    const total = lines.reduce((t, l) => t + lineTotalCents(l.estimatedUnitCostCents, l.finalOrderQty), 0);
    const poId = uuid();

    ctx.db
      .prepare(
        `insert into purchase_orders
           (id, org_id, request_id, po_number, sequence_value, vendor_id, vendor_contact_id, job_number,
            approver_id, delivery_location_id, delivery_method, need_by_date, need_by_time,
            estimated_total_cents, notes, status, generated_at, generated_by, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        poId, actor.orgId, requestId, poNumber, sequenceValue, vendorIds[0], contact?.id ?? null,
        request.job_number, request.approver_id ?? actor.id, request.delivery_location_id,
        request.delivery_method, request.need_by_date, request.need_by_time, total,
        request.decision_notes ?? null, 'ISSUED', ctx.now, actor.id, ctx.now, ctx.now,
      );

    lines.forEach((line, idx) => {
      ctx.db
        .prepare(
          `insert into purchase_order_items
             (id, purchase_order_id, line_no, request_item_id, description, substitute_description,
              order_qty, unit, unit_cost_cents, line_total_cents, expected_arrival_date, created_at)
           values (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          uuid(), poId, idx + 1, line.requestItemId, line.description, line.substituteDescription,
          line.finalOrderQty, line.unit, line.estimatedUnitCostCents ?? 0,
          lineTotalCents(line.estimatedUnitCostCents, line.finalOrderQty), line.expectedArrivalDate, ctx.now,
        );
    });

    transition(ctx, actor, request, 'PO_GENERATED');
    logActivity(ctx, actor, {
      orgId: actor.orgId, requestId, action: 'po.generated',
      entityType: 'purchase_order', entityId: poId,
      newValues: { poNumber, vendorId: vendorIds[0], estimatedTotalCents: total, lines: lines.length },
    });

    const doc = generatePoDocument(ctx, actor, poId);
    notify(ctx, { orgId: actor.orgId, requestId, event: 'purchase_order.generated', payload: { poNumber } });
    return { poNumber, purchaseOrderId: poId, documentId: doc.id, reused: false };
  });
}

export function generatePoDocument(ctx: Ctx, actor: Actor, purchaseOrderId: string) {
  const po = ctx.db.prepare('select * from purchase_orders where id = ?').get(purchaseOrderId) as any;
  if (!po) throw new ServiceError('not_found', 'purchase order not found');
  const view = purchaseOrderView(ctx, purchaseOrderId);
  const pdf = renderPoPdf(view);
  const base64 = pdf.toString('base64');
  const id = uuid();
  ctx.db
    .prepare(
      `insert into purchase_order_documents
         (id, purchase_order_id, kind, filename, content_type, byte_size, data_base64, sha256,
          generated_at, generated_by, template_key)
       values (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id, purchaseOrderId, 'PDF', `${po.po_number}.pdf`, 'application/pdf', pdf.byteLength, base64,
      createHash('sha256').update(pdf).digest('hex'), ctx.now, actor.id,
      loadSettings(ctx.db, po.org_id).poTemplateKey,
    );
  logActivity(ctx, actor, {
    orgId: po.org_id, requestId: po.request_id, action: 'po.document_generated',
    entityType: 'purchase_order_document', entityId: id,
    newValues: { filename: `${po.po_number}.pdf`, bytes: pdf.byteLength },
  });
  return { id, filename: `${po.po_number}.pdf`, byteSize: pdf.byteLength };
}

/** Everything the PO template and the vendor email need, in one shape. */
export function purchaseOrderView(ctx: Ctx, purchaseOrderId: string) {
  const po = ctx.db.prepare('select * from purchase_orders where id = ?').get(purchaseOrderId) as any;
  if (!po) throw new ServiceError('not_found', 'purchase order not found');
  const org = ctx.db.prepare('select * from orgs where id = ?').get(po.org_id) as any;
  const vendor = ctx.db.prepare('select * from vendors where id = ?').get(po.vendor_id) as any;
  const contact = po.vendor_contact_id
    ? (ctx.db.prepare('select * from vendor_contacts where id = ?').get(po.vendor_contact_id) as any)
    : null;
  const location = ctx.db.prepare('select * from delivery_locations where id = ?').get(po.delivery_location_id) as any;
  const approver = ctx.db.prepare('select * from users where id = ?').get(po.approver_id) as any;
  const request = ctx.db.prepare('select * from purchase_requests where id = ?').get(po.request_id) as any;
  const requestor = ctx.db.prepare('select * from users where id = ?').get(request.requestor_id) as any;
  const items = ctx.db
    .prepare('select * from purchase_order_items where purchase_order_id = ? order by line_no')
    .all(purchaseOrderId) as any[];

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
}

// --- email drafts -----------------------------------------------------------

export function generateVendorEmailDraft(ctx: Ctx, actor: Actor, requestId: string) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'email.draft', request);
  const po = ctx.db.prepare('select * from purchase_orders where request_id = ?').get(requestId) as any;
  if (!po) throw new ServiceError('email_before_po', 'a vendor email needs a purchase order first');

  return inTransaction(ctx.db, () => {
    const view = purchaseOrderView(ctx, po.id);
    const doc = ctx.db
      .prepare('select * from purchase_order_documents where purchase_order_id = ? order by generated_at desc limit 1')
      .get(po.id) as any;
    const template = ctx.db
      .prepare('select * from email_templates where org_id = ? and template_key = ? and is_active = 1')
      .get(actor.orgId, 'VENDOR_PURCHASE_ORDER') as any;

    const draftKey = `po:${po.po_number}:vendor`;
    const existing = ctx.db
      .prepare('select * from purchase_email_drafts where org_id = ? and draft_key = ?')
      .get(actor.orgId, draftKey) as any;
    if (existing) {
      if (request.status === 'PO_GENERATED') transition(ctx, actor, request, 'EMAIL_DRAFTED');
      return { id: existing.id, reused: true };
    }

    const composed = composeDraft(
      'VENDOR_PURCHASE_ORDER',
      {
        ...view,
        sender: { id: actor.id, name: actor.name, email: actor.email },
        to: [view.vendorContact?.email].filter(Boolean),
        attachments: doc ? [{ filename: doc.filename, contentType: doc.content_type, documentId: doc.id }] : [],
        draftKey,
      },
      { template: template ? { subject: template.subject, body: template.body } : null },
    );

    const id = uuid();
    ctx.db
      .prepare(
        `insert into purchase_email_drafts
           (id, org_id, request_id, purchase_order_id, template_key, status, subject, body,
            to_addrs, cc_addrs, attachments, draft_key, generated_at, generated_by,
            external_send_enabled, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, actor.orgId, requestId, po.id, 'VENDOR_PURCHASE_ORDER', 'GENERATED',
        composed.subject, composed.body, JSON.stringify(composed.to), JSON.stringify(composed.cc),
        JSON.stringify(composed.attachments), draftKey, ctx.now, actor.id,
        EXTERNAL_SEND_ENABLED ? 1 : 0, ctx.now, ctx.now,
      );

    transition(ctx, actor, request, 'EMAIL_DRAFTED');
    logActivity(ctx, actor, {
      orgId: actor.orgId, requestId, action: 'email.draft_generated',
      entityType: 'purchase_email_draft', entityId: id,
      newValues: { type: 'VENDOR_PURCHASE_ORDER', to: composed.to, poNumber: po.po_number },
    });
    notify(ctx, { orgId: actor.orgId, requestId, event: 'purchase_email.draft_ready', payload: { poNumber: po.po_number } });
    return { id, reused: false };
  });
}

export function updateEmailDraft(ctx: Ctx, actor: Actor, draftId: string, patch: { subject?: string; body?: string }) {
  const draft = ctx.db.prepare('select * from purchase_email_drafts where id = ?').get(draftId) as any;
  if (!draft || draft.org_id !== actor.orgId) throw new ServiceError('not_found', 'draft not found');
  const request = requireRequest(ctx, actor, draft.request_id);
  guard(ctx, actor, 'email.draft', request);
  if (draft.status !== 'GENERATED') {
    throw new ServiceError('draft_frozen', 'a reviewed draft is frozen — the review refers to these words');
  }
  ctx.db
    .prepare('update purchase_email_drafts set subject = ?, body = ?, updated_at = ? where id = ?')
    .run(patch.subject ?? draft.subject, patch.body ?? draft.body, ctx.now, draftId);
  return { ok: true };
}

export function advanceEmailDraft(
  ctx: Ctx, actor: Actor, draftId: string,
  to: 'REVIEWED' | 'APPROVED_TO_SEND' | 'SENT' | 'CANCELLED' | 'FAILED',
  notes?: string,
) {
  const draft = ctx.db.prepare('select * from purchase_email_drafts where id = ?').get(draftId) as any;
  if (!draft || draft.org_id !== actor.orgId) throw new ServiceError('not_found', 'draft not found');
  const request = requireRequest(ctx, actor, draft.request_id);
  guard(ctx, actor, 'email.review', request);

  const g = draftGuard(draft.status, to, {
    reviewedBy: draft.reviewed_by,
    markedBy: to === 'SENT' ? actor.id : null,
  });
  if (!g.ok) throw new ServiceError(g.reason ?? 'illegal_transition', g.message ?? 'illegal draft transition');

  const columns: Record<string, unknown> = { status: to, updated_at: ctx.now };
  if (to === 'REVIEWED') { columns.reviewed_at = ctx.now; columns.reviewed_by = actor.id; }
  if (to === 'APPROVED_TO_SEND') { columns.approved_to_send_at = ctx.now; columns.approved_to_send_by = actor.id; }
  // SENT means: a human copied this into their own mail client and sent it.
  // Nothing in this codebase transmits anything.
  if (to === 'SENT') { columns.sent_at = ctx.now; columns.sent_marked_by = actor.id; }
  if (to === 'CANCELLED') columns.cancelled_at = ctx.now;
  if (to === 'FAILED') columns.failure_reason = notes ?? 'unspecified';

  const sets = Object.keys(columns).map((c) => `${c} = ?`).join(', ');
  ctx.db.prepare(`update purchase_email_drafts set ${sets} where id = ?`).run(...(Object.values(columns) as any[]), draftId);

  const action =
    to === 'REVIEWED' ? 'email.draft_reviewed'
    : to === 'APPROVED_TO_SEND' ? 'email.draft_approved_to_send'
    : to === 'SENT' ? 'email.marked_sent'
    : 'email.draft_generated';
  logActivity(ctx, actor, {
    orgId: actor.orgId, requestId: draft.request_id, action,
    entityType: 'purchase_email_draft', entityId: draftId,
    previousValues: { status: draft.status }, newValues: { status: to }, notes: notes ?? null,
  });
  return { status: to };
}

// --- ordering, tracking, receiving -----------------------------------------

export function markOrdered(ctx: Ctx, actor: Actor, requestId: string, input: { orderedAt?: string; notes?: string } = {}) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'order.mark_ordered', request);
  return inTransaction(ctx.db, () => {
    transition(ctx, actor, request, 'ORDERED', { ordered_at: input.orderedAt ?? ctx.now });
    logActivity(ctx, actor, {
      orgId: actor.orgId, requestId, action: 'order.placed',
      entityType: 'purchase_request', entityId: requestId,
      previousValues: { status: request.status }, newValues: { status: 'ORDERED' }, notes: input.notes ?? null,
    });
    return { status: 'ORDERED' };
  });
}

export function updateTracking(
  ctx: Ctx, actor: Actor, requestId: string,
  input: { trackingNumber?: string; carrier?: string; expectedArrivalDate?: string },
) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'order.track', request);
  ctx.db
    .prepare('update purchase_requests set tracking_number = ?, tracking_carrier = ?, expected_arrival_date = ?, updated_at = ?, updated_by = ? where id = ?')
    .run(
      input.trackingNumber ?? request.tracking_number,
      input.carrier ?? request.tracking_carrier,
      input.expectedArrivalDate ?? request.expected_arrival_date,
      ctx.now, actor.id, requestId,
    );
  logActivity(ctx, actor, {
    orgId: actor.orgId, requestId, action: 'order.tracking_updated',
    entityType: 'purchase_request', entityId: requestId,
    previousValues: {
      trackingNumber: request.tracking_number, carrier: request.tracking_carrier,
      expectedArrivalDate: request.expected_arrival_date,
    },
    newValues: input,
  });
  return { ok: true };
}

export type ReceiptLineInput = {
  purchaseOrderItemId: string;
  receivedQty?: string | number;
  damagedQty?: string | number;
  backorderedQty?: string | number;
  writtenOffQty?: string | number;
  overrideReason?: string | null;
  notes?: string | null;
};

export function recordReceipt(
  ctx: Ctx, actor: Actor, requestId: string,
  input: {
    receivedDate: string; packingSlipNumber?: string; notes?: string;
    lines: ReceiptLineInput[]; attachments?: Array<{ filename: string; dataBase64?: string; caption?: string }>;
  },
) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'receiving.record', request);
  if (!['ORDERED', 'PARTIALLY_RECEIVED'].includes(request.status)) {
    throw new ServiceError('not_receivable', `a ${request.status} request is not awaiting delivery`);
  }
  if (!input.receivedDate) throw new ServiceError('validation_failed', 'a receipt needs the date it arrived');

  return inTransaction(ctx.db, () => {
    const po = ctx.db.prepare('select * from purchase_orders where request_id = ?').get(requestId) as any;
    const progress = new Map(orderProgress(ctx, requestId).map((p) => [p.purchaseOrderItemId, p]));
    const receiptId = uuid();

    ctx.db
      .prepare(
        `insert into purchase_receipts
           (id, org_id, request_id, purchase_order_id, received_date, received_by, packing_slip_number, notes, is_final, created_at)
         values (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(receiptId, actor.orgId, requestId, po?.id ?? null, input.receivedDate, actor.id, input.packingSlipNumber ?? null, input.notes ?? null, 0, ctx.now);

    for (const line of input.lines) {
      const state = progress.get(line.purchaseOrderItemId);
      if (!state) throw new ServiceError('unknown_line', 'that line is not on this purchase order');
      const received = optionalQty(line.receivedQty);
      const damaged = optionalQty(line.damagedQty);
      const backordered = optionalQty(line.backorderedQty);
      const writtenOff = optionalQty(line.writtenOffQty);
      if (received + damaged + backordered + writtenOff === 0) continue;

      if (received > 0) {
        const check = receiptGuard({
          orderedQty: state.finalOrderQty,
          alreadyReceivedQty: state.receivedQty + state.damagedQty + state.writtenOffQty,
          incomingQty: received,
          override: Boolean(line.overrideReason),
        });
        if (!check.ok) throw new ServiceError(check.reason ?? 'over_receipt', check.message ?? 'receipt refused');
      }

      ctx.db
        .prepare(
          `insert into purchase_receipt_items
             (id, receipt_id, purchase_order_item_id, received_qty, damaged_qty, backordered_qty,
              written_off_qty, over_receipt_override, override_reason, notes, created_at)
           values (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          uuid(), receiptId, line.purchaseOrderItemId, received, damaged, backordered, writtenOff,
          line.overrideReason ? 1 : 0, line.overrideReason ?? null, line.notes ?? null, ctx.now,
        );

      if (received > 0) {
        recordAdjustment(ctx, actor, requestId, state.requestItemId, state.description, received, state.unit, 'RECEIVED');
      }
      if (damaged > 0) {
        recordAdjustment(ctx, actor, requestId, state.requestItemId, state.description, -damaged, state.unit, 'DAMAGE');
      }
    }

    for (const file of input.attachments ?? []) {
      ctx.db
        .prepare(
          `insert into purchase_receipt_attachments (id, receipt_id, filename, content_type, byte_size, data_base64, caption, created_at, created_by)
           values (?,?,?,?,?,?,?,?,?)`,
        )
        .run(uuid(), receiptId, file.filename, null, file.dataBase64 ? Math.floor((file.dataBase64.length * 3) / 4) : null, file.dataBase64 ?? null, file.caption ?? null, ctx.now, actor.id);
    }

    const after = orderProgress(ctx, requestId);
    const outstanding = countOutstandingLines(after);
    const fresh = ctx.db.prepare('select * from purchase_requests where id = ?').get(requestId) as any;

    if (outstanding === 0) {
      transition(ctx, actor, fresh, 'RECEIVED', { received_at: ctx.now });
      ctx.db.prepare('update purchase_receipts set is_final = 1 where id = ?').run(receiptId);
      logActivity(ctx, actor, {
        orgId: actor.orgId, requestId, action: 'receipt.completed',
        entityType: 'purchase_receipt', entityId: receiptId,
        newValues: { receivedDate: input.receivedDate, outstandingLines: 0 },
      });
      notify(ctx, { orgId: actor.orgId, requestId, event: 'purchase_receipt.completed', payload: {} });
      notify(ctx, { orgId: actor.orgId, requestId, event: 'purchase_material.ready_for_pickup', payload: {} });
    } else {
      if (fresh.status !== 'PARTIALLY_RECEIVED') transition(ctx, actor, fresh, 'PARTIALLY_RECEIVED');
      logActivity(ctx, actor, {
        orgId: actor.orgId, requestId, action: 'receipt.partial',
        entityType: 'purchase_receipt', entityId: receiptId,
        newValues: { receivedDate: input.receivedDate, outstandingLines: outstanding },
      });
      notify(ctx, { orgId: actor.orgId, requestId, event: 'purchase_receipt.partial', payload: { outstandingLines: outstanding } });
    }

    logActivity(ctx, actor, {
      orgId: actor.orgId, requestId, action: 'receipt.recorded',
      entityType: 'purchase_receipt', entityId: receiptId,
      newValues: { lines: input.lines.length, packingSlip: input.packingSlipNumber ?? null },
    });
    return { receiptId, outstandingLines: outstanding };
  });
}

function optionalQty(value: string | number | undefined | null): number {
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const parsed = parseQty(value);
  if (!parsed.ok) throw new ServiceError('validation_failed', parsed.error as string);
  return parsed.value;
}

function recordAdjustment(
  ctx: Ctx, actor: Actor, requestId: string, requestItemId: string | null,
  description: string, delta: number, unit: string, reason: string,
) {
  ctx.db
    .prepare(
      `insert into inventory_adjustments
         (id, org_id, request_id, request_item_id, item_description, delta_qty, unit, reason, adjusted_at, adjusted_by, created_at)
       values (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(uuid(), actor.orgId, requestId, requestItemId, description, delta, unit, reason, ctx.now, actor.id, ctx.now);
  logActivity(ctx, actor, {
    orgId: actor.orgId, requestId, action: 'inventory.adjusted',
    entityType: 'inventory_adjustment', entityId: requestItemId,
    newValues: { description, delta, unit, reason },
  });
}

export function completeRequest(ctx: Ctx, actor: Actor, requestId: string, notes?: string) {
  const request = requireRequest(ctx, actor, requestId);
  guard(ctx, actor, 'request.complete', request);
  return inTransaction(ctx.db, () => {
    transition(ctx, actor, request, 'COMPLETED', { completed_at: ctx.now });
    logActivity(ctx, actor, {
      orgId: actor.orgId, requestId, action: 'request.completed',
      entityType: 'purchase_request', entityId: requestId,
      previousValues: { status: request.status }, newValues: { status: 'COMPLETED' }, notes: notes ?? null,
    });
    return { status: 'COMPLETED' };
  });
}

// --- reads ------------------------------------------------------------------

export function listRequests(ctx: Ctx, actor: Actor) {
  const all = authorize(actor, 'request.read.all', {}).ok;
  const rows = (all
    ? ctx.db.prepare(
        `select r.*, u.full_name as requestor_name, a.full_name as approver_name, v.name as vendor_name,
                p.po_number,
                (select coalesce(sum(i.requested_qty), 0) from purchase_request_items i
                  where i.request_id = r.id) as requested_qty,
                (select coalesce(sum(ri.usable_stock_qty), 0) from purchase_review_items ri
                   join purchase_reviews rv on rv.id = ri.review_id where rv.request_id = r.id) as stock_qty,
                (select coalesce(sum(ri.final_order_qty), 0) from purchase_review_items ri
                   join purchase_reviews rv on rv.id = ri.review_id where rv.request_id = r.id) as final_qty
           from purchase_requests r
           join users u on u.id = r.requestor_id
           left join users a on a.id = r.approver_id
           left join vendors v on v.id = r.vendor_id
           left join purchase_orders p on p.request_id = r.id
          where r.org_id = ? order by r.created_at desc`,
      ).all(actor.orgId)
    : ctx.db.prepare(
        `select r.*, u.full_name as requestor_name, a.full_name as approver_name, v.name as vendor_name,
                p.po_number,
                (select coalesce(sum(i.requested_qty), 0) from purchase_request_items i
                  where i.request_id = r.id) as requested_qty,
                (select coalesce(sum(ri.usable_stock_qty), 0) from purchase_review_items ri
                   join purchase_reviews rv on rv.id = ri.review_id where rv.request_id = r.id) as stock_qty,
                (select coalesce(sum(ri.final_order_qty), 0) from purchase_review_items ri
                   join purchase_reviews rv on rv.id = ri.review_id where rv.request_id = r.id) as final_qty
           from purchase_requests r
           join users u on u.id = r.requestor_id
           left join users a on a.id = r.approver_id
           left join vendors v on v.id = r.vendor_id
           left join purchase_orders p on p.request_id = r.id
          where r.org_id = ? and (r.requestor_id = ? or r.created_by = ?)
          order by r.created_at desc`,
      ).all(actor.orgId, actor.id, actor.id)) as any[];

  return rows.map((r) => ({
    id: r.id,
    requestNumber: r.request_number,
    poNumber: r.po_number ?? null,
    jobNumber: r.job_number,
    requestorId: r.requestor_id,
    requestorName: r.requestor_name,
    approverId: r.approver_id ?? null,
    approverName: r.approver_name ?? null,
    vendorId: r.vendor_id ?? null,
    vendorName: r.vendor_name ?? null,
    status: r.status,
    needByDate: r.need_by_date,
    needByTime: r.need_by_time,
    estimatedTotalCents: Number(r.estimated_total_cents ?? 0),
    requestedQty: Number(r.requested_qty ?? 0),
    workshopStockQty: Number(r.stock_qty ?? 0),
    finalOrderQty: Number(r.final_qty ?? 0),
    expectedArrivalDate: r.expected_arrival_date ?? null,
    trackingNumber: r.tracking_number ?? null,
    createdAt: r.created_at,
    receivedAt: r.received_at ?? null,
    orgId: r.org_id,
    createdBy: r.created_by,
  }));
}

export function approvalQueue(ctx: Ctx, actor: Actor) {
  guard(ctx, actor, 'review.read_queue');
  return listRequests(ctx, actor).filter((r) => QUEUE_STATUSES.includes(r.status));
}

export function getRequestDetail(ctx: Ctx, actor: Actor, requestId: string) {
  const request = requireRequest(ctx, actor, requestId);
  const canReadAll = authorize(actor, 'request.read.all', { request: toAuthzRequest(request) }).ok;
  if (!canReadAll) guard(ctx, actor, 'request.read.own', request);

  const settings = loadSettings(ctx.db, actor.orgId);
  const location = ctx.db.prepare('select * from delivery_locations where id = ?').get(request.delivery_location_id) as any;
  const requestor = ctx.db.prepare('select * from users where id = ?').get(request.requestor_id) as any;
  const approver = request.approver_id ? (ctx.db.prepare('select * from users where id = ?').get(request.approver_id) as any) : null;
  const items = ctx.db.prepare('select * from purchase_request_items where request_id = ? order by line_no').all(requestId) as any[];
  const attachments = ctx.db.prepare('select id, filename, content_type, byte_size, caption, created_at from purchase_request_attachments where request_id = ?').all(requestId) as any[];
  const po = ctx.db.prepare('select * from purchase_orders where request_id = ?').get(requestId) as any;
  const drafts = ctx.db.prepare('select * from purchase_email_drafts where request_id = ? order by created_at').all(requestId) as any[];
  const receipts = ctx.db.prepare('select * from purchase_receipts where request_id = ? order by created_at').all(requestId) as any[];
  const timeline = ctx.db.prepare('select * from purchase_activity_log where request_id = ? order by at, seq').all(requestId) as any[];
  const approvals = ctx.db.prepare('select * from purchase_approvals where request_id = ? order by decided_at').all(requestId) as any[];

  return {
    request: {
      id: request.id,
      orgId: request.org_id,
      requestNumber: request.request_number,
      jobNumber: request.job_number,
      status: request.status,
      requestorId: request.requestor_id,
      requestorName: requestor?.full_name ?? '',
      createdBy: request.created_by,
      needByDate: request.need_by_date,
      needByTime: request.need_by_time,
      deliveryMethod: request.delivery_method,
      deliveryLocationId: request.delivery_location_id,
      deliveryLocationName: location?.name ?? '',
      deliveryAddress: location?.address ?? '',
      reason: request.reason ?? '',
      notes: request.notes ?? '',
      submittedAt: request.submitted_at,
      approverId: request.approver_id,
      approverName: approver?.full_name ?? null,
      decidedAt: request.decided_at,
      decisionNotes: request.decision_notes,
      rejectionReason: request.rejection_reason,
      clarificationQuestion: request.clarification_question,
      clarificationAnswer: request.clarification_answer,
      estimatedTotalCents: Number(request.estimated_total_cents ?? 0),
      expectedArrivalDate: request.expected_arrival_date,
      trackingNumber: request.tracking_number,
      trackingCarrier: request.tracking_carrier,
      orderedAt: request.ordered_at,
      receivedAt: request.received_at,
      completedAt: request.completed_at,
      cancelReason: request.cancel_reason,
      version: request.version,
      createdAt: request.created_at,
    },
    // Section A of the approval screen. Read-only, forever.
    originalItems: items.map((i) => ({
      id: i.id, lineNo: i.line_no, description: i.description,
      requestedQty: Number(i.requested_qty), unit: i.unit,
      stockNumber: i.stock_number, notes: i.notes,
    })),
    // Section B. Nothing here can overwrite Section A.
    reviewLines: reviewLines(ctx, requestId),
    attachments,
    purchaseOrder: po
      ? {
          id: po.id, poNumber: po.po_number, generatedAt: po.generated_at,
          estimatedTotalCents: Number(po.estimated_total_cents), status: po.status,
          documents: ctx.db
            .prepare('select id, filename, content_type, byte_size, generated_at from purchase_order_documents where purchase_order_id = ?')
            .all(po.id),
          items: ctx.db.prepare('select * from purchase_order_items where purchase_order_id = ? order by line_no').all(po.id),
        }
      : null,
    emailDrafts: drafts.map((d) => ({
      id: d.id, templateKey: d.template_key, status: d.status, subject: d.subject, body: d.body,
      to: JSON.parse(d.to_addrs), attachments: JSON.parse(d.attachments),
      generatedAt: d.generated_at, reviewedAt: d.reviewed_at, sentAt: d.sent_at,
      externalSendEnabled: Boolean(d.external_send_enabled),
    })),
    receipts: receipts.map((r) => ({
      id: r.id, receivedDate: r.received_date, packingSlipNumber: r.packing_slip_number,
      notes: r.notes, isFinal: Boolean(r.is_final),
      items: ctx.db.prepare('select * from purchase_receipt_items where receipt_id = ?').all(r.id),
    })),
    progress: orderProgress(ctx, requestId),
    approvals: approvals.map((a) => ({
      id: a.id, decision: a.decision, decidedAt: a.decided_at, notes: a.notes,
      reason: a.reason, changes: JSON.parse(a.changes_json ?? '[]'),
      approverName: (ctx.db.prepare('select full_name from users where id = ?').get(a.approver_id) as any)?.full_name,
    })),
    timeline: timeline.map((t) => ({
      id: t.id, at: t.at, seq: t.seq, actorId: t.actor_id, actorName: t.actor_name,
      action: t.action, entityType: t.entity_type, entityId: t.entity_id,
      previousValues: t.previous_values ? JSON.parse(t.previous_values) : null,
      newValues: t.new_values ? JSON.parse(t.new_values) : null,
      notes: t.notes,
    })),
    actions: availableActions(actor, toAuthzRequest(request), { settings }),
    viewer: { id: actor.id, name: actor.name, roles: actor.roles, isApprover: isApprover(actor) },
  };
}

export function listVendors(ctx: Ctx, actor: Actor) {
  return ctx.db
    .prepare(
      `select v.*, c.name as contact_name, c.email as contact_email, c.phone as contact_phone
         from vendors v
         left join vendor_contacts c on c.vendor_id = v.id and c.is_primary = 1
        where v.org_id = ? and v.is_active = 1 order by v.name`,
    )
    .all(actor.orgId) as any[];
}

export function listDeliveryLocations(ctx: Ctx, actor: Actor) {
  return ctx.db
    .prepare('select * from delivery_locations where org_id = ? and is_active = 1 order by kind, name')
    .all(actor.orgId) as any[];
}

export function listJobs(ctx: Ctx, actor: Actor) {
  return ctx.db.prepare('select * from jobs where org_id = ? and is_active = 1 order by job_number').all(actor.orgId) as any[];
}

export function listUsers(ctx: Ctx, actor: Actor) {
  const rows = ctx.db.prepare('select * from users where org_id = ? order by full_name').all(actor.orgId) as any[];
  return rows.map((u) => ({
    ...u,
    roles: (ctx.db.prepare('select role_key from user_roles where user_id = ?').all(u.id) as any[]).map((r) => r.role_key),
  }));
}

export function listNotifications(ctx: Ctx, actor: Actor) {
  return ctx.db
    .prepare('select * from purchase_notifications where recipient_id = ? order by created_at desc limit 50')
    .all(actor.id) as any[];
}

// --- administration ---------------------------------------------------------

export function poConfig(ctx: Ctx, actor: Actor) {
  return ctx.db.prepare('select * from po_number_sequences where org_id = ?').get(actor.orgId) as any;
}

/**
 * Change the PO numbering scheme. The next value may only move FORWARD: winding
 * a sequence backwards would re-issue numbers that vendors and invoices already
 * reference.
 */
export function updatePoConfig(
  ctx: Ctx, actor: Actor,
  input: { prefix?: string; padding?: number; suffix?: string; nextValue?: number },
) {
  guard(ctx, actor, 'admin.po_config');
  const current = poConfig(ctx, actor);
  const validation = validatePoConfig({
    prefix: input.prefix ?? current.prefix,
    padding: input.padding ?? current.padding,
    nextNumber: input.nextValue ?? current.next_value,
  });
  if (!validation.ok) throw new ServiceError('validation_failed', 'invalid PO configuration', validation.errors);
  const nextValue = input.nextValue ?? Number(current.next_value);
  if (nextValue < Number(current.next_value)) {
    throw new ServiceError('sequence_rewind', 'a PO sequence can only move forward — issued numbers are permanent');
  }
  ctx.db
    .prepare('update po_number_sequences set prefix = ?, padding = ?, suffix = ?, next_value = ?, updated_at = ?, updated_by = ? where org_id = ?')
    .run(input.prefix ?? current.prefix, input.padding ?? current.padding, input.suffix ?? current.suffix, nextValue, ctx.now, actor.id, actor.orgId);
  logActivity(ctx, actor, {
    orgId: actor.orgId, action: 'admin.po_config_changed', entityType: 'po_number_sequence', entityId: actor.orgId,
    previousValues: { prefix: current.prefix, padding: current.padding, suffix: current.suffix, nextValue: current.next_value },
    newValues: { prefix: input.prefix ?? current.prefix, padding: input.padding ?? current.padding, nextValue },
    notes: 'PO numbering configuration changed',
  });
  return { ok: true };
}

/** Grant or revoke approval authority for a user (spec §2 OFFICE, §14). */
export function setApprovalAuthority(ctx: Ctx, actor: Actor, userId: string, canApprove: boolean) {
  guard(ctx, actor, 'admin.users');
  const target = ctx.db.prepare('select * from users where id = ?').get(userId) as any;
  if (!target || target.org_id !== actor.orgId) throw new ServiceError('not_found', 'user not found');
  ctx.db
    .prepare('update users set can_approve = ?, updated_at = ?, updated_by = ? where id = ?')
    .run(canApprove ? 1 : 0, ctx.now, actor.id, userId);
  logActivity(ctx, actor, {
    orgId: actor.orgId, action: 'admin.approval_authority_changed', entityType: 'user', entityId: userId,
    previousValues: { canApprove: Boolean(target.can_approve) }, newValues: { canApprove },
    notes: `approval authority ${canApprove ? 'granted to' : 'revoked from'} ${target.full_name}`,
  });
  return { ok: true };
}

export function auditLog(ctx: Ctx, actor: Actor, limit = 200) {
  guard(ctx, actor, 'admin.audit');
  return ctx.db
    .prepare('select * from purchase_activity_log where org_id = ? order by at desc, seq desc limit ?')
    .all(actor.orgId, limit) as any[];
}
