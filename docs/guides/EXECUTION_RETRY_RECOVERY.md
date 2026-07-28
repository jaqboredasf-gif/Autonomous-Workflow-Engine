# Execution Retry and Recovery

Retryable classes are infrastructure, provider, rate limit and timeout.
Validation, authorization, policy and tenant failures never retry
automatically. Uncertain effects and compensation-required failures are special
states, not ordinary retry candidates.

Policies support fixed/exponential delay, bounded injected jitter, attempt and
elapsed ceilings, and deadline awareness. Each retry creates a new attempt,
checkpoint and wake.

`service.recover({ org_id, now })`:

- expires stale leases;
- records lease loss;
- moves recoverable work through `recovering` to `ready`;
- preserves the last checkpoint;
- increments the recovery count; and
- dead-letters exhaustion, missing-wake corruption and stuck compensation.

Do not silently repair incompatible run/job state. Review the dead-letter event
references and last checkpoint before manual requeue.
