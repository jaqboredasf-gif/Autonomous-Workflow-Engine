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

// ---------------------------------------------------------------------------
// AUDIT ROWS ARE NOT HUMAN INTERACTIONS
//
// The defect this section exists to remove, measured rather than supposed. One
// complete purchase — three line items, raised, reviewed, approved, ordered,
// received and closed — writes THIRTY-ONE rows to purchase_activity_log, none
// of them system-written, for ELEVEN times a person touched the software.
//
// The trail is not wrong. It is a faithful record of DOMAIN EVENTS, and it has
// to be: recording stock once per line is what makes a review auditable, and
// recording `po.generated` against both the request and the order is what lets
// either be traced. But a domain event is not a unit of human work, and pricing
// one interaction per row inflates AWE-era human handling by about 2.8x — which
// UNDER-states hours returned, and which no amount of baseline fieldwork would
// have corrected, because the error is on the other side of the subtraction.
//
// It is also unmeasurable in the field. Nobody can stopwatch `review.stock_
// recorded` separately from `review.saved`: they are one person pressing Save
// on one screen. A touch standard has to be priceable by watching somebody
// work, and that means its unit must be the SCREEN, not the event.
//
// So one action per interaction is declared the ANCHOR — the row that stands
// for "a person pressed the button" — and every other row in the same
// transaction is a consequence of it. Anchors are priced; consequences are
// free, because they cost the human nothing beyond the anchor they came with.
//
// DESIGN IT TWICE. The alternative was to group rows by actor and timestamp
// proximity and call each cluster an interaction. It needs no table, and it was
// rejected: the window is a magic number that decides the answer, and the
// rehearsal proved it degenerates — driven at machine speed, every row in the
// purchase collapsed into two clusters. An anchor table is explicit, testable
// against the whole vocabulary by `unmappedActions()`, and immune to how fast
// anybody works. The timing rule below survives only as a de-duplicator inside
// one transaction, where it decides nothing about which work counted.
// ---------------------------------------------------------------------------

/**
 * The action that stands for a human interaction, and the entity it is
 * recorded against.
 *
 * `entityType: '*'` means any. Where an action is recorded twice in one
 * transaction against two different entities — `po.generated` lands on both the
 * request and the order — the anchor names the one that represents the act,
 * and the echo is a consequence.
 */
export const ANCHOR_ACTIONS = Object.freeze({
  'request.created': 'purchase_request',
  'request.submitted': 'purchase_request',
  'request.updated': 'purchase_request',
  'request.cancelled': 'purchase_request',
  'request.note_added': 'purchase_request',
  'request.attachment_added': 'purchase_request_attachment',
  'clarification.requested': 'purchase_request',
  'clarification.answered': 'purchase_request',
  'review.saved': 'purchase_review',
  'decision.approved': 'purchase_request',
  'decision.rejected': 'purchase_request',
  'po.generated': 'purchase_order',
  'email.draft_generated': 'purchase_email_draft',
  'email.draft_reviewed': 'purchase_email_draft',
  'email.draft_approved_to_send': 'purchase_email_draft',
  'email.marked_sent': 'purchase_email_draft',
  'email.draft_cancelled': 'purchase_email_draft',
  'email.draft_failed': 'purchase_email_draft',
  'order.placed': 'purchase_request',
  'order.tracking_updated': 'purchase_request',
  'receipt.recorded': 'purchase_receipt',
  'request.completed': 'purchase_request',
  'accounting.actual_cost_recorded': 'purchase_order',
  'inventory.observed': 'inventory_observation',
  'authz.denied': 'purchase_request',
  'validation.rejected_fields': 'purchase_request',
});

/**
 * Rows that are consequences of an anchor, not acts of their own.
 *
 * Listed rather than inferred, so that a new purchasing action forces a
 * decision instead of defaulting into whichever bucket is quieter.
 */
export const CONSEQUENCE_ACTIONS = Object.freeze([
  'request.item_added',
  'request.item_updated',
  'request.item_removed',
  'review.stock_recorded',
  'review.quantity_changed',
  'review.vendor_selected',
  'review.cost_changed',
  'review.substitute_set',
  'po.document_generated',
  'receipt.partial',
  'receipt.completed',
  'inventory.adjusted',
]);

/**
 * Two anchors this close together, by one person, are one interaction.
 *
 * A second is a very long time for a server transaction and far too short for a
 * human: reaching a second PCC screen means a navigation and a form submit, and
 * nobody does that in under a second. So this collapses only what one click
 * produced — the new-request form that creates AND submits, or receiving that
 * records a receipt AND closes the request — and never merges two things a
 * person actually did separately.
 *
 * It de-duplicates. It never decides whether work happened.
 */
export const INTERACTION_WINDOW_MS = 1000;

/**
 * The most anchors one click is allowed to have produced.
 *
 * The window above is safe for a person using a browser and NOT safe for a
 * machine: a migration, a backfill or a replay writes a whole purchase in
 * milliseconds, and everything would collapse into one interaction. That error
 * runs in the dangerous direction — fewer interactions means fewer human
 * minutes means MORE hours returned — so it is capped rather than trusted.
 *
 * Three is generous. The largest genuine one-click group in the application is
 * the new-request form, which creates and submits, and receiving, which records
 * a receipt and closes the request. Beyond that the collapse stops and the next
 * anchor starts a new interaction, which counts the work as separate and costs
 * us hours we might have claimed. That is the correct way round.
 *
 * The cap counts DISTINCT actions. A repeat of one action inside the window is
 * always folded in, whatever the count, because it is a duplicate record rather
 * than a second act: submitting a request writes `request.submitted` four times
 * — the domain statement, the queue entry, and both state transitions — and
 * nobody pressed Submit four times.
 *
 * Proven by the rehearsal in the suite: the same purchase driven at machine
 * speed and at human speed must not differ by more than this bound.
 */
export const MAX_ANCHORS_PER_INTERACTION = 3;

/**
 * Human interactions, from the audit trail.
 *
 * Anchors only, de-duplicated within one transaction, represented by the FIRST
 * anchor in the group — which is the one that names the screen the person was
 * looking at. The rows collapsed into it are kept on `note`, so a reader
 * tracing a figure can still see every audit row it rests on.
 */
export function interactionsFrom(activity = []) {
  const anchors = activity
    .filter((a) => a.actorId)
    .filter((a) => !OVERHEAD_ACTIONS.includes(a.action))
    .filter((a) => {
      const entity = ANCHOR_ACTIONS[a.action];
      if (entity === undefined) return false;
      return entity === '*' || a.entityType === undefined || a.entityType === entity;
    })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a.seq ?? 0) - (b.seq ?? 0));

  const out = [];
  for (const row of anchors) {
    const last = out.at(-1);
    const t = Date.parse(row.at);
    const sameBurst = last && last.actorId === row.actorId && Number.isFinite(t) &&
      t - last.lastAt <= INTERACTION_WINDOW_MS;
    if (sameBurst) {
      const distinct = new Set([last.action, ...last.collapsed]);
      if (distinct.has(row.action) || distinct.size < MAX_ANCHORS_PER_INTERACTION) {
        last.lastAt = t;
        last.collapsed.push(row.action);
        continue;
      }
    }
    out.push({ ...row, lastAt: Number.isFinite(t) ? t : 0, collapsed: [] });
  }
  return out;
}

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

  // ONE TOUCH PER INTERACTION, not per audit row. See ANCHOR_ACTIONS above:
  // a three-line purchase writes thirty-one rows for eleven things a person did.
  const touches = interactionsFrom(activity).map((a) => humanTouch({
    action: a.action,
    actorId: a.actorId,
    at: a.at,
    kind: TOUCH_KIND_BY_ACTION[a.action] ?? 'ROUTINE',
    // PCC has no duration column. When one exists — or when a timed
    // observation session fills it — this is where it arrives, and the
    // arithmetic upstream already prefers it.
    observedMinutes: a.observedMinutes ?? null,
    note: a.collapsed.length ? `one interaction; also recorded ${a.collapsed.join(', ')}` : null,
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
 * Actions that are neither an anchor, a consequence, nor organization overhead.
 *
 * A new purchasing action has to be classified as one of the three, and this is
 * what makes forgetting impossible: an unclassified action would otherwise
 * default to free, which is the direction that flatters us.
 */
export function unclassifiedInteractionActions(activityActions) {
  return activityActions.filter((a) =>
    !Object.hasOwn(ANCHOR_ACTIONS, a) &&
    !CONSEQUENCE_ACTIONS.includes(a) &&
    !OVERHEAD_ACTIONS.includes(a));
}

/** The actions a touch standard has to price: the anchors, and only those. */
export const PRICEABLE_ACTIONS = Object.freeze(Object.keys(ANCHOR_ACTIONS));

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
