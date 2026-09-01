/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// context.ts — the Supabase composition of a PurchasingContext.
//
// Same interfaces, same use cases, same domain. The only things that change are
// which repository implementations are bound and what the transaction boundary
// can honestly promise.
//
// STATUS: never executed. No Supabase project exists in this environment.
// ---------------------------------------------------------------------------

import type { PurchasingContext } from '../../application/context.ts';
import type {
  AtomicOperations, AuditPort, AttachmentPort, DocumentPort, IdentityPort,
  NotificationPort, UnitOfWork,
} from '../../application/ports.ts';
import type { AppConfig } from '../env.ts';
import { emailDraftAdapter, pdfRenderer, systemClock } from '../adapters.ts';
import { builtinIntegrationProviders } from '../providers/builtin.ts';
import { requestClient, privilegedClient, unwrap, type SupabaseHandles } from './client.ts';
import { TABLES, money, qty, toActor } from './mappers.ts';
import { poNumberStrategyFor } from '../../organization/po-numbering.mjs';
import {
  supabaseApprovalRepository, supabaseEmailDraftRepository, supabaseInventoryRepository,
  supabaseOrderRepository, supabasePoNumberAllocator, supabasePurchaseHistoryRepository,
  supabaseReceiptRepository, supabaseItemCatalogRepository, supabaseReferenceRepository,
  supabaseRequestRepository, supabaseReviewRepository,
} from './repositories.ts';

/**
 * THE HONEST UNIT OF WORK.
 *
 * `supabase-js` has no client-side transaction: each call is its own HTTP
 * request and its own implicit transaction. So this implementation runs the
 * callback and nothing else. It does NOT begin, commit or roll back, because
 * pretending to would be worse than not having one — a caller would believe an
 * atomicity guarantee that does not exist.
 *
 * Multi-statement atomic units must therefore be Postgres functions called
 * through a single RPC. Migration 0016 already provides two:
 *
 *   record_purchase_decision()   approval + approval row + inventory movement
 *   generate_purchase_order()    number allocation + order + items + status
 *
 * Two of the three are now routed through `atomic` below:
 * record_purchase_decision and record_purchase_receipt (0019).
 *
 * generate_purchase_order is NOT, and deliberately so: the use case also
 * renders and stores the PO document, which the database cannot do. Splitting
 * that step out so the row write can move into the RPC is Checkpoint 2A. Until
 * then PO generation is atomic on the local provider and a sequence of writes
 * here — recorded rather than papered over.
 */
function supabaseUnitOfWork(): UnitOfWork {
  return {
    async run<T>(fn: () => Promise<T> | T): Promise<T> {
      return fn();
    },
  };
}

/**
 * The operations Postgres does in one transaction because PostgREST cannot.
 *
 * Each maps to a function migration 0016/0019 already defines. Nothing here
 * re-implements a rule: the RPC is the transaction, and it re-checks the
 * invariants the domain already checked so that a caller which is not this
 * application still cannot write something incoherent.
 */
function atomicOperations(h: SupabaseHandles): AtomicOperations {
  return {
    async recordDecision(input) {
      const status = unwrap(
        await h.db.rpc('record_purchase_decision', {
          p_request: input.requestId,
          p_decision: input.decision,
          p_notes: input.notes ?? null,
          p_reason: input.reason ?? null,
        }),
        'record_purchase_decision',
      ) as any;
      return { status: String(Array.isArray(status) ? status[0] : status) };
    },

    async recordReceipt(input) {
      const rows = unwrap(
        await h.db.rpc('record_purchase_receipt', {
          p_request: input.requestId,
          p_received_date: input.receivedDate,
          p_packing_slip: input.packingSlipNumber ?? null,
          p_notes: input.notes ?? null,
          p_lines: input.lines.map((line) => ({
            purchase_order_item_id: line.purchaseOrderItemId,
            received_qty: qty.write(line.receivedQty),
            damaged_qty: qty.write(line.damagedQty),
            backordered_qty: qty.write(line.backorderedQty),
            written_off_qty: qty.write(line.writtenOffQty),
            override_reason: line.overrideReason ?? null,
            notes: line.notes ?? null,
          })),
        }),
        'record_purchase_receipt',
      ) as any;
      const row = Array.isArray(rows) ? rows[0] : rows;
      return { receiptId: String(row.receipt_id), outstandingLines: Number(row.outstanding_lines) };
    },
  };
}

function identity(h: SupabaseHandles, config: AppConfig): IdentityPort {
  const loadRoles = async (userId: string) => {
    const [roles, jobs] = await Promise.all([
      h.db.from(TABLES.userRoles).select('role').eq('user_id', userId).order('role'),
      h.db.from(TABLES.jobAssignments).select('job_number').eq('user_id', userId).order('job_number'),
    ]);
    return {
      roles: ((roles.data ?? []) as any[]).map((r) => r.role as string),
      jobs: ((jobs.data ?? []) as any[]).map((j) => j.job_number as string),
    };
  };

  return {
    async load(userId) {
      const { data } = await h.db.from(TABLES.users).select('*').eq('id', userId).maybeSingle();
      if (!data) return null;
      const { roles, jobs } = await loadRoles(userId);
      return toActor(data, roles, jobs);
    },

    async listUsers(orgId) {
      return supabaseReferenceRepository(h).users(orgId);
    },

    // Administrative writes. These touch other people's records, so they use
    // the privileged client — and only after the application has authorized
    // the caller, which happens in the use case before we are called.
    async createUser(input) {
      const row = unwrap(
        await privilegedClient(config).from(TABLES.users).insert({
          org_id: input.orgId, full_name: input.fullName, email: input.email, is_active: true,
          purchasing_can_approve: input.canApprove,
          purchasing_is_delivery_receiver: input.isDeliveryReceiver,
        }).select('id').single(),
        'create user',
      ) as any;
      unwrap(
        await privilegedClient(config).from(TABLES.userRoles)
          .insert(input.roles.map((role) => ({ user_id: row.id, role, granted_by: input.createdBy }))),
        'assign roles',
      );
      return row.id as string;
    },

    async setActive(userId, active) {
      unwrap(
        await privilegedClient(config).from(TABLES.users).update({ is_active: active }).eq('id', userId),
        'set user active',
      );
    },

    async setRoles(userId, roles, actorId) {
      const client = privilegedClient(config);
      unwrap(await client.from(TABLES.userRoles).delete().eq('user_id', userId), 'clear roles');
      unwrap(
        await client.from(TABLES.userRoles).insert(roles.map((role) => ({ user_id: userId, role, granted_by: actorId }))),
        'set roles',
      );
    },

    async setDeliveryReceiver(userId, isReceiver) {
      unwrap(
        await privilegedClient(config).from(TABLES.users)
          .update({ purchasing_is_delivery_receiver: isReceiver }).eq('id', userId),
        'set delivery receiver',
      );
    },

    async assignJob(userId, jobNumber, actorId) {
      unwrap(
        await privilegedClient(config).from(TABLES.jobAssignments)
          .upsert({ user_id: userId, job_number: jobNumber, assigned_by: actorId }, { onConflict: 'user_id,job_number' }),
        'assign job',
      );
    },

    async unassignJob(userId, jobNumber) {
      unwrap(
        await privilegedClient(config).from(TABLES.jobAssignments)
          .delete().eq('user_id', userId).eq('job_number', jobNumber),
        'unassign job',
      );
    },
  };
}

function audit(h: SupabaseHandles): AuditPort {
  return {
    async record(orgId, actor, event) {
      // The local provider computes a per-request sequence; in Postgres the
      // ordering key is (at, id) and a gapless sequence would need a lock for
      // no benefit. `seq` is still written so both providers' rows have the
      // same shape — 1C should replace it with a database default.
      const { data: last } = await h.db.from(TABLES.activityLog)
        .select('seq').eq('request_id', event.requestId ?? null)
        .order('seq', { ascending: false }).limit(1).maybeSingle();

      unwrap(
        await h.db.from(TABLES.activityLog).insert({
          org_id: orgId, request_id: event.requestId ?? null,
          actor_id: actor?.id ?? null, actor_name: actor?.name ?? 'system',
          action: event.action, entity_type: event.entityType, entity_id: event.entityId ?? null,
          previous_values: event.before ?? null, new_values: event.after ?? null,
          notes: event.notes ?? null, seq: Number((last as any)?.seq ?? 0) + 1,
        }),
        'record activity',
      );
    },

    async timelineFor(requestId) {
      const rows = unwrap(
        await h.db.from(TABLES.activityLog).select('*').eq('request_id', requestId).order('at').order('seq'),
        'read timeline',
      ) as any[];
      return rows.map((t) => ({
        id: t.id, at: t.at, seq: t.seq, actorId: t.actor_id, actorName: t.actor_name,
        action: t.action, entityType: t.entity_type, entityId: t.entity_id,
        previousValues: t.previous_values ?? null, newValues: t.new_values ?? null, notes: t.notes,
      }));
    },

    async orgLog(orgId, limit) {
      return unwrap(
        await h.db.from(TABLES.activityLog).select('*').eq('org_id', orgId)
          .order('at', { ascending: false }).order('seq', { ascending: false }).limit(limit),
        'read org audit log',
      ) as any[];
    },
  };
}

function notifications(h: SupabaseHandles): NotificationPort {
  return {
    async publish(orgId, event, requestId, payload) {
      // Audience resolution mirrors the local adapter: roles from the join
      // table, plus the requestor of record where the event names them.
      const { NOTIFICATION_AUDIENCE } = await import('../../domain/activity.mjs');
      const groups = (NOTIFICATION_AUDIENCE as Record<string, string[]>)[event] ?? [];
      const recipients = new Set<string>();

      for (const group of groups) {
        if (group === 'REQUESTOR_OF_RECORD') {
          if (!requestId) continue;
          const { data } = await h.db.from(TABLES.requests).select('requestor_id').eq('id', requestId).maybeSingle();
          if ((data as any)?.requestor_id) recipients.add((data as any).requestor_id);
          continue;
        }
        const { data } = await h.db.from(TABLES.userRoles)
          .select(`user_id, user:users!inner(id,org_id,is_active)`)
          .eq('role', group).eq('user.org_id', orgId).eq('user.is_active', true);
        for (const row of (data ?? []) as any[]) recipients.add(row.user_id);
      }
      if (!recipients.size) return;

      unwrap(
        await h.db.from(TABLES.notifications).insert(
          [...recipients].map((recipient) => ({
            org_id: orgId, request_id: requestId, event, recipient_id: recipient, payload: payload ?? {},
          })),
        ),
        'publish notification',
      );
    },

    async inboxFor(userId) {
      return unwrap(
        await h.db.from(TABLES.notifications).select('*').eq('recipient_id', userId)
          .order('created_at', { ascending: false }).limit(50),
        'read notifications',
      ) as any[];
    },
  };
}

/**
 * Documents. Migration 0016 stores a `storage_path`, not bytes: production puts
 * the PDF in Supabase Storage. That bucket does not exist yet (Checkpoint 1C/
 * Phase 7), so this adapter records the row and reports honestly when asked for
 * bytes rather than inventing an empty PDF.
 */
function documents(h: SupabaseHandles): DocumentPort {
  return {
    async store(doc, now) {
      const storagePath = `${h.orgId}/purchase-orders/${doc.purchaseOrderId}/${doc.filename}`;
      const row = unwrap(
        await h.db.from(TABLES.orderDocuments).insert({
          purchase_order_id: doc.purchaseOrderId, kind: doc.kind, filename: doc.filename,
          content_type: doc.contentType, byte_size: doc.bytes.byteLength, storage_path: storagePath,
          sha256: await sha256(doc.bytes), generated_at: now, generated_by: doc.generatedBy,
          template_key: doc.templateKey,
        }).select('id').single(),
        'store purchase order document',
      ) as any;
      // TODO(1C): upload doc.bytes to Storage at storagePath. Until the bucket
      // exists the row points at an object that is not there, and any download
      // must fail loudly rather than serve nothing.
      return { id: row.id, filename: doc.filename, byteSize: doc.bytes.byteLength };
    },

    async get(id) {
      const { data } = await h.db.from(TABLES.orderDocuments).select('*').eq('id', id).maybeSingle();
      return data ?? null;
    },

    async listFor(purchaseOrderId) {
      return unwrap(
        await h.db.from(TABLES.orderDocuments)
          .select('id,filename,content_type,byte_size,generated_at,storage_path')
          .eq('purchase_order_id', purchaseOrderId),
        'list purchase order documents',
      ) as any[];
    },
  };
}

function attachments(h: SupabaseHandles): AttachmentPort {
  return {
    async attachToRequest(requestId, file, actorId) {
      const storagePath = `${h.orgId}/requests/${requestId}/${file.filename}`;
      const row = unwrap(
        await h.db.from(TABLES.requestAttachments).insert({
          request_id: requestId, filename: file.filename, content_type: file.contentType ?? null,
          byte_size: file.byteSize ?? null, storage_path: storagePath, caption: file.caption ?? null,
          created_by: actorId,
        }).select('id').single(),
        'attach to request',
      ) as any;
      return { id: row.id, filename: file.filename };
    },

    async attachToReceipt(receiptId, file, actorId) {
      await supabaseReceiptRepository(h).attach(
        receiptId,
        { ...file, storagePath: `${h.orgId}/receipts/${receiptId}/${file.filename}` },
        actorId,
        new Date().toISOString(),
      );
    },
  };
}

async function sha256(bytes: Buffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build a purchasing context backed by Supabase, scoped to ONE request.
 *
 * `accessToken` is the caller's verified session token; every query then runs
 * as that user and RLS applies to them. Passing null produces an anonymous
 * client, which RLS will refuse — that is the correct failure.
 */
export function supabasePurchasingContext(
  config: AppConfig,
  { accessToken, orgId, now }: { accessToken: string | null; orgId: string; now?: string },
): PurchasingContext {
  const handles: SupabaseHandles = {
    db: requestClient(config, accessToken),
    privileged: () => privilegedClient(config),
    orgId,
  };

  const reference = supabaseReferenceRepository(handles);
  const catalog = supabaseItemCatalogRepository(handles);

  return {
    clock: systemClock(now),
    uow: supabaseUnitOfWork(),
    requests: supabaseRequestRepository(handles),
    reviews: supabaseReviewRepository(handles),
    approvals: supabaseApprovalRepository(handles),
    orders: supabaseOrderRepository(handles),
    drafts: supabaseEmailDraftRepository(handles),
    receipts: supabaseReceiptRepository(handles),
    inventory: supabaseInventoryRepository(handles),
    reference,
    catalog,
    // Immutable history, written at the terminal transition. The catalogue's
    // "last ordered from" and "last price" read from here, so a renamed vendor
    // cannot rewrite what a past purchase says.
    history: supabasePurchaseHistoryRepository(handles),
    // Same seam as the local composition root, same source of truth: the
    // organization's profile id decides the rule, and both providers now build
    // the identifier with the same function.
    poNumbers: supabasePoNumberAllocator(handles, poNumberStrategyFor(config.poNumbering, handles.orgId, { separator: config.poSeparator })),
    identity: identity(handles, config),
    // Credentials stay with the AuthPort; the Supabase auth adapter already
    // exists and is selected by the same configuration.
    auth: null as any,
    audit: audit(handles),
    notifications: notifications(handles),
    documents: documents(handles),
    renderer: pdfRenderer(),
    attachments: attachments(handles),
    email: emailDraftAdapter(),
    // The same seams, over the Supabase repositories. The adapters are written
    // against the repository interfaces rather than against SQLite, so both
    // providers get identical job lookup, autocomplete ranking and email
    // handoff — which is the property that makes the local harness evidence
    // about production behaviour rather than about the pilot.
    integrations: builtinIntegrationProviders({ reference, catalog }),
    atomic: atomicOperations(handles),
  };
}

export { money, qty };
