# AWE Migration Collision Resolution

**Date:** 2026-08-02 · **Analysed at:** `a3961c0`
**Status: PROPOSED — requires human approval.** Remote Supabase applied state is unknown, and that
is the one fact that decides between the strategies below.

**No migration file was created, modified, renamed or applied. No database was contacted.**

---

## 1. The three artifacts, measured

| | A | B | C |
|---|---|---|---|
| **Filename** | `0016_drop_undeclared_client_policies.sql` | `0016_m365_integration_plane.sql` | `20260727142118_phase1_c1_remove_undeclared_policies.sql` (+ `…142120_c2`, `…142121_c3`, `…142123_c4`) |
| **Branch** | `feat/kernelized-mcp-context` and everything below it; also `security/c1-policy-cleanup`, `chore/agent-handoff-integration` | `claude/microsoft-365-integration-plane-fcsm1e` | `security/phase-1-remediation` |
| **Commit introduced** | in the 20-commit root block | `ad8589a` (single commit) | in the 5-commit phase-1 block |
| **Identity scheme** | four-digit ordinal | four-digit ordinal | Supabase timestamp |
| **Lines** | 80 | 406 | 53 (C1 alone) |
| **Tables created** | none | `m365_subscriptions`, `m365_notifications`, `m365_executions`, `m365_capability_invocations` | none |
| **Tables referenced** | `crews`, `crew_members`, `integration_events`, `time_entry_audits` | `orgs` (0001), `work_requests` (0011) | `crews`, `crew_members`, `integration_events`, `time_entry_audits` |
| **Policies** | drops 16 client RLS policies | creates policies + indexes on its own new tables; enables RLS on all four | drops the same 16 policies |
| **Ordering dependency** | none beyond the tables existing | **only "after 0011"** — any ordinal ≥ 0012 satisfies it | none beyond the tables existing |
| **Applied remotely?** | header states **"PROMOTED, NOT YET APPLIED … remains unapplied until explicit user approval"** | unknown | unknown |
| **Test coverage** | `scripts/acceptance-s1-security.sh` (credential-gated), `s1-policy-cleanup-{rehearsal,rollback}.sql` | `scripts/lib/validate-migration-0016.mjs`, `scripts/eval-m365.sh` — both on the M365 branch only | `scripts/lib/validate-phase1-security.mjs` |
| **Rollback** | re-create the 16 policies; the file says so in its own header | drop four tables; additive, so rollback is clean | same as A |

## 2. The finding that changes the shape of the problem

**A and C are the same fix.** Both drop the identical 16 client RLS policies on `crews`,
`crew_members`, `integration_events` and `time_entry_audits`, under two incompatible naming schemes.
This is what ADR-0009 recorded, now confirmed statement by statement.

**B is semantically independent of both.** It creates only `m365_*` tables and references only
`orgs` and `work_requests` — objects that already exist on `main` at `0001` and `0011`. It touches
nothing A or C touches.

So there are **two different problems wearing one label**:

| | Problem | Nature |
|---|---|---|
| **P1** | A vs C — two implementations of the same C1 fix | **Semantic.** Only one belongs in canonical history. Choosing is a real decision. |
| **P2** | A vs B — two files claiming ordinal `0016` | **Naming only.** Renumbering B is sufficient; nothing depends on its ordinal. |

Treating P2 as if it were as hard as P1 has been costing time. It is not.

## 3. Why Git will not protect you

`git merge-tree --write-tree origin/codex/durable-execution-plane origin/claude/microsoft-365-integration-plane-fcsm1e`
produces tree `14079e5`, which contains **both**:

```
supabase/migrations/0016_drop_undeclared_client_policies.sql
supabase/migrations/0016_m365_integration_plane.sql
```

The conflicts Git reports are `docs/planning/AGENT_HANDOFF.md`, `docs/planning/DECISION_LOG.md` and
`scripts/regression.sh` — **none of them the migrations**. The filenames differ, so from Git's point
of view nothing collided. A reviewer resolving three conflicts would land a duplicate ordinal
without ever being shown it.

**This is the single most dangerous item in the whole integration.** It must be prevented by a check,
not by attention.

## 4. Strategies

### Strategy 1 — Renumber the M365 migration after the canonical chain

`0016_m365_integration_plane.sql` → `0017_m365_integration_plane.sql`.

- **Solves:** P2.
- **Safe because:** B's only ordering requirement is "after `0011`" (it references `work_requests`).
  `0017` satisfies that as well as `0016` did.
- **Also required:** `scripts/lib/validate-migration-0016.mjs` on the M365 branch validates *its*
  `0016` by path. Renumbering without renaming that validator leaves a lint pointing at a file that
  no longer exists — a silently passing check.
- **Blocked by:** whether `0016_m365_integration_plane.sql` was ever applied to a remote project. If
  it was, renaming it desynchronizes the migration-history table.
- **Leaves P1 open.**

### Strategy 2 — Convert the M365 migration to the timestamp scheme

- **Solves:** P2, and moves the repository toward one scheme.
- **Costs:** it picks the timestamp scheme by implication rather than by decision, and 16 of 17
  existing migrations use ordinals. That is a large change justified by a small problem.
- **Leaves P1 open** — indeed it half-decides it in the wrong direction, by precedent rather than
  reasoning.

### Strategy 3 — Rebuild one canonical migration history before any remote application

Decide the scheme, retire the duplicate C1 implementation, and renumber into one clean sequence.

- **Solves:** P1 and P2 together.
- **Only safe while nothing has been applied remotely.** If anything has, this is not a renaming
  exercise; it is a migration-history repair with checksum implications.
- **Highest cost, highest payoff.**

## 5. Recommendation — PROPOSED, requires approval

**Adopt Strategy 1 now for P2, and defer P1 until the remote state is known.**

Reasoning:

1. P2 is a naming collision with a one-line fix and no semantic content. It is the item that can
   silently corrupt a merge, so it should be closed first and cheaply.
2. P1 is a genuine architectural choice between two implementations of the same fix. Choosing it
   without knowing whether either was applied risks writing a migration history that does not match
   the database.
3. Strategy 3 is the right end state, but it is a decision to make **once**, with the applied-state
   evidence in hand — not twice.

**Concretely proposed:**

- Rename `0016_m365_integration_plane.sql` → `0017_m365_integration_plane.sql` **on the M365 branch,
  before it is merged anywhere**, and rename `validate-migration-0016.mjs` → `-0017.mjs` with its
  path updated in the same commit.
- Keep `0016_drop_undeclared_client_policies.sql` as the canonical ordinal `0016`.
- Mark the four `2026072714…` phase-1 migrations as **candidates for retirement**, pending P1.
- **Do not delete anything on `security/phase-1-remediation`** until P1 is decided; it also carries
  C2, C3 and C4, which have no ordinal equivalent.

**Neither rename has been performed.** Both are outside this task's allowed scope.

## 6. Add a check so this cannot recur

Recommend a new offline lint — `scripts/lib/validate-migration-identity.mjs` — that fails when the
`supabase/migrations/` tree contains two files claiming the same identifier, or mixes ordinal and
timestamp schemes without an ADR permitting it. Register it in
`packages/awe-kernel/src/registry.mjs` as a `static` suite so it runs in every credential-free
regression.

The evidence collector already computes exactly this — `findSlotCollisions()` in
`scripts/lib/evidence/collectors.mjs`, covered by Runner EV. The lint would be a thin wrapper that
turns a report into a gate. **Proposed, not built:** it is code, and this task is analysis.

## 7. What must be learned before ANY migration is renamed

This is the blocking list. Every item needs the MacBook or a Supabase session, and none can be
answered from this machine.

| # | Question | Why it decides something |
|---|---|---|
| 1 | Which Supabase project is AWE's? | Nothing else can be asked without it |
| 2 | Full contents of the applied-migration table | Turns every "unknown" below into a fact |
| 3 | **Was any `0016` variant ever applied?** | If yes, renaming `0016_m365` desynchronizes history and Strategy 1 becomes unsafe |
| 4 | Were the four `2026072714…` phase-1 migrations applied? | Decides P1 directly — if C1 ran as a timestamp migration, the ordinal `0016` version must never run |
| 5 | Migration checksums, if the tooling stores them | A renamed file with an unchanged checksum may still be detected as new |
| 6 | Has the remote diverged from local Git? | A migration applied from a branch that was never merged would explain any mismatch |
| 7 | Whether `0016_drop_undeclared` was applied despite its "NOT YET APPLIED" header | The header is a **claim in a file**, not an observation. It is `REPORTED_NOT_VERIFIED`. |

Item 7 deserves emphasis: the strongest applied-state evidence in the repository is a comment
someone wrote. It is good evidence about intent and no evidence at all about a database.

## 8. Evidence status

| Claim | Status |
|---|---|
| Three artifacts exist with the identities above | `VERIFIED` — `git ls-tree` on each branch |
| A and C drop the same 16 policies | `VERIFIED` — statement comparison |
| B creates only `m365_*` tables and references only `orgs`, `work_requests` | `VERIFIED` — SQL inspection |
| Merging M365 into the stack yields two `0016` files with no Git warning | `VERIFIED` — `merge-tree` tree `14079e5` |
| `0016_drop_undeclared` has not been applied | `REPORTED_NOT_VERIFIED` — a file header, not a database |
| `0016_m365` applied state | `UNKNOWN` |
| Phase-1 timestamp migrations applied state | `UNKNOWN` |
| Renaming `0016_m365` → `0017_m365` is safe | `PARTIALLY_VERIFIED` — safe by dependency analysis, conditional on question 3 |
