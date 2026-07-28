import {
  canonicalClone, deepFreeze, digest, invariant, isInstant, isPlainObject,
} from './kernel.mjs';
import {
  assertExecutionContract,
  defineCancellationRequest,
  defineCompletionRecord,
  defineDeadLetterRecord,
  defineEffectReceipt,
  defineExecutionAttempt,
  defineExecutionCheckpoint,
  defineExecutionEvent,
  defineExecutionJob,
  defineExecutionLease,
  defineLeaseClaim,
  defineExecutionRun,
  defineExecutionStep,
  defineIdempotencyRecord,
  defineWakeCondition,
  defineWorker,
  defineWorkerHeartbeat,
  sanitizeExecutionData,
} from './contracts.mjs';
import {
  assertCompatibleRunJob, TERMINAL_EXECUTION_STATES, transitionExecutionRecord,
} from './state-machine.mjs';

const PRIORITY_RANK = Object.freeze({ background: 0, normal: 1, urgent: 2, critical: 3 });
const ACTIVE_LEASE_STATUSES = ['active'];

function clone(value) {
  return value === null || value === undefined ? value : deepFreeze(canonicalClone(value));
}

function owned(document, org_id, label) {
  if (document === null || document === undefined) return null;
  invariant(typeof org_id === 'string' && org_id.length > 0, 'execution_tenant_required', `${label} needs org_id`, {});
  invariant(document.org_id === org_id, 'execution_tenant_violation', `${label} is not accessible to tenant '${org_id}'`, {});
  return document;
}

function laterThan(left, right) {
  invariant(isInstant(left) && isInstant(right), 'invalid_input', 'instant comparison needs ISO instants', {});
  return Date.parse(left) > Date.parse(right);
}

function atOrBefore(left, right) {
  invariant(isInstant(left) && isInstant(right), 'invalid_input', 'instant comparison needs ISO instants', {});
  return Date.parse(left) <= Date.parse(right);
}

function rebuild(type, document) {
  const input = canonicalClone(document);
  delete input.schema;
  delete input.document_digest;
  switch (type) {
    case 'job': return defineExecutionJob(input);
    case 'run': return defineExecutionRun(input);
    case 'step': return defineExecutionStep(input);
    case 'attempt': return defineExecutionAttempt(input);
    case 'lease': return defineExecutionLease(input);
    case 'checkpoint': return defineExecutionCheckpoint(input);
    case 'wake_condition': return defineWakeCondition(input);
    case 'effect_receipt': return defineEffectReceipt(input);
    case 'idempotency_record': return defineIdempotencyRecord(input);
    case 'cancellation_request': return defineCancellationRequest(input);
    default: invariant(false, 'invalid_input', `cannot rebuild contract '${type}'`, {});
  }
}

function compareReady(a, b) {
  return PRIORITY_RANK[b.priority_class] - PRIORITY_RANK[a.priority_class]
    || a.available_at.localeCompare(b.available_at)
    || a.created_at.localeCompare(b.created_at)
    || a.job_id.localeCompare(b.job_id);
}

export const EXECUTION_REPOSITORY_METHODS = [
  'accept', 'readJob', 'readRun', 'readStep', 'listSteps', 'transitionJob',
  'transitionRun', 'registerWorker', 'readWorker', 'heartbeatWorker',
  'listReady', 'claimLease', 'readLease', 'verifyLease', 'renewLease',
  'releaseLease', 'expireLease', 'listExpiredLeases', 'createAttempt',
  'finishAttempt', 'listAttempts', 'commitCheckpoint', 'latestCheckpoint',
  'putWakeCondition', 'readWakeCondition', 'listWakeConditions',
  'satisfyWakeCondition', 'cancelWakeCondition', 'putCancellation',
  'readCancellation', 'putIdempotency', 'readIdempotency', 'putEffectReceipt',
  'readEffectByKey', 'listEffects', 'putCompletion', 'putDeadLetter',
  'readDeadLetter', 'appendEvent', 'eventsForRun', 'listJobs', 'listRuns', 'queueStatus',
  'snapshot',
];

export function defineExecutionRepository(impl) {
  invariant(isPlainObject(impl), 'invalid_input', 'execution repository must be an object', {});
  for (const method of EXECUTION_REPOSITORY_METHODS) {
    invariant(typeof impl[method] === 'function', 'invalid_input', `execution repository needs ${method}()`, {});
  }
  return Object.freeze({ kind: impl.kind ?? 'execution_repository', ...impl });
}

export function createInMemoryExecutionRepository() {
  const jobs = new Map();
  const runs = new Map();
  const steps = new Map();
  const workers = new Map();
  const heartbeats = new Map();
  const leases = new Map();
  const activeLeaseByJob = new Map();
  const fenceByJob = new Map();
  const attempts = new Map();
  const checkpoints = new Map();
  const checkpointIds = new Set();
  const wakes = new Map();
  const cancellations = new Map();
  const idempotency = new Map();
  const effects = new Map();
  const effectByKey = new Map();
  const completions = new Map();
  const deadLetters = new Map();
  const eventLogs = new Map();

  function requireJob(job_id, org_id) {
    const job = jobs.get(job_id) ?? null;
    invariant(job !== null, 'execution_job_unknown', `job '${job_id}' is not registered`, {});
    return owned(job, org_id, 'job');
  }

  function requireRun(run_id, org_id) {
    const run = runs.get(run_id) ?? null;
    invariant(run !== null, 'execution_run_unknown', `run '${run_id}' is not registered`, {});
    return owned(run, org_id, 'run');
  }

  function storeTransition(type, map, key, current, request) {
    const next = transitionExecutionRecord(current, request);
    const document = rebuild(type, next);
    map.set(key, document);
    return clone(document);
  }

  function appendEvent({
    event_id,
    run_id,
    job_id,
    org_id,
    event_type,
    payload = {},
    occurred_at,
    correlation_id = null,
    causation_id = null,
  }) {
    requireRun(run_id, org_id);
    requireJob(job_id, org_id);
    invariant(typeof event_type === 'string' && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(event_type), 'invalid_input', `invalid execution event type '${event_type}'`, {});
    const log = eventLogs.get(run_id) ?? [];
    const previous_digest = log.length === 0 ? null : log[log.length - 1].event_digest;
    const sequence = log.length + 1;
    const core = {
      event_id,
      sequence,
      run_id,
      job_id,
      org_id,
      event_type,
      payload: sanitizeExecutionData(payload),
      occurred_at,
      correlation_id,
      causation_id,
      previous_digest,
    };
    const event = defineExecutionEvent({ ...core, event_digest: digest(core) });
    log.push(event);
    eventLogs.set(run_id, log);
    return clone(event);
  }

  const repository = {
    kind: 'memory_execution_repository',

    accept({ job, run, steps: initialSteps = [] } = {}) {
      assertExecutionContract('job', job, { at: 'repository.accept' });
      assertExecutionContract('run', run, { at: 'repository.accept' });
      assertCompatibleRunJob(run, job);
      invariant(!jobs.has(job.job_id) && !runs.has(run.run_id), 'execution_duplicate_submission', 'job or run already exists', {});
      const seen = new Set();
      for (const step of initialSteps) {
        assertExecutionContract('step', step, { at: 'repository.accept' });
        invariant(step.run_id === run.run_id && step.job_id === job.job_id && step.org_id === run.org_id, 'execution_tenant_violation', 'step identity does not match run', {});
        invariant(!seen.has(step.step_id) && !steps.has(step.step_id), 'execution_duplicate_submission', `duplicate step '${step.step_id}'`, {});
        seen.add(step.step_id);
      }
      jobs.set(job.job_id, clone(job));
      runs.set(run.run_id, clone(run));
      for (const step of initialSteps) steps.set(step.step_id, clone(step));
      return clone({ job, run, steps: initialSteps });
    },

    readJob({ job_id, org_id } = {}) {
      const found = jobs.get(job_id) ?? null;
      return clone(owned(found, org_id, 'job'));
    },

    readRun({ run_id, org_id } = {}) {
      const found = runs.get(run_id) ?? null;
      return clone(owned(found, org_id, 'run'));
    },

    readStep({ step_id, org_id } = {}) {
      const found = steps.get(step_id) ?? null;
      return clone(owned(found, org_id, 'step'));
    },

    listSteps({ run_id, org_id } = {}) {
      requireRun(run_id, org_id);
      return clone([...steps.values()]
        .filter((step) => step.run_id === run_id && step.org_id === org_id)
        .sort((a, b) => a.sequence - b.sequence || a.step_id.localeCompare(b.step_id)));
    },

    transitionJob({ job_id, org_id, ...request } = {}) {
      return storeTransition('job', jobs, job_id, requireJob(job_id, org_id), request);
    },

    transitionRun({ run_id, org_id, ...request } = {}) {
      return storeTransition('run', runs, run_id, requireRun(run_id, org_id), request);
    },

    registerWorker(worker) {
      assertExecutionContract('worker', worker, { at: 'repository.registerWorker' });
      const existing = workers.get(worker.worker_id);
      invariant(existing === undefined || existing.document_digest === worker.document_digest, 'execution_worker_conflict', `worker '${worker.worker_id}' is already registered differently`, {});
      workers.set(worker.worker_id, clone(worker));
      return clone(worker);
    },

    readWorker({ worker_id, org_id } = {}) {
      const worker = workers.get(worker_id) ?? null;
      return clone(owned(worker, org_id, 'worker'));
    },

    heartbeatWorker(heartbeat) {
      assertExecutionContract('worker_heartbeat', heartbeat, { at: 'repository.heartbeatWorker' });
      const worker = workers.get(heartbeat.worker_id) ?? null;
      invariant(worker !== null, 'execution_worker_unknown', `worker '${heartbeat.worker_id}' is not registered`, {});
      owned(worker, heartbeat.org_id, 'worker');
      heartbeats.set(heartbeat.worker_id, clone(heartbeat));
      return clone(heartbeat);
    },

    listReady({ org_id, capabilities = [], now, limit = 1 } = {}) {
      invariant(typeof org_id === 'string' && org_id.length > 0, 'execution_tenant_required', 'ready query needs org_id', {});
      invariant(Array.isArray(capabilities), 'invalid_input', 'capabilities must be an array', {});
      invariant(isInstant(now), 'invalid_input', 'ready query needs now', {});
      invariant(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'invalid_input', 'ready query limit must be 1..100', {});
      const offered = new Set(capabilities);
      return clone([...jobs.values()]
        .filter((job) => job.org_id === org_id)
        .filter((job) => job.state === 'ready')
        .filter((job) => atOrBefore(job.available_at, now))
        .filter((job) => job.deadline_at === null || laterThan(job.deadline_at, now))
        .filter((job) => job.required_capabilities.every((capability) => offered.has(capability)))
        .sort(compareReady)
        .slice(0, limit));
    },

    claimLease({
      lease_id,
      claim_id,
      job_id,
      org_id,
      worker_id,
      now,
      expires_at,
      max_expires_at,
    } = {}) {
      const job = requireJob(job_id, org_id);
      const run = requireRun(job.run_id, org_id);
      const worker = owned(workers.get(worker_id) ?? null, org_id, 'worker');
      invariant(worker !== null, 'execution_worker_unknown', `worker '${worker_id}' is not registered`, {});
      invariant(worker.status === 'active', 'execution_worker_inactive', `worker '${worker_id}' is not active`, {});
      invariant(job.required_capabilities.every((capability) => worker.capabilities.includes(capability)), 'execution_capability_mismatch', `worker '${worker_id}' lacks a required capability`, {});
      invariant(isInstant(now) && isInstant(expires_at) && isInstant(max_expires_at), 'invalid_input', 'lease claim needs valid instants', {});
      invariant(laterThan(expires_at, now) && !laterThan(expires_at, max_expires_at), 'invalid_input', 'lease expiration must be after claim and within maximum', {});

      const activeId = activeLeaseByJob.get(job_id);
      if (activeId !== undefined) {
        const active = leases.get(activeId);
        if (active.status === 'active' && laterThan(active.expires_at, now)) {
          return clone({ ok: false, reason: 'execution_lease_contended', lease: active });
        }
        if (active.status === 'active') {
          leases.set(active.lease_id, rebuild('lease', { ...active, status: 'expired', released_at: now }));
        }
      }
      invariant(['ready', 'recovering'].includes(job.state), 'execution_not_ready', `job '${job_id}' is ${job.state}, not ready`, {});

      const fencing_token = (fenceByJob.get(job_id) ?? 0) + 1;
      fenceByJob.set(job_id, fencing_token);
      const lease = defineExecutionLease({
        lease_id,
        job_id,
        run_id: job.run_id,
        org_id,
        worker_id,
        fencing_token,
        status: 'active',
        claimed_at: now,
        expires_at,
        max_expires_at,
        renewal_count: 0,
        released_at: null,
      });
      leases.set(lease_id, lease);
      activeLeaseByJob.set(job_id, lease_id);
      storeTransition('job', jobs, job_id, job, {
        to: 'leased', expected_version: job.state_version, occurred_at: now,
      });
      storeTransition('run', runs, run.run_id, run, {
        to: 'leased', expected_version: run.state_version, occurred_at: now,
      });
      return clone({
        ok: true,
        reason: null,
        lease,
        claim: defineLeaseClaim({
          claim_id,
          lease_id,
          job_id,
          run_id: run.run_id,
          org_id,
          worker_id,
          fencing_token,
          claimed_at: now,
        }),
      });
    },

    readLease({ lease_id, org_id } = {}) {
      return clone(owned(leases.get(lease_id) ?? null, org_id, 'lease'));
    },

    verifyLease({ lease_id, job_id, run_id, org_id, worker_id, fencing_token, now } = {}) {
      const lease = leases.get(lease_id) ?? null;
      if (lease === null) return clone({ ok: false, reason: 'execution_lease_unknown', lease: null });
      if (
        lease.job_id !== job_id
        || lease.run_id !== run_id
        || lease.org_id !== org_id
        || lease.worker_id !== worker_id
      ) return clone({ ok: false, reason: 'execution_lease_owner_mismatch', lease: null });
      if (lease.fencing_token !== fencing_token || fenceByJob.get(job_id) !== fencing_token) {
        return clone({ ok: false, reason: 'execution_fencing_token_stale', lease: null });
      }
      if (lease.status !== 'active') return clone({ ok: false, reason: 'execution_lease_lost', lease: null });
      if (!laterThan(lease.expires_at, now)) return clone({ ok: false, reason: 'execution_lease_expired', lease: null });
      return clone({ ok: true, reason: null, lease });
    },

    renewLease({ lease_id, org_id, worker_id, fencing_token, now, expires_at } = {}) {
      const lease = owned(leases.get(lease_id) ?? null, org_id, 'lease');
      invariant(lease !== null, 'execution_lease_unknown', `lease '${lease_id}' is unknown`, {});
      const verified = repository.verifyLease({
        lease_id,
        job_id: lease.job_id,
        run_id: lease.run_id,
        org_id,
        worker_id,
        fencing_token,
        now,
      });
      invariant(verified.ok, verified.reason, `lease '${lease_id}' cannot renew`, {});
      invariant(laterThan(expires_at, now), 'invalid_input', 'renewed lease must expire after now', {});
      invariant(!laterThan(expires_at, lease.max_expires_at), 'execution_lease_renewal_limit', 'renewal exceeds the bounded lease lifetime', {});
      const renewed = rebuild('lease', {
        ...lease,
        expires_at,
        renewal_count: lease.renewal_count + 1,
      });
      leases.set(lease_id, renewed);
      return clone(renewed);
    },

    releaseLease({ lease_id, org_id, worker_id, fencing_token, now, reason_code = 'released' } = {}) {
      const lease = owned(leases.get(lease_id) ?? null, org_id, 'lease');
      invariant(lease !== null, 'execution_lease_unknown', `lease '${lease_id}' is unknown`, {});
      const verified = repository.verifyLease({
        lease_id,
        job_id: lease.job_id,
        run_id: lease.run_id,
        org_id,
        worker_id,
        fencing_token,
        now,
      });
      invariant(verified.ok, verified.reason, `lease '${lease_id}' cannot release`, {});
      const released = rebuild('lease', { ...lease, status: reason_code === 'completed' ? 'completed' : 'released', released_at: now });
      leases.set(lease_id, released);
      if (activeLeaseByJob.get(lease.job_id) === lease_id) activeLeaseByJob.delete(lease.job_id);
      return clone(released);
    },

    expireLease({ lease_id, org_id, now, reason_code = 'lease_expired' } = {}) {
      const lease = owned(leases.get(lease_id) ?? null, org_id, 'lease');
      invariant(lease !== null, 'execution_lease_unknown', `lease '${lease_id}' is unknown`, {});
      invariant(lease.status === 'active', 'execution_lease_lost', `lease '${lease_id}' is not active`, {});
      invariant(!laterThan(lease.expires_at, now), 'execution_lease_active', `lease '${lease_id}' has not expired`, {});
      const expired = rebuild('lease', { ...lease, status: 'expired', released_at: now });
      leases.set(lease_id, expired);
      if (activeLeaseByJob.get(lease.job_id) === lease_id) activeLeaseByJob.delete(lease.job_id);
      return clone({ ...expired, reason_code });
    },

    listExpiredLeases({ org_id, now } = {}) {
      invariant(isInstant(now), 'invalid_input', 'expired lease query needs now', {});
      return clone([...leases.values()]
        .filter((lease) => lease.org_id === org_id && lease.status === 'active' && !laterThan(lease.expires_at, now))
        .sort((a, b) => a.expires_at.localeCompare(b.expires_at) || a.lease_id.localeCompare(b.lease_id)));
    },

    createAttempt(attempt) {
      assertExecutionContract('attempt', attempt, { at: 'repository.createAttempt' });
      requireRun(attempt.run_id, attempt.org_id);
      requireJob(attempt.job_id, attempt.org_id);
      invariant(!attempts.has(attempt.attempt_id), 'execution_duplicate_submission', `attempt '${attempt.attempt_id}' already exists`, {});
      attempts.set(attempt.attempt_id, clone(attempt));
      return clone(attempt);
    },

    finishAttempt({ attempt_id, org_id, state, reason_code, error_class, result_digest, finished_at } = {}) {
      const attempt = owned(attempts.get(attempt_id) ?? null, org_id, 'attempt');
      invariant(attempt !== null, 'execution_attempt_unknown', `attempt '${attempt_id}' is unknown`, {});
      invariant(attempt.finished_at === null, 'execution_attempt_terminal', `attempt '${attempt_id}' is already finished`, {});
      const finished = rebuild('attempt', {
        ...attempt,
        state,
        reason_code,
        error_class,
        result_digest,
        finished_at,
      });
      attempts.set(attempt_id, finished);
      return clone(finished);
    },

    listAttempts({ run_id, org_id } = {}) {
      requireRun(run_id, org_id);
      return clone([...attempts.values()]
        .filter((attempt) => attempt.run_id === run_id && attempt.org_id === org_id)
        .sort((a, b) => a.number - b.number || a.attempt_id.localeCompare(b.attempt_id)));
    },

    commitCheckpoint(checkpoint, evidence = {}) {
      assertExecutionContract('checkpoint', checkpoint, { at: 'repository.commitCheckpoint' });
      const run = requireRun(checkpoint.run_id, checkpoint.org_id);
      requireJob(checkpoint.job_id, checkpoint.org_id);
      const verified = repository.verifyLease({
        lease_id: checkpoint.lease_id,
        job_id: checkpoint.job_id,
        run_id: checkpoint.run_id,
        org_id: checkpoint.org_id,
        worker_id: checkpoint.worker_id,
        fencing_token: checkpoint.fencing_token,
        now: evidence.now,
      });
      invariant(verified.ok, verified.reason, 'checkpoint refused after lease loss', {});
      invariant(run.state_version === evidence.expected_state_version, 'state_version_conflict', `checkpoint expected state version ${evidence.expected_state_version}, found ${run.state_version}`, {});
      invariant(checkpoint.state_version === run.state_version, 'state_version_conflict', 'checkpoint state version does not match run', {});
      const list = checkpoints.get(run.run_id) ?? [];
      invariant(checkpoint.sequence === list.length + 1, 'checkpoint_sequence_conflict', `checkpoint sequence must be ${list.length + 1}`, {});
      invariant(!checkpointIds.has(checkpoint.checkpoint_id), 'execution_duplicate_submission', `checkpoint '${checkpoint.checkpoint_id}' already exists`, {});
      list.push(clone(checkpoint));
      checkpoints.set(run.run_id, list);
      checkpointIds.add(checkpoint.checkpoint_id);
      const updated = rebuild('run', { ...run, checkpoint_id: checkpoint.checkpoint_id });
      runs.set(run.run_id, updated);
      return clone(checkpoint);
    },

    latestCheckpoint({ run_id, org_id } = {}) {
      requireRun(run_id, org_id);
      const list = checkpoints.get(run_id) ?? [];
      return clone(list.length === 0 ? null : list[list.length - 1]);
    },

    putWakeCondition(wake) {
      assertExecutionContract('wake_condition', wake, { at: 'repository.putWakeCondition' });
      requireRun(wake.run_id, wake.org_id);
      requireJob(wake.job_id, wake.org_id);
      const existing = wakes.get(wake.wake_id);
      invariant(existing === undefined || existing.document_digest === wake.document_digest, 'execution_wake_conflict', `wake '${wake.wake_id}' already differs`, {});
      wakes.set(wake.wake_id, clone(wake));
      return clone(wake);
    },

    readWakeCondition({ wake_id, org_id } = {}) {
      return clone(owned(wakes.get(wake_id) ?? null, org_id, 'wake condition'));
    },

    listWakeConditions({ org_id, status = null } = {}) {
      return clone([...wakes.values()]
        .filter((wake) => wake.org_id === org_id && (status === null || wake.status === status))
        .sort((a, b) => a.available_at.localeCompare(b.available_at) || a.wake_id.localeCompare(b.wake_id)));
    },

    satisfyWakeCondition({ wake_id, org_id, occurred_at, payload_digest = null } = {}) {
      const wake = owned(wakes.get(wake_id) ?? null, org_id, 'wake condition');
      invariant(wake !== null, 'execution_wake_unknown', `wake '${wake_id}' is unknown`, {});
      invariant(wake.status === 'pending', 'execution_wake_terminal', `wake '${wake_id}' is ${wake.status}`, {});
      const satisfied = rebuild('wake_condition', {
        ...wake,
        status: 'satisfied',
        satisfied_at: occurred_at,
        payload_digest: payload_digest ?? wake.payload_digest,
      });
      wakes.set(wake_id, satisfied);
      return clone(satisfied);
    },

    cancelWakeCondition({ wake_id, org_id, occurred_at } = {}) {
      const wake = owned(wakes.get(wake_id) ?? null, org_id, 'wake condition');
      invariant(wake !== null, 'execution_wake_unknown', `wake '${wake_id}' is unknown`, {});
      invariant(wake.status === 'pending', 'execution_wake_terminal', `wake '${wake_id}' is ${wake.status}`, {});
      const cancelled = rebuild('wake_condition', { ...wake, status: 'cancelled', satisfied_at: occurred_at });
      wakes.set(wake_id, cancelled);
      return clone(cancelled);
    },

    putCancellation(request) {
      assertExecutionContract('cancellation_request', request, { at: 'repository.putCancellation' });
      requireRun(request.run_id, request.org_id);
      requireJob(request.job_id, request.org_id);
      const existing = cancellations.get(request.run_id);
      invariant(existing === undefined || existing.document_digest === request.document_digest, 'execution_cancellation_conflict', `run '${request.run_id}' already has a different cancellation`, {});
      cancellations.set(request.run_id, clone(request));
      return clone(request);
    },

    readCancellation({ run_id, org_id } = {}) {
      requireRun(run_id, org_id);
      return clone(owned(cancellations.get(run_id) ?? null, org_id, 'cancellation'));
    },

    putIdempotency(record) {
      assertExecutionContract('idempotency_record', record, { at: 'repository.putIdempotency' });
      const key = `${record.org_id}\u0000${record.scope}\u0000${record.idempotency_key}`;
      const existing = idempotency.get(key);
      if (existing !== undefined && existing.action_digest !== record.action_digest) {
        return clone({ ok: false, reason: 'execution_idempotency_conflict', record: existing });
      }
      if (existing !== undefined) return clone({ ok: true, replayed: true, record: existing });
      idempotency.set(key, clone(record));
      return clone({ ok: true, replayed: false, record });
    },

    readIdempotency({ org_id, scope, idempotency_key } = {}) {
      return clone(idempotency.get(`${org_id}\u0000${scope}\u0000${idempotency_key}`) ?? null);
    },

    putEffectReceipt(receipt, evidence = {}) {
      assertExecutionContract('effect_receipt', receipt, { at: 'repository.putEffectReceipt' });
      const verified = repository.verifyLease({
        lease_id: receipt.lease_id,
        job_id: receipt.job_id,
        run_id: receipt.run_id,
        org_id: receipt.org_id,
        worker_id: receipt.worker_id,
        fencing_token: receipt.fencing_token,
        now: evidence.now,
      });
      invariant(verified.ok, verified.reason, 'effect receipt refused after lease loss', {});
      const key = `${receipt.org_id}\u0000${receipt.idempotency_key}`;
      const existingId = effectByKey.get(key);
      if (existingId !== undefined) {
        const existing = effects.get(existingId);
        invariant(existing.action_digest === receipt.action_digest, 'execution_idempotency_conflict', 'effect idempotency key was reused for another action', {});
        const allowed = {
          proposed: ['admitted', 'refused'],
          admitted: ['executing', 'refused'],
          executing: ['confirmed', 'uncertain', 'refused'],
          confirmed: ['compensation_requested'],
          refused: [],
          uncertain: ['compensation_requested'],
          compensation_requested: ['compensated', 'uncertain'],
          compensated: [],
        };
        invariant(existing.effect_id === receipt.effect_id, 'execution_idempotency_conflict', 'effect identity changed for an idempotency key', {});
        invariant(allowed[existing.state].includes(receipt.state) || existing.document_digest === receipt.document_digest, 'invalid_transition', `effect cannot transition ${existing.state} -> ${receipt.state}`, {});
      }
      effects.set(receipt.effect_id, clone(receipt));
      effectByKey.set(key, receipt.effect_id);
      return clone(receipt);
    },

    readEffectByKey({ org_id, idempotency_key } = {}) {
      const effectId = effectByKey.get(`${org_id}\u0000${idempotency_key}`);
      return clone(effectId === undefined ? null : effects.get(effectId));
    },

    listEffects({ run_id, org_id } = {}) {
      requireRun(run_id, org_id);
      return clone([...effects.values()]
        .filter((effect) => effect.run_id === run_id && effect.org_id === org_id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.effect_id.localeCompare(b.effect_id)));
    },

    putCompletion(completion, evidence = {}) {
      assertExecutionContract('completion_record', completion, { at: 'repository.putCompletion' });
      requireRun(completion.run_id, completion.org_id);
      requireJob(completion.job_id, completion.org_id);
      const existing = completions.get(completion.run_id);
      if (existing !== undefined && existing.document_digest === completion.document_digest) return clone(existing);
      const verified = repository.verifyLease({
        lease_id: evidence.lease_id,
        job_id: completion.job_id,
        run_id: completion.run_id,
        org_id: completion.org_id,
        worker_id: evidence.worker_id,
        fencing_token: evidence.fencing_token,
        now: evidence.now,
      });
      invariant(verified.ok, verified.reason, 'completion refused after lease loss', {});
      invariant(existing === undefined || existing.document_digest === completion.document_digest, 'execution_completion_conflict', `run '${completion.run_id}' completed differently`, {});
      completions.set(completion.run_id, clone(completion));
      return clone(completion);
    },

    putDeadLetter(record) {
      assertExecutionContract('dead_letter', record, { at: 'repository.putDeadLetter' });
      requireRun(record.run_id, record.org_id);
      requireJob(record.job_id, record.org_id);
      const existing = deadLetters.get(record.run_id);
      invariant(existing === undefined || existing.document_digest === record.document_digest, 'execution_dead_letter_conflict', `run '${record.run_id}' dead-lettered differently`, {});
      deadLetters.set(record.run_id, clone(record));
      return clone(record);
    },

    readDeadLetter({ run_id, org_id } = {}) {
      requireRun(run_id, org_id);
      return clone(owned(deadLetters.get(run_id) ?? null, org_id, 'dead letter'));
    },

    appendEvent,

    eventsForRun({ run_id, org_id } = {}) {
      requireRun(run_id, org_id);
      return clone(eventLogs.get(run_id) ?? []);
    },

    listJobs({ org_id, states = null } = {}) {
      return clone([...jobs.values()]
        .filter((job) => job.org_id === org_id && (states === null || states.includes(job.state)))
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.job_id.localeCompare(b.job_id)));
    },

    listRuns({ org_id, states = null } = {}) {
      return clone([...runs.values()]
        .filter((run) => run.org_id === org_id && (states === null || states.includes(run.state)))
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.run_id.localeCompare(b.run_id)));
    },

    queueStatus({ org_id, now, capacity = 1000 } = {}) {
      invariant(isInstant(now), 'invalid_input', 'queue status needs now', {});
      invariant(Number.isInteger(capacity) && capacity >= 1, 'invalid_input', 'queue capacity must be positive', {});
      const partition = [...jobs.values()].filter((job) => job.org_id === org_id);
      const ready = partition.filter((job) => job.state === 'ready' && atOrBefore(job.available_at, now)).length;
      const delayed = partition.filter((job) => ['scheduled', 'retry_scheduled', 'waiting_until'].includes(job.state)).length;
      const leased = partition.filter((job) => ['leased', 'running', 'checkpointing'].includes(job.state)).length;
      return clone({
        schema: 'awe.queue_status/v1',
        org_id,
        capacity,
        ready,
        delayed,
        leased,
        depth: ready + delayed,
        backpressure: ready + delayed >= capacity,
      });
    },

    snapshot() {
      return clone({
        schema: 'awe.execution_repository_snapshot/v1',
        jobs: [...jobs.values()],
        runs: [...runs.values()],
        steps: [...steps.values()],
        workers: [...workers.values()],
        heartbeats: [...heartbeats.values()],
        leases: [...leases.values()],
        attempts: [...attempts.values()],
        checkpoints: [...checkpoints.values()].flat(),
        wakes: [...wakes.values()],
        cancellations: [...cancellations.values()],
        idempotency: [...idempotency.values()],
        effects: [...effects.values()],
        completions: [...completions.values()],
        dead_letters: [...deadLetters.values()],
        events: [...eventLogs.values()].flat(),
        snapshot_digest: digest({
          jobs: [...jobs.values()].map((entry) => entry.document_digest),
          runs: [...runs.values()].map((entry) => entry.document_digest),
          events: [...eventLogs.values()].flat().map((entry) => entry.event_digest),
        }),
      });
    },
  };

  return defineExecutionRepository(repository);
}
