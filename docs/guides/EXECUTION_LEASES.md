# Execution Leases

One active lease permits one worker to mutate one job/run.

## Claim evidence

```text
lease_id · job_id · run_id · org_id · worker_id
fencing_token · claimed_at · expires_at · max_expires_at
```

Claims require an eligible job, matching tenant, active worker and matching
capability set. A concurrent active claim returns
`execution_lease_contended`.

## Renewal and release

Renewal keeps the fencing token and cannot exceed `max_expires_at`. A pause,
completion, cancellation or dead letter releases/completes the lease. Paused
work consumes no active worker.

## Fencing

Every takeover increments the job's fencing token. Checkpoints, effect receipts
and completion commits verify the current token and active unexpired lease.
Verification happens again after an effect adapter returns.

A future SQL adapter must claim/take over with one transactional conditional
statement. A read-then-write emulation is not an atomic implementation.
