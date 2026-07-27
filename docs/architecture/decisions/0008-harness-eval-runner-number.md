# ADR-0008 — Harness eval is Runner 6

**Status:** Proposed (2026-07-27) — awaiting Jack's ratification.
**Corrects:** `docs/architecture/AGENT_HARNESS_DESIGN.md` §16 H13, which called the
harness eval "Runner 4".

## Context

Runner numbers are already allocated (CONTEXT.md repo map, EVAL_STRATEGY.md,
`regression.sh`):

| Runner | Script | Scope |
|---|---|---|
| 1 | `scripts/eval-intake.sh` | baseline deterministic intake |
| 2A / 2B | `eval-classification.sh` / `eval-classification-live.sh` | classification (replay / live) |
| 3 | `eval-approval-diff.sh` | task ADR — approval diff engine |
| 4 | `eval-approval-matrix.sh` | B3 matrix + outbound drafts |
| 5 | `eval-approval-queue.sh` | B5 approval-queue logic |

"Runner 4" is taken. Two runners with one number would break every future
regression report and every handoff that cites a runner by number.

## Decision

The harness eval is **Runner 6**:

- `scripts/eval-harness.sh` — **Runner 6A**, deterministic, replay adapter, real DB
  persistence + Verify Steps, **in `regression.sh`**;
- `scripts/eval-harness-live.sh` — **Runner 6B**, live inference, key-gated
  (`ANTHROPIC_API_KEY`), **not** in regression.

Same 2A/2B split rationale as EVAL_STRATEGY.md: 6A proves the machine is correct
given known-good model output; only 6B says anything about model quality.

Separately, H1's pure unit suite is **not** a Runner — it is
`scripts/eval-harness-unit.sh`, an offline lint/unit step in the same class as
`validate-migration-0014/0015.mjs`. Runner numbers are reserved for
fixture+label evaluations.

## Alternatives considered

- **Renumber the existing runners.** Rejected outright: they are cited by number in
  DECISION_LOG, SESSION_HANDOFF, TASK_BACKLOG and EVAL_STRATEGY. Renumbering
  rewrites history for cosmetic tidiness.
- **Name instead of number** ("harness eval"). Rejected: the project's regression
  vocabulary is numeric; a lone named runner is the odd one out and gets miscited.

## Consequences

- EVAL_STRATEGY.md gains a Runner 6 section at H13.
- `regression.sh` gains one step after Runner 5.
- Any earlier reference to "harness Runner 4" is wrong; H13's acceptance text is
  corrected by this ADR and in the design doc.

## Security impact

None.

## Operational impact

Regression gains one deterministic suite (and one live suite that never runs in
regression). Runner 6A writes fixture rows per ADR-0005.

## Reversal strategy

Numbering only.

## Related tasks and guardrails

Tasks H13, H17 · No guardrail dependency.
