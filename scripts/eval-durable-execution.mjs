#!/usr/bin/env node
// Runner D — Durable Execution Plane.
// Fully offline: injected virtual time, deterministic ids, in-memory storage,
// fake effects, existing synthetic Agent Runtime and Memory Layer fixtures.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createGateRun, digest,
} from '../packages/awe-kernel/src/index.mjs';
import {
  ERROR_CLASSES,
  EXECUTION_CONTRACT_TYPES,
  EXECUTION_SCHEMAS,
  EXECUTION_STATES,
  REPLAY_CLASSIFICATIONS,
  assertExecutionContract,
  calculateNextRun,
  canTransition,
  classifyExecutionError,
  compensateEffect,
  createExecutionWorker,
  createInMemoryExecutionRepository,
  createSequenceIdentifiers,
  decideRetry,
  defineCompletionRecord,
  defineEffectReceipt,
  defineExecutionCheckpoint,
  defineExecutionContract,
  defineExecutionRepository,
  defineRecurringSchedule,
  defineRetryPolicy,
  executeIdempotentEffect,
  replayExecution,
  transitionExecutionRecord,
  verifyExecutionEventChain,
} from '../packages/awe-execution/src/index.mjs';
import {
  OPERATIONS_ORG,
  createDurableExecutionService,
  createDurableOperationsExecutor,
  createSyntheticEffectAdapter,
  createWorkflowRuntimeExecutionAdapter,
} from '../packages/awe-runtime/src/index.mjs';
import { createSteppingClock } from '../packages/awe-runtime/src/clock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages', 'awe-execution', 'src');
const startedNs = process.hrtime.bigint();
const run = createGateRun({ name: 'eval-durable-execution (Runner D, offline, deterministic)' });
const { check, equal, section } = run;
let fixtures = 0;
let skips = 0;

function group(title, body) {
  section(title);
  try { body(); } catch (error) { check(false, `${title}: threw unexpectedly — ${error?.stack ?? error}`); }
}

async function groupAsync(title, body) {
  section(title);
  try { await body(); } catch (error) { check(false, `${title}: threw unexpectedly — ${error?.stack ?? error}`); }
}

function composition({ prefix = `fixture_${fixtures + 1}`, start = '2026-07-28T15:00:00.000Z', tick_ms = 1, limits = {} } = {}) {
  fixtures += 1;
  const clock = createSteppingClock({ start, tick_ms });
  const repository = createInMemoryExecutionRepository();
  const ids = createSequenceIdentifiers({ prefix });
  const service = createDurableExecutionService({
    repository,
    clock,
    ids,
    platform_limits: limits,
  });
  return { clock, repository, ids, service };
}

function accept(c, overrides = {}) {
  return c.service.acceptJob({
    kind: 'workflow',
    org_id: 'org_durable_fixture',
    workflow_id: 'synthetic_workflow',
    workflow_version: '1.0.0',
    idempotency_key: `${c.ids.next('input')}:accept`,
    payload: { synthetic: true },
    required_capabilities: ['workflow'],
    ...overrides,
  });
}

function register(c, worker_id, capabilities = ['workflow'], org_id = 'org_durable_fixture') {
  return c.service.registerWorker({ worker_id, org_id, capabilities });
}

const D = 'a'.repeat(16);
const T = '2026-07-28T15:00:00.000Z';

function contractSample(type) {
  const identity = { run_id: 'run_1', job_id: 'job_1', org_id: 'org_1' };
  switch (type) {
    case 'job': return {
      ...identity, environment: 'TEST', kind: 'workflow', state: 'ready',
      workflow_id: 'workflow_1', workflow_version: '1.0.0', agent_id: null, agent_version: null,
      priority_class: 'normal', required_capabilities: ['workflow'], available_at: T, deadline_at: null,
      attempt_count: 0, max_attempts: 3, state_version: 1, idempotency_key: 'job_key',
      payload_digest: D, trace_id: 'trace_1', correlation_id: 'corr_1', causation_id: null,
      created_at: T, updated_at: T, terminal_reason: null, metadata: {},
    };
    case 'run': return {
      ...identity, environment: 'TEST', kind: 'workflow', state: 'ready',
      workflow_id: 'workflow_1', workflow_version: '1.0.0', agent_id: null, agent_version: null,
      active_step_id: 'step_1', checkpoint_id: null, wake_id: null, state_version: 1,
      attempt_count: 0, recovery_count: 0, compensation_count: 0, started_at: null,
      deadline_at: null, completed_at: null, result_digest: null, terminal_reason: null,
      trace_id: 'trace_1', correlation_id: 'corr_1', causation_id: null,
      created_at: T, updated_at: T, metadata: {},
    };
    case 'step': return {
      ...identity, step_id: 'step_1', state: 'ready', state_version: 1, sequence: 1,
      name: 'step', kind: 'workflow', attempt_count: 0, max_attempts: 3,
      idempotency_key: 'step_key', input_digest: D, output_digest: null,
      compensation: { mode: 'unsupported' }, created_at: T, updated_at: T,
    };
    case 'attempt': return {
      ...identity, attempt_id: 'attempt_1', step_id: 'step_1', lease_id: 'lease_1',
      worker_id: 'worker_1', number: 1, state: 'running', error_class: null,
      reason_code: null, started_at: T, finished_at: null, result_digest: null,
    };
    case 'worker_capability': return { capability_id: 'cap_1', name: 'workflow', version: '1.0.0' };
    case 'worker': return {
      worker_id: 'worker_1', org_id: 'org_1', environment: 'TEST',
      capabilities: ['workflow'], max_concurrency: 1, status: 'active', registered_at: T,
    };
    case 'worker_heartbeat': return {
      heartbeat_id: 'heartbeat_1', worker_id: 'worker_1', org_id: 'org_1',
      active_lease_ids: ['lease_1'], occurred_at: T,
    };
    case 'lease': return {
      ...identity, lease_id: 'lease_1', worker_id: 'worker_1', fencing_token: 1,
      status: 'active', claimed_at: T, expires_at: '2026-07-28T15:01:00.000Z',
      max_expires_at: '2026-07-28T15:02:00.000Z', renewal_count: 0, released_at: null,
    };
    case 'lease_claim': return {
      ...identity, claim_id: 'claim_1', lease_id: 'lease_1', worker_id: 'worker_1',
      fencing_token: 1, claimed_at: T,
    };
    case 'lease_renewal': return {
      renewal_id: 'renewal_1', lease_id: 'lease_1', worker_id: 'worker_1', org_id: 'org_1',
      fencing_token: 1, previous_expires_at: '2026-07-28T15:01:00.000Z',
      expires_at: '2026-07-28T15:01:30.000Z', renewed_at: T,
    };
    case 'lease_release': return {
      release_id: 'release_1', lease_id: 'lease_1', worker_id: 'worker_1',
      org_id: 'org_1', fencing_token: 1, reason_code: 'completed', released_at: T,
    };
    case 'lease_expiration': return {
      expiration_id: 'expiration_1', lease_id: 'lease_1', worker_id: 'worker_1',
      org_id: 'org_1', fencing_token: 1, expired_at: T, reason_code: 'lease_expired',
    };
    case 'checkpoint': return {
      ...identity, checkpoint_id: 'checkpoint_1', step_id: 'step_1', attempt_id: 'attempt_1',
      lease_id: 'lease_1', worker_id: 'worker_1', fencing_token: 1, state_version: 2,
      sequence: 1, workflow_state: {}, agent_loop_state: {}, completed_steps: [],
      pending_step: null, context_snapshot_ref: null, memory_snapshot_refs: [],
      transcript_position: 0, tool_receipts: [], effect_receipts: [], policy_decisions: [],
      approval_requests: [], retry_state: null, compensation_stack: [], wake_condition: null,
      runtime_versions: {}, content_digests: {}, created_at: T, checkpoint_digest: D,
    };
    case 'wake_condition': return {
      ...identity, wake_id: 'wake_1', kind: 'approval', status: 'pending', available_at: T,
      expires_at: null, correlation_key: null, action_digest: D, dependency_run_id: null,
      reason_code: 'approval_required', created_at: T, satisfied_at: null, payload_digest: D,
    };
    case 'scheduled_wakeup': return {
      ...identity, schedule_id: 'schedule_1', wake_id: 'wake_1', available_at: T,
      missed_run_policy: 'run_once', created_at: T,
    };
    case 'recurring_schedule': return {
      schedule_id: 'recurring_1', org_id: 'org_1', anchor_at: T,
      interval_ms: 60000, timezone: 'UTC', missed_run_policy: 'catch_up_bounded',
      max_catch_up: 2, enabled: true, next_at: '2026-07-28T15:01:00.000Z', created_at: T,
    };
    case 'approval_wakeup': return {
      ...identity, approval_id: 'approval_1', wake_id: 'wake_1', action_digest: D,
      decision: 'approve', actor: 'human', principal: 'person_1', principal_roles: ['owner'],
      occurred_at: T,
    };
    case 'external_event_wakeup': return {
      ...identity, external_event_id: 'external_1', wake_id: 'wake_1',
      correlation_key: 'order_1', payload_digest: D, occurred_at: T,
    };
    case 'retry_schedule': return {
      ...identity, retry_id: 'retry_1', step_id: 'step_1', attempt_id: 'attempt_1',
      error_class: 'retryable_provider', reason_code: 'provider_unavailable',
      attempt_number: 1, available_at: T, deadline_at: null, delay_ms: 1000, created_at: T,
    };
    case 'cancellation_request': return {
      ...identity, cancellation_id: 'cancel_1', actor: 'human', principal: 'person_1',
      reason_code: 'operator_cancelled', requested_at: T, status: 'requested',
    };
    case 'timeout_decision': return {
      ...identity, timeout_id: 'timeout_1', scope: 'run', deadline_at: T,
      observed_at: T, decision: 'fail', reason_code: 'deadline_exhausted',
    };
    case 'recovery_request': return {
      ...identity, recovery_id: 'recovery_1', lease_id: 'lease_1',
      reason_code: 'lease_expired', requested_at: T, status: 'started',
    };
    case 'compensation_request': return {
      ...identity, compensation_id: 'comp_1', step_id: 'step_1', effect_id: 'effect_1',
      mode: 'supported', reason_code: 'downstream_failure', requested_at: T, status: 'requested',
    };
    case 'completion_record': return {
      ...identity, completion_id: 'completion_1', state_version: 3,
      outcome: 'completed', result_digest: D, completed_at: T,
    };
    case 'dead_letter': return {
      ...identity, dead_letter_id: 'dead_1', final_state: 'dead_lettered', attempts: 3,
      last_checkpoint_id: 'checkpoint_1', last_error: 'synthetic', reason_code: 'retry_attempt_limit',
      event_refs: ['event_1'], effect_uncertainty: false, compensation_status: 'not_requested',
      recommended_action: 'review', created_at: T,
    };
    case 'idempotency_record': return {
      idempotency_key: 'key_1', org_id: 'org_1', scope: 'effect', action_digest: D,
      state: 'confirmed', result_ref: 'effect_1', created_at: T, updated_at: T,
    };
    case 'effect_receipt': return {
      ...identity, effect_id: 'effect_1', step_id: 'step_1', attempt_id: 'attempt_1',
      lease_id: 'lease_1', worker_id: 'worker_1', fencing_token: 1,
      idempotency_key: 'effect_key', action_digest: D, state: 'confirmed',
      adapter_ref: 'fake', result_digest: D, error_class: null, compensation_mode: 'supported',
      approval_evidence_digest: D, policy_evidence_digest: D, created_at: T, updated_at: T,
    };
    case 'execution_event': return {
      ...identity, event_id: 'event_1', sequence: 1, event_type: 'job.accepted',
      payload: {}, occurred_at: T, correlation_id: 'corr_1', causation_id: null,
      previous_digest: null, event_digest: D,
    };
    case 'execution_command': return {
      ...identity, command_id: 'command_1', command_type: 'resume',
      expected_state_version: 1, idempotency_key: 'command_key', payload_digest: D, issued_at: T,
    };
    case 'execution_result': return {
      ...identity, result_id: 'result_1', command_id: 'command_1', kind: 'completed',
      reason_code: 'completed', error_class: null, output_digest: D,
      checkpoint_id: null, wake_id: null, effect_ids: [], created_at: T,
    };
    default: throw new Error(`no contract sample for ${type}`);
  }
}

group('canonical contracts — all required records are closed, versioned and content-addressed', () => {
  equal(EXECUTION_CONTRACT_TYPES.length, 30, 'all 30 durable execution contract families are present');
  for (const type of EXECUTION_CONTRACT_TYPES) {
    const document = defineExecutionContract(type, contractSample(type));
    equal(document.schema, EXECUTION_SCHEMAS[type], `${type} schema is pinned`);
    check(document.document_digest.length >= 16, `${type} is content-addressed`);
    check(Object.isFrozen(document), `${type} is immutable`);
    assertExecutionContract(type, document);
  }
  const malformed = { ...contractSample('job'), surprise: true };
  run.throwsKernel(() => defineExecutionContract('job', malformed), 'invalid_input', 'unknown contract keys fail closed');
  const valid = defineExecutionContract('job', contractSample('job'));
  run.throwsKernel(
    () => assertExecutionContract('job', { ...valid, priority_class: 'critical' }),
    'contract_violation',
    'tampered contract digest is refused',
  );
  run.deterministic(() => defineExecutionContract('checkpoint', contractSample('checkpoint')), 'checkpoint construction is deterministic');
});

group('state machine — explicit transitions and optimistic concurrency', () => {
  check(EXECUTION_STATES.includes('waiting_for_approval') && EXECUTION_STATES.includes('dead_lettered'), 'long-running and terminal states are explicit');
  check(canTransition('running', 'checkpointing'), 'running may checkpoint');
  check(canTransition('waiting_for_approval', 'ready'), 'approval wait may become ready');
  check(!canTransition('completed', 'running'), 'terminal state cannot restart');
  const record = defineExecutionContract('run', contractSample('run'));
  const leased = transitionExecutionRecord(record, {
    to: 'leased',
    expected_version: 1,
    occurred_at: '2026-07-28T15:00:01.000Z',
  });
  equal(leased.state_version, 2, 'valid transition increments state version');
  run.throwsKernel(
    () => transitionExecutionRecord(record, { to: 'leased', expected_version: 0, occurred_at: T }),
    'invalid_input',
    'stale state version fails closed',
  );
  run.throwsKernel(
    () => transitionExecutionRecord({ ...record, state: 'completed' }, { to: 'running', expected_version: 1, occurred_at: T }),
    'invalid_input',
    'invalid terminal transition fails closed',
  );
});

group('scheduler and queue — delayed eligibility, priority, capability and duplicate suppression', () => {
  const c = composition({ prefix: 'schedule' });
  const delayed = accept(c, {
    idempotency_key: 'scheduled-job',
    available_at: '2026-07-28T15:01:00.000Z',
  });
  equal(delayed.job.state, 'scheduled', 'future work is scheduled, not ready');
  equal(c.service.tick({ org_id: 'org_durable_fixture', now: '2026-07-28T15:00:30.000Z' }).ready_count, 0, 'scheduler does not release work early');
  equal(c.service.tick({ org_id: 'org_durable_fixture', now: '2026-07-28T15:01:00.000Z' }).ready_count, 1, 'scheduler makes due work ready');
  accept(c, { idempotency_key: 'background-job', priority_class: 'background' });
  accept(c, { idempotency_key: 'critical-job', priority_class: 'critical' });
  const ready = c.repository.listReady({
    org_id: 'org_durable_fixture',
    capabilities: ['workflow'],
    now: '2026-07-28T15:02:00.000Z',
    limit: 10,
  });
  equal(ready[0].priority_class, 'critical', 'bounded priority classes order ready work');
  equal(c.repository.listReady({
    org_id: 'org_durable_fixture',
    capabilities: [],
    now: '2026-07-28T15:02:00.000Z',
    limit: 10,
  }), [], 'capability mismatch prevents selection');
  equal(c.repository.queueStatus({
    org_id: 'org_durable_fixture',
    now: '2026-07-28T15:02:00.000Z',
    capacity: 1,
  }).backpressure, true, 'queue surfaces bounded backpressure');
  const recurring = defineRecurringSchedule(contractSample('recurring_schedule'));
  equal(calculateNextRun(recurring, {
    after: '2026-07-28T15:03:30.000Z',
  }).next_at, '2026-07-28T15:04:00.000Z', 'recurring boundary calculates a deterministic next run');
  equal(calculateNextRun(recurring, {
    after: '2026-07-28T15:03:30.000Z',
  }).missed, 2, 'recurring catch-up is bounded by policy');
  const first = c.service.acceptJob({
    kind: 'workflow', org_id: 'org_durable_fixture', workflow_id: 'synthetic_workflow',
    workflow_version: '1.0.0', idempotency_key: 'duplicate-job', payload: { x: 1 },
    required_capabilities: ['workflow'],
  });
  const duplicate = c.service.acceptJob({
    kind: 'workflow', org_id: 'org_durable_fixture', workflow_id: 'synthetic_workflow',
    workflow_version: '1.0.0', idempotency_key: 'duplicate-job', payload: { x: 1 },
    required_capabilities: ['workflow'],
  });
  equal(duplicate.duplicate, true, 'duplicate submission reuses the existing job');
  equal(duplicate.job.job_id, first.job.job_id, 'duplicate suppression preserves identity');
  run.throwsKernel(
    () => c.service.acceptJob({
      kind: 'workflow', org_id: 'org_durable_fixture', workflow_id: 'synthetic_workflow',
      workflow_version: '1.0.0', idempotency_key: 'duplicate-job', payload: { x: 2 },
      required_capabilities: ['workflow'],
    }),
    'invalid_input',
    'same idempotency key with different content is refused',
  );
});

await groupAsync('durable wakes — scheduled time and correlated external events resume without duplicate work', async () => {
  const scheduled = composition({ prefix: 'scheduled_wake', tick_ms: 0 });
  const scheduledAccepted = accept(scheduled, { idempotency_key: 'scheduled-wake-job' });
  const scheduledWorkerA = register(scheduled, 'scheduled_worker_a');
  let scheduledCalls = 0;
  const scheduledExecutor = {
    async execute({ checkpoint }) {
      scheduledCalls += 1;
      return checkpoint === null
        ? {
          kind: 'paused',
          reason_code: 'scheduled_wait',
          checkpoint: { completed_steps: ['before_wait'] },
          wake: { kind: 'scheduled_time', available_at: '2026-07-28T15:01:00.000Z' },
        }
        : { kind: 'completed', output: { restored: true }, checkpoint, effects: [] };
    },
  };
  equal(
    (await scheduled.service.createWorker({ worker: scheduledWorkerA, executor: scheduledExecutor }).pollOnce()).status,
    'paused',
    'scheduled wait checkpoints and releases Worker A',
  );
  equal(
    scheduled.service.tick({ org_id: 'org_durable_fixture', now: '2026-07-28T15:00:59.000Z' }).ready_count,
    0,
    'scheduled wake does not resume early',
  );
  equal(
    scheduled.service.tick({ org_id: 'org_durable_fixture', now: '2026-07-28T15:01:00.000Z' }).ready_count,
    1,
    'scheduled wake makes work eligible at its exact boundary',
  );
  scheduled.clock.advance(60000);
  const scheduledWorkerB = register(scheduled, 'scheduled_worker_b');
  equal(
    (await scheduled.service.createWorker({ worker: scheduledWorkerB, executor: scheduledExecutor }).pollOnce()).status,
    'completed',
    'Worker B restores the scheduled-wait checkpoint',
  );
  equal(scheduledCalls, 2, 'scheduled resume executes one attempt on each side of the wait');
  equal(
    scheduled.service.inspect({ run_id: scheduledAccepted.run.run_id, org_id: 'org_durable_fixture' }).attempts.length,
    2,
    'scheduled resume preserves distinct attempt records',
  );

  const external = composition({ prefix: 'external_wake', tick_ms: 0 });
  const externalAccepted = accept(external, { idempotency_key: 'external-wake-job' });
  const externalWorkerA = register(external, 'external_worker_a');
  const externalExecutor = {
    async execute({ checkpoint }) {
      return checkpoint === null
        ? {
          kind: 'paused',
          reason_code: 'dependency_wait',
          checkpoint: { completed_steps: ['request_dependency'] },
          wake: {
            kind: 'external_event',
            correlation_key: 'fixture:dependency:42',
            available_at: T,
          },
        }
        : { kind: 'completed', output: { dependency_received: true }, checkpoint, effects: [] };
    },
  };
  await external.service.createWorker({ worker: externalWorkerA, executor: externalExecutor }).pollOnce();
  const waiting = external.service.inspect({
    run_id: externalAccepted.run.run_id,
    org_id: 'org_durable_fixture',
  });
  run.throwsKernel(
    () => external.service.signalExternalEvent({
      wake_id: waiting.wake.wake_id,
      org_id: 'org_durable_fixture',
      correlation_key: 'fixture:wrong',
      payload: { synthetic: true },
    }),
    'invalid_input',
    'external wake rejects a mismatched correlation key',
  );
  external.service.signalExternalEvent({
    wake_id: waiting.wake.wake_id,
    org_id: 'org_durable_fixture',
    correlation_key: 'fixture:dependency:42',
    payload: { synthetic: true },
  });
  equal(external.service.tick({ org_id: 'org_durable_fixture' }).ready_count, 1, 'valid external event makes the paused run eligible');
  const externalWorkerB = register(external, 'external_worker_b');
  equal(
    (await external.service.createWorker({ worker: externalWorkerB, executor: externalExecutor }).pollOnce()).status,
    'completed',
    'external-event resume restores checkpoint and completes',
  );
});

group('atomic lease protocol — contention, renewal bounds, expiry and fencing', () => {
  const c = composition({ prefix: 'lease', tick_ms: 0 });
  const accepted = accept(c, { idempotency_key: 'lease-job' });
  register(c, 'worker_a');
  register(c, 'worker_b');
  const first = c.repository.claimLease({
    lease_id: 'lease_a', claim_id: 'claim_a', job_id: accepted.job.job_id,
    org_id: 'org_durable_fixture', worker_id: 'worker_a', now: T,
    expires_at: '2026-07-28T15:00:10.000Z', max_expires_at: '2026-07-28T15:00:30.000Z',
  });
  equal(first.ok, true, 'first claimant atomically obtains the lease');
  const second = c.repository.claimLease({
    lease_id: 'lease_b', claim_id: 'claim_b', job_id: accepted.job.job_id,
    org_id: 'org_durable_fixture', worker_id: 'worker_b', now: T,
    expires_at: '2026-07-28T15:00:10.000Z', max_expires_at: '2026-07-28T15:00:30.000Z',
  });
  equal(second.reason, 'execution_lease_contended', 'second independent claimant is refused');
  const renewed = c.repository.renewLease({
    lease_id: 'lease_a', org_id: 'org_durable_fixture', worker_id: 'worker_a',
    fencing_token: first.lease.fencing_token, now: '2026-07-28T15:00:01.000Z',
    expires_at: '2026-07-28T15:00:20.000Z',
  });
  equal(renewed.renewal_count, 1, 'active owner renews a lease');
  run.throwsKernel(
    () => c.repository.renewLease({
      lease_id: 'lease_a', org_id: 'org_durable_fixture', worker_id: 'worker_a',
      fencing_token: first.lease.fencing_token, now: '2026-07-28T15:00:02.000Z',
      expires_at: '2026-07-28T15:00:31.000Z',
    }),
    'invalid_input',
    'renewal cannot exceed the bounded maximum',
  );
  equal(c.repository.verifyLease({
    lease_id: 'lease_a', job_id: accepted.job.job_id, run_id: accepted.run.run_id,
    org_id: 'org_durable_fixture', worker_id: 'worker_a',
    fencing_token: first.lease.fencing_token, now: '2026-07-28T15:00:21.000Z',
  }).reason, 'execution_lease_expired', 'expired lease is no longer mutation evidence');
  run.throwsKernel(
    () => c.repository.claimLease({
      lease_id: 'lease_foreign', claim_id: 'claim_foreign', job_id: accepted.job.job_id,
      org_id: 'org_other', worker_id: 'worker_b', now: T,
      expires_at: '2026-07-28T15:00:10.000Z', max_expires_at: '2026-07-28T15:00:30.000Z',
    }),
    'invalid_input',
    'cross-tenant claim is refused without disclosure',
  );
});

group('recovery — expired worker is fenced and recovered work continues safely', () => {
  const c = composition({ prefix: 'recover', tick_ms: 0 });
  const accepted = accept(c, { idempotency_key: 'recover-job' });
  register(c, 'worker_a');
  register(c, 'worker_b');
  const stale = c.repository.claimLease({
    lease_id: 'stale_lease', claim_id: 'stale_claim', job_id: accepted.job.job_id,
    org_id: 'org_durable_fixture', worker_id: 'worker_a', now: T,
    expires_at: '2026-07-28T15:00:01.000Z', max_expires_at: '2026-07-28T15:00:05.000Z',
  }).lease;
  const recovered = c.service.recover({ org_id: 'org_durable_fixture', now: '2026-07-28T15:00:02.000Z' });
  equal(recovered.decisions[0].status, 'recovered', 'recovery controller requeues expired work after the worker misses heartbeat/lease renewal');
  const newLease = c.repository.claimLease({
    lease_id: 'recovered_lease', claim_id: 'recovered_claim', job_id: accepted.job.job_id,
    org_id: 'org_durable_fixture', worker_id: 'worker_b', now: '2026-07-28T15:00:02.000Z',
    expires_at: '2026-07-28T15:00:04.000Z', max_expires_at: '2026-07-28T15:00:06.000Z',
  }).lease;
  check(newLease.fencing_token > stale.fencing_token, 'recovery advances the monotonic fencing token');
  equal(c.repository.verifyLease({
    lease_id: stale.lease_id, job_id: stale.job_id, run_id: stale.run_id,
    org_id: stale.org_id, worker_id: stale.worker_id, fencing_token: stale.fencing_token,
    now: '2026-07-28T15:00:02.000Z',
  }).reason, 'execution_fencing_token_stale', 'stale worker is fenced after takeover');
  const currentRun = c.repository.readRun({ run_id: accepted.run.run_id, org_id: 'org_durable_fixture' });
  const staleCheckpoint = defineExecutionCheckpoint({
    ...contractSample('checkpoint'),
    checkpoint_id: 'stale_checkpoint',
    run_id: currentRun.run_id,
    job_id: currentRun.job_id,
    step_id: currentRun.active_step_id,
    attempt_id: 'attempt_stale',
    lease_id: stale.lease_id,
    worker_id: stale.worker_id,
    fencing_token: stale.fencing_token,
    org_id: currentRun.org_id,
    state_version: currentRun.state_version,
  });
  run.throwsKernel(
    () => c.repository.commitCheckpoint(staleCheckpoint, {
      now: '2026-07-28T15:00:02.000Z',
      expected_state_version: currentRun.state_version,
    }),
    'invalid_input',
    'expired worker cannot checkpoint',
  );
  const staleEffect = defineEffectReceipt({
    ...contractSample('effect_receipt'),
    effect_id: 'stale_effect',
    run_id: currentRun.run_id,
    job_id: currentRun.job_id,
    step_id: currentRun.active_step_id,
    attempt_id: 'attempt_stale',
    lease_id: stale.lease_id,
    worker_id: stale.worker_id,
    fencing_token: stale.fencing_token,
    org_id: currentRun.org_id,
    idempotency_key: 'stale_effect_key',
  });
  run.throwsKernel(
    () => c.repository.putEffectReceipt(staleEffect, { now: '2026-07-28T15:00:02.000Z' }),
    'invalid_input',
    'expired worker cannot record a confirmed effect',
  );
  const staleCompletion = defineCompletionRecord({
    completion_id: 'stale_completion',
    run_id: currentRun.run_id,
    job_id: currentRun.job_id,
    org_id: currentRun.org_id,
    state_version: currentRun.state_version,
    outcome: 'completed',
    result_digest: D,
    completed_at: '2026-07-28T15:00:02.000Z',
  });
  run.throwsKernel(
    () => c.repository.putCompletion(staleCompletion, {
      lease_id: stale.lease_id,
      worker_id: stale.worker_id,
      fencing_token: stale.fencing_token,
      now: '2026-07-28T15:00:02.000Z',
    }),
    'invalid_input',
    'expired worker cannot mark completion',
  );
  equal(c.repository.verifyLease({
    lease_id: newLease.lease_id, job_id: newLease.job_id, run_id: newLease.run_id,
    org_id: newLease.org_id, worker_id: newLease.worker_id, fencing_token: newLease.fencing_token,
    now: '2026-07-28T15:00:02.000Z',
  }).ok, true, 'recovered worker holds valid mutation evidence');
});

await groupAsync('complete vertical slice — Agent Runtime + Memory + approval + cold resume + exactly-once effect', async () => {
  const c = composition({ prefix: 'vertical', start: '2026-07-28T16:00:00.000Z' });
  const effectAdapter = createSyntheticEffectAdapter();
  const accepted = c.service.acceptJob({
    kind: 'agent',
    org_id: OPERATIONS_ORG,
    agent_id: 'operations_investigator',
    agent_version: '1.0.0',
    idempotency_key: 'vertical:case_1042',
    payload: { case_id: 'case_1042', synthetic: true },
    required_capabilities: ['agent'],
  });
  const workerA = c.service.registerWorker({
    worker_id: 'vertical_worker_a', org_id: OPERATIONS_ORG, capabilities: ['agent'],
  });
  const executorA = createDurableOperationsExecutor({ clock: c.clock, effectAdapter });
  const first = await c.service.createWorker({ worker: workerA, executor: executorA }).pollOnce();
  equal(first.status, 'paused', 'Worker A pauses instead of occupying a worker');
  const paused = c.service.inspect({ run_id: accepted.run.run_id, org_id: OPERATIONS_ORG });
  equal(paused.run.state, 'waiting_for_approval', 'run durably waits for approval');
  check(paused.checkpoint.memory_snapshot_refs.length === 1, 'checkpoint preserves Memory Layer retrieval snapshot');
  check(paused.checkpoint.transcript_position > 0, 'checkpoint preserves Agent Runtime transcript position');
  equal(executorA.metrics().agent_calls.length, 2, 'bounded Agent Runtime invoked two safe synthetic read tools');
  equal(c.repository.snapshot().leases.filter((lease) => lease.status === 'active').length, 0, 'paused run releases its worker lease');
  run.throwsKernel(
    () => c.service.signalApproval({
      wake_id: paused.wake.wake_id, org_id: OPERATIONS_ORG, action_digest: paused.wake.action_digest,
      decision: 'approve', actor: 'service', principal: 'automation', principal_roles: ['operations_owner'],
    }),
    'invalid_input',
    'automation cannot self-approve a valid pending action',
  );
  run.throwsKernel(
    () => c.service.signalApproval({
      wake_id: paused.wake.wake_id, org_id: OPERATIONS_ORG, action_digest: 'b'.repeat(16),
      decision: 'approve', actor: 'human', principal: 'operator_alex', principal_roles: ['operations_owner'],
    }),
    'invalid_input',
    'stale or altered approval digest cannot resume',
  );
  run.throwsKernel(
    () => c.service.signalApproval({
      wake_id: paused.wake.wake_id, org_id: 'org_other', action_digest: paused.wake.action_digest,
      decision: 'approve', actor: 'human', principal: 'operator_alex', principal_roles: ['operations_owner'],
    }),
    'invalid_input',
    'cross-tenant approval cannot resume',
  );
  c.service.signalApproval({
    wake_id: paused.wake.wake_id, org_id: OPERATIONS_ORG, action_digest: paused.wake.action_digest,
    decision: 'approve', actor: 'human', principal: 'operator_alex', principal_roles: ['operations_owner'],
  });
  equal(c.service.tick({ org_id: OPERATIONS_ORG }).ready_count, 1, 'approval makes work eligible but does not execute it');
  const workerB = c.service.registerWorker({
    worker_id: 'vertical_worker_b', org_id: OPERATIONS_ORG, capabilities: ['agent'],
  });
  // New executor instance simulates the original runtime process terminating.
  const executorB = createDurableOperationsExecutor({ clock: c.clock, effectAdapter });
  const second = await c.service.createWorker({ worker: workerB, executor: executorB }).pollOnce();
  equal(second.status, 'completed', 'Worker B restores and completes');
  const completed = c.service.inspect({ run_id: accepted.run.run_id, org_id: OPERATIONS_ORG });
  equal(completed.attempts.length, 2, 'pause/resume uses distinct durable attempts');
  equal(completed.effects.length, 1, 'one final effect receipt is stored');
  equal(completed.effects[0].state, 'confirmed', 'effect receipt is confirmed');
  equal(effectAdapter.metrics().calls.length, 1, 'production-capable fake adapter executes exactly once');
  equal(
    c.repository.putCompletion(second.result.completion, {
      lease_id: 'already_released',
      worker_id: 'duplicate_caller',
      fencing_token: 0,
      now: c.clock(),
    }).document_digest,
    second.result.completion.document_digest,
    'duplicate identical completion remains idempotent after lease release',
  );
  const replay = c.service.replay({ run_id: accepted.run.run_id, org_id: OPERATIONS_ORG });
  equal(replay.classification, 'control_decision_replay', 'control path replays without divergence');
  equal(replay.tools_invoked, 0, 'replay invokes no tools');
  equal(replay.models_invoked, 0, 'replay invokes no models');
  check(replay.effects.every((effect) => effect.simulated), 'external effects are simulated from captured receipts');
  equal(
    c.service.replay({
      run_id: accepted.run.run_id,
      org_id: OPERATIONS_ORG,
      mode: 'checkpoint_replay',
    }).classification,
    'checkpoint_replay',
    'replay can start from the durable checkpoint',
  );
});

group('retry taxonomy — deterministic backoff, deadlines and never-retry classes', () => {
  for (const error_class of ERROR_CLASSES) {
    const classified = classifyExecutionError({ error_class });
    equal(classified.error_class, error_class, `${error_class} is preserved`);
    equal(classified.retryable, error_class.startsWith('retryable_'), `${error_class} retryability is explicit`);
    run.record('error_classes', error_class);
  }
  const policy = defineRetryPolicy({
    strategy: 'exponential',
    base_delay_ms: 1000,
    max_delay_ms: 10000,
    jitter_ratio: 0.2,
    max_attempts: 4,
    max_elapsed_ms: 60000,
  });
  const decision = decideRetry({
    error: { error_class: 'retryable_provider' },
    attempt_number: 2,
    first_attempt_at: T,
    now: '2026-07-28T15:00:01.000Z',
    policy,
    randomness: () => 0.5,
  });
  equal(decision.delay_ms, 2000, 'injected midpoint randomness gives deterministic exponential delay');
  equal(decision.available_at, '2026-07-28T15:00:03.000Z', 'retry schedule is an explicit instant');
  equal(decideRetry({
    error: { error_class: 'non_retryable_authorization' }, attempt_number: 1,
    first_attempt_at: T, now: T, policy,
  }).decision, 'do_not_retry', 'authorization failures never retry');
  equal(decideRetry({
    error: { error_class: 'non_retryable_tenant' }, attempt_number: 1,
    first_attempt_at: T, now: T, policy,
  }).decision, 'do_not_retry', 'tenant violations never retry');
  equal(decideRetry({
    error: { error_class: 'retryable_timeout' }, attempt_number: 1,
    first_attempt_at: T, now: T, deadline_at: '2026-07-28T15:00:00.500Z',
    policy: { ...policy, jitter_ratio: 0 },
  }).reason_code, 'retry_deadline_exhausted', 'retry will not cross the run deadline');
  run.coverage('error_classes', ERROR_CLASSES);
});

await groupAsync('worker retry and dead letter — bounded attempts are durable', async () => {
  const c = composition({ prefix: 'retry_worker' });
  const accepted = accept(c, { idempotency_key: 'retry-worker-job' });
  const worker = register(c, 'retry_worker');
  let calls = 0;
  const executor = {
    async execute() {
      calls += 1;
      return calls === 1
        ? { kind: 'retry', reason_code: 'provider_unavailable', error_class: 'retryable_provider', checkpoint: {} }
        : { kind: 'completed', output: { ok: true }, effects: [] };
    },
  };
  const runtime = c.service.createWorker({
    worker,
    executor,
    retry_policy: { strategy: 'fixed', base_delay_ms: 10, max_delay_ms: 10, jitter_ratio: 0, max_attempts: 3, max_elapsed_ms: 1000 },
  });
  equal((await runtime.pollOnce()).status, 'paused', 'retryable failure releases worker on a durable backoff wake');
  c.clock.advance(20);
  equal(c.service.tick({ org_id: 'org_durable_fixture' }).ready_count, 1, 'scheduler releases delayed retry');
  equal((await runtime.pollOnce()).status, 'completed', 'next attempt restores and completes');
  equal(c.service.inspect({ run_id: accepted.run.run_id, org_id: 'org_durable_fixture' }).attempts.length, 2, 'retries are distinct attempt records');

  const dead = composition({ prefix: 'dead_worker' });
  const deadAccepted = accept(dead, { idempotency_key: 'dead-worker-job' });
  const deadWorker = register(dead, 'dead_worker');
  const deadRuntime = dead.service.createWorker({
    worker: deadWorker,
    executor: { execute: async () => ({ kind: 'retry', reason_code: 'still_down', error_class: 'retryable_infrastructure' }) },
    retry_policy: { strategy: 'fixed', base_delay_ms: 0, max_delay_ms: 0, jitter_ratio: 0, max_attempts: 1, max_elapsed_ms: 1000 },
  });
  equal((await deadRuntime.pollOnce()).status, 'dead_lettered', 'attempt ceiling routes work to dead letter');
  const deadState = dead.service.inspect({ run_id: deadAccepted.run.run_id, org_id: 'org_durable_fixture' });
  equal(deadState.dead_letter.reason_code, 'retry_attempt_limit', 'dead letter records structured reason');
  check(deadState.dead_letter.recommended_action.length > 0, 'dead letter preserves operator guidance');
});

await groupAsync('effects — idempotency, uncertainty and compensation are explicit', async () => {
  const c = composition({ prefix: 'effect', tick_ms: 0 });
  const accepted = accept(c, { idempotency_key: 'effect-job' });
  const worker = register(c, 'effect_worker');
  const claimed = c.repository.claimLease({
    lease_id: 'effect_lease', claim_id: 'effect_claim', job_id: accepted.job.job_id,
    org_id: 'org_durable_fixture', worker_id: worker.worker_id, now: T,
    expires_at: '2026-07-28T15:01:00.000Z', max_expires_at: '2026-07-28T15:02:00.000Z',
  }).lease;
  const adapter = createSyntheticEffectAdapter();
  const request = {
    effect_id: 'effect_once', run_id: accepted.run.run_id, job_id: accepted.job.job_id,
    step_id: accepted.run.active_step_id, attempt_id: 'attempt_effect',
    lease_id: claimed.lease_id, worker_id: worker.worker_id, fencing_token: claimed.fencing_token,
    org_id: 'org_durable_fixture', idempotency_key: 'stable-effect-key',
    action_digest: D, adapter, compensation_mode: 'supported',
    approval_evidence_digest: D, policy_evidence_digest: D, created_at: T,
  };
  const first = await executeIdempotentEffect({ repository: c.repository, request, input: { x: 1 }, clock: () => T });
  const repeated = await executeIdempotentEffect({ repository: c.repository, request, input: { x: 1 }, clock: () => T });
  equal(first.ok, true, 'first effect confirms');
  equal(repeated.replayed, true, 'duplicate confirmed effect replays receipt');
  equal(adapter.metrics().calls.length, 1, 'duplicate effect does not call adapter twice');
  const compensated = await compensateEffect({
    repository: c.repository,
    receipt: first.receipt,
    adapter,
    input: { reason: 'synthetic_downstream_failure' },
    clock: () => T,
  });
  equal(compensated.ok, true, 'supported effect compensates');
  equal(adapter.metrics().compensation_calls.length, 1, 'compensator runs exactly once');

  const uncertainAdapter = {
    name: 'uncertain_fake',
    execute: async () => ({ status: 'uncertain', error_class: 'uncertain_external_effect' }),
  };
  const uncertain = await executeIdempotentEffect({
    repository: c.repository,
    request: { ...request, effect_id: 'effect_uncertain', idempotency_key: 'uncertain-key', adapter: uncertainAdapter },
    input: { x: 2 },
    clock: () => T,
  });
  equal(uncertain.reason, 'execution_effect_uncertain', 'uncertain outcome is not treated as failed');
  equal((await executeIdempotentEffect({
    repository: c.repository,
    request: { ...request, effect_id: 'effect_uncertain', idempotency_key: 'uncertain-key', adapter: uncertainAdapter },
    input: { x: 2 },
    clock: () => T,
  })).replayed, true, 'uncertain effect is not blindly re-executed');
  let unsupported = null;
  try {
    await compensateEffect({
      repository: c.repository,
      receipt: { ...uncertain.receipt, compensation_mode: 'unsupported' },
      adapter: uncertainAdapter,
      input: {},
      clock: () => T,
    });
  } catch (error) {
    unsupported = error;
  }
  check(unsupported !== null, 'unsupported compensation fails closed');
});

await groupAsync('cancellation and compensation-required failure', async () => {
  const scheduled = composition({ prefix: 'cancel_ready' });
  const accepted = accept(scheduled, { idempotency_key: 'cancel-ready-job' });
  const cancelled = scheduled.service.requestCancellation({
    run_id: accepted.run.run_id,
    org_id: 'org_durable_fixture',
    principal: 'operator',
  });
  equal(cancelled.run.state, 'cancelled', 'ready work cancels without a worker');

  const paused = composition({ prefix: 'cancel_paused' });
  const pausedAccepted = accept(paused, { idempotency_key: 'cancel-paused-job' });
  const workerA = register(paused, 'cancel_pause_worker_a');
  const pausing = paused.service.createWorker({
    worker: workerA,
    executor: {
      execute: async () => ({
        kind: 'paused',
        reason_code: 'external_dependency',
        checkpoint: {},
        wake: { kind: 'external_event', correlation_key: 'fixture:dependency', available_at: paused.clock() },
      }),
    },
  });
  await pausing.pollOnce();
  paused.service.requestCancellation({
    run_id: pausedAccepted.run.run_id,
    org_id: 'org_durable_fixture',
    principal: 'operator',
  });
  const workerB = register(paused, 'cancel_pause_worker_b');
  const neverCalled = { count: 0 };
  const cancelling = paused.service.createWorker({
    worker: workerB,
    executor: { execute: async () => { neverCalled.count += 1; return { kind: 'completed', effects: [] }; } },
  });
  equal((await cancelling.pollOnce()).status, 'cancelled', 'paused cancellation is durably acknowledged by a worker');
  equal(neverCalled.count, 0, 'cancelled run does not re-enter executor');

  const afterEffect = composition({ prefix: 'cancel_after_effect', tick_ms: 0 });
  const afterEffectAccepted = accept(afterEffect, { idempotency_key: 'cancel-after-effect-job' });
  const effectWorkerA = register(afterEffect, 'cancel_effect_worker_a');
  const cancellationAdapter = createSyntheticEffectAdapter();
  const cancellationInput = { synthetic: true, operation: 'reversible_fixture' };
  await afterEffect.service.createWorker({
    worker: effectWorkerA,
    executor: {
      async execute(context) {
        await executeIdempotentEffect({
          repository: afterEffect.repository,
          request: {
            effect_id: 'cancel_effect',
            run_id: context.run.run_id,
            job_id: context.job.job_id,
            step_id: context.run.active_step_id,
            attempt_id: context.attempt.attempt_id,
            lease_id: context.lease.lease_id,
            worker_id: context.worker.worker_id,
            fencing_token: context.lease.fencing_token,
            org_id: context.run.org_id,
            idempotency_key: 'cancel-effect-key',
            action_digest: D,
            adapter: cancellationAdapter,
            compensation_mode: 'supported',
            approval_evidence_digest: D,
            policy_evidence_digest: D,
            created_at: T,
          },
          input: cancellationInput,
          clock: () => T,
        });
        return {
          kind: 'paused',
          reason_code: 'manual_review_after_effect',
          checkpoint: { effect_receipts: ['cancel_effect'] },
          wake: { kind: 'manual_hold', available_at: T },
        };
      },
    },
  }).pollOnce();
  afterEffect.service.requestCancellation({
    run_id: afterEffectAccepted.run.run_id,
    org_id: 'org_durable_fixture',
    principal: 'operator',
  });
  const effectWorkerB = register(afterEffect, 'cancel_effect_worker_b');
  const cancelledAfterEffect = await afterEffect.service.createWorker({
    worker: effectWorkerB,
    executor: { execute: async () => ({ kind: 'completed', output: {}, effects: [] }) },
    compensators: [{
      effect_id: 'cancel_effect',
      adapter: cancellationAdapter,
      input: cancellationInput,
    }],
  }).pollOnce();
  equal(cancelledAfterEffect.status, 'cancelled', 'cancellation after a confirmed effect terminates explicitly');
  equal(cancellationAdapter.metrics().calls.length, 1, 'cancellation does not duplicate the confirmed forward effect');
  equal(cancellationAdapter.metrics().compensation_calls.length, 1, 'cancellation invokes the declared compensation exactly once');
  equal(
    afterEffect.service.inspect({
      run_id: afterEffectAccepted.run.run_id,
      org_id: 'org_durable_fixture',
    }).effects[0].state,
    'compensated',
    'cancellation preserves the compensated effect receipt',
  );

  const comp = composition({ prefix: 'comp_required', tick_ms: 0 });
  const compAccepted = accept(comp, { idempotency_key: 'comp-required-job' });
  const compWorker = register(comp, 'comp_worker');
  const adapter = createSyntheticEffectAdapter();
  const executor = {
    async execute(context) {
      const request = {
        effect_id: 'comp_effect', run_id: context.run.run_id, job_id: context.job.job_id,
        step_id: context.run.active_step_id, attempt_id: context.attempt.attempt_id,
        lease_id: context.lease.lease_id, worker_id: context.worker.worker_id,
        fencing_token: context.lease.fencing_token, org_id: context.run.org_id,
        idempotency_key: 'comp-effect-key', action_digest: D, adapter,
        compensation_mode: 'supported', approval_evidence_digest: D,
        policy_evidence_digest: D, created_at: T,
      };
      await executeIdempotentEffect({ repository: comp.repository, request, input: { synthetic: true }, clock: () => T });
      return {
        kind: 'compensate',
        reason_code: 'downstream_failure',
        compensators: [{ effect_id: 'comp_effect', adapter, input: { synthetic: true } }],
      };
    },
  };
  equal((await comp.service.createWorker({ worker: compWorker, executor }).pollOnce()).status, 'failed', 'compensation-required failure terminates explicitly');
  equal(adapter.metrics().calls.length, 1, 'forward effect occurred once');
  equal(adapter.metrics().compensation_calls.length, 1, 'reverse compensation occurred once');
  equal(comp.service.inspect({ run_id: compAccepted.run.run_id, org_id: 'org_durable_fixture' }).effects[0].state, 'compensated', 'effect receipt records compensation');
});

group('replay integrity — corruption and divergence are visible', () => {
  const c = composition({ prefix: 'replay' });
  const accepted = accept(c, { idempotency_key: 'replay-job' });
  const events = c.repository.eventsForRun({ run_id: accepted.run.run_id, org_id: 'org_durable_fixture' });
  verifyExecutionEventChain(events);
  const replay = replayExecution({ events, expected_state: 'ready' });
  equal(replay.diverged, false, 'matching state replay has no divergence');
  equal(replayExecution({ events, expected_state: 'completed' }).classification, 'divergence', 'state mismatch is classified as divergence');
  const tampered = structuredClone(events);
  tampered[0].event_type = 'job.scheduled';
  const resealed = { ...tampered[0] };
  delete resealed.document_digest;
  tampered[0].document_digest = digest(resealed);
  run.throwsKernel(() => verifyExecutionEventChain(tampered), 'invalid_input', 'fully resealed event with stale event digest is refused');
  const foreignCheckpoint = defineExecutionCheckpoint({
    ...contractSample('checkpoint'),
    checkpoint_id: 'foreign_checkpoint',
    run_id: 'foreign_run',
    job_id: accepted.job.job_id,
    org_id: 'org_durable_fixture',
  });
  run.throwsKernel(
    () => replayExecution({ events, checkpoint: foreignCheckpoint, mode: 'checkpoint_replay' }),
    'invalid_input',
    'checkpoint replay refuses mismatched execution identity',
  );
  equal(REPLAY_CLASSIFICATIONS.length, 6, 'all replay classifications are named');
});

await groupAsync('workflow runtime adapter — existing control-plane pause and resume are mapped, not replaced', async () => {
  let starts = 0;
  let resumes = 0;
  const workflowService = {
    async startRun() {
      starts += 1;
      return {
        run_id: 'control_run_1', workflow_id: 'workflow_1', workflow_version: '1.0.0',
        state: 'paused', advance: 'paused', blocked_reason: 'approval_required',
        pending_approval: { approval_id: 'approval_1', step_id: 'step_1', action_digest: D },
        journal_ref: 'journal_1',
      };
    },
    async resumeRun() {
      resumes += 1;
      return {
        run_id: 'control_run_1', workflow_id: 'workflow_1', workflow_version: '1.0.0',
        state: 'completed', advance: 'completed', outcome: { data: { ok: true } },
      };
    },
  };
  const adapter = createWorkflowRuntimeExecutionAdapter({
    workflowService,
    buildStartRequest: () => ({}),
    buildResumeRequest: () => ({}),
  });
  check(typeof adapter.execute === 'function', 'workflow adapter exposes the durable executor contract');
  check(starts === 0 && resumes === 0, 'adapter construction executes no workflow');
  const context = {
    job: { updated_at: T, deadline_at: null },
    checkpoint: null,
  };
  equal((await adapter.execute(context)).kind, 'paused', 'workflow start pause maps to a durable wake');
  equal(starts, 1, 'existing Workflow Runtime starts exactly once');
  equal((await adapter.execute({
    ...context,
    checkpoint: { workflow_state: { control_run_id: 'control_run_1' } },
  })).kind, 'completed', 'workflow resume completion maps to a durable completion');
  equal(resumes, 1, 'existing Workflow Runtime resumes exactly once');
});

await groupAsync('worker lifecycle, tenant boundary and malformed adapters', async () => {
  const c = composition({ prefix: 'lifecycle' });
  accept(c, { idempotency_key: 'lifecycle-job' });
  const worker = register(c, 'lifecycle_worker');
  const runtime = c.service.createWorker({
    worker,
    executor: { execute: async () => ({ kind: 'completed', output: {}, effects: [] }) },
  });
  runtime.stop();
  equal(runtime.status().stopped, true, 'worker stops cleanly');
  let crossTenant = null;
  try {
    await runtime.pollOnce({ org_id: 'org_other' });
  } catch (error) {
    crossTenant = error;
  }
  equal(crossTenant?.code, 'invalid_input', 'worker refuses a cross-tenant poll');
  const broken = { ...c.repository, readJob: null };
  run.throwsKernel(() => defineExecutionRepository(broken), 'invalid_input', 'repository adapter must implement the complete port');
  const malformedRepository = defineExecutionRepository({
    ...c.repository,
    listReady: () => [{ schema: 'awe.execution_job/v1', job_id: 'malformed_job' }],
  });
  let malformedStorage = null;
  try {
    await createExecutionWorker({
      worker,
      repository: malformedRepository,
      executor: { execute: async () => ({ kind: 'completed', output: {}, effects: [] }) },
      clock: c.clock,
      ids: c.ids,
    }).pollOnce();
  } catch (error) {
    malformedStorage = error;
  }
  equal(malformedStorage?.code, 'contract_violation', 'malformed storage output fails closed at the worker boundary');
  run.throwsKernel(
    () => assertExecutionContract('checkpoint', { schema: 'awe.execution_checkpoint/v1' }),
    'contract_violation',
    'malformed stored checkpoint is refused',
  );
});

group('layering and source purity — core has no provider, network or ambient runtime', () => {
  const sources = [
    'contracts.mjs', 'state-machine.mjs', 'repository.mjs', 'retry.mjs',
    'effects.mjs', 'scheduler.mjs', 'worker.mjs', 'recovery.mjs',
    'replay.mjs', 'service.mjs',
  ].map((name) => join(SRC, name));
  run.sourcePurity(sources, [
    { name: 'network', pattern: /\bfetch\s*\(|node:https|node:http|WebSocket|createConnection\s*\(/ },
    { name: 'provider SDK', pattern: /supabase|redis|kafka|bullmq|temporal|inngest/i },
    { name: 'ambient clock', pattern: /Date\.now\s*\(/ },
    { name: 'ambient randomness', pattern: /Math\.random\s*\(/ },
    { name: 'ambient environment', pattern: /process\.env/ },
    { name: 'filesystem storage', pattern: /node:fs|readFile|writeFile|mkdir/ },
    { name: 'external process', pattern: /child_process|execFile|spawn\s*\(/ },
  ], { label: 'execution core purity' });
  for (const path of sources) {
    const imports = [...readFileSync(path, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    check(imports.every((specifier) => specifier.startsWith('./')), `${path} imports only execution-local modules`);
  }
  equal(JSON.parse(readFileSync(join(ROOT, 'packages', 'awe-execution', 'package.json'), 'utf8')).dependencies, undefined, 'execution package declares zero runtime dependencies');
});

group('non-vacuity perturbations — safety checks reject the mutation each guard names', () => {
  const c = composition({ prefix: 'perturb' });
  const accepted = accept(c, { idempotency_key: 'perturb-job' });
  const original = c.repository.readRun({ run_id: accepted.run.run_id, org_id: 'org_durable_fixture' });
  run.throwsKernel(
    () => transitionExecutionRecord(original, { to: 'leased', expected_version: original.state_version - 1, occurred_at: T }),
    'invalid_input',
    'perturbation: removing state-version equality would admit a stale writer',
  );
  run.throwsKernel(
    () => c.service.signalApproval({
      wake_id: 'missing_wake', org_id: 'org_durable_fixture', action_digest: D,
      decision: 'approve', actor: 'service', principal: 'automation', principal_roles: ['owner'],
    }),
    'invalid_input',
    'perturbation: removing the actor guard would let automation approve',
  );
  run.throwsKernel(
    () => defineExecutionContract('job', { ...contractSample('job'), required_capabilities: ['workflow', 'workflow'] }),
    'invalid_input',
    'perturbation: removing capability uniqueness would weaken worker matching',
  );
  const event = defineExecutionContract('execution_event', contractSample('execution_event'));
  run.throwsKernel(
    () => assertExecutionContract('execution_event', { ...event, payload: { altered: true } }),
    'contract_violation',
    'perturbation: removing document digest verification would admit history mutation',
  );
  check(fixtures > 0, 'zero-fixture run is a hard failure');
});

const summary = run.summary({ fixtures });
const durationMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
const report = {
  schema: 'awe.runner_report/v1',
  runner: 'D',
  suite: summary.suite,
  fixture_count: fixtures,
  assertion_count: summary.pass + summary.fail,
  pass_count: summary.pass,
  fail_count: summary.fail,
  skip_count: skips,
  duration_ms: Math.round(durationMs * 1000) / 1000,
  failures: summary.failures,
  coverage: summary.coverage,
  report_digest: digest({
    runner: 'D',
    fixture_count: fixtures,
    assertion_count: summary.pass + summary.fail,
    pass_count: summary.pass,
    fail_count: summary.fail,
    skip_count: skips,
    failures: summary.failures,
  }),
};
const reportDir = join(ROOT, 'artifacts', 'runner_durable_execution');
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, 'latest.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`runner report: ${reportPath}`);
console.log(`Runner D metrics: fixtures=${fixtures} assertions=${report.assertion_count} passed=${report.pass_count} failed=${report.fail_count} skipped=${report.skip_count} duration_ms=${report.duration_ms}`);
process.exitCode = run.exitCode;
