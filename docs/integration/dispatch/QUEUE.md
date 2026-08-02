# Dispatch Queue

**Created:** 2026-08-01 at `codex/durable-execution-plane` @ `55c0ba5`
**Status: every packet below is QUEUED. None has been executed.**

Each packet follows the template in `context/AGENT_EXECUTION_PACKET.md`. Universal forbidden actions
for all packets: push · merge · rebase · reset · force push · branch deletion · applying a migration
in any environment · live provider call · outbound email · n8n activation · secret exposure ·
repository visibility change · file deletion.

> **Machine-readable tasks now live in `tasks/`.** Six of the packets below have a structured task
> file — `tasks/AWE-INT-101.md` … `tasks/AWE-INT-106.md` — carrying scope, prohibitions, tests,
> completion evidence and an assigned role in the format documented in
> [TASK_FORMAT.md](TASK_FORMAT.md). Each one compiles straight into an execution packet:
>
> ```bash
> npm run context:compile -- --objective "<objective>" --task-id AWE-INT-101 --capability migration-identity --output .awe/packets/AWE-INT-101
> ```
>
> A task states **intent**; the compiler supplies **grounded context** — repository identity, current
> Git state, mandatory policies, blockers, and a source manifest. They are kept separate so a task
> file never rots into a stale mini-handoff. Generated packets live under the gitignored `.awe/`.

| ID | Task | Depends on | Blocked by | Priority |
|---|---|---|---|---|
| `AWE-INT-101` | Migration identity resolution | — | — | **P0 — next** |
| `AWE-INT-104` | MacBook artifact preservation | — | MacBook access | **P0 — parallel** |
| `AWE-INT-105` | n8n export recovery | — | n8n access | **P0 — parallel** |
| `AWE-INT-102` | M365 reconciliation | 101 | — | P1 |
| `AWE-INT-103` | Docker / database replay | 101 | Docker daemon | P1 |
| `AWE-INT-106` | Supabase state verification | — | project identity | P1 |
| `AWE-INT-107` | Orchestration recovery or retirement | — | MacBook access | P2 |
| `AWE-INT-108` | TEGG audit | 101–103 | — | P3 |

---

## AWE-INT-101 — Migration identity resolution

**Objective:** produce `docs/planning/MIGRATION_IDENTITY_RESOLUTION.md` deciding between four-digit
ordinals and Supabase timestamp identities, and planning the fix for all three competing `0016`
artifacts — **changing no migration file**.
**Scope:** create that one document; update `context/VERIFIED_EVIDENCE.md` and
`context/LATEST_AGENT_HANDOFF.md`.
**Forbidden additionally:** any change under `supabase/`; checking out the M365 or phase-1 branches
(use `git show`); guessing the canonical scheme instead of presenting options.
**Tests:** `bash scripts/regression.sh --only=validate-migration-0014,validate-migration-0015`
**Done when:** the document names the options, consequences, a recommendation with reasoning, a
rollback, and the human decision required — and `git status --short supabase/` is empty.
**Full packet:** `context/AGENT_EXECUTION_PACKET.md` Part 2.

## AWE-INT-102 — Microsoft 365 reconciliation

**Objective:** decide whether `packages/m365` becomes an adapter behind `awe-execution` or stays
standalone, and write the reconciliation design.
**Evidence to start from:** `docs/integration/AWE_MERGE_RISK_REPORT.md` — 70 files vs 162, 5
overlapping paths, 3 conflicts (`AGENT_HANDOFF.md` add/add, `DECISION_LOG.md` content,
`scripts/regression.sh` content), and the silent `0016` trap.
**Key fact:** the M365 branch has **none** of the six `awe-*` packages, so its `policy.ts`,
`evidence.ts`, `credentials.ts`, `contracts.ts` are parallel implementations, not reuse.
**Forbidden additionally:** merging, rebasing, or cherry-picking either branch; checking out the M365
branch; resolving `scripts/regression.sh` by picking a side (M365's suites must be registered in
`packages/awe-kernel/src/registry.mjs`, which is a code change).
**Done when:** a design document states the chosen layering, the suites to register, and the ordered
steps — with no branch modified.

## AWE-INT-103 — Docker and database replay

**Objective:** replay `0001`–`0016` against an **empty PostgreSQL in an isolated container**; confirm
the chain applies from scratch, RLS behaves, tenant isolation holds. Then run the 8 credential-gated
DB suites against that local instance only.
**Prerequisite:** Docker Desktop launched once (WSL2 is installed but has no distribution).
**Forbidden additionally:** pointing any replay at a shared, remote, or production database;
`supabase db push`; using real credentials.
**Done when:** a fresh database applies the canonical chain, the transcript is saved to
`C:\AWE\evidence\`, and every failure is recorded rather than worked around.

## AWE-INT-104 — MacBook artifact preservation

**Objective:** get the unprotected Mac-local artifacts under protection.
**Targets:** Obsidian Persistent Cognition vault → `C:\AWE\vault` and compare against `context/`;
key-name-only `.env.example` templates for `apps/web`, `packages/mcp-server`, `packages/m365`; any
saved evidence behind the "145 checks" / "61 tests" figures; `git branch -vv` output proving no
local-only branch exists.
**Forbidden additionally:** committing any real `.env`, key, or token — **key names only**.
**Done when:** the vault is copied, the templates exist, and the branch listing is recorded.

## AWE-INT-105 — n8n export recovery

**Objective:** export every workflow read-only and index them.
**Capture per workflow:** ID, name, active state, updated timestamp, credential *references* (never
values), webhooks, external-send nodes, approval gates, unpublished dependencies.
**Specifically:** WF1–WF10, Evaluator 309, Planner 310, the five AI primitives, and **both WF8
variants — `e0d2b551` (live, ungated) and `22d83e67` (hardened draft)** — then diff them.
**Forbidden additionally:** activating, publishing, executing, or modifying any workflow; using a
real recipient; any external send.
**Why it is P0:** a live ungated workflow can produce side effects no platform policy governs, and no
export exists anywhere. Highest operational risk in the programme.

## AWE-INT-106 — Supabase state verification

**Objective:** identify the AWE Supabase project and list its applied migrations; compare with the 16
tracked files.
**Forbidden additionally:** applying or reverting any migration; writing to any remote database;
recording a key or connection string in any file.
**Done when:** C-108's `UNKNOWN` becomes a fact, and any drift between applied state and tracked
files is documented.

## AWE-INT-107 — Orchestration & Responsibility: locate or retire

**Objective:** settle whether the Orchestration & Responsibility Plane exists anywhere.
**Evidence so far:** absent from all 12 remote branches. `work_package` 0 hits, `replan` 0 hits;
`responsibility` 15 prose hits, `orchestration` 10. No package, branch, table, or runner.
**Forbidden additionally:** **reconstructing it from conversation history** (policy P11); adding an
orchestration package speculatively.
**Done when:** it is either located and preserved, or formally declared nonexistent and struck from
`context/AWE_UBIQUITOUS_LANGUAGE.md`.

## AWE-INT-108 — TEGG audit (separate bounded operation)

**Objective:** audit `jaqboredasf-gif/TRANSCEND`, branch `worktree-tegg-mock-sprint` (39
`src/tegg/` modules, 26 test files, `FINAL_HANDOFF.md`), and decide what — if anything — becomes a
reusable AWE capability.
**Hard constraint:** TEGG's name, structure, and contents **must not influence AWE's architecture**.
This runs after Phases 3–6 are settled, in its own session.
**Also in scope:** confirm the superseded Windows ancestor at
`C:\AWE\backups\LIPPOLIS-2026-08-01\tegg-report-agent\` is formally retired, and that the pasted TEGG
password reported in its handoff was rotated.
**Forbidden additionally:** modifying `TRANSCEND`; copying TEGG code into this repository; copying
the LIPPOLIS Claude transcripts anywhere (they are secret-bearing).
