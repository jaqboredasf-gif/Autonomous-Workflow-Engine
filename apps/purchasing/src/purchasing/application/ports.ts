/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// ports.ts — the SHARED AWE capabilities Purchasing consumes but does not own.
//
// Everything in this file is a capability that belongs to the platform, not to
// purchasing. Purchasing states the narrow interface it needs; infrastructure
// binds it to whatever AWE actually provides. The pilot binds them to local
// implementations; production binds them to Supabase Auth, the existing
// `integration_events` bus, Supabase Storage, and the notification layer.
//
// The rule this encodes: if a second AWE module would want the same capability,
// Purchasing must not own it — it consumes it through a port here.
//
//   IdentityPort       -> Supabase Auth + `users` (0001) + purchasing_user_roles
//   AuditPort          -> the org-wide audit trail / integration_events (0009)
//   NotificationPort   -> the notification layer (0009 emit_event contract)
//   DocumentPort       -> document storage (Supabase Storage, 0005 idiom)
//   DocumentRenderer   -> PDF rendering
//   AttachmentPort     -> user-uploaded file storage
//   EmailDraftPort     -> draft composition + the transport that WILL exist
//   Clock              -> time, injectable so the domain stays testable
//   UnitOfWork         -> transaction boundary
// ---------------------------------------------------------------------------

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

export interface Clock {
  now(): string;
}

/**
 * Identity and roles. Purchasing NEVER authenticates and never stores a
 * credential: it asks who the caller is and what purchasing roles they hold.
 * Role membership itself is platform data (`purchasing_user_roles`), not a
 * purchasing table.
 */
export interface IdentityPort {
  load(userId: string): Actor | null;
  listUsers(orgId: string): any[];
}

/**
 * The audit trail. Purchasing produces domain events; where they are stored,
 * how long they are kept and who else can read them is the platform's problem.
 */
export interface AuditPort {
  record(orgId: string, actor: Actor | null, event: any): void;
  timelineFor(requestId: string): any[];
  orgLog(orgId: string, limit: number): any[];
}

/** Notification fan-out. Purchasing names the event; delivery is not its job. */
export interface NotificationPort {
  publish(orgId: string, event: string, requestId: string | null, payload: unknown): void;
  inboxFor(userId: string): any[];
}

/** Generated documents (the PO PDF). Storage is a platform capability. */
export interface DocumentPort {
  store(doc: {
    purchaseOrderId: string;
    kind: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
    templateKey: string;
    generatedBy: string;
  }, now: string): { id: string; filename: string; byteSize: number };
  get(id: string): any | null;
  listFor(purchaseOrderId: string): any[];
}

/** Rendering. Purchasing supplies the data; the renderer owns the paper. */
export interface DocumentRenderer {
  renderPurchaseOrder(view: any): Buffer;
  templateKey: string;
}

/** User-uploaded files (photos of a panel, a packing slip). */
export interface AttachmentPort {
  attachToRequest(requestId: string, file: any, actorId: string, now: string): { id: string; filename: string };
  attachToReceipt(receiptId: string, file: any, actorId: string, now: string): void;
}

/**
 * Email. Purchasing composes a DRAFT and never sends: the transport is a
 * platform capability that does not exist yet, and `send` is deliberately
 * absent from this interface so no purchasing code can call it by accident.
 */
export interface EmailDraftPort {
  compose(templateKey: string, context: any, storedTemplate: any | null): any;
  readonly externalSendEnabled: false;
}

/** Transaction boundary. A use case that writes more than one row uses it. */
export interface UnitOfWork {
  run<T>(fn: () => T): T;
}
