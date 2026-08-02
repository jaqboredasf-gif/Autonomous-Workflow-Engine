# AWE Asset Inventory

**Date:** 2026-08-01 · **Branch:** `codex/durable-execution-plane` @ `55c0ba5` · **Method:** local
inspection of a full clone at `C:\AWE\repos\Autonomous-Workflow-Engine`.

For the orientation summary see `context/AWE_CURRENT_STATE.md`. This file is the exhaustive list.

---

## 1. Packages (8)

| Path | npm name | Version | Modules | Runner |
|---|---|---|---|---|
| `packages/awe-kernel` | `@exattime/awe-kernel` | 0.1.0 | 19 | K — 582 |
| `packages/awe-control-plane` | `@exattime/awe-control-plane` | 0.1.0 | 8 | P — 372 |
| `packages/awe-agent-runtime` | `@exattime/awe-agent-runtime` | 0.1.0 | 8 | A — 127 |
| `packages/awe-memory` | `@exattime/awe-memory` | 0.1.0 | 8 | Y — 91 |
| `packages/awe-execution` | `@exattime/awe-execution` | 0.1.0 | 12 | D — 309 |
| `packages/awe-runtime` | `@exattime/awe-runtime` | 0.1.0 | 11 | E — 376 |
| `packages/mcp-server` | `@exattime/mcp-server` | 0.0.1 | 6 | M — 420 |
| `packages/shared` | `@exattime/shared` | 0.0.1 | 2 (TS) | — |

Apps: `apps/web` (Next.js — approvals, completions, employees, flags, map, payroll, schedule, sites,
timesheets, settings), `apps/mobile` (Expo).

Root: npm workspaces `["apps/*", "packages/*"]`, `engines.node >= 20`, **no `scripts` block**,
`package-lock.json`. No `pnpm-workspace.yaml`, no `packageManager` field.

## 2. Migrations (16 files, 2,286 lines, 23 tables)

`0001_core`(163) `0002_rls`(73) `0003_geo_flags`(48) `0004_admin_policies`(23)
`0005_storage_photos`(11) `0006_foreman_updates`(9) `0007_shifts_approval`(83)
`0008_automation_core`(48) `0009_completion_events`(177) `0010_timecard_corrections`(136)
`0011_request_intake`(319) `0012_drop_orphan_schema`(51) `0013_triage_events`(65)
`0014_approval_evidence`(273) `0015_approval_matrix_outbound`(727)
`0016_drop_undeclared_client_policies`(80)

Tables: `approval_drafts` `approval_outcomes` `category_authority` `completion_reports` `cost_codes`
`crew_members` `crews` `email_messages` `integration_events` `job_sites` `leads` `message_policies`
`org_settings` `orgs` `outbound_messages` `pay_periods` `payroll_exports` `service_areas` `shifts`
`time_entries` `time_entry_audits` `timecard_corrections` `users` `work_requests`

Branch-specific `0016` variants: see `AWE_CONFLICT_REGISTER.md` C-101.

## 3. Evaluators and test scripts (41 scripts)

**Offline runners (ran green 2026-08-01):** `eval-kernel`(K 582) `eval-context`(C 138)
`eval-agent-runtime`(A 127) `eval-memory`(Y 91) `eval-durable-execution`(D 309) `eval-execution`(E 376)
`eval-control-plane`(P 372) `eval-mcp`(M 420) `eval-approval-diff`(3 121) `eval-approval-matrix`(4 327)
`eval-approval-queue`(5 349) — plus **`eval-context-validator`(V 45)** added by this session.

**Static:** `scripts/lib/validate-migration-0014.mjs`, `-0015.mjs`, `scripts/validate-agent-handoff.sh`,
**`scripts/validate-context.mjs`** (new).

**Credential-gated (not run):** `acceptance-slice1`–`5`, `acceptance-s1-security`, `eval-intake`(1),
`eval-classification`(2A), `eval-classification-live`(2B), `eval-mcp-live`(M-LIVE), `parity-route-live`.

**Build kind:** `mcp-smoke` (**fails here — `jq` missing**), mobile typecheck, web build.

**Orchestrator:** `scripts/regression.sh` — reads the suite registry at
`packages/awe-kernel/src/registry.mjs` via `scripts/lib/suite-plan.mjs`. 25 suites; 13 credential-free.
Supports `--dry-run`, `--kinds=`, `--only=`, `--exclude-kinds=`.

**Support libs:** `artifact-store` `runner-report` `suite-plan` `db` `model-adapters` `classification`
`approval-diff` `approval-matrix` `outbound-draft` `awe-reasons` `awe-execution` **`context-validator`** (new).

## 4. Fixtures

`fixtures/emails/` (12 cases + labels + `model_recorded.json`) · `fixtures/approvals/` (15 cases) ·
`fixtures/outbound/` (cases + labels + policies) · `fixtures/queue/` (cases + base-row + labels).
`fixtures/m365/` (22 notification cases + 4 state files) exists **only on the M365 branch**.

## 5. Documentation

**Architecture (13):** `AGENT_HARNESS{,_CONTRACTS,_DECISIONS,_DESIGN,_DOCTRINE,_GUARDRAILS,_H0_EXIT,_H1_BRIEF}.md`,
`AGENT_RUNTIME.md`, `DURABLE_EXECUTION_PLANE.md`, `EXECUTION_CONTROL_PLANE.md`, `MEMORY_LAYER.md`,
`UBIQUITOUS_LANGUAGE.md`.

**ADRs (9):** `0001`–`0009` — **all `Proposed`, all dated 2026-07-27, none ratified.**

**Guides (7):** `EXECUTION_{CHECKPOINTS,IDEMPOTENCY,LEASES,PAUSE_RESUME,REPLAY,RETRY_RECOVERY,WORKERS}.md`

**Planning (20):** incl. `AGENT_HANDOFF.md`, `CODEX_HANDOFF.md`, `EXECUTION_HANDOFF.md`,
`SESSION_HANDOFF.md`, `BOSS_INTERVIEW.md`, `STAKEHOLDERS_AND_PERMISSIONS.md`, `DATA_MODEL.md`,
`DECISION_LOG.md`, `TASK_BACKLOG.md`.

**Testing (4):** `APPROVAL_DIFF.md`, `APPROVAL_MATRIX.md`, `APPROVAL_QUEUE.md`, `EVAL_STRATEGY.md`

**Top level:** `API_CONTRACT.md`, `AUTOMATION_SYNERGY.md`, `GAP_ANALYSIS.md`, `REGRESSION_CHECKLIST.md`,
`ROADMAP.md`, `SECURITY_FINDINGS.md`.

**New this session:** `context/` (10 files), `docs/integration/` (8 files).

## 6. Branches (12 remote) and PRs (9)

See `context/AWE_SYSTEM_MAP.md` §7 for the topology diagram. Stack verified by
`git merge-base --is-ancestor`. No tags exist.

| PR | Head → Base | State |
|---|---|---|
| #9 | `claude/microsoft-365-integration-plane-fcsm1e` → `main` | OPEN draft |
| #7 | `codex/durable-execution-plane` → `codex/memory-layer` | OPEN draft |
| #6 | `codex/memory-layer` → `codex/agent-runtime` | OPEN draft |
| #5 | `codex/agent-runtime` → `codex/live-mcp-data-boundary` | OPEN draft |
| #4 | `codex/live-mcp-data-boundary` → `feat/kernelized-mcp-context` | OPEN draft |
| #3 | `security/phase-1-remediation` → `main` | OPEN draft |
| #2 | `chore/agent-handoff-clean` → `main` | MERGED |
| #1 | `chore/agent-handoff-integration` → `security/c1-policy-cleanup` | CLOSED unmerged |
| — | **`feat/kernelized-mcp-context` → `main`** | **DOES NOT EXIST — the stack has no path to `main`** |

Open issue #8: "Build Microsoft 365 Integration Verification Suite."

## 7. External systems

Supabase/PostgreSQL (project identity **UNKNOWN**) · Microsoft Graph (M365 branch, offline only) ·
MCP via `@modelcontextprotocol/sdk` · model providers (abstracted) · **n8n — referenced in 61 files,
zero code, zero exports**.

## 8. Missing artifacts

`AWE_CURRENT_STATE.md`/`AWE_SYSTEM_MAP.md`/`AGENT_EXECUTION_PACKET.md` — **created by this session** ·
`KNOWLEDGE_HANDOFF.md` — absent · `pnpm-workspace.yaml` — never existed · Orchestration &
Responsibility Plane — absent · Objective Plane — absent · n8n exports — absent ·
`.env.example` for `apps/web`, `packages/mcp-server`, `packages/m365` — absent (only
`apps/mobile/.env.example` is tracked).

## 9. MacBook-only dependencies

Obsidian vault · n8n exports (WF1–WF10, 309, 310, WF8 `e0d2b551` + `22d83e67`) · Supabase project
identity and applied-migration state · real `.env` files · saved evidence behind the "145 checks" and
"61 tests" figures · the Orchestration/Responsibility Plane if it exists.

## 10. Related external repository — not in scope

`jaqboredasf-gif/TRANSCEND` (**private**, default branch `claude/tegg-agent-gaps-af4ziv`). Despite the
name it contains the **TEGG** operational agent in Python: branch `worktree-tegg-mock-sprint` has 39
`src/tegg/` modules, **26 test files**, `FINAL_HANDOFF.md`, `docs/OPERATOR.md`, `config/mock_cases.yaml`.

**Recorded only.** Not cloned, not inspected in depth, not modified. Its name, structure, and contents
**must not influence AWE's architecture**. Requires its own bounded audit — packet `AWE-INT-108`.
