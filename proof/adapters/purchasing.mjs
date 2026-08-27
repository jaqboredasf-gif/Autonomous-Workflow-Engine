// ---------------------------------------------------------------------------
// adapters/purchasing.mjs — PCC's records, in the proof system's vocabulary.
//
// THE SEAM. Purchasing knows about requests, vendors, reviews and receipts; the
// proof system knows about none of them and must not learn. So one module
// translates, and everything difficult about purchasing stops here.
//
// It reads only what PCC ALREADY RECORDS:
//
//   purchase_requests        created_at, submitted_at, decided_at, ordered_at,
//                            received_at, completed_at, cancelled_at, status,
//                            need_by_date, need_by_time
//   purchase_activity_log    actor_id, action, at, seq — one row per meaningful
//                            act, from the closed vocabulary in
//                            domain/activity.mjs
//   receipt / order lines    ordered vs received quantities
//
// so nothing has to be added to the schema for measurement to begin. What is
// NOT recorded is stated rather than approximated — see `INSTRUMENTATION_GAPS`
// at the foot of this file.
//
// THE OBJECTIVE, and why it is not "the PO was sent"
//
//   A purchase order email leaving the building proves an email left the
//   building. The organization's objective is that the material the job asked
//   for is in the requestor's hands, in the quantity needed, by the day it was
//   needed. PCC can test that: it has the need-by date, the ordered quantities
//   and the received quantities. So execution success and objective success are
//   genuinely different figures here, computed from different columns, and a
//   purchase order that was issued perfectly for material that arrived three
//   days late scores 1 for execution and 0 for objective.
//
// PURE: no clock, no randomness, no I/O. The caller reads the rows.
// ---------------------------------------------------------------------------

import {
  cycleFromTimestamps, executionRecord, humanTouch, objectiveTest,
} from '../execution.mjs';
import { source } from '../provenance.mjs';

export const PURCHASING_CAPABILITY = 'purchasing';
export const PURCHASING_WORKFLOW = 'purchase_request_to_receipt';
export const PURCHASING_OBJECTIVE = 'material_in_hand_by_need_by';

/**
 * Which recorded actions are a HUMAN doing work, and what kind of work.
 *
 * Keyed on `ACTIVITY_ACTIONS` from `apps/purchasing/src/purchasing/domain/
 * activity.mjs` so the audit log, the touch standard and this table all agree
 * on one word. An action absent from this map but present in a request's
 * activity log is reported by `unmappedActions()` rather than assumed to be
 * free — the same rule the touch standard applies to pricing.
 *
 * Actions the SYSTEM performs alone carry no entry and are filtered out by
 * `actorId` being null: PCC records a null actor for machine-written rows.
 */
export const TOUCH_KIND_BY_ACTION = Object.freeze({
  'request.created': 'ORIGINATION',
  'request.updated': 'ROUTINE',
  'request.submitted': 'ORIGINATION',
  'request.item_added': 'ORIGINATION',
  'request.item_updated': 'CORRECTION',
  'request.item_removed': 'CORRECTION',
  'request.attachment_added': 'ROUTINE',
  'request.note_added': 'ROUTINE',
  'request.cancelled': 'EXCEPTION',
  'clarification.requested': 'EXCEPTION',
  'clarification.answered': 'EXCEPTION',
  'review.stock_recorded': 'ROUTINE',
  'review.quantity_changed': 'ROUTINE',
  'review.vendor_selected': 'ROUTINE',
  'review.cost_changed': 'ROUTINE',
  'review.substitute_set': 'ROUTINE',
  'review.saved': 'ROUTINE',
  'decision.approved': 'APPROVAL',
  'decision.rejected': 'APPROVAL',
  'po.generated': 'ROUTINE',
  'po.document_generated': 'ROUTINE',
  'email.draft_generated': 'ROUTINE',
  'email.draft_reviewed': 'SUPERVISION',
  'email.draft_approved_to_send': 'APPROVAL',
  'email.marked_sent': 'ROUTINE',
  'email.draft_cancelled': 'EXCEPTION',
  'email.draft_failed': 'EXCEPTION',
  'order.placed': 'ROUTINE',
  'order.tracking_updated': 'ROUTINE',
  'receipt.recorded': 'ROUTINE',
  'receipt.partial': 'EXCEPTION',
  'receipt.completed': 'ROUTINE',
  'inventory.observed': 'ROUTINE',
  'inventory.adjusted': 'CORRECTION',
  'request.completed': 'ROUTINE',
  'authz.denied': 'EXCEPTION',
  'validation.rejected_fields': 'CORRECTION',
  'accounting.actual_cost_recorded': 'ROUTINE',
});

/**
 * Administrative and directory actions. Recorded, auditable, and DELIBERATELY
 * not charged against any one request: creating a vendor is setup for the whole
 * organization, and billing it to whichever purchase happened next would make a
 * single request look expensive and every subsequent one look cheap.
 *
 * They are a period overhead. `overheadTouches()` collects them so a caller can
 * price them into `ledger.overhead()` where they belong.
 */
export const OVERHEAD_ACTIONS = Object.freeze([
  'admin.po_config_changed',
  'admin.po_sequence_initialized',
  'admin.approval_authority_changed',
  'admin.vendor_created',
  'admin.vendor_updated',
  'admin.job_created',
  'admin.job_updated',
]);

/**
 * Did the material arrive, in the quantity needed, by the day it was needed?
 *
 * @param {object} request   the purchase request row
 * @param {Array}  lines     order lines with orderedQty / receivedQty
 * @returns an ObjectiveTest, defaulting to UNKNOWN.
 */
export function materialObjective(request, lines = []) {
  const statement =
    'The material the job requested was in the requestor\'s hands, in the quantity needed, ' +
    'by the day it was needed.';
  const name = PURCHASING_OBJECTIVE;

  // The organization decided not to buy. The workflow was right; the objective
  // never applied.
  if (request.status === 'REJECTED' || request.status === 'CANCELLED') {
    return objectiveTest({
      name, statement, result: 'NOT_APPLICABLE',
      note: `the request was ${request.status.toLowerCase()} — no material was ever meant to arrive`,
    });
  }

  // Still moving. Not a failure, not yet a success.
  if (!request.receivedAt && !request.completedAt) {
    return objectiveTest({
      name, statement, result: 'UNKNOWN',
      note: 'the request has not reached a state where arrival can be tested',
    });
  }

  const receivedAt = request.receivedAt ?? request.completedAt;
  const evidence = [
    source({ kind: 'SYSTEM_RECORD', ref: `purchase_requests.received_at for ${request.id}`, at: receivedAt }),
    source({ kind: 'SYSTEM_RECORD', ref: `purchase_requests.need_by_date for ${request.id}` }),
  ];

  const shortLines = lines.filter((l) => Number(l.receivedQty ?? 0) < Number(l.orderedQty ?? 0));
  if (lines.length) {
    evidence.push(source({
      kind: 'SYSTEM_RECORD',
      ref: `purchase_order_items / purchase_receipt_items for ${request.id}`,
      sampleSize: lines.length,
    }));
  }

  // Compared by DAY, matching `dashboard.onTimeDelivery()`: material that
  // arrived on the afternoon of the day it was needed arrived on time.
  const onTime = !request.needByDate
    ? null
    : String(receivedAt).slice(0, 10) <= String(request.needByDate).slice(0, 10);

  if (onTime === null) {
    return objectiveTest({
      name, statement, result: 'UNKNOWN', evidence,
      note: 'the request carries no need-by date, so "on time" has no meaning for it',
    });
  }
  if (shortLines.length > 0) {
    return objectiveTest({
      name, statement, result: 'NOT_ACHIEVED', evidence, measuredAt: receivedAt,
      note: `${shortLines.length} line(s) were received short of the quantity ordered`,
    });
  }
  return objectiveTest({
    name, statement, result: onTime ? 'ACHIEVED' : 'NOT_ACHIEVED', evidence, measuredAt: receivedAt,
    note: onTime ? null : `arrived ${receivedAt.slice(0, 10)}, needed by ${request.needByDate}`,
  });
}

/** How the workflow ended, in the proof system's four words. */
export function executionOutcomeOf(request) {
  switch (request.status) {
    case 'COMPLETED':
    case 'RECEIVED':
      return { executionOutcome: 'COMPLETED' };
    case 'REJECTED':
      return {
        executionOutcome: 'REFUSED',
        refusalReason: request.rejectionReason || 'rejected_at_review',
      };
    case 'CANCELLED':
      return { executionOutcome: 'ABANDONED' };
    default:
      // Still in flight. Not an outcome yet; the caller decides whether to
      // include in-flight work, and `valueOf` will exclude it as
      // objective_unknown either way.
      return { executionOutcome: 'COMPLETED', inFlight: true };
  }
}

/**
 * One purchase request → one ExecutionRecord.
 *
 * @param {object} input
 * @param {object} input.request     the purchase request row (camelCase, as the
 *                                   repositories already return it)
 * @param {Array}  input.activity    purchase_activity_log rows for the request
 * @param {Array}  [input.lines]     order lines with orderedQty / receivedQty
 * @param {string} input.baselineId  which baseline this work is measured against
 */
export function toExecutionRecord({ request, activity = [], lines = [], baselineId }) {
  const objective = materialObjective(request, lines);
  const outcome = executionOutcomeOf(request);

  const touches = activity
    .filter((a) => a.actorId)                                   // machine rows carry no actor
    .filter((a) => !OVERHEAD_ACTIONS.includes(a.action))        // organization setup, not this request
    .map((a) => humanTouch({
      action: a.action,
      actorId: a.actorId,
      at: a.at,
      kind: TOUCH_KIND_BY_ACTION[a.action] ?? 'ROUTINE',
      // PCC has no duration column. When one exists — or when a timed
      // observation session fills it — this is where it arrives, and the
      // arithmetic upstream already prefers it.
      observedMinutes: a.observedMinutes ?? null,
    }));

  // A retry, in purchasing terms, is a clarification round: the request went
  // back to the requestor and came again. Counted so the ledger can charge the
  // extra human minutes rather than treating the eventual success as clean.
  const retries = activity.filter((a) => a.action === 'clarification.requested').length;

  return executionRecord({
    id: `pcc:${request.id}`,
    orgId: request.orgId,
    capability: PURCHASING_CAPABILITY,
    workflow: PURCHASING_WORKFLOW,
    objectiveId: PURCHASING_OBJECTIVE,
    baselineId,
    // The unit of real-world work. Two executions on one purchase request —
    // a replay, a re-import, a second capability — bank the saving once.
    scopeKey: `purchase_request:${request.id}`,
    startedAt: request.createdAt ?? request.submittedAt,
    endedAt: request.completedAt ?? request.receivedAt ?? request.cancelledAt ?? request.decidedAt ?? null,
    executionOutcome: outcome.executionOutcome,
    refusalReason: outcome.refusalReason ?? null,
    humanTouches: touches,
    retries,
    objective,
    cycle: cycleFromTimestamps({
      from: request.createdAt ?? request.submittedAt,
      to: request.receivedAt ?? request.completedAt,
      label: 'request raised to material in hand',
      ref: `purchase_requests.created_at → received_at for ${request.id}`,
    }),
    meta: {
      requestNumber: request.requestNumber ?? null,
      jobNumber: request.jobNumber ?? null,
      status: request.status,
      inFlight: Boolean(outcome.inFlight),
    },
  });
}

/** Many requests at once. Rows are grouped by the caller's own read. */
export function toExecutionRecords(rows, { baselineId }) {
  return rows.map(({ request, activity, lines }) =>
    toExecutionRecord({ request, activity, lines, baselineId }));
}

/**
 * Administrative actions in a period, for pricing as period overhead rather
 * than against any one request.
 */
export function overheadTouches(activity = []) {
  return activity
    .filter((a) => a.actorId && OVERHEAD_ACTIONS.includes(a.action))
    .map((a) => humanTouch({ action: a.action, actorId: a.actorId, at: a.at, kind: 'ROUTINE' }));
}

/**
 * Actions PCC can record that this adapter does not classify.
 *
 * Runs against `ACTIVITY_ACTIONS`. A new audit action added to purchasing
 * without a decision about whether it is human work, and what kind, is caught
 * by the suite rather than silently defaulted.
 */
export function unmappedActions(activityActions) {
  return activityActions.filter(
    (a) => !Object.hasOwn(TOUCH_KIND_BY_ACTION, a) && !OVERHEAD_ACTIONS.includes(a));
}

/**
 * What PCC would have to record for the figures above to improve, stated as
 * fact rather than as a roadmap. Each entry names the metric it unlocks and the
 * grade it would move it to.
 *
 * This list is asserted by the suite so it cannot quietly become out of date,
 * and it is what `docs/proof/PCC_INSTRUMENTATION.md` is generated from.
 */
export const INSTRUMENTATION_GAPS = Object.freeze([
  {
    id: 'human_dwell_time',
    missing: 'how long a person spends on one PCC interaction',
    todayInstead: 'a per-action touch standard, applied to a count of audit rows',
    unlocks: 'observed human handling time',
    wouldMoveTo: 'MEASURED',
    where: 'a duration column on purchase_activity_log, written by the server action from a client-reported interaction span',
  },
  {
    id: 'pre_awe_baseline',
    missing: 'timed observation of the paper purchasing process at Lippolis',
    todayInstead: 'nothing — the baseline is declared UNAVAILABLE and every derived figure is unavailable with it',
    unlocks: 'human hours returned, labour value returned',
    wouldMoveTo: 'MEASURED, or SELF_REPORTED if collected by interview',
    where: 'proof/baselines/lippolis-purchasing.mjs, and the method in docs/proof/BASELINE_METHODOLOGY.md',
  },
  {
    id: 'pre_awe_cycle_time',
    missing: 'how long the paper process took from request to material in hand',
    todayInstead: 'nothing — cycle-time improvement is unavailable, though the AWE-era cycle time is measured',
    unlocks: 'cycle-time improvement',
    wouldMoveTo: 'ESTIMATED, from dated paper purchase orders and packing slips',
    where: 'the cycle fields on the Lippolis baseline',
  },
  {
    id: 'loaded_labour_rate',
    missing: 'the fully-loaded hourly cost of the people who do this work',
    todayInstead: 'nothing — labour value is unavailable even where hours are known',
    unlocks: 'labour value returned, money saved',
    wouldMoveTo: 'MEASURED, from payroll',
    where: 'the labourRate fields on the Lippolis baseline',
  },
  {
    id: 'rework_and_error_rate',
    missing: 'whether a purchase had to be corrected after the fact',
    todayInstead: 'corrections appear as new requests with no link to the one they correct',
    unlocks: 'error and rework reduction',
    wouldMoveTo: 'MEASURED',
    where: 'a supersedes/corrects reference on purchase_requests',
  },
]);
