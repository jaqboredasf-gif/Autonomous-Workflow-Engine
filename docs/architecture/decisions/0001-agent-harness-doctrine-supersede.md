# ADR-0001 — Agent Harness supersedes the "no generic runtime" clause

**Status:** Proposed (2026-07-27) — awaiting Jack's ratification.

## Context

DECISION_LOG 2026-07-17 locked the harness doctrine:

> harness = schema constraints + triggers + `integration_events` + deterministic
> scripts + per-slice runner code. No generic agent runtime, no engine tables,
> **no tool-dispatch layer until a second consumer exists**.

That clause was a *deferral with a trigger*, not a permanent ban. Since it was
written, five consumers have each grown their own copy of the same five concerns:

| Consumer | Independently re-implements |
|---|---|
| `scripts/lib/classification.mjs` + `classify.mjs` (B2) | packet build, retry budget (1+2), parse/validate, fail-closed, Verify Step, telemetry |
| `scripts/lib/approval-matrix.mjs` + `outbound-draft.mjs` (B3) | authz gate, `ALLOWED_ACTIONS` list, idempotency (`draft_key`), blocked-reason vocabulary, TEST-mode guard |
| `packages/mcp-server/src/index.js` | tool descriptors, input schemas, org assumption, error shape |
| `apps/web` API + `src/lib/approval-queue.ts` (B5) | the same authz surface and refusal vocabulary |
| B12 n8n consumers (blocked) | retry/attempt accounting on `integration_events` |

Observable cost today: three separate blocked-reason vocabularies
(`ROUTE_BLOCKED_REASONS`, `GATE_BLOCKED_REASONS`, ad-hoc runner errors), two DB
access paths (management API in `scripts/lib/db.mjs`, service-role client in the
MCP server), and one tenant-binding bug (`packages/mcp-server/src/index.js:396`
selects `orgs … limit 1` — "the first org" is not a tenant binding).

## Decision

**The trigger condition is met. Build the Agent Harness as a subsystem**, per
`docs/architecture/AGENT_HARNESS_DESIGN.md`, under the non-goals below. The
harness is the *extraction* of machinery that already exists in five places, plus
durable session state that exists nowhere.

Binding non-goals (each testable, re-checked at H17):

1. No `workflow_definitions`-style tables, no DSL, no user-authored graphs. AWE
   stays map-driven over concrete domain tables (UBIQUITOUS_LANGUAGE § AWE).
2. No autonomous external send. The `external` effect class has no descriptor, no
   permitted ceiling, and no code path (ADR-0001 → doctrine D1).
3. No daemon, queue worker, or scheduler in v1 (ADR-0003).
4. No cross-session memory, no RAG, no vector store.
5. No new model capability: the first session type must reproduce Runner 2A
   byte-for-byte (H12 parity gate).
6. No replacement of DB-enforced rules by application logic. Anything the
   database can enforce stays in the database.

## Alternatives considered

- **Keep deferring.** Rejected: the duplication is already three vocabularies and
  two access paths deep, and each new slice (B4, B6, B12) adds a sixth copy. The
  trigger exists precisely to stop this.
- **Refactor in place** — extract shared helpers into `scripts/lib/` without
  session state. Rejected: solves duplication, not the actual gap. No durable
  session, no resume, no budget ledger, no immutable step audit. Every future
  multi-step slice would still invent its own.
- **Adopt an off-the-shelf agent framework.** Rejected: imports a runtime whose
  guardrails are not schema-enforced, whose retries are not budget-charged, and
  whose audit is not our `integration_events` contract. It would invert the
  project's core rule that the database is the enforcement layer.

## Consequences

- New workspace package `packages/harness/`; new tables in migrations 0017/0018;
  new eval Runner 6 (ADR-0008); H1–H17 backlog entries.
- Existing behavior must not change: H7/H9/H12 are parity-gated against Runner 2A
  byte-for-byte; a divergence is a harness bug, never a label change.
- `docs/architecture/AGENT_HARNESS.md` (the built/partial/task mapping) stays the
  status document and is rewritten at H17; the design/doctrine/contract docs are
  the specification.
- Doctrine text in DECISION_LOG 2026-07-17 is **narrowed, not deleted**: "no
  generic runtime" survives as non-goals 1–6.

## Security impact

Net positive if built as specified, net negative if half-built:

- Positive: one dispatcher means one place where tenant binding, authz, effect
  ceiling, and idempotency are enforced — instead of five. Fixes the MCP
  "first org" binding by construction.
- Positive: immutable step/tool/model ledgers make agent actions auditable, which
  today they are not.
- Risk: new service-role-only tables are exactly the shape that produced S1
  (undeclared `TO authenticated` policies on `integration_events` et al). Mitigated
  by G2 — RLS on, zero client policies, plus a `pg_policies` count pin in the new
  acceptance slice from H2 onward.
- Risk: a dispatcher is a single high-authority chokepoint. Mitigated by the
  effect-class ceiling being enforced twice (code + DB check) and by `external`
  having no descriptor at all.

## Operational impact

- ~17 sessions of work (H1–H17), two live-apply approval checkpoints.
- Regression grows by one acceptance slice, one offline unit runner, one
  registry-parity lint, and Runner 6.
- Ops gains a kill switch, a cost ledger, and a session trace that do not exist
  today.

## Reversal strategy

Cheap at every point, because nothing existing is rewritten in place:

- Before AC-1 (0017 apply): delete `packages/harness/`, drop the backlog entries.
  Nothing in the live DB, nothing in existing runtime paths.
- After AC-1/AC-2: the harness tables are additive and unreferenced by any
  existing table; stopping means leaving them empty and unused. No destructive
  migration is required to abandon the subsystem (and none would be permitted
  without separate approval).
- After H12: `classify.mjs` remains the untouched entrypoint; the harness calls
  the same domain service. Reverting = stop invoking the harness path.

## Related tasks and guardrails

Tasks H0–H17 · Guardrails G1–G20 · Supersedes (narrows) DECISION_LOG 2026-07-17
"Harness doctrine" · Depends on nothing · Blocks H1 and everything after.
