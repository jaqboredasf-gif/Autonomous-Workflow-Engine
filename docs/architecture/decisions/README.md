# Architecture Decision Records — index

Canonical location for AWE architecture decisions that are too large for a
`DECISION_LOG.md` bullet: one file per decision, `docs/architecture/decisions/`.

## Naming convention

```
docs/architecture/decisions/NNNN-kebab-case-title.md
```
- `NNNN` — zero-padded sequential, never reused, never renumbered.
- Referenced in prose as **ADR-NNNN**.
- One decision per file. A decision that changes another one does not edit it —
  it supersedes it and both files record the link.

## Naming collision warning (read once)

This repository already uses the bare token **ADR** for the *task* "Approval Diff
& Reasoning" (`docs/testing/APPROVAL_DIFF.md`, TASK_BACKLOG § ADR). To keep the
two apart:

- the task is written **task ADR (Approval Diff & Reasoning)**;
- decision records are always written with their number, **ADR-0001**, never bare.

## Status values

| Status | Meaning |
|---|---|
| `Proposed` | drafted by a session, **not yet ratified by Jack**. Carries no authority. |
| `Accepted` | ratified. A one-line entry pointing here is appended to `docs/planning/DECISION_LOG.md` on the same day. |
| `Superseded by ADR-NNNN` | replaced; kept for history, never deleted. |
| `Rejected` | considered and declined; kept so the option is not re-litigated. |

`DECISION_LOG.md` stays the append-only chronological ledger and remains the
authority for *when* a decision took effect. These files are the authority for
*why* and *what exactly*. If the two disagree, DECISION_LOG wins on date, the ADR
wins on content.

## Format (all records use it)

Title · Status · Context · Decision · Alternatives considered · Consequences ·
Security impact · Operational impact · Reversal strategy · Related tasks and
guardrails.

## Index

| ADR | Title | Status | Blocks |
|---|---|---|---|
| [ADR-0001](0001-agent-harness-doctrine-supersede.md) | Agent Harness supersedes the "no generic runtime" clause | Proposed | H1 and everything after |
| [ADR-0002](0002-harness-database-access-path.md) | Harness runtime uses the service-role Supabase client (O1) | Proposed | H2, H6, H11 |
| [ADR-0003](0003-harness-execution-locus.md) | Harness is a library; no daemon in v1 (O2) | Proposed | H11, H15 |
| [ADR-0004](0004-structured-output-contract.md) | Strict JSON-in-text output; native tool-calling deferred (O3) | Proposed | H7, H9 |
| [ADR-0005](0005-fixture-session-lifecycle.md) | Fixture harness rows accumulate; no reaper in v1 (O4) | Proposed | H13 |
| [ADR-0006](0006-human-gate-surface.md) | Human gates reuse the B5 approval queue (O5) | Proposed | H14, H15 |
| [ADR-0007](0007-kill-switch-home.md) | Kill switch lives in `agent_harness_settings`, not `org_settings` | Proposed | H2, H16 |
| [ADR-0008](0008-harness-eval-runner-number.md) | Harness eval is **Runner 6** (1–5 are taken) | Proposed | H13 |
| [ADR-0009](0009-competing-c1-migration-artifacts.md) | Two competing C1 migration artifacts under two identity schemes (raises no decision; records the conflict) | Proposed | AC-1 / H2 numbering, Phase 1 deploy |

All nine are `Proposed`. **H0 is not closed until Jack ratifies ADR-0001…0008** and
a DECISION_LOG entry records the ratification date — see
`docs/architecture/AGENT_HARNESS_H0_EXIT.md`. ADR-0009 was raised later, by the H0
re-verification session, and is not an H0 exit criterion: it blocks H2, not H1.
