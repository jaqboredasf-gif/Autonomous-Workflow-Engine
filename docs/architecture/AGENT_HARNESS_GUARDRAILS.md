# Agent Harness — guardrail enforcement matrix G1–G20 (H0, 2026-07-27)

Companion to `AGENT_HARNESS_DOCTRINE.md` (rules D1–D20). This file is the
enforcement view: for each guardrail, **what enforces it**, **where the second
layer is**, **what happens when it trips**, and **which test proves it is alive**.

Status: **PROPOSED** with ADR-0001…0008. Columns marked *(exists)* are already
built today; everything else lands in the H-series task named in the last column.

| G | Guardrail | Primary enforcement | Second layer | Failure behavior | Regression proof | Task |
|---|---|---|---|---|---|---|
| **G1** | Tenant boundary | Code: `org_id` required at session creation, in `ToolContext`, filters reads, set on writes, asserted on returned rows | Schema: `org_id NOT NULL` + FK on every harness table (RLS is bypassed by the service role — ADR-0002) | Refusal before any write, `tenant_violation`, session `blocked` | Runner 6A cross-org refusal; slice 6 column pins | H2, H6 |
| **G2** | Service-role-only harness tables | Schema: RLS enabled, **zero** client policies | Test: `pg_policies` count = 0 pin per harness table (the S1 pattern) | Any policy appearing on a harness table fails regression | slice 6 policy-count pin, state-aware like `acceptance-s1-security.sh` | H2, H3 |
| **G3** | Zero external send | Absence: no `external` descriptor exists | Schema: `agent_session_types.max_effect_class` check forbids `'external'`; dispatcher raises | `external_effect_forbidden`, no write, `agent.tool_blocked` | slice 6 (zero external rows, check rejects type); Runner 6A test-only descriptor raises pre-ledger | H2, H6 |
| **G4** | Automation approves nothing | Registry: `authz.actor='human'` on `record_approval` / `mark_message_sent` / `link_duplicate` | DB *(exists)*: 0015 RLS + `sent`-requires-approval constraint | `unauthorized_external_action`, no write, `awaiting_human` | H14 service-actor refusal; slices 4–5 stay green | H14 |
| **G5** | Tool allowlist per session type | Data: `agent_session_types.allowed_tools` | Code: dispatcher membership check before lookup | `tool_not_allowed`, no write | H6 allowlist unit + Runner 6A | H4, H6 |
| **G6** | Effect-class ceiling | Code: descriptor class vs type ceiling | Schema: ceiling check constraint on the type row | `effect_ceiling_exceeded`, no write, one blocked ledger row, **never retried** | H6 ceiling refusal; H8 asserts zero retries after a block | H2, H6 |
| **G7** | Step budget | Code: `budget.mjs` precheck each iteration | DB: `enforce_agent_budget` BEFORE INSERT on `agent_steps` | Terminal `failed`, `budget_exhausted` event | H11 one-step-budget test; slice 6 trigger test | H2, H11 |
| **G8** | Model-call / token / cost budget | Code: counters on `agent_sessions`, charged per attempt incl. retries | Data: type budget columns `NOT NULL` and `> 0` (check) | Terminal `failed`, `agent.budget_exhausted` | H11 budget tests; slice 6 rejects null/zero budgets | H2, H11 |
| **G9** | Wall-clock timeout | Code: `deadline_at` in `ToolContext`, checked before each phase | DB: lease expiry → `expired`, resumable | `expired`; resume continues, never silently dropped | H11 resume-equivalence; lease-expiry test | H2, H11 |
| **G10** | Untrusted content stays data | Code: `trusted=false` + delimiters; preserved across compaction L1–L3 | Code: groundedness check before any write derived from untrusted text | Compaction aborts rather than promoting trust; fail-closed to human | H9 trust-label suite; H10 preservation + determinism | H9, H10 |
| **G11** | Groundedness (no invented values) | Code: generalized `hallucinationCheck()` — extracted values absent from source text block the write | Verify: post-write re-read compares persisted values to source | Write refused, `ungrounded_extraction`, human queue | Runner 6A hallucination cases (B2 corpus, gate = 0) | H6, H13 |
| **G12** | Fail closed | Code: unknown/unparseable/low-confidence ⇒ `needs_review` | DB *(exists)*: emergency lock, `request.triage_required`, blocked rows | Human queue with a reason; never a guess | Runner 6A fail-closed fixtures (inherited from B2) | H12, H13 |
| **G13** | Verify before success | Code: `succeeded` requires `verify.ok` | DB: `completed` transition rejected while any non-read tool call is unverified | Step `terminal_error`; session cannot complete | Runner 6A un-emitted-event perturbation | H2, H5, H6 |
| **G14** | Idempotent side effects | DB: partial unique `(org_id, tool_name, idempotency_key)` | Code: 23505 → `deduped`, original output returned; retries reuse the key | One effect, one `deduped`, never a double write | H3 dry-run 23505; Runner 6A repeat-run test | H3, H6 |
| **G15** | No hard deletes / immutable ledger | DB: `guard_no_delete` + insert-only triggers on all four ledger tables | Code: no update/delete path in harness runtime | Mutation raises; session fails rather than rewriting history | slice 6 UPDATE + DELETE rejection per table | H2, H3 |
| **G16** | Kill switch | Data: `agent_harness_settings.enabled` (default **false**) → `agent_session_types.enabled` → `agent_tools.enabled` | Code: checked at session start **and** before every dispatch | Next dispatch refused; session `cancelled`, `terminal_reason='kill_switch'` | H16 mid-session flip test | H2, H16 |
| **G17** | Secrets never in context or logs | Code: deny-list redaction on context items, ledger payloads, log lines | Design: adapters read credentials from env only; harness holds no management token | Payload replaced by digest, `redaction_applied=true` | H16 planted-secret test across all three planes | H1, H16 |
| **G18** | Registry drift | Test: code↔`agent_tools` parity on name/version/effect class/schemas/`code_digest` | Code: unregistered name ⇒ `unknown_tool` refusal | Regression fails on drift; dispatch refuses unknown tools | H4 parity validator + perturbation (must fail) | H4 |
| **G19** | TEST-mode isolation | Code: fixture sessions touch only `fixture:%` / `@example.invalid`; `is_fixture` propagates to every child row | Data: `fixture_mode_only=true` refuses non-fixture session creation | `test_mode_violation`, no write | Runner 6A non-fixture-target refusal; slice 6 creation refusal | H2, H12 |
| **G20** | Model-provider portability | Code: all model access through `ModelAdapter`; ids from the router tier table | Lint: domain/registry modules may not import an adapter implementation | Non-conforming adapter cannot register; offline suites use the `deny` adapter | H7 conformance suite; Runner 2A byte-identical after refactor | H7 |

## Enforcement-layer summary

| Layer | Guardrails |
|---|---|
| Database schema/trigger (primary) | G2, G7(2nd), G13(2nd), G14, G15 |
| Code, single chokepoint (dispatcher/loop) | G1, G3, G5, G6, G8, G9, G10, G11, G12, G16, G17, G19, G20 |
| Data/config rows | G5, G8, G16, G19 |
| Absence of capability | G3 |
| Test-only (drift detection) | G18 |

**Rule for reviewers:** any guardrail whose only enforcement is code must name a
second layer or an explicit acceptance of the risk. Two currently carry a knowing
acceptance, both traceable to ADR-0002 (service role bypasses RLS): **G1** and
**G11**. Both are covered by mandatory refusal tests, and both improve
automatically if the harness ever moves to a least-privilege Postgres role.

## Non-vacuity requirement (M2)

Each test above must be demonstrated failing when its rule is broken, at the task
that introduces it, and the perturbation recorded in the task's handoff. Precedents
in this repo: S1's two perturbation runs, Runner 1's perturbed labels, `validate-migration-0015`'s
parity check.
