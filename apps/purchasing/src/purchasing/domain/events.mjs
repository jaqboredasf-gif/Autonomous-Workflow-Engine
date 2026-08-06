// ---------------------------------------------------------------------------
// events.mjs — Purchasing domain events.
//
// PURE builders. A use case returns events; the application layer hands them to
// the AuditPort and the NotificationPort. Purchasing does not own audit storage
// or notification delivery — it owns the STATEMENT that something happened, in
// its own vocabulary.
//
// Two vocabularies, deliberately separate:
//   * `action`   — the audit statement (activity.mjs ACTIVITY_ACTIONS)
//   * `notify`   — the integration event other parts of AWE subscribe to
//                  (activity.mjs NOTIFICATION_EVENTS), named on the existing
//                  `<entity>.<past-tense>` emit_event contract.
//
// An event with a `notify` is a fact the rest of the business cares about. An
// event without one is a fact only the purchasing record cares about.
// ---------------------------------------------------------------------------

import { isActivityAction, isNotificationEvent } from './activity.mjs';

/**
 * @param {object} spec
 * @param {string} spec.action      one of ACTIVITY_ACTIONS
 * @param {string} spec.entityType
 * @param {string} [spec.entityId]
 * @param {string} [spec.requestId] correlation id — the request this belongs to
 * @param {object} [spec.before]    previous values, where a change was made
 * @param {object} [spec.after]     new values
 * @param {string} [spec.notes]
 * @param {string} [spec.notify]    one of NOTIFICATION_EVENTS
 * @param {object} [spec.payload]   notification payload
 */
export function domainEvent(spec) {
  if (!isActivityAction(spec.action)) {
    throw new Error(`unknown purchasing activity action: ${spec.action}`);
  }
  if (spec.notify && !isNotificationEvent(spec.notify)) {
    throw new Error(`unknown purchasing notification event: ${spec.notify}`);
  }
  return Object.freeze({
    action: spec.action,
    entityType: spec.entityType,
    entityId: spec.entityId ?? null,
    requestId: spec.requestId ?? null,
    before: spec.before ?? null,
    after: spec.after ?? null,
    notes: spec.notes ?? null,
    notify: spec.notify ?? null,
    payload: spec.payload ?? {},
  });
}

// --- the named events, so a use case never spells one wrong ------------------

export const events = {
  requestCreated: (request, extra = {}) =>
    domainEvent({
      action: 'request.created', entityType: 'purchase_request', entityId: request.id, requestId: request.id,
      after: { requestNumber: request.requestNumber, jobNumber: request.jobNumber, needByDate: request.needByDate, needByTime: request.needByTime, ...extra },
    }),

  requestUpdated: (requestId, before, after) =>
    domainEvent({ action: 'request.updated', entityType: 'purchase_request', entityId: requestId, requestId, before, after }),

  purchasingFieldsRejected: (requestId, fields) =>
    domainEvent({
      action: 'validation.rejected_fields', entityType: 'purchase_request', entityId: requestId, requestId,
      after: { fields }, notes: 'purchasing fields are set in workshop review, not at intake',
    }),

  requestSubmitted: (request) =>
    domainEvent({
      action: 'request.submitted', entityType: 'purchase_request', entityId: request.id, requestId: request.id,
      before: { status: request.status }, after: { status: 'SUBMITTED' },
      notify: 'purchase_request.submitted', payload: { requestNumber: request.requestNumber },
    }),

  awaitingReview: (request) =>
    domainEvent({
      action: 'request.submitted', entityType: 'purchase_request', entityId: request.id, requestId: request.id,
      after: { status: 'PENDING_WORKSHOP_REVIEW' },
      notify: 'purchase_request.awaiting_review', payload: { requestNumber: request.requestNumber },
    }),

  stockRecorded: (requestId, lineId, before, after, notes) =>
    domainEvent({ action: 'review.stock_recorded', entityType: 'purchase_review_item', entityId: lineId, requestId, before, after, notes }),

  vendorSelected: (requestId, lineId, vendorId, vendorName) =>
    domainEvent({ action: 'review.vendor_selected', entityType: 'purchase_review_item', entityId: lineId, requestId, after: { vendorId, vendorName } }),

  reviewSaved: (requestId, reviewId, totals) =>
    domainEvent({ action: 'review.saved', entityType: 'purchase_review', entityId: reviewId, requestId, after: totals }),

  approved: (request, changes, notes) =>
    domainEvent({
      action: 'decision.approved', entityType: 'purchase_request', entityId: request.id, requestId: request.id,
      before: { status: request.status }, after: { status: 'APPROVED', changes }, notes,
      notify: 'purchase_request.approved', payload: { requestNumber: request.requestNumber },
    }),

  rejected: (request, reason) =>
    domainEvent({
      action: 'decision.rejected', entityType: 'purchase_request', entityId: request.id, requestId: request.id,
      before: { status: request.status }, after: { status: 'REJECTED' }, notes: reason,
      notify: 'purchase_request.rejected', payload: { reason },
    }),

  clarificationRequested: (request, question) =>
    domainEvent({
      action: 'clarification.requested', entityType: 'purchase_request', entityId: request.id, requestId: request.id,
      before: { status: request.status }, after: { status: 'CLARIFICATION_REQUESTED' }, notes: question,
      notify: 'purchase_request.clarification_requested', payload: { question },
    }),

  clarificationAnswered: (request, answer) =>
    domainEvent({
      action: 'clarification.answered', entityType: 'purchase_request', entityId: request.id, requestId: request.id,
      notes: answer, notify: 'purchase_request.awaiting_review', payload: {},
    }),

  poGenerated: (request, order) =>
    domainEvent({
      action: 'po.generated', entityType: 'purchase_order', entityId: order.id, requestId: request.id,
      after: { poNumber: order.poNumber, vendorId: order.vendorId, estimatedTotalCents: order.estimatedTotalCents, lines: order.items?.length },
      notify: 'purchase_order.generated', payload: { poNumber: order.poNumber },
    }),

  poDocumentGenerated: (requestId, document) =>
    domainEvent({
      action: 'po.document_generated', entityType: 'purchase_order_document', entityId: document.id, requestId,
      after: { filename: document.filename, bytes: document.byteSize },
    }),

  emailDraftGenerated: (requestId, draft, poNumber) =>
    domainEvent({
      action: 'email.draft_generated', entityType: 'purchase_email_draft', entityId: draft.id, requestId,
      after: { type: draft.templateKey, to: draft.to, poNumber },
      notify: 'purchase_email.draft_ready', payload: { poNumber },
    }),

  emailDraftAdvanced: (requestId, draftId, from, to, notes) =>
    domainEvent({
      action: to === 'REVIEWED' ? 'email.draft_reviewed'
        : to === 'APPROVED_TO_SEND' ? 'email.draft_approved_to_send'
        : to === 'SENT' ? 'email.marked_sent'
        : 'email.draft_generated',
      entityType: 'purchase_email_draft', entityId: draftId, requestId,
      before: { status: from }, after: { status: to }, notes,
    }),

  orderPlaced: (request, notes) =>
    domainEvent({
      action: 'order.placed', entityType: 'purchase_request', entityId: request.id, requestId: request.id,
      before: { status: request.status }, after: { status: 'ORDERED' }, notes,
    }),

  trackingUpdated: (requestId, before, after) =>
    domainEvent({ action: 'order.tracking_updated', entityType: 'purchase_request', entityId: requestId, requestId, before, after }),

  receiptRecorded: (requestId, receiptId, after) =>
    domainEvent({ action: 'receipt.recorded', entityType: 'purchase_receipt', entityId: receiptId, requestId, after }),

  receiptPartial: (requestId, receiptId, outstandingLines) =>
    domainEvent({
      action: 'receipt.partial', entityType: 'purchase_receipt', entityId: receiptId, requestId,
      after: { outstandingLines }, notify: 'purchase_receipt.partial', payload: { outstandingLines },
    }),

  receiptCompleted: (requestId, receiptId, receivedDate) =>
    domainEvent({
      action: 'receipt.completed', entityType: 'purchase_receipt', entityId: receiptId, requestId,
      after: { receivedDate, outstandingLines: 0 }, notify: 'purchase_receipt.completed', payload: {},
    }),

  materialReady: (requestId) =>
    domainEvent({
      action: 'receipt.completed', entityType: 'purchase_request', entityId: requestId, requestId,
      notify: 'purchase_material.ready_for_pickup', payload: {},
    }),

  inventoryObserved: (requestId, itemId, after) =>
    domainEvent({ action: 'inventory.observed', entityType: 'inventory_observation', entityId: itemId, requestId, after }),

  inventoryAdjusted: (requestId, itemId, after) =>
    domainEvent({ action: 'inventory.adjusted', entityType: 'inventory_adjustment', entityId: itemId, requestId, after }),

  requestCompleted: (request, notes) =>
    domainEvent({
      action: 'request.completed', entityType: 'purchase_request', entityId: request.id, requestId: request.id,
      before: { status: request.status }, after: { status: 'COMPLETED' }, notes,
    }),

  requestCancelled: (request, reason) =>
    domainEvent({
      action: 'request.cancelled', entityType: 'purchase_request', entityId: request.id, requestId: request.id,
      before: { status: request.status }, after: { status: 'CANCELLED' }, notes: reason,
    }),

  noteAdded: (requestId, note) =>
    domainEvent({ action: 'request.note_added', entityType: 'purchase_request', entityId: requestId, requestId, notes: note }),

  attachmentAdded: (requestId, attachment) =>
    domainEvent({
      action: 'request.attachment_added', entityType: 'purchase_request_attachment',
      entityId: attachment.id, requestId, after: { filename: attachment.filename },
    }),

  accessDenied: (requestId, permission, reason, message) =>
    domainEvent({
      action: 'authz.denied', entityType: 'purchase_request', entityId: requestId, requestId,
      after: { permission, reason }, notes: message,
    }),

  poConfigChanged: (before, after) =>
    domainEvent({ action: 'admin.po_config_changed', entityType: 'po_number_sequence', before, after, notes: 'PO numbering configuration changed' }),

  approvalAuthorityChanged: (userId, before, after, notes) =>
    domainEvent({ action: 'admin.approval_authority_changed', entityType: 'user', entityId: userId, before, after, notes }),
};
