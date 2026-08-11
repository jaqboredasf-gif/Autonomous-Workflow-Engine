/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// repositories.ts — repository INTERFACES, owned by the domain.
//
// Types only: this file compiles to nothing. The domain states what it needs to
// load and save; infrastructure decides how (SQLite for the pilot, Supabase in
// production). No SQL, no table names and no `snake_case` may appear above this
// line — repositories return domain-shaped records.
//
// Rules of the boundary:
//   * repositories take and return plain, serializable records
//   * every method is ASYNC. The local store answers immediately and resolves
//     in the same tick, but a network-backed provider cannot, and an interface
//     only a local database can satisfy is not a boundary — it is the local
//     database wearing one. Async here is a real persistence boundary, not
//     decoration: pure domain calculation stays synchronous.
//   * a repository NEVER decides. It has no opinion on status, permission or
//     arithmetic — those live in the domain and are checked in use cases.
// ---------------------------------------------------------------------------

export type Id = string;

export type PurchaseRequestRecord = {
  id: Id;
  orgId: Id;
  requestNumber: string;
  jobNumber: string;
  requestorId: Id;
  requestorName?: string;
  createdBy: Id;
  status: string;
  needByDate: string;
  needByTime: string;
  deliveryLocationId: Id;
  deliveryLocationName?: string;
  /**
   * `purchase_location_kind` for the destination — JOBSITE, WORKSHOP, OFFICE or
   * VENDOR_PICKUP. Receiving authority is scoped by WHERE the material lands
   * (see mayReceiveAt), so the destination's kind has to reach the domain.
   */
  deliveryLocationKind?: string | null;
  deliveryAddress?: string;
  deliveryMethod: string;
  reason: string | null;
  notes: string | null;
  submittedAt: string | null;
  approverId: Id | null;
  approverName?: string | null;
  decidedAt: string | null;
  decisionNotes: string | null;
  rejectionReason: string | null;
  clarificationQuestion: string | null;
  clarificationAnswer: string | null;
  vendorId: Id | null;
  vendorName?: string | null;
  estimatedTotalCents: number;
  expectedArrivalDate: string | null;
  trackingNumber: string | null;
  trackingCarrier: string | null;
  orderedAt: string | null;
  receivedAt: string | null;
  completedAt: string | null;
  cancelReason: string | null;
  version: number;
  createdAt: string;
  poNumber?: string | null;
};

export type RequestItemRecord = {
  id: Id;
  requestId: Id;
  lineNo: number;
  description: string;
  requestedQty: number;
  unit: string;
  stockNumber: string | null;
  notes: string | null;
};

export type ReviewLineRecord = {
  id: Id | null;
  requestItemId: Id;
  lineNo: number;
  description: string;
  unit: string;
  requestedQty: number;
  usableStockQty: number;
  approvedQty: number;
  suggestedOrderQty: number;
  finalOrderQty: number;
  stockAppliedQty: number;
  replenishmentQty: number;
  vendorId: Id | null;
  vendorName: string | null;
  estimatedUnitCostCents: number | null;
  estimatedLineTotalCents: number;
  substituteDescription: string | null;
  expectedArrivalDate: string | null;
  lineNotes: string | null;
  overrideReason: string | null;
};

export type LineProgressRecord = {
  purchaseOrderItemId: Id;
  requestItemId: Id;
  description: string;
  unit: string;
  finalOrderQty: number;
  receivedQty: number;
  damagedQty: number;
  backorderedQty: number;
  writtenOffQty: number;
  outstandingQty: number;
};

export interface PurchaseRequestRepository {
  nextRequestNumber(orgId: Id): Promise<string>;
  insert(record: any): Promise<PurchaseRequestRecord>;
  findById(id: Id): Promise<PurchaseRequestRecord | null>;
  listForOrg(orgId: Id): Promise<PurchaseRequestRecord[]>;
  listForRequestor(orgId: Id, userId: Id): Promise<PurchaseRequestRecord[]>;
  /** Optimistic write: fails if `version` moved under us. */
  update(id: Id, expectedVersion: number, patch: Record<string, unknown>): Promise<void>;
  /** Non-versioned field write (tracking, totals) — never a status change. */
  patch(id: Id, patch: Record<string, unknown>): Promise<void>;
  itemsFor(requestId: Id): Promise<RequestItemRecord[]>;
  replaceItems(requestId: Id, items: any[], actorId: Id, now: string): Promise<void>;
  attachmentsFor(requestId: Id): Promise<any[]>;
}

export interface WorkshopReviewRepository {
  findByRequest(requestId: Id): Promise<{ id: Id; requestId: Id; savedAt: string | null; workshopNotes: string | null } | null>;
  open(requestId: Id, reviewerId: Id, now: string): Promise<{ id: Id }>;
  saveLine(reviewId: Id, requestItemId: Id, values: Record<string, unknown>, actorId: Id, now: string): Promise<{ previous: any }>;
  linesFor(requestId: Id): Promise<ReviewLineRecord[]>;
  markSaved(reviewId: Id, reviewerId: Id, workshopNotes: string | null, now: string): Promise<void>;
}

export interface ApprovalRepository {
  /**
   * `selfApproved` is BR-011's audit stamp: the approver held the approval
   * capability AND raised the request. It records a fact, it does not gate one.
   */
  record(requestId: Id, approverId: Id, decision: string, notes: string | null, reason: string | null, changes: unknown, now: string, selfApproved?: boolean): Promise<void>;
  listForRequest(requestId: Id): Promise<any[]>;
}

export interface PurchaseOrderRepository {
  findByRequest(requestId: Id): Promise<any | null>;
  findById(id: Id): Promise<any | null>;
  insert(order: any, now: string): Promise<{ id: Id; poNumber: string }>;
  itemsFor(purchaseOrderId: Id): Promise<any[]>;
  progressFor(requestId: Id): Promise<LineProgressRecord[]>;
  /** Everything the PO template and the vendor email need, in one shape. */
  view(purchaseOrderId: Id): Promise<any>;

  /**
   * What was actually paid, once an invoice says so.
   *
   * Separate from everything else on purpose: an actual cost arrives days or
   * weeks after the material did, from a different person, and must never be a
   * precondition for ordering or receiving. NULL means "not reconciled yet",
   * which is not the same as zero.
   */
  recordActualCost(
    orgId: Id, purchaseOrderId: Id,
    input: { actualTotalCents: number | null; source: string | null; reference: string | null },
    actorId: Id, now: string,
  ): Promise<void>;
}

export interface EmailDraftRepository {
  findByKey(orgId: Id, draftKey: string): Promise<any | null>;
  findById(id: Id): Promise<any | null>;
  listForRequest(requestId: Id): Promise<any[]>;
  insert(draft: any, now: string): Promise<{ id: Id }>;
  updateContent(id: Id, patch: { subject?: string; body?: string }, now: string): Promise<void>;
  updateStatus(id: Id, columns: Record<string, unknown>): Promise<void>;
}

export interface ReceiptRepository {
  insert(receipt: any, now: string): Promise<{ id: Id }>;
  insertLine(receiptId: Id, line: any, now: string): Promise<void>;
  markFinal(receiptId: Id): Promise<void>;
  listForRequest(requestId: Id): Promise<any[]>;
  findById(id: Id): Promise<any | null>;
  attach(receiptId: Id, file: any, actorId: Id, now: string): Promise<void>;
  attachmentsFor(receiptId: Id): Promise<any[]>;
}

export interface InventoryRepository {
  observe(record: any, now: string): Promise<void>;
  adjust(record: any, now: string): Promise<void>;
}

export interface ReferenceRepository {
  vendors(orgId: Id): Promise<any[]>;
  primaryContact(vendorId: Id): Promise<any | null>;

  // --- vendor and job DIRECTORY writes ------------------------------------
  // An organization configures its own suppliers and job sites. Without these
  // a new customer needs a developer to insert rows, which is the difference
  // between a product and a bespoke install.
  //
  // `vendorByName` and `jobByNumber` exist because both directories have a
  // natural key the user actually types. Looking it up first turns "unique
  // constraint violated" into "you already have a vendor called that".
  vendorByName(orgId: Id, name: string): Promise<any | null>;
  createVendor(orgId: Id, input: Record<string, unknown>, actorId: Id, now: string): Promise<Id>;
  updateVendor(orgId: Id, vendorId: Id, patch: Record<string, unknown>, actorId: Id, now: string): Promise<void>;
  setVendorPrimaryContact(orgId: Id, vendorId: Id, contact: Record<string, unknown>, now: string): Promise<void>;

  jobByNumber(orgId: Id, jobNumber: string): Promise<any | null>;
  createJob(orgId: Id, input: Record<string, unknown>, actorId: Id, now: string): Promise<Id>;
  updateJob(orgId: Id, jobId: Id, patch: Record<string, unknown>, actorId: Id, now: string): Promise<void>;
  deliveryLocations(orgId: Id): Promise<any[]>;
  jobs(orgId: Id): Promise<any[]>;
  users(orgId: Id): Promise<any[]>;
  settings(orgId: Id): Promise<any>;
  emailTemplate(orgId: Id, key: string): Promise<any | null>;
  emailTemplates(orgId: Id): Promise<any[]>;
  poConfig(orgId: Id): Promise<any>;
  updatePoConfig(orgId: Id, patch: Record<string, unknown>, actorId: Id, now: string): Promise<void>;
  setApprovalAuthority(userId: Id, canApprove: boolean, actorId: Id, now: string): Promise<void>;
}

/**
 * One thing an organization buys, as its purchasing history describes it.
 *
 * READ ONLY, on purpose. `purchase_item_catalog` exists in both schemas for
 * curated entries, but nothing in the workflow writes it yet, and migration
 * 0018 is explicit that ranking is a QUERY rather than a stored counter — a
 * `times_ordered` column drifts the moment anything writes a line item without
 * updating it. So this reads the line items themselves, which already carry
 * the `normalized_description` that domain/catalog.mjs computed when they were
 * written, and folds the curated catalog row over the top where one exists.
 *
 * That means the catalog is correct on day one of this screen existing,
 * without a backfill and without a second write path to keep in step.
 */
export type CatalogEntry = {
  /** The curated row's id, when this item has been curated. Otherwise null. */
  catalogItemId: Id | null;
  /** The matching key — what "the same thing, typed differently" collapses to. */
  normalizedDescription: string;
  /** What the organization sees offered. Curated name if there is one. */
  canonicalDescription: string;
  /** Every distinct spelling seen in history. The alias list. */
  aliases: string[];
  defaultUnit: string | null;
  catalogNumber: string | null;
  /** How many request lines have asked for it. */
  timesRequested: number;
  totalQtyRequested: number;
  lastRequestedAt: string | null;
  /** The vendor it was last actually bought from, when it has been. */
  lastVendorId: Id | null;
  lastVendorName: string | null;
  lastUnitCostCents: number | null;
  lastOrderedAt: string | null;
  isActive: boolean;
};

export interface ItemCatalogRepository {
  /**
   * The organization's catalogue. `search` matches the canonical form, any
   * alias, or a part number — matching on the NORMALIZED text, so "2 x 4" and
   * "2x4" find each other the way the domain says they should.
   */
  list(orgId: Id, options?: { search?: string; limit?: number; activeOnly?: boolean }): Promise<CatalogEntry[]>;
  /** Ranked for autocomplete: what this organization asks for most, and most recently. */
  suggest(orgId: Id, query: string, limit?: number): Promise<CatalogEntry[]>;
  /** One entry by its matching key. */
  findByNormalized(orgId: Id, normalizedDescription: string): Promise<CatalogEntry | null>;
  /** What a vendor is actually bought for — the vendor profile's materials list. */
  forVendor(vendorId: Id, limit?: number): Promise<CatalogEntry[]>;
}

/**
 * ONE LINE OF PURCHASING HISTORY, as it was when the request ended.
 *
 * The fields are built by domain/history.mjs and written once. Every `*Name`
 * and `*Number` field is a SNAPSHOT: renaming the vendor, re-describing the
 * material or re-numbering a job changes the entity, never this row.
 *
 * Both an id and a snapshot are present for the same thing on purpose — the id
 * keeps the row joinable to current data, the snapshot keeps it true.
 */
export type PurchaseHistoryLineRecord = {
  id?: Id;
  orgId: Id;

  terminalState: string;
  terminalReason: string | null;
  recordedAt: string;
  recordedBy: Id;

  requestId: Id;
  requestNumber: string;
  requestItemId: Id;
  lineNo: number;
  purchaseOrderId: Id | null;
  poNumber: string | null;
  purchaseOrderItemId: Id | null;
  jobId: Id | null;
  jobNumber: string;
  catalogItemId: Id | null;

  normalizedDescription: string;
  normalizerVersion: number;
  requestedDescription: string;
  orderedDescription: string | null;
  unit: string;
  requestedQty: number;
  orderedQty: number;

  vendorId: Id | null;
  vendorName: string | null;
  vendorPartNumber: string | null;

  estimatedUnitCostCents: number | null;
  estimatedLineTotalCents: number | null;
  actualUnitCostCents: number | null;
  actualLineTotalCents: number | null;

  requestorId: Id;
  requestorName: string | null;
  approverId: Id | null;
  approverName: string | null;

  requestedAt: string | null;
  poGeneratedAt: string | null;
  orderedAt: string | null;
  receivedAt: string | null;
  completedAt: string | null;

  receivedQty: number;
  damagedQty: number;
  backorderedQty: number;
  writtenOffQty: number;
  outcome: string;
};

/**
 * IMMUTABLE PURCHASING HISTORY.
 *
 * There is no update method and no delete method, and that is the interface's
 * whole point: BR-012 makes completed purchasing activity evidence. A correction
 * is a new request, exactly as a miscounted receipt is a new receipt.
 *
 * `record` is idempotent by (orgId, requestId, requestItemId). Asking twice —
 * a retried transaction, a replayed event, an operator re-running a backfill —
 * writes nothing the second time and reports how many rows were new. It must
 * never raise on a duplicate: history that refuses to be written twice would
 * turn a harmless retry into a failed completion.
 */
export interface PurchaseHistoryRepository {
  record(lines: PurchaseHistoryLineRecord[], now: string): Promise<{ inserted: number; skipped: number }>;
  /** The rows written for one request. Empty until it reaches a terminal state. */
  forRequest(orgId: Id, requestId: Id): Promise<PurchaseHistoryLineRecord[]>;
  /** An organization's whole history, newest first. The derived read model's input. */
  listForOrg(orgId: Id, options?: { limit?: number; normalizedDescription?: string; vendorId?: Id }): Promise<PurchaseHistoryLineRecord[]>;
}

/**
 * PO numbering is a repository, not a service: the number comes from durable,
 * transactional storage or it is not safe. The implementation holds the write
 * lock; nothing above this interface may invent a number.
 */
export interface PoNumberAllocator {
  allocate(orgId: Id, now: string): Promise<{ poNumber: string; sequenceValue: number }>;
}
