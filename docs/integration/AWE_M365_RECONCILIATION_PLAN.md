# Microsoft 365 Reconciliation Plan

**Date:** 2026-08-02 · **Analysed at:** `a3961c0`
**Compared:** `claude/microsoft-365-integration-plane-fcsm1e` (`ad8589a`, one commit, 70 files)
against `codex/durable-execution-plane` and `feat/cognition-dispatch-control-plane`.

**No branch was merged, rebased or cherry-picked. The M365 branch was never checked out** — it was
read with `git show`, `git ls-tree`, `git diff` and `git merge-tree`.

---

## 1. What the branch is

One commit on top of `main`. 70 files:

| Area | Files |
|---|---|
| `packages/m365/src/` | 28 — 24 modules incl. 5 adapters (`mail`, `teams`, `document`, `identity`, `types`) |
| `fixtures/m365/` | 26 — 22 notification cases + 4 state files |
| `scripts/` | 7 — `eval-m365.{mjs,sh}`, `m365-live-smoke.{mjs,sh}`, `lib/m365-policy-bridge.mjs`, `lib/validate-migration-0016.mjs`, `regression.sh` |
| `docs/` | 8 |
| `supabase/migrations/` | 1 — `0016_m365_integration_plane.sql` (406 lines) |

## 2. The structural fact that drives everything

**`packages/m365` imports nothing from the platform.** Measured:

| Platform package | References inside `packages/m365` |
|---|---|
| `awe-kernel` | **0** |
| `awe-control-plane` | **0** |
| `awe-execution` | **0** |
| `awe-runtime` | **0** |

The branch was cut from `main`, which has none of those packages, so it could not have used them.
It therefore carries its own `policy.ts`, `evidence.ts`, `contracts.ts`, `credentials.ts`,
`execution.ts` and `capabilities.ts` — **parallel implementations of concepts the platform also
owns**, arrived at independently.

This is not a defect of the M365 work. It is the predictable result of two branches growing from a
common ancestor that had neither. But it means **M365 cannot simply be merged and declared
integrated**: merging produces a tree with two policy engines that compile, pass their own tests,
and mean different things.

## 3. File-level classification

| Path | Class | Detail |
|---|---|---|
| `packages/m365/src/adapters/*` (5) | `CLEAN_INDEPENDENT` | New paths; no platform equivalent |
| `packages/m365/src/{gateway,http-gateway,executor,pipeline,handlers,normalize,subscriptions,notifications,persistence,scopes,allowlist,fake-graph,index,node-runtime.d}.ts` | `CLEAN_INDEPENDENT` | New paths |
| `packages/m365/src/policy.ts` | **`SEMANTIC_CONFLICT`** | Parallel to `awe-control-plane/src/policy.mjs` + `awe-kernel/src/gates.mjs` |
| `packages/m365/src/evidence.ts` | **`SEMANTIC_CONFLICT`** | Parallel to `scripts/lib/artifact-store.mjs` → `awe-runtime/src/file-sinks.mjs` |
| `packages/m365/src/contracts.ts` | **`SEMANTIC_CONFLICT`** | Parallel to `awe-execution/src/contracts.mjs` |
| `packages/m365/src/execution.ts` | **`SEMANTIC_CONFLICT`** | Parallel to `awe-execution/src/{service,state-machine}.mjs` |
| `packages/m365/src/capabilities.ts` | `SEMANTIC_CONFLICT` | Parallel to the kernel's capability registry |
| `packages/m365/src/credentials.ts` | `NEEDS_LIVE_PROOF` | Never exercised against Graph; `docs/integrations/BLOCKED_LIVE_PROOF.md` |
| `fixtures/m365/**` (26) | `CLEAN_INDEPENDENT` | New paths |
| `supabase/migrations/0016_m365_integration_plane.sql` | **`MIGRATION_CONFLICT`** | Ordinal collision only — see §4 |
| `scripts/eval-m365.{mjs,sh}` | **`TEST_HARNESS_CONFLICT`** | Claims **Runner 6** — see §5 |
| `scripts/lib/validate-migration-0016.mjs` | `MIGRATION_CONFLICT` | Validates its own `0016` by path; breaks silently if the migration is renumbered |
| `scripts/lib/m365-policy-bridge.mjs` | `SEMANTIC_CONFLICT` | A bridge to a policy model the platform implements differently |
| `scripts/m365-live-smoke.{mjs,sh}` | `NEEDS_LIVE_PROOF` | Credential-gated; must never run unattended |
| `scripts/regression.sh` | **`SEMANTIC_CONFLICT`** | See §5 — resolving toward the stack **deletes** M365's suite registrations |
| `docs/planning/AGENT_HANDOFF.md` | `TEXTUAL_CONFLICT` | add/add, as with every branch |
| `docs/planning/DECISION_LOG.md` | `TEXTUAL_CONFLICT` | Both appended; interleave chronologically |
| `docs/architecture/UBIQUITOUS_LANGUAGE.md` | `DOCUMENTATION_ONLY` | Auto-merges |
| `docs/REGRESSION_CHECKLIST.md` | `DOCUMENTATION_ONLY` | Auto-merges |
| `docs/architecture/M365_INTEGRATION_PLANE.md`, `docs/integrations/{BLOCKED_LIVE_PROOF,M365_ENTRA_CONFIGURATION}.md`, `docs/planning/INTEGRATIONS.md` | `CLEAN_INDEPENDENT` | New paths |

**Totals:** 60 `CLEAN_INDEPENDENT` · 7 `SEMANTIC_CONFLICT` · 2 `MIGRATION_CONFLICT` ·
2 `TEXTUAL_CONFLICT` · 2 `DOCUMENTATION_ONLY` · 2 `NEEDS_LIVE_PROOF` · 1 `TEST_HARNESS_CONFLICT`.

## 4. The migration conflict is narrower than it looks

`0016_m365_integration_plane.sql` creates only `m365_subscriptions`, `m365_notifications`,
`m365_executions`, `m365_capability_invocations`, and references only `orgs` (`0001`) and
`work_requests` (`0011`). It touches **nothing** that `0016_drop_undeclared_client_policies.sql`
touches.

So the conflict is the **ordinal, not the semantics** — renumbering to `0017` is sufficient, subject
to the applied-state questions in `AWE_MIGRATION_COLLISION_RESOLUTION.md` §7.

⚠ `git merge-tree` proves both files survive a merge with **no Git warning**. Merged tree `14079e5`
contains both. This must be caught by a lint, not by a reviewer's attention.

## 5. Two harness conflicts Git cannot show

### `scripts/regression.sh` — the suite list moved out of bash

- **On `main` (where M365 branched):** the suite list lives in `regression.sh`. M365 appended three
  `if [ -f … ]` blocks: an m365 typecheck, `validate-migration-0016`, and `eval-m365.sh`.
- **On the stack:** the list moved into `packages/awe-kernel/src/registry.mjs`, resolved by
  `scripts/lib/suite-plan.mjs`. The file's own header now says: *"Adding a suite means adding a
  descriptor to the registry — never editing bash."*

**Consequence:** resolving this conflict toward the stack version — which is correct — **silently
deletes all three M365 suite registrations.** The tests still exist on disk and never run again.
Nothing fails; coverage just disappears.

**Required:** three new descriptors in `registry.mjs` (`m365-typecheck` kind `build`,
`validate-migration-0017` kind `static`, `eval-m365` kind `offline`). That is a code change, not a
conflict resolution, and it belongs in the M365 reconciliation commit.

### Runner 6 is claimed twice

| Claimant | Where |
|---|---|
| Agent Harness eval (`6A` deterministic, `6B` live) | **ADR-0008**, `docs/architecture/decisions/0008-harness-eval-runner-number.md`, on the codex stack |
| M365 Integration Plane eval | `scripts/eval-m365.sh` header and its `Runner 6: PASS` output |

Both are "Runner 6". The files never collide — `scripts/eval-harness.sh` does not exist yet — so no
merge will ever surface this.

This also explains a standing evidence-collector warning: *"cognition cites Runner 6 but no script
declares it."* ADR-0008 reserved the number; M365 then took it on a branch the collector cannot see.

**Recommendation:** M365 becomes **Runner 7**. ADR-0008 is `Proposed`, but it was reasoned about
runner allocation deliberately, and the harness it names is the older claim. Renaming an unmerged
branch's runner is cheaper than renaming a ratified ADR's.

## 6. Landing order

**Recommendation: M365 lands LAST — after the platform stack, after the cognition/dispatch PR, and
only once the migration identity decision is made.**

| Consideration | Verdict |
|---|---|
| Can M365 land before the stack? | Technically yes — 0 conflicts against `main`. **But** it would then be integrated against a `main` with no platform packages, entrenching the parallel implementations and requiring a second reconciliation later. |
| Can it land inside the stack? | No. It is not an ancestor of any stack branch; inserting it would mean rebasing it onto a moving base five times. |
| After the stack? | **Yes.** By then `awe-kernel`, `awe-control-plane` and `awe-execution` exist, so the parallel modules can be reduced to adapters against real contracts. |

### Prerequisites, in order

1. Platform stack landed (root PR → #4 → #5 → #6 → #7).
2. `feat/cognition-dispatch-control-plane` landed.
3. **Migration identity decision approved** — the renumber cannot happen before the applied-state
   questions are answered.
4. Renumber `0016_m365_integration_plane.sql` → `0017_…` and
   `validate-migration-0016.mjs` → `-0017.mjs`, in one commit on the M365 branch.
5. Renumber the M365 eval to **Runner 7**.
6. Register the three M365 suites in `packages/awe-kernel/src/registry.mjs`.
7. Rebase or re-target the M365 PR onto the new `main`.

### Required test gates at landing

`bash scripts/regression.sh --kinds=unit,offline,static` must be ALL GREEN **and** must include the
three newly registered M365 suites — a green run that silently skipped them proves nothing.
`scripts/m365-live-smoke.sh` stays **out** of scope: it is credential-gated and has never had a live
proof (`docs/integrations/BLOCKED_LIVE_PROOF.md`).

## 7. Cherry-pickable vs requires reconciliation

**Cleanly cherry-pickable** (60 files, new paths, zero overlap): all `packages/m365/src/adapters/*`,
the transport and lifecycle modules, all 26 fixtures, and the four new documents.

**Requires human reconciliation** (10 files): `policy.ts`, `evidence.ts`, `contracts.ts`,
`execution.ts`, `capabilities.ts`, `m365-policy-bridge.mjs`, `regression.sh`, the migration, its
validator, and `DECISION_LOG.md`.

**Do not cherry-pick anything now.** M365 is one commit; splitting it would destroy the only record
of how the plane was built, to save a rebase.

## 8. Should M365 stay an adapter package?

**Yes — and reduce it to one.** It should keep its adapters, transport, subscription lifecycle,
fixtures and migration, and **lose** its parallel policy, evidence, contracts and execution modules
in favour of the platform's, once those exist on `main`.

That reduction is the actual integration work. It is not a merge, and it should not be attempted in
the same commit as the merge.

## 9. Obsolete or contradictory documentation

| Document | Issue |
|---|---|
| `docs/integrations/BLOCKED_LIVE_PROOF.md` | Still accurate — no live Graph proof exists. Keep. |
| `docs/planning/DECISION_LOG.md` | Both branches appended; entries must interleave by date, not be chosen between |
| `docs/architecture/UBIQUITOUS_LANGUAGE.md` | Auto-merges, but M365's terms should be checked against `context/AWE_UBIQUITOUS_LANGUAGE.md` for duplicate definitions |
| `docs/REGRESSION_CHECKLIST.md` | Will be stale on landing — it describes bash-listed suites, and the stack moved them to the registry |

## 10. Evidence status

| Claim | Status |
|---|---|
| M365 is one commit, 70 files, 0 conflicts vs `main` | `VERIFIED` — `git diff`, `merge-tree` |
| `packages/m365` imports no platform package | `VERIFIED` — `git grep` returned 0 for all four |
| The M365 migration touches no table the ordinal-`0016` migration touches | `VERIFIED` — SQL inspection |
| Merging M365 into the stack yields two `0016` files with no warning | `VERIFIED` — tree `14079e5` |
| `regression.sh` resolution drops three M365 suites | `VERIFIED` — diff of both sides |
| Runner 6 is claimed by both ADR-0008 and `eval-m365.sh` | `VERIFIED` — both texts read |
| M365 behaves correctly against real Graph | `MOCK_ONLY` — `fake-graph.ts`; no live proof exists |
| Renumbering to `0017` is safe | `PARTIALLY_VERIFIED` — safe by dependency; conditional on remote applied state |
