# Execution Idempotency

Job acceptance uses:

```text
tenant + scope(job_acceptance) + idempotency_key + payload_digest
```

The same key and digest returns the existing job. The same key with another
digest is a conflict.

External effects use:

```text
tenant + stable idempotency_key + action_digest
+ attempt + policy/approval evidence + lease/fence
```

A confirmed duplicate replays the receipt and does not invoke the adapter.
An uncertain receipt is returned as uncertain and is not re-executed
automatically. A different action using the same key is refused.

Provider adapters should also pass the stable idempotency key to providers that
support it. Local receipt idempotency cannot prove what a provider did after a
connection was lost.
