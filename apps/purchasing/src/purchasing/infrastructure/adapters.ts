/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// adapters.ts — pilot bindings for the SHARED AWE capabilities Purchasing
// consumes through application/ports.ts.
//
// Every adapter here is a placeholder for something the platform owns. Each one
// names its production counterpart, so replacing it is a lookup, not an
// investigation:
//
//   identityAdapter      -> Supabase Auth + users (0001) + purchasing_user_roles (0016)
//   auditAdapter         -> the org audit trail; purchase_activity_log (0016)
//                           and, in production, emit_event -> integration_events (0009)
//   notificationAdapter  -> the notification layer; the same emit_event contract
//   documentAdapter      -> Supabase Storage (the 0005 storage idiom)
//   attachmentAdapter    -> Supabase Storage
//   emailDraftAdapter    -> composes drafts only; the transport does not exist,
//                           and `send` is absent from the port on purpose
//   pdfRenderer          -> the PO renderer (infrastructure/pdf-adapter.ts)
//
// Purchasing owns none of these capabilities. It owns the narrow question it
// asks each of them.
// ---------------------------------------------------------------------------

import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type {
  Actor, AttachmentPort, AuditPort, Clock, DocumentPort, DocumentRenderer,
  EmailDraftPort, IdentityPort, NotificationPort,
} from '../application/ports.ts';
import { NOTIFICATION_AUDIENCE } from '../domain/activity.mjs';
import { composeDraft, EXTERNAL_SEND_ENABLED } from '../domain/email.mjs';
import { renderPoPdf, PO_TEMPLATE_KEY } from './pdf-adapter.ts';

const uuid = () => randomUUID();

export function systemClock(fixed?: string): Clock {
  return { now: () => fixed ?? new Date().toISOString() };
}

/**
 * Identity. The pilot reads the `users` table; production reads the same table
 * behind Supabase Auth, and roles move to `purchasing_user_roles`. Purchasing
 * never sees a credential either way.
 */
export function identityAdapter(db: DatabaseSync): IdentityPort {
  return {
    async load(userId) {
      const u = db.prepare('select * from users where id = ?').get(userId) as any;
      if (!u) return null;
      const roles = (db.prepare('select role_key from user_roles where user_id = ? order by role_key').all(userId) as any[])
        .map((r) => r.role_key as string);
      // Job assignments come from the server, every time. A browser can claim a
      // role or a job number all it likes; it never reaches this object.
      const assignedJobNumbers = (
        db.prepare('select job_number from user_job_assignments where user_id = ? order by job_number').all(userId) as any[]
      ).map((r) => r.job_number as string);

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
        isDeliveryReceiver: Boolean(u.is_delivery_receiver),
        assignedJobNumbers,
      };
    },
    async listUsers(orgId) {
      const rows = db.prepare('select * from users where org_id = ? order by full_name').all(orgId) as any[];
      return rows.map((u) => ({
        ...u,
        roles: (db.prepare('select role_key from user_roles where user_id = ?').all(u.id) as any[]).map((r) => r.role_key),
        jobs: (db.prepare('select job_number from user_job_assignments where user_id = ? order by job_number')
          .all(u.id) as any[]).map((r) => r.job_number),
      }));
    },

    // --- administrative writes on the PERSON ---------------------------------
    // None of these creates a way to sign in. That is AuthPort.setPassword,
    // called separately, so "user exists" and "user has credentials" stay two
    // decisions rather than one accident.

    async createUser(input) {
      const id = uuid();
      db.prepare(
        `insert into users (id, org_id, full_name, email, is_active, can_approve, is_primary_approver,
                            is_backup_approver, is_delivery_receiver, created_at, updated_at, created_by)
         values (?,?,?,?,1,?,0,0,?,?,?,?)`,
      ).run(id, input.orgId, input.fullName, input.email, input.canApprove ? 1 : 0,
            input.isDeliveryReceiver ? 1 : 0, input.now, input.now, input.createdBy);
      for (const role of input.roles) {
        db.prepare('insert into user_roles (user_id, role_key, granted_at, granted_by) values (?,?,?,?)')
          .run(id, role, input.now, input.createdBy);
      }
      return id;
    },

    async setActive(userId, active, actorId, now) {
      db.prepare('update users set is_active = ?, updated_at = ?, updated_by = ? where id = ?')
        .run(active ? 1 : 0, now, actorId, userId);
    },

    async setRoles(userId, roles, actorId, now) {
      db.prepare('delete from user_roles where user_id = ?').run(userId);
      for (const role of roles) {
        db.prepare('insert into user_roles (user_id, role_key, granted_at, granted_by) values (?,?,?,?)')
          .run(userId, role, now, actorId);
      }
      db.prepare('update users set updated_at = ?, updated_by = ? where id = ?').run(now, actorId, userId);
    },

    async setDeliveryReceiver(userId, isReceiver, actorId, now) {
      db.prepare('update users set is_delivery_receiver = ?, updated_at = ?, updated_by = ? where id = ?')
        .run(isReceiver ? 1 : 0, now, actorId, userId);
    },

    async assignJob(userId, jobNumber, actorId, now) {
      db.prepare(
        `insert or ignore into user_job_assignments (user_id, job_number, assigned_at, assigned_by)
         values (?,?,?,?)`,
      ).run(userId, jobNumber, now, actorId);
    },

    async unassignJob(userId, jobNumber) {
      db.prepare('delete from user_job_assignments where user_id = ? and job_number = ?').run(userId, jobNumber);
    },
  };
}

/**
 * Audit. Purchasing hands over a domain event; the platform decides where it
 * lives. The pilot appends to purchase_activity_log with a per-request sequence
 * so the timeline is stable even when two events share a timestamp.
 */
export function auditAdapter(db: DatabaseSync, clock: Clock): AuditPort {
  return {
    async record(orgId: string, actor: Actor | null, event: any) {
      const seqRow = db
        .prepare('select coalesce(max(seq), 0) as m from purchase_activity_log where request_id is ?')
        .get(event.requestId ?? null) as any;
      db.prepare(
        `insert into purchase_activity_log
           (id, org_id, request_id, actor_id, actor_name, action, entity_type, entity_id,
            previous_values, new_values, notes, at, seq)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        uuid(), orgId, event.requestId ?? null, actor?.id ?? null, actor?.name ?? 'system',
        event.action, event.entityType, event.entityId ?? null,
        event.before === null || event.before === undefined ? null : JSON.stringify(event.before),
        event.after === null || event.after === undefined ? null : JSON.stringify(event.after),
        event.notes ?? null, clock.now(), Number(seqRow?.m ?? 0) + 1,
      );
    },

    async timelineFor(requestId: string) {
      return (db.prepare('select * from purchase_activity_log where request_id = ? order by at, seq').all(requestId) as any[]).map((t) => ({
        id: t.id, at: t.at, seq: t.seq, actorId: t.actor_id, actorName: t.actor_name,
        action: t.action, entityType: t.entity_type, entityId: t.entity_id,
        previousValues: t.previous_values ? JSON.parse(t.previous_values) : null,
        newValues: t.new_values ? JSON.parse(t.new_values) : null,
        notes: t.notes,
      }));
    },

    async orgLog(orgId: string, limit: number) {
      return db
        .prepare('select * from purchase_activity_log where org_id = ? order by at desc, seq desc limit ?')
        .all(orgId, limit) as any[];
    },
  };
}

/**
 * Notifications. Purchasing names an event and an audience shape; who gets it,
 * and how it is delivered, is the platform's. In production this becomes
 * emit_event() so the existing n8n consumers see purchasing traffic without a
 * second bus being invented for it.
 */
export function notificationAdapter(db: DatabaseSync, clock: Clock): NotificationPort {
  return {
    async publish(orgId, event, requestId, payload) {
      const audience = (NOTIFICATION_AUDIENCE as Record<string, string[]>)[event] ?? [];
      const recipients = new Set<string>();
      for (const group of audience) {
        if (group === 'REQUESTOR_OF_RECORD') {
          if (requestId) {
            const r = db.prepare('select requestor_id from purchase_requests where id = ?').get(requestId) as any;
            if (r?.requestor_id) recipients.add(r.requestor_id);
          }
          continue;
        }
        const rows = db
          .prepare(
            `select u.id from users u join user_roles ur on ur.user_id = u.id
              where u.org_id = ? and ur.role_key = ? and u.is_active = 1`,
          )
          .all(orgId, group) as any[];
        for (const row of rows) recipients.add(row.id);
      }
      const stmt = db.prepare(
        `insert into purchase_notifications (id, org_id, request_id, event, recipient_id, payload, created_at)
         values (?,?,?,?,?,?,?)`,
      );
      for (const recipient of recipients) {
        stmt.run(uuid(), orgId, requestId, event, recipient, JSON.stringify(payload ?? {}), clock.now());
      }
    },

    async inboxFor(userId) {
      return db
        .prepare('select * from purchase_notifications where recipient_id = ? order by created_at desc limit 50')
        .all(userId) as any[];
    },
  };
}

/** Document storage. Production: Supabase Storage + a row holding the path. */
export function documentAdapter(db: DatabaseSync): DocumentPort {
  return {
    async store(doc, now) {
      const id = uuid();
      db.prepare(
        `insert into purchase_order_documents
           (id, purchase_order_id, kind, filename, content_type, byte_size, data_base64, sha256,
            generated_at, generated_by, template_key)
         values (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, doc.purchaseOrderId, doc.kind, doc.filename, doc.contentType, doc.bytes.byteLength,
        doc.bytes.toString('base64'), createHash('sha256').update(doc.bytes).digest('hex'),
        now, doc.generatedBy, doc.templateKey,
      );
      return { id, filename: doc.filename, byteSize: doc.bytes.byteLength };
    },
    async get(id) {
      return db.prepare('select * from purchase_order_documents where id = ?').get(id) as any;
    },
    async listFor(purchaseOrderId) {
      return db
        .prepare('select id, filename, content_type, byte_size, generated_at from purchase_order_documents where purchase_order_id = ?')
        .all(purchaseOrderId) as any[];
    },
  };
}

/** User uploads. Production: Supabase Storage; the row keeps the object path. */
export function attachmentAdapter(db: DatabaseSync): AttachmentPort {
  return {
    async attachToRequest(requestId, file, actorId, now) {
      const id = uuid();
      db.prepare(
        `insert into purchase_request_attachments
           (id, request_id, filename, content_type, byte_size, data_base64, caption, created_at, created_by)
         values (?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, requestId, file.filename, file.contentType ?? null,
        file.byteSize ?? (file.dataBase64 ? Math.floor((file.dataBase64.length * 3) / 4) : null),
        file.dataBase64 ?? null, file.caption ?? null, now, actorId,
      );
      return { id, filename: file.filename };
    },
    async attachToReceipt(receiptId, file, actorId, now) {
      db.prepare(
        `insert into purchase_receipt_attachments (id, receipt_id, filename, content_type, byte_size, data_base64, caption, created_at, created_by)
         values (?,?,?,?,?,?,?,?,?)`,
      ).run(uuid(), receiptId, file.filename, file.contentType ?? null,
            file.dataBase64 ? Math.floor((file.dataBase64.length * 3) / 4) : null,
            file.dataBase64 ?? null, file.caption ?? null, now, actorId);
    },
  };
}

/**
 * Email drafting. Composition only — there is no `send` on the port, so no
 * purchasing code can call one. When AWE grows a transport, it implements a
 * SendPort somewhere else and a human approval still gates it.
 */
export function emailDraftAdapter(): EmailDraftPort {
  return {
    compose(templateKey, context, storedTemplate) {
      return composeDraft(templateKey, context, { template: storedTemplate });
    },
    externalSendEnabled: EXTERNAL_SEND_ENABLED as false,
  };
}

/** PDF rendering, behind the port so the template adapter can be swapped. */
export function pdfRenderer(): DocumentRenderer {
  return {
    renderPurchaseOrder: (view: any) => renderPoPdf(view),
    templateKey: PO_TEMPLATE_KEY,
  };
}
