// ---------------------------------------------------------------------------
// adapters/tegg.mjs — a second capability, through the same boundary.
//
// WHAT THIS IS FOR. AWE's proof layer was built while measuring one thing: the
// purchasing workflow. A measurement layer that fits exactly one capability is
// not a measurement layer, it is that capability's reporting code with a
// general-sounding name. The claim worth testing is:
//
//   ANY capability that can say what ran, for whom, when, whether it finished
//   and whether the organization got what it wanted can be measured by the same
//   arithmetic, with no change to the arithmetic.
//
// TEGG is the falsification attempt. It is a different product in a different
// language in a different repository: a read-only Python agent that signs in to
// the TEGG portal, reads a completed site visit, and produces an ESA findings
// review. It shares no code, no database and no vocabulary with purchasing.
//
// WHAT IT ALREADY HAS, and this is the finding: TEGG writes a durable run
// ledger at `work/operations/<run-id>/state.json` carrying `tenant`,
// `environment`, `operation`, `status`, `started_at`, `updated_at`, verified
// `steps` with timestamps, `resumes`, and `human_action_required`. Those are
// the fields an ExecutionRecord needs. Nothing had to be added to TEGG to make
// this adapter possible, and nothing had to be added to the proof layer to
// accept it — which is the whole claim, demonstrated rather than asserted.
//
// WHAT IT DOES NOT HAVE, stated rather than papered over:
//
//   · `human_action_required` is a list of SENTENCES. It records that a person
//     had to act; it does not record which person, or when. So this adapter
//     emits NO human touches and sets `humanTouchesComplete: false`, which
//     makes human minutes UNAVAILABLE rather than zero. Emitting nothing while
//     claiming a complete trail would read as "no human involved" — the largest
//     possible saving, from a capability that cannot see its own humans.
//
//   · The objective is UNKNOWN, and honestly so. TEGG's objective is not "the
//     review was produced" — that is the workflow finishing, which is a
//     different question this model deliberately keeps apart. It is whether the
//     estimator sent the report and the customer bought the repair, and no part
//     of that is in the ledger. It stays UNKNOWN until something observes it.
//
//   · There is no TEGG baseline. Nobody has measured what producing one ESA
//     review cost before AWE. The caller names a baseline id; if no such
//     baseline is in force, the ledger reports `no_baseline_in_force` and every
//     value figure is NOT MEASURABLE. That is the correct output today.
//
// So the honest result of feeding TEGG through this boundary is: real
// executions, real reliability, real interventions-required counts, and NOT
// MEASURABLE against every money and hours figure. A generalization that
// produced numbers here would have proved the opposite of what it claims.
//
// PURE: takes parsed ledger objects, returns records. No filesystem, no clock.
// ---------------------------------------------------------------------------

import { executionRecord, objectiveTest } from '../execution.mjs';

/**
 * TEGG run status → AWE execution outcome.
 *
 * `escalated` is REFUSED, not FAILED, and the distinction is the point of
 * TEGG's design: the agent stopped because the portal disagreed with what it
 * believed, and it said so instead of retrying into a mess. A refusal that
 * names its reason is the system working.
 */
export const OUTCOME_FOR = Object.freeze({
  completed: 'COMPLETED',
  escalated: 'REFUSED',
  failed: 'FAILED',
  interrupted: 'ABANDONED',
});

/** Statuses that are not yet an outcome. A run still going is not evidence. */
export const NOT_TERMINAL = Object.freeze(['running']);

/**
 * What real-world unit of work this run displaced.
 *
 * A visit-findings run is about ONE site visit, and two runs against the same
 * visit — a resume, a retry after an escalation, a second look — are one unit
 * of work, not two. Keying on the visit is what stops a capability that had to
 * be run twice reporting twice the saving. A run with no external subject can
 * only be keyed on itself, and this says so rather than inventing a grouping.
 */
export function scopeKeyFor(ledger) {
  const visit = ledger.visit?.identifier ?? ledger.visit?.job_number ?? null;
  return visit ? `visit:${visit}` : `run:${ledger.run_id}`;
}

/**
 * One TEGG run ledger → one ExecutionRecord.
 *
 * @param {object} ledger        parsed state.json
 * @param {object} spec
 * @param {string} spec.capability     the AWE capability id these runs belong to
 * @param {string} spec.baselineId     what this work is measured against
 * @param {string} [spec.objectiveId]
 * @returns {object|null} null when the run has not reached an outcome
 */
export function toExecutionRecord(ledger, { capability, baselineId, objectiveId = 'report_delivered' }) {
  if (!capability) throw new Error('toExecutionRecord needs the capability these runs belong to');
  if (!baselineId) throw new Error('toExecutionRecord needs the baseline this work is measured against');
  if (!ledger?.run_id) throw new Error('a TEGG run ledger must carry a run_id');
  if (!ledger.tenant) {
    throw new Error(`TEGG run ${ledger.run_id} names no tenant — evidence is organization-bound and cannot be guessed`);
  }
  if (NOT_TERMINAL.includes(ledger.status)) return null;

  const executionOutcome = OUTCOME_FOR[ledger.status];
  if (!executionOutcome) {
    throw new Error(
      `TEGG run ${ledger.run_id} has status ${JSON.stringify(ledger.status)}, which this adapter does not map. ` +
      'Refusing rather than guessing: a status silently treated as COMPLETED becomes a saving.');
  }

  // The escalation messages ARE the refusal reason. TEGG writes them for a
  // person to read, and repeating them unchanged means a reader tracing a
  // figure lands on the sentence the agent actually produced.
  const needed = ledger.human_action_required ?? [];
  const refusalReason = executionOutcome === 'REFUSED'
    ? (needed[0] ?? 'the run escalated without recording why')
    : null;
  const errorCode = executionOutcome === 'FAILED'
    ? (ledger.error_code ?? 'tegg_run_failed')
    : null;

  const steps = ledger.steps ?? [];
  const lastAt = steps.length ? steps[steps.length - 1].at : null;

  return executionRecord({
    id: ledger.run_id,
    orgId: ledger.tenant,
    capability,
    // The OPERATION is the workflow. TEGG runs more than one — reading the
    // documentation area is not producing a findings review — and collapsing
    // them would average two different jobs into one meaningless rate.
    workflow: ledger.operation,
    objectiveId,
    baselineId,
    scopeKey: scopeKeyFor(ledger),
    startedAt: ledger.started_at,
    endedAt: ledger.updated_at ?? lastAt,
    executionOutcome,
    refusalReason,
    errorCode,

    // NONE, and not because none happened. See the header: the ledger records
    // that a human was required, never who or when.
    humanTouches: [],
    humanTouchesComplete: false,

    // A resume is the same unit of work attempted again. Recorded so a run that
    // needed three attempts cannot read like one that worked first time.
    retries: ledger.resumes ?? 0,

    // UNKNOWN, deliberately. Whether the estimator sent the report and the
    // customer bought the repair is the objective; the ledger cannot see it.
    objective: objectiveTest({
      name: objectiveId,
      statement: 'The findings review reached the estimator and was used to quote the repair.',
      result: 'UNKNOWN',
      note: 'TEGG produces the review and stops. Nothing downstream of it is observed, '
        + 'so this is UNKNOWN rather than ACHIEVED — the workflow finishing is a different question.',
    }),

    cycle: null,

    // Kept for a reader tracing a figure back to a run directory.
    meta: {
      integration: ledger.integration ?? null,
      environment: ledger.environment ?? 'unstamped',
      humanActionsRequired: needed.length,
      stepsVerified: steps.length,
      stepsDefined: (ledger.step_names ?? []).length,
      contradictions: (ledger.contradictions ?? []).length,
      correctedKnowledge: (ledger.corrected_knowledge ?? []).length,
    },
  });
}

/**
 * Many ledgers → records, plus what was skipped and why.
 *
 * ONE ENVIRONMENT PER READ, and it is refused rather than resolved. A directory
 * holding both production runs and rehearsal runs cannot produce one honest
 * figure, and picking a majority or filtering silently would hide the fact that
 * somebody's evidence directory is mixed.
 */
export function readRuns(ledgers, { capability, baselineId, objectiveId } = {}) {
  const records = [];
  const skipped = [];
  const environments = new Set();

  for (const ledger of ledgers) {
    environments.add(ledger.environment ?? 'unstamped');
    const record = toExecutionRecord(ledger, { capability, baselineId, objectiveId });
    if (record === null) {
      skipped.push({ runId: ledger.run_id, because: `status "${ledger.status}" — the run has not finished` });
      continue;
    }
    records.push(record);
  }

  if (environments.size > 1) {
    throw new Error(
      `these runs come from more than one environment (${[...environments].sort().join(', ')}). ` +
      'One read cannot produce one honest figure across them: read each environment separately.');
  }

  return {
    records,
    skipped,
    environment: environments.size ? [...environments][0] : 'unstamped',
  };
}
