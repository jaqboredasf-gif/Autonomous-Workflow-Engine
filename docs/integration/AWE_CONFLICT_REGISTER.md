# AWE Conflict Register

**Date:** 2026-08-01 · `codex/durable-execution-plane` @ `55c0ba5`
All conflicts below are **confirmed by repository inspection**, not inferred from documents.
Nothing in this session changed migration files, branch visibility, or deleted anything.

---

## C-101 — Slot `0016` is claimed three ways · **severity: high · blocks all migration work**

| Branch(es) | File claiming `0016` |
|---|---|
| codex stack + `security/c1-policy-cleanup` + `chore/agent-handoff-integration` | `0016_drop_undeclared_client_policies.sql` (80 lines) |
| `claude/microsoft-365-integration-plane-fcsm1e` | `0016_m365_integration_plane.sql` (~406 lines) |
| `security/phase-1-remediation` | `20260727142118_phase1_c1_remove_undeclared_policies.sql` + `…142120_c2`, `…142121_c3`, `…142123_c4` |

Two files claim the same ordinal, and a third branch re-solves the **same C1 problem** under an
**incompatible identity scheme** (Supabase timestamps vs four-digit ordinals). These cannot all merge
as written. Already acknowledged in-repo by ADR-0009 — which documented *two* artifacts; verification
shows *three*.

**The undecided question:** does this project use sequential ordinals or timestamp identities?
That answer determines the fix for all three. **Do not guess it.** → packet `AWE-INT-101`.

## C-102 — The M365 branch diverges from the codex stack · **severity: high**

`claude/microsoft-365-integration-plane-fcsm1e` (`ad8589a`) is **+1 / −0 from `main`** — it branched
from `main`, **not** from the codex stack. Consequences, verified by tree comparison (no checkout):

- It has `packages/{m365, mcp-server, shared}` and **none** of `awe-kernel`, `awe-control-plane`,
  `awe-agent-runtime`, `awe-memory`, `awe-execution`, `awe-runtime`.
- So `packages/m365` cannot import the kernel, the policy gate, the journal, or the durable execution
  plane. Its policy/evidence/credential handling is **parallel implementation**, not reuse.
- PR #9 targets `main`; PR #7 targets `codex/memory-layer`. They will not meet without a decision.

**Not a merge task.** Architectural reconciliation: decide whether `packages/m365` becomes an adapter
behind `awe-execution` or stays standalone. → packet `AWE-INT-102`.

## C-103 — The stack has no path to `main` · **severity: high**

`feat/kernelized-mcp-context` (+20) is the root of the 33-commit tower and **has no pull request into
`main`**. PRs #4–#7 each target the branch below them, so the chain terminates at a branch with no
open integration path. Nothing is lost; nothing can land either.

**Do not open that PR without explicit human instruction** — 33 commits depend on its base.

## C-104 — The earlier handoff's migration numbering is wrong · **severity: medium · resolved here**

Handoff: "Migration 004 = Execution Control", "migration 005 = Orchestration, generated not applied".
Repository: `0004_admin_policies.sql` (23 lines), `0005_storage_photos.sql` (11 lines) — neither
relates, both merged into `main` long ago. The real chain is `0001`–`0016`.

**Status: SUPERSEDED.** Recorded so no future session re-imports it.

## C-105 — The Orchestration & Responsibility Plane does not exist · **severity: high**

Claimed: objective/work-package/task models, role/worker/capability registries, responsibility
resolver, separation of duties, durable queue, planner, scheduler, SLA/escalation, outcome evaluator,
replanning; 61/61 tests; migration 005.

Verified across all 12 remote branches: **no package, no branch, no table, no runner, no doc.**
`work_package` **0 hits**. `replan` **0 hits**. `responsibility` 15 prose hits in 10 files;
`orchestration` 10 prose hits in 6 files — adjectives, never components.

The nearest real mechanism is **approval-matrix routing with a backup owner**
(`0015_approval_matrix_outbound.sql`, `fixtures/outbound/cases/06_backup_owner_routing.json`).
Separation of duties is **not implemented**.

**Do not reconstruct this from conversation history** (P11). Either locate it on the MacBook or
formally declare it nonexistent. → packet `AWE-INT-107`.

## C-106 — No Persistent Cognition Layer existed before this session · **severity: medium · resolved**

`context/` did not exist. No `AWE_CURRENT_STATE.md`, `AWE_SYSTEM_MAP.md`, or
`AGENT_EXECUTION_PACKET.md` on any branch; zero hits for "Obsidian" or "Persistent Cognition".
Every session therefore re-derived AWE from scratch — the exact failure the layer prevents.

**Created this session**, Git-backed, with `scripts/validate-context.mjs` + Runner V (45 assertions).
The Obsidian vault remains MacBook-local and unprotected.

## C-107 — No n8n export is tracked anywhere · **severity: high · operational risk**

n8n appears in 61 files as **design references only**. Filename search across all 12 branches:
**zero workflow JSON**. `externalSendingEnabled` and `plan_valid`: **0 hits repo-wide** — they are
n8n-side properties.

So WF1–WF10, Evaluator 309, Planner 310, the five AI primitives, and both WF8 variants
(`e0d2b551` live/**ungated**, `22d83e67` hardened draft) exist **only inside the n8n instance**. A
live ungated workflow is by definition capable of side effects no platform policy governs, and it has
no backup.

**Standing rule:** nothing about WF8 is modified, activated, or deleted until both variants are
exported and diffed. → packet `AWE-INT-105`.

## C-108 — Supabase project identity and applied-migration state are unknown · **severity: high**

`supabase/config.toml` is tracked on every branch, but the **remote project reference is unknown**
from this machine and no database was contacted. So: migration files are `VERIFIED`; **applied state
is `UNKNOWN`**. Any claim that "migrations 002–004 were applied" is unsupported here.

Compounding: `.env`/`.env.*` are correctly gitignored, and the only tracked template is
`apps/mobile/.env.example`. There is **no** `.env.example` for `apps/web`, `packages/mcp-server`, or
`packages/m365`, so even the *shape* of the configuration exists only on the MacBook. Adding
key-name-only templates would close that without exposing values. → packet `AWE-INT-106`.

## C-109 — The repository is PUBLIC while holding internal operational material · **severity: high**

`jaqboredasf-gif/Autonomous-Workflow-Engine` is **public**. Tracked content includes:

- `docs/planning/BOSS_INTERVIEW.md`, `STAKEHOLDERS_AND_PERMISSIONS.md`, `PROJECT_SCOPE.md`, `CONTEXT.md`
- `apps/web/src/app/payroll/page.tsx`, `apps/web/src/app/employees/page.tsx`
- `fixtures/emails/` — 12 message cases with `labels.json` and `model_recorded.json`
- Named business context: "Lippolis" appears in 17 tracked files on `main`
- `docs/SECURITY_FINDINGS.md` and `security/*` branches describing known weaknesses

Meanwhile the **activewear side project `TRANSCEND` is private**. That is very likely backwards.

**Not changed this session** — visibility change and file deletion are both out of scope. This needs
a human decision, and it should be made before more business content lands.

## C-110 — Supply-chain and secret-hygiene items found in passing · **severity: medium**

- `npm ci` reports **17 vulnerabilities (12 moderate, 5 high)**. Not triaged this session.
- Two packages have install scripts not covered by `allowScripts`: `sharp@0.34.5`,
  `unrs-resolver@1.12.2`. npm is currently deferring them; a future `npm approve-scripts` is a
  security decision, not a formality.
- No secret value was found in tracked files. `scripts/validate-context.mjs` now scans `context/`
  for token-shaped literals on every run.
- **Outside this repo:** `C:\Users\jackd\.claude\projects\C--Users-jackd-LIPPOLIS\*.jsonl` reportedly
  contains a pasted TEGG password (per the local TEGG handoff). Never copy those transcripts into
  this or any repository.

## C-111 — All nine ADRs are unratified · **severity: medium**

Every ADR `0001`–`0009` reads **"Proposed (2026-07-27) — awaiting Jack's ratification."** The
platform — agent runtime existence, service-role DB path, library-not-daemon, JSON output contract,
human-gate surface, kill-switch home, runner numbering — rests on nine decisions nobody has accepted.

Cheap to fix, and it converts a large block of implicit risk into explicit agreement.

---

## Summary

| ID | Conflict | Severity | Blocks |
|---|---|---|---|
| C-101 | `0016` claimed three ways | High | all migration work |
| C-102 | M365 branch off-stack | High | M365 integration |
| C-103 | Stack has no PR into `main` | High | all integration |
| C-104 | Handoff migration numbering wrong | Medium | resolved |
| C-105 | Orchestration/Responsibility absent | High | vocabulary, roadmap |
| C-106 | No cognition layer | Medium | resolved this session |
| C-107 | No n8n exports | High | n8n adapter work |
| C-108 | Supabase identity/applied state unknown | High | DB verification |
| C-109 | Public repo, internal content | High | needs a human decision |
| C-110 | 17 npm vulns, 2 unreviewed install scripts | Medium | security triage |
| C-111 | Nine unratified ADRs | Medium | architectural certainty |
