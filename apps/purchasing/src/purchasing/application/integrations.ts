/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// integrations.ts — the seams where OTHER SYSTEMS will attach.
//
// ports.ts holds the platform capabilities purchasing consumes (identity,
// audit, storage). This file holds something different and worth keeping
// separate: the boundaries where an EXTERNAL system — QuickBooks, Microsoft
// 365, Exact Time, a spreadsheet somebody maintains — will one day supply data
// purchasing currently keeps for itself.
//
// WHY THESE EXIST NOW, BEFORE THE INTEGRATIONS DO
// Not to be ready for everything. To stop the opposite: a `quickbooks.ts`
// imported from the middle of a use case, an Outlook token read inside a
// domain rule, a vendor list fetched from a screen. Each provider below is
// asked a narrow question and answers with purchasing's own vocabulary, so an
// adapter can be swapped for a real integration without a single domain file
// changing.
//
// THE RULES EVERY PROVIDER OBEYS
//
//   1. PURCHASING OWNS THE DECISION. A provider supplies facts — jobs, items,
//      vendors, a composed draft. It never approves, never orders, never
//      decides who may do what. Authorization stays in authorize().
//
//   2. THE CANONICAL IDENTIFIER SURVIVES. Every record carries the source's own
//      id in `sourceId` alongside whatever purchasing shows a human. When a
//      user picks "24-118 — Harrison Gym", what gets stored is the identifier
//      the source system will still recognise next year, not the label.
//
//   3. READ, THEN WRITE BACK DELIBERATELY OR NOT AT ALL. These are read
//      interfaces plus, where it makes sense, an explicit import. Nothing here
//      writes into an external system.
//
//   4. NO CREDENTIALS ABOVE INFRASTRUCTURE. A provider implementation may hold
//      a token; nothing that imports this file may see one. Any browser-visible
//      path goes through a server action or route, never a client fetch with a
//      secret.
//
//   5. DEGRADED IS A STATE, NOT AN EXCEPTION. `available` lets a screen say
//      "QuickBooks is not connected" instead of showing an empty list that
//      looks like "this company has no jobs".
//
// The current bindings are in infrastructure/providers/builtin.ts, over the data
// purchasing already holds. PCC_INTEGRATION_ARCHITECTURE.md documents where
// each real integration attaches.
// ---------------------------------------------------------------------------

/** Where a record came from. Shown to humans when it is not purchasing itself. */
export type IntegrationSource = 'local' | 'quickbooks' | 'microsoft365' | 'exacttime' | 'import';

/** What every provider can say about itself, without being called. */
export type ProviderInfo = {
  readonly source: IntegrationSource;
  /**
   * False when the integration is configured but unreachable, or not
   * configured at all. A screen renders this as a stated condition; it never
   * renders an empty result as if it were an answer.
   */
  readonly available: boolean;
  /** Human-readable reason when `available` is false. */
  readonly unavailableReason?: string | null;
};

// ---------------------------------------------------------------------------
// JOBS — QuickBooks is the intended source of truth.
// ---------------------------------------------------------------------------

export type JobRecord = {
  /** The identifier the SOURCE system knows this job by. Never re-issued. */
  sourceId: string;
  /** What people type and say: "24-118". */
  jobNumber: string;
  name: string;
  customerName?: string | null;
  address?: string | null;
  active: boolean;
  source: IntegrationSource;
};

/**
 * The job directory. A purchase request is worthless without the right job
 * number on it, and the job list belongs to accounting's system rather than to
 * purchasing.
 *
 * `search` is a TYPE-AHEAD: it takes what has been typed so far and returns
 * matches ranked for a person mid-keystroke. `byNumber` is the exact lookup a
 * server action uses to re-verify a submitted selection — never trust the
 * browser to have sent a job that exists.
 */
export interface JobDirectoryProvider extends ProviderInfo {
  search(orgId: string, query: string, limit?: number): Promise<JobRecord[]>;
  byNumber(orgId: string, jobNumber: string): Promise<JobRecord | null>;
  /** Every active job. For pickers small enough not to need a search. */
  list(orgId: string): Promise<JobRecord[]>;
}

// ---------------------------------------------------------------------------
// MATERIALS — the authoritative list arrives as a spreadsheet.
// ---------------------------------------------------------------------------

export type MaterialRecord = {
  sourceId: string;
  /** The stable internal identifier, when the source has one. */
  materialId?: string | null;
  canonicalDescription: string;
  aliases: string[];
  category?: string | null;
  subcategory?: string | null;
  size?: string | null;
  unit?: string | null;
  manufacturer?: string | null;
  manufacturerPartNumber?: string | null;
  vendorPartNumbers?: Record<string, string> | null;
  preferredVendorId?: string | null;
  active: boolean;
  /** History, when purchasing knows it. Drives the autocomplete ranking. */
  timesRequested?: number;
  lastRequestedAt?: string | null;
  lastUnitCostCents?: number | null;
  source: IntegrationSource;
};

/**
 * The material catalogue.
 *
 * `search` ranks the way the handoff specifies and rankMaterialMatches()
 * implements: exact match, then alias match, then what this company buys
 * OFTEN, then what it bought RECENTLY. That order is a product decision, so it
 * lives in the domain (catalog.mjs) rather than in each adapter's SQL.
 */
export interface MaterialCatalogProvider extends ProviderInfo {
  search(orgId: string, query: string, limit?: number): Promise<MaterialRecord[]>;
  byId(orgId: string, materialId: string): Promise<MaterialRecord | null>;
}

// ---------------------------------------------------------------------------
// VENDORS
// ---------------------------------------------------------------------------

export type VendorRecord = {
  sourceId: string;
  vendorId: string;
  name: string;
  accountNumber?: string | null;
  email?: string | null;
  phone?: string | null;
  active: boolean;
  source: IntegrationSource;
};

export interface VendorDirectoryProvider extends ProviderInfo {
  search(orgId: string, query: string, limit?: number): Promise<VendorRecord[]>;
  byId(orgId: string, vendorId: string): Promise<VendorRecord | null>;
  list(orgId: string): Promise<VendorRecord[]>;
}

// ---------------------------------------------------------------------------
// EMAIL DRAFTS — Microsoft 365 is the intended destination.
//
// This is the seam with the sharpest rule attached to it, because getting it
// wrong means a vendor is told to deliver something nobody approved.
// ---------------------------------------------------------------------------

/**
 * How a finished draft reaches the human who will send it. Every one of these
 * ends with a PERSON pressing send in their own mail client.
 *
 *   display   — the draft is shown in the PCC and copied by hand. Always
 *               available; the floor, not the goal.
 *   mailto    — a mailto: link opens the local client pre-filled. Length-limited
 *               and strips attachments, so it is a convenience, not the path.
 *   eml       — a downloaded .eml the user opens in Outlook. Carries the PO
 *               attachment and the full body, needs no account connection.
 *   graph     — created as a real DRAFT in the user's Microsoft 365 mailbox
 *               (POST /me/messages). It lands in their Drafts folder with their
 *               signature applied by Outlook itself, and THEY send it.
 */
export type EmailHandoff = 'display' | 'mailto' | 'eml' | 'graph';

export type EmailDraftPayload = {
  to: string[];
  cc?: string[];
  subject: string;
  /** Plain text. The body is composed by the domain, never by an adapter. */
  body: string;
  attachments?: Array<{ filename: string; contentType: string; bytes: Buffer }>;
};

export type EmailDraftHandoffResult = {
  handoff: EmailHandoff;
  /** Where the human goes next: a mailto: URL, a download path, a deep link. */
  url?: string | null;
  /** The provider's own id for a draft it created (Graph message id). */
  externalDraftId?: string | null;
  /**
   * ALWAYS FALSE in v1, and typed as false so no code can branch on it being
   * true. A draft handed to a human is not a sent message, and a system that
   * reports "sent" when it means "drafted" teaches people to stop checking.
   */
  sent: false;
};

/**
 * Composition and handoff of the vendor email.
 *
 * `send` is deliberately absent — not unimplemented, ABSENT — so no purchasing
 * code can call it by accident, and so adding one later is a visible change to
 * this interface rather than a quiet change to an adapter.
 *
 * The signature is applied by the user's own mail client. This system does not
 * paste a signature into a body and does not assume Outlook will append one to
 * an .eml it did not create.
 */
export interface EmailDraftProvider extends ProviderInfo {
  /** Which handoffs this deployment can actually offer, best first. */
  readonly handoffs: readonly EmailHandoff[];
  /**
   * Prepare the draft for a human to review and send. Never sends.
   * Implementations MUST refuse a payload with no recipient rather than
   * silently producing a draft addressed to nobody.
   */
  prepare(input: {
    orgId: string;
    actorId: string;
    purchaseOrderId: string;
    payload: EmailDraftPayload;
    prefer?: EmailHandoff;
  }): Promise<EmailDraftHandoffResult>;
}

// ---------------------------------------------------------------------------
// TIME TRACKING — Exact Time.
//
// Declared, not implemented. Purchasing does not need labour hours to buy
// material; the seam exists so that when "what did this job cost" is asked
// across both systems, the answer is assembled through an interface instead of
// a join somebody writes into a purchasing query.
// ---------------------------------------------------------------------------

export type JobLabourSummary = {
  jobNumber: string;
  /** Hours booked to the job in the window. */
  hours: number;
  from: string;
  to: string;
  source: IntegrationSource;
};

export interface TimeTrackingProvider extends ProviderInfo {
  labourForJob(orgId: string, jobNumber: string, from: string, to: string): Promise<JobLabourSummary | null>;
}

// ---------------------------------------------------------------------------
// THE REGISTRY
// ---------------------------------------------------------------------------

/**
 * Every seam, in one bag, hung off the purchasing context. A use case reaches
 * for `ctx.integrations.jobs`, and composition decides what that is.
 *
 * `timeTracking` is nullable because no implementation exists: a null seam is
 * honest, and an adapter that returns empty arrays would be a lie that reads
 * like data.
 */
export type IntegrationProviders = {
  jobs: JobDirectoryProvider;
  materials: MaterialCatalogProvider;
  vendors: VendorDirectoryProvider;
  email: EmailDraftProvider;
  timeTracking: TimeTrackingProvider | null;
};
