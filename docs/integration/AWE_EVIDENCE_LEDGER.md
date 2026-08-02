# AWE Evidence Ledger

**Date:** 2026-08-01 · `codex/durable-execution-plane` @ `55c0ba5`

The authoritative capability-by-capability ledger is `context/VERIFIED_EVIDENCE.md`. **This file
exists to do one job the context ledger does not: adjudicate the specific numbers carried in from
the AWE Unified Integration Handoff.** Those figures were repeated across sessions without a source,
and repetition is not verification.

Raw output: `C:\AWE\evidence\runs-2026-08-01\`.

---

## The five contested figures

| Handoff claim | What was searched | Result | Status |
|---|---|---|---|
| **"Runner A: 127 passing, 0 failing"** | Re-ran `bash scripts/eval-agent-runtime.sh` | `eval-agent-runtime (Runner A, offline, deterministic): passed=127 failed=0 [16 fixtures]` | **`VERIFIED`** — exact |
| **"Runner Y: 91 passing, 0 failing"** | Re-ran `bash scripts/eval-memory.sh` | `eval-memory (Runner Y, offline, deterministic): passed=91 failed=0 [9 fixtures]` | **`VERIFIED`** — exact |
| **"Runner K: 577 passing, 0 failing"** | Re-ran `bash scripts/eval-kernel.sh` | `passed=582 failed=0` | **`SUPERSEDED`** — the suite grew by 5. The claim was true when written; 582 is now the number |
| **"145 database checks — schema 23, security 57, functional 30, concurrency 17, tenant isolation 18"** | `grep -rn "145"` across `docs/`, `scripts/` filtered for check/schema/security/functional/concurrency/isolation; searched every branch tree for a DB-check harness producing a 145 total | **Zero hits.** No suite, no saved output, no artifact | **`REPORTED_NOT_VERIFIED`** |
| **"61 of 61 deterministic orchestration tests"** | `grep -rn "\b61\b" docs/`; searched all branches for an orchestration package, branch, or runner | **Zero relevant hits.** No orchestration package, branch, table, or suite exists on any of the 12 remote branches | **`REPORTED_NOT_VERIFIED`** |

**Rule for future sessions:** these two figures may not be restated as fact. If the underlying
evidence is found on the MacBook, attach the path and re-classify. Until then they are claims.

## What actually reproduces — 3,212 assertions, 0 failures

`bash scripts/regression.sh --kinds=unit,offline,static` → **`regression: ALL GREEN [13 ran, 12 skipped]`**, exit 0.

| Runner | Suite | Result |
|---|---|---|
| K | awe-kernel unit | 582 / 0 |
| M | kernelized MCP surface | 420 / 0 |
| E | execution outcomes + durable artifacts | 376 / 0 |
| P | execution control plane | 372 / 0 |
| 5 | approval queue | 349 / 0 |
| 4 | approval matrix + outbound | 327 / 0 |
| D | durable execution plane | 309 / 0 (16 fixtures) |
| C | context primitives | 138 / 0 |
| A | agent runtime | 127 / 0 (16 fixtures) |
| 3 | approval diff | 121 / 0 (15 fixtures) |
| Y | memory layer | 91 / 0 (9 fixtures) |
| V | context validator (**new**) | 45 / 0 |
| static | `validate-migration-0014`, `-0015` | pass |

## Failures and blocks — recorded, not hidden

| Item | Result | Classification |
|---|---|---|
| `mcp-smoke` | `scripts/smoke-mcp.sh: line 26: jq: command not found` → `FAIL (tools=0)` | **`FAILED`** — environment gap on this PC, not a code defect. Fix: install `jq`. |
| `eval-classification` (Runner 2A) | `SUPABASE_ACCESS_TOKEN: export SUPABASE_ACCESS_TOKEN (management token) first` | `LIVE_BLOCKED` — failed closed, which is correct |
| `acceptance-slice1`–`5`, `acceptance-s1-security`, `eval-intake` | not run — kind `db` deselected, missing credential | `LIVE_BLOCKED` |
| `eval-mcp-live` (M-LIVE) | not run — needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AWE_ORG_ID` | `LIVE_BLOCKED` |
| Isolated migration replay | not attempted | `LIVE_BLOCKED` — Docker daemon down, WSL2 has no distribution |
| `npm ci` | succeeded, but reports **17 vulnerabilities (12 moderate, 5 high)** and 2 unreviewed install scripts (`sharp`, `unrs-resolver`) | `VERIFIED` install / open security item |

## Evidence-rank note

`docs/planning/PRESERVATION_AUDIT.md` (branch `claude/awe-preservation-audit-iuq4k6`, pushed
2026-08-02 00:05 UTC by a parallel cloud session) independently reports the same branch topology, PR
states, `0016` collision, and orchestration/vault absence.

It is **rank 7** evidence — an agent handoff — and was used as corroboration only. Every overlapping
claim in this ledger was re-derived locally at rank 1–2. Its one correctable error: it classifies
TEGG as "NOT PRESENT ANYWHERE, P0 unprotected". TEGG is preserved in the private repo
`jaqboredasf-gif/TRANSCEND`, branch `worktree-tegg-mock-sprint`. That P0 is closed.
