import { deepFreeze, invariant, isInstant } from './kernel.mjs';

export const EXECUTION_STATES = [
  'accepted',
  'scheduled',
  'ready',
  'leased',
  'running',
  'checkpointing',
  'waiting',
  'waiting_for_approval',
  'waiting_for_event',
  'waiting_until',
  'retry_scheduled',
  'recovering',
  'compensating',
  'cancelling',
  'cancelled',
  'completed',
  'failed',
  'dead_lettered',
];

export const TERMINAL_EXECUTION_STATES = ['cancelled', 'completed', 'failed', 'dead_lettered'];

export const EXECUTION_TRANSITIONS = deepFreeze({
  accepted: ['scheduled', 'ready', 'cancelling', 'failed'],
  scheduled: ['ready', 'cancelling', 'cancelled', 'failed'],
  ready: ['leased', 'cancelling', 'cancelled', 'failed', 'dead_lettered'],
  leased: ['running', 'ready', 'recovering', 'cancelling', 'failed'],
  running: [
    'checkpointing', 'waiting', 'waiting_for_approval', 'waiting_for_event',
    'waiting_until', 'retry_scheduled', 'recovering', 'compensating', 'cancelling',
    'completed', 'failed', 'dead_lettered',
  ],
  checkpointing: [
    'running', 'waiting', 'waiting_for_approval', 'waiting_for_event',
    'waiting_until', 'retry_scheduled', 'recovering', 'compensating', 'cancelling',
    'completed', 'failed', 'dead_lettered',
  ],
  waiting: ['ready', 'recovering', 'cancelling', 'cancelled', 'failed'],
  waiting_for_approval: ['ready', 'recovering', 'cancelling', 'cancelled', 'failed'],
  waiting_for_event: ['ready', 'recovering', 'cancelling', 'cancelled', 'failed'],
  waiting_until: ['ready', 'recovering', 'cancelling', 'cancelled', 'failed'],
  retry_scheduled: ['ready', 'recovering', 'cancelling', 'cancelled', 'dead_lettered', 'failed'],
  recovering: ['ready', 'leased', 'cancelling', 'failed', 'dead_lettered'],
  compensating: ['cancelling', 'cancelled', 'failed', 'dead_lettered'],
  cancelling: ['compensating', 'cancelled', 'failed', 'dead_lettered'],
  cancelled: [],
  completed: [],
  failed: [],
  dead_lettered: [],
});

export function canTransition(from, to) {
  return EXECUTION_STATES.includes(from)
    && EXECUTION_STATES.includes(to)
    && EXECUTION_TRANSITIONS[from].includes(to);
}

export function transitionExecutionRecord(record, {
  to,
  expected_version,
  occurred_at,
  reason_code = null,
  patch = {},
} = {}) {
  invariant(record !== null && typeof record === 'object' && !Array.isArray(record), 'invalid_input', 'transition needs an execution record', {});
  invariant(EXECUTION_STATES.includes(record.state), 'contract_violation', `unknown prior execution state '${record.state}'`, {});
  invariant(EXECUTION_STATES.includes(to), 'invalid_input', `unknown target execution state '${to}'`, {});
  invariant(Number.isInteger(record.state_version) && record.state_version >= 0, 'contract_violation', 'execution state_version is invalid', {});
  invariant(Number.isInteger(expected_version) && expected_version >= 0, 'invalid_input', 'expected_version is required', {});
  invariant(record.state_version === expected_version, 'state_version_conflict', `expected state version ${expected_version}, found ${record.state_version}`, {
    expected_version,
    actual_version: record.state_version,
  });
  invariant(canTransition(record.state, to), 'invalid_transition', `execution cannot transition ${record.state} -> ${to}`, {
    from: record.state,
    to,
  });
  invariant(isInstant(occurred_at), 'invalid_input', 'execution transition needs occurred_at', {});
  invariant(patch !== null && typeof patch === 'object' && !Array.isArray(patch), 'invalid_input', 'transition patch must be an object', {});
  invariant(!Object.hasOwn(patch, 'state') && !Object.hasOwn(patch, 'state_version'), 'invalid_input', 'transition patch cannot set state or state_version', {});

  return {
    ...record,
    ...patch,
    state: to,
    state_version: expected_version + 1,
    updated_at: occurred_at,
    terminal_reason: TERMINAL_EXECUTION_STATES.includes(to) ? reason_code : record.terminal_reason ?? null,
  };
}

export function assertCompatibleRunJob(run, job) {
  invariant(run.run_id === job.run_id && run.job_id === job.job_id, 'execution_state_inconsistent', 'run and job identities disagree', {});
  invariant(run.org_id === job.org_id, 'execution_tenant_violation', 'run and job tenants disagree', {});
  const bothTerminal = TERMINAL_EXECUTION_STATES.includes(run.state) && TERMINAL_EXECUTION_STATES.includes(job.state);
  if (bothTerminal) {
    invariant(run.state === job.state, 'execution_state_inconsistent', `terminal run/job states disagree (${run.state}/${job.state})`, {});
  }
  return true;
}
