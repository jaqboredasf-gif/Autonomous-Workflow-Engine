# Execution Workers

Workers are replaceable executors over durable records. They are not the source
of truth.

## Local reference

```bash
node scripts/awe-execution.mjs worker --polls 2
node scripts/awe-execution.mjs demo
```

`--polls` is required to remain bounded to 1–100. Tests never start an
uncontrolled process.

## Lifecycle

1. Build `awe.worker/v1` with tenant, environment and capabilities.
2. Register it through `service.registerWorker()`.
3. Construct a runtime with `service.createWorker({ worker, executor })`.
4. `pollOnce()` heartbeats, selects eligible tenant work and atomically claims.
5. The executor receives job/run/attempt/checkpoint/lease plus heartbeat,
   renewal and lease-verification controls.
6. Return one structured result: completed, paused, retry, failed, cancelled or
   compensate.
7. The runtime persists the result and releases/completes the lease.
8. `stop()` prevents later polls and reports a clean stopped state.

Workers may poll only their registered tenant. Required job capabilities must be
a subset of the worker capabilities. A stale worker must treat lease loss as a
hard stop.

## Executor boundary

```js
const executor = {
  async execute({ worker, job, run, attempt, checkpoint, lease, controls }) {
    controls.assertLease();
    controls.heartbeat();
    controls.renew(30_000);
    return { kind: 'completed', output: { ok: true }, effects: [] };
  },
};
```

Do not hide a clock, id generator, queue, store, provider or mutable singleton
inside an executor. Inject it through the composition.
