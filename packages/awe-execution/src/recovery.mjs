import { deepFreeze, digest, invariant, isInstant } from './kernel.mjs';
import { defineDeadLetterRecord, defineRecoveryRequest } from './contracts.mjs';
import { assertCompatibleRunJob, TERMINAL_EXECUTION_STATES } from './state-machine.mjs';

export function createRecoveryController({
  repository,
  clock,
  ids,
  max_recoveries = 3,
  stuck_after_ms = 300000,
} = {}) {
  invariant(repository !== null && typeof repository?.listExpiredLeases === 'function', 'invalid_input', 'recovery controller needs a repository', {});
  invariant(typeof clock === 'function', 'invalid_input', 'recovery controller needs an injected clock', {});
  invariant(ids !== null && typeof ids?.next === 'function', 'invalid_input', 'recovery controller needs an identifier source', {});
  invariant(Number.isInteger(max_recoveries) && max_recoveries >= 0, 'invalid_input', 'max_recoveries must be non-negative', {});
  invariant(Number.isInteger(stuck_after_ms) && stuck_after_ms >= 0, 'invalid_input', 'stuck_after_ms must be non-negative', {});

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

  function transitionPair(run, job, to, at, reason_code, runPatch = {}) {
    const nextJob = repository.transitionJob({
      job_id: job.job_id,
      org_id: job.org_id,
      to,
      expected_version: job.state_version,
      occurred_at: at,
      reason_code,
    });
    const nextRun = repository.transitionRun({
      run_id: run.run_id,
      org_id: run.org_id,
      to,
      expected_version: run.state_version,
      occurred_at: at,
      reason_code,
      patch: runPatch,
    });
    return { run: nextRun, job: nextJob };
  }

  function deadLetter(run, job, reason_code, at, detail) {
    let pair = { run, job };
    if (!['recovering', 'retry_scheduled', 'ready', 'compensating', 'cancelling'].includes(run.state)) {
      pair = transitionPair(run, job, 'recovering', at, reason_code, {
        recovery_count: run.recovery_count + 1,
      });
    }
    pair = transitionPair(pair.run, pair.job, 'dead_lettered', at, reason_code);
    const attempts = repository.listAttempts({ run_id: run.run_id, org_id: run.org_id });
    const checkpoint = repository.latestCheckpoint({ run_id: run.run_id, org_id: run.org_id });
    const effects = repository.listEffects({ run_id: run.run_id, org_id: run.org_id });
    const events = repository.eventsForRun({ run_id: run.run_id, org_id: run.org_id });
    const record = defineDeadLetterRecord({
      dead_letter_id: ids.next('dead_letter'),
      run_id: run.run_id,
      job_id: job.job_id,
      org_id: run.org_id,
      final_state: 'dead_lettered',
      attempts: attempts.length,
      last_checkpoint_id: checkpoint?.checkpoint_id ?? null,
      last_error: detail,
      reason_code,
      event_refs: events.slice(-20).map((event) => event.event_id),
      effect_uncertainty: effects.some((effect) => effect.state === 'uncertain'),
      compensation_status: effects.some((effect) => effect.state === 'compensation_requested')
        ? 'incomplete'
        : effects.some((effect) => effect.state === 'compensated') ? 'partial_or_complete' : 'not_requested',
      recommended_action: reason_code === 'execution_state_corrupt'
        ? 'inspect immutable history; do not auto-repair'
        : 'review the last checkpoint and retry only after resolving the recorded reason',
      created_at: at,
    });
    repository.putDeadLetter(record);
    emit(pair.run, pair.job, 'job.dead_lettered', {
      dead_letter_id: record.dead_letter_id,
      reason_code,
    }, at);
    return record;
  }

  function recoverExpiredLease(lease, at) {
    const run = repository.readRun({ run_id: lease.run_id, org_id: lease.org_id });
    const job = repository.readJob({ job_id: lease.job_id, org_id: lease.org_id });
    try {
      assertCompatibleRunJob(run, job);
    } catch (error) {
      return { status: 'dead_lettered', record: deadLetter(run, job, 'execution_state_corrupt', at, String(error.message)) };
    }
    if (TERMINAL_EXECUTION_STATES.includes(run.state)) {
      repository.expireLease({ lease_id: lease.lease_id, org_id: lease.org_id, now: at, reason_code: 'terminal_lease_cleanup' });
      return { status: 'released_terminal', run_id: run.run_id };
    }
    repository.expireLease({ lease_id: lease.lease_id, org_id: lease.org_id, now: at });
    emit(run, job, 'lease.lost', {
      lease_id: lease.lease_id,
      worker_id: lease.worker_id,
      fencing_token: lease.fencing_token,
      reason_code: 'lease_expired',
    }, at);
    if (run.recovery_count >= max_recoveries) {
      return { status: 'dead_lettered', record: deadLetter(run, job, 'recovery_limit_exhausted', at, 'maximum recovery count reached') };
    }
    const request = defineRecoveryRequest({
      recovery_id: ids.next('recovery'),
      run_id: run.run_id,
      job_id: job.job_id,
      lease_id: lease.lease_id,
      org_id: run.org_id,
      reason_code: 'lease_expired',
      requested_at: at,
      status: 'started',
    });
    emit(run, job, 'recovery.started', {
      recovery_id: request.recovery_id,
      lease_id: lease.lease_id,
    }, at);
    let pair = transitionPair(run, job, 'recovering', at, 'lease_expired', {
      recovery_count: run.recovery_count + 1,
    });
    pair = transitionPair(pair.run, pair.job, 'ready', at, 'recovery_completed');
    emit(pair.run, pair.job, 'recovery.completed', {
      recovery_id: request.recovery_id,
      checkpoint_id: pair.run.checkpoint_id,
      recovery_count: pair.run.recovery_count,
    }, at);
    return { status: 'recovered', request, ...pair };
  }

  function sweep({ org_id, now = clock() } = {}) {
    invariant(typeof org_id === 'string' && org_id.length > 0, 'execution_tenant_required', 'recovery sweep needs org_id', {});
    invariant(isInstant(now), 'invalid_input', 'recovery sweep needs now', {});
    const decisions = [];
    for (const lease of repository.listExpiredLeases({ org_id, now })) {
      decisions.push(recoverExpiredLease(lease, now));
    }

    for (const run of repository.listRuns({ org_id, states: ['compensating', 'cancelling'] })) {
      if (Date.parse(now) - Date.parse(run.updated_at) < stuck_after_ms) continue;
      const job = repository.readJob({ job_id: run.job_id, org_id });
      decisions.push({
        status: 'dead_lettered',
        record: deadLetter(run, job, 'stuck_compensation', now, `state '${run.state}' exceeded ${stuck_after_ms}ms`),
      });
    }

    // A waiting record without a wake is corruption, not a missed scheduling
    // decision. It is surfaced for operator review rather than silently fixed.
    for (const run of repository.listRuns({
      org_id,
      states: ['waiting', 'waiting_for_approval', 'waiting_for_event', 'waiting_until', 'retry_scheduled'],
    })) {
      if (run.wake_id !== null && repository.readWakeCondition({ wake_id: run.wake_id, org_id }) !== null) continue;
      const job = repository.readJob({ job_id: run.job_id, org_id });
      decisions.push({
        status: 'dead_lettered',
        record: deadLetter(run, job, 'execution_state_corrupt', now, 'waiting run has no durable wake condition'),
      });
    }
    return deepFreeze({
      schema: 'awe.recovery_sweep/v1',
      org_id,
      now,
      decision_count: decisions.length,
      decisions,
      sweep_digest: digest(decisions),
    });
  }

  return Object.freeze({ sweep });
}
