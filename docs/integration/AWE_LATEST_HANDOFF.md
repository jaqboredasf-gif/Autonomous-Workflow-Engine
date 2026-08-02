# AWE Latest Handoff — integration workstream

**Date:** 2026-08-01 · **Branch:** `feat/persistent-cognition-compiler` · **Evidence baseline:** `55c0ba5`

> ## Update 2026-08-01 — the cognition layer became a capability
>
> The Persistent Cognition Layer is no longer a static set of documents. The **AWE Context Compiler**
> turns a human-defined objective into a bounded execution packet, so an agent starts from repository
> evidence rather than reconstructing AWE from conversation.
>
> ```bash
> npm run context:compile -- --objective "<text>" --task-id AWE-INT-101 --output .awe/packets/AWE-INT-101
> ```
>
> **Placement:** `scripts/lib/context-compiler/` — repo tooling, no new package. Pure core, single I/O
> module, so moving behind a service later replaces one file. Reasoning in
> `context/CRITICAL_DECISIONS.md`.
>
> **Verified:** Runner CC **114/0**, Runner V **45/0**, `validate-context` PASS, `context:check` PASS
> (0 staleness errors), and the platform regression still **`ALL GREEN [13 ran, 12 skipped]`** —
> **3,371 assertions, 0 failures** in total.
>
> **Dispatch is now compilable:** six structured tasks in `dispatch/tasks/` following
> `dispatch/TASK_FORMAT.md`, each generating its own packet. A task states intent; the compiler
> supplies grounded context. Generated packets live under the gitignored `.awe/`.
>
> **Not connected** to live agents, n8n, Supabase, Microsoft Graph, or any remote service. Two local
> commits on this branch; nothing pushed.

The operational handoff agents should read is **`context/LATEST_AGENT_HANDOFF.md`**. It is the single
place a session updates at the end of its work (policy P15), and duplicating it here would guarantee
the two drift apart.

This file records only what belongs to the integration workstream specifically.

---

## Session summary

A full clone was established on the Windows home PC, the stacked-branch hypothesis was **verified by
`git merge-base --is-ancestor`** rather than assumed, and the entire credential-free test surface was
reproduced: **3,212 assertions across 11 runners, 0 failures, `regression: ALL GREEN [13 ran, 12
skipped]`**.

Two figures carried through several handoffs were adjudicated: **Runner A (127) and Runner Y (91)
reproduce exactly**; the **"145 database checks" and "61 orchestration tests" have no reproducible
source anywhere in the repository** and are now `REPORTED_NOT_VERIFIED`.

The Persistent Cognition Layer (`context/`, 10 files) was created and is machine-validated by
`scripts/validate-context.mjs` with **Runner V (45 assertions)** covering the validator itself.

## Integration documents created

| File | Purpose |
|---|---|
| `AWE_ASSET_INVENTORY.md` | Exhaustive inventory: 8 packages, 16 migrations, 41 scripts, 53 docs, 12 branches, 9 PRs |
| `AWE_EVIDENCE_LEDGER.md` | Adjudicates the five contested figures from the earlier handoff |
| `AWE_COMPONENT_GRAPH.md` | Real import counts; where layering is convention rather than enforcement |
| `AWE_CONFLICT_REGISTER.md` | C-101 … C-111, all confirmed by inspection |
| `AWE_MERGE_RISK_REPORT.md` | Dry-run merge of the M365 branch: 5 overlaps, 3 conflicts, 1 silent trap |
| `AWE_INTEGRATION_PLAN.md` | Dependency-ordered phases 0–12 with packet IDs |
| `AWE_HOME_PC_BOOTSTRAP.md` | Verified setup; corrects the pnpm guidance to `npm ci` |
| `AWE_HOME_PC_PARITY_REPORT.md` | Full offline parity; nothing that needs a DB or credential |
| `dispatch/QUEUE.md` | Eight bounded packets, **none executed** |

## The three findings that should change what happens next

1. **`feat/kernelized-mcp-context` has no PR into `main`** (C-103). The whole 33-commit tower rests on
   a branch with no integration path. Nothing is lost; nothing can land.
2. **Slot `0016` is claimed three ways** (C-101), and a naive merge would produce two migration
   `0016`s **without Git warning**. This gates every migration-touching task.
3. **The repository is public** (C-109) while holding `BOSS_INTERVIEW.md`,
   `STAKEHOLDERS_AND_PERMISSIONS.md`, payroll and employee UI, and 12 email fixtures — while the
   activewear `TRANSCEND` repo is private. Not changed here; needs a human decision.

## Next bounded task

**`AWE-INT-101`** — resolve the `0016` migration-identity collision on paper. Full packet in
`context/AGENT_EXECUTION_PACKET.md`; **no migration file may be touched**.

Two minute-scale unblockers for a human: start Docker Desktop once (WSL2 is installed but has no
distribution), and `winget install jqlang.jq` (the only reason `mcp-smoke` fails).

## Not executed

No commit, push, merge, rebase, reset, force push, branch deletion, or PR change · no migration
created, modified, or applied · no database contacted · no Docker container started · no live Graph
call · no n8n contact · no email · no credential opened or committed · no visibility change · no file
deleted · the M365 branch was read with `git show` and `git merge-tree` and **never checked out** ·
`TRANSCEND` was not cloned or modified.
