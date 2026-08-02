# Merge-Risk Report — M365 branch vs the codex stack

**Date:** 2026-08-01
**Compared:** `origin/claude/microsoft-365-integration-plane-fcsm1e` (`ad8589a`) against
`codex/durable-execution-plane` (`55c0ba5`)
**Method:** `git diff --name-only` three-dot ranges, plus `git merge-tree --write-tree` — a **dry-run
merge that touches no ref, no branch, and no working tree**. The M365 branch was never checked out.

**This report describes risk. It proposes no merge and performs none.**

---

## 1. Surface area

| | Files changed vs `main` |
|---|---|
| `claude/microsoft-365-integration-plane-fcsm1e` | **70** |
| `codex/durable-execution-plane` | **162** |
| **Overlap (both touch the same path)** | **5** |

Only 5 of 232 touched paths are shared. The branches are **far more independent than their sizes
suggest** — the real difficulty is architectural, not textual.

## 2. Dry-run merge result

`git merge-tree --write-tree origin/claude/microsoft-365-integration-plane-fcsm1e HEAD`

| File | Result |
|---|---|
| `docs/REGRESSION_CHECKLIST.md` | ✅ auto-merges |
| `docs/architecture/UBIQUITOUS_LANGUAGE.md` | ✅ auto-merges |
| `docs/planning/AGENT_HANDOFF.md` | ❌ **CONFLICT (add/add)** |
| `docs/planning/DECISION_LOG.md` | ❌ **CONFLICT (content)** |
| `scripts/regression.sh` | ❌ **CONFLICT (content)** |

Three conflicts. Two are documentation and mechanically resolvable. **One is code.**

## 3. Cherry-pickable vs requires reconciliation

### Clean — no conflict, no shared path

| Change set | Why it is safe |
|---|---|
| `packages/m365/**` (26 source modules) | Path does not exist on the codex stack at all |
| `fixtures/m365/**` (22 notification cases + 4 state files) | New paths |
| `docs/architecture/M365_INTEGRATION_PLANE.md`, `docs/integrations/M365_ENTRA_CONFIGURATION.md`, `docs/integrations/BLOCKED_LIVE_PROOF.md` | New paths |

### Mechanical — conflicts, but resolvable by a human in minutes

| File | Nature |
|---|---|
| `docs/planning/AGENT_HANDOFF.md` | add/add: both branches rewrote the handoff for their own work. Resolve by keeping both narratives, or by regenerating from `context/LATEST_AGENT_HANDOFF.md` |
| `docs/planning/DECISION_LOG.md` | Both appended entries. Interleave chronologically |

### Requires architectural reconciliation — do not resolve by picking a side

| Item | Why it is not a text merge |
|---|---|
| **`scripts/regression.sh`** | Both branches changed the suite orchestrator. On the codex stack the suite list moved *out* of bash into the registry (`packages/awe-kernel/src/registry.mjs` via `scripts/lib/suite-plan.mjs`); the M365 branch, built on `main`, does not have that registry. Resolving toward the codex version means **M365's suites must be registered**, which is a code change, not a conflict resolution. |
| **`supabase/migrations/0016_*`** | No textual conflict — the files have *different names*. But both claim ordinal `0016`, so a clean auto-merge would produce **two migration `0016`s in one tree**. Git will not warn. This is C-101 and is the single most dangerous item in this report. |
| **`packages/m365` layering** | M365 has none of `awe-kernel`, `awe-control-plane`, `awe-execution` (it branched from `main`). Its `policy.ts`, `evidence.ts`, `credentials.ts`, `contracts.ts` are parallel implementations of platform concepts. Merging the files produces a tree where two policy engines coexist — compiling, passing, and meaning different things. |

## 4. The trap

**A naive `git merge` of these two branches would succeed after three small manual fixes and leave
the repository in a state where:**

1. two migrations claim slot `0016`,
2. two independent policy/evidence implementations coexist,
3. `scripts/regression.sh` runs the codex registry while M365's suites are invisible to it.

Nothing would fail loudly. That is precisely why C-101 and C-102 must be decided **before** any merge
is attempted, and why the recommended order in `AWE_INTEGRATION_PLAN.md` puts migration identity
first.

## 5. Recommended sequence — analysis only, not scheduled work

1. Ratify the migration identity scheme (C-101) — human decision, packet `AWE-INT-101`.
2. Decide whether `packages/m365` becomes an adapter behind `awe-execution` (C-102) — packet `AWE-INT-102`.
3. Open the base PR `feat/kernelized-mcp-context` → `main` (C-103) — **human instruction required**.
4. Only then rebase or re-target the M365 branch onto the stack.

**No step above was performed.** No merge, rebase, cherry-pick, push, or PR change occurred.
