# Latest Agent Handoff

**Date:** 2026-08-02
**Branch:** `feat/cognition-dispatch-control-plane`
**Commit:** `0c4f225` — the commit every claim below was verified against
**Session role:** Integrator (Windows home PC), working as `claude-code-home-integration-01`

---

## What this session was

The first **real** integration task run through the control plane rather than another capability
build. `AWE-INT-101` was dispatched, prepared, claimed, worked, submitted as a structured handoff,
and is now **`VERIFIED`** — nine checks passed, including the claimed file list matching the actual
commit range `a3961c0..0c4f225`.

## The four findings that change what happens next

**1. The platform stack was never structurally blocked.** `git merge-tree` across all nine branches
shows every one merges into `main` with **exactly one conflict**: `docs/planning/AGENT_HANDOFF.md`,
add/add. `main` advanced by 8 commits touching four files, and both sides rewrote that document.
What is missing is a pull request, not a merge path.

**2. A duplicate migration ordinal lands silently.** Merging M365 into the stack produces tree
`14079e5` containing both `0016_drop_undeclared_client_policies.sql` and
`0016_m365_integration_plane.sql`, while Git reports conflicts only in three unrelated documents.
It will never warn — the filenames differ.

**3. Two problems were wearing one label.** `0016_drop_undeclared` and
`20260727142118_phase1_c1` drop the **same 16 policies** — a real semantic choice between two
implementations. The M365 migration creates only `m365_*` tables and references only `orgs` and
`work_requests`, touching nothing either of them touches — a naming collision with a one-line fix.

**4. Two harness conflicts Git cannot show.** Resolving `regression.sh` toward the stack version
**silently deletes** M365's three suite registrations, because the stack moved the suite list out of
bash into the kernel registry — the tests stay on disk and never run again. And **Runner 6 is
claimed twice**, by ADR-0008 for the agent harness and by `scripts/eval-m365.sh`, in files that
never collide.

## What was produced

| Artifact | Purpose |
|---|---|
| `docs/integration/AWE_BRANCH_INTEGRATION_GRAPH.md` | Measured graph; four landing options analysed with recommendation |
| `docs/integration/AWE_MIGRATION_COLLISION_RESOLUTION.md` | Three artifacts compared; strategy proposed; seven blocking questions listed |
| `docs/integration/AWE_M365_RECONCILIATION_PLAN.md` | 70 files classified; landing order; prerequisites |
| `docs/integration/AWE_PLATFORM_LANDING_PLAN.md` | Ten operational stages with gates, evidence and stop conditions |
| `docs/integration/AWE_REPOSITORY_EXPOSURE_REVIEW.md` | Category-by-category disposition; push recommendation |
| `docs/architecture/decisions/0010-…-integration-strategy.md` | **`Proposed`** — six required human approvals |

## Recommendations, in priority order

1. **Make the repository private**, then decide file-by-file. The only reversible immediate action.
2. **Hold the unpushed cognition branches** until that decision — they *increase* exposure, and this
   handoff plus the exposure review together form a map of where the sensitive material is.
3. **Open the root PR** `feat/kernelized-mcp-context → main` — one doc conflict away from unblocking
   41 commits.
4. **Answer the seven Supabase questions** before any migration is renamed.

## What remains unknown

Whether any `0016` variant or the phase-1 timestamp migrations were ever applied remotely — this
blocks every rename. Whether the planning corpus is commercially sensitive (a business judgement,
not a repository fact). Whether the repository has already been cloned or indexed. The `0016_drop`
header saying "NOT YET APPLIED" is a **claim in a file**, not an observation of a database.

## Dispatch state

`AWE-INT-101` **VERIFIED**. Eight follow-ups dispatched and all **`BLOCKED`** on external inputs:
`AWE-INT-102` (visibility + MacBook), `103` (n8n), `104` (Supabase), `105` (depends 104+107),
`106` (Docker), `107` (root-PR instruction), `108` (original vault), `AWE-SEC-001` (owner decision).

None was marked `READY`, because none of their inputs exist.

## Next safest bounded task

**`AWE-SEC-001`** — the visibility decision. It gates the push of every local branch and is the only
item on the list that needs nothing but a judgement.

## What was intentionally not executed

No branch merged, rebased, cherry-picked or pushed · no PR opened or modified · no migration
created, modified, renamed or applied · no database, Supabase, n8n, Microsoft Graph or email contact
· no repository visibility change · no file deleted and no history rewritten · the M365 branch was
never checked out · no worker launched · the `0016` collision was **analysed, not resolved** · the
Orchestration Plane was **not** reconstructed · the historical MacBook vault was **not** imported.
