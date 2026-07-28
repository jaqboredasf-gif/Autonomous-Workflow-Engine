import { deepFreeze, digest, invariant, isInstant } from './kernel.mjs';
import { assertExecutionContract } from './contracts.mjs';

const WAITING_STATES = [
  'waiting', 'waiting_for_approval', 'waiting_for_event', 'waiting_until', 'retry_scheduled',
];

export function calculateNextRun(schedule, { after } = {}) {
  assertExecutionContract('recurring_schedule', schedule, { at: 'calculateNextRun' });
  invariant(isInstant(after), 'invalid_input', 'next-run calculation needs after', {});
  if (!schedule.enabled) return deepFreeze({ next_at: null, missed: 0, suppressed: true });
  const anchor = Date.parse(schedule.anchor_at);
  const cursor = Date.parse(after);
  const intervals = Math.max(0, Math.floor((cursor - anchor) / schedule.interval_ms) + 1);
  const nominalMissed = Math.max(0, intervals - 1);
  const missed = schedule.missed_run_policy === 'catch_up_bounded'
    ? Math.min(nominalMissed, schedule.max_catch_up)
    : nominalMissed;
  return deepFreeze({
    next_at: new Date(anchor + intervals * schedule.interval_ms).toISOString(),
    missed,
    suppressed: false,
    decision: schedule.missed_run_policy === 'skip'
      ? 'skip_missed'
      : schedule.missed_run_policy === 'run_once' ? 'coalesce_missed' : 'catch_up_bounded',
  });
}

export function createExecutionScheduler({ repository, clock, ids } = {}) {
  invariant(repository !== null && typeof repository?.listWakeConditions === 'function', 'invalid_input', 'scheduler needs an execution repository', {});
  invariant(typeof clock === 'function', 'invalid_input', 'scheduler needs an injected clock', {});
  invariant(ids !== null && typeof ids?.next === 'function', 'invalid_input', 'scheduler needs an injected identifier source', {});

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

  function makeReady(job, run, at, reason_code) {
    let currentJob = job;
    let currentRun = run;
    if (currentJob.state !== 'ready') {
      currentJob = repository.transitionJob({
        job_id: currentJob.job_id,
        org_id: currentJob.org_id,
        to: 'ready',
        expected_version: currentJob.state_version,
        occurred_at: at,
        reason_code,
        patch: { available_at: at },
      });
    }
    if (currentRun.state !== 'ready') {
      currentRun = repository.transitionRun({
        run_id: currentRun.run_id,
        org_id: currentRun.org_id,
        to: 'ready',
        expected_version: currentRun.state_version,
        occurred_at: at,
        reason_code,
        patch: { wake_id: null },
      });
    }
    emit(currentRun, currentJob, 'job.ready', { reason_code }, at);
    return { job: currentJob, run: currentRun };
  }

  function tick({ org_id, now = clock() } = {}) {
    invariant(typeof org_id === 'string' && org_id.length > 0, 'execution_tenant_required', 'scheduler tick needs org_id', {});
    invariant(isInstant(now), 'invalid_input', 'scheduler tick needs an instant', {});
    const ready = [];
    const expired = [];

    for (const job of repository.listJobs({ org_id, states: ['scheduled', 'ready'] })) {
      if (job.deadline_at !== null && Date.parse(job.deadline_at) <= Date.parse(now)) {
        const run = repository.readRun({ run_id: job.run_id, org_id });
        const failedJob = repository.transitionJob({
          job_id: job.job_id, org_id, to: 'failed', expected_version: job.state_version,
          occurred_at: now, reason_code: 'deadline_exhausted',
        });
        const failedRun = repository.transitionRun({
          run_id: run.run_id, org_id, to: 'failed', expected_version: run.state_version,
          occurred_at: now, reason_code: 'deadline_exhausted',
        });
        emit(failedRun, failedJob, 'execution.failed', { reason_code: 'deadline_exhausted' }, now);
        expired.push(job.job_id);
        continue;
      }
      if (job.state === 'scheduled' && Date.parse(job.available_at) <= Date.parse(now)) {
        const run = repository.readRun({ run_id: job.run_id, org_id });
        ready.push(makeReady(job, run, now, 'scheduled_time_reached'));
      }
    }

    for (const wake of repository.listWakeConditions({ org_id })) {
      if (wake.status !== 'pending' && wake.status !== 'satisfied') continue;
      const run = repository.readRun({ run_id: wake.run_id, org_id });
      const job = repository.readJob({ job_id: wake.job_id, org_id });
      if (!WAITING_STATES.includes(run.state) || !WAITING_STATES.includes(job.state)) continue;
      if (wake.expires_at !== null && Date.parse(wake.expires_at) <= Date.parse(now) && wake.status === 'pending') {
        const failedJob = repository.transitionJob({
          job_id: job.job_id, org_id, to: 'failed', expected_version: job.state_version,
          occurred_at: now, reason_code: 'wake_expired',
        });
        const failedRun = repository.transitionRun({
          run_id: run.run_id, org_id, to: 'failed', expected_version: run.state_version,
          occurred_at: now, reason_code: 'wake_expired',
        });
        repository.cancelWakeCondition({ wake_id: wake.wake_id, org_id, occurred_at: now });
        emit(failedRun, failedJob, 'execution.failed', { reason_code: 'wake_expired', wake_id: wake.wake_id }, now);
        expired.push(wake.wake_id);
        continue;
      }
      const dueByTime = ['scheduled_time', 'retry_backoff', 'rate_limit'].includes(wake.kind)
        && Date.parse(wake.available_at) <= Date.parse(now);
      if (wake.status === 'satisfied' || dueByTime) {
        if (wake.status === 'pending') {
          repository.satisfyWakeCondition({
            wake_id: wake.wake_id,
            org_id,
            occurred_at: now,
            payload_digest: wake.payload_digest ?? digest({ wake_id: wake.wake_id, now }),
          });
        }
        const resumed = makeReady(job, run, now, `wake_${wake.kind}`);
        emit(resumed.run, resumed.job, 'execution.resumed', {
          wake_id: wake.wake_id,
          kind: wake.kind,
        }, now);
        ready.push(resumed);
      }
    }
    return deepFreeze({ schema: 'awe.scheduler_tick/v1', org_id, now, ready_count: ready.length, expired_count: expired.length, ready, expired });
  }

  return Object.freeze({ tick });
}
