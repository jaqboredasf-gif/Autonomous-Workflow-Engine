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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { baselineStep, defineBaseline, defineTouchStandard } from '../baseline.mjs';
import { labourRateFrom, stepFromObservations } from './ingest.mjs';

/**
 * WHAT WAS ACTUALLY OBSERVED, if anything has been.
 *
 * The header above says: do not edit a number into this file without also
 * editing its provenance and adding a source. That is correct, and it is an
 * instruction — the kind somebody follows at 11pm by typing a plausible six and
 * moving on, because `quantity()` accepts any figure that carries *a* source.
 *
 * So observations live in a JSON file the founder fills in over several days,
 * and `ingest.mjs` is the only path from that file to a duration. It refuses an
 * observation with no observer, no date or nothing to go and look at; it caps a
 * step below MEASURED when fewer than five occurrences were timed; and the
 * weakest method sets the grade for the whole step.
 *
 * An absent or empty file leaves every step exactly as it was declared below —
 * UNAVAILABLE — which is the correct state of the world until somebody watches
 * the work.
 */
const OBSERVATIONS = (() => {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'observations', 'lippolis-purchasing.json');
  if (!existsSync(path)) return { steps: {} };
  return JSON.parse(readFileSync(path, 'utf8'));
})();

/**
 * The declared shape of a step, with any observations folded in.
 *
 * The shape — which steps exist, who performs them, what to watch for — is
 * code, because it is an argument about the process. The durations are data,
 * because they are observations. Keeping them apart is what stops a busy
 * evening turning the second into the first.
 */
function step({ id, label, performedBy, note }) {
  const observed = OBSERVATIONS.steps?.[id];
  if (!observed || !(observed.observations?.length)) {
    return baselineStep({ id, label, minutes: null, provenance: 'UNAVAILABLE', performedBy, note });
  }
  return stepFromObservations({
    id, label, performedBy,
    observations: observed.observations,
    appliesToShare: observed.appliesToShare ?? 1,
    note,
  });
}

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
  step({
    id: 'request_intake',
    label: 'Taking the request from the field',
    performedBy: 'office or workshop',
    note: 'Observe: a foreman phones or texts what a job needs; somebody writes it down. Time from the call connecting to the note being complete.',
  }),
  step({
    id: 'clarification',
    label: 'Going back for missing detail',
    performedBy: 'office or workshop',
    note: 'Observe on the subset of requests that need it, and record the SHARE of requests that need it — a step that happens on one request in four is not a full step of the average.',
  }),
  step({
    id: 'stock_check',
    label: 'Checking what the workshop already holds',
    performedBy: 'workshop',
    note: 'Observe: walking the shelves, or asking somebody who knows. This is the step PCC replaced with a recorded number, so it is the one most likely to show a real difference.',
  }),
  step({
    id: 'approval_handling',
    label: 'Getting the purchase approved',
    performedBy: 'workshop approver',
    note: 'HANDLING time only — the minutes the approver is occupied, not the hours the paper sits on a desk. The waiting belongs in the cycle-time figure, not here.',
  }),
  step({
    id: 'po_preparation',
    label: 'Writing the purchase order',
    performedBy: 'office',
    note: 'Observe: finding the next number for that job and vendor, filling the form, checking the job address. Paper POs exist for this — sample them.',
  }),
  step({
    id: 'vendor_communication',
    label: 'Telling the vendor',
    performedBy: 'office',
    note: 'Observe: composing the email or making the call. Excludes waiting for the vendor to answer.',
  }),
  step({
    id: 'tracking_and_filing',
    label: 'Chasing the order and filing the paperwork',
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
  ...(() => {
    const rate = labourRateFrom(OBSERVATIONS.labourRate);
    return {
      labourRateCentsPerHour: rate.centsPerHour,
      labourRateProvenance: rate.provenance,
      labourRateSources: rate.sources,
    };
  })(),
  reviewedBy: OBSERVATIONS.reviewedBy ?? null,
  reviewedAt: OBSERVATIONS.reviewedAt ?? null,
  reviewedAt: null,
});

/**
 * What one interaction with PCC costs a human.
 *
 * PRICED PER SCREEN, NOT PER AUDIT ROW. One complete purchase writes 31 rows to
 * `purchase_activity_log` and is 11 things a person did — see ANCHOR_ACTIONS in
 * `proof/adapters/purchasing.mjs`. Only anchors appear here, because only an
 * anchor is something somebody can be watched doing.
 *
 * THE ELEVEN THAT MATTER FIRST. A normal purchase — raised, reviewed, approved,
 * ordered, received, closed — touches exactly these, in this order:
 *
 *    1  request.created                the foreman fills in the request
 *    2  request.submitted              and sends it (often the same click)
 *    3  review.saved                   the purchaser records stock and vendor
 *    4  decision.approved              and approves
 *    5  po.generated                   the purchase order is issued
 *    6  email.draft_generated          the vendor email is drafted
 *    7  email.draft_reviewed           somebody reads it
 *    8  email.draft_approved_to_send   and approves it
 *    9  email.marked_sent              and records that it went
 *   10  order.placed                   the order is marked placed
 *   11  receipt.recorded               the material is signed for
 *
 * Timing those eleven screens once, with one purchaser, over one normal
 * morning, is the whole measurement. The remaining entries below are the
 * exception paths; they are worth pricing second, and a purchase that hits one
 * of them is simply unvaluable until they are.
 *
 * Also unmeasured today, and declared action by action rather than left absent,
 * so `unpricedActions()` reports a complete list of what still needs timing and
 * the suite can assert the list matches purchasing's real vocabulary.
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
    // --- the happy path: price these first ---------------------------------
    'request.created': UNPRICED,
    'request.submitted': UNPRICED,
    'review.saved': UNPRICED,
    'decision.approved': UNPRICED,
    'po.generated': UNPRICED,
    'email.draft_generated': UNPRICED,
    'email.draft_reviewed': UNPRICED,
    'email.draft_approved_to_send': UNPRICED,
    'email.marked_sent': UNPRICED,
    'order.placed': UNPRICED,
    'receipt.recorded': UNPRICED,

    // --- exception and administrative paths: price these second ------------
    'request.updated': UNPRICED,
    'request.cancelled': UNPRICED,
    'request.note_added': UNPRICED,
    'request.attachment_added': UNPRICED,
    'clarification.requested': UNPRICED,
    'clarification.answered': UNPRICED,
    'decision.rejected': UNPRICED,
    'email.draft_cancelled': UNPRICED,
    'email.draft_failed': UNPRICED,
    'order.tracking_updated': UNPRICED,
    'request.completed': UNPRICED,
    'accounting.actual_cost_recorded': UNPRICED,
    'inventory.observed': UNPRICED,
    'authz.denied': UNPRICED,
    'validation.rejected_fields': UNPRICED,
  },
});

/**
 * The eleven screens a normal purchase touches, in order.
 *
 * Exported so the field protocol, the suite and any future observation tool all
 * read one list rather than three that drift.
 */
export const LIPPOLIS_HAPPY_PATH_SCREENS = Object.freeze([
  'request.created',
  'request.submitted',
  'review.saved',
  'decision.approved',
  'po.generated',
  'email.draft_generated',
  'email.draft_reviewed',
  'email.draft_approved_to_send',
  'email.marked_sent',
  'order.placed',
  'receipt.recorded',
]);

export default lippolisPurchasingBaseline;
