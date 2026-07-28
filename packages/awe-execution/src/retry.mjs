import { deepFreeze, invariant, isInstant } from './kernel.mjs';
import { ERROR_CLASSES } from './contracts.mjs';

export const RETRYABLE_ERROR_CLASSES = [
  'retryable_infrastructure',
  'retryable_provider',
  'retryable_rate_limit',
  'retryable_timeout',
];

export const NON_RETRYABLE_ERROR_CLASSES = ERROR_CLASSES.filter(
  (name) => !RETRYABLE_ERROR_CLASSES.includes(name),
);

export const RETRY_STRATEGIES = ['fixed', 'exponential'];

function instantPlus(instant, milliseconds) {
  invariant(isInstant(instant), 'invalid_input', 'retry time needs an ISO instant', {});
  invariant(Number.isInteger(milliseconds) && milliseconds >= 0, 'invalid_input', 'retry delay must be a non-negative integer', {});
  return new Date(Date.parse(instant) + milliseconds).toISOString();
}

export function defineRetryPolicy(spec = {}) {
  const allowed = [
    'strategy', 'base_delay_ms', 'max_delay_ms', 'jitter_ratio',
    'max_attempts', 'max_elapsed_ms',
  ];
  const unknown = Object.keys(spec).filter((key) => !allowed.includes(key));
  invariant(unknown.length === 0, 'invalid_input', `retry policy contains unknown keys: ${unknown.sort().join(', ')}`, {});
  const policy = {
    strategy: spec.strategy ?? 'exponential',
    base_delay_ms: spec.base_delay_ms ?? 1000,
    max_delay_ms: spec.max_delay_ms ?? 30000,
    jitter_ratio: spec.jitter_ratio ?? 0,
    max_attempts: spec.max_attempts ?? 3,
    max_elapsed_ms: spec.max_elapsed_ms ?? 300000,
  };
  invariant(RETRY_STRATEGIES.includes(policy.strategy), 'invalid_input', 'retry strategy must be fixed or exponential', {});
  invariant(Number.isInteger(policy.base_delay_ms) && policy.base_delay_ms >= 0, 'invalid_input', 'base_delay_ms must be non-negative', {});
  invariant(Number.isInteger(policy.max_delay_ms) && policy.max_delay_ms >= policy.base_delay_ms, 'invalid_input', 'max_delay_ms must bound base_delay_ms', {});
  invariant(typeof policy.jitter_ratio === 'number' && policy.jitter_ratio >= 0 && policy.jitter_ratio <= 1, 'invalid_input', 'jitter_ratio must be in [0,1]', {});
  invariant(Number.isInteger(policy.max_attempts) && policy.max_attempts >= 1, 'invalid_input', 'max_attempts must be positive', {});
  invariant(Number.isInteger(policy.max_elapsed_ms) && policy.max_elapsed_ms >= 0, 'invalid_input', 'max_elapsed_ms must be non-negative', {});
  return deepFreeze(policy);
}

export function classifyExecutionError(error = {}) {
  const explicit = error.error_class ?? error.class ?? null;
  if (ERROR_CLASSES.includes(explicit)) {
    return deepFreeze({
      error_class: explicit,
      retryable: RETRYABLE_ERROR_CLASSES.includes(explicit),
      reason_code: error.reason_code ?? explicit,
    });
  }
  const code = String(error.code ?? '').toLowerCase();
  let error_class = 'non_retryable_validation';
  if (/429|rate.?limit/.test(code)) error_class = 'retryable_rate_limit';
  else if (/timeout|timed.?out/.test(code)) error_class = 'retryable_timeout';
  else if (/econn|network|unavailable|infrastructure/.test(code)) error_class = 'retryable_infrastructure';
  else if (/provider|5\d\d/.test(code)) error_class = 'retryable_provider';
  else if (/tenant|cross.?tenant/.test(code)) error_class = 'non_retryable_tenant';
  else if (/auth|permission|forbidden/.test(code)) error_class = 'non_retryable_authorization';
  else if (/policy|approval|guard/.test(code)) error_class = 'non_retryable_policy';
  else if (/uncertain|unknown.?effect/.test(code)) error_class = 'uncertain_external_effect';
  else if (/compensat/.test(code)) error_class = 'compensation_required';
  return deepFreeze({
    error_class,
    retryable: RETRYABLE_ERROR_CLASSES.includes(error_class),
    reason_code: error.reason_code ?? (code || error_class),
  });
}

export function decideRetry({
  error,
  attempt_number,
  first_attempt_at,
  now,
  deadline_at = null,
  policy = defineRetryPolicy(),
  randomness = () => 0.5,
} = {}) {
  invariant(Number.isInteger(attempt_number) && attempt_number >= 1, 'invalid_input', 'retry decision needs a positive attempt_number', {});
  invariant(isInstant(first_attempt_at) && isInstant(now), 'invalid_input', 'retry decision needs first_attempt_at and now', {});
  invariant(deadline_at === null || isInstant(deadline_at), 'invalid_input', 'retry deadline must be an instant or null', {});
  invariant(typeof randomness === 'function', 'invalid_input', 'retry randomness must be injected', {});
  const configured = defineRetryPolicy(policy);
  const classification = classifyExecutionError(error);
  if (!classification.retryable) {
    return deepFreeze({ decision: 'do_not_retry', ...classification, reason_code: classification.reason_code, delay_ms: null, available_at: null });
  }
  if (attempt_number >= configured.max_attempts) {
    return deepFreeze({ decision: 'dead_letter', ...classification, reason_code: 'retry_attempt_limit', delay_ms: null, available_at: null });
  }
  const elapsed = Date.parse(now) - Date.parse(first_attempt_at);
  if (elapsed >= configured.max_elapsed_ms) {
    return deepFreeze({ decision: 'dead_letter', ...classification, reason_code: 'retry_elapsed_limit', delay_ms: null, available_at: null });
  }
  const raw = configured.strategy === 'fixed'
    ? configured.base_delay_ms
    : configured.base_delay_ms * (2 ** Math.max(0, attempt_number - 1));
  const capped = Math.min(raw, configured.max_delay_ms);
  const sample = randomness();
  invariant(typeof sample === 'number' && Number.isFinite(sample) && sample >= 0 && sample <= 1, 'contract_violation', 'randomness adapter must return [0,1]', {});
  const spread = capped * configured.jitter_ratio;
  const delay_ms = Math.max(0, Math.round(capped - spread + (2 * spread * sample)));
  const available_at = instantPlus(now, delay_ms);
  if (deadline_at !== null && Date.parse(available_at) >= Date.parse(deadline_at)) {
    return deepFreeze({ decision: 'dead_letter', ...classification, reason_code: 'retry_deadline_exhausted', delay_ms, available_at: null });
  }
  if (elapsed + delay_ms > configured.max_elapsed_ms) {
    return deepFreeze({ decision: 'dead_letter', ...classification, reason_code: 'retry_elapsed_limit', delay_ms, available_at: null });
  }
  return deepFreeze({ decision: 'retry', ...classification, reason_code: classification.reason_code, delay_ms, available_at });
}

export { instantPlus };
