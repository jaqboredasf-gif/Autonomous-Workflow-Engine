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
  /** Designated to sign for deliveries on their assigned job sites. */
  isDeliveryReceiver: boolean;
  /** The job numbers this person may confirm deliveries for. Server-resolved. */
  assignedJobNumbers: string[];
  /**
   * This person is signed in with a password somebody else chose, and must
   * replace it before doing anything else. Read from the credential store on
   * every request, never from anything the browser sent.
   *
   * Optional because it is a property of the LOCAL credential provider: a
   * Supabase identity has no such flag, and there it is simply absent — which
   * routeDecision treats as false.
   */
  mustChangePassword?: boolean;
};

export interface Clock {
  now(): string;
}

export type AuthResult =
  | {
      ok: true;
      userId: string;
      /**
       * The caller's access token. Present when the provider issues one
       * (Supabase); absent for the local credential store, which has no
       * database session to scope. Everything downstream that talks to
       * Postgres carries this so row level security applies to the PERSON,
       * not to a service role.
       */
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
    }
  | { ok: false; reason: 'invalid_credentials' | 'account_disabled' | 'unavailable' };

/**
 * Credentials. Purchasing never stores a password and never decides whether one
 * is correct: it asks the provider, and gets back an application user id or a
 * refusal. Two adapters implement this — Supabase Auth (production) and a local
 * scrypt credential store (pilot) — and nothing above this interface can tell
 * which is running.
 */
export interface AuthPort {
  readonly provider: 'local' | 'supabase';
  signIn(email: string, password: string): Promise<AuthResult>;
  requestPasswordReset(email: string): Promise<{ ok: boolean; token?: string }>;
  resetPassword(token: string, newPassword: string): Promise<{ ok: boolean; reason?: string }>;
  /**
   * Administrative: invite a user, or reset access for one.
   *
   * A password set here is one somebody ELSE chose and passed on, so a provider
   * that can express it marks the credential as requiring replacement before
   * the account may be used for anything.
   */
  setPassword(userId: string, password: string): Promise<void>;
  /**
   * The person replaces their own password, proving they know the current one.
   * Clears any requirement to change it.
   */
  changeOwnPassword(
    userId: string, currentPassword: string, newPassword: string,
  ): Promise<{ ok: boolean; reason?: 'invalid_credentials' | 'weak_password' | 'same_password' | 'unsupported' }>;
  setDisabled(userId: string, disabled: boolean): Promise<void>;
}

/**
 * Identity and roles. Purchasing NEVER authenticates and never stores a
 * credential: it asks who the caller is and what purchasing roles they hold.
 * Role membership itself is platform data (`purchasing_user_roles`), not a
 * purchasing table.
 */
export interface IdentityPort {
  load(userId: string): Promise<Actor | null>;
  listUsers(orgId: string): Promise<any[]>;
  /**
   * Administrative writes on the PERSON — never on their credentials. Creating
   * a user here does not create a way to sign in; that is AuthPort.setPassword,
   * called separately and deliberately.
   */
  createUser(input: {
    orgId: string; fullName: string; email: string; roles: string[];
    canApprove: boolean; isDeliveryReceiver: boolean; createdBy: string; now: string;
  }): Promise<string>;
  setActive(userId: string, active: boolean, actorId: string, now: string): Promise<void>;
  setRoles(userId: string, roles: string[], actorId: string, now: string): Promise<void>;
  setDeliveryReceiver(userId: string, isReceiver: boolean, actorId: string, now: string): Promise<void>;
  assignJob(userId: string, jobNumber: string, actorId: string, now: string): Promise<void>;
  unassignJob(userId: string, jobNumber: string): Promise<void>;
}

/**
 * The audit trail. Purchasing produces domain events; where they are stored,
 * how long they are kept and who else can read them is the platform's problem.
 */
export interface AuditPort {
  record(orgId: string, actor: Actor | null, event: any): Promise<void>;
  timelineFor(requestId: string): Promise<any[]>;
  orgLog(orgId: string, limit: number): Promise<any[]>;
}

/** Notification fan-out. Purchasing names the event; delivery is not its job. */
export interface NotificationPort {
  publish(orgId: string, event: string, requestId: string | null, payload: unknown): Promise<void>;
  inboxFor(userId: string): Promise<any[]>;
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
  }, now: string): Promise<{ id: string; filename: string; byteSize: number }>;
  get(id: string): Promise<any | null>;
  listFor(purchaseOrderId: string): Promise<any[]>;
}

/** Rendering. Purchasing supplies the data; the renderer owns the paper. */
export interface DocumentRenderer {
  renderPurchaseOrder(view: any): Buffer;
  templateKey: string;
}

/** What `fetch` hands back: the bytes, and the request they hang off. */
export type StoredAttachment = {
  /** The request this file belongs to, whether it was attached to the request
   *  itself or to one of its receipts. Authorization is decided against it. */
  requestId: string;
  filename: string;
  contentType: string | null;
  byteSize: number;
  bytes: Buffer;
};

/** User-uploaded files (photos of a panel, a packing slip). */
export interface AttachmentPort {
  attachToRequest(requestId: string, file: any, actorId: string, now: string): Promise<{ id: string; filename: string }>;
  attachToReceipt(receiptId: string, file: any, actorId: string, now: string): Promise<void>;

  /**
   * Read one back. OPTIONAL, and optional for a stated reason rather than a
   * shrug: the local provider keeps the bytes in the database and can always
   * produce them, while the Supabase provider records a storage path and does
   * not upload anything to it yet. A provider that cannot honestly return the
   * file omits this, and the caller reports "not found" rather than a provider
   * inventing an empty one.
   */
  fetch?(attachmentId: string): Promise<StoredAttachment | null>;
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

/**
 * ATOMIC OPERATIONS a provider may implement server-side.
 *
 * Some invariants span several writes and must not be observable half-done: a
 * receipt whose lines are missing, or a request whose status disagrees with the
 * quantities recorded against it.
 *
 * The local provider does NOT implement this — its unit of work is a real
 * transaction, so the composed use case is already atomic and reimplementing it
 * would mean two places to fix. The Supabase provider DOES, because
 * supabase-js has no client-side transaction and the only honest way to get
 * atomicity is a Postgres function called through one RPC.
 *
 * Domain rules stay in TypeScript either way. What the RPC adds is the atomic
 * write sequence plus a server-side re-check of the invariants, so a different
 * client, a script or a future adapter cannot write what the domain would have
 * refused. That duplication is deliberate: it is defence in depth, not a second
 * implementation of the workflow.
 *
 * A use case asks `ctx.atomic?.x` and otherwise composes the steps itself.
 */
export interface AtomicOperations {
  /**
   * The decision, its approval record and the inventory movement the approval
   * causes, in one transaction. `record_purchase_decision()` (migration 0016).
   */
  recordDecision(input: {
    requestId: string;
    decision: 'APPROVED' | 'REJECTED' | 'CLARIFICATION_REQUESTED';
    notes?: string | null;
    reason?: string | null;
  }): Promise<{ status: string }>;

  recordReceipt(input: {
    requestId: string;
    receivedDate: string;
    packingSlipNumber?: string | null;
    notes?: string | null;
    lines: Array<{
      purchaseOrderItemId: string;
      receivedQty: number;
      damagedQty: number;
      backorderedQty: number;
      writtenOffQty: number;
      overrideReason?: string | null;
      notes?: string | null;
    }>;
  }): Promise<{ receiptId: string; outstandingLines: number }>;
}

/**
 * Transaction boundary. A use case that writes more than one record uses it.
 *
 * The callback is async because the repositories are, and that makes
 * serialization the implementation's problem: between an `await` inside a
 * transaction and the next statement, another request can run, and two
 * interleaved transactions on one connection is a corrupted write, not a slow
 * one. An implementation MUST either queue or hold a real per-connection
 * transaction.
 *
 * What each provider can honestly promise:
 *   local (SQLite)  — `begin immediate` … `commit`, serialized in-process, so
 *                     the whole callback is atomic and isolated.
 *   Supabase (next) — a single-statement RPC per atomic unit, or a Postgres
 *                     function; supabase-js has no client-side transaction, so
 *                     multi-statement atomicity MUST move server-side rather
 *                     than be simulated here. See PURCHASING_ASYNC_REFACTOR_HANDOFF.md.
 */
export interface UnitOfWork {
  run<T>(fn: () => Promise<T> | T): Promise<T>;
}
