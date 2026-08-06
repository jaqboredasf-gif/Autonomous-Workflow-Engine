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
  record(requestId: Id, approverId: Id, decision: string, notes: string | null, reason: string | null, changes: unknown, now: string): Promise<void>;
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
 * PO numbering is a repository, not a service: the number comes from durable,
 * transactional storage or it is not safe. The implementation holds the write
 * lock; nothing above this interface may invent a number.
 */
export interface PoNumberAllocator {
  allocate(orgId: Id, now: string): Promise<{ poNumber: string; sequenceValue: number }>;
}
