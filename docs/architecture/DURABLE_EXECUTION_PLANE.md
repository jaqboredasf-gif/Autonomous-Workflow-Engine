# AWE Durable Execution Plane

Status: implemented and verified offline. The shipped adapter is deterministic
and in-memory. No database, queue service, provider SDK, network call, live
effect, migration, deployment, or production configuration is included.

## Executive verdict

The Durable Execution Plane is the provider-neutral control substrate that lets
AWE work survive process replacement and long waits. Execution state is stored
as explicit jobs, runs, steps, attempts, leases, checkpoints, wakes, effects,
completion/dead-letter records, and append-only events. Workers are replaceable
executors. They do not own truth.

The complete synthetic reference run proves:

1. a tenant-bound agent job is accepted and made ready;
2. Worker A atomically claims it;
3. the existing Memory Layer retrieves an immutable snapshot;
4. the existing bounded Agent Runtime executes two safe read tools;
5. the agent proposes a synthetic consequential action;
6. the execution is checkpointed and paused for a digest-bound human approval;
7. Worker A releases its lease;
8. a human approval makes the job eligible without executing it;
9. Worker B obtains a newer fencing token and restores the checkpoint;
10. one fake effect executes through a stable idempotency key;
11. a confirmed receipt is stored and the run completes; and
12. control replay invokes no tool, model, or provider.

Run it:

```bash
node scripts/awe-execution.mjs demo
bash scripts/eval-durable-execution.sh
```

## Dependency direction

```text
@exattime/awe-kernel
  canonical data · digests · events · outcomes · Context Items
            ▲
            │
@exattime/awe-control-plane       @exattime/awe-memory
  workflow/policy/approval          records/retrieval snapshots
            ▲                              ▲
            │                              │
@exattime/awe-agent-runtime               │
  bounded model/tool loop                  │
            ▲                              │
            └──────────┐        ┌──────────┘
                       │        │
             @exattime/awe-execution
  contracts · state · repository · queue · scheduler · leases
  checkpoints · retry · effects · workers · recovery · replay
                       ▲
                       │
               @exattime/awe-runtime
  composition adapters · reference worker · synthetic scenario
                       ▲
                       │
           CLI · MCP · web · workers · scheduler · n8n
```

The new core package imports only its local kernel seam. It does not import the
Control Plane, Agent Runtime, Memory Layer, runtime services, applications, or
scripts. `@exattime/awe-runtime` composes those higher-level capabilities.
Consequently, a future database/queue adapter can implement the same repository
port without putting storage code in the execution core.

## Package structure

```text
packages/awe-execution/
  src/contracts.mjs       30 versioned closed contracts
  src/state-machine.mjs   canonical execution states and transitions
  src/repository.mjs      storage-neutral port + deterministic memory adapter
  src/retry.mjs           classification and deterministic retry policy
  src/effects.mjs         receipts, idempotency, uncertainty, compensation
  src/scheduler.mjs       time/wake eligibility and recurring boundary
  src/worker.mjs          bounded claim/execute/checkpoint/release lifecycle
  src/recovery.mjs        expired work, corruption and dead-letter decisions
  src/replay.mjs          hash-chain verification and control replay
  src/service.mjs         safe developer APIs
  src/index.mjs           public surface

packages/awe-runtime/
  src/execution-service.mjs
  src/reference/durable-operations.mjs

scripts/
  awe-execution.mjs
  eval-durable-execution.{mjs,sh}
```

## Canonical contracts

Every document is closed, versioned, runtime validated, deeply frozen and
content-addressed:

```text
execution job             execution run
execution step            execution attempt
worker                    worker capability
worker heartbeat          execution lease
lease claim               lease renewal
lease release             lease expiration
checkpoint                wake condition
scheduled wakeup          recurring schedule
approval wakeup           external-event wakeup
retry schedule            cancellation request
timeout decision          recovery request
compensation request      completion record
dead-letter record        idempotency record
effect receipt            execution event
execution command         execution result
```

Opaque ids, tenant, environment, runtime identity/version, trace/correlation
links, content digests, state versions and timestamps are explicit where
applicable. An unknown key is refused. A changed body with an old digest is
refused. Contracts do not serialize arbitrary JavaScript runtime state.

## State machine

```text
accepted ──► scheduled ──► ready ──► leased ──► running
    │                         │                    │
    └────────────► ready ◄────┘                    ├──► checkpointing ──┐
                                                  │                    │
                                                  ├──► waiting         │
                                                  ├──► waiting_for_approval
                                                  ├──► waiting_for_event
                                                  ├──► waiting_until
                                                  ├──► retry_scheduled
                                                  ├──► recovering ──► ready
                                                  ├──► compensating
                                                  ├──► cancelling
                                                  ├──► completed
                                                  ├──► failed
                                                  └──► dead_lettered

waiting* / retry_scheduled ──wake──► ready
cancelling ──► compensating | cancelled | failed | dead_lettered
compensating ──► cancelled | failed | dead_lettered
```

`cancelled`, `completed`, `failed`, and `dead_lettered` are terminal.
Transitions require `expected_version`; success increments `state_version`.
A stale expected version or illegal edge fails closed. Scheduler, worker and
recovery updates all use the same transition function.

## Repository and queue

`defineExecutionRepository()` requires the complete provider-neutral port. The
memory implementation includes tenant-checked storage for:

- jobs, runs, steps, attempts and workers;
- leases and worker heartbeats;
- checkpoints and wake conditions;
- cancellation and idempotency records;
- effect receipts, completion and dead-letter records; and
- append-only execution events.

Ready selection is tenant-partitioned, capability-filtered, available-time
ordered, bounded to 100 items, and deterministically sorted by one of four
platform priority classes, then time and opaque id. `queueStatus()` reports
ready, delayed, leased and total depth plus a bounded-capacity backpressure
signal. Duplicate job acceptance is suppressed by tenant + scope + idempotency
key and payload digest.

The in-memory adapter makes one claim decision synchronously, which is atomic in
one JavaScript process. A durable adapter must implement claim/takeover as one
database/queue compare-and-set operation; the port must not be implemented as
read-then-write.

## Lease and fencing protocol

Claim requires:

- an eligible tenant-owned job;
- an active tenant-owned worker;
- all required worker capabilities;
- an unexpired bounded lease interval; and
- no active lease for the job.

Every claim receives a monotonically increasing `fencing_token`. Renewal keeps
the token and cannot exceed `max_expires_at`. Release records `released` or
`completed`. Recovery expires the old lease before requeueing.

Checkpoint, effect-confirmation and completion commits re-verify:

```text
lease_id + job_id + run_id + org_id + worker_id
+ fencing_token + active status + expires_at > now
```

Checkpoint commits additionally require the expected run `state_version`.
Verification occurs again after an effect adapter returns, so an old worker
cannot claim confirmation after another worker recovers the job. A provider
outcome may still be uncertain; fencing prevents a false commit, not the laws of
distributed systems.

## Worker lifecycle

```text
register capability set
  → heartbeat
  → poll tenant partition
  → atomically claim
  → transition leased → running
  → create immutable attempt
  → restore latest checkpoint
  → invoke injected workflow/agent executor
  → checkpoint / effect / retry / compensate / complete
  → release or complete lease
  → stop after bounded polls or an explicit stop
```

The executor receives the worker, job, run, attempt, checkpoint, lease and
controls for heartbeat, renewal and lease verification. Clocks, identifiers,
randomness, repository, executor, event port, audit port and retry policy are
injected. There is no infinite test worker and no hidden global mutable state.

Cancellation is checked before executor re-entry. Mid-adapter interruption is
deliberately absent: cancelling a provider call cannot establish whether its
effect landed. The next safe boundary records the decision.

## Checkpoint model

`awe.execution_checkpoint/v1` stores explicit platform state:

- workflow state and bounded agent-loop state;
- completed and pending steps;
- Context snapshot reference and Memory retrieval snapshot references;
- transcript position;
- tool and external-effect receipt references;
- policy decisions and approval requests;
- retry state and compensation stack;
- wake condition;
- runtime versions and content digests; and
- lease/fence/worker/attempt evidence plus state version and sequence.

Writes are sequential and state-version protected. A paused job releases its
lease. The next attempt loads the last committed checkpoint. Runner D proves
that an expired Worker A cannot checkpoint after Worker B receives a new fence.

## Scheduler and wakes

The scheduler never executes work. It changes eligibility.

Supported durable wake kinds:

- scheduled time;
- human approval;
- external event;
- manual operator hold;
- policy review;
- retry backoff;
- dependency completion; and
- rate-limit delay.

One-time jobs respect `available_at`. Approval/external/manual wakes must be
satisfied before eligibility. Expired wakes fail the run explicitly. Deadlines
fail ready or scheduled work rather than leaving it invisible. Duplicate wake
ids are refused unless byte-identical.

`awe.recurring_schedule/v1` is an adapter boundary using an anchor plus interval,
timezone label, missed-run policy and bounded catch-up. `calculateNextRun()` is
deterministic. It is intentionally not a cron parser or calendar provider.

## Approval integration

An approval pause stores the exact action digest in the checkpoint and wake.
Only a human actor can call `signalApproval()`. Tenant, pending status and digest
must match. Rejection fails the run. Approval only satisfies the wake; the
scheduler makes work ready and a separately leased worker executes it.
Automation never self-approves.

The core consumes authenticated principal data but does not authenticate it.
Authentication remains the responsibility of the web/operator surface.

## Retry behavior

The taxonomy distinguishes:

```text
retryable: infrastructure · provider · rate limit · timeout
terminal:  validation · authorization · policy · tenant
special:   uncertain external effect · compensation required
```

Policies support fixed or exponential delay, maximum delay, bounded jitter from
injected randomness, maximum attempts, maximum elapsed time and deadline-aware
refusal. Authorization, policy and tenant failures never retry automatically.
Every retry is a new attempt and a durable wake. Exhausted retries create a
dead-letter record.

## External effects and idempotency

Before a fake or future production-capable action, the worker records:

```text
tenant + run/job/step/attempt + active lease/fence + stable idempotency key
+ action digest + policy evidence digest + approval evidence digest
+ declared compensation mode
```

Receipt states are:

```text
proposed → admitted → executing → confirmed
                              ├→ refused
                              └→ uncertain
confirmed | uncertain → compensation_requested → compensated | uncertain
```

A confirmed duplicate replays the stored receipt and does not call the adapter.
Reusing a key for another action is refused. An uncertain receipt is never
blindly retried or reclassified as failure.

Compensation modes are `supported`, `unsupported`, `manual_only`, and
`conditional`. Supported compensation runs newest effect first through an
injected compensator. The system never claims every action is reversible.

## Recovery and dead letters

The recovery controller deterministically handles:

- expired leases and abandoned leased/running/checkpointing jobs;
- missing progress after the lease/heartbeat safety window;
- bounded recovery count;
- waiting records missing a durable wake;
- expired/missed wakes (with the scheduler);
- stuck cancellation or compensation; and
- terminal/inconsistent state requiring review.

Recoverable work moves through `recovering` back to `ready`, preserving the last
checkpoint and incrementing `recovery_count`. Corruption is never silently
repaired. Dead-letter records preserve identities, attempts, last checkpoint,
last error, structured reason, recent event refs, effect uncertainty,
compensation status and recommended operator action.

## Cancellation

- accepted/scheduled/ready work can cancel without a worker;
- waiting/retry work cancels its future wake and becomes ready so a worker can
  acknowledge it at a safe boundary;
- leased/running work observes the persisted request at a step boundary;
- runs with effects enter compensation where supported; and
- cancellation after an unsupported/manual effect fails to operator review
  rather than claiming reversal.

Cancellation requested and completed events are distinct.

## Runtime integrations

### Agent Runtime

`createAgentRuntimeExecutionAdapter()` maps the existing bounded Agent Runtime
result into durable completed/paused/retry/failed outcomes. Agent transcripts,
context digests, tool receipts and Memory snapshot refs become checkpoint
evidence. Authorization is not widened on resume. The reference scenario uses
the real Agent Runtime and two real synthetic read adapters before approval.

### Workflow Runtime

`createWorkflowRuntimeExecutionAdapter()` wraps the existing Control Plane
service. Its hash-chained workflow journal remains the workflow semantic record;
the Durable Execution Plane owns queueing, workers, leases, attempts,
checkpoints and recovery around it. No replacement workflow engine was created.

### Memory Layer and Context Engine

The reference executor performs an actual Memory Layer retrieval. Its immutable
snapshot becomes ordinary Context Items for the existing Agent Runtime and its
snapshot digest is stored in the execution checkpoint. Replay refers to the
captured snapshot and never queries a memory adapter.

## Events, audit and replay

Execution events are closed, sequenced, content-addressed and linked by
`previous_digest`. They reuse the kernel redactor and carry control evidence,
not customer bodies. The runtime may mirror them into the existing injected
event/audit ports.

Replay verifies every document digest, dense sequence, previous digest and
event digest before projecting control state. Classifications are:

- exact execution replay;
- checkpoint replay;
- control-decision replay;
- simulated external-effect replay;
- current-state re-execution; and
- divergence.

The shipped reference uses control-decision replay with simulated captured
effects. It reports `tools_invoked: 0` and `models_invoked: 0`. Real time,
provider behavior and uncaptured external responses are not reproduced.

## Limits and tenant guarantees

Platform limits include attempts, execution duration, pause duration,
checkpoints, recoveries, compensations, scheduled wakes, agent turns, tool
invocations and uncertain effects. Request-level attempts are clamped to the
platform ceiling. Existing Agent Runtime manifests retain their own stricter
turn/tool/token limits.

Every repository read, claim, wake, approval, cancellation, effect and replay
operation states an `org_id`. Cross-tenant access fails closed. Ready selection
does not scan another tenant partition. A worker may poll only its registered
tenant. LIVE execution is refused unless an explicit unshipped `allow_live`
composition is supplied; no shipped composition does so.

## Extension points

Future adapters may implement:

- relational execution storage with transactional compare-and-set;
- durable queue/ready indexes;
- event streams/outbox publication;
- authenticated approval relays;
- provider-specific error classification;
- cron/calendar recurring schedules; and
- encrypted tenant-bound checkpoint/snapshot bodies.

They must preserve the repository contract, tenant checks, atomic claim,
monotonic fence, state-version checks, append-only events and receipt semantics.

## Known limitations

- The reference repository is process-local. The demo simulates process
  replacement by rebuilding workers/executors around the same durable-port
  adapter; it does not claim RAM survives an OS process.
- There is no RLS/database adapter because repository and live migration
  history are known to disagree. No migration was created or applied.
- Recurrence is interval-based; cron/calendar parsing is an adapter boundary.
- Worker heartbeat recovery uses lease expiry as the authoritative safety
  boundary. A production adapter may index heartbeat deadlines separately.
- No authenticated human UI/token relay is included.
- No networked queue or multi-host atomicity benchmark is claimed.
- Compensation is only as strong as each effect adapter's declaration.
- The core does not serialize stacks, closures, promises, model internals or
  arbitrary heap state.
