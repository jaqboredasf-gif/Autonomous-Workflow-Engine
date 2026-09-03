// ---------------------------------------------------------------------------
// journal.mjs — the append-only Run Journal and the run state projection.
//
// The problem this solves: `runWorkflow` produces an outcome and a report, and
// both are SNAPSHOTS. A run that pauses for a human, is resumed by a different
// process an hour later, retries a step, and then compensates has a history
// that no snapshot can express — and, worse, has a "current state" that some
// caller could set to anything it liked.
//
// The journal is the record; the state is a PROJECTION of it. There is no
// setter. `projectRunState()` folds the events through an explicit transition
// table, so:
//
//   * current state cannot contradict the event history, because it is derived
//     from the history on every read rather than stored alongside it;
//   * an illegal transition (an approval granted on a run that never requested
//     one, an event after a terminal state) is a `contract_violation`, not a
//     state that quietly wins;
//   * the entries are hash-chained — each entry commits to its predecessor's
//     digest — so removing, reordering or editing an entry is detectable
//     without a database, which is what makes "append-only" a property rather
//     than an intention.
//
// Events reuse the kernel's envelope (redaction, content-addressed
// `event_key`), so a journal entry is already safe to persist and already
// deduplicable. The journal adds `seq` and the chain on top.
//
// PURE: no clock, no randomness, no I/O. `occurred_at` is supplied per append.
// ---------------------------------------------------------------------------

import { assertEvent, canonicalClone, createEvent, deepFreeze, digest, invariant } from './kernel.mjs';

export const RUN_JOURNAL_SCHEMA = 'awe.run_journal/v1';

// The lifecycle a run can be in. `paused` and `awaiting_approval` are separate
// on purpose: "we have asked for a decision" and "we have stopped and released
// the caller" are different facts, and an operator needs to see both.
export const RUN_STATES = [
  'pending',
  'running',
  'awaiting_approval',
  'paused',
  'approved',
  'rejected',
  'compensating',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
];

export const TERMINAL_STATES = ['completed', 'failed', 'cancelled', 'timed_out'];

/**
 * The transition table IS the state machine. Every event type names the states
 * it may occur in and the state it produces. An event type absent from this
 * table cannot be appended at all, which is what stops the vocabulary drifting
 * as new code is written.
 */
export const TRANSITIONS = Object.freeze({
  'workflow.started': { from: ['pending'], to: 'running' },
  'step.started': { from: ['running'], to: 'running' },
  'tool.invoked': { from: ['running', 'compensating'], to: null },
  'step.completed': { from: ['running'], to: 'running' },
  'step.failed': { from: ['running'], to: 'running' },
  // A conditional step whose `when` did not hold. It is a first-class event
  // rather than an absence, because a run whose history simply does NOT mention
  // the approval step cannot be told apart from one where the step was removed
  // from the manifest — and "why did this payment go out without an approval?"
  // is exactly the question an audit has to answer.
  'step.skipped': { from: ['running'], to: 'running' },
  'approval.requested': { from: ['running'], to: 'awaiting_approval' },
  'workflow.paused': { from: ['awaiting_approval'], to: 'paused' },
  // ONE principal's vote, and it deliberately moves nothing (`to: null`). A
  // quorum above one means several people vote before the gate opens, and a
  // state that flipped to `approved` on the first vote could not express "one
  // of the two required approvals has been received" — the run would already be
  // resumable. Separating the votes from the gate is what makes a quorum a gate
  // rather than a label.
  'approval.recorded': { from: ['paused', 'awaiting_approval'], to: null },
  // The gate itself. Appended by the engine only once the quorum is satisfied,
  // so its presence in a journal IS the proof that enough distinct people said
  // yes — a reader does not have to count votes to know.
  'approval.granted': { from: ['paused', 'awaiting_approval'], to: 'approved' },
  // One rejection closes the gate whatever has accumulated: an approval quorum
  // is a floor on agreement, not a majority vote.
  'approval.denied': { from: ['paused', 'awaiting_approval'], to: 'rejected' },
  'workflow.resumed': { from: ['paused', 'approved'], to: 'running' },
  // `paused` and `awaiting_approval` are here because cancelling a run that is
  // waiting for a human must still undo what it already committed — and
  // `cancelled` is terminal, so the rollback has to happen BEFORE it.
  'compensation.requested': { from: ['running', 'rejected', 'compensating', 'paused', 'awaiting_approval'], to: 'compensating' },
  'compensation.completed': { from: ['compensating'], to: 'compensating' },
  'compensation.failed': { from: ['compensating'], to: 'compensating' },
  // --- the governed agent plane ---------------------------------------------
  //
  // Added for the Governed Agent Execution Plane (`packages/awe-agent`). Every
  // one of them has `to: null`: an agent event RECORDS a decision and moves
  // nothing. A run's state still changes only through the workflow, step and
  // approval events above, so an agent cannot reach a state a workflow cannot,
  // and the projection below needed no new state.
  //
  // They live in THIS table rather than in a second, agent-shaped journal
  // because two hash-chained histories for one run is precisely the
  // disagreement "state is projected, never stored" exists to prevent. An
  // agent run is a run; it is simply one whose steps were proposed at runtime
  // instead of declared in a manifest.
  //
  // All of them occur while the run is `running`. A resumed agent run
  // re-validates AFTER `workflow.resumed` has returned it to `running`, so a
  // revalidation refusal is recorded in the same state as a first-pass one.
  'agent.turn_started': { from: ['running'], to: null },
  'agent.context_assembled': { from: ['running'], to: null },
  'agent.action_proposed': { from: ['running'], to: null },
  'agent.proposal_refused': { from: ['running'], to: null },
  // The Policy Decision Record: immutable audit evidence of allow /
  // require_approval / deny, with the versions and reason codes it was decided
  // on. A model cannot write one, because a model never appends to a journal.
  'agent.policy_decided': { from: ['running'], to: null },
  // A tool result, recorded as an OBSERVATION. The distinction is the point:
  // an observation is data the next turn may read, never an instruction the
  // runtime obeys.
  'agent.observation_recorded': { from: ['running'], to: null },
  // An evaluation record's digest, written before the run terminates. It
  // records; it can activate nothing.
  'agent.evaluated': { from: ['running'], to: null },

  'workflow.completed': { from: ['running'], to: 'completed' },
  'workflow.failed': { from: ['running', 'compensating', 'rejected'], to: 'failed' },
  'workflow.cancelled': { from: ['running', 'paused', 'awaiting_approval', 'compensating'], to: 'cancelled' },
  'workflow.timed_out': { from: ['running', 'compensating'], to: 'timed_out' },
});

export const RUN_EVENT_TYPES = Object.freeze(Object.keys(TRANSITIONS).sort());

/**
 * The subset of `RUN_EVENT_TYPES` that only the governed agent plane produces.
 *
 * Named as its own vocabulary so each suite can be held to the part of the
 * table it is responsible for: Runner P covers every WORKFLOW event type and is
 * explicitly not expected to produce an agent one, and Runner G covers all of
 * these. Without the split, adding an agent event type would silently weaken
 * Runner P's coverage gate from "everything" to "everything I happen to reach".
 */
export const AGENT_EVENT_TYPES = Object.freeze(
  RUN_EVENT_TYPES.filter((t) => t.startsWith('agent.')),
);

export const WORKFLOW_EVENT_TYPES = Object.freeze(
  RUN_EVENT_TYPES.filter((t) => !t.startsWith('agent.')),
);

const ENTITY_TYPE = 'workflow_run';

// --- entries -----------------------------------------------------------------

// The chain link. `prev_digest` of the first entry is the run's own genesis
// digest, so a journal cannot be re-parented onto another run.
export function genesisDigest({ run_id, workflow_id, workflow_version, org_id }) {
  return digest({ schema: RUN_JOURNAL_SCHEMA, run_id, workflow_id, workflow_version, org_id });
}

function makeEntry({ seq, prev_digest, event }) {
  const body = { seq, prev_digest, event: canonicalClone(event) };
  return deepFreeze({ ...body, entry_digest: digest(body) });
}

/**
 * createRunJournal({ run_id, workflow_id, workflow_version, org_id, entries })
 *
 * Passing `entries` rehydrates a journal that was persisted and read back —
 * which is exactly what a resume across two separate application-service calls
 * does. Rehydration re-verifies the chain, so a tampered file cannot be
 * resumed.
 */
export function createRunJournal({
  run_id, workflow_id, workflow_version, org_id = null, entries = [],
} = {}) {
  invariant(typeof run_id === 'string' && run_id.length > 0, 'invalid_input', 'a run journal needs a run_id', { run_id });
  invariant(typeof workflow_id === 'string' && workflow_id.length > 0, 'invalid_input', 'a run journal needs a workflow_id', { workflow_id });
  invariant(typeof workflow_version === 'string' && workflow_version.length > 0, 'invalid_input', 'a run journal needs a workflow_version', { workflow_version });

  const genesis = genesisDigest({ run_id, workflow_id, workflow_version, org_id });
  const log = [];

  // Rehydrate through the same verification a reader gets, so a corrupted
  // journal is refused at load rather than at some later projection.
  if (entries.length > 0) {
    verifyChain(entries, { genesis, run_id });
    log.push(...entries.map((e) => deepFreeze(canonicalClone(e))));
  }

  function append({ event_type, payload = {}, occurred_at = null, entity_id = null }) {
    const transition = TRANSITIONS[event_type];
    invariant(
      transition !== undefined,
      'invalid_input', `'${event_type}' is not a run journal event type`,
      { event_type, known: RUN_EVENT_TYPES },
    );

    const state = projectRunState(log, { genesis, run_id }).state;
    invariant(
      transition.from.includes(state),
      'contract_violation',
      `'${event_type}' cannot occur while the run is '${state}' (allowed from ${transition.from.join('|')})`,
      { event_type, state, allowed: transition.from, run_id },
    );

    const seq = log.length + 1;
    const event = createEvent({
      event_type,
      entity_type: ENTITY_TYPE,
      entity_id: entity_id ?? run_id,
      org_id,
      // `seq` inside the payload is what makes two structurally identical
      // events (two attempts of the same step) distinct to the kernel's
      // content-addressed `event_key`, so an audit sink cannot dedupe away a
      // real repetition.
      payload: { ...payload, seq, run_id, workflow_id, workflow_version },
      occurred_at,
    });

    const entry = makeEntry({
      seq,
      prev_digest: seq === 1 ? genesis : log[log.length - 1].entry_digest,
      event,
    });
    log.push(entry);
    return entry;
  }

  return Object.freeze({
    run_id,
    workflow_id,
    workflow_version,
    org_id,
    genesis,
    append,
    entries() { return Object.freeze([...log]); },
    events() { return log.map((e) => e.event); },
    length() { return log.length; },
    state() { return projectRunState(log, { genesis, run_id }); },
    head() { return log.length === 0 ? genesis : log[log.length - 1].entry_digest; },
    // The persistable document. Self-describing and self-verifying: everything
    // `createRunJournal` needs to rehydrate is in here.
    toDocument() {
      const body = {
        schema: RUN_JOURNAL_SCHEMA,
        run_id,
        workflow_id,
        workflow_version,
        org_id,
        genesis,
        entry_count: log.length,
        head: log.length === 0 ? genesis : log[log.length - 1].entry_digest,
        entries: canonicalClone(log),
      };
      return deepFreeze({ ...body, journal_digest: digest(body) });
    },
  });
}

/**
 * loadRunJournal(document) -> journal
 *
 * The read side of `toDocument()`. Verifies the document's own digest before
 * verifying the chain, so a hand-edited file is refused for the cheapest
 * possible reason first.
 */
export function loadRunJournal(document) {
  invariant(
    document !== null && typeof document === 'object' && !Array.isArray(document),
    'contract_violation', 'a run journal document must be an object', {},
  );
  invariant(
    document.schema === RUN_JOURNAL_SCHEMA,
    'contract_violation', `run journal schema '${document.schema}' is not '${RUN_JOURNAL_SCHEMA}'`, {},
  );
  const { journal_digest, ...rest } = document;
  invariant(
    digest(rest) === journal_digest,
    'contract_violation', 'journal_digest does not match the journal content',
    { expected: digest(rest), actual: journal_digest },
  );
  return createRunJournal({
    run_id: document.run_id,
    workflow_id: document.workflow_id,
    workflow_version: document.workflow_version,
    org_id: document.org_id,
    entries: document.entries,
  });
}

/**
 * verifyChain(entries, { genesis, run_id })
 *
 * Three independent things have to hold, and each catches a different attack on
 * the history: sequence numbers catch a deletion, the digest chain catches a
 * reorder or an edit, and the kernel's own `event_key` catches a payload
 * rewritten in place.
 */
export function verifyChain(entries, { genesis = null, run_id = null } = {}) {
  invariant(Array.isArray(entries), 'contract_violation', 'a run journal is an array of entries', {});
  let previous = genesis;

  entries.forEach((entry, index) => {
    invariant(
      entry !== null && typeof entry === 'object',
      'contract_violation', `journal entry ${index} is not an object`, { index, run_id },
    );
    invariant(
      entry.seq === index + 1,
      'contract_violation', `journal entry ${index} claims seq ${entry.seq} — the log has a gap or a reordering`,
      { index, seq: entry.seq, run_id },
    );
    if (previous !== null) {
      invariant(
        entry.prev_digest === previous,
        'contract_violation',
        `journal entry ${entry.seq} does not chain to its predecessor — the history was edited, reordered or spliced`,
        { seq: entry.seq, expected: previous, actual: entry.prev_digest, run_id },
      );
    }
    const { entry_digest, ...body } = entry;
    invariant(
      digest(body) === entry_digest,
      'contract_violation', `journal entry ${entry.seq} digest does not match its content`,
      { seq: entry.seq, expected: digest(body), actual: entry_digest, run_id },
    );
    // The kernel's own check: the event's content-addressed key must still
    // match its payload.
    assertEvent(entry.event, { seq: entry.seq, run_id });
    previous = entry_digest;
  });

  return entries.length === 0 ? genesis : entries[entries.length - 1].entry_digest;
}

// --- the projection ----------------------------------------------------------

/**
 * projectRunState(entries, { genesis, run_id, verify }) -> frozen state
 *
 * The ONLY way to know what a run's state is. It folds the verified history
 * through `TRANSITIONS`; there is no stored `state` column anywhere in this
 * package for it to disagree with.
 */
export function projectRunState(entries, { genesis = null, run_id = null, verify = true } = {}) {
  if (verify) verifyChain(entries, { genesis, run_id });

  let state = 'pending';
  const completed_steps = [];
  const failed_steps = [];
  const skipped_steps = [];
  const executed_tools = [];
  const approvals = [];
  const approval_votes = [];
  const compensations = [];
  const timeline = [];
  let pending_approval = null;
  let failure = null;
  let current_step = null;
  let attempts = 0;

  for (const entry of entries) {
    const { event } = entry;
    const transition = TRANSITIONS[event.event_type];
    invariant(
      transition !== undefined,
      'contract_violation', `journal holds unknown event type '${event.event_type}'`,
      { seq: entry.seq, event_type: event.event_type, run_id },
    );
    invariant(
      transition.from.includes(state),
      'contract_violation',
      `journal is self-contradictory: '${event.event_type}' at seq ${entry.seq} cannot follow state '${state}'`,
      { seq: entry.seq, event_type: event.event_type, state, allowed: transition.from, run_id },
    );

    const p = event.payload ?? {};
    switch (event.event_type) {
      case 'step.started':
        current_step = p.step_id ?? null;
        attempts = p.attempt ?? 1;
        break;
      case 'tool.invoked':
        executed_tools.push({
          step_id: p.step_id ?? null,
          tool: p.tool ?? null,
          tool_version: p.tool_version ?? null,
          side_effect: p.side_effect ?? null,
          idempotency_key: p.idempotency_key ?? null,
          // Carried so a LATER process can rebuild the dispatcher's effect
          // memory and still detect a conflicting re-invocation.
          input_digest: p.input_digest ?? null,
          replayed: p.replayed === true,
          seq: entry.seq,
        });
        break;
      case 'step.completed':
        completed_steps.push({ step_id: p.step_id ?? null, tool: p.tool ?? null, seq: entry.seq });
        current_step = null;
        break;
      case 'step.failed':
        failed_steps.push({ step_id: p.step_id ?? null, reason: p.reason ?? null, attempt: p.attempt ?? null, seq: entry.seq });
        break;
      case 'step.skipped':
        skipped_steps.push({
          step_id: p.step_id ?? null,
          tool: p.tool ?? null,
          predicate_digest: p.predicate_digest ?? null,
          // The comparisons that were made, with the DECLARED (manifest) values
          // and a digest of what was actually seen — never the actual value.
          // See predicate.mjs on why that asymmetry is the two-store rule
          // applied to conditions.
          leaves: p.leaves ?? [],
          seq: entry.seq,
        });
        current_step = null;
        break;
      case 'approval.requested':
        pending_approval = {
          approval_id: p.approval_id ?? null,
          step_id: p.step_id ?? null,
          tool: p.tool ?? null,
          side_effect: p.side_effect ?? null,
          org_id: event.org_id,
          approver_roles: p.approver_roles ?? [],
          quorum: p.quorum ?? 1,
          // The accumulator. `votes` is what makes "one person may not satisfy a
          // quorum of two" checkable by the approval rules without those rules
          // needing to re-read the journal themselves.
          votes: [],
          outstanding: p.quorum ?? 1,
          requested_at: event.occurred_at,
          reason: p.reason ?? null,
        };
        break;
      case 'approval.recorded': {
        const vote = {
          approval_id: p.approval_id ?? null,
          decision: p.decision ?? null,
          principal: p.principal ?? null,
          roles: p.roles ?? [],
          note: p.note ?? null,
          recorded_at: event.occurred_at,
          seq: entry.seq,
        };
        approval_votes.push(vote);
        if (pending_approval !== null) {
          pending_approval.votes = [...pending_approval.votes, vote];
          const yes = pending_approval.votes.filter((v) => v.decision === 'approve').length;
          pending_approval.outstanding = Math.max(0, pending_approval.quorum - yes);
        }
        break;
      }
      case 'approval.granted':
      case 'approval.denied': {
        const forThis = approval_votes.filter((v) => v.approval_id === (p.approval_id ?? null));
        approvals.push({
          approval_id: p.approval_id ?? null,
          decision: event.event_type === 'approval.granted' ? 'approve' : 'reject',
          // The principal who CLOSED the gate. `principals` is who satisfied it
          // — for a quorum of one those are the same person, and a report that
          // showed only the last name for a quorum of three would understate
          // who is accountable.
          principal: p.principal ?? null,
          principals: forThis
            .filter((v) => v.decision === (event.event_type === 'approval.granted' ? 'approve' : 'reject'))
            .map((v) => v.principal),
          quorum: p.quorum ?? 1,
          roles: p.roles ?? [],
          note: p.note ?? null,
          decided_at: event.occurred_at,
          seq: entry.seq,
        });
        pending_approval = null;
        break;
      }
      case 'compensation.requested':
        compensations.push({ step_id: p.step_id ?? null, compensates: p.compensates ?? null, status: 'requested', seq: entry.seq });
        break;
      case 'compensation.completed':
      case 'compensation.failed': {
        const status = event.event_type === 'compensation.completed' ? 'completed' : 'failed';
        const open = [...compensations].reverse().find((c) => c.step_id === (p.step_id ?? null) && c.status === 'requested');
        if (open !== undefined) open.status = status;
        else compensations.push({ step_id: p.step_id ?? null, compensates: p.compensates ?? null, status, seq: entry.seq });
        break;
      }
      case 'workflow.failed':
      case 'workflow.timed_out':
      case 'workflow.cancelled':
        failure = { reason: p.reason ?? null, detail: p.detail ?? null, step_id: p.step_id ?? null };
        break;
      default:
        break;
    }

    timeline.push({
      seq: entry.seq,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      step_id: p.step_id ?? null,
      detail: p.detail ?? p.reason ?? null,
    });

    if (transition.to !== null) state = transition.to;
  }

  // Post-terminal appends are caught by the transition table (no event lists a
  // terminal state in `from`), which is why this needs no separate check.
  return deepFreeze({
    state,
    terminal: TERMINAL_STATES.includes(state),
    current_step,
    attempts,
    completed_steps,
    failed_steps,
    skipped_steps,
    executed_tools,
    approvals,
    approval_votes,
    pending_approval,
    compensations,
    failure,
    timeline,
    event_count: entries.length,
    last_seq: entries.length,
    head: entries.length === 0 ? genesis : entries[entries.length - 1].entry_digest,
  });
}
