// ---------------------------------------------------------------------------
// execute.mjs — the reusable run scaffolding.
//
// The eight steps every AWE execution has to perform, in one place, so that a
// runner, a web route, an MCP tool and a future unattended worker all terminate
// the same way:
//
//   1. receive a run request        -> the caller's input
//   2. construct execution context  -> createExecutionContext (context.mjs)
//   3. pass through shared gates    -> the workflow's own fail-closed gates
//   4. execute deterministic logic  -> `body(context)`
//   5. produce a standardized outcome -> an outcome envelope, always
//   6. emit sanitized audit events  -> the audit sink
//   7. persist a durable report     -> the artifact sink
//   8. terminate with an explicit final state -> `final_state`
//
// The contract that makes this safe to run unattended: **nothing the workflow
// does can escape as an exception.** A body that throws becomes `failed`; a body
// that returns something that is not an outcome envelope becomes
// `failed('contract_violation')`; a sink that cannot write downgrades the final
// state to `incomplete` rather than letting a run report itself completed on the
// strength of a write that did not land. There is no path out of here that
// leaves a caller guessing about the run.
//
// The one exception is a malformed CALL — no body, or a context that is not an
// execution context. That is a wiring bug in the caller, not a result of the
// run, and it rejects loudly rather than being recorded as a failed run.
//
// This module executes nothing on its own behalf: no clock, no randomness, no
// I/O, no network. Every effect belongs to the injected `body` or the injected
// sinks.
// ---------------------------------------------------------------------------

import { assertExecutionContext, runMetadata } from './context.mjs';
import { invariant } from './errors.mjs';
import { sequence } from './events.mjs';
import { assertOutcome, createOutcome, failed, fromError } from './outcome.mjs';
import { buildReport, finalStateFor, reportPath } from './report.mjs';

// Attach the run's correlation ids to whatever meta the workflow already set.
// Explicit run metadata wins over a workflow's own key of the same name: the
// scaffolding owns identity, the workflow owns everything else.
function withRunMetadata(outcome, context) {
  return createOutcome({
    status: outcome.status,
    blocked_reason: outcome.blocked_reason,
    error: outcome.error,
    data: outcome.data,
    events: outcome.events,
    audit: outcome.audit,
    verify: outcome.verify,
    meta: { ...outcome.meta, ...runMetadata(context) },
  });
}

async function callSink(fn) {
  try {
    const result = await fn();
    if (result === null || result === undefined) return { ok: false, error: 'sink returned nothing' };
    return { ...result, ok: result.ok === true, error: result.error ?? null };
  } catch (e) {
    // A sink that throws is a failed write, not a failed run: the outcome above
    // it stays exactly what the workflow decided.
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * runWorkflow({ context, body, artifacts, audit, summary, requireArtifact, finished_at })
 *
 *   body(context) -> outcome envelope (may be async)
 *   artifacts     -> ArtifactSink | null   (sinks.mjs)
 *   audit         -> AuditSink | null
 *   summary       -> optional, redacted, caller-chosen detail for the report
 *   finished_at   -> ISO instant supplied by the caller (the kernel has no clock)
 *
 * Returns, always:
 *   { outcome, report, artifact, audit_result, final_state, duplicates }
 */
export async function runWorkflow({
  context,
  body,
  artifacts = null,
  audit = null,
  summary = null,
  requireArtifact = null,
  finished_at = null,
} = {}) {
  assertExecutionContext(context, { at: 'runWorkflow' });
  invariant(typeof body === 'function', 'invalid_input', 'runWorkflow needs a body function', {});

  // Persistence is required whenever a sink was supplied, unless the caller says
  // otherwise. Opting out is a decision someone has to write down.
  const mustPersist = requireArtifact === null ? artifacts !== null : requireArtifact === true;

  let outcome;
  try {
    const produced = await body(context);
    // A workflow that forgets to return an envelope is a contract violation, not
    // a success with an odd shape.
    try {
      assertOutcome(produced, { context: { workflow: context.workflow_id, run: context.run_id } });
      outcome = produced;
    } catch (e) {
      outcome = failed('contract_violation', `workflow '${context.workflow_id}' did not return an outcome envelope: ${e?.message ?? e}`);
    }
  } catch (e) {
    outcome = fromError(e);
  }

  outcome = withRunMetadata(outcome, context);

  // Ordered and duplicate-checked before anything durable sees them.
  const batch = sequence(outcome.events);

  let auditResult = null;
  if (audit !== null) {
    auditResult = await callSink(() => audit.emit(outcome.events, context));
  }

  // The report is built BEFORE the write, with the persistence outcome folded in
  // afterwards, so the artifact on disk states its own final state truthfully.
  const provisional = buildReport({ context, outcome, finished_at, summary, persisted: true });
  const path = reportPath(provisional);

  let artifactResult = null;
  let persisted = true;
  if (artifacts !== null) {
    artifactResult = await callSink(() => artifacts.write(provisional, { path }));
    persisted = artifactResult.ok;
  }

  const auditOk = audit === null || auditResult.ok;
  const durable = (!mustPersist || persisted) && auditOk;

  const report = durable
    ? provisional
    : buildReport({ context, outcome, finished_at, summary, persisted: false });

  const final_state = durable
    ? finalStateFor(outcome.status)
    : 'incomplete';

  // A downgraded report is worth one more attempt to store — an incomplete run
  // that left no record at all is the worst of both.
  if (!durable && artifacts !== null && artifactResult.ok) {
    await callSink(() => artifacts.write(report, { path: reportPath(report) }));
  }

  return Object.freeze({
    outcome,
    report,
    artifact: artifactResult,
    audit_result: auditResult,
    final_state,
    duplicates: batch.duplicates,
  });
}
