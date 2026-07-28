# Durable Execution Plane Handoff

## Status

Implementation is complete in the isolated worktree
`/private/tmp/awe-durable-execution` on branch
`codex/durable-execution-plane`, based on `codex/memory-layer` at `cf3335d`.

The new `@exattime/awe-execution` package supplies closed contracts, one
optimistic state machine, a storage-neutral repository with a complete in-memory
adapter, priority/capability queueing, schedules and wakes, atomic in-process
leases with fencing, checkpoints, retries, idempotent effects, workers,
recovery, cancellation, compensation, dead letters and replay.

Runtime adapters integrate the existing Workflow Runtime, bounded Agent Runtime,
Memory Layer, Context Items and audit/event boundaries. The reference scenario
performs Memory retrieval and two Agent Runtime safe reads, pauses for a human
digest-bound approval, resumes on Worker B and executes one fake effect.

## Safety boundary

No migration, live database, live tenant, production configuration, n8n
workflow, external send, real model, deployment or external service was used.
LIVE remains refused by default.

The in-memory adapter is the verified offline reference, not production
durability. A relational/queue adapter must preserve transactional claim,
monotonic fencing, optimistic state versions and tenant checks.

## Verification

Verified on 2026-07-28:

- Runner D: 309 passed, 0 failed, 16 synthetic fixture compositions, 0 skipped.
- Runner K: 582 passed, 0 failed.
- Runner A: 127 passed, 0 failed.
- Runner Y: 91 passed, 0 failed.
- Full non-database regression: all green, 16 ran / 9 skipped.
- Web production build: passed with non-secret build-only Supabase placeholders;
  compilation, TypeScript and all 15 prerendered/dynamic routes completed.
- Mobile typecheck: passed.
- MCP TEST-mode smoke: passed with 10 tools.
- Reference CLI: passed; Worker A paused, Worker B resumed, one fake external
  effect executed, and replay invoked zero tools and zero models.
- Syntax checks and `git diff --check`: passed.

Seven real source mutations were applied one at a time and restored. Runner D
turned red when each of the following guards was removed: closed-contract keys,
state-version equality, fencing-token validation, human approval actor
separation, uncertain-effect replay refusal, per-event replay digest
validation, and worker tenant partitioning. The restored tree is the 309/309
result above.

## Publication

- Core commit: `96467af`
- Runtime/eval commit: `523788c`
- Documentation commit: `24d2acc`
- Branch: `codex/durable-execution-plane`
- Remote branch: pushed to `origin`
- Stacked draft PR: #7, targeting `codex/memory-layer`
- PR validation: green at handoff

Focused commands:

```bash
bash scripts/eval-durable-execution.sh
node scripts/awe-execution.mjs demo
bash scripts/eval-memory.sh
bash scripts/eval-agent-runtime.sh
bash scripts/eval-kernel.sh
bash scripts/regression.sh --kinds=unit,offline,static
```

For the web build in a credential-free isolated worktree, use non-secret
build-only values because the existing app eagerly constructs its Supabase
client during prerender:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=build-only-placeholder \
npm --workspace apps/web run build
```

## Next work

The next production-oriented milestone is a durable encrypted tenant-bound
repository/queue adapter after repository migration history, live migration
history and the applicable ADRs agree. Do not create or apply that migration
while the histories disagree.
