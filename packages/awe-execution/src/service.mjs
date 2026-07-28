import { deepFreeze, digest, invariant, isInstant, redact } from './kernel.mjs';
import {
  defineApprovalWakeup,
  defineCancellationRequest,
  defineExecutionJob,
  defineExecutionRun,
  defineExecutionStep,
  defineExternalEventWakeup,
  defineIdempotencyRecord,
  defineWorker,
  executionContentDigest,
} from './contracts.mjs';
import { createRecoveryController } from './recovery.mjs';
import { replayExecution } from './replay.mjs';
import { createExecutionScheduler } from './scheduler.mjs';
import { createExecutionWorker } from './worker.mjs';

export function createSequenceIdentifiers({ prefix = 'exec', start = 0 } = {}) {
  invariant(typeof prefix === 'string' && /^[a-z][a-z0-9_-]*$/.test(prefix), 'invalid_input', 'identifier prefix is invalid', {});
  invariant(Number.isInteger(start) && start >= 0, 'invalid_input', 'identifier start must be non-negative', {});
  let sequence = start;
  return Object.freeze({
    next(kind = 'id') {
      sequence += 1;
      return `${prefix}:${kind}:${String(sequence).padStart(6, '0')}`;
    },
    current() { return sequence; },
  });
}

export function createExecutionService({
  repository,
  clock,
  ids = createSequenceIdentifiers(),
  platform_limits = {},
  allow_live = false,
} = {}) {
  invariant(repository !== null && typeof repository?.accept === 'function', 'invalid_input', 'execution service needs a repository', {});
  invariant(typeof clock === 'function', 'invalid_input', 'execution service needs an injected clock', {});
  invariant(ids !== null && typeof ids?.next === 'function', 'invalid_input', 'execution service needs an identifier source', {});
  const limits = deepFreeze({
    max_attempts: platform_limits.max_attempts ?? 5,
    max_execution_duration_ms: platform_limits.max_execution_duration_ms ?? 3600000,
    max_pause_duration_ms: platform_limits.max_pause_duration_ms ?? 2592000000,
    max_checkpoints: platform_limits.max_checkpoints ?? 1000,
    max_recoveries: platform_limits.max_recoveries ?? 5,
    max_compensations: platform_limits.max_compensations ?? 100,
    max_scheduled_wakeups: platform_limits.max_scheduled_wakeups ?? 100,
    max_agent_turns: platform_limits.max_agent_turns ?? 50,
    max_tool_invocations: platform_limits.max_tool_invocations ?? 100,
    max_uncertain_effects: platform_limits.max_uncertain_effects ?? 1,
  });
  const scheduler = createExecutionScheduler({ repository, clock, ids });
  const recovery = createRecoveryController({
    repository,
    clock,
    ids,
    max_recoveries: limits.max_recoveries,
  });

  function emit(run, job, event_type, payload, occurred_at) {
    return repository.appendEvent({
      event_id: ids.next('event'),
      run_id: run.run_id,
      job_id: job.job_id,
      org_id: run.org_id,
      event_type,
      payload,
      occurred_at,
      correlation_id: run.correlation_id,
      causation_id: run.causation_id,
    });
  }

  function inspect({ run_id, org_id } = {}) {
    const run = repository.readRun({ run_id, org_id });
    if (run === null) return null;
    return deepFreeze({
      run,
      job: repository.readJob({ job_id: run.job_id, org_id }),
      steps: repository.listSteps({ run_id, org_id }),
      attempts: repository.listAttempts({ run_id, org_id }),
      checkpoint: repository.latestCheckpoint({ run_id, org_id }),
      wake: run.wake_id === null ? null : repository.readWakeCondition({ wake_id: run.wake_id, org_id }),
      effects: repository.listEffects({ run_id, org_id }),
      cancellation: repository.readCancellation({ run_id, org_id }),
      dead_letter: repository.readDeadLetter({ run_id, org_id }),
      events: repository.eventsForRun({ run_id, org_id }),
    });
  }

  function acceptJob(request = {}) {
    invariant(request !== null && typeof request === 'object' && !Array.isArray(request), 'invalid_input', 'job request must be an object', {});
    const now = request.created_at ?? clock();
    invariant(isInstant(now), 'invalid_input', 'job created_at must be an instant', {});
    const environment = request.environment ?? 'TEST';
    invariant(environment !== 'LIVE' || allow_live === true, 'live_mode_unratified', 'durable execution LIVE mode is not ratified', {});
    invariant(['workflow', 'agent'].includes(request.kind), 'invalid_input', 'job kind must be workflow or agent', {});
    invariant(typeof request.org_id === 'string' && request.org_id.length > 0, 'execution_tenant_required', 'job request needs org_id', {});
    invariant(typeof request.idempotency_key === 'string' && request.idempotency_key.length > 0, 'invalid_input', 'job request needs idempotency_key', {});
    const existing = repository.readIdempotency({
      org_id: request.org_id,
      scope: 'job_acceptance',
      idempotency_key: request.idempotency_key,
    });
    const payloadDigest = executionContentDigest(request.payload ?? {});
    if (existing !== null) {
      invariant(existing.action_digest === payloadDigest, 'execution_idempotency_conflict', 'job idempotency key was reused for another payload', {});
      const job = repository.readJob({ job_id: existing.result_ref, org_id: request.org_id });
      return deepFreeze({ ok: true, duplicate: true, job, run: repository.readRun({ run_id: job.run_id, org_id: request.org_id }) });
    }
    const job_id = request.job_id ?? ids.next('job');
    const run_id = request.run_id ?? ids.next('run');
    const trace_id = request.trace_id ?? ids.next('trace');
    const correlation_id = request.correlation_id ?? run_id;
    const causation_id = request.causation_id ?? null;
    const deadline_at = request.deadline_at ?? new Date(Date.parse(now) + limits.max_execution_duration_ms).toISOString();
    const available_at = request.available_at ?? now;
    const maxAttempts = Math.min(request.max_attempts ?? limits.max_attempts, limits.max_attempts);
    const initialState = Date.parse(available_at) > Date.parse(now) ? 'accepted' : 'accepted';
    const common = {
      org_id: request.org_id,
      environment,
      kind: request.kind,
      workflow_id: request.workflow_id ?? null,
      workflow_version: request.workflow_version ?? null,
      agent_id: request.agent_id ?? null,
      agent_version: request.agent_version ?? null,
      trace_id,
      correlation_id,
      causation_id,
      created_at: now,
      updated_at: now,
      metadata: {
        ...(request.metadata ?? {}),
        payload: redact(request.payload ?? {}),
        authorization_envelope_digest: request.authorization_envelope_digest ?? null,
        context_item_refs: request.context_item_refs ?? [],
        memory_snapshot_refs: request.memory_snapshot_refs ?? [],
      },
    };
    const job = defineExecutionJob({
      job_id,
      run_id,
      ...common,
      state: initialState,
      priority_class: request.priority_class ?? 'normal',
      required_capabilities: request.required_capabilities ?? [request.kind],
      available_at,
      deadline_at,
      attempt_count: 0,
      max_attempts: maxAttempts,
      state_version: 0,
      idempotency_key: request.idempotency_key,
      payload_digest: payloadDigest,
      terminal_reason: null,
    });
    const step_id = request.step_id ?? ids.next('step');
    const run = defineExecutionRun({
      run_id,
      job_id,
      ...common,
      state: initialState,
      active_step_id: step_id,
      checkpoint_id: null,
      wake_id: null,
      state_version: 0,
      attempt_count: 0,
      recovery_count: 0,
      compensation_count: 0,
      started_at: null,
      deadline_at,
      completed_at: null,
      result_digest: null,
      terminal_reason: null,
    });
    const step = defineExecutionStep({
      step_id,
      run_id,
      job_id,
      org_id: request.org_id,
      state: 'accepted',
      state_version: 0,
      sequence: 1,
      name: request.step_name ?? `${request.kind}_execution`,
      kind: request.kind,
      attempt_count: 0,
      max_attempts: maxAttempts,
      idempotency_key: `${request.idempotency_key}:step:1`,
      input_digest: payloadDigest,
      output_digest: null,
      compensation: request.compensation ?? { mode: 'unsupported' },
      created_at: now,
      updated_at: now,
    });
    repository.accept({ job, run, steps: [step] });
    repository.putIdempotency(defineIdempotencyRecord({
      idempotency_key: request.idempotency_key,
      org_id: request.org_id,
      scope: 'job_acceptance',
      action_digest: payloadDigest,
      state: 'confirmed',
      result_ref: job_id,
      created_at: now,
      updated_at: now,
    }));
    emit(run, job, 'job.accepted', {
      kind: request.kind,
      payload_digest: payloadDigest,
      priority_class: job.priority_class,
    }, now);
    const scheduled = scheduleJob({ job_id, org_id: request.org_id, available_at, now });
    return deepFreeze({ ok: true, duplicate: false, ...scheduled });
  }

  function scheduleJob({ job_id, org_id, available_at, now = clock() } = {}) {
    let job = repository.readJob({ job_id, org_id });
    invariant(job !== null, 'execution_job_unknown', `job '${job_id}' is unknown`, {});
    let run = repository.readRun({ run_id: job.run_id, org_id });
    invariant(job.state === 'accepted', 'invalid_transition', `job '${job_id}' cannot be scheduled from ${job.state}`, {});
    const target = Date.parse(available_at) <= Date.parse(now) ? 'ready' : 'scheduled';
    job = repository.transitionJob({
      job_id,
      org_id,
      to: target,
      expected_version: job.state_version,
      occurred_at: now,
      reason_code: target === 'ready' ? 'eligible_now' : 'scheduled_future',
      patch: { available_at },
    });
    run = repository.transitionRun({
      run_id: run.run_id,
      org_id,
      to: target,
      expected_version: run.state_version,
      occurred_at: now,
      reason_code: target === 'ready' ? 'eligible_now' : 'scheduled_future',
    });
    emit(run, job, target === 'ready' ? 'job.ready' : 'job.scheduled', { available_at }, now);
    return deepFreeze({ job, run });
  }

  function registerWorker(spec = {}) {
    const worker = defineWorker({
      worker_id: spec.worker_id ?? ids.next('worker'),
      org_id: spec.org_id,
      environment: spec.environment ?? 'TEST',
      capabilities: spec.capabilities ?? [],
      max_concurrency: spec.max_concurrency ?? 1,
      status: spec.status ?? 'active',
      registered_at: spec.registered_at ?? clock(),
    });
    return repository.registerWorker(worker);
  }

  function createWorker({ worker, executor, ...options } = {}) {
    repository.registerWorker(worker);
    return createExecutionWorker({
      worker,
      repository,
      executor,
      clock,
      ids,
      limits,
      ...options,
    });
  }

  function signalApproval({
    wake_id,
    org_id,
    action_digest,
    decision,
    actor,
    principal,
    principal_roles,
    occurred_at = clock(),
  } = {}) {
    invariant(actor === 'human', 'approval_actor_invalid', 'automation cannot approve execution', {});
    invariant(['approve', 'reject'].includes(decision), 'invalid_input', 'approval decision must be approve or reject', {});
    const wake = repository.readWakeCondition({ wake_id, org_id });
    invariant(wake !== null && wake.kind === 'approval', 'execution_wake_unknown', 'approval wake is unknown', {});
    invariant(wake.status === 'pending', 'execution_wake_terminal', 'approval wake is no longer pending', {});
    invariant(wake.action_digest === action_digest, 'approval_digest_mismatch', 'approval action digest is stale or altered', {});
    const approval = defineApprovalWakeup({
      approval_id: ids.next('approval'),
      wake_id,
      run_id: wake.run_id,
      job_id: wake.job_id,
      org_id,
      action_digest,
      decision,
      actor,
      principal,
      principal_roles,
      occurred_at,
    });
    const run = repository.readRun({ run_id: wake.run_id, org_id });
    const job = repository.readJob({ job_id: wake.job_id, org_id });
    if (decision === 'reject') {
      repository.cancelWakeCondition({ wake_id, org_id, occurred_at });
      const failedJob = repository.transitionJob({
        job_id: job.job_id, org_id, to: 'failed', expected_version: job.state_version,
        occurred_at, reason_code: 'approval_rejected',
      });
      const failedRun = repository.transitionRun({
        run_id: run.run_id, org_id, to: 'failed', expected_version: run.state_version,
        occurred_at, reason_code: 'approval_rejected',
      });
      emit(failedRun, failedJob, 'approval.received', {
        approval_id: approval.approval_id,
        decision,
        action_digest,
      }, occurred_at);
      emit(failedRun, failedJob, 'execution.failed', { reason_code: 'approval_rejected' }, occurred_at);
      return deepFreeze({ approval, run: failedRun, job: failedJob });
    }
    repository.satisfyWakeCondition({
      wake_id,
      org_id,
      occurred_at,
      payload_digest: approval.document_digest,
    });
    emit(run, job, 'approval.received', {
      approval_id: approval.approval_id,
      decision,
      action_digest,
      principal,
    }, occurred_at);
    return deepFreeze({ approval, wake: repository.readWakeCondition({ wake_id, org_id }) });
  }

  function signalExternalEvent({
    wake_id,
    org_id,
    correlation_key,
    payload,
    occurred_at = clock(),
  } = {}) {
    const wake = repository.readWakeCondition({ wake_id, org_id });
    invariant(wake !== null && wake.kind === 'external_event', 'execution_wake_unknown', 'external-event wake is unknown', {});
    invariant(wake.status === 'pending', 'execution_wake_terminal', 'external-event wake is no longer pending', {});
    invariant(wake.correlation_key === correlation_key, 'execution_event_correlation_mismatch', 'external event correlation does not match wake', {});
    const event = defineExternalEventWakeup({
      external_event_id: ids.next('external_event'),
      wake_id,
      run_id: wake.run_id,
      job_id: wake.job_id,
      org_id,
      correlation_key,
      payload_digest: executionContentDigest(payload),
      occurred_at,
    });
    repository.satisfyWakeCondition({
      wake_id,
      org_id,
      occurred_at,
      payload_digest: event.payload_digest,
    });
    const run = repository.readRun({ run_id: wake.run_id, org_id });
    const job = repository.readJob({ job_id: wake.job_id, org_id });
    emit(run, job, 'execution.resumed', {
      wake_id,
      external_event_id: event.external_event_id,
      correlation_key,
    }, occurred_at);
    return event;
  }

  function requestCancellation({
    run_id,
    org_id,
    actor = 'human',
    principal,
    reason_code = 'operator_cancelled',
    requested_at = clock(),
  } = {}) {
    const run = repository.readRun({ run_id, org_id });
    invariant(run !== null, 'execution_run_unknown', `run '${run_id}' is unknown`, {});
    const job = repository.readJob({ job_id: run.job_id, org_id });
    const request = defineCancellationRequest({
      cancellation_id: ids.next('cancellation'),
      run_id,
      job_id: job.job_id,
      org_id,
      actor,
      principal,
      reason_code,
      requested_at,
      status: 'requested',
    });
    repository.putCancellation(request);
    emit(run, job, 'cancellation.requested', {
      cancellation_id: request.cancellation_id,
      reason_code,
    }, requested_at);
    if (['scheduled', 'ready'].includes(run.state)) {
      const cancellingJob = repository.transitionJob({
        job_id: job.job_id, org_id, to: 'cancelling', expected_version: job.state_version,
        occurred_at: requested_at, reason_code,
      });
      const cancellingRun = repository.transitionRun({
        run_id, org_id, to: 'cancelling', expected_version: run.state_version,
        occurred_at: requested_at, reason_code,
      });
      const cancelledJob = repository.transitionJob({
        job_id: job.job_id, org_id, to: 'cancelled', expected_version: cancellingJob.state_version,
        occurred_at: requested_at, reason_code,
      });
      const cancelledRun = repository.transitionRun({
        run_id, org_id, to: 'cancelled', expected_version: cancellingRun.state_version,
        occurred_at: requested_at, reason_code,
        patch: { completed_at: requested_at },
      });
      emit(cancelledRun, cancelledJob, 'cancellation.completed', {
        cancellation_id: request.cancellation_id,
        reason_code,
      }, requested_at);
      return deepFreeze({ request, run: cancelledRun, job: cancelledJob });
    }
    if (['waiting', 'waiting_for_approval', 'waiting_for_event', 'waiting_until', 'retry_scheduled'].includes(run.state)) {
      if (run.wake_id !== null) repository.cancelWakeCondition({ wake_id: run.wake_id, org_id, occurred_at: requested_at });
      const readyJob = repository.transitionJob({
        job_id: job.job_id, org_id, to: 'ready', expected_version: job.state_version,
        occurred_at: requested_at, reason_code: 'cancellation_ready',
        patch: { available_at: requested_at },
      });
      const readyRun = repository.transitionRun({
        run_id, org_id, to: 'ready', expected_version: run.state_version,
        occurred_at: requested_at, reason_code: 'cancellation_ready',
        patch: { wake_id: null },
      });
      return deepFreeze({ request, run: readyRun, job: readyJob });
    }
    return deepFreeze({ request, run, job });
  }

  function resumeWake({
    wake_id,
    org_id,
    actor = 'human',
    principal,
    reason_code = 'operator_resumed',
    occurred_at = clock(),
  } = {}) {
    invariant(actor === 'human' || actor === 'service', 'invalid_input', 'resume actor must be human or service', {});
    const wake = repository.readWakeCondition({ wake_id, org_id });
    invariant(wake !== null, 'execution_wake_unknown', `wake '${wake_id}' is unknown`, {});
    invariant(['manual_hold', 'policy_review', 'dependency'].includes(wake.kind), 'invalid_input', `wake kind '${wake.kind}' needs its dedicated signal`, {});
    invariant(wake.status === 'pending', 'execution_wake_terminal', `wake '${wake_id}' is ${wake.status}`, {});
    repository.satisfyWakeCondition({
      wake_id,
      org_id,
      occurred_at,
      payload_digest: digest({ wake_id, actor, principal, reason_code }),
    });
    const run = repository.readRun({ run_id: wake.run_id, org_id });
    const job = repository.readJob({ job_id: wake.job_id, org_id });
    emit(run, job, 'execution.resumed', {
      wake_id,
      kind: wake.kind,
      actor,
      principal,
      reason_code,
    }, occurred_at);
    return deepFreeze({
      wake: repository.readWakeCondition({ wake_id, org_id }),
      run,
      job,
    });
  }

  function replay({ run_id, org_id, mode = 'control_decision_replay', external_effects = 'simulate' } = {}) {
    const state = inspect({ run_id, org_id });
    invariant(state !== null, 'execution_run_unknown', `run '${run_id}' is unknown`, {});
    return replayExecution({
      events: state.events,
      checkpoint: state.checkpoint,
      expected_state: state.run.state,
      mode,
      external_effects,
    });
  }

  return Object.freeze({
    acceptJob,
    scheduleJob,
    registerWorker,
    createWorker,
    signalApproval,
    signalExternalEvent,
    resumeWake,
    requestCancellation,
    tick: (request) => scheduler.tick(request),
    recover: (request) => recovery.sweep(request),
    inspect,
    replay,
    describe() {
      return deepFreeze({
        schema: 'awe.execution_service_description/v1',
        allow_live,
        limits,
        repository: repository.kind,
        service_digest: digest({ allow_live, limits, repository: repository.kind }),
      });
    },
  });
}
