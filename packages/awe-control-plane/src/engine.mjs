// ---------------------------------------------------------------------------
// engine.mjs — the run engine: the explicit workflow / run / step state machine.
//
// Everything above this file decides; this file is what actually walks a
// manifest's steps and is the ONLY writer to a run journal. That single-writer
// property is deliberate — if the dispatcher, the approval path and the engine
// could all append, "the state cannot contradict the history" would depend on
// three modules agreeing.
//
// The loop, once:
//
//   for each remaining step:
//     cancellation requested?           -> workflow.cancelled          [stop]
//     run budget exhausted?             -> workflow.timed_out          [stop]
//     step.started
//     dispatch (policy + approval + idempotency + step budget)
//       blocked: approval_required      -> approval.requested,
//                                          workflow.paused             [stop, resumable]
//       blocked: anything else          -> step.failed -> on_failure
//       failed / step_timeout           -> retry up to max_attempts, then on_failure
//       ok                              -> tool.invoked, step.completed
//   workflow.completed
//
// on_failure is per step and has two values, both of which terminate:
//   'fail'        -> workflow.failed
//   'compensate'  -> compensation.requested / .completed for every completed
//                    step that has a registered compensator, newest first,
//                    then workflow.failed
//
// PAUSE AND RESUME. A paused run is a journal and nothing else. `advanceRun()`
// takes a rehydrated journal and continues from the projected state, so the
// process that resumes need share no memory with the process that paused — see
// the operator CLI, which genuinely uses three separate node processes.
//
// The engine never throws for a workflow's own failure: every path returns an
// outcome envelope. It throws only for a wiring bug (no manifest, no journal).
//
// PURE apart from the injected dispatcher, clock and adapters.
// ---------------------------------------------------------------------------

import {
  assertContextBundle, blocked, deepFreeze, digest, invariant, isInstant, succeeded,
} from './kernel.mjs';
import { validateContextRequirements } from './manifest.mjs';
import { createRunJournal, projectRunState } from './journal.mjs';
import { evaluateApprovalDecision } from './policy.mjs';
import { evaluatePredicate, predicateDigest, predicateScope } from './predicate.mjs';

// How a call into the engine ended, for a caller that has to decide whether to
// wait for a human or report a result. Distinct from the run STATE, which is
// projected from the journal.
export const ADVANCE_OUTCOMES = ['completed', 'paused', 'failed', 'cancelled', 'timed_out'];

function approvalId({ run_id, step_id, attempt }) {
  return `apr-${digest({ run_id, step_id, attempt })}`;
}

/**
 * createRunEngine({ registry, dispatcher, policy, clock })
 *
 * `clock` supplies `occurred_at` for journal events and drives the run budget.
 * It is injected rather than read, so a simulator replays a run byte for byte.
 */
export function createRunEngine({ registry, dispatcher, policy, clock = null } = {}) {
  invariant(registry !== null && registry !== undefined, 'invalid_input', 'the run engine needs a workflow registry', {});
  invariant(dispatcher !== null && dispatcher !== undefined, 'invalid_input', 'the run engine needs a tool dispatcher', {});
  invariant(policy !== null && policy !== undefined, 'invalid_input', 'the run engine needs a policy engine', {});

  const now = () => (clock === null ? null : clock());

  // --- compensation --------------------------------------------------------

  // The compensators for a set of completed steps, newest first. A compensator
  // is a step whose `compensates` names an already-completed step; it is NOT
  // run in the forward pass (the loop skips it) and exists only for this.
  function compensatorsFor(manifest, completedStepIds) {
    return manifest.steps
      .filter((s) => s.compensates !== null && completedStepIds.includes(s.compensates))
      .reverse();
  }

  async function compensate({ journal, manifest, context, deps, state, results = {}, bundle = null }) {
    const completed = state.completed_steps.map((s) => s.step_id);
    const compensators = compensatorsFor(manifest, completed);
    let allOk = true;

    for (const step of compensators) {
      journal.append({
        event_type: 'compensation.requested',
        occurred_at: now(),
        payload: { step_id: step.id, compensates: step.compensates, tool: step.tool },
      });

      const invocation = await dispatcher.invoke({
        manifest,
        step,
        // A compensator gets the same input envelope a forward step gets — it
        // needs the output of the step it is undoing (the draft id, the record
        // id) and cannot be expected to re-derive it.
        input: { ...resolveInput(step, { results, bundle, context }), compensates: step.compensates },
        context,
        deps,
        // A compensation is authorized by the same policy as any other tool use
        // — it is a real side effect. It is exempt only from the approval gate,
        // because refusing to undo a committed effect while waiting for a
        // second human decision is how a system ends up half-applied.
        approved: true,
        compensating: true,
      });

      if (invocation.ok) {
        journal.append({
          event_type: 'compensation.completed',
          occurred_at: now(),
          payload: { step_id: step.id, compensates: step.compensates, tool: step.tool },
        });
      } else {
        allOk = false;
        journal.append({
          event_type: 'compensation.failed',
          occurred_at: now(),
          payload: {
            step_id: step.id,
            compensates: step.compensates,
            reason: invocation.reason,
            detail: invocation.detail,
          },
        });
      }
    }
    return { ok: allOk, count: compensators.length };
  }

  // --- the forward loop ----------------------------------------------------

  /**
   * advanceRun({ journal, manifest, context, bundle, deps, cancel, results })
   *   -> { outcome, state, advance }
   *
   * `results` is the step-output map, keyed by step id. It is passed IN (a
   * resuming process seeds it from the result store) and MUTATED in place, so
   * the caller can persist it afterwards. It is not carried in the journal on
   * purpose: a journal records that a step ran and the digest of what it
   * produced, never the body — see `packages/awe-runtime/src/result-store.mjs`.
   */
  async function advanceRun({
    journal, manifest, context, bundle = null, deps = {}, cancel = null, results = {},
  } = {}) {
    invariant(journal !== null && journal !== undefined, 'invalid_input', 'advanceRun needs a run journal', {});
    invariant(manifest !== null && manifest !== undefined, 'invalid_input', 'advanceRun needs a manifest', {});

    // The dispatcher's effect memory is rebuilt from the journal on every call,
    // so a resuming process knows what an earlier one already committed.
    dispatcher.rehydrate(journal.state().executed_tools);

    // The run budget bounds ACTIVE EXECUTION, not elapsed wall time: it is
    // measured from the start of the current segment (the last `workflow.started`
    // or `workflow.resumed`), so time spent waiting for a human approval never
    // expires a run. A gate that punished an operator for taking the afternoon
    // to decide would train people to approve quickly, which is the opposite of
    // what an approval gate is for.
    const segmentStart = [...journal.entries()].reverse()
      .find((e) => e.event.event_type === 'workflow.started' || e.event.event_type === 'workflow.resumed');
    const runStartedAt = segmentStart?.event?.occurred_at ?? context.started_at ?? null;

    const finish = (advance, outcome) => {
      const state = journal.state();
      return deepFreeze({ advance, outcome, state, run_id: journal.run_id });
    };

    // A run that is still waiting for a human is NOT advanced. Falling through
    // here would try to start a step from `paused`, which the journal correctly
    // refuses — but refusing loudly at the boundary is the honest answer to
    // "resume a run nobody has decided on yet".
    const entry = journal.state();
    if (entry.state === 'paused' || entry.state === 'awaiting_approval') {
      return finish('paused', blocked('approval_required', {
        audit: auditTrail(journal),
        events: journal.events(),
        meta: {
          approval_id: entry.pending_approval?.approval_id ?? null,
          step_id: entry.pending_approval?.step_id ?? null,
          detail: 'the run is waiting for a human decision; nothing was advanced',
        },
      }));
    }

    // Steps that exist only to undo another step are not part of the forward
    // path; the engine reaches them through `compensate()`.
    const forwardSteps = manifest.steps.filter((s) => s.compensates === null);

    // Loop progress. Every iteration that does not return must move exactly one
    // step out of the "remaining" set — by completing it or by skipping it. If
    // one does not, the loop would pick the same step again forever, and the
    // only thing that would eventually stop it is the run budget, after an
    // unbounded number of journal appends.
    //
    // This is a wiring invariant, not a workflow outcome, so it THROWS rather
    // than returning an envelope: a manifest cannot cause it and no operator can
    // fix it. It exists because a perturbation of the skipped-step bookkeeping
    // turned a test failure into a hang, and a control plane that can spin is
    // worse than one that fails loudly.
    let lastRemaining = Number.POSITIVE_INFINITY;

    for (;;) {
      const state = journal.state();
      if (state.terminal) {
        return finish(state.state === 'completed' ? 'completed' : state.state, terminalOutcome(state, manifest, journal));
      }

      // A skipped step is DONE for the purposes of advancing — its condition did
      // not hold and it is never revisited. It is deliberately not in
      // `completed_steps`, because a compensator must not roll back a step that
      // never ran, and `compensatorsFor` reads exactly that list.
      const done = new Set([
        ...state.completed_steps.map((s) => s.step_id),
        ...state.skipped_steps.map((s) => s.step_id),
      ]);
      const next = forwardSteps.find((s) => !done.has(s.id));

      const remaining = forwardSteps.filter((s) => !done.has(s.id)).length;
      invariant(
        remaining < lastRemaining,
        'contract_violation',
        `run '${journal.run_id}' made no progress: ${remaining} step(s) still remaining after an iteration that neither completed nor skipped one`,
        { run_id: journal.run_id, remaining, step_id: next?.id ?? null },
      );
      lastRemaining = remaining;

      if (next === undefined) {
        const finalState = journal.state();
        journal.append({
          event_type: 'workflow.completed',
          occurred_at: now(),
          payload: {
            // What RAN, and what was skipped, kept separate. A single `steps`
            // count that included skipped steps would tell a reader a
            // conditional run did more than it did.
            steps: finalState.completed_steps.length,
            skipped: finalState.skipped_steps.length,
            manifest_digest: manifest.manifest_digest,
          },
        });
        return finish('completed', succeeded(
          {
            run_id: journal.run_id,
            workflow_id: manifest.workflow_id,
            workflow_version: manifest.version,
            steps_completed: journal.state().completed_steps.length,
            steps_skipped: journal.state().skipped_steps.length,
            results,
          },
          { audit: auditTrail(journal), events: journal.events() },
        ));
      }

      // Cancellation is checked at the step boundary rather than mid-adapter:
      // a control plane that could interrupt a tool halfway through would have
      // no idea whether its effect landed.
      if (cancel !== null && cancel.requested === true) {
        // Compensate FIRST, then record the cancellation. `cancelled` is
        // terminal, and a terminal state accepts no further events — so undoing
        // after recording would be an illegal transition, correctly refused by
        // the journal.
        await compensate({ journal, manifest, context, deps, state: journal.state(), results, bundle });
        journal.append({
          event_type: 'workflow.cancelled',
          occurred_at: now(),
          payload: { reason: 'run_cancelled', detail: cancel.reason ?? 'cancellation requested', step_id: next.id },
        });
        return finish('cancelled', blocked('run_cancelled', {
          audit: auditTrail(journal), events: journal.events(),
          meta: { cancelled_before_step: next.id },
        }));
      }

      // Run budget. Measured from the first journal event, so a run that paused
      // overnight is judged on its own elapsed time and not on process uptime.
      const overrun = runOverrun(runStartedAt, now(), manifest.limits.run_timeout_ms);
      if (overrun !== null) {
        journal.append({
          event_type: 'workflow.timed_out',
          occurred_at: now(),
          payload: { reason: 'run_timeout', detail: overrun, step_id: next.id },
        });
        return finish('timed_out', blocked('run_timeout', {
          audit: auditTrail(journal), events: journal.events(), meta: { detail: overrun },
        }));
      }

      // The conditional edge, evaluated BEFORE anything else the step would do
      // — before the policy check, before the approval gate, before the
      // dispatcher. A step whose condition does not hold has not been refused;
      // it was never asked for, and running the authorization machinery on it
      // would put refusals in the journal for work nobody requested.
      if (next.when !== null && next.when !== undefined) {
        const verdict = evaluatePredicate(
          next.when,
          predicateScope({ results, input: next.input, context }),
        );
        if (!verdict.matched) {
          journal.append({
            event_type: 'step.skipped',
            occurred_at: now(),
            payload: {
              step_id: next.id,
              tool: next.tool,
              predicate_digest: predicateDigest(next.when),
              leaves: verdict.leaves,
              detail: 'the step\'s `when` condition did not hold',
            },
          });
          continue;
        }
      }

      const approvedForStep = approvalGranted(journal.state(), next.id);
      const stepResult = await runStep({
        journal, manifest, context, bundle, deps, step: next, results, approved: approvedForStep,
      });

      if (stepResult.kind === 'paused') return finish('paused', stepResult.outcome);
      if (stepResult.kind === 'terminated') return finish(stepResult.advance, stepResult.outcome);
      // 'completed' — fall through to the next step.
    }
  }

  // One step, including its retries. Returns a discriminated result rather than
  // mutating shared state, so the loop above reads as a sequence of decisions.
  async function runStep({ journal, manifest, context, bundle, deps, step, results, approved }) {
    const maxAttempts = manifest.limits.max_attempts;
    let last = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      journal.append({
        event_type: 'step.started',
        occurred_at: now(),
        payload: { step_id: step.id, tool: step.tool, attempt, max_attempts: maxAttempts },
      });

      const input = resolveInput(step, { results, bundle, context });
      const invocation = await dispatcher.invoke({ manifest, step, input, context, deps, approved });
      last = invocation;

      if (invocation.ok) {
        journal.append({
          event_type: 'tool.invoked',
          occurred_at: now(),
          payload: {
            step_id: step.id,
            tool: invocation.descriptor.name,
            tool_version: invocation.descriptor.version,
            side_effect: invocation.descriptor.side_effect,
            idempotency_key: invocation.idempotency_key,
            input_digest: digest(input),
            replayed: invocation.replayed,
            elapsed_ms: invocation.elapsed_ms,
            // The RESULT is recorded as a digest, never as a body: a journal is
            // a control-plane record, and the tables that already hold customer
            // data under RLS are where the body belongs.
            result_digest: invocation.data === null ? null : digest(invocation.data),
          },
        });
        results[step.id] = invocation.data;
        journal.append({
          event_type: 'step.completed',
          occurred_at: now(),
          payload: { step_id: step.id, tool: step.tool, attempt, replayed: invocation.replayed },
        });
        return { kind: 'completed' };
      }

      // An approval requirement is not a failure and is never retried: the run
      // stops and waits for a person.
      if (invocation.reason === 'approval_required') {
        const id = approvalId({ run_id: journal.run_id, step_id: step.id, attempt });
        journal.append({
          event_type: 'approval.requested',
          occurred_at: now(),
          payload: {
            approval_id: id,
            step_id: step.id,
            tool: invocation.descriptor.name,
            side_effect: invocation.descriptor.side_effect,
            approver_roles: invocation.obligations?.approver_roles ?? [],
            quorum: invocation.obligations?.quorum ?? 1,
            reason: 'approval_required',
            detail: invocation.detail,
          },
        });
        journal.append({
          event_type: 'workflow.paused',
          occurred_at: now(),
          payload: { reason: 'approval_required', step_id: step.id, approval_id: id },
        });
        return {
          kind: 'paused',
          outcome: blocked('approval_required', {
            audit: auditTrail(journal),
            events: journal.events(),
            meta: { approval_id: id, step_id: step.id, tool: invocation.descriptor.name },
          }),
        };
      }

      journal.append({
        event_type: 'step.failed',
        occurred_at: now(),
        payload: {
          step_id: step.id,
          tool: step.tool,
          attempt,
          reason: invocation.reason,
          detail: invocation.detail,
          retryable: isRetryable(invocation.reason) && attempt < maxAttempts,
        },
      });

      // A policy refusal, an unregistered tool or an idempotency conflict will
      // refuse identically every time. Retrying them burns the budget and hides
      // the reason behind an attempt count.
      if (!isRetryable(invocation.reason)) break;
    }

    return terminateOn({ journal, manifest, context, deps, step, invocation: last, results, bundle });
  }

  async function terminateOn({ journal, manifest, context, deps, step, invocation, results = {}, bundle = null }) {
    const reason = invocation?.reason ?? 'step_failed';
    const detail = invocation?.detail ?? null;

    if (step.on_failure === 'compensate') {
      const state = journal.state();
      // The entry into `compensating`: one requested marker naming the step
      // whose failure triggered the rollback, then one requested/completed pair
      // per registered compensator inside `compensate()`.
      journal.append({
        event_type: 'compensation.requested',
        occurred_at: now(),
        payload: { step_id: step.id, compensates: null, reason, detail },
      });
      const undone = await compensate({ journal, manifest, context, deps, state, results, bundle });
      journal.append({
        event_type: 'workflow.failed',
        occurred_at: now(),
        payload: { reason, detail, step_id: step.id, compensated: undone.count, compensation_ok: undone.ok },
      });
      return {
        kind: 'terminated',
        advance: 'failed',
        outcome: blocked(undone.ok ? reason : 'compensation_failed', {
          audit: auditTrail(journal),
          events: journal.events(),
          meta: { step_id: step.id, detail, compensated: undone.count },
        }),
      };
    }

    journal.append({
      event_type: 'workflow.failed',
      occurred_at: now(),
      payload: { reason, detail, step_id: step.id, compensated: 0 },
    });
    return {
      kind: 'terminated',
      advance: 'failed',
      outcome: blocked(reason, {
        audit: auditTrail(journal),
        events: journal.events(),
        meta: { step_id: step.id, detail },
      }),
    };
  }

  // --- starting and resuming ------------------------------------------------

  /**
   * startRun({ workflow_id, version, org_id, context, bundle, deps, cancel })
   *
   * The registry-backed entry point. There is no parameter through which a
   * caller can supply a workflow DEFINITION — only an id and a version
   * requirement — which is what makes bypassing the registry impossible rather
   * than merely discouraged.
   */
  async function startRun({
    workflow_id, version = null, context, bundle = null, deps = {}, cancel = null,
    require_promoted = true, results = {},
  } = {}) {
    invariant(context !== null && context !== undefined, 'invalid_input', 'startRun needs an execution context', {});

    const resolution = registry.resolve({
      workflow_id,
      version,
      org_id: context.org_id,
      require_promoted,
    });
    if (!resolution.ok) {
      return deepFreeze({
        advance: 'failed',
        run_id: context.run_id,
        state: null,
        journal: null,
        resolution,
        outcome: blocked(resolution.reason, {
          audit: [{ step: 'resolve_workflow', ok: false, detail: resolution.detail }],
          meta: { workflow_id, requested_version: version },
        }),
      });
    }
    const manifest = resolution.manifest;

    // The execution context must be for the workflow that resolved. A context
    // built for one workflow and executed against another's manifest is the
    // shape of every "we ran the wrong thing" incident.
    invariant(
      context.workflow_id === manifest.workflow_id,
      'contract_violation',
      `execution context is for workflow '${context.workflow_id}', not '${manifest.workflow_id}'`,
      { context_workflow: context.workflow_id, manifest_workflow: manifest.workflow_id },
    );

    if (bundle !== null) {
      assertContextBundle(bundle, { at: 'startRun' });
      invariant(
        bundle.run_id === context.run_id && bundle.org_id === context.org_id,
        'contract_violation',
        `context bundle belongs to run '${bundle.run_id}'/org '${bundle.org_id}', not '${context.run_id}'/'${context.org_id}'`,
        {},
      );
    }

    // Context requirements are checked BEFORE the first step, not lazily: a run
    // that is missing the org's policy items must not perform two low-risk
    // steps first and discover it at the consequential one.
    const contextCheck = validateContextRequirements(manifest, bundle ?? { items: [], org_id: context.org_id });
    if (!contextCheck.ok) {
      return deepFreeze({
        advance: 'failed',
        run_id: context.run_id,
        state: null,
        journal: null,
        resolution,
        outcome: blocked('context_requirements_unmet', {
          audit: [{ step: 'validate_context', ok: false, detail: `${contextCheck.unmet.length} unmet requirement(s)` }],
          meta: { unmet: contextCheck.unmet },
        }),
      });
    }

    const journal = createRunJournal({
      run_id: context.run_id,
      workflow_id: manifest.workflow_id,
      workflow_version: manifest.version,
      org_id: context.org_id,
    });

    journal.append({
      event_type: 'workflow.started',
      occurred_at: context.started_at ?? now(),
      payload: {
        manifest_digest: manifest.manifest_digest,
        risk: manifest.risk,
        promotion_status: manifest.promotion.status,
        actor: context.actor,
        mode: context.mode,
        dependencies: resolution.dependencies,
        context_bundle_digest: bundle?.bundle_digest ?? null,
        registry_digest: registry.registry_digest(),
        policy_digest: policy.policy_digest(),
      },
    });

    const advanced = await advanceRun({ journal, manifest, context, bundle, deps, cancel, results });
    return deepFreeze({ ...advanced, journal, manifest, resolution });
  }

  /**
   * submitApproval({ journal, manifest, context, decision, actor, principal,
   *                  principal_roles, org_id, note })
   *
   * Records a human decision on a paused run. It does NOT continue the run —
   * `advanceRun` does — so "who decided" and "what happened next" stay two
   * separate, separately auditable calls.
   *
   * QUORUM. Every submission appends `approval.recorded` — one vote, no state
   * change. The gate (`approval.granted`) is appended only when the manifest's
   * quorum of DISTINCT principals has approved, so a run with `quorum: 2` and
   * one approval is still paused and still refuses to advance. A single
   * rejection appends `approval.denied` immediately and terminates the gate
   * whatever has accumulated: a quorum is a floor on agreement, not a tally to
   * be out-voted.
   */
  function submitApproval({
    journal, manifest, decision: verb, actor = 'human', principal = null,
    principal_roles = [], org_id = null, note = null, approval_id = null,
  } = {}) {
    invariant(journal !== null && journal !== undefined, 'invalid_input', 'submitApproval needs a run journal', {});
    const state = journal.state();
    const pending = state.pending_approval;

    const verdict = evaluateApprovalDecision({
      manifest, pending, decision: verb, actor, principal, principal_roles, org_id,
    });
    if (!verdict.ok) {
      return deepFreeze({
        ok: false,
        reason: verdict.reason,
        detail: verdict.detail,
        state,
        outcome: blocked(verdict.reason, {
          audit: [{ step: 'submit_approval', ok: false, detail: verdict.detail }],
          meta: { run_id: journal.run_id, approval_id: pending?.approval_id ?? null },
        }),
      });
    }
    if (approval_id !== null && approval_id !== pending.approval_id) {
      return deepFreeze({
        ok: false,
        reason: 'approval_unknown',
        detail: `approval '${approval_id}' is not the approval pending on run '${journal.run_id}'`,
        state,
        outcome: blocked('approval_unknown', {
          audit: [{ step: 'submit_approval', ok: false, detail: 'approval id does not match the pending approval' }],
        }),
      });
    }

    const roles = [...(principal_roles ?? [])].sort();
    const quorum = pending.quorum ?? 1;
    const votePayload = {
      approval_id: pending.approval_id,
      step_id: pending.step_id,
      tool: pending.tool,
      decision: verb,
      principal,
      roles,
      note,
      quorum,
    };

    // The vote is always recorded, even the one that closes the gate. A journal
    // where the deciding vote were implicit in `approval.granted` would make
    // "who was the third approver" a matter of inference.
    journal.append({ event_type: 'approval.recorded', occurred_at: now(), payload: votePayload });

    // Re-projected rather than counted here: the journal is the authority on
    // how many distinct approvals are in force, and a second counter in the
    // engine could disagree with it.
    const accumulated = journal.state().pending_approval;
    const outstanding = verb === 'approve' ? (accumulated?.outstanding ?? 0) : 0;
    const satisfied = verb === 'reject' || outstanding === 0;

    if (!satisfied) {
      return deepFreeze({
        ok: true,
        reason: null,
        detail: `approval recorded; ${outstanding} of ${quorum} still outstanding`,
        decision: verb,
        approval_id: pending.approval_id,
        step_id: pending.step_id,
        quorum,
        outstanding,
        quorum_satisfied: false,
        principals: (accumulated?.votes ?? []).filter((v) => v.decision === 'approve').map((v) => v.principal),
        state: journal.state(),
      });
    }

    const principals = (accumulated?.votes ?? [])
      .filter((v) => v.decision === verb)
      .map((v) => v.principal);
    journal.append({
      event_type: verb === 'approve' ? 'approval.granted' : 'approval.denied',
      occurred_at: now(),
      payload: { ...votePayload, principals },
    });

    if (verb === 'approve') {
      journal.append({
        event_type: 'workflow.resumed',
        occurred_at: now(),
        payload: { step_id: pending.step_id, approval_id: pending.approval_id, resumed_by: principal },
      });
    }

    return deepFreeze({
      ok: true,
      reason: null,
      detail: null,
      decision: verb,
      approval_id: pending.approval_id,
      step_id: pending.step_id,
      quorum,
      outstanding: 0,
      quorum_satisfied: true,
      principals,
      state: journal.state(),
    });
  }

  /**
   * A denial is a terminal path, not a pause: the run compensates whatever it
   * already committed and fails with `approval_rejected`.
   */
  async function applyDenial({ journal, manifest, context, deps, results = {} }) {
    const state = journal.state();
    const denied = state.approvals[state.approvals.length - 1] ?? null;
    journal.append({
      event_type: 'compensation.requested',
      occurred_at: now(),
      payload: { step_id: denied?.approval_id ?? null, compensates: null, reason: 'approval_rejected' },
    });
    const undone = await compensate({ journal, manifest, context, deps, state, results });
    journal.append({
      event_type: 'workflow.failed',
      occurred_at: now(),
      payload: { reason: 'approval_rejected', detail: 'a human rejected the consequential step', compensated: undone.count, compensation_ok: undone.ok },
    });
    return deepFreeze({
      advance: 'failed',
      run_id: journal.run_id,
      state: journal.state(),
      outcome: blocked(undone.ok ? 'approval_rejected' : 'compensation_failed', {
        audit: auditTrail(journal),
        events: journal.events(),
        meta: { compensated: undone.count },
      }),
    });
  }

  /**
   * cancelRun — records the intent. The run terminates at the next step
   * boundary in `advanceRun`, or immediately here when it is already paused.
   */
  async function cancelRun({ journal, manifest, context, deps, results = {}, reason = 'operator cancelled' } = {}) {
    const state = journal.state();
    if (state.terminal) {
      return deepFreeze({
        advance: state.state, run_id: journal.run_id, state,
        outcome: blocked('run_cancelled', { audit: auditTrail(journal), meta: { already: state.state } }),
      });
    }
    // Same ordering rule as the in-loop cancellation: undo first, then close
    // the run, because `cancelled` accepts no further events.
    const undone = await compensate({ journal, manifest, context, deps, state, results });
    journal.append({
      event_type: 'workflow.cancelled',
      occurred_at: now(),
      payload: { reason: 'run_cancelled', detail: reason },
    });
    return deepFreeze({
      advance: 'cancelled',
      run_id: journal.run_id,
      state: journal.state(),
      outcome: blocked('run_cancelled', {
        audit: auditTrail(journal), events: journal.events(), meta: { detail: reason, compensated: undone.count },
      }),
    });
  }

  return Object.freeze({ startRun, advanceRun, submitApproval, applyDenial, cancelRun, compensate });
}

// --- helpers -----------------------------------------------------------------

// Reasons a retry could plausibly change. Everything else is deterministic
// refusal and is not retried.
const RETRYABLE_REASONS = ['step_failed', 'step_timeout'];

export function isRetryable(reason) {
  return RETRYABLE_REASONS.includes(reason);
}

// Was this step's approval granted (and not superseded by a later request)?
function approvalGranted(state, step_id) {
  const decisions = state.approvals.filter((a) => a.decision === 'approve');
  if (decisions.length === 0) return false;
  // The engine only ever pauses on one step at a time, so the most recent
  // granted approval is the one in force; the step it belongs to is recorded on
  // the `workflow.resumed` event's step_id via the timeline.
  const resumed = state.timeline.filter((t) => t.event_type === 'workflow.resumed');
  return resumed.some((t) => t.step_id === step_id);
}

// Step input: the manifest's literal input, plus the results of previous steps
// and the assembled context, made available under reserved keys. Reserved keys
// are prefixed so a manifest cannot accidentally shadow them.
function resolveInput(step, { results, bundle, context }) {
  return {
    ...step.input,
    _step_id: step.id,
    _run_id: context.run_id,
    _org_id: context.org_id,
    _results: results,
    _context_digest: bundle?.bundle_digest ?? null,
  };
}

function runOverrun(startedAt, nowInstant, budgetMs) {
  if (startedAt === null || nowInstant === null) return null;
  const elapsed = instantDelta(startedAt, nowInstant);
  if (elapsed === null || elapsed <= budgetMs) return null;
  return `run has been open ${elapsed}ms, over the ${budgetMs}ms budget`;
}

// Milliseconds between two instants.
//
// `Date.parse` is a pure string→number function: it reads nothing from the
// system clock and returns the same value on every machine for a fully
// qualified instant. This package bans `Date.now()` and `new Date()` for the
// same reason the kernel does — reading the clock destroys replayability — and
// permits parsing a timestamp the caller supplied, exactly as
// `events.mjs:instantEpochSeconds` already does. Millisecond precision is
// needed here (the kernel's helper floors to seconds), which is why this is not
// simply that function.
function instantDelta(from, to) {
  if (!isInstant(from) || !isInstant(to)) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

// The gate-decision trail a run report renders as a table.
function auditTrail(journal) {
  return journal.state().timeline.map((t) => ({
    step: `${t.seq}:${t.event_type}`,
    ok: !/failed|denied|cancelled|timed_out/.test(t.event_type),
    detail: t.step_id === null ? t.detail : `${t.step_id}${t.detail ? ` — ${t.detail}` : ''}`,
  }));
}

function terminalOutcome(state, manifest, journal) {
  if (state.state === 'completed') {
    return succeeded(
      { run_id: journal.run_id, workflow_id: manifest.workflow_id, workflow_version: manifest.version },
      { audit: auditTrail(journal), events: journal.events() },
    );
  }
  const reason = state.failure?.reason ?? 'step_failed';
  return blocked(reason, {
    audit: auditTrail(journal), events: journal.events(), meta: { detail: state.failure?.detail ?? null },
  });
}

// Re-exported so a caller that only imports the engine can still ask a journal
// document what state it is in without reaching for another module.
export { projectRunState };
