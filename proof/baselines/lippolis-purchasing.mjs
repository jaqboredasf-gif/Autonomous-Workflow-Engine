// ---------------------------------------------------------------------------
// baselines/lippolis-purchasing.mjs — the Lippolis purchasing baseline.
//
// EVERY FIGURE IN THIS FILE IS UNAVAILABLE, AND THAT IS THE POINT.
//
// Nobody has yet timed how Lippolis bought material before PCC. No observation
// session has been run, no operator has been interviewed with a stopwatch, and
// no paper purchase orders have been sampled for dates. The repository is the
// truth, and the repository contains no such measurement — the closest thing to
// one anywhere in it is the boss's "~1 hour lost per day" on time-punch
// verification (docs/planning/BOSS_INTERVIEW.md), which is a different process
// entirely.
//
// So this file declares the SHAPE of the baseline — the steps the old process
// actually had, drawn from docs/planning/CURRENT_WORKFLOW.md and the purchasing
// capability contract — with every duration marked UNAVAILABLE. The effect,
// enforced by `baselineHandlingMinutes()`, is that every figure downstream of
// it is unavailable too: no hours returned, no labour value, no ROI. PCC will
// report executions, objective success and AWE-era cycle time honestly, and
// will report NOT MEASURABLE for everything that needs a before.
//
// That is the correct state of the world today, and it is the state the case
// study should print, because the alternative — a plausible number typed into
// this file by somebody who has not watched the work — is precisely the lie the
// whole proof package exists to make impossible.
//
// TO MAKE THIS BASELINE REAL, follow docs/proof/BASELINE_METHODOLOGY.md. Each
// step below carries, in its `note`, exactly what has to be observed and who
// can say it.
//
// DO NOT edit a number into this file without also editing its `provenance` and
// adding a `source`. `quantity()` refuses a valued figure with no source, so an
// attempt to do so fails at import rather than shipping a fiction.
// ---------------------------------------------------------------------------

import { baselineStep, defineBaseline, defineTouchStandard } from '../baseline.mjs';

const ORG = 'lippolis';

/**
 * The steps of the pre-PCC purchasing process.
 *
 * Derived from the capability contract's lifecycle (capability/purchasing/
 * README.md) and the current-state model (docs/planning/CURRENT_WORKFLOW.md
 * §3), which describes the same shape at company level: somebody asks, somebody
 * checks, somebody decides, somebody prepares paper, somebody tells the vendor,
 * somebody chases and files.
 *
 * These are the steps a person performed. Waiting for a vendor is not a step:
 * nobody is working during it, and counting it would inflate the baseline
 * enormously and invisibly.
 */
export const LIPPOLIS_PURCHASING_STEPS = [
  baselineStep({
    id: 'request_intake',
    label: 'Taking the request from the field',
    minutes: null,
    provenance: 'UNAVAILABLE',
    performedBy: 'office or workshop',
    note: 'Observe: a foreman phones or texts what a job needs; somebody writes it down. Time from the call connecting to the note being complete.',
  }),
  baselineStep({
    id: 'clarification',
    label: 'Going back for missing detail',
    minutes: null,
    provenance: 'UNAVAILABLE',
    performedBy: 'office or workshop',
    note: 'Observe on the subset of requests that need it, and record the SHARE of requests that need it — a step that happens on one request in four is not a full step of the average.',
  }),
  baselineStep({
    id: 'stock_check',
    label: 'Checking what the workshop already holds',
    minutes: null,
    provenance: 'UNAVAILABLE',
    performedBy: 'workshop',
    note: 'Observe: walking the shelves, or asking somebody who knows. This is the step PCC replaced with a recorded number, so it is the one most likely to show a real difference.',
  }),
  baselineStep({
    id: 'approval_handling',
    label: 'Getting the purchase approved',
    minutes: null,
    provenance: 'UNAVAILABLE',
    performedBy: 'workshop approver',
    note: 'HANDLING time only — the minutes the approver is occupied, not the hours the paper sits on a desk. The waiting belongs in the cycle-time figure, not here.',
  }),
  baselineStep({
    id: 'po_preparation',
    label: 'Writing the purchase order',
    minutes: null,
    provenance: 'UNAVAILABLE',
    performedBy: 'office',
    note: 'Observe: finding the next number for that job and vendor, filling the form, checking the job address. Paper POs exist for this — sample them.',
  }),
  baselineStep({
    id: 'vendor_communication',
    label: 'Telling the vendor',
    minutes: null,
    provenance: 'UNAVAILABLE',
    performedBy: 'office',
    note: 'Observe: composing the email or making the call. Excludes waiting for the vendor to answer.',
  }),
  baselineStep({
    id: 'tracking_and_filing',
    label: 'Chasing the order and filing the paperwork',
    minutes: null,
    provenance: 'UNAVAILABLE',
    performedBy: 'office',
    note: 'Observe across the life of one order: the chases, the packing slip, the filing. Likely the most under-estimated step, because it happens in fragments.',
  }),
];

/**
 * The baseline itself.
 *
 * `effectiveFrom` is the day PCC's production line was handed over, so that
 * work done before it has no baseline in force and cannot be valued
 * retroactively — see `versionInForce()`.
 *
 * `coversSteps` names the work in the ORGANIZATION's vocabulary, not
 * purchasing's, because the overlap check that prevents double counting has to
 * compare across capabilities: if a future capability also claims "vendor
 * communication" for Lippolis, `assertNoOverlap()` refuses both.
 */
export const lippolisPurchasingBaseline = defineBaseline({
  id: 'lippolis_purchasing_v0',
  version: '0.1.0',
  orgId: ORG,
  process: 'Buying material for a job',
  description:
    'How Lippolis Electric bought material for a job before the Purchasing Control Center. ' +
    'The steps are known; none of the durations has been measured.',
  effectiveFrom: '2026-08-19T00:00:00Z',
  effectiveTo: null,
  unitOfWork: 'purchase request',
  steps: LIPPOLIS_PURCHASING_STEPS,
  coversSteps: [
    'material_request_intake',
    'material_stock_check',
    'material_purchase_approval',
    'purchase_order_preparation',
    'vendor_purchase_communication',
    'purchase_tracking_and_filing',
  ],
  // Elapsed time of the old process, end to end. Also unmeasured. Dated paper
  // purchase orders and packing slips could establish it as HISTORICAL_RECORD
  // without anybody watching anything.
  cycleHours: null,
  cycleProvenance: 'UNAVAILABLE',
  // What an hour of the relevant people's time costs, fully loaded. Payroll
  // knows; nobody has asked.
  labourRateCentsPerHour: null,
  labourRateProvenance: 'UNAVAILABLE',
  reviewedBy: null,
  reviewedAt: null,
});

/**
 * What one interaction with PCC costs a human.
 *
 * Also unmeasured, and declared action by action rather than left absent, so
 * that `unpricedActions()` reports a complete list of what needs timing and the
 * suite can assert that the list matches purchasing's actual vocabulary.
 *
 * The fastest honest route to filling this in is a single timed session with
 * one purchaser doing a normal morning's work: it produces MEASURED durations
 * for the actions that occur, and leaves the rest visibly unpriced.
 */
const UNPRICED = { minutes: null, provenance: 'UNAVAILABLE' };

export const lippolisPurchasingTouchStandard = defineTouchStandard({
  id: 'lippolis_pcc_touches_v0',
  version: '0.1.0',
  orgId: ORG,
  capability: 'purchasing',
  effectiveFrom: '2026-08-19T00:00:00Z',
  effectiveTo: null,
  // Null, deliberately: an interaction nobody has priced is unknown, not free.
  defaultMinutes: null,
  actions: {
    'request.created': UNPRICED,
    'request.updated': UNPRICED,
    'request.submitted': UNPRICED,
    'request.item_added': UNPRICED,
    'request.item_updated': UNPRICED,
    'request.item_removed': UNPRICED,
    'request.attachment_added': UNPRICED,
    'request.note_added': UNPRICED,
    'request.cancelled': UNPRICED,
    'clarification.requested': UNPRICED,
    'clarification.answered': UNPRICED,
    'review.stock_recorded': UNPRICED,
    'review.quantity_changed': UNPRICED,
    'review.vendor_selected': UNPRICED,
    'review.cost_changed': UNPRICED,
    'review.substitute_set': UNPRICED,
    'review.saved': UNPRICED,
    'decision.approved': UNPRICED,
    'decision.rejected': UNPRICED,
    'po.generated': UNPRICED,
    'po.document_generated': UNPRICED,
    'email.draft_generated': UNPRICED,
    'email.draft_reviewed': UNPRICED,
    'email.draft_approved_to_send': UNPRICED,
    'email.marked_sent': UNPRICED,
    'email.draft_cancelled': UNPRICED,
    'email.draft_failed': UNPRICED,
    'order.placed': UNPRICED,
    'order.tracking_updated': UNPRICED,
    'receipt.recorded': UNPRICED,
    'receipt.partial': UNPRICED,
    'receipt.completed': UNPRICED,
    'inventory.observed': UNPRICED,
    'inventory.adjusted': UNPRICED,
    'request.completed': UNPRICED,
    'authz.denied': UNPRICED,
    'validation.rejected_fields': UNPRICED,
    'accounting.actual_cost_recorded': UNPRICED,
  },
});

export default lippolisPurchasingBaseline;
