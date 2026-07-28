import { deepFreeze, digest, invariant, isInstant, redact } from './kernel.mjs';
import {
  assertExecutionContract,
  defineCompletionRecord,
  defineDeadLetterRecord,
  defineExecutionAttempt,
  defineExecutionCheckpoint,
  defineWakeCondition,
  defineWorkerHeartbeat,
  executionContentDigest,
} from './contracts.mjs';
import { compensateEffect, executeIdempotentEffect } from './effects.mjs';
import { decideRetry, defineRetryPolicy, instantPlus } from './retry.mjs';

const WAIT_STATE_BY_WAKE = Object.freeze({
  approval: 'waiting_for_approval',
  external_event: 'waiting_for_event',
  scheduled_time: 'waiting_until',
  manual_hold: 'waiting',
  policy_review: 'waiting',
  retry_backoff: 'retry_scheduled',
  dependency: 'waiting',
  rate_limit: 'retry_scheduled',
});

function validateExecutor(executor) {
  invariant(executor !== null && typeof executor === 'object' && typeof executor.execute === 'function', 'invalid_input', 'worker needs an executor with execute()', {});
  return executor;
}

function validateResult(result) {
  invariant(result !== null && typeof result === 'object' && !Array.isArray(result), 'contract_violation', 'executor returned no structured result', {});
  invariant(['completed', 'paused', 'retry', 'failed', 'cancelled', 'compensate'].includes(result.kind), 'contract_violation', `executor returned unknown result kind '${result.kind}'`, {});
  if (result.kind === 'paused') {
    invariant(result.wake !== null && typeof result.wake === 'object', 'contract_violation', 'paused execution needs a wake condition', {});
    invariant(WAIT_STATE_BY_WAKE[result.wake.kind] !== undefined, 'contract_violation', `unsupported wake kind '${result.wake.kind}'`, {});
  }
  return result;
}

function validateStored(type, document, { nullable = false, at } = {}) {
  if (nullable && document === null) return null;
  return assertExecutionContract(type, document, { at });
}

export function createExecutionWorker({
  worker,
  repository,
  executor,
  clock,
  ids,
  retry_policy = defineRetryPolicy(),
  randomness = () => 0.5,
  lease_duration_ms = 30000,
  max_lease_duration_ms = 120000,
  limits = {},
  event_port = null,
  audit_port = null,
  compensators = [],
} = {}) {
  invariant(worker !== null && worker?.schema === 'awe.worker/v1', 'invalid_input', 'worker runtime needs a validated worker', {});
  invariant(repository !== null && typeof repository?.claimLease === 'function', 'invalid_input', 'worker runtime needs a repository', {});
  validateExecutor(executor);
  invariant(typeof clock === 'function', 'invalid_input', 'worker runtime needs an injected clock', {});
  invariant(ids !== null && typeof ids?.next === 'function', 'invalid_input', 'worker runtime needs an injected identifier source', {});
  invariant(Number.isInteger(lease_duration_ms) && lease_duration_ms > 0, 'invalid_input', 'lease_duration_ms must be positive', {});
  invariant(Number.isInteger(max_lease_duration_ms) && max_lease_duration_ms >= lease_duration_ms, 'invalid_input', 'max lease duration must bound the lease duration', {});
  const retryPolicy = defineRetryPolicy(retry_policy);
  invariant(Array.isArray(compensators), 'invalid_input', 'worker compensators must be an array', {});
  const configuredLimits = {
    max_checkpoints: limits.max_checkpoints ?? 100,
    max_uncertain_effects: limits.max_uncertain_effects ?? 1,
    max_compensations: limits.max_compensations ?? 100,
  };
  let stopped = false;

  function emit(run, job, event_type, payload, occurred_at = clock()) {
    const event = repository.appendEvent({
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
    if (event_port?.append) event_port.append(event);
    if (audit_port?.emit) audit_port.emit([event], { run_id: run.run_id, org_id: run.org_id });
    return event;
  }

  function transitionPair(run, job, to, at, reason_code = null, patches = {}) {
    const nextJob = repository.transitionJob({
      job_id: job.job_id,
      org_id: job.org_id,
      to,
      expected_version: job.state_version,
      occurred_at: at,
      reason_code,
      patch: patches.job ?? {},
    });
    const nextRun = repository.transitionRun({
      run_id: run.run_id,
      org_id: run.org_id,
      to,
      expected_version: run.state_version,
      occurred_at: at,
      reason_code,
      patch: patches.run ?? {},
    });
    return { run: nextRun, job: nextJob };
  }

  function leaseEvidence(lease, now = clock()) {
    return {
      lease_id: lease.lease_id,
      job_id: lease.job_id,
      run_id: lease.run_id,
      org_id: lease.org_id,
      worker_id: lease.worker_id,
      fencing_token: lease.fencing_token,
      now,
    };
  }

  function assertLease(lease, at = clock()) {
    const verified = repository.verifyLease(leaseEvidence(lease, at));
    invariant(verified.ok, verified.reason, `worker '${worker.worker_id}' lost lease '${lease.lease_id}'`, {});
    return verified.lease;
  }

  function heartbeat() {
    const at = clock();
    const active = repository.listJobs({ org_id: worker.org_id, states: ['leased', 'running', 'checkpointing'] })
      .map((job) => repository.snapshot().leases.find((lease) => lease.job_id === job.job_id && lease.status === 'active'))
      .filter(Boolean)
      .map((lease) => lease.lease_id);
    const document = defineWorkerHeartbeat({
      heartbeat_id: ids.next('heartbeat'),
      worker_id: worker.worker_id,
      org_id: worker.org_id,
      active_lease_ids: active,
      occurred_at: at,
    });
    return repository.heartbeatWorker(document);
  }

  function renew(lease, duration_ms = lease_duration_ms) {
    const now = clock();
    const renewed = repository.renewLease({
      lease_id: lease.lease_id,
      org_id: lease.org_id,
      worker_id: lease.worker_id,
      fencing_token: lease.fencing_token,
      now,
      expires_at: instantPlus(now, duration_ms),
    });
    const run = repository.readRun({ run_id: lease.run_id, org_id: lease.org_id });
    const job = repository.readJob({ job_id: lease.job_id, org_id: lease.org_id });
    emit(run, job, 'lease.renewed', {
      lease_id: lease.lease_id,
      worker_id: worker.worker_id,
      fencing_token: lease.fencing_token,
      expires_at: renewed.expires_at,
      renewal_count: renewed.renewal_count,
    }, now);
    return renewed;
  }

  function checkpointDocument({ run, job, attempt, lease, data, wake = null }) {
    const previous = repository.latestCheckpoint({ run_id: run.run_id, org_id: run.org_id });
    invariant((previous?.sequence ?? 0) < configuredLimits.max_checkpoints, 'execution_checkpoint_limit', 'checkpoint limit exhausted', {});
    const body = {
      workflow_state: data?.workflow_state ?? null,
      agent_loop_state: data?.agent_loop_state ?? null,
      completed_steps: data?.completed_steps ?? [],
      pending_step: data?.pending_step ?? null,
      context_snapshot_ref: data?.context_snapshot_ref ?? null,
      memory_snapshot_refs: data?.memory_snapshot_refs ?? [],
      transcript_position: data?.transcript_position ?? 0,
      tool_receipts: data?.tool_receipts ?? [],
      effect_receipts: data?.effect_receipts ?? [],
      policy_decisions: data?.policy_decisions ?? [],
      approval_requests: data?.approval_requests ?? [],
      retry_state: data?.retry_state ?? null,
      compensation_stack: data?.compensation_stack ?? [],
      wake_condition: wake,
      runtime_versions: data?.runtime_versions ?? {},
      content_digests: data?.content_digests ?? {},
    };
    return defineExecutionCheckpoint({
      checkpoint_id: ids.next('checkpoint'),
      run_id: run.run_id,
      job_id: job.job_id,
      step_id: run.active_step_id,
      attempt_id: attempt.attempt_id,
      lease_id: lease.lease_id,
      worker_id: worker.worker_id,
      fencing_token: lease.fencing_token,
      org_id: run.org_id,
      state_version: run.state_version,
      sequence: (previous?.sequence ?? 0) + 1,
      ...body,
      created_at: clock(),
      checkpoint_digest: digest(body),
    });
  }

  async function commitCheckpoint({ run, job, attempt, lease, data, wake = null }) {
    const at = clock();
    let pair = transitionPair(run, job, 'checkpointing', at, 'checkpoint_requested');
    const document = checkpointDocument({
      run: pair.run,
      job: pair.job,
      attempt,
      lease,
      data,
      wake,
    });
    repository.commitCheckpoint(document, {
      now: clock(),
      expected_state_version: pair.run.state_version,
    });
    pair = {
      run: repository.readRun({ run_id: run.run_id, org_id: run.org_id }),
      job: repository.readJob({ job_id: job.job_id, org_id: job.org_id }),
    };
    emit(pair.run, pair.job, 'checkpoint.committed', {
      checkpoint_id: document.checkpoint_id,
      checkpoint_digest: document.checkpoint_digest,
      sequence: document.sequence,
    }, document.created_at);
    return { ...pair, checkpoint: document };
  }

  function createWake({ run, job, result, checkpoint, now }) {
    const wake = defineWakeCondition({
      wake_id: ids.next('wake'),
      run_id: run.run_id,
      job_id: job.job_id,
      org_id: run.org_id,
      kind: result.wake.kind,
      status: 'pending',
      available_at: result.wake.available_at ?? now,
      expires_at: result.wake.expires_at ?? null,
      correlation_key: result.wake.correlation_key ?? null,
      action_digest: result.wake.action_digest ?? null,
      dependency_run_id: result.wake.dependency_run_id ?? null,
      reason_code: result.reason_code ?? `waiting_${result.wake.kind}`,
      created_at: now,
      satisfied_at: null,
      payload_digest: result.wake.payload_digest ?? digest({
        checkpoint_id: checkpoint.checkpoint_id,
        wake: result.wake,
      }),
    });
    return repository.putWakeCondition(wake);
  }

  async function executeEffects({ result, run, job, attempt, lease }) {
    const receipts = [];
    for (const [index, effect] of (result.effects ?? []).entries()) {
      assertLease(lease);
      const request = {
        effect_id: effect.effect_id ?? ids.next('effect'),
        run_id: run.run_id,
        job_id: job.job_id,
        step_id: effect.step_id ?? run.active_step_id,
        attempt_id: attempt.attempt_id,
        lease_id: lease.lease_id,
        worker_id: worker.worker_id,
        fencing_token: lease.fencing_token,
        org_id: run.org_id,
        idempotency_key: effect.idempotency_key,
        action_digest: effect.action_digest ?? executionContentDigest(effect.input),
        adapter: effect.adapter,
        compensation_mode: effect.compensation_mode ?? 'unsupported',
        approval_evidence_digest: effect.approval_evidence_digest ?? null,
        policy_evidence_digest: effect.policy_evidence_digest ?? null,
        created_at: clock(),
      };
      emit(run, job, 'effect.proposed', {
        effect_id: request.effect_id,
        idempotency_key: request.idempotency_key,
        action_digest: request.action_digest,
        index,
      });
      emit(run, job, 'effect.admitted', {
        effect_id: request.effect_id,
        policy_evidence_digest: request.policy_evidence_digest,
        approval_evidence_digest: request.approval_evidence_digest,
      });
      emit(run, job, 'effect.executing', {
        effect_id: request.effect_id,
        attempt_id: attempt.attempt_id,
      });
      const execution = await executeIdempotentEffect({
        repository,
        request,
        input: effect.input,
        clock,
      });
      receipts.push(execution.receipt);
      emit(run, job, execution.ok ? 'effect.confirmed' : `effect.${execution.receipt.state}`, {
        effect_id: request.effect_id,
        idempotency_key: request.idempotency_key,
        replayed: execution.replayed,
        reason: execution.reason,
      });
      if (!execution.ok) return { ok: false, execution, receipts };
    }
    return { ok: true, receipts };
  }

  async function compensate({ run, job, attempt, lease, result }) {
    const effects = repository.listEffects({ run_id: run.run_id, org_id: run.org_id })
      .filter((receipt) => ['confirmed', 'uncertain'].includes(receipt.state))
      .reverse();
    invariant(effects.length <= configuredLimits.max_compensations, 'execution_compensation_limit', 'compensation limit exhausted', {});
    const adapters = new Map((result.compensators ?? []).map((entry) => [entry.effect_id, entry]));
    let allOk = true;
    for (const receipt of effects) {
      assertLease(lease);
      emit(run, job, 'compensation.requested', { effect_id: receipt.effect_id });
      const configured = adapters.get(receipt.effect_id);
      if (configured === undefined) {
        allOk = false;
        emit(run, job, 'compensation.failed', { effect_id: receipt.effect_id, reason: 'compensator_missing' });
        continue;
      }
      const outcome = await compensateEffect({
        repository,
        receipt,
        adapter: configured.adapter,
        input: configured.input,
        clock,
        lease_evidence: {
          attempt_id: attempt.attempt_id,
          lease_id: lease.lease_id,
          worker_id: worker.worker_id,
          fencing_token: lease.fencing_token,
          org_id: run.org_id,
        },
      });
      allOk = allOk && outcome.ok;
      emit(run, job, outcome.ok ? 'compensation.completed' : 'compensation.failed', {
        effect_id: receipt.effect_id,
        reason: outcome.reason,
      });
    }
    return { ok: allOk, count: effects.length };
  }

  async function finishTerminal({ kind, reason_code, run, job, attempt, lease, result }) {
    const at = clock();
    const target = kind === 'completed' ? 'completed' : kind === 'cancelled' ? 'cancelled' : 'failed';
    const pair = transitionPair(run, job, target, at, reason_code, {
      run: {
        completed_at: at,
        result_digest: result.output === undefined ? null : digest(result.output),
      },
    });
    repository.finishAttempt({
      attempt_id: attempt.attempt_id,
      org_id: run.org_id,
      state: target,
      reason_code,
      error_class: result.error_class ?? null,
      result_digest: result.output === undefined ? null : digest(result.output),
      finished_at: at,
    });
    const completion = defineCompletionRecord({
      completion_id: ids.next('completion'),
      run_id: run.run_id,
      job_id: job.job_id,
      org_id: run.org_id,
      state_version: pair.run.state_version,
      outcome: target,
      result_digest: result.output === undefined ? null : digest(result.output),
      completed_at: at,
    });
    repository.putCompletion(completion, {
      lease_id: lease.lease_id,
      worker_id: worker.worker_id,
      fencing_token: lease.fencing_token,
      now: at,
    });
    const releasedAt = clock();
    repository.releaseLease({
      lease_id: lease.lease_id,
      org_id: run.org_id,
      worker_id: worker.worker_id,
      fencing_token: lease.fencing_token,
      now: releasedAt,
      reason_code: target === 'completed' ? 'completed' : target,
    });
    emit(pair.run, pair.job, target === 'completed' ? 'execution.completed' : `execution.${target}`, {
      reason_code,
      completion_id: completion.completion_id,
    }, at);
    emit(pair.run, pair.job, 'lease.released', {
      lease_id: lease.lease_id,
      worker_id: worker.worker_id,
      reason_code: target,
    }, releasedAt);
    if (target === 'cancelled') {
      emit(pair.run, pair.job, 'cancellation.completed', { reason_code }, at);
    }
    return deepFreeze({ kind: target, run: pair.run, job: pair.job, completion, result });
  }

  async function finishDeadLetter({ reason_code, run, job, attempt, lease, result }) {
    const at = clock();
    const pair = transitionPair(run, job, 'dead_lettered', at, reason_code, {
      run: { completed_at: at },
    });
    repository.finishAttempt({
      attempt_id: attempt.attempt_id,
      org_id: run.org_id,
      state: 'dead_lettered',
      reason_code,
      error_class: result.error_class ?? null,
      result_digest: null,
      finished_at: at,
    });
    const checkpoint = repository.latestCheckpoint({ run_id: run.run_id, org_id: run.org_id });
    const effects = repository.listEffects({ run_id: run.run_id, org_id: run.org_id });
    const events = repository.eventsForRun({ run_id: run.run_id, org_id: run.org_id });
    const record = defineDeadLetterRecord({
      dead_letter_id: ids.next('dead_letter'),
      run_id: run.run_id,
      job_id: job.job_id,
      org_id: run.org_id,
      final_state: 'dead_lettered',
      attempts: pair.run.attempt_count,
      last_checkpoint_id: checkpoint?.checkpoint_id ?? null,
      last_error: result.detail ?? reason_code,
      reason_code,
      event_refs: events.slice(-20).map((event) => event.event_id),
      effect_uncertainty: effects.some((effect) => effect.state === 'uncertain'),
      compensation_status: effects.some((effect) => effect.state === 'compensated') ? 'partial_or_complete' : 'not_requested',
      recommended_action: 'inspect the last checkpoint and error classification before requeueing',
      created_at: at,
    });
    repository.putDeadLetter(record);
    const releasedAt = clock();
    repository.releaseLease({
      lease_id: lease.lease_id,
      org_id: run.org_id,
      worker_id: worker.worker_id,
      fencing_token: lease.fencing_token,
      now: releasedAt,
      reason_code: 'dead_lettered',
    });
    emit(pair.run, pair.job, 'job.dead_lettered', {
      dead_letter_id: record.dead_letter_id,
      reason_code,
    }, at);
    emit(pair.run, pair.job, 'lease.released', {
      lease_id: lease.lease_id,
      worker_id: worker.worker_id,
      reason_code: 'dead_lettered',
    }, releasedAt);
    return deepFreeze({ kind: 'dead_lettered', run: pair.run, job: pair.job, dead_letter: record });
  }

  async function pauseFor({ result, run, job, attempt, lease }) {
    const checked = await commitCheckpoint({
      run,
      job,
      attempt,
      lease,
      data: result.checkpoint ?? {},
      wake: result.wake,
    });
    const now = clock();
    const wake = createWake({
      run: checked.run,
      job: checked.job,
      result,
      checkpoint: checked.checkpoint,
      now,
    });
    const target = WAIT_STATE_BY_WAKE[wake.kind];
    const pair = transitionPair(checked.run, checked.job, target, now, result.reason_code ?? `waiting_${wake.kind}`, {
      run: { wake_id: wake.wake_id },
    });
    repository.finishAttempt({
      attempt_id: attempt.attempt_id,
      org_id: run.org_id,
      state: 'paused',
      reason_code: result.reason_code ?? `waiting_${wake.kind}`,
      error_class: null,
      result_digest: null,
      finished_at: now,
    });
    const releasedAt = clock();
    repository.releaseLease({
      lease_id: lease.lease_id,
      org_id: run.org_id,
      worker_id: worker.worker_id,
      fencing_token: lease.fencing_token,
      now: releasedAt,
      reason_code: 'paused',
    });
    const eventType = wake.kind === 'approval'
      ? 'approval.requested'
      : ['retry_backoff', 'rate_limit'].includes(wake.kind)
        ? 'retry.scheduled'
        : 'execution.paused';
    emit(pair.run, pair.job, eventType, {
      wake_id: wake.wake_id,
      kind: wake.kind,
      checkpoint_id: checked.checkpoint.checkpoint_id,
      action_digest: wake.action_digest,
    }, now);
    emit(pair.run, pair.job, 'lease.released', {
      lease_id: lease.lease_id,
      worker_id: worker.worker_id,
      reason_code: 'paused',
    }, releasedAt);
    return deepFreeze({ kind: 'paused', run: pair.run, job: pair.job, checkpoint: checked.checkpoint, wake });
  }

  async function scheduleRetry({ result, run, job, attempt, lease }) {
    const decision = decideRetry({
      error: { error_class: result.error_class, reason_code: result.reason_code },
      attempt_number: attempt.number,
      first_attempt_at: repository.listAttempts({ run_id: run.run_id, org_id: run.org_id })[0].started_at,
      now: clock(),
      deadline_at: job.deadline_at,
      policy: retryPolicy,
      randomness,
    });
    if (decision.decision !== 'retry') {
      return finishDeadLetter({
        reason_code: decision.reason_code,
        run,
        job,
        attempt,
        lease,
        result: { ...result, error_class: decision.error_class },
      });
    }
    return pauseFor({
      result: {
        ...result,
        kind: 'paused',
        reason_code: decision.reason_code,
        checkpoint: {
          ...(result.checkpoint ?? {}),
          retry_state: decision,
        },
        wake: {
          kind: result.error_class === 'retryable_rate_limit' ? 'rate_limit' : 'retry_backoff',
          available_at: decision.available_at,
          expires_at: job.deadline_at,
          payload_digest: digest(decision),
        },
      },
      run,
      job,
      attempt,
      lease,
    });
  }

  async function processClaim({ job, lease }) {
    let run = validateStored('run', repository.readRun({ run_id: job.run_id, org_id: job.org_id }), { at: 'worker.processClaim.readRun' });
    let currentJob = validateStored('job', repository.readJob({ job_id: job.job_id, org_id: job.org_id }), { at: 'worker.processClaim.readJob' });
    const startedAt = clock();
    ({ run, job: currentJob } = transitionPair(run, currentJob, 'running', startedAt, 'worker_started', {
      job: { attempt_count: currentJob.attempt_count + 1 },
      run: { attempt_count: run.attempt_count + 1 },
    }));
    const attempt = defineExecutionAttempt({
      attempt_id: ids.next('attempt'),
      run_id: run.run_id,
      job_id: currentJob.job_id,
      step_id: run.active_step_id,
      lease_id: lease.lease_id,
      worker_id: worker.worker_id,
      org_id: run.org_id,
      number: run.attempt_count,
      state: 'running',
      error_class: null,
      reason_code: null,
      started_at: startedAt,
      finished_at: null,
      result_digest: null,
    });
    repository.createAttempt(attempt);
    emit(run, currentJob, run.attempt_count > 1 ? 'retry.started' : 'execution.started', {
      attempt_id: attempt.attempt_id,
      worker_id: worker.worker_id,
      lease_id: lease.lease_id,
      fencing_token: lease.fencing_token,
    }, startedAt);

    const cancellation = repository.readCancellation({ run_id: run.run_id, org_id: run.org_id });
    if (cancellation !== null) {
      emit(run, currentJob, 'cancellation.requested', { cancellation_id: cancellation.cancellation_id });
      const pair = transitionPair(run, currentJob, 'cancelling', clock(), cancellation.reason_code);
      const compensation = await compensate({
        run: pair.run,
        job: pair.job,
        attempt,
        lease,
        result: { compensators },
      });
      const target = compensation.count > 0 && !compensation.ok ? 'failed' : 'cancelled';
      return finishTerminal({
        kind: target,
        reason_code: cancellation.reason_code,
        run: pair.run,
        job: pair.job,
        attempt,
        lease,
        result: { output: null, error_class: null },
      });
    }

    const checkpoint = validateStored(
      'checkpoint',
      repository.latestCheckpoint({ run_id: run.run_id, org_id: run.org_id }),
      { nullable: true, at: 'worker.processClaim.latestCheckpoint' },
    );
    let result;
    try {
      result = validateResult(await executor.execute({
        worker,
        job: currentJob,
        run,
        attempt,
        checkpoint,
        lease,
        controls: Object.freeze({
          heartbeat,
          renew: (duration_ms) => renew(lease, duration_ms),
          assertLease: () => assertLease(lease),
        }),
      }));
    } catch (error) {
      result = {
        kind: 'failed',
        reason_code: error?.code ?? 'executor_failed',
        error_class: error?.error_class ?? 'retryable_infrastructure',
        detail: String(redact(String(error?.message ?? error))).slice(0, 500),
      };
    }
    assertLease(lease);

    if (result.kind === 'paused') return pauseFor({ result, run, job: currentJob, attempt, lease });
    if (result.kind === 'retry') return scheduleRetry({ result, run, job: currentJob, attempt, lease });
    if (result.kind === 'failed') {
      if (String(result.error_class ?? '').startsWith('retryable_')) {
        return scheduleRetry({ result, run, job: currentJob, attempt, lease });
      }
      return finishTerminal({
        kind: 'failed',
        reason_code: result.reason_code ?? 'execution_failed',
        run,
        job: currentJob,
        attempt,
        lease,
        result,
      });
    }
    if (result.kind === 'cancelled') {
      const pair = transitionPair(run, currentJob, 'cancelling', clock(), result.reason_code ?? 'cancelled');
      return finishTerminal({
        kind: 'cancelled',
        reason_code: result.reason_code ?? 'cancelled',
        run: pair.run,
        job: pair.job,
        attempt,
        lease,
        result,
      });
    }
    if (result.kind === 'compensate') {
      const pair = transitionPair(run, currentJob, 'compensating', clock(), result.reason_code ?? 'compensation_required');
      const compensated = await compensate({
        run: pair.run,
        job: pair.job,
        attempt,
        lease,
        result,
      });
      return finishTerminal({
        kind: 'failed',
        reason_code: compensated.ok ? (result.reason_code ?? 'compensated_failure') : 'execution_compensation_failed',
        run: pair.run,
        job: pair.job,
        attempt,
        lease,
        result: { ...result, compensation: compensated },
      });
    }

    const effectOutcome = await executeEffects({ result, run, job: currentJob, attempt, lease });
    if (!effectOutcome.ok) {
      if (effectOutcome.execution.receipt.state === 'uncertain') {
        const uncertain = repository.listEffects({ run_id: run.run_id, org_id: run.org_id })
          .filter((receipt) => receipt.state === 'uncertain').length;
        if (uncertain > configuredLimits.max_uncertain_effects) {
          return finishTerminal({
            kind: 'failed',
            reason_code: 'execution_uncertain_effect_limit',
            run,
            job: currentJob,
            attempt,
            lease,
            result: { ...result, error_class: 'uncertain_external_effect' },
          });
        }
        return pauseFor({
          result: {
            kind: 'paused',
            reason_code: 'execution_effect_uncertain',
            checkpoint: {
              ...(result.checkpoint ?? {}),
              effect_receipts: effectOutcome.receipts.map((entry) => entry.effect_id),
            },
            wake: {
              kind: 'manual_hold',
              available_at: clock(),
              action_digest: effectOutcome.execution.receipt.action_digest,
            },
          },
          run,
          job: currentJob,
          attempt,
          lease,
        });
      }
      return scheduleRetry({
        result: {
          ...result,
          kind: 'retry',
          reason_code: effectOutcome.execution.reason,
          error_class: effectOutcome.execution.receipt.error_class ?? 'retryable_provider',
        },
        run,
        job: currentJob,
        attempt,
        lease,
      });
    }

    return finishTerminal({
      kind: 'completed',
      reason_code: result.reason_code ?? 'execution_completed',
      run,
      job: currentJob,
      attempt,
      lease,
      result: {
        ...result,
        checkpoint: {
          ...(result.checkpoint ?? {}),
          effect_receipts: effectOutcome.receipts.map((entry) => entry.effect_id),
        },
      },
    });
  }

  async function pollOnce({ org_id = worker.org_id } = {}) {
    invariant(org_id === worker.org_id, 'execution_tenant_violation', 'worker cannot poll another tenant partition', {});
    if (stopped) return deepFreeze({ status: 'stopped', claimed: false, result: null });
    heartbeat();
    const now = clock();
    const [job] = repository.listReady({
      org_id,
      capabilities: worker.capabilities,
      now,
      limit: 1,
    });
    if (job === undefined) return deepFreeze({ status: 'idle', claimed: false, result: null });
    validateStored('job', job, { at: 'worker.pollOnce.listReady' });
    const claimed = repository.claimLease({
      lease_id: ids.next('lease'),
      claim_id: ids.next('claim'),
      job_id: job.job_id,
      org_id,
      worker_id: worker.worker_id,
      now,
      expires_at: instantPlus(now, lease_duration_ms),
      max_expires_at: instantPlus(now, max_lease_duration_ms),
    });
    invariant(claimed !== null && typeof claimed === 'object' && typeof claimed.ok === 'boolean', 'contract_violation', 'repository returned a malformed lease claim result', {});
    if (!claimed.ok) return deepFreeze({ status: 'contended', claimed: false, result: claimed });
    validateStored('lease', claimed.lease, { at: 'worker.pollOnce.claimLease' });
    const claimedRun = validateStored('run', repository.readRun({ run_id: job.run_id, org_id }), { at: 'worker.pollOnce.readRun' });
    const claimedJob = validateStored('job', repository.readJob({ job_id: job.job_id, org_id }), { at: 'worker.pollOnce.readJob' });
    emit(
      claimedRun,
      claimedJob,
      'lease.claimed',
      {
        lease_id: claimed.lease.lease_id,
        worker_id: worker.worker_id,
        fencing_token: claimed.lease.fencing_token,
      },
      now,
    );
    const result = await processClaim({ job, lease: claimed.lease });
    return deepFreeze({ status: result.kind, claimed: true, lease: claimed.lease, result });
  }

  return Object.freeze({
    pollOnce,
    heartbeat,
    stop() { stopped = true; return deepFreeze({ stopped: true, worker_id: worker.worker_id }); },
    status() { return deepFreeze({ worker_id: worker.worker_id, stopped }); },
  });
}
