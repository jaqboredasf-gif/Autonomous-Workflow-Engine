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
//   * every method is synchronous, because the pilot store is synchronous and
//     the production adapter will run inside a server action that awaits once,
//     at the edge (see application/ports.ts, UnitOfWork)
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
  nextRequestNumber(orgId: Id): string;
  insert(record: any): PurchaseRequestRecord;
  findById(id: Id): PurchaseRequestRecord | null;
  listForOrg(orgId: Id): PurchaseRequestRecord[];
  listForRequestor(orgId: Id, userId: Id): PurchaseRequestRecord[];
  /** Optimistic write: fails if `version` moved under us. */
  update(id: Id, expectedVersion: number, patch: Record<string, unknown>): void;
  /** Non-versioned field write (tracking, totals) — never a status change. */
  patch(id: Id, patch: Record<string, unknown>): void;
  itemsFor(requestId: Id): RequestItemRecord[];
  replaceItems(requestId: Id, items: any[], actorId: Id, now: string): void;
  attachmentsFor(requestId: Id): any[];
}

export interface WorkshopReviewRepository {
  findByRequest(requestId: Id): { id: Id; requestId: Id; savedAt: string | null; workshopNotes: string | null } | null;
  open(requestId: Id, reviewerId: Id, now: string): { id: Id };
  saveLine(reviewId: Id, requestItemId: Id, values: Record<string, unknown>, actorId: Id, now: string): { previous: any };
  linesFor(requestId: Id): ReviewLineRecord[];
  markSaved(reviewId: Id, reviewerId: Id, workshopNotes: string | null, now: string): void;
}

export interface ApprovalRepository {
  record(requestId: Id, approverId: Id, decision: string, notes: string | null, reason: string | null, changes: unknown, now: string): void;
  listForRequest(requestId: Id): any[];
}

export interface PurchaseOrderRepository {
  findByRequest(requestId: Id): any | null;
  findById(id: Id): any | null;
  insert(order: any, now: string): { id: Id; poNumber: string };
  itemsFor(purchaseOrderId: Id): any[];
  progressFor(requestId: Id): LineProgressRecord[];
  /** Everything the PO template and the vendor email need, in one shape. */
  view(purchaseOrderId: Id): any;
}

export interface EmailDraftRepository {
  findByKey(orgId: Id, draftKey: string): any | null;
  findById(id: Id): any | null;
  listForRequest(requestId: Id): any[];
  insert(draft: any, now: string): { id: Id };
  updateContent(id: Id, patch: { subject?: string; body?: string }, now: string): void;
  updateStatus(id: Id, columns: Record<string, unknown>): void;
}

export interface ReceiptRepository {
  insert(receipt: any, now: string): { id: Id };
  insertLine(receiptId: Id, line: any, now: string): void;
  markFinal(receiptId: Id): void;
  listForRequest(requestId: Id): any[];
  attach(receiptId: Id, file: any, actorId: Id, now: string): void;
}

export interface InventoryRepository {
  observe(record: any, now: string): void;
  adjust(record: any, now: string): void;
}

export interface ReferenceRepository {
  vendors(orgId: Id): any[];
  primaryContact(vendorId: Id): any | null;
  deliveryLocations(orgId: Id): any[];
  jobs(orgId: Id): any[];
  users(orgId: Id): any[];
  settings(orgId: Id): any;
  emailTemplate(orgId: Id, key: string): any | null;
  emailTemplates(orgId: Id): any[];
  poConfig(orgId: Id): any;
  updatePoConfig(orgId: Id, patch: Record<string, unknown>, actorId: Id, now: string): void;
  setApprovalAuthority(userId: Id, canApprove: boolean, actorId: Id, now: string): void;
}

/**
 * PO numbering is a repository, not a service: the number comes from durable,
 * transactional storage or it is not safe. The implementation holds the write
 * lock; nothing above this interface may invent a number.
 */
export interface PoNumberAllocator {
  allocate(orgId: Id, now: string): { poNumber: string; sequenceValue: number };
}
