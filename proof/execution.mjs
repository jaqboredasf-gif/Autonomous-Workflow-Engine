// ---------------------------------------------------------------------------
// execution.mjs — what happened, in a vocabulary no capability owns.
//
// This is the record every capability adapts into, and the reason the proof
// system will still work when the second capability arrives. Purchasing knows
// about requests, vendors and receipts; TEGG knows about site visits and
// certificates; the value arithmetic must know about neither. So each
// capability writes an adapter that produces THIS shape, and nothing above the
// adapter learns a purchasing word.
//
// THE DISTINCTION THIS MODULE EXISTS TO PROTECT
//
//   TASK COMPLETED IS NOT OBJECTIVE ACHIEVED.
//
// AWE sending a purchase-order email proves that an email was sent. It does not
// prove the material arrived, in the right quantity, by the day the job needed
// it. Those are different claims with different evidence, and collapsing them
// into one boolean is how a system starts reporting successes that the customer
// experienced as failures.
//
// So four fields, never merged, each with its own evidence:
//
//   executionOutcome   did the run do its steps?          COMPLETED | REFUSED | FAILED | ABANDONED
//   objectiveSuccess   did the organization's goal occur?  ACHIEVED | NOT_ACHIEVED | UNKNOWN
//   businessOutcome    what changed in the business?       a record, or null
//   (economic value is computed elsewhere, from these — see value.mjs)
//
// REFUSED is a first-class outcome and not a failure, matching the kernel's
// `blocked` status: a workflow that fail-closed on a governance rule did the
// right thing. It returns no hours, because a refusal still had to be handled
// by somebody, and it is not an error either.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { quantity, source } from './provenance.mjs';

/**
 * Did the run perform its steps?
 *
 *   COMPLETED  every step the capability defines ran and returned.
 *   REFUSED    the capability declined, deliberately, under a stated rule.
 *              A correct run. Not an error, and not a success either.
 *   FAILED     something broke.
 *   ABANDONED  a human stopped it, or it was superseded.
 */
export const EXECUTION_OUTCOMES = Object.freeze(['COMPLETED', 'REFUSED', 'FAILED', 'ABANDONED']);

/**
 * Did the thing the organization actually wanted happen?
 *
 * UNKNOWN is the DEFAULT and is not a defect. Most objectives are only
 * observable some time after the execution ends, and a great many are not
 * observable by us at all. A capability that cannot test its own objective
 * reports UNKNOWN forever, and the case study says so.
 *
 * NOT_APPLICABLE is separate from both, and the separation is load-bearing.
 * A purchase request the organization DECLINED did not fail: the workflow ran
 * correctly and the right answer was "no". Its objective — the material
 * arriving — never applied. Recording that as NOT_ACHIEVED would invent a
 * failure; recording it as ACHIEVED would invent a saving; recording it as
 * UNKNOWN would claim we are still waiting for something that will never come.
 * It is excluded from valuation, and the human minutes it consumed are still
 * reported, so a decline is visible as a cost rather than as nothing.
 */
export const OBJECTIVE_RESULTS = Object.freeze(['ACHIEVED', 'NOT_ACHIEVED', 'UNKNOWN', 'NOT_APPLICABLE']);

/** Who did a thing: a person, or the system acting alone. */
export const ACTOR_KINDS = Object.freeze(['HUMAN', 'SYSTEM']);

/** Why a human was involved. The categories bill differently against savings. */
export const TOUCH_KINDS = Object.freeze([
  'ORIGINATION',   // a human started the work. Present in the baseline too.
  'APPROVAL',      // a governance step AWE deliberately keeps human.
  'EXCEPTION',     // AWE could not proceed and a person unblocked it.
  'CORRECTION',    // a person fixed something AWE got wrong.
  'SUPERVISION',   // a person checked work AWE did.
  'ROUTINE',       // ordinary operation of the tool.
]);

/**
 * One human interaction, from the capability's audit trail.
 *
 * `action` is the capability's own audit action, unchanged. That is deliberate:
 * the touch standard prices the same word the audit log recorded, so a reader
 * tracing a figure lands on a real row rather than a translated category.
 *
 * `observedMinutes` is normally null — see the long note in baseline.mjs. When
 * a real duration IS available (a future dwell-time instrument, or a stopwatch
 * session), it is set here and it OVERRIDES the standard, promoting that touch
 * to MEASURED. The arithmetic already prefers it; nothing has to change when
 * the instrument arrives.
 */
export function humanTouch({ action, actorId, at, kind = 'ROUTINE', observedMinutes = null, note = null }) {
  if (!TOUCH_KINDS.includes(kind)) throw new Error(`unknown touch kind: ${kind}`);
  if (!action) throw new Error('a human touch must name the action that was recorded');
  if (!actorId) throw new Error('a human touch must name the human — a touch nobody performed is a system step');
  if (!at) throw new Error('a human touch must say when');
  if (observedMinutes !== null && !(Number.isFinite(observedMinutes) && observedMinutes >= 0)) {
    throw new Error(`observedMinutes must be a non-negative number or null (got ${observedMinutes})`);
  }
  return Object.freeze({ action, actorId, at, kind, observedMinutes, note });
}

/**
 * The test that decides objective success, and the evidence it read.
 *
 * A capability declares this once per objective. It is DATA rather than a
 * function so that the case study can print the sentence that was tested, and
 * so a reader can disagree with the test rather than with the number.
 */
export function objectiveTest({ name, statement, result, evidence = [], measuredAt = null, note = null }) {
  if (!OBJECTIVE_RESULTS.includes(result)) throw new Error(`unknown objective result: ${result}`);
  if (!statement) throw new Error('an objective test must state, in words, what it claims');
  if (!['UNKNOWN', 'NOT_APPLICABLE'].includes(result) && evidence.length === 0) {
    throw new Error(`objective test "${name}" claims ${result} with no evidence — then it is UNKNOWN`);
  }
  return Object.freeze({ name, statement, result, evidence: Object.freeze([...evidence]), measuredAt, note });
}

/**
 * What changed in the business, as a consequence.
 *
 * SEPARATE from objective success and never inferred from it. The material
 * arriving on time is the objective; the crew not standing idle for a morning
 * is the business outcome, and the second does not follow from the first
 * without somebody establishing that it did. `attribution` is where that
 * establishing is recorded, with its own grade — this is the correlation /
 * causation seam and it is guarded by requiring a source, not by a comment.
 */
export function businessOutcome({ name, statement, attribution, evidence = [], claims = [], note = null }) {
  if (!statement) throw new Error('a business outcome must state what changed');
  if (!['CAUSAL_EVIDENCE', 'OPERATOR_ATTRIBUTION', 'CORRELATION_ONLY'].includes(attribution)) {
    throw new Error(`attribution must be CAUSAL_EVIDENCE, OPERATOR_ATTRIBUTION or CORRELATION_ONLY (got ${attribution})`);
  }
  if (evidence.length === 0) throw new Error(`business outcome "${name}" has no evidence`);
  // A CORRELATION_ONLY outcome may be recorded — it is a real observation — but
  // it may not carry a money claim, because a dollar figure attached to
  // "these two things moved together" is the exact sentence this system exists
  // to make unwritable.
  if (attribution === 'CORRELATION_ONLY' && claims.length > 0) {
    throw new Error(
      `business outcome "${name}" is CORRELATION_ONLY and may not carry a money claim — ` +
      'establish attribution, or record the observation without a figure');
  }
  return Object.freeze({
    name, statement, attribution,
    evidence: Object.freeze([...evidence]),
    claims: Object.freeze([...claims]),
    note,
  });
}

/**
 * One execution of one capability for one organization.
 *
 * `scopeKey` is the anti-double-counting identity: the thing in the real world
 * this execution did work on, in a form stable across capabilities. For PCC it
 * is the purchase request id. Two executions — a retry, or a second capability
 * touching the same request — share a scopeKey, and the ledger banks the work
 * once. Without it, every retry is free money.
 */
export function executionRecord({
  id, orgId, capability, workflow, objectiveId,
  baselineId, baselineVersion = null, scopeKey,
  startedAt, endedAt,
  executionOutcome, refusalReason = null, errorCode = null,
  humanTouches = [],
  // IS THE HUMAN-TOUCH LIST COMPLETE FOR THIS EXECUTION?
  //
  // The arithmetic treats an empty touch list as a MEASURED zero, on the
  // grounds that an audit log recording no human rows IS the measurement. That
  // is true of PCC, whose activity log writes a row for every human action, and
  // it is a property of THAT CAPABILITY'S INSTRUMENTATION rather than of this
  // model.
  //
  // Generalizing the proof layer to a second capability found the seam. TEGG's
  // run ledger records that a human action was REQUIRED — it does not record
  // who performed one, or when. An adapter that emitted no touches for such a
  // run would be read as "no human involved", which is the largest possible
  // saving, from a capability that cannot see its own humans. That error runs
  // in the direction that flatters us, so it is refused rather than defaulted.
  //
  // `true` keeps every existing caller exactly as it was. A capability whose
  // trail is partial says so, and its human minutes are UNAVAILABLE — not zero
  // — until it records the actor and the moment.
  humanTouchesComplete = true,
  retries = 0,
  objective = null,
  outcomes = [],
  cycle = null,
  meta = {},
}) {
  if (!id || !orgId || !capability || !workflow) {
    throw new Error('an execution record needs id, orgId, capability and workflow');
  }
  if (!EXECUTION_OUTCOMES.includes(executionOutcome)) {
    throw new Error(`unknown execution outcome: ${executionOutcome}`);
  }
  if (!scopeKey) {
    throw new Error(`execution ${id} has no scopeKey — without it a retry is counted as a second saving`);
  }
  if (!baselineId) {
    throw new Error(`execution ${id} names no baseline — work with nothing to compare against cannot be valued`);
  }
  if (!startedAt) throw new Error(`execution ${id} must say when it started`);
  if (executionOutcome === 'REFUSED' && !refusalReason) {
    throw new Error(`execution ${id} refused without naming a reason — an unexplained refusal is a failure`);
  }
  if (executionOutcome === 'FAILED' && !errorCode) {
    throw new Error(`execution ${id} failed without an error code`);
  }
  if (executionOutcome !== 'REFUSED' && refusalReason) {
    throw new Error(`execution ${id} carries a refusal reason but did not refuse`);
  }
  for (const t of humanTouches) {
    if (!t.actorId) throw new Error(`execution ${id} has a human touch with no human`);
  }

  return Object.freeze({
    id, orgId, capability, workflow, objectiveId,
    baselineId, baselineVersion, scopeKey,
    startedAt, endedAt,
    executionOutcome, refusalReason, errorCode,
    humanTouches: Object.freeze([...humanTouches]),
    humanTouchesComplete,
    retries,
    objective,
    outcomes: Object.freeze([...outcomes]),
    // Elapsed wall-clock through the process, for cycle-time comparison ONLY.
    // Deliberately a separate field from anything the labour arithmetic reads,
    // and `value.mjs` never touches it. Machine and waiting time are not
    // labour, and the cheapest way to guarantee that is for the labour path to
    // have no access to this number at all.
    cycle: cycle ? Object.freeze({ ...cycle }) : null,
    meta: Object.freeze({ ...meta }),
    /** Did the run do its steps? */
    executionSucceeded: executionOutcome === 'COMPLETED',
    /** Did the organization get what it wanted? Never derived from the above. */
    objectiveResult: objective?.result ?? 'UNKNOWN',
  });
}

/**
 * Human touches that count as work AWE did NOT remove.
 *
 * Every kind counts. There is no category of human involvement that is free,
 * and the temptation to exclude "approval, because we chose to keep that human"
 * is exactly the selection bias this list refuses. If a person spent four
 * minutes approving, those four minutes were spent whatever the reason.
 */
export function chargeableTouches(record) {
  return record.humanTouches;
}

/** The distinct people who touched this execution. */
export function humansInvolved(record) {
  return [...new Set(record.humanTouches.map((t) => t.actorId))];
}

/** Touch counts by kind — the shape a case study reports interventions in. */
export function touchProfile(record) {
  const profile = Object.fromEntries(TOUCH_KINDS.map((k) => [k, 0]));
  for (const t of record.humanTouches) profile[t.kind] += 1;
  return profile;
}

/**
 * The cycle-time record: elapsed real time from the organization asking to the
 * organization having.
 *
 * Elapsed, not handling. Named so nobody confuses the two, and carrying its own
 * provenance because a start timestamp the system wrote is measured while one
 * reconstructed from a paper file is not.
 */
export function cycleRecord({ from, to, elapsedHours, provenance, sources = [], label }) {
  return Object.freeze({
    from, to, label,
    elapsed: quantity({
      value: provenance === 'UNAVAILABLE' ? null : elapsedHours,
      unit: 'hours', provenance, sources,
      basis: `elapsed time, ${label} — real time, not human handling time`,
    }),
  });
}

/** Convenience for adapters reading two system-written timestamps. */
export function cycleFromTimestamps({ from, to, label, ref }) {
  if (!from || !to) {
    return cycleRecord({ from: from ?? null, to: to ?? null, elapsedHours: null, provenance: 'UNAVAILABLE', label });
  }
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) {
    return cycleRecord({ from, to, elapsedHours: null, provenance: 'UNAVAILABLE', label });
  }
  return cycleRecord({
    from, to, label,
    elapsedHours: ms / 3_600_000,
    provenance: 'MEASURED',
    sources: [source({ kind: 'SYSTEM_RECORD', ref })],
  });
}
