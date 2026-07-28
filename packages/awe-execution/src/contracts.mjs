import {
  canonicalClone, deepFreeze, digest, invariant, isInstant, isPlainObject, redact,
} from './kernel.mjs';

export const EXECUTION_ENVIRONMENTS = ['TEST', 'STAGING', 'LIVE'];
export const PRIORITY_CLASSES = ['background', 'normal', 'urgent', 'critical'];
export const EXECUTION_KINDS = ['workflow', 'agent'];
export const WAKE_KINDS = [
  'scheduled_time', 'approval', 'external_event', 'manual_hold',
  'policy_review', 'retry_backoff', 'dependency', 'rate_limit',
];
export const EFFECT_STATES = [
  'proposed', 'admitted', 'executing', 'confirmed', 'refused', 'uncertain',
  'compensation_requested', 'compensated',
];
export const COMPENSATION_MODES = ['supported', 'unsupported', 'manual_only', 'conditional'];
export const ERROR_CLASSES = [
  'retryable_infrastructure',
  'retryable_provider',
  'retryable_rate_limit',
  'retryable_timeout',
  'non_retryable_validation',
  'non_retryable_authorization',
  'non_retryable_policy',
  'non_retryable_tenant',
  'uncertain_external_effect',
  'compensation_required',
];
export const EXECUTION_RESULT_KINDS = [
  'completed', 'paused', 'retry', 'failed', 'cancelled', 'compensate',
];
export const DURABLE_EXECUTION_REASONS = [
  'execution_capability_mismatch',
  'execution_checkpoint_limit',
  'execution_compensation_failed',
  'execution_compensation_manual',
  'execution_compensation_unsupported',
  'execution_effect_refused',
  'execution_effect_uncertain',
  'execution_fencing_token_stale',
  'execution_idempotency_conflict',
  'execution_lease_contended',
  'execution_lease_expired',
  'execution_lease_lost',
  'execution_replay_identity_mismatch',
  'execution_state_corrupt',
  'execution_tenant_required',
  'execution_tenant_violation',
  'execution_uncertain_effect_limit',
  'recovery_limit_exhausted',
  'retry_attempt_limit',
  'retry_deadline_exhausted',
  'retry_elapsed_limit',
  'stuck_compensation',
  'wake_expired',
];

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DIGEST = /^[a-f0-9]{16,128}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

function closed(value, allowed, label, code = 'invalid_input') {
  invariant(isPlainObject(value), code, `${label} must be a plain object`, {});
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  invariant(unknown.length === 0, code, `${label} contains unknown keys: ${unknown.sort().join(', ')}`, {
    unknown: unknown.sort(),
    allowed,
  });
}

function required(value, names, label, code = 'invalid_input') {
  for (const name of names) {
    invariant(Object.prototype.hasOwnProperty.call(value, name), code, `${label} is missing '${name}'`, {});
  }
}

function opaque(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  invariant(typeof value === 'string' && OPAQUE_ID.test(value), 'invalid_input', `${label} must be an opaque identifier`, {});
  return value;
}

function instant(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  invariant(isInstant(value), 'invalid_input', `${label} must be an ISO-8601 instant`, {});
  return value;
}

function integer(value, label, { min = 0 } = {}) {
  invariant(Number.isInteger(value) && value >= min, 'invalid_input', `${label} must be an integer >= ${min}`, {});
  return value;
}

function oneOf(value, allowed, label) {
  invariant(allowed.includes(value), 'invalid_input', `${label} must be one of ${allowed.join(', ')}`, {});
  return value;
}

function strings(value, label, { unique = true } = {}) {
  invariant(Array.isArray(value), 'invalid_input', `${label} must be an array`, {});
  const normalized = value.map((entry, index) => opaque(entry, `${label}[${index}]`));
  if (unique) invariant(new Set(normalized).size === normalized.length, 'invalid_input', `${label} must not contain duplicates`, {});
  return normalized;
}

function contentDigest(value, label) {
  invariant(typeof value === 'string' && DIGEST.test(value), 'invalid_input', `${label} must be a lowercase hex digest`, {});
  return value;
}

const DEFINITIONS = Object.freeze({
  job: {
    schema: 'awe.execution_job/v1',
    keys: [
      'schema', 'job_id', 'run_id', 'org_id', 'environment', 'kind', 'state',
      'workflow_id', 'workflow_version', 'agent_id', 'agent_version',
      'priority_class', 'required_capabilities', 'available_at', 'deadline_at',
      'attempt_count', 'max_attempts', 'state_version', 'idempotency_key',
      'payload_digest', 'trace_id', 'correlation_id', 'causation_id',
      'created_at', 'updated_at', 'terminal_reason', 'metadata', 'document_digest',
    ],
    required: [
      'job_id', 'run_id', 'org_id', 'environment', 'kind', 'state',
      'priority_class', 'required_capabilities', 'available_at', 'deadline_at',
      'attempt_count', 'max_attempts', 'state_version', 'idempotency_key',
      'payload_digest', 'trace_id', 'correlation_id', 'causation_id',
      'created_at', 'updated_at', 'terminal_reason', 'metadata',
    ],
  },
  run: {
    schema: 'awe.execution_run/v1',
    keys: [
      'schema', 'run_id', 'job_id', 'org_id', 'environment', 'kind', 'state',
      'workflow_id', 'workflow_version', 'agent_id', 'agent_version',
      'active_step_id', 'checkpoint_id', 'wake_id', 'state_version',
      'attempt_count', 'recovery_count', 'compensation_count', 'started_at',
      'deadline_at', 'completed_at', 'result_digest', 'terminal_reason',
      'trace_id', 'correlation_id', 'causation_id', 'created_at', 'updated_at',
      'metadata', 'document_digest',
    ],
    required: [
      'run_id', 'job_id', 'org_id', 'environment', 'kind', 'state',
      'active_step_id', 'checkpoint_id', 'wake_id', 'state_version',
      'attempt_count', 'recovery_count', 'compensation_count', 'started_at',
      'deadline_at', 'completed_at', 'result_digest', 'terminal_reason',
      'trace_id', 'correlation_id', 'causation_id', 'created_at', 'updated_at', 'metadata',
    ],
  },
  step: {
    schema: 'awe.execution_step/v1',
    keys: [
      'schema', 'step_id', 'run_id', 'job_id', 'org_id', 'state', 'state_version',
      'sequence', 'name', 'kind', 'attempt_count', 'max_attempts',
      'idempotency_key', 'input_digest', 'output_digest', 'compensation',
      'created_at', 'updated_at', 'document_digest',
    ],
    required: [
      'step_id', 'run_id', 'job_id', 'org_id', 'state', 'state_version',
      'sequence', 'name', 'kind', 'attempt_count', 'max_attempts',
      'idempotency_key', 'input_digest', 'output_digest', 'compensation',
      'created_at', 'updated_at',
    ],
  },
  attempt: {
    schema: 'awe.execution_attempt/v1',
    keys: [
      'schema', 'attempt_id', 'run_id', 'job_id', 'step_id', 'lease_id',
      'worker_id', 'org_id', 'number', 'state', 'error_class', 'reason_code',
      'started_at', 'finished_at', 'result_digest', 'document_digest',
    ],
    required: [
      'attempt_id', 'run_id', 'job_id', 'step_id', 'lease_id', 'worker_id',
      'org_id', 'number', 'state', 'error_class', 'reason_code',
      'started_at', 'finished_at', 'result_digest',
    ],
  },
  worker_capability: {
    schema: 'awe.worker_capability/v1',
    keys: ['schema', 'capability_id', 'name', 'version', 'document_digest'],
    required: ['capability_id', 'name', 'version'],
  },
  worker: {
    schema: 'awe.worker/v1',
    keys: [
      'schema', 'worker_id', 'org_id', 'environment', 'capabilities',
      'max_concurrency', 'status', 'registered_at', 'document_digest',
    ],
    required: [
      'worker_id', 'org_id', 'environment', 'capabilities',
      'max_concurrency', 'status', 'registered_at',
    ],
  },
  worker_heartbeat: {
    schema: 'awe.worker_heartbeat/v1',
    keys: ['schema', 'heartbeat_id', 'worker_id', 'org_id', 'active_lease_ids', 'occurred_at', 'document_digest'],
    required: ['heartbeat_id', 'worker_id', 'org_id', 'active_lease_ids', 'occurred_at'],
  },
  lease: {
    schema: 'awe.execution_lease/v1',
    keys: [
      'schema', 'lease_id', 'job_id', 'run_id', 'org_id', 'worker_id',
      'fencing_token', 'status', 'claimed_at', 'expires_at', 'max_expires_at',
      'renewal_count', 'released_at', 'document_digest',
    ],
    required: [
      'lease_id', 'job_id', 'run_id', 'org_id', 'worker_id', 'fencing_token',
      'status', 'claimed_at', 'expires_at', 'max_expires_at', 'renewal_count', 'released_at',
    ],
  },
  lease_claim: {
    schema: 'awe.lease_claim/v1',
    keys: [
      'schema', 'claim_id', 'lease_id', 'job_id', 'run_id', 'org_id',
      'worker_id', 'fencing_token', 'claimed_at', 'document_digest',
    ],
    required: ['claim_id', 'lease_id', 'job_id', 'run_id', 'org_id', 'worker_id', 'fencing_token', 'claimed_at'],
  },
  lease_renewal: {
    schema: 'awe.lease_renewal/v1',
    keys: ['schema', 'renewal_id', 'lease_id', 'worker_id', 'org_id', 'fencing_token', 'previous_expires_at', 'expires_at', 'renewed_at', 'document_digest'],
    required: ['renewal_id', 'lease_id', 'worker_id', 'org_id', 'fencing_token', 'previous_expires_at', 'expires_at', 'renewed_at'],
  },
  lease_release: {
    schema: 'awe.lease_release/v1',
    keys: ['schema', 'release_id', 'lease_id', 'worker_id', 'org_id', 'fencing_token', 'reason_code', 'released_at', 'document_digest'],
    required: ['release_id', 'lease_id', 'worker_id', 'org_id', 'fencing_token', 'reason_code', 'released_at'],
  },
  lease_expiration: {
    schema: 'awe.lease_expiration/v1',
    keys: ['schema', 'expiration_id', 'lease_id', 'worker_id', 'org_id', 'fencing_token', 'expired_at', 'reason_code', 'document_digest'],
    required: ['expiration_id', 'lease_id', 'worker_id', 'org_id', 'fencing_token', 'expired_at', 'reason_code'],
  },
  checkpoint: {
    schema: 'awe.execution_checkpoint/v1',
    keys: [
      'schema', 'checkpoint_id', 'run_id', 'job_id', 'step_id', 'attempt_id',
      'lease_id', 'worker_id', 'fencing_token', 'org_id', 'state_version',
      'sequence', 'workflow_state', 'agent_loop_state', 'completed_steps',
      'pending_step', 'context_snapshot_ref', 'memory_snapshot_refs',
      'transcript_position', 'tool_receipts', 'effect_receipts',
      'policy_decisions', 'approval_requests', 'retry_state',
      'compensation_stack', 'wake_condition', 'runtime_versions',
      'content_digests', 'created_at', 'checkpoint_digest', 'document_digest',
    ],
    required: [
      'checkpoint_id', 'run_id', 'job_id', 'step_id', 'attempt_id',
      'lease_id', 'worker_id', 'fencing_token', 'org_id', 'state_version',
      'sequence', 'workflow_state', 'agent_loop_state', 'completed_steps',
      'pending_step', 'context_snapshot_ref', 'memory_snapshot_refs',
      'transcript_position', 'tool_receipts', 'effect_receipts',
      'policy_decisions', 'approval_requests', 'retry_state',
      'compensation_stack', 'wake_condition', 'runtime_versions',
      'content_digests', 'created_at', 'checkpoint_digest',
    ],
  },
  wake_condition: {
    schema: 'awe.wake_condition/v1',
    keys: [
      'schema', 'wake_id', 'run_id', 'job_id', 'org_id', 'kind', 'status',
      'available_at', 'expires_at', 'correlation_key', 'action_digest',
      'dependency_run_id', 'reason_code', 'created_at', 'satisfied_at',
      'payload_digest', 'document_digest',
    ],
    required: [
      'wake_id', 'run_id', 'job_id', 'org_id', 'kind', 'status',
      'available_at', 'expires_at', 'correlation_key', 'action_digest',
      'dependency_run_id', 'reason_code', 'created_at', 'satisfied_at', 'payload_digest',
    ],
  },
  scheduled_wakeup: {
    schema: 'awe.scheduled_wakeup/v1',
    keys: ['schema', 'schedule_id', 'wake_id', 'run_id', 'job_id', 'org_id', 'available_at', 'missed_run_policy', 'created_at', 'document_digest'],
    required: ['schedule_id', 'wake_id', 'run_id', 'job_id', 'org_id', 'available_at', 'missed_run_policy', 'created_at'],
  },
  recurring_schedule: {
    schema: 'awe.recurring_schedule/v1',
    keys: [
      'schema', 'schedule_id', 'org_id', 'anchor_at', 'interval_ms',
      'timezone', 'missed_run_policy', 'max_catch_up', 'enabled',
      'next_at', 'created_at', 'document_digest',
    ],
    required: [
      'schedule_id', 'org_id', 'anchor_at', 'interval_ms', 'timezone',
      'missed_run_policy', 'max_catch_up', 'enabled', 'next_at', 'created_at',
    ],
  },
  approval_wakeup: {
    schema: 'awe.approval_wakeup/v1',
    keys: ['schema', 'approval_id', 'wake_id', 'run_id', 'job_id', 'org_id', 'action_digest', 'decision', 'actor', 'principal', 'principal_roles', 'occurred_at', 'document_digest'],
    required: ['approval_id', 'wake_id', 'run_id', 'job_id', 'org_id', 'action_digest', 'decision', 'actor', 'principal', 'principal_roles', 'occurred_at'],
  },
  external_event_wakeup: {
    schema: 'awe.external_event_wakeup/v1',
    keys: ['schema', 'external_event_id', 'wake_id', 'run_id', 'job_id', 'org_id', 'correlation_key', 'payload_digest', 'occurred_at', 'document_digest'],
    required: ['external_event_id', 'wake_id', 'run_id', 'job_id', 'org_id', 'correlation_key', 'payload_digest', 'occurred_at'],
  },
  retry_schedule: {
    schema: 'awe.retry_schedule/v1',
    keys: ['schema', 'retry_id', 'run_id', 'job_id', 'step_id', 'attempt_id', 'org_id', 'error_class', 'reason_code', 'attempt_number', 'available_at', 'deadline_at', 'delay_ms', 'created_at', 'document_digest'],
    required: ['retry_id', 'run_id', 'job_id', 'step_id', 'attempt_id', 'org_id', 'error_class', 'reason_code', 'attempt_number', 'available_at', 'deadline_at', 'delay_ms', 'created_at'],
  },
  cancellation_request: {
    schema: 'awe.cancellation_request/v1',
    keys: ['schema', 'cancellation_id', 'run_id', 'job_id', 'org_id', 'actor', 'principal', 'reason_code', 'requested_at', 'status', 'document_digest'],
    required: ['cancellation_id', 'run_id', 'job_id', 'org_id', 'actor', 'principal', 'reason_code', 'requested_at', 'status'],
  },
  timeout_decision: {
    schema: 'awe.timeout_decision/v1',
    keys: ['schema', 'timeout_id', 'run_id', 'job_id', 'org_id', 'scope', 'deadline_at', 'observed_at', 'decision', 'reason_code', 'document_digest'],
    required: ['timeout_id', 'run_id', 'job_id', 'org_id', 'scope', 'deadline_at', 'observed_at', 'decision', 'reason_code'],
  },
  recovery_request: {
    schema: 'awe.recovery_request/v1',
    keys: ['schema', 'recovery_id', 'run_id', 'job_id', 'lease_id', 'org_id', 'reason_code', 'requested_at', 'status', 'document_digest'],
    required: ['recovery_id', 'run_id', 'job_id', 'lease_id', 'org_id', 'reason_code', 'requested_at', 'status'],
  },
  compensation_request: {
    schema: 'awe.compensation_request/v1',
    keys: ['schema', 'compensation_id', 'run_id', 'job_id', 'step_id', 'effect_id', 'org_id', 'mode', 'reason_code', 'requested_at', 'status', 'document_digest'],
    required: ['compensation_id', 'run_id', 'job_id', 'step_id', 'effect_id', 'org_id', 'mode', 'reason_code', 'requested_at', 'status'],
  },
  completion_record: {
    schema: 'awe.execution_completion/v1',
    keys: ['schema', 'completion_id', 'run_id', 'job_id', 'org_id', 'state_version', 'outcome', 'result_digest', 'completed_at', 'document_digest'],
    required: ['completion_id', 'run_id', 'job_id', 'org_id', 'state_version', 'outcome', 'result_digest', 'completed_at'],
  },
  dead_letter: {
    schema: 'awe.dead_letter/v1',
    keys: [
      'schema', 'dead_letter_id', 'run_id', 'job_id', 'org_id', 'final_state',
      'attempts', 'last_checkpoint_id', 'last_error', 'reason_code',
      'event_refs', 'effect_uncertainty', 'compensation_status',
      'recommended_action', 'created_at', 'document_digest',
    ],
    required: [
      'dead_letter_id', 'run_id', 'job_id', 'org_id', 'final_state',
      'attempts', 'last_checkpoint_id', 'last_error', 'reason_code',
      'event_refs', 'effect_uncertainty', 'compensation_status',
      'recommended_action', 'created_at',
    ],
  },
  idempotency_record: {
    schema: 'awe.idempotency_record/v1',
    keys: ['schema', 'idempotency_key', 'org_id', 'scope', 'action_digest', 'state', 'result_ref', 'created_at', 'updated_at', 'document_digest'],
    required: ['idempotency_key', 'org_id', 'scope', 'action_digest', 'state', 'result_ref', 'created_at', 'updated_at'],
  },
  effect_receipt: {
    schema: 'awe.effect_receipt/v1',
    keys: [
      'schema', 'effect_id', 'run_id', 'job_id', 'step_id', 'attempt_id',
      'lease_id', 'worker_id', 'fencing_token', 'org_id', 'idempotency_key',
      'action_digest', 'state', 'adapter_ref', 'result_digest', 'error_class',
      'compensation_mode', 'approval_evidence_digest', 'policy_evidence_digest',
      'created_at', 'updated_at', 'document_digest',
    ],
    required: [
      'effect_id', 'run_id', 'job_id', 'step_id', 'attempt_id',
      'lease_id', 'worker_id', 'fencing_token', 'org_id', 'idempotency_key',
      'action_digest', 'state', 'adapter_ref', 'result_digest', 'error_class',
      'compensation_mode', 'approval_evidence_digest', 'policy_evidence_digest',
      'created_at', 'updated_at',
    ],
  },
  execution_event: {
    schema: 'awe.execution_event/v1',
    keys: [
      'schema', 'event_id', 'sequence', 'run_id', 'job_id', 'org_id',
      'event_type', 'payload', 'occurred_at', 'correlation_id', 'causation_id',
      'previous_digest', 'event_digest', 'document_digest',
    ],
    required: [
      'event_id', 'sequence', 'run_id', 'job_id', 'org_id', 'event_type',
      'payload', 'occurred_at', 'correlation_id', 'causation_id',
      'previous_digest', 'event_digest',
    ],
  },
  execution_command: {
    schema: 'awe.execution_command/v1',
    keys: ['schema', 'command_id', 'command_type', 'run_id', 'job_id', 'org_id', 'expected_state_version', 'idempotency_key', 'payload_digest', 'issued_at', 'document_digest'],
    required: ['command_id', 'command_type', 'run_id', 'job_id', 'org_id', 'expected_state_version', 'idempotency_key', 'payload_digest', 'issued_at'],
  },
  execution_result: {
    schema: 'awe.execution_result/v1',
    keys: ['schema', 'result_id', 'command_id', 'run_id', 'job_id', 'org_id', 'kind', 'reason_code', 'error_class', 'output_digest', 'checkpoint_id', 'wake_id', 'effect_ids', 'created_at', 'document_digest'],
    required: ['result_id', 'command_id', 'run_id', 'job_id', 'org_id', 'kind', 'reason_code', 'error_class', 'output_digest', 'checkpoint_id', 'wake_id', 'effect_ids', 'created_at'],
  },
});

export const EXECUTION_CONTRACT_TYPES = Object.freeze(Object.keys(DEFINITIONS).sort());
export const EXECUTION_SCHEMAS = deepFreeze(Object.fromEntries(
  Object.entries(DEFINITIONS).map(([name, definition]) => [name, definition.schema]),
));

const NON_SECRET_EVIDENCE_FIELDS = new Set([
  'fencing_token',
  'approval_evidence_digest',
  'policy_evidence_digest',
]);

export function sanitizeExecutionData(value) {
  const safe = redact(value);
  const restore = (target, source) => {
    if (target === null || source === null || typeof target !== 'object' || typeof source !== 'object') return;
    for (const [key, child] of Object.entries(source)) {
      if (NON_SECRET_EVIDENCE_FIELDS.has(key)) target[key] = child;
      else if (target[key] !== undefined) restore(target[key], child);
    }
  };
  restore(safe, value);
  return safe;
}

function validateKnownFields(type, value) {
  const ids = Object.entries(value).filter(([name]) => name.endsWith('_id'));
  for (const [name, field] of ids) if (field !== null) opaque(field, `${type}.${name}`);
  for (const [name, field] of Object.entries(value)) {
    if ((name.endsWith('_at') || name === 'deadline_at') && field !== null) instant(field, `${type}.${name}`);
    if (name.endsWith('_digest') && field !== null) contentDigest(field, `${type}.${name}`);
    if (name === 'state_version' || name === 'attempt_count' || name === 'recovery_count' || name === 'compensation_count') {
      integer(field, `${type}.${name}`);
    }
  }
  if (value.org_id !== undefined) opaque(value.org_id, `${type}.org_id`);
  if (value.environment !== undefined) oneOf(value.environment, EXECUTION_ENVIRONMENTS, `${type}.environment`);
  if (value.priority_class !== undefined) oneOf(value.priority_class, PRIORITY_CLASSES, `${type}.priority_class`);
  if (value.kind !== undefined && ['job', 'run'].includes(type)) oneOf(value.kind, EXECUTION_KINDS, `${type}.kind`);
  if (value.required_capabilities !== undefined) strings(value.required_capabilities, `${type}.required_capabilities`);
  if (value.capabilities !== undefined) strings(value.capabilities, `${type}.capabilities`);
  if (value.active_lease_ids !== undefined) strings(value.active_lease_ids, `${type}.active_lease_ids`);
  if (value.memory_snapshot_refs !== undefined) strings(value.memory_snapshot_refs, `${type}.memory_snapshot_refs`);
  if (value.event_refs !== undefined) strings(value.event_refs, `${type}.event_refs`);
  if (value.effect_ids !== undefined) strings(value.effect_ids, `${type}.effect_ids`);
  if (value.principal_roles !== undefined) strings(value.principal_roles, `${type}.principal_roles`);
  if (value.version !== undefined) invariant(VERSION.test(value.version), 'invalid_input', `${type}.version must be semver`, {});
  if (type === 'wake_condition') oneOf(value.kind, WAKE_KINDS, 'wake_condition.kind');
  if (type === 'effect_receipt') {
    oneOf(value.state, EFFECT_STATES, 'effect_receipt.state');
    oneOf(value.compensation_mode, COMPENSATION_MODES, 'effect_receipt.compensation_mode');
  }
  if (type === 'execution_result') oneOf(value.kind, EXECUTION_RESULT_KINDS, 'execution_result.kind');
  if (value.error_class !== undefined && value.error_class !== null) oneOf(value.error_class, ERROR_CLASSES, `${type}.error_class`);
  if (type === 'recurring_schedule') {
    integer(value.interval_ms, 'recurring_schedule.interval_ms', { min: 1 });
    integer(value.max_catch_up, 'recurring_schedule.max_catch_up');
    invariant(typeof value.timezone === 'string' && value.timezone.length > 0, 'invalid_input', 'recurring_schedule.timezone is required', {});
    invariant(['skip', 'run_once', 'catch_up_bounded'].includes(value.missed_run_policy), 'invalid_input', 'recurring_schedule missed_run_policy is invalid', {});
    invariant(typeof value.enabled === 'boolean', 'invalid_input', 'recurring_schedule.enabled must be boolean', {});
  }
}

export function defineExecutionContract(type, spec = {}) {
  invariant(DEFINITIONS[type] !== undefined, 'invalid_input', `unknown execution contract '${type}'`, {});
  const definition = DEFINITIONS[type];
  const input = canonicalClone(spec);
  delete input.schema;
  delete input.document_digest;
  closed(input, definition.keys.filter((key) => !['schema', 'document_digest'].includes(key)), `${type} contract`);
  required(input, definition.required, `${type} contract`);
  validateKnownFields(type, input);
  const safe = sanitizeExecutionData(input);
  // These are control evidence, not credentials. The kernel redactor correctly
  // treats arbitrary `token` / `authorization` keys as secret-shaped, so the
  // execution contract explicitly restores its typed non-secret evidence after
  // recursive payload redaction.
  for (const evidenceField of NON_SECRET_EVIDENCE_FIELDS) {
    if (Object.hasOwn(input, evidenceField)) safe[evidenceField] = input[evidenceField];
  }
  const document = { schema: definition.schema, ...safe };
  return deepFreeze({ ...document, document_digest: digest(document) });
}

export function assertExecutionContract(type, document, where = {}) {
  invariant(isPlainObject(document), 'contract_violation', `${type} document must be an object`, where);
  const definition = DEFINITIONS[type];
  invariant(definition !== undefined, 'contract_violation', `unknown execution contract '${type}'`, where);
  closed(document, definition.keys, `${type} document`, 'contract_violation');
  required(document, definition.keys, `${type} document`, 'contract_violation');
  invariant(document.schema === definition.schema, 'contract_violation', `${type} schema must be '${definition.schema}'`, where);
  const rebuilt = defineExecutionContract(type, document);
  invariant(rebuilt.document_digest === document.document_digest, 'contract_violation', `${type} document digest mismatch`, where);
  return document;
}

const wrappers = Object.fromEntries(EXECUTION_CONTRACT_TYPES.map((type) => [
  type,
  (spec) => defineExecutionContract(type, spec),
]));

export const defineExecutionJob = wrappers.job;
export const defineExecutionRun = wrappers.run;
export const defineExecutionStep = wrappers.step;
export const defineExecutionAttempt = wrappers.attempt;
export const defineWorkerCapability = wrappers.worker_capability;
export const defineWorker = wrappers.worker;
export const defineWorkerHeartbeat = wrappers.worker_heartbeat;
export const defineExecutionLease = wrappers.lease;
export const defineLeaseClaim = wrappers.lease_claim;
export const defineLeaseRenewal = wrappers.lease_renewal;
export const defineLeaseRelease = wrappers.lease_release;
export const defineLeaseExpiration = wrappers.lease_expiration;
export const defineExecutionCheckpoint = wrappers.checkpoint;
export const defineWakeCondition = wrappers.wake_condition;
export const defineScheduledWakeup = wrappers.scheduled_wakeup;
export const defineRecurringSchedule = wrappers.recurring_schedule;
export const defineApprovalWakeup = wrappers.approval_wakeup;
export const defineExternalEventWakeup = wrappers.external_event_wakeup;
export const defineRetrySchedule = wrappers.retry_schedule;
export const defineCancellationRequest = wrappers.cancellation_request;
export const defineTimeoutDecision = wrappers.timeout_decision;
export const defineRecoveryRequest = wrappers.recovery_request;
export const defineCompensationRequest = wrappers.compensation_request;
export const defineCompletionRecord = wrappers.completion_record;
export const defineDeadLetterRecord = wrappers.dead_letter;
export const defineIdempotencyRecord = wrappers.idempotency_record;
export const defineEffectReceipt = wrappers.effect_receipt;
export const defineExecutionEvent = wrappers.execution_event;
export const defineExecutionCommand = wrappers.execution_command;
export const defineExecutionResult = wrappers.execution_result;

export function executionContentDigest(value) {
  return digest(redact(canonicalClone(value)));
}
