# AWE Platform Landing Plan

**Date:** 2026-08-02 · **Baseline:** `feat/cognition-dispatch-control-plane` @ `a3961c0`
**Authority:** ADR-0010 (`Proposed` — this plan is not authorized to execute until it is ratified)

Operational, not aspirational: every stage names an exact branch or commit, the tests that gate it,
the evidence it must produce, and the condition under which it stops.

**Nothing in this plan has been executed.**

---

## Stage 0 — Approvals that gate everything

| # | Approval | Blocks |
|---|---|---|
| A1 | Repository visibility decision | **any push** — Stage 1 onward |
| A2 | Open the root PR | Stage 3 |
| A3 | Migration identity scheme ratified | Stages 4, 5, 6 |
| A4 | Supabase applied state known | Stage 4 |

**Stop condition:** if A1 is unresolved, no local branch is pushed. See
`AWE_REPOSITORY_EXPOSURE_REVIEW.md`.

## Stage 1 — Preserve remote state

**Inputs:** this machine; the MacBook; the n8n instance; the Supabase project.
**Allowed:** push branches (only after A1); export; copy; record.
**Forbidden:** merge; delete; activate any workflow; apply any migration.

| Step | Action | Evidence |
|---|---|---|
| 1.1 | Push `feat/persistent-cognition-compiler` and `feat/cognition-dispatch-control-plane` — **only after A1** | remote refs exist |
| 1.2 | On the MacBook: `git branch -vv`; push anything without an upstream | branch/upstream table |
| 1.3 | Export every n8n workflow read-only, incl. both WF8 variants | `C:\AWE\exports\n8n\` + index |
| 1.4 | Capture the Supabase applied-migration table | `C:\AWE\evidence\supabase-applied.json` |
| 1.5 | Copy the historical Obsidian vault — **do not merge it into `C:\AWE\vault`** | `C:\AWE\vault-macbook-original\` |

**Tests:** none. **Rollback:** n/a — additive only.
**Done when:** every artifact exists in two places and 1.2 shows no branch without an upstream.

## Stage 2 — Establish the integration base

**Exact base:** `origin/main` @ `dbf8f17`.
**Exact head of the chain:** `feat/kernelized-mcp-context` @ `19f5e1c`.

**Step 2.1 — Re-run the dry-run merges.** `main` may have moved.

```bash
git merge-tree --write-tree --name-only origin/main origin/feat/kernelized-mcp-context
```

**Expected:** exactly one conflict, `docs/planning/AGENT_HANDOFF.md`.
**Stop condition:** more than one conflict, or a conflict in `packages/`, `supabase/` or `scripts/`
— re-run the branch graph analysis before proceeding.

**Step 2.2 — Prepare the handoff-document resolution.** Both sides rewrote it independently. The
resolution keeps `main`'s validation-compatible structure (CI at
`.github/workflows/agent-handoff.yml` enforces `scripts/validate-agent-handoff.sh`) and folds in the
stack's content. Prepare it **once**; reuse it at each PR.

## Stage 3 — Land the root platform capabilities

Each row: merge, then run the gate, then proceed. **Do not batch.**

| # | PR | Head → Base | Adds | Gate |
|---|---|---|---|---|
| 3.1 | **new** | `feat/kernelized-mcp-context` → `main` | `awe-kernel`, `awe-control-plane`, `awe-runtime`, 9 ADRs, migration `0016` | regression ALL GREEN; Runners K, C, P, M |
| 3.2 | #4 | `codex/live-mcp-data-boundary` → `main`* | MCP data-boundary tests | regression; Runner M |
| 3.3 | #5 | `codex/agent-runtime` → `main`* | `awe-agent-runtime` | regression; **Runner A = 127/0** |
| 3.4 | #6 | `codex/memory-layer` → `main`* | `awe-memory` | regression; **Runner Y = 91/0** |
| 3.5 | #7 | `codex/durable-execution-plane` → `main`* | `awe-execution`, 7 guides, suite registry | regression; Runner D = 309/0, E = 376/0 |

*Bases are re-targeted to `main` as each parent lands. **Do not re-target before the parent merges**
— that is what turns a stack into a set of conflicting forks.

**Allowed changes:** conflict resolution in `docs/planning/AGENT_HANDOFF.md` only.
**Forbidden:** touching `supabase/`, rebasing, squashing, force-pushing.
**Evidence per step:** full regression output saved to `C:\AWE\evidence\landing\<pr>.txt`.
**Stop condition:** any runner count below its recorded baseline, or any new conflict outside the
handoff document.
**Rollback:** `git revert -m 1 <merge-commit>`.
**Done when:** `main` contains all six `awe-*` packages and the regression is ALL GREEN on `main`.

## Stage 4 — Resolve migration identity

**Prerequisite: A3 and A4.** This stage cannot start from this machine.

| Step | Action |
|---|---|
| 4.1 | Answer all seven questions in `AWE_MIGRATION_COLLISION_RESOLUTION.md` §7 |
| 4.2 | Ratify the scheme (ordinals recommended — 16 of 17 files already use them) |
| 4.3 | Decide C1: keep `0016_drop_undeclared_client_policies.sql` **or** the `2026072714…` phase-1 set. **Not both.** |
| 4.4 | Rename `0016_m365_integration_plane.sql` → `0017_…` **on the M365 branch**, with `validate-migration-0016.mjs` → `-0017.mjs` in the same commit |
| 4.5 | Add `scripts/lib/validate-migration-identity.mjs`; register as a `static` suite |

**Stop condition:** if 4.1 shows any `0016` variant was applied remotely, **stop** — a rename becomes
a migration-history repair, not a rename.
**Evidence:** applied-migration listing; checksum comparison; the new lint passing.
**Done when:** exactly one file claims each identifier, one scheme is ratified, and the lint fails on
a deliberately duplicated fixture.

## Stage 5 — Reconcile Microsoft 365

**Prerequisite:** Stages 3 and 4.

| Step | Action |
|---|---|
| 5.1 | Rebase or re-target the M365 branch onto the new `main` |
| 5.2 | Renumber its eval to **Runner 7** (ADR-0008 holds 6) |
| 5.3 | Register three suites in `packages/awe-kernel/src/registry.mjs`: `m365-typecheck` (build), `validate-migration-0017` (static), `eval-m365` (offline) |
| 5.4 | Resolve `scripts/regression.sh` toward the registry version — **5.3 must already be done**, or three suites vanish silently |
| 5.5 | Interleave `docs/planning/DECISION_LOG.md` by date |
| 5.6 | Merge PR #9 |
| 5.7 | **Separate commit:** reduce `packages/m365/src/{policy,evidence,contracts,execution,capabilities}.ts` to adapters over platform contracts |

**Gate:** regression ALL GREEN **and** the plan output must list all three M365 suites as *run*, not
*skipped*.
**Stop condition:** if the M365 suites do not appear in the plan, 5.3 was not done. Stop.
**Forbidden:** `scripts/m365-live-smoke.sh` — credential-gated, never had a live proof.
**Done when:** M365 is on `main`, its suites run in every regression, and 5.7 has a follow-up task.

## Stage 6 — Replay migrations locally

**Prerequisite:** Docker operational (WSL2 installed; no distribution yet — launch Docker Desktop
once).

Replay `0001`–`0017` against an **empty** PostgreSQL in an isolated container. Confirm the chain
applies from scratch, RLS behaves, tenant isolation holds.

**Forbidden:** pointing any replay at a shared or remote database; `supabase db push`.
**Evidence:** full transcript to `C:\AWE\evidence\migration-replay\`.
**Stop condition:** any migration failing on an empty database — that is a defect, not an
environment problem, and it blocks Stage 7.

## Stage 7 — Verify tenant isolation and concurrency

Against the Stage 6 container only: `acceptance-slice1`–`5`, `acceptance-s1-security`, `eval-intake`,
`eval-classification` (Runner 2A), `eval-mcp-live` (M-LIVE, read-only).

This is where the unverified **"145 database checks"** figure can finally be reproduced or retired.
**Done when:** every DB-kind suite has a recorded result, and the 145 figure is `VERIFIED` or
formally `SUPERSEDED`.

## Stage 8 — Integrate cognition and dispatch

**Lands after Stage 3, and may land before Stages 4–7** — it touches no migration and no platform
package. One PR: `feat/cognition-dispatch-control-plane → main`, 43 files.

**Gate:** Runners V 45, CC 116, EV 117, CG 66, DP 63, OB 62, DB 49, RP 48 — all PASS; plus
`context:validate` and `context:check`.

## Stage 9 — Restore external operational artifacts

| Artifact | Action | Task |
|---|---|---|
| n8n | classify each workflow; define the adapter contract; **activate nothing** | `AWE-INT-103` |
| Supabase | applied state → `AWE_EVIDENCE_LEDGER.md` | `AWE-INT-104` |
| Obsidian historical vault | three-way reconcile: original ↔ Git ↔ `C:\AWE\vault` | `AWE-INT-108` |
| TEGG | separate bounded audit of `TRANSCEND`, **after** the platform is stable | later |

## Stage 10 — The controlled PR sequence

| Order | Title | Head → Base | Prereq |
|---|---|---|---|
| 1 | `feat: kernelize the MCP context and add the execution control plane` | `feat/kernelized-mcp-context` → `main` | A2 |
| 2 | `test(mcp): add opt-in live tenant-boundary proof` (#4) | → `main` | 1 |
| 3 | `feat: add bounded provider-neutral Agent Runtime` (#5) | → `main` | 2 |
| 4 | `feat: add tenant-bound versioned Memory Layer` (#6) | → `main` | 3 |
| 5 | `feat: add provider-neutral Durable Execution Plane` (#7) | → `main` | 4 |
| 6 | `feat: add cognition and dispatch control plane` | `feat/cognition-dispatch-control-plane` → `main` | 5 |
| 7 | `feat: land the Microsoft 365 Integration Plane` (#9) | → `main` | 6 + A3 + A4 |
| 8 | `refactor(m365): reduce parallel modules to platform adapters` | new branch → `main` | 7 |

Open PR #3 (`security/phase-1-remediation`) is **deliberately unscheduled** — it carries the
competing C1 implementation and cannot be ordered until Stage 4 step 4.3.

## Cross-cutting stop conditions

Stop and escalate on any of: a conflict appearing in `supabase/`, `packages/` or `scripts/` that this
plan did not predict · a runner count dropping below its recorded baseline · discovering that any
migration was applied remotely · a push attempted before A1 · a regression run that skips a suite it
should have run.
