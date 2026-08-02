# AWE Current State

**Last verified:** 2026-08-01
**Verified at commit:** `55c0ba5c2b4bdc807ee07f8c1f9b3a15f4f28e83`
**Verified on branch:** `codex/durable-execution-plane`
**Verified by:** Claude Code session on the Windows home PC (`C:\AWE\repos\Autonomous-Workflow-Engine`)

Every row carries an evidence status. Allowed values: `VERIFIED`, `PARTIALLY_VERIFIED`,
`REPORTED_NOT_VERIFIED`, `GENERATED_NOT_APPLIED`, `MOCK_ONLY`, `LIVE_BLOCKED`, `FAILED`,
`SUPERSEDED`, `UNKNOWN`.

---

## 1. Canonical repository

| Field | Value | Status |
|---|---|---|
| Repository | `https://github.com/jaqboredasf-gif/Autonomous-Workflow-Engine` | `VERIFIED` |
| Visibility | **PUBLIC** — see Blockers §8 | `VERIFIED` |
| Default branch | `main` @ `dbf8f17` | `VERIFIED` |
| Integration baseline | `codex/durable-execution-plane` @ `55c0ba5` — **+33 / −8 vs `main`** | `VERIFIED` |
| Package manager | **npm workspaces** (`package-lock.json`); no pnpm, no `packageManager` field | `VERIFIED` |
| Node requirement | `engines.node >= 20`; running 24.18.1 | `VERIFIED` |
| Tags | none | `VERIFIED` |
| Working tree | clean (one CRLF-normalization entry, zero content diff — §7) | `VERIFIED` |

## 2. Packages

All eight install and their offline suites pass.

| Package | npm name | Modules | Status |
|---|---|---|---|
| `packages/awe-kernel` | `@exattime/awe-kernel` 0.1.0 | 19 — `assembly`, `canonical`, `compaction`, `context-item`, `context`, `corpus`, `errors`, `events`, `execute`, `gates`, `outcome`, `reasons`, `registry`, `report`, `sinks`, `suite`, `tools`, `verify` | `VERIFIED` |
| `packages/awe-control-plane` | `@exattime/awe-control-plane` 0.1.0 | 8 — `dispatch`, `engine`, `journal`, `kernel`, `manifest`, `policy`, `workflow-registry` | `VERIFIED` |
| `packages/awe-agent-runtime` | `@exattime/awe-agent-runtime` 0.1.0 | 8 — `action`, `agent-registry`, `manifest`, `model`, `run-store`, `runtime`, `transcript` | `VERIFIED` |
| `packages/awe-memory` | `@exattime/awe-memory` 0.1.0 | 8 — `kernel`, `layer`, `manifest`, `memory-registry`, `record`, `retrieval`, `store` | `VERIFIED` |
| `packages/awe-execution` | `@exattime/awe-execution` 0.1.0 | 12 — `contracts`, `effects`, `kernel`, `recovery`, `replay`, `repository`, `retry`, `scheduler`, `service`, `state-machine`, `worker` | `VERIFIED` |
| `packages/awe-runtime` | `@exattime/awe-runtime` 0.1.0 | 11 — `agent-service`, `clock`, `control-plane-service`, `execution-service`, `file-sinks`, `journal-store`, `memory-service`, `result-store`, `service` | `VERIFIED` |
| `packages/mcp-server` | `@exattime/mcp-server` 0.0.1 | 6 — `data-port`, `fixtures`, `index.js`, `runtime`, `tenant`, `tools` | `VERIFIED` |
| `packages/shared` | `@exattime/shared` 0.0.1 | 2 — `index.ts`, `types.ts` | `VERIFIED` |

`awe-kernel` is the hub: 26 cross-package source imports point at it; `awe-control-plane` is next
with 4. No package declares another as an npm dependency — they resolve by relative path.

## 3. Database migrations

16 files, 2,286 lines, 23 tables. `VERIFIED` as **files present**; `UNKNOWN` as **applied state**
(no database was contacted).

```
0001_core(163) 0002_rls(73) 0003_geo_flags(48) 0004_admin_policies(23) 0005_storage_photos(11)
0006_foreman_updates(9) 0007_shifts_approval(83) 0008_automation_core(48) 0009_completion_events(177)
0010_timecard_corrections(136) 0011_request_intake(319) 0012_drop_orphan_schema(51)
0013_triage_events(65) 0014_approval_evidence(273) 0015_approval_matrix_outbound(727)
0016_drop_undeclared_client_policies(80)
```

Tables: `approval_drafts`, `approval_outcomes`, `category_authority`, `completion_reports`,
`cost_codes`, `crew_members`, `crews`, `email_messages`, `integration_events`, `job_sites`, `leads`,
`message_policies`, `org_settings`, `orgs`, `outbound_messages`, `pay_periods`, `payroll_exports`,
`service_areas`, `shifts`, `time_entries`, `time_entry_audits`, `timecard_corrections`, `users`,
`work_requests`.

> ⚠ **Slot `0016` is claimed three ways.** See [CRITICAL_DECISIONS.md](CRITICAL_DECISIONS.md) and
> `docs/architecture/decisions/0009-competing-c1-migration-artifacts.md`.

## 4. Open stacked branches — verified by `git merge-base --is-ancestor`

```
main (dbf8f17)
 └── feat/kernelized-mcp-context  19f5e1c  +20   ⚠ NO PR INTO main — the whole stack rests here
      └── codex/live-mcp-data-boundary  cf37090  +24   PR #4
           └── codex/agent-runtime      bfcb679  +26   PR #5
                └── codex/memory-layer  cf3335d  +28   PR #6
                     └── codex/durable-execution-plane  55c0ba5  +33   PR #7  ← baseline
```

All four predecessors confirmed ancestors of `55c0ba5`. Every PR in the chain is **open and draft**.
Off-stack: `claude/microsoft-365-integration-plane-fcsm1e` (`ad8589a`, +1, PR #9, based on `main`),
`security/phase-1-remediation` (+5, PR #3), `security/c1-policy-cleanup` (+1),
`chore/agent-handoff-integration` (+6, PR #1 closed unmerged),
`claude/awe-preservation-audit-iuq4k6` (+2, pushed 2026-08-02 00:05 UTC by a parallel cloud session).

## 5. Verified capabilities — reproduced on this machine 2026-08-01

`bash scripts/regression.sh --kinds=unit,offline,static` → **`regression: ALL GREEN [13 ran, 12 skipped]`**, exit 0.

| Runner | Suite | Assertions | Status |
|---|---|---|---|
| K | awe-kernel unit | **582** passed / 0 failed | `VERIFIED` |
| M | kernelized MCP surface | **420** / 0 | `VERIFIED` |
| E | execution-outcome + durable artifact | **376** / 0 | `VERIFIED` |
| P | execution control plane | **372** / 0 | `VERIFIED` |
| 5 | approval queue | **349** / 0 | `VERIFIED` |
| 4 | approval matrix + outbound draft | **327** / 0 | `VERIFIED` |
| D | durable execution plane | **309** / 0 (16 fixtures) | `VERIFIED` |
| C | context primitives | **138** / 0 | `VERIFIED` |
| A | agent runtime | **127** / 0 (16 fixtures) | `VERIFIED` |
| 3 | approval diff | **121** / 0 (15 fixtures) | `VERIFIED` |
| Y | memory layer | **91** / 0 (9 fixtures) | `VERIFIED` |
| — | `validate-migration-0014`, `-0015` | static lint, pass | `VERIFIED` |

**Total: 3,212 assertions, 0 failures.** Raw output: `C:\AWE\evidence\runs-2026-08-01\`.

The earlier handoff's figures reconcile as follows: **Runner A = 127 ✅ exact**, **Runner Y = 91 ✅
exact**, **Runner K = 582, not 577** (the suite grew by 5). The "145 database checks" and "61
orchestration tests" have **no reproducible source in this repository** → `REPORTED_NOT_VERIFIED`.

## 6. Partially verified / blocked

| Capability | Status | Why |
|---|---|---|
| Microsoft 365 Integration Plane | `MOCK_ONLY` | `packages/m365` exists only on `claude/microsoft-365-integration-plane-fcsm1e`; `fake-graph.ts` present; `docs/integrations/BLOCKED_LIVE_PROOF.md`. Not inspected by checkout this session (branch not checked out, per scope). |
| Migration application | `UNKNOWN` | No database contacted. Files exist; applied state unknown. |
| DB acceptance suites 1–5, S1-security, intake, classification | `LIVE_BLOCKED` | Require `SUPABASE_ACCESS_TOKEN`. Runner 2A failed closed with a clear message — correct behaviour. |
| `eval-mcp-live` (Runner M-LIVE) | `LIVE_BLOCKED` | Requires `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AWE_ORG_ID`. Not run. |
| `mcp-smoke` | `FAILED` (environment) | **`jq` is not installed on this PC.** `scripts/smoke-mcp.sh:26` → `jq: command not found` → `FAIL (tools=0)`. Not a code defect. |

## 7. Missing capabilities

| Capability | Status | Evidence |
|---|---|---|
| Orchestration & Responsibility Plane | `UNKNOWN` — absent | No package, no branch, no table. `work_package` **0 hits**, `replan` **0 hits**; `responsibility` 15 prose hits, `orchestration` 10. |
| Objective Plane | absent | `objective` = 8 hits, all in handoff prose and `validate-agent-handoff.sh` |
| n8n workflow exports | absent | 61 design references, **zero** workflow JSON files on any branch |
| Persistent Cognition Layer | **created by this session** | `context/` did not exist before 2026-08-01 |
| `AI_EGRESS`, `already_done`, `plan_valid`, `externalSendingEnabled` | **0 hits repo-wide** | Local recursive grep. These belong to n8n/TEGG, not this repo. |

## 8. Known external systems and blockers

| Item | State |
|---|---|
| **Docker** | **NOT OPERATIONAL.** WSL2 installed (default v2), **no distribution**; Docker Desktop 4.84.0 installed but daemon unreachable (`dockerDesktopLinuxEngine` pipe absent). Blocks all isolated database replay. |
| `jq` | not installed — blocks `mcp-smoke` |
| Supabase remote project | identity `UNKNOWN`; applied-migration state `UNKNOWN` |
| n8n instance | reachable state `UNKNOWN`; holds WF1–WF10, 309, 310 |
| **Repository visibility** | **PUBLIC** while containing `docs/planning/BOSS_INTERVIEW.md`, `STAKEHOLDERS_AND_PERMISSIONS.md`, payroll/employee UI, and `fixtures/emails/`. Not changed this session. |
| `npm ci` | succeeded; reports **17 vulnerabilities (12 moderate, 5 high)** and 2 packages with unreviewed install scripts (`sharp`, `unrs-resolver`) |

## 9. MacBook-only artifacts

1. **Orchestration & Responsibility Plane** — if it exists at all
2. **Obsidian Persistent Cognition vault** — 0 hits across all 11 remote branches
3. **n8n workflow exports** — WF1–WF10, 309, 310, both WF8 variants (`e0d2b551` live/ungated, `22d83e67` hardened)
4. **Supabase project identity and applied-migration state**
5. **Real `.env` files** — correctly gitignored; only `apps/mobile/.env.example` is tracked. No template exists for `apps/web`, `packages/mcp-server`, or `packages/m365`.
6. **Saved evidence** behind the "145 checks" and "61 tests" figures

TEGG is **not** a MacBook-only gap: it is preserved in the private repo
`jaqboredasf-gif/TRANSCEND` (branch `worktree-tegg-mock-sprint`, 26 test files). Out of scope here.
