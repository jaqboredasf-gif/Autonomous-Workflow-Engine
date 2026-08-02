# AWE Integration Plan

**Date:** 2026-08-01 · baseline `codex/durable-execution-plane` @ `55c0ba5`

Dependency-ordered. **Merging every stacked branch into `main` is not the next action** — the
migration identity question and the M365 layering question both come first, or the merge silently
produces a broken tree (see `AWE_MERGE_RISK_REPORT.md` §4).

Each phase names its packet ID. Packets are in `docs/integration/dispatch/`. **None have been executed.**

---

## Phase 0 — Preservation ✅ substantially done

| Item | State |
|---|---|
| All named branches pushed to GitHub | ✅ verified — 12 remote branches, no local-only work on this PC |
| Full clone with all branches and tags | ✅ `C:\AWE\repos\Autonomous-Workflow-Engine` |
| Runner evidence captured | ✅ `C:\AWE\evidence\runs-2026-08-01\` |
| Windows Lippolis/TEGG folder backed up | ✅ `C:\AWE\backups\LIPPOLIS-2026-08-01\` |
| Obsidian vault, n8n exports, real `.env` files | ❌ **MacBook-local, unprotected** → `AWE-INT-104` |

## Phase 1 — Evidence verification ✅ done for the offline surface

3,212 assertions reproduced, 0 failures, `regression: ALL GREEN [13 ran, 12 skipped]`. Two carried-in
figures (145 DB checks, 61 orchestration tests) reclassified `REPORTED_NOT_VERIFIED`. See
`AWE_EVIDENCE_LEDGER.md`.

Remaining: the 12 credential-gated suites, and `mcp-smoke` (needs `jq`).

## Phase 2 — Persistent Cognition ✅ established this session

`context/` (10 files) + `scripts/validate-context.mjs` + Runner V (45 assertions). **Maintaining it is
now a standing obligation** — policy P15.

## Phase 3 — Migration collision resolution 🔜 **next**

**Packet `AWE-INT-101`.** Decide the identity scheme (four-digit ordinals vs Supabase timestamps),
then plan the fix for all three competing artifacts. Written analysis only; **no migration file
changes**. Blocks Phases 4, 5, and 6.

## Phase 4 — Microsoft 365 reconciliation

**Packet `AWE-INT-102`.** Decide whether `packages/m365` becomes an adapter behind `awe-execution` or
stays standalone. Evidence is in `AWE_MERGE_RISK_REPORT.md`: 70 files, 5 overlapping, 3 conflicts,
and no shared platform packages. **Not a merge task.** Depends on Phase 3.

## Phase 5 — Open the base PR

`feat/kernelized-mcp-context` → `main` does not exist, so the 33-commit stack has no path to `main`
(C-103). **Requires explicit human instruction** — an agent must not open it. Depends on Phase 3.

## Phase 6 — Database replay once Docker works

**Packet `AWE-INT-103`.** Replay `0001`–`0016` against an empty PostgreSQL in an isolated container;
confirm the chain applies from scratch, RLS behaves, tenant isolation holds. Then run the 8
credential-gated DB suites against that local instance — **never against a shared or remote database**.

Blocked on: Docker daemon (WSL2 installed, no distribution — start Docker Desktop once).

## Phase 7 — MacBook artifact recovery

**Packet `AWE-INT-104`.** Obsidian vault → `C:\AWE\vault`; real `.env` shape → key-name-only
`.env.example` files for `apps/web`, `packages/mcp-server`, `packages/m365`; any saved evidence behind
the 145/61 figures. Independent of Phases 3–6; can run in parallel.

## Phase 8 — n8n export capture

**Packet `AWE-INT-105`.** Export every workflow read-only: IDs, names, active state, credential
*references* (never values), webhooks, external-send nodes, approval gates. Diff WF8 `e0d2b551`
(live, **ungated**) against `22d83e67` (hardened draft). **Activate nothing.** Highest operational
risk in the whole programme, because an ungated live workflow has side effects no policy governs.

## Phase 9 — Supabase state verification

**Packet `AWE-INT-106`.** Identify the project, list applied migrations, compare with the 16 files.
Read-only. Turns C-108's `UNKNOWN` into a fact.

## Phase 10 — Orchestration & Responsibility: locate or retire

**Packet `AWE-INT-107`.** Search the MacBook and any other remote. If found, preserve and assess. If
not found after a bounded search, **formally declare it nonexistent** and strike it from the
vocabulary. Do **not** reconstruct it from conversation history (P11).

## Phase 11 — TEGG audit (separate operation)

**Packet `AWE-INT-108`.** `jaqboredasf-gif/TRANSCEND`, branch `worktree-tegg-mock-sprint`. Bounded,
separate, and **must not influence AWE's architecture**. Not before Phases 3–6 are settled.

## Phase 12 — Coworker-facing delivery

Only after platform reliability: migration chain replayable, DB suites green, M365 reconciled, n8n
adapter defined. Nothing before then.

---

## Ordering rationale

The two questions that gate everything are **which migration identity scheme wins** and **whether
M365 sits behind the platform or beside it**. Both are human architectural decisions, cheap to make
and expensive to defer. Every merge, replay, and adapter task downstream inherits the answer.

Docker and `jq` are two-minute installs that unblock Phase 6 and one failing suite respectively —
the best effort-to-value ratio available right now.
