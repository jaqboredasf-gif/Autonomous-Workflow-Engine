# Verified Evidence Ledger

**Last verified:** 2026-08-01
**Branch / commit:** `codex/durable-execution-plane` @ `55c0ba5`
**Raw output retained at:** `C:\AWE\evidence\runs-2026-08-01\` (home PC, outside this repo)

Allowed statuses: `VERIFIED` · `PARTIALLY_VERIFIED` · `REPORTED_NOT_VERIFIED` ·
`GENERATED_NOT_APPLIED` · `MOCK_ONLY` · `LIVE_BLOCKED` · `FAILED` · `SUPERSEDED` · `UNKNOWN`

---

## A. Reproduced this session — rank 2 evidence (runner output)

| Capability | Claim | Evidence path | Runner | Commit | Status | Date | Limitations |
|---|---|---|---|---|---|---|---|
| Kernel | context/gates/outcome/reasons primitives work | `packages/awe-kernel/src/*` (19 modules) | K — `scripts/eval-kernel.sh` → **582/0** | 55c0ba5 | `VERIFIED` | 2026-08-01 | Pure unit; no DB, no network |
| MCP surface | Kernelized MCP execution surface; service layer reaches no DB directly | `packages/mcp-server/src/*` | M — `scripts/eval-mcp.sh` → **420/0** | 55c0ba5 | `VERIFIED` | 2026-08-01 | Offline; live boundary proof is `LIVE_BLOCKED` |
| Execution outcomes | Standardized outcomes + durable run artifacts | `packages/awe-runtime/src/*`, `scripts/lib/artifact-store.mjs` | E — `scripts/eval-execution.sh` → **376/0** | 55c0ba5 | `VERIFIED` | 2026-08-01 | Local filesystem sink only |
| Execution Control Plane | Dispatch, journal, policy, workflow registry | `packages/awe-control-plane/src/*`, `docs/architecture/EXECUTION_CONTROL_PLANE.md` | P — `scripts/eval-control-plane.sh` → **372/0** | 55c0ba5 | `VERIFIED` | 2026-08-01 | Introduced on `feat/kernelized-mcp-context` |
| Approval queue | Human gate surface (ADR-0006) | `apps/web/src/lib/approval-queue.ts`, `docs/testing/APPROVAL_QUEUE.md` | 5 → **349/0** | 55c0ba5 | `VERIFIED` | 2026-08-01 | Offline fixtures; browser-path RLS is `LIVE_BLOCKED` |
| Approval matrix + outbound | Matrix routing and outbound drafting | `supabase/migrations/0015_approval_matrix_outbound.sql` (727 lines), `scripts/lib/{approval-matrix,outbound-draft}.mjs` | 4 → **327/0** | 55c0ba5 | `VERIFIED` | 2026-08-01 | Engine/SQL parity is lint-level, not DB-level |
| **Durable Execution Plane** | Durable staged execution, recovery, resume, replay, idempotency, leases, dead-letter | `packages/awe-execution/src/*` (12 modules), `docs/guides/EXECUTION_*.md` (7) | D — `scripts/eval-durable-execution.sh` → **309/0**, 16 fixtures | 55c0ba5 | `VERIFIED` | 2026-08-01 | Offline; no real provider, no DB |
| Context primitives | Assembly, compaction, checkpoints | `packages/awe-kernel/src/{assembly,compaction,context,context-item,corpus}.mjs` | C → **138/0** | 55c0ba5 | `VERIFIED` | 2026-08-01 | Pure |
| **Agent Runtime** | Bounded, provider-neutral agent runtime | `packages/awe-agent-runtime/src/*` (8), `docs/architecture/AGENT_RUNTIME.md` | A — `scripts/eval-agent-runtime.sh` → **127/0**, 16 fixtures | 55c0ba5 | `VERIFIED` | 2026-08-01 | **Exactly matches the handoff's 127** |
| Approval diff | Deterministic approval diffing | `scripts/lib/approval-diff.mjs`, `docs/testing/APPROVAL_DIFF.md` | 3 → **121/0**, 15 fixtures | 55c0ba5 | `VERIFIED` | 2026-08-01 | Offline |
| **Memory Layer** | Tenant-bound, versioned, replayable memory | `packages/awe-memory/src/*` (8), `docs/architecture/MEMORY_LAYER.md` | Y — `scripts/eval-memory.sh` → **91/0**, 9 fixtures | 55c0ba5 | `VERIFIED` | 2026-08-01 | **Exactly matches the handoff's 91** |
| Migration lint 0014/0015 | Structural validity, engine/SQL parity | `scripts/lib/validate-migration-001{4,5}.mjs` | static — pass | 55c0ba5 | `VERIFIED` | 2026-08-01 | Lint only; proves nothing about an applied DB |
| **Full credential-free regression** | — | `scripts/regression.sh --kinds=unit,offline,static` | **ALL GREEN [13 ran, 12 skipped]**, exit 0 | 55c0ba5 | `VERIFIED` | 2026-08-01 | 12 suites skipped for missing credentials |

| Context validator | Required files, sections, statuses, dates, paths, handoff anchors, packet fields, secret scan | `scripts/lib/context-validator.mjs` | V — `scripts/eval-context-validator.sh` → **45/0** | 53b8f7f | `VERIFIED` | 2026-08-01 | Validates structure, not truth — `context:check` covers truth |
| **Context Compiler** | An objective compiles to a bounded packet; every claim traceable; absence reported; unverified claims flagged not dropped | `scripts/lib/context-compiler/*.mjs` | CC — `scripts/eval-context-compiler.sh` → **114/0** | 53b8f7f | `VERIFIED` | 2026-08-01 | Pure core only. `fs-sources.mjs` is exercised by CLI runs, not by Runner CC |
| Packet generation (end to end) | Three real packets built from live repository state | `.awe/packets/AWE-INT-{101,102,103}/` | `npm run context:compile` — exit 0, 63 sources from 249 records each | 53b8f7f | `VERIFIED` | 2026-08-01 | Output is gitignored by design; regenerate rather than trust a stored copy |
| Context freshness | Stale, cross-branch and non-existent commit references detected; PASS at HEAD | `scripts/context-check.mjs` | `npm run context:check` → **0 staleness errors, 31 warnings, PASS** | 53b8f7f | `VERIFIED` | 2026-08-01 | Reports only; never rewrites context |

| AWE-INT-101 | eval-context-compiler was run | 0c4f22588d657b50bee7833d310e714910e9e846 | `VERIFIED` | 2026-08-02 | from handoff AWE-INT-101, ingested |
| AWE-INT-101 | eval-evidence was run | 0c4f22588d657b50bee7833d310e714910e9e846 | `VERIFIED` | 2026-08-02 | from handoff AWE-INT-101, ingested |
| AWE-INT-101 | eval-dispatch was run | 0c4f22588d657b50bee7833d310e714910e9e846 | `VERIFIED` | 2026-08-02 | from handoff AWE-INT-101, ingested |
| AWE-INT-101 | docs/integration/AWE_BRANCH_INTEGRATION_GRAPH.md was created | 0c4f22588d657b50bee7833d310e714910e9e846 | `PARTIALLY_VERIFIED` | 2026-08-02 | from handoff AWE-INT-101, ingested |
| AWE-INT-101 | docs/integration/AWE_MIGRATION_COLLISION_RESOLUTION.md was created | 0c4f22588d657b50bee7833d310e714910e9e846 | `PARTIALLY_VERIFIED` | 2026-08-02 | from handoff AWE-INT-101, ingested |
| AWE-INT-101 | docs/integration/AWE_M365_RECONCILIATION_PLAN.md was created | 0c4f22588d657b50bee7833d310e714910e9e846 | `PARTIALLY_VERIFIED` | 2026-08-02 | from handoff AWE-INT-101, ingested |
| AWE-INT-101 | docs/integration/AWE_PLATFORM_LANDING_PLAN.md was created | 0c4f22588d657b50bee7833d310e714910e9e846 | `PARTIALLY_VERIFIED` | 2026-08-02 | from handoff AWE-INT-101, ingested |
| AWE-INT-101 | docs/integration/AWE_REPOSITORY_EXPOSURE_REVIEW.md was created | 0c4f22588d657b50bee7833d310e714910e9e846 | `PARTIALLY_VERIFIED` | 2026-08-02 | from handoff AWE-INT-101, ingested |
| AWE-INT-101 | docs/architecture/decisions/0010-awe-platform-integration-strategy.md was created | 0c4f22588d657b50bee7833d310e714910e9e846 | `PARTIALLY_VERIFIED` | 2026-08-02 | from handoff AWE-INT-101, ingested |
| AWE-INT-101 | context/CRITICAL_DECISIONS.md was modified | 0c4f22588d657b50bee7833d310e714910e9e846 | `PARTIALLY_VERIFIED` | 2026-08-02 | from handoff AWE-INT-101, ingested |

**Total reproduced: 3,371 assertions, 0 failures** (3,212 platform + 45 validator + 114 compiler).

## B. Structure verified, behaviour not

| Capability | Claim | Evidence | Status | Limitations |
|---|---|---|---|---|
| Package stack | 8 packages under `@exattime/*` | `packages/*/package.json` | `VERIFIED` | Boundaries are relative-path convention, not npm deps |
| Branch stack | 4 branches are ancestors of `55c0ba5` | `git merge-base --is-ancestor` — all 4 true | `VERIFIED` | — |
| Migrations exist | 16 files, 2,286 lines, 23 tables | `supabase/migrations/` | `VERIFIED` (files) / `UNKNOWN` (applied) | No database was contacted |
| Tenant isolation | RLS + tenant boundary | `0002_rls.sql`, `packages/mcp-server/src/tenant.mjs`; Runner M + Runner D assertions | `PARTIALLY_VERIFIED` | Offline assertions only; DB-level RLS proof is `LIVE_BLOCKED` |
| M365 Integration Plane | `packages/m365`, 26 modules, offline slice | branch `claude/microsoft-365-integration-plane-fcsm1e` @ `ad8589a`, PR #9 | `MOCK_ONLY` | Not checked out this session (out of scope); `fake-graph.ts`; `docs/integrations/BLOCKED_LIVE_PROOF.md` |

## C. Blocked

| Capability | Status | Blocker |
|---|---|---|
| Acceptance slices 1–5, S1-security, eval-intake, eval-classification (Runner 2A) | `LIVE_BLOCKED` | `SUPABASE_ACCESS_TOKEN` absent. Runner 2A failed closed with an explicit message — correct behaviour |
| `eval-mcp-live` (Runner M-LIVE) | `LIVE_BLOCKED` | Needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AWE_ORG_ID` |
| Isolated migration replay | `LIVE_BLOCKED` | Docker daemon not running; WSL2 has no distribution |
| `mcp-smoke` | **`FAILED`** | **`jq` not installed** — `scripts/smoke-mcp.sh:26` → `jq: command not found` → `FAIL (tools=0)`. Environment gap, not a code defect |

## D. Reported but not verified — do not promote without a re-run

| Claim | Source | Search performed | Status |
|---|---|---|---|
| "Runner K: 577 passing" | handoff §3.1/§3.2 | Re-ran: **582/0** | `SUPERSEDED` — suite grew by 5 |
| "145 database checks (schema 23, security 57, functional 30, concurrency 17, tenant isolation 18)" | handoff §3.4 | grep for `145` + check/schema/security/functional/concurrency/isolation across `docs/`, `scripts/` → **0 hits** | `REPORTED_NOT_VERIFIED` |
| "61 of 61 deterministic orchestration tests" | handoff §3.5 | grep `\b61\b` across `docs/` → 0 relevant hits; no orchestration package/branch/suite | `REPORTED_NOT_VERIFIED` |
| "Migration 005 generated but not applied" | handoff §3.5 | `0005_storage_photos.sql` is 11 lines and merged into `main` | `SUPERSEDED` — the handoff's numbering does not map |
| n8n planner returned `plan_valid: true`, five AI primitives, WF2 step 11 | handoff §3.7 | `plan_valid` **0 hits**; no workflow export tracked | `UNKNOWN` — n8n-side only |
| Workflows 309/310, WF1–WF10, `externalSendingEnabled` | handoff §3.7/§3.8 | `externalSendingEnabled` **0 hits**; zero export files | `UNKNOWN` — n8n-side only |
| Orchestration & Responsibility Plane | handoff §3.5 | No package, branch, table, or doc. `work_package` 0, `replan` 0, `responsibility` 15 prose hits | `UNKNOWN` — absent from Git |
| Obsidian Persistent Cognition vault | handoff §4 | 0 hits across all 11 remote branches | `UNKNOWN` — Mac-local |

## E. Corroborating independent audit

`docs/planning/PRESERVATION_AUDIT.md` on `claude/awe-preservation-audit-iuq4k6` (pushed 2026-08-02
00:05 UTC by a parallel cloud session) independently reached the same branch topology, PR states,
`0016` collision, and orchestration/vault absence. It is **rank 7 evidence** (agent handoff) and was
treated as corroboration, not proof — every overlapping claim above was re-derived locally.

Its one gap this session closes: it reports TEGG as "NOT PRESENT ANYWHERE / P0 unprotected". TEGG is
in fact preserved in the private repo `jaqboredasf-gif/TRANSCEND`, branch `worktree-tegg-mock-sprint`
(39 modules, 26 test files, `FINAL_HANDOFF.md`). **That P0 is resolved**, and TEGG is out of scope here.
