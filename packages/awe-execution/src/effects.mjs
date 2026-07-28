import { deepFreeze, digest, invariant, isInstant, redact } from './kernel.mjs';
import {
  COMPENSATION_MODES,
  defineEffectReceipt,
} from './contracts.mjs';

export function defineEffectAdapter(adapter = {}) {
  invariant(adapter !== null && typeof adapter === 'object' && !Array.isArray(adapter), 'invalid_input', 'effect adapter must be an object', {});
  invariant(typeof adapter.name === 'string' && adapter.name.length > 0, 'invalid_input', 'effect adapter needs a name', {});
  invariant(typeof adapter.execute === 'function', 'invalid_input', 'effect adapter needs execute()', {});
  invariant(adapter.compensate === undefined || typeof adapter.compensate === 'function', 'invalid_input', 'effect adapter compensate must be a function', {});
  return Object.freeze({
    name: adapter.name,
    execute: adapter.execute.bind(adapter),
    compensate: adapter.compensate?.bind(adapter) ?? null,
  });
}

function receiptFor(request, state, at, patch = {}) {
  return defineEffectReceipt({
    effect_id: request.effect_id,
    run_id: request.run_id,
    job_id: request.job_id,
    step_id: request.step_id,
    attempt_id: request.attempt_id,
    lease_id: request.lease_id,
    worker_id: request.worker_id,
    fencing_token: request.fencing_token,
    org_id: request.org_id,
    idempotency_key: request.idempotency_key,
    action_digest: request.action_digest,
    state,
    adapter_ref: request.adapter.name,
    result_digest: null,
    error_class: null,
    compensation_mode: request.compensation_mode,
    approval_evidence_digest: request.approval_evidence_digest,
    policy_evidence_digest: request.policy_evidence_digest,
    created_at: request.created_at,
    updated_at: at,
    ...patch,
  });
}

function validateRequest(request) {
  invariant(request !== null && typeof request === 'object' && !Array.isArray(request), 'invalid_input', 'effect execution needs a request', {});
  for (const key of [
    'effect_id', 'run_id', 'job_id', 'step_id', 'attempt_id', 'lease_id',
    'worker_id', 'org_id', 'idempotency_key', 'action_digest', 'adapter',
    'compensation_mode', 'created_at',
  ]) invariant(request[key] !== undefined && request[key] !== null, 'invalid_input', `effect request needs ${key}`, {});
  invariant(COMPENSATION_MODES.includes(request.compensation_mode), 'invalid_input', 'effect compensation mode is invalid', {});
  invariant(isInstant(request.created_at), 'invalid_input', 'effect created_at must be an instant', {});
}

export async function executeIdempotentEffect({
  repository,
  request,
  input,
  clock,
} = {}) {
  invariant(repository !== null && typeof repository?.putEffectReceipt === 'function', 'invalid_input', 'effect execution needs a repository', {});
  invariant(typeof clock === 'function', 'invalid_input', 'effect execution needs an injected clock', {});
  validateRequest(request);
  const adapter = defineEffectAdapter(request.adapter);
  const existing = repository.readEffectByKey({
    org_id: request.org_id,
    idempotency_key: request.idempotency_key,
  });
  if (existing !== null) {
    if (existing.action_digest !== request.action_digest) {
      return deepFreeze({ ok: false, replayed: false, reason: 'execution_idempotency_conflict', receipt: existing, result: null });
    }
    if (existing.state === 'confirmed') {
      return deepFreeze({ ok: true, replayed: true, reason: null, receipt: existing, result: null });
    }
    if (existing.state === 'uncertain') {
      return deepFreeze({ ok: false, replayed: true, reason: 'execution_effect_uncertain', receipt: existing, result: null });
    }
    if (existing.state === 'refused') {
      return deepFreeze({ ok: false, replayed: true, reason: 'execution_effect_refused', receipt: existing, result: null });
    }
  }

  const evidence = { now: clock() };
  let receipt = receiptFor({ ...request, adapter }, 'proposed', evidence.now);
  repository.putEffectReceipt(receipt, evidence);
  receipt = receiptFor({ ...request, adapter }, 'admitted', clock());
  repository.putEffectReceipt(receipt, { now: receipt.updated_at });
  receipt = receiptFor({ ...request, adapter }, 'executing', clock());
  repository.putEffectReceipt(receipt, { now: receipt.updated_at });

  let response;
  try {
    response = await adapter.execute({
      input,
      idempotency_key: request.idempotency_key,
      action_digest: request.action_digest,
      org_id: request.org_id,
      attempt_id: request.attempt_id,
    });
  } catch (error) {
    response = {
      status: error?.effect_uncertain === true ? 'uncertain' : 'refused',
      error_class: error?.effect_uncertain === true ? 'uncertain_external_effect' : 'retryable_provider',
      error: String(redact(String(error?.message ?? error))).slice(0, 500),
    };
  }
  invariant(response !== null && typeof response === 'object' && !Array.isArray(response), 'contract_violation', 'effect adapter returned a malformed result', {});
  invariant(['confirmed', 'uncertain', 'refused'].includes(response.status), 'contract_violation', 'effect adapter status must be confirmed, uncertain or refused', {});
  const finishedAt = clock();
  receipt = receiptFor({ ...request, adapter }, response.status, finishedAt, {
    result_digest: response.result === undefined || response.result === null ? null : digest(response.result),
    error_class: response.status === 'confirmed' ? null : (response.error_class ?? 'retryable_provider'),
  });
  // This commit re-verifies lease ownership and fencing after the adapter call.
  // A stale worker may have caused an uncertain provider outcome, but it cannot
  // claim confirmation after another worker recovered the job.
  repository.putEffectReceipt(receipt, { now: finishedAt });
  return deepFreeze({
    ok: response.status === 'confirmed',
    replayed: false,
    reason: response.status === 'confirmed' ? null : `execution_effect_${response.status}`,
    receipt,
    result: response.result ?? null,
  });
}

export async function compensateEffect({
  repository,
  receipt,
  adapter: rawAdapter,
  input,
  clock,
  lease_evidence = null,
} = {}) {
  invariant(receipt?.state === 'confirmed' || receipt?.state === 'uncertain', 'invalid_input', 'only confirmed or uncertain effects can enter compensation', {});
  invariant(receipt.compensation_mode !== 'unsupported', 'execution_compensation_unsupported', 'effect declares compensation unsupported', {});
  invariant(receipt.compensation_mode !== 'manual_only', 'execution_compensation_manual', 'effect requires manual compensation', {});
  const adapter = defineEffectAdapter(rawAdapter);
  invariant(adapter.compensate !== null, 'execution_compensation_unsupported', `adapter '${adapter.name}' has no compensator`, {});
  if (lease_evidence !== null) {
    invariant(
      lease_evidence.org_id === receipt.org_id,
      'execution_tenant_violation',
      'compensation lease evidence belongs to another tenant',
      {},
    );
  }
  const requestedAt = clock();
  const requested = defineEffectReceipt({
    ...receipt,
    ...(lease_evidence ?? {}),
    state: 'compensation_requested',
    updated_at: requestedAt,
    document_digest: undefined,
  });
  repository.putEffectReceipt(requested, { now: requestedAt });
  let result;
  try {
    result = await adapter.compensate({
      input,
      effect_id: receipt.effect_id,
      idempotency_key: `compensate:${receipt.idempotency_key}`,
      org_id: receipt.org_id,
    });
  } catch (error) {
    return deepFreeze({
      ok: false,
      reason: 'execution_compensation_failed',
      error: String(redact(String(error?.message ?? error))).slice(0, 500),
      receipt: requested,
    });
  }
  const completedAt = clock();
  const completed = defineEffectReceipt({
    ...requested,
    state: 'compensated',
    result_digest: result === undefined || result === null ? null : digest(result),
    updated_at: completedAt,
    document_digest: undefined,
  });
  repository.putEffectReceipt(completed, { now: completedAt });
  return deepFreeze({ ok: true, reason: null, result, receipt: completed });
}
