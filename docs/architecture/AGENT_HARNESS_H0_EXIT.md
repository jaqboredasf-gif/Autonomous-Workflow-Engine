# Agent Harness — H0 exit checklist, H1 entry criteria, task dependency map

Date: 2026-07-27. Companion docs: `AGENT_HARNESS_DESIGN.md` (architecture),
`AGENT_HARNESS_DECISIONS.md` (O1–O5 + two design defects),
`AGENT_HARNESS_DOCTRINE.md` (D1–D20), `AGENT_HARNESS_GUARDRAILS.md` (G1–G20),
`AGENT_HARNESS_CONTRACTS.md` (six subsystem contracts),
`decisions/` (ADR-0001…0008), `AGENT_HARNESS_H1_BRIEF.md` (next session).

---

## 1. H0 exit criteria

| # | Criterion | State |
|---|---|---|
| 1 | Five open questions restated, analyzed, and each given one recommendation with consequences and rejected alternatives | **DONE** — `AGENT_HARNESS_DECISIONS.md` |
| 2 | Doctrine written with enforcement layer, second layer, failure behavior, regression test and guardrail number per rule | **DONE** — 20 rules, `AGENT_HARNESS_DOCTRINE.md` |
| 3 | Guardrail enforcement matrix G1–G20 | **DONE** — `AGENT_HARNESS_GUARDRAILS.md` |
| 4 | Implementation contracts: registry, dispatcher, verification, context/compaction, session manager, retry | **DONE** — `AGENT_HARNESS_CONTRACTS.md` |
| 5 | ADRs drafted in one canonical location with a naming convention and an index | **DONE** — `docs/architecture/decisions/`, 8 records, all `Proposed` |
| 6 | Design-doc defects found during inspection corrected | **DONE** — kill-switch home (ADR-0007), Runner number (ADR-0008); design doc patched |
| 7 | H1 refined into a pure, dependency-light, DB-free session brief | **DONE** — `AGENT_HARNESS_H1_BRIEF.md` |
| 8 | Task dependency map H0–H17 | **DONE** — §5 below |
| 9 | Backlog + handoff updated so a fresh session can continue without terminal history | **DONE** — `TASK_BACKLOG.md` § H-series, `SESSION_HANDOFF.md` |
| 10 | **Jack ratifies ADR-0001…0008 and a DECISION_LOG entry records the date** | **OPEN — the only blocker** |

**H0 status: INCOMPLETE.** Criteria 1–9 are complete; criterion 10 cannot be
self-granted. Every decision above is `Proposed` and carries no authority until
ratified. Ratification is one review pass plus one DECISION_LOG entry.

## 2. H1 entry criteria

H1 may start when **all** of these hold:

1. ADR-0001 is `Accepted` (the doctrine supersede). H1 builds nothing that depends
   on ADR-0002…0008, but it builds *for* a subsystem that ADR-0001 authorizes.
2. A DECISION_LOG entry records the ratification date and links
   `docs/architecture/decisions/`.
3. `scripts/regression.sh` is ALL GREEN on the current tree (baseline captured in
   the H1 handoff before any change).
4. Working tree clean, on a fresh branch (`feat/h1-harness-core` suggested); S1 /
   migration 0016 untouched and still unapplied.
5. No live apply is scheduled in the same session (H1 touches no database).

ADR-0002…0008 may remain `Proposed` during H1 — none of them is reachable from
pure code — but they must be `Accepted` before H2 (0002, 0007), H7 (0004), H11
(0003), H13 (0005, 0008), H14 (0006).

## 3. Required repository files (state after H0)

Created this session:
```
docs/architecture/AGENT_HARNESS_DECISIONS.md
docs/architecture/AGENT_HARNESS_DOCTRINE.md
docs/architecture/AGENT_HARNESS_GUARDRAILS.md
docs/architecture/AGENT_HARNESS_CONTRACTS.md
docs/architecture/AGENT_HARNESS_H0_EXIT.md          (this file)
docs/architecture/AGENT_HARNESS_H1_BRIEF.md
docs/architecture/decisions/README.md
docs/architecture/decisions/0001-…0008-*.md          (8 records)
```
Updated this session: `AGENT_HARNESS_DESIGN.md` (two corrections),
`docs/architecture/UBIQUITOUS_LANGUAGE.md` (proposed harness terms),
`docs/planning/TASK_BACKLOG.md` (H-series), `docs/planning/SESSION_HANDOFF.md`.

Not created (correctly): no code, no migration, no seed, no workflow, no commit.

## 4. Assumptions that must become configuration, not code

| Assumption | Becomes | Task |
|---|---|---|
| One model call per email, ≤2 retries | `agent_session_types` budget columns | H2 |
| Which tools a session may use | `agent_session_types.allowed_tools` | H2 |
| Effect ceiling per session type | `agent_session_types.max_effect_class` | H2 |
| Compaction thresholds (0.60 / 0.85 / 0.95) | session-type config, defaults in code | H2, H10 |
| `verify_poll_max` (default 3) | session-type config | H2 |
| Lease duration (default 300s) | `agent_harness_settings.default_lease_seconds` | H2 |
| Harness on/off, fixture-only mode | `agent_harness_settings` | H2 |
| Model tier → (provider, model) | router tier table | H7 |
| Cost per token per model | router cost table | H7 |
| Fixture-row revisit threshold (100k) | documented threshold + view | H13, H16 |
| Retry caps per error class | `retry.mjs` policy table (code, single source) | H8 |

## 5. Task dependency map H0–H17

```
H0 (doctrine + ADRs)  ─ ratification gate ─┐
                                           ▼
                                          H1  pure core (no DB, no network)
                                           │
              ┌────────────────┬───────────┼────────────────┐
              ▼                ▼           ▼                ▼
             H2 (0017)        H7 model    H9 context      (H3 needs H2)
              │  written+dry-run │           │
              ▼                │           ▼
             H3 (0018)         │          H10 compaction
              │                │           │
     ── AC-1/AC-2 apply gates ─┘           │
              ▼                            │
             H4 registry+parity            │
              ▼                            │
             H5 verify library             │
              ▼                            │
             H6 dispatcher (read/write_internal)
              ▼                            │
             H8 retry  ◄──────────────── H7│
              ▼                            │
             H11 session manager ◄─────────┘   (needs H2, H6, H8, H10)
              ▼
             H12 triage_email + CLI + parity gate (needs H4, H7, H11)
              ▼
             H13 Runner 6A/6B + regression wiring
              ▼
             H14 human gate + human_visible dispatch
              ▼
             H15 web API ──► H16 MCP + observability + kill switch ──► H17 docs
```

| Task | Depends on | Blocked by ADR | Live DB? |
|---|---|---|---|
| H1 | H0 ratified | 0001 | no |
| H2 | H1 | 0001, 0002, 0007 | writes migration file only; **AC-1** applies |
| H3 | H2 | 0002 | file only; **AC-2** applies |
| H4 | H1, H3 | — | reads (parity offline) |
| H5 | H4 | 0002 | reads |
| H6 | H4, H5 | 0002 | writes (fixture) |
| H7 | H1 | 0004 | no |
| H8 | H6, H7 | — | writes (fixture) |
| H9 | H1 | 0004 | no |
| H10 | H9, H3 | — | writes snapshots (fixture) |
| H11 | H2, H6, H8, H10 | 0003 | writes (fixture) |
| H12 | H11, H4, H7 | 0005 | writes (fixture) |
| H13 | H12 | 0005, 0008 | writes (fixture) |
| H14 | H12, H6 | 0006 | writes (fixture) |
| H15 | H11 | 0003, 0006 | reads/writes via API |
| H16 | H14, H3 | 0007 | reads |
| H17 | H16 | — | no |

**Parallelizable** (disjoint files): `{H2, H3}` ∥ `{H7}` ∥ `{H9}` — all after H1.
**Apply checkpoints:** AC-1 (0017) after H2 review; AC-2 (0018) after H3 review.
Both require explicit approval, a fresh live-state recheck, and the CONTEXT.md
management-API dry-run-then-apply protocol. Neither may share a session with S1.

## 6. Unresolved blockers

| # | Blocker | Blocks | Owner |
|---|---|---|---|
| B-1 | ADR-0001…0008 ratification + DECISION_LOG entry | H1 (ADR-0001), later tasks (rest) | Jack |
| B-2 | S1 / migration 0016 still unapplied; live DB carries the 16-policy drift | Nothing in H1–H3 directly, but harness tables must not be created into a database with unresolved policy drift on the shared events table — **recommend applying 0016 before AC-1** | Jack |
| B-3 | `ANTHROPIC_API_KEY` absent | Runner 6B (H13 live variant) only; 6A is unaffected | Jack |
| B-4 | Service-role key rotation (standing debt) will rotate the harness credential too | operational note for H17 runbook | Jack |
| B-5 | **Live migration history is absent.** The Supabase migration-list API returns zero rows and the live DB has no `supabase_migrations` schema, while `0001`–`0015` are materially present in the live schema. `AGENTS.md`'s standing stop condition ("stop when repository, migration history, and live state disagree") is therefore **active**. Evidence: `docs/planning/AGENT_HANDOFF.md` (2026-07-27 read-only deployment review) | AC-1, AC-2, and any live apply. **Not H1** | Jack |
| B-6 | **Two competing C1 artifacts** — `0016_drop_undeclared_client_policies.sql` (branch `security/c1-policy-cleanup`) and `20260727142118_phase1_c1_remove_undeclared_policies.sql` (branch `security/phase-1-remediation`) drop the same 16 policies under two incompatible naming conventions; `main` has neither. Phase 1 also adds C2/C3/C4 timestamped files, which may need `0017`–`0019` and would then collide with the harness allocation in §5. See ADR-0009 | H2/H3 migration numbering; Phase 1 deploy. **Not H1** | Jack |

None of B-2…B-6 blocks H1. B-5 and B-6 block H2 and every apply checkpoint.

---

## 8. H0 re-verification (2026-07-27, fresh session — no code written)

An independent session re-derived H0 state from repository files only.

**Confirmed accurate.** Criteria 1–9 are genuinely complete; the doc set is
internally consistent (D1–D20 ↔ G1–G20 ↔ contracts ↔ ADR-0001…0008 cross-reference
cleanly). Spot-checked claims that hold against real code:
`packages/mcp-server/src/index.js:396` does bind tenancy with
`from('orgs').select('id').limit(1)`; `scripts/lib/db.mjs` does hard-code
`PROJECT_REF`/`ORG_ID`; Runners 1–5 are indeed allocated, so ADR-0008's "Runner 6"
is correct; `packages/harness/` does not exist, as H1 expects.

**Criterion 10 remains OPEN.** All eight ADRs still read `Status: Proposed` and
`docs/planning/DECISION_LOG.md` has no ratification entry. **H0 is INCOMPLETE.** A
session cannot self-grant this: the ADR README states `Proposed` "carries no
authority", and doctrine D2 forbids automation approving its own work. An agent
marking these `Accepted` would be the exact failure mode the harness is being built
to prevent.

**Newly discovered, not known to the H0 session:** a parallel security workstream
exists on branches `security/phase-1-remediation` (C1–C4, PR #3) and
`chore/agent-handoff-clean` (merged to `main` as PR #2). It produced blockers B-5
and B-6 above. The H0 documents are not wrong about the harness; they were written
without visibility into that workstream, and §5's `0017`/`0018` allocation is the
one place the two collide.

**Branch note:** the H0 harness documents are untracked files sitting on
`chore/agent-handoff-integration`, which has been superseded — its clean replacement
`chore/agent-handoff-clean` was already merged into `main` (`dbf8f17`), and the
current branch is 6 commits ahead of / 8 behind `main`. The H0 work exists on no
branch and in no commit. Preserving it is a prerequisite to acting on it.

## 7. Decisions that must never remain implicit

Restated from `AGENT_HARNESS_DECISIONS.md` so a fresh session cannot "reasonably
assume" otherwise: the harness never chooses an org · never imports
`scripts/lib/db.mjs` · has no `external` effect class · is never an approver ·
arrives dormant (`enabled=false`, `fixture_mode_only=true`) · treats model output as
non-evidence · never retries a guard refusal · never touches a Workstream A table.
