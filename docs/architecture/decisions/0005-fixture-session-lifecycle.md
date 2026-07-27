# ADR-0005 — Fixture harness rows accumulate; no reaper in v1 (open question O4)

**Status:** Proposed (2026-07-27) — awaiting Jack's ratification.

## Context

Every regression run already writes live fixture rows: slice 4 and slice 5 seed
fixture emails, work requests and drafts per run, and the AR backlog notes they
accumulate in the `fixture:` namespace ("harmless … but a periodic fixture-reaper
— which must respect the no-hard-delete guards — is worth designing before real
data lands"). The harness multiplies this: one Runner 6 pass over 12 fixtures
writes ~12 sessions plus tens of step, tool-call and model-call rows, on every
regression run.

## Decision

**Fixture harness rows accumulate. No reaper, no deletion, in v1.** Instead:

1. `is_fixture` propagates session → step → tool call → model call, so fixture rows
   are always separable by predicate.
2. Fixture sessions may only touch fixture data (`graph_message_id LIKE 'fixture:%'`,
   recipients `@example.invalid`) — the TEST-mode guard already proven in
   `approval-matrix.mjs`, enforced at dispatch (G19).
3. Runner 6 is **idempotent per fixture**: re-running reuses the deterministic
   session key (`fixture:<corpus>:<name>`), so a re-run updates one session's
   ledger rather than minting a new one. Row growth is bounded by corpus size, not
   by run count.
4. A `agent_fixture_footprint` view reports fixture row counts per table. Revisit
   when any harness table exceeds **100,000 fixture rows** — a number, not a vibe.

Deletion stays forbidden (`guard_no_delete`, G15). If pruning ever becomes
necessary it will be an archival status plus a separately approved migration, never
a `DELETE`.

## Alternatives considered

- **Build a reaper now.** Rejected: it is deletion machinery against immutable
  audit tables, written before any evidence that growth is a problem — the exact
  shape of change the no-hard-delete rule exists to prevent.
- **Separate fixture org (tenant-level isolation of test data).** Genuinely the
  cleanest long-term answer and worth doing before real employee data lands. Rejected
  for v1 because it forks every acceptance script's org constant and touches
  Workstream A tests, which is a bigger blast radius than the harness build itself.
  Recorded here as the recommended successor.
- **Non-persisting fixture runs** (harness writes nothing in fixture mode).
  Rejected: it would gut the Verify Step, which is precisely what Runner 6 must
  exercise. A run that writes nothing proves nothing.

## Consequences

- Live table growth is bounded by corpus size × session types, not by CI frequency.
- Runner 6 must prove idempotency explicitly: two consecutive runs produce the same
  session count and the same terminal states (H13 acceptance).
- The AR backlog item "fixture reaper" is expanded to cover harness tables and the
  fixture-org option, and is **not** closed by this ADR.

## Security impact

Neutral. No new deletion capability is created; audit immutability is preserved.
Fixture isolation keeps synthetic rows out of production reporting via `is_fixture`.

## Operational impact

One more view to watch; a documented threshold to trigger the next decision.

## Reversal strategy

Nothing is built, so nothing to reverse. Choosing the fixture-org path later is
additive.

## Related tasks and guardrails

O4 · Tasks H12, H13, H16 · Guardrails G15 (no hard delete), G19 (TEST mode) · AR
backlog: fixture reaper (expanded, still open).
