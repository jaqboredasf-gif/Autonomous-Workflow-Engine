// ---------------------------------------------------------------------------
// budget.mjs — the execution budget.
//
// An agent loop that stops when the model stops wanting things is not bounded;
// it is bounded BY the model, which is the same as not being bounded. Four
// independent budgets, all declared in the agent definition, all NOT NULL and
// all > 0 by construction:
//
//   max_turns       how many times the planner may be asked
//   max_steps       how many governed steps the run may take at all
//                   (a refused proposal is a step: a run that proposes
//                    forbidden actions forever must terminate too)
//   max_tool_calls  how many times a tool may actually be invoked
//   run_timeout_ms  wall clock, against an INJECTED clock
//
// FOUR REASONS, NOT ONE. `budget_turns_exhausted` and `budget_time_exhausted`
// call for completely different responses — a bigger turn budget versus a
// faster tool — and an operator should not have to read a detail string to tell
// them apart.
//
// The ledger is a projection of what a run has already recorded, so a resumed
// run in a different process reconstructs it exactly: `fromJournalState()`
// counts the run's own history rather than trusting a counter that lived in the
// process that paused.
//
// TIME IS MEASURED OVER ACTIVE SEGMENTS, not wall time since the run began.
// A run that waited three days for a human approval has not spent three days of
// budget — the same rule `engine.mjs` applies, for the same reason: a gate that
// punished an operator for thinking would train people to approve quickly.
//
// PURE: no clock (instants are arguments), no randomness, no I/O.
// ---------------------------------------------------------------------------

import { deepFreeze, invariant, isInstant } from './kernel.mjs';

export const BUDGET_DIMENSIONS = ['turns', 'steps', 'tool_calls', 'time'];

const REASON_FOR = Object.freeze({
  turns: 'budget_turns_exhausted',
  steps: 'budget_steps_exhausted',
  tool_calls: 'budget_tool_calls_exhausted',
  time: 'budget_time_exhausted',
});

// Milliseconds between two instants. `Date.parse` is a pure string→number
// function that reads nothing from the system clock — the same reasoning, and
// the same exception to the no-clock rule, that `engine.mjs:instantDelta`
// documents.
function elapsedMs(from, to) {
  if (!isInstant(from) || !isInstant(to)) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

/**
 * createBudgetLedger({ budget, spent, segment_started_at })
 *
 *   budget             — the agent definition's budget block
 *   spent              — { turns, steps, tool_calls, elapsed_ms } already used
 *   segment_started_at — when the CURRENT active segment began
 */
export function createBudgetLedger({ budget, spent = {}, segment_started_at = null } = {}) {
  invariant(budget !== null && budget !== undefined, 'invalid_input', 'a budget ledger needs a budget', {});

  let turns = spent.turns ?? 0;
  let steps = spent.steps ?? 0;
  let tool_calls = spent.tool_calls ?? 0;
  const carried_ms = spent.elapsed_ms ?? 0;

  const elapsed = (now) => {
    const segment = segment_started_at === null || now === null ? 0 : (elapsedMs(segment_started_at, now) ?? 0);
    return carried_ms + segment;
  };

  const remaining = (now = null) => deepFreeze({
    turns: Math.max(0, budget.max_turns - turns),
    steps: Math.max(0, budget.max_steps - steps),
    tool_calls: Math.max(0, budget.max_tool_calls - tool_calls),
    time_ms: Math.max(0, budget.run_timeout_ms - elapsed(now)),
  });

  /**
   * check({ now, dimensions }) -> { ok, reason, detail }
   *
   * Returns DATA. An exhausted budget is a normal terminal outcome the harness
   * records, not an exception — and it is checked BEFORE the work rather than
   * discovered after it, so the last thing a run does is refuse rather than act.
   */
  function check({ now = null, dimensions = BUDGET_DIMENSIONS } = {}) {
    const ok = deepFreeze({ ok: true, reason: null, detail: null, dimension: null });
    const no = (dimension, detail) => deepFreeze({
      ok: false, reason: REASON_FOR[dimension], detail, dimension,
    });

    if (dimensions.includes('turns') && turns >= budget.max_turns) {
      return no('turns', `the planner has been asked ${turns} time(s); the budget is ${budget.max_turns}`);
    }
    if (dimensions.includes('steps') && steps >= budget.max_steps) {
      return no('steps', `the run has taken ${steps} governed step(s); the budget is ${budget.max_steps}`);
    }
    if (dimensions.includes('tool_calls') && tool_calls >= budget.max_tool_calls) {
      return no('tool_calls', `the run has invoked ${tool_calls} tool call(s); the budget is ${budget.max_tool_calls}`);
    }
    if (dimensions.includes('time')) {
      const used = elapsed(now);
      if (now !== null && used > budget.run_timeout_ms) {
        return no('time', `the run has been active ${used}ms; the budget is ${budget.run_timeout_ms}ms`);
      }
    }
    return ok;
  }

  return Object.freeze({
    check,
    remaining,
    spendTurn() { turns += 1; return turns; },
    spendStep() { steps += 1; return steps; },
    spendToolCall() { tool_calls += 1; return tool_calls; },
    elapsedMs(now = null) { return elapsed(now); },
    spent() { return deepFreeze({ turns, steps, tool_calls, elapsed_ms: carried_ms }); },
    limits: budget,
  });
}

/**
 * spentFromJournal(state) -> { turns, steps, tool_calls, elapsed_ms }
 *
 * What this run has ALREADY used, counted from its own append-only history. This
 * is what makes a resume in a second process exact: nothing is carried in
 * memory, and a worker that never saw the first half of a run still knows how
 * much of the budget it has left.
 *
 * `elapsed_ms` sums the CLOSED active segments — each `workflow.started` or
 * `workflow.resumed` up to the `workflow.paused` that ended it. Time spent
 * paused is not in any segment and is therefore not spent.
 */
export function spentFromJournal(state) {
  const timeline = state?.timeline ?? [];
  const turns = timeline.filter((t) => t.event_type === 'agent.turn_started').length;
  const steps = timeline.filter((t) => t.event_type === 'agent.policy_decided').length;
  const tool_calls = (state?.executed_tools ?? []).filter((t) => t.replayed !== true).length;

  let elapsed_ms = 0;
  let openedAt = null;
  for (const entry of timeline) {
    if (entry.event_type === 'workflow.started' || entry.event_type === 'workflow.resumed') {
      openedAt = entry.occurred_at;
      continue;
    }
    if (entry.event_type === 'workflow.paused' && openedAt !== null) {
      elapsed_ms += elapsedMs(openedAt, entry.occurred_at) ?? 0;
      openedAt = null;
    }
  }
  return { turns, steps, tool_calls, elapsed_ms };
}

/**
 * segmentStartedAt(state) -> instant | null
 *
 * When the current active segment began: the most recent `workflow.started` or
 * `workflow.resumed`. Null for a run that is paused, which is exactly right —
 * a paused run's segment is closed and its clock is not running.
 */
export function segmentStartedAt(state) {
  const timeline = state?.timeline ?? [];
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const entry = timeline[i];
    if (entry.event_type === 'workflow.paused') return null;
    if (entry.event_type === 'workflow.started' || entry.event_type === 'workflow.resumed') return entry.occurred_at;
  }
  return null;
}
