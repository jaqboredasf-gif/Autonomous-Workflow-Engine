/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// mappers.ts — rows in, domain records out. The only place the two number
// representations meet.
//
// THE DIVERGENCE, STATED ONCE:
//
//   domain / local store          production Postgres
//   money    integer CENTS        numeric(12,2)
//   quantity integer THOUSANDTHS  numeric(14,3)
//
// Both are exact; neither is floating point. The domain keeps integers because
// `18 × 8640` must never produce 155519.99999999997, and Postgres keeps numeric
// because that is what an accountant expects to read in the table.
//
// Converting between them is the one place a rounding bug could enter the
// system, so it is done by STRING SURGERY rather than arithmetic:
// `parseFixed('86.40', 2)` shifts the decimal point and reads an integer. There
// is no `Math.round(value * 100)` in this file, because that expression is
// wrong for exactly the values nobody tests with.
//
// PostgREST returns numeric as a JSON number or a string depending on
// magnitude and configuration, so every reader accepts both.
// ---------------------------------------------------------------------------

/**
 * Read a decimal (string or number) as a scaled integer.
 * `parseFixed('86.4', 2)` -> 8640. `parseFixed('12.5', 3)` -> 12500.
 */
export function parseFixed(value: unknown, decimals: number): number {
  if (value === null || value === undefined || value === '') return 0;

  const text = typeof value === 'number' ? value.toFixed(decimals) : String(value).trim();
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;

  const [whole, fraction = ''] = digits.split('.');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) {
    throw new Error(`not a decimal value: ${String(value)}`);
  }
  // Pad or truncate the fraction to the scale we store. Truncation would only
  // happen if the database held more precision than the column allows, which
  // the schema forbids — so this is a guard, not a rounding policy.
  const scaled = `${whole}${fraction.padEnd(decimals, '0').slice(0, decimals)}`;
  const magnitude = Number(scaled === '' ? '0' : scaled);
  if (!Number.isSafeInteger(magnitude)) throw new Error(`value out of range: ${String(value)}`);
  return negative ? -magnitude : magnitude;
}

/** Write a scaled integer back as a decimal string Postgres will accept. */
export function formatFixed(scaled: number | null | undefined, decimals: number): string | null {
  if (scaled === null || scaled === undefined) return null;
  const negative = scaled < 0;
  const digits = String(Math.abs(Math.trunc(scaled))).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export const money = {
  /** numeric(12,2) -> integer cents */
  read: (value: unknown) => parseFixed(value, 2),
  /** integer cents -> numeric(12,2) */
  write: (cents: number | null | undefined) => formatFixed(cents, 2),
};

export const qty = {
  /** numeric(14,3) -> integer thousandths */
  read: (value: unknown) => parseFixed(value, 3),
  /** integer thousandths -> numeric(14,3) */
  write: (thousandths: number | null | undefined) => formatFixed(thousandths, 3),
};

/** Nullable money: an unknown estimated cost must stay unknown, not become 0. */
export const nullableMoney = {
  read: (value: unknown) => (value === null || value === undefined ? null : parseFixed(value, 2)),
  write: (cents: number | null | undefined) => (cents === null || cents === undefined ? null : formatFixed(cents, 2)),
};

// ---------------------------------------------------------------------------
// Table names. The production schema prefixes purchasing tables; the local
// store does not. This map is the single translation, and it mirrors
// scripts/lib/validate-migration-0016.mjs (asserted in lockstep by that lint).
// ---------------------------------------------------------------------------

export const TABLES = {
  orgs: 'orgs',
  users: 'users',
  userRoles: 'purchasing_user_roles',
  memberships: 'purchasing_org_memberships',
  invitations: 'purchasing_invitations',
  jobAssignments: 'purchasing_job_assignments',
  vendors: 'purchase_vendors',
  vendorContacts: 'purchase_vendor_contacts',
  deliveryLocations: 'purchase_delivery_locations',
  jobs: 'purchase_jobs',
  itemCatalog: 'purchase_item_catalog',
  /** The immutable record of what was purchased. Migration 0030. */
  historyLines: 'purchase_history_lines',
  requests: 'purchase_requests',
  requestItems: 'purchase_request_items',
  requestAttachments: 'purchase_request_attachments',
  reviews: 'purchase_reviews',
  reviewItems: 'purchase_review_items',
  approvals: 'purchase_approvals',
  /** RETIRED by 0038 — the placeholder global counter. Nothing allocates from it. */
  poSequences: 'po_number_sequences',
  /** One counter per (org, job, vendor). The Lippolis rule. Migration 0038. */
  poPairSequences: 'po_job_vendor_sequences',
  requestSequences: 'request_number_sequences',
  orders: 'purchase_orders',
  orderItems: 'purchase_order_items',
  orderDocuments: 'purchase_order_documents',
  emailTemplates: 'purchase_email_templates',
  emailDrafts: 'purchase_email_drafts',
  receipts: 'purchase_receipts',
  receiptItems: 'purchase_receipt_items',
  receiptAttachments: 'purchase_receipt_attachments',
  inventoryObservations: 'inventory_observations',
  inventoryAdjustments: 'inventory_adjustments',
  activityLog: 'purchase_activity_log',
  notifications: 'purchase_notifications',
  settings: 'purchasing_settings',
} as const;

// ---------------------------------------------------------------------------
// Row -> domain record. Same shapes the SQLite mapper produces, so nothing
// above infrastructure can tell which provider answered.
// ---------------------------------------------------------------------------

export function toRequest(row: any): any {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    requestNumber: row.request_number,
    jobNumber: row.job_number,
    requestorId: row.requestor_id,
    requestorName: row.requestor?.full_name ?? undefined,
    createdBy: row.created_by,
    status: row.status,
    needByDate: row.need_by_date,
    needByTime: typeof row.need_by_time === 'string' ? row.need_by_time.slice(0, 5) : row.need_by_time,
    deliveryLocationId: row.delivery_location_id,
    deliveryLocationName: row.delivery_location?.name ?? undefined,
    deliveryLocationKind: row.delivery_location?.kind ?? null,
    deliveryAddress: row.delivery_location?.address ?? undefined,
    deliveryMethod: row.delivery_method,
    reason: row.reason ?? null,
    notes: row.notes ?? null,
    submittedAt: row.submitted_at ?? null,
    approverId: row.approver_id ?? null,
    approverName: row.approver?.full_name ?? null,
    decidedAt: row.decided_at ?? null,
    decisionNotes: row.decision_notes ?? null,
    rejectionReason: row.rejection_reason ?? null,
    clarificationQuestion: row.clarification_question ?? null,
    clarificationAnswer: row.clarification_answer ?? null,
    vendorId: row.vendor_id ?? null,
    vendorName: row.vendor?.name ?? null,
    estimatedTotalCents: money.read(row.estimated_total),
    expectedArrivalDate: row.expected_arrival_date ?? null,
    trackingNumber: row.tracking_number ?? null,
    trackingCarrier: row.tracking_carrier ?? null,
    orderedAt: row.ordered_at ?? null,
    receivedAt: row.received_at ?? null,
    completedAt: row.completed_at ?? null,
    cancelReason: row.cancel_reason ?? null,
    version: Number(row.version ?? 1),
    createdAt: row.created_at,
    poNumber: row.purchase_order?.[0]?.po_number ?? row.po_number ?? null,
  };
}

export function toRequestItem(row: any): any {
  return {
    id: row.id,
    requestId: row.request_id,
    lineNo: Number(row.line_no),
    description: row.description,
    requestedQty: qty.read(row.requested_qty),
    unit: row.unit,
    stockNumber: row.stock_number ?? null,
    notes: row.notes ?? null,
  };
}

/**
 * The requestor's line and the workshop's line, joined but never merged.
 * `requestedQty` comes from the request item and cannot be written through
 * this shape — the same guarantee the local provider gives.
 */
export function toReviewLine(item: any, review: any | null, vendorName: string | null): any {
  return {
    id: review?.id ?? null,
    requestItemId: item.id,
    lineNo: Number(item.line_no),
    description: item.description,
    unit: item.unit,
    requestedQty: qty.read(item.requested_qty),
    usableStockQty: qty.read(review?.usable_stock_qty ?? 0),
    approvedQty: review ? qty.read(review.approved_qty) : qty.read(item.requested_qty),
    suggestedOrderQty: qty.read(review?.suggested_order_qty ?? 0),
    finalOrderQty: qty.read(review?.final_order_qty ?? 0),
    stockAppliedQty: qty.read(review?.stock_applied_qty ?? 0),
    replenishmentQty: qty.read(review?.replenishment_qty ?? 0),
    vendorId: review?.vendor_id ?? null,
    vendorName,
    estimatedUnitCostCents: nullableMoney.read(review?.estimated_unit_cost),
    estimatedLineTotalCents: money.read(review?.estimated_line_total ?? 0),
    substituteDescription: review?.substitute_description ?? null,
    expectedArrivalDate: review?.expected_arrival_date ?? null,
    lineNotes: review?.line_notes ?? null,
    overrideReason: review?.override_reason ?? null,
  };
}

export function toOrder(row: any): any {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    requestId: row.request_id,
    poNumber: row.po_number,
    sequenceValue: Number(row.sequence_value),
    vendorId: row.vendor_id,
    vendorCode: row.vendor_code ?? null,
    vendorContactId: row.vendor_contact_id ?? null,
    jobNumber: row.job_number,
    approverId: row.approver_id,
    estimatedTotalCents: money.read(row.estimated_total),
    status: row.status,
    generatedAt: row.generated_at,
  };
}

export function toOrderItem(row: any): any {
  return {
    ...row,
    order_qty: qty.read(row.order_qty),
    unit_cost_cents: money.read(row.unit_cost),
    line_total_cents: money.read(row.line_total),
    // The actual cost is nullable on purpose: NULL means "not reconciled yet",
    // and money.read() would turn that into 0 — a purchase that cost nothing.
    // History snapshots this, so both providers must present it the same way.
    actual_unit_cost_cents: nullableMoney.read(row.actual_unit_cost ?? null),
    actual_line_total_cents: nullableMoney.read(row.actual_line_total ?? null),
  };
}

export function toEmailDraft(row: any): any {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    requestId: row.request_id,
    purchaseOrderId: row.purchase_order_id ?? null,
    templateKey: row.template_key,
    status: row.status,
    subject: row.subject,
    body: row.body,
    to: row.to_addrs ?? [],
    cc: row.cc_addrs ?? [],
    attachments: row.attachments ?? [],
    draftKey: row.draft_key,
    generatedAt: row.generated_at,
    reviewedAt: row.reviewed_at ?? null,
    reviewedBy: row.reviewed_by ?? null,
    sentAt: row.sent_at ?? null,
    externalSendEnabled: Boolean(row.external_send_enabled),
  };
}

export function toReceipt(row: any, items: any[]): any {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    requestId: row.request_id,
    purchaseOrderId: row.purchase_order_id ?? null,
    receivedDate: row.received_date,
    receivedBy: row.received_by,
    packingSlipNumber: row.packing_slip_number,
    notes: row.notes,
    isFinal: Boolean(row.is_final),
    createdAt: row.created_at,
    items: items.map((i) => ({
      ...i,
      received_qty: qty.read(i.received_qty),
      damaged_qty: qty.read(i.damaged_qty),
      backordered_qty: qty.read(i.backordered_qty),
      written_off_qty: qty.read(i.written_off_qty),
    })),
  };
}

export function toActor(row: any, roles: string[], assignedJobNumbers: string[]): any {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.full_name,
    email: row.email,
    roles,
    canApprove: Boolean(row.purchasing_can_approve),
    isActive: Boolean(row.is_active),
    isPrimaryApprover: Boolean(row.purchasing_is_primary_approver),
    isBackupApprover: Boolean(row.purchasing_is_backup_approver),
    isDeliveryReceiver: Boolean(row.purchasing_is_delivery_receiver),
    assignedJobNumbers,
  };
}
