# ADR-0010 — AWE platform integration strategy

**Status:** Proposed (2026-08-02) — awaiting Jack's ratification.
**Supersedes:** nothing. **Depends on:** ADR-0008 (runner numbering), ADR-0009 (competing C1
migration artifacts).

---

## Context

41 local commits across 237 files sit outside `main` in a linear seven-branch chain, plus a
Microsoft 365 integration plane on its own branch. PRs #4–#7 chain each branch to the one beneath
it; the root, `feat/kernelized-mcp-context`, has no PR into `main`, so the chain terminates nowhere.

Two migrations claim ordinal `0016`. A third artifact re-solves the same C1 fix under a timestamp
scheme. `git merge-tree` confirms a merge of the M365 branch into the stack produces a tree
containing both `0016` files while reporting conflicts only in three unrelated documents.

Measured, not assumed: every branch in the chain merges into `main` with **exactly one conflict**,
in `docs/planning/AGENT_HANDOFF.md`. The stack is not blocked by anything structural.

## Decision

### 1. Land the root stack by preserving the stacked PR chain

Open the missing root PR `feat/kernelized-mcp-context → main`, then land #4, #5, #6, #7 in order.

Rejected alternatives, with reasons recorded so they are not re-argued:

- **A single `integration/awe-unification` branch** — one 237-file PR is approved, not reviewed, and
  reverting it removes every capability at once.
- **Squash or cherry-pick per capability** — the packages import each other by relative path;
  `packages/awe-agent-runtime` cherry-picked alone would import an `awe-kernel` that is not there.
- **Rebase the stack onto `main`** — 41 replayed commits, five moved branch pointers and every open
  PR invalidated, to remove one Markdown conflict.

### 2. Cognition and dispatch land as a separate PR, after the stack

`feat/cognition-dispatch-control-plane` touches 43 files no platform branch touches and is tooling,
not runtime. Its only platform coupling is one import of `packages/awe-kernel/src/canonical.mjs`, so it must
land **after** the root but need not land **inside** the chain.

### 3. Microsoft 365 lands last, and is reduced to an adapter afterwards

M365 has zero conflicts against `main` but imports **no** platform package — it carries parallel
`policy`, `evidence`, `contracts`, `execution` and `capabilities` modules because it was cut from a
`main` that had none. Landing it before the platform would entrench that duplication and require a
second reconciliation later.

Merging M365 is not integrating it. The integration is the subsequent reduction of those five
modules to adapters over the platform's contracts, and that is separate work in a separate commit.

### 4. Migration identity: fix the naming collision now, defer the semantic one

There are two problems wearing one label:

- **Naming (M365 `0016` vs platform `0016`)** — the M365 migration creates only `m365_*` tables and
  references only `orgs` and `work_requests`. Renumbering to `0017` is sufficient.
- **Semantic (`0016_drop_undeclared_client_policies.sql` vs `20260727142118_phase1_c1_*`)** — the
  same 16 policy drops implemented twice under incompatible schemes. Only one belongs in canonical
  history.

**Decided:** renumber M365 to `0017` (with its validator renamed in the same commit) **before** it
merges anywhere. **Deferred:** the C1 duplication, until the remote applied state is known.

### 5. Runner 6 collides; M365 becomes Runner 7

ADR-0008 reserves Runner 6 for the Agent Harness (6A/6B). `scripts/eval-m365.sh` independently
claims Runner 6. The files never collide, so no merge will surface it. The harness claim is older
and was reasoned about deliberately; M365 renumbers.

### 6. Every landing step is gated on evidence, not on assertion

`bash scripts/regression.sh --kinds=unit,offline,static` must be ALL GREEN at each base before the
next PR merges — and for M365, the run must **include** its three newly registered suites. A green
run that silently skipped them proves nothing.

### 7. A migration-identity lint must exist before M365 merges

Two files claiming one ordinal must fail a check, not depend on a reviewer noticing. The evidence
collector already computes this (`findSlotCollisions()`, covered by Runner EV); it needs a thin
wrapper registered as a `static` suite.

## Consequences

**Good:** history preserved; each capability reviewable on its own diff; rollback is one revert per
capability; the silent duplicate-`0016` hazard is closed by a gate rather than by attention.

**Costs:** the `AGENT_HANDOFF.md` conflict is resolved once per PR as each base advances — five
times, mechanically. M365 waits for the platform.

**Risks accepted:** `main` may advance during the sequence, widening the conflict. Mitigation: land
the chain in one working session, or re-run the dry-run merges before each step.

**Risk NOT accepted:** applying or renaming any migration before the Supabase applied state is known.

## Required human approvals

| # | Approval | Why it cannot be an agent decision |
|---|---|---|
| 1 | Open the root PR `feat/kernelized-mcp-context → main` | 41 commits depend on its base |
| 2 | Ratify the migration identity scheme (ordinals vs timestamps) | Determines the fix for all three artifacts |
| 3 | Confirm the remote Supabase applied state | Nothing may be renamed until this is known |
| 4 | Decide repository visibility before any push | See `AWE_REPOSITORY_EXPOSURE_REVIEW.md` |
| 5 | Ratify or supersede ADR-0008 | Decides whether Runner 6 stays reserved |
| 6 | Choose between the two C1 implementations | Only one belongs in canonical history |

## Rollback

- Per capability: revert the merge commit for that PR. Dependencies are strictly ordered, so
  reverting a later capability never orphans an earlier one.
- Root PR: revert the merge; `main` returns to `dbf8f17` and the branches survive untouched.
- Migration renumber: it is a rename on an unmerged branch — `git checkout` the previous name.
- Nothing in this decision applies a migration, so no database rollback is in scope.

## Evidence

`docs/integration/AWE_BRANCH_INTEGRATION_GRAPH.md` · `AWE_MIGRATION_COLLISION_RESOLUTION.md` ·
`AWE_M365_RECONCILIATION_PLAN.md` · `AWE_PLATFORM_LANDING_PLAN.md`. Every structural claim is
`VERIFIED` by local Git inspection; every applied-state claim is `UNKNOWN`.

**This ADR is `Proposed`. Nothing in it has been executed.**
