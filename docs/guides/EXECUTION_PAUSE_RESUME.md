# Execution Pause and Resume

Supported waits are approval, scheduled time, external event, manual hold,
policy review, retry backoff, dependency completion and rate-limit delay.

Pause order:

```text
running → checkpointing → commit checkpoint → create wake
→ waiting state → finish attempt → release lease
```

Resume order:

```text
validate/satisfy wake → scheduler marks ready
→ new worker claims a newer lease → restore checkpoint → execute
```

Approval must use `signalApproval()` with a human actor and exact action digest.
External events use `signalExternalEvent()` with the exact correlation key.
Manual/policy/dependency holds use `resumeWake()`. Time/retry wakes are satisfied
by `tick()`.

An approval never invokes an effect directly. It only makes the run eligible.
