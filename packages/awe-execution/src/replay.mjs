import {
  canonicalClone, deepFreeze, digest, invariant,
} from './kernel.mjs';
import { assertExecutionContract } from './contracts.mjs';

const STATE_BY_EVENT = Object.freeze({
  'job.accepted': 'accepted',
  'job.scheduled': 'scheduled',
  'job.ready': 'ready',
  'lease.claimed': 'leased',
  'execution.started': 'running',
  'retry.started': 'running',
  'checkpoint.committed': 'checkpointing',
  'execution.paused': 'waiting',
  'approval.requested': 'waiting_for_approval',
  'retry.scheduled': 'retry_scheduled',
  'recovery.started': 'recovering',
  'recovery.completed': 'ready',
  'compensation.requested': 'compensating',
  'cancellation.requested': 'cancelling',
  'cancellation.completed': 'cancelled',
  'execution.cancelled': 'cancelled',
  'execution.completed': 'completed',
  'execution.failed': 'failed',
  'job.dead_lettered': 'dead_lettered',
});

export const REPLAY_CLASSIFICATIONS = [
  'exact_execution_replay',
  'checkpoint_replay',
  'control_decision_replay',
  'simulated_external_effect_replay',
  'current_state_reexecution',
  'divergence',
];

export function verifyExecutionEventChain(events, where = {}) {
  invariant(Array.isArray(events) && events.length > 0, 'execution_replay_empty', 'execution replay needs at least one event', where);
  let previous = null;
  for (const [index, event] of events.entries()) {
    assertExecutionContract('execution_event', event, { ...where, index });
    invariant(event.sequence === index + 1, 'execution_event_corrupt', `event sequence is not dense at ${index + 1}`, where);
    invariant(event.previous_digest === previous, 'execution_event_corrupt', `event chain breaks at ${index + 1}`, where);
    const core = canonicalClone(event);
    delete core.schema;
    delete core.document_digest;
    delete core.event_digest;
    invariant(digest(core) === event.event_digest, 'execution_event_corrupt', `event digest mismatch at ${index + 1}`, where);
    previous = event.event_digest;
  }
  return true;
}

export function replayExecution({
  events,
  checkpoint = null,
  expected_state = null,
  mode = 'control_decision_replay',
  external_effects = 'simulate',
} = {}) {
  invariant(REPLAY_CLASSIFICATIONS.includes(mode), 'invalid_input', `unknown replay classification '${mode}'`, {});
  invariant(['simulate', 'captured_only', 'forbid'].includes(external_effects), 'invalid_input', 'external effect replay mode is invalid', {});
  verifyExecutionEventChain(events);
  if (checkpoint !== null) {
    assertExecutionContract('checkpoint', checkpoint, { at: 'replayExecution' });
    const [first] = events;
    invariant(
      checkpoint.run_id === first.run_id
      && checkpoint.job_id === first.job_id
      && checkpoint.org_id === first.org_id,
      'execution_replay_identity_mismatch',
      'checkpoint and execution history identities disagree',
      {},
    );
  }
  let state = null;
  const decisions = [];
  const effects = [];
  for (const event of events) {
    if (STATE_BY_EVENT[event.event_type] !== undefined) state = STATE_BY_EVENT[event.event_type];
    if (
      event.event_type.startsWith('lease.')
      || event.event_type.startsWith('retry.')
      || event.event_type.startsWith('recovery.')
      || event.event_type.startsWith('approval.')
      || event.event_type.startsWith('cancellation.')
    ) decisions.push({
      sequence: event.sequence,
      event_type: event.event_type,
      payload_digest: digest(event.payload),
    });
    if (event.event_type.startsWith('effect.')) {
      invariant(external_effects !== 'forbid', 'execution_replay_external_effect', 'replay encountered a captured external effect', {});
      effects.push({
        sequence: event.sequence,
        event_type: event.event_type,
        effect_id: event.payload.effect_id ?? null,
        simulated: true,
      });
    }
  }
  const diverged = expected_state !== null && expected_state !== state;
  return deepFreeze({
    schema: 'awe.execution_replay/v1',
    classification: diverged ? 'divergence' : mode,
    state,
    expected_state,
    diverged,
    checkpoint_id: checkpoint?.checkpoint_id ?? null,
    checkpoint_digest: checkpoint?.checkpoint_digest ?? null,
    event_count: events.length,
    event_head: events[events.length - 1].event_digest,
    decisions,
    effects,
    tools_invoked: 0,
    models_invoked: 0,
    replay_digest: digest({
      state,
      checkpoint_digest: checkpoint?.checkpoint_digest ?? null,
      event_head: events[events.length - 1].event_digest,
      decisions,
      effects,
    }),
  });
}
