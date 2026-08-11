// ---------------------------------------------------------------------------
// activity.mjs — the audit vocabulary and the notification event contract.
//
// PURE. Two closed vocabularies:
//   ACTIVITY_ACTIONS   — what goes in purchase_activity_log (§13)
//   NOTIFICATION_EVENTS— what the notification layer subscribes to (§11)
//
// The notification names follow the existing AWE integration-events contract
// (0009's emit_event: dotted lowercase, `<entity>.<past-tense>`), so when this
// module runs against Supabase the same rows land in `integration_events` and
// the existing n8n consumers see purchasing traffic without a second bus.
// ---------------------------------------------------------------------------

/** Every auditable action. One per meaningful thing a human or the system does. */
export const ACTIVITY_ACTIONS = [
  'request.created',
  'request.updated',
  'request.submitted',
  'request.item_added',
  'request.item_updated',
  'request.item_removed',
  'request.attachment_added',
  'request.note_added',
  'request.cancelled',
  'clarification.requested',
  'clarification.answered',
  'review.stock_recorded',
  'review.quantity_changed',
  'review.vendor_selected',
  'review.cost_changed',
  'review.substitute_set',
  'review.saved',
  'decision.approved',
  'decision.rejected',
  'po.generated',
  'po.document_generated',
  'email.draft_generated',
  'email.draft_reviewed',
  'email.draft_approved_to_send',
  'email.marked_sent',
  // A draft can also end without being sent. Both endings were reachable in the
  // state machine and neither had a name in the audit vocabulary, so a
  // cancelled or failed draft recorded nothing describing what became of it.
  'email.draft_cancelled',
  'email.draft_failed',
  'order.placed',
  'order.tracking_updated',
  'receipt.recorded',
  'receipt.partial',
  'receipt.completed',
  'inventory.observed',
  'inventory.adjusted',
  'request.completed',
  'authz.denied',
  'validation.rejected_fields',
  'admin.po_config_changed',
  'admin.approval_authority_changed',
  'accounting.actual_cost_recorded',
  'admin.vendor_created',
  'admin.vendor_updated',
  'admin.job_created',
  'admin.job_updated',
];

/** Events the notification layer fans out on. */
export const NOTIFICATION_EVENTS = [
  'purchase_request.submitted',
  'purchase_request.awaiting_review',
  'purchase_request.clarification_requested',
  'purchase_request.approved',
  'purchase_request.rejected',
  'purchase_order.generated',
  'purchase_email.draft_ready',
  'purchase_order.overdue',
  'purchase_receipt.partial',
  'purchase_receipt.completed',
  'purchase_material.ready_for_pickup',
];

/** Who should hear about each event. Resolved to users by the notifier. */
export const NOTIFICATION_AUDIENCE = {
  'purchase_request.submitted': ['WORKSHOP_APPROVER', 'OFFICE'],
  'purchase_request.awaiting_review': ['WORKSHOP_APPROVER'],
  'purchase_request.clarification_requested': ['REQUESTOR_OF_RECORD'],
  'purchase_request.approved': ['REQUESTOR_OF_RECORD', 'OFFICE'],
  'purchase_request.rejected': ['REQUESTOR_OF_RECORD'],
  'purchase_order.generated': ['OFFICE', 'WORKSHOP_APPROVER'],
  'purchase_email.draft_ready': ['WORKSHOP_APPROVER', 'OFFICE'],
  'purchase_order.overdue': ['WORKSHOP_APPROVER', 'OFFICE'],
  'purchase_receipt.partial': ['REQUESTOR_OF_RECORD', 'OFFICE'],
  'purchase_receipt.completed': ['REQUESTOR_OF_RECORD', 'OFFICE'],
  'purchase_material.ready_for_pickup': ['REQUESTOR_OF_RECORD'],
};

export function isActivityAction(a) {
  return ACTIVITY_ACTIONS.includes(a);
}

export function isNotificationEvent(e) {
  return NOTIFICATION_EVENTS.includes(e);
}

/**
 * The translation key and parameters for a timeline row.
 *
 * A timeline is the most language-sensitive surface in the application — it is
 * prose. So the domain emits a KEY and the values to interpolate, never a
 * sentence, and a message catalogue turns that into English or Spanish.
 *
 * `describeActivity()` below remains as the English fallback, and is what the
 * current UI still calls. Replacing those call sites is the i18n checkpoint;
 * this exists so that work does not require changing the domain again.
 */
export function activityMessage(entry) {
  const d = entry?.details ?? entry?.newValues ?? {};
  return {
    key: `purchasing.activity.${entry?.action ?? 'unknown'}`,
    params: {
      actor: entry?.actorName ?? null,
      vendorName: d.vendorName ?? null,
      poNumber: d.poNumber ?? null,
      filename: d.filename ?? null,
      type: d.type ?? null,
      permission: d.permission ?? null,
      reason: d.reason ?? null,
      fields: d.fields ?? null,
    },
  };
}

/**
 * English sentence for a timeline row. FALLBACK ONLY — see activityMessage().
 * Falls back to the raw action rather than throwing: an unlabelled but recorded
 * action is still evidence.
 */
export function describeActivity(entry) {
  const who = entry.actorName ?? 'Someone';
  const d = entry.details ?? {};
  switch (entry.action) {
    case 'request.created': return `${who} created the request`;
    case 'request.updated': return `${who} edited the request`;
    case 'request.submitted': return `${who} submitted the request for workshop review`;
    case 'request.item_added': return `${who} added a line item`;
    case 'request.item_updated': return `${who} changed a line item`;
    case 'request.item_removed': return `${who} removed a line item`;
    case 'request.attachment_added': return `${who} attached ${d.filename ?? 'a file'}`;
    case 'request.note_added': return `${who} added a note`;
    case 'request.cancelled': return `${who} cancelled the request`;
    case 'clarification.requested': return `${who} asked the requestor for clarification`;
    case 'clarification.answered': return `${who} answered the clarification and resubmitted`;
    case 'review.stock_recorded': return `${who} recorded workshop stock`;
    case 'review.quantity_changed': return `${who} changed a purchasing quantity`;
    case 'review.vendor_selected': return `${who} selected vendor ${d.vendorName ?? ''}`.trim();
    case 'review.cost_changed': return `${who} entered an estimated cost`;
    case 'review.substitute_set': return `${who} recorded a substitute item`;
    case 'review.saved': return `${who} saved the workshop review`;
    case 'decision.approved': return `${who} approved the request`;
    case 'decision.rejected': return `${who} rejected the request`;
    case 'po.generated': return `${who} generated purchase order ${d.poNumber ?? ''}`.trim();
    case 'po.document_generated': return `Purchase order document generated`;
    case 'email.draft_generated': return `${who} generated the ${d.type ?? 'vendor'} email draft`;
    case 'email.draft_reviewed': return `${who} reviewed the email draft`;
    case 'email.draft_approved_to_send': return `${who} approved the draft to send`;
    case 'email.marked_sent': return `${who} marked the email sent by hand`;
    case 'order.placed': return `${who} marked the order placed with the vendor`;
    case 'order.tracking_updated': return `${who} updated tracking information`;
    case 'receipt.recorded': return `${who} recorded a receipt`;
    case 'receipt.partial': return `${who} recorded a partial receipt`;
    case 'receipt.completed': return `${who} recorded the final receipt`;
    case 'inventory.observed': return `${who} recorded observed workshop stock`;
    case 'inventory.adjusted': return `${who} adjusted workshop inventory`;
    case 'request.completed': return `${who} completed the request`;
    case 'authz.denied': return `${who} was refused: ${d.permission ?? ''} (${d.reason ?? ''})`;
    case 'validation.rejected_fields': return `${who} sent fields they may not set: ${(d.fields ?? []).join(', ')}`;
    case 'admin.po_config_changed': return `${who} changed the PO numbering configuration`;
    case 'admin.approval_authority_changed': return `${who} changed approval authority`;
    default: return `${who}: ${entry.action}`;
  }
}

/**
 * Build the timeline for a request: ordered oldest-first, with the field-level
 * diff attached where one was recorded. Pure — the caller supplies the rows.
 */
export function buildTimeline(entries = []) {
  return [...entries]
    .sort((a, b) => (a.at === b.at ? (a.seq ?? 0) - (b.seq ?? 0) : String(a.at).localeCompare(String(b.at))))
    .map((e) => ({
      ...e,
      description: describeActivity(e),
      changes: diffOf(e),
    }));
}

function diffOf(entry) {
  const prev = entry.previousValues ?? null;
  const next = entry.newValues ?? null;
  if (!prev && !next) return [];
  const keys = [...new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})])].sort();
  return keys
    .filter((k) => JSON.stringify(prev?.[k]) !== JSON.stringify(next?.[k]))
    .map((k) => ({ field: k, from: prev?.[k] ?? null, to: next?.[k] ?? null }));
}
