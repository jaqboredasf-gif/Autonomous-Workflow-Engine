# Active Capability Specification

**Capability ID:** `AWE-INT-UNIFY`
**Opened:** 2026-08-01
**Status:** ACTIVE
**Baseline:** `codex/durable-execution-plane` @ `55c0ba5`

---

## Objective

Unify and verify the existing AWE platform capabilities, and establish a trustworthy Persistent
Cognition Layer, **before** adding any additional platform capability.

## Scope

1. Reproduce and record every claimed capability from repository evidence — **done** for the 11
   offline runners (3,212 assertions, 0 failures).
2. Maintain `context/` as the Git-backed cognition layer, validated by a script. **✅ extended
   2026-08-01** — the layer is now compiler-backed: `npm run context:compile` turns an objective into
   a bounded execution packet, `npm run context:check` detects staleness. Runner V (45) and Runner CC
   (114) cover both.
3. Resolve the `0016` migration collision **on paper first** — a written plan with no migration file
   changed.
4. Reconcile the Microsoft 365 branch against the codex stack by **analysis only** (no checkout, no
   merge).
5. Recover the artifacts that exist only outside Git: Obsidian vault, n8n exports, Supabase remote
   state, and the Orchestration/Responsibility Plane if it exists at all.
6. Open the missing base PR for `feat/kernelized-mcp-context` → `main` **only on explicit human
   instruction**, since the entire 33-commit stack depends on it.

## Non-scope

- Any work in `jaqboredasf-gif/TRANSCEND` (TEGG). Related repository, later bounded audit.
- Merging, rebasing, or pushing any branch.
- Applying migrations anywhere.
- Live Microsoft Graph, live Supabase, n8n activation, outbound email.
- Building the Objective, Orchestration, or Responsibility planes. They do not exist; do not
  invent them from handoff prose.
- Coworker-facing UI.
- Changing repository visibility or deleting files.

## Dependencies

| Dependency | State | Blocks |
|---|---|---|
| Node ≥ 20 | ✅ 24.18.1 | — |
| `npm ci` | ✅ succeeds | — |
| Docker daemon | ❌ not running; WSL2 has no distribution | migration replay, DB acceptance suites |
| `jq` | ❌ not installed | `mcp-smoke` |
| `SUPABASE_ACCESS_TOKEN` | ❌ absent | 8 DB-kind suites |
| MacBook access | ❌ | vault, n8n exports, Supabase identity |

## Completion conditions

1. Every capability in [VERIFIED_EVIDENCE.md](VERIFIED_EVIDENCE.md) carries a status backed by rank
   1–4 evidence, or is explicitly `UNKNOWN` / `LIVE_BLOCKED`.
2. `context/` passes `node scripts/validate-context.mjs` **and** `npm run context:check` with zero
   errors. ✅ both PASS at 2026-08-01.
3. The `0016` collision has a written resolution plan with a named owner and a rollback.
4. The M365 branch has a file-level merge-risk report.
5. Docker runs, and the full migration chain replays cleanly against an empty database.
6. The Orchestration/Responsibility Plane is either located, or formally declared nonexistent and
   removed from the vocabulary.
7. A base PR exists for `feat/kernelized-mcp-context` → `main`.

## Required evidence

Reproducible runner output (not remembered numbers) · file paths with commit SHAs · migration
replay transcript from an isolated container · an n8n export index · a Supabase applied-migration
listing.

## Forbidden actions

`git push` · `git merge` · `git rebase` · `git reset --hard` · branch deletion · force push ·
`supabase db push` · any live provider call · sending email · activating a workflow · committing a
secret · changing repository visibility · deleting internal files.

## Known blockers

- **B1 — Docker not operational.** Highest-impact local blocker.
- **B2 — `feat/kernelized-mcp-context` has no PR into `main`.** The stack cannot integrate.
- **B3 — `0016` claimed three ways.** See ADR-0009.
- **B4 — Repository is public** with internal operational planning and email fixtures.
- **B5 — Orchestration/Responsibility Plane unlocated.**
- **B6 — No Supabase project identity**, so no applied-migration truth.
