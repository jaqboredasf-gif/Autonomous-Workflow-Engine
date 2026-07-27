# Agent Harness — doctrine (H0, 2026-07-27)

Non-negotiable rules for the Agent Harness subsystem. **Status: PROPOSED** until
Jack ratifies ADR-0001…ADR-0008 (see `docs/architecture/decisions/README.md`).

How to read a rule: every rule states its **primary enforcement layer**, a
**second layer** where one is required, the **failure behavior** when it trips, the
**regression test** that proves it is alive, and its **guardrail number** (G1–G20,
enforcement detail in `AGENT_HARNESS_GUARDRAILS.md`).

Two meta-rules govern the rest:

- **M1 — Enforcement or it is not a rule.** A constraint that exists only in a
  prompt or only in a comment is documentation, not doctrine. Every rule below
  names a mechanism.
- **M2 — Non-vacuity.** Every regression test named below must be shown to fail
  when its rule is deliberately broken. A test that cannot fail proves nothing.
  This is the repo's existing standard (S1 perturbation runs, Runner 1 perturbed
  labels) applied to the harness.

---

## D1 — Zero automatic external sending

The harness never transmits anything outside the organization: no email, no SMS,
no calendar write, no webhook to a third party, no QuickBooks call.

- **Primary enforcement:** absence — no tool descriptor declares
  `effect_class='external'`, so no dispatchable path exists.
- **Second layer:** `agent_session_types.max_effect_class` carries a check
  constraint forbidding `'external'`; the dispatcher raises unconditionally on an
  `external` descriptor.
- **Failure behavior:** refusal before any write, `blocked_reason='external_effect_forbidden'`,
  session → `blocked`, event `agent.tool_blocked`.
- **Regression test:** slice 6 asserts zero `external` rows in `agent_tools` and that
  the type check rejects `max_effect_class='external'`; Runner 6A registers a
  test-only external descriptor and asserts the dispatcher raises **before** any
  ledger write.
- **Guardrail:** G3. **Related:** ADR-0001 non-goal 2, MVP_SPEC "zero v1 auto-sends".

## D2 — Automation never approves its own work

No service actor may approve, reject, mark-sent, or confirm a duplicate.

- **Primary enforcement:** registry — `record_approval`, `mark_message_sent`,
  `link_duplicate` declare `authz.actor='human'`; the dispatcher refuses a service
  actor.
- **Second layer:** the database. `record_approval()` / `mark_message_sent()` (0015)
  already enforce approver-role RLS, and `outbound_messages` cannot reach `sent`
  without an approval row.
- **Failure behavior:** `blocked_reason='unauthorized_external_action'`, no write,
  session → `awaiting_human`.
- **Regression test:** H14 acceptance — a service-actor `record_approval` is blocked
  and writes nothing; slices 4 and 5 stay green.
- **Guardrail:** G4. **Related:** REQUIREMENTS approval matrix, ADR-0006.

## D3 — Human-visible actions require authorization

Anything a human will see and act on (a draft, a queue item) is dispatchable only
when the session type allows it, the tool is enabled, and the actor class matches.

- **Primary enforcement:** guard chain — allowlist (`agent_session_types.allowed_tools`)
  then effect ceiling then actor class.
- **Second layer:** the underlying RPC's own RLS/role checks (`create_outbound_draft()`
  routes through `message_policies`; an unconfigured responsibility blocks with
  `missing_approver_role` and never falls back to a default approver).
- **Failure behavior:** structured refusal, blocked row or no write per the existing
  gate/route split, `agent.tool_blocked`.
- **Regression test:** H14 — a session type without `create_outbound_draft` in its
  allowlist is refused; Runner 4/5 stay green.
- **Guardrail:** G5, G6. **Related:** APPROVAL_MATRIX.md.

## D4 — Tenant binding at every boundary

`org_id` is explicit, carried end to end, and asserted on the way out.

- **Primary enforcement:** code — `org_id` is a required argument of session
  creation, lives in `ToolContext`, filters every read, is set on every write, and
  is compared against every returned row.
- **Second layer:** schema — `org_id NOT NULL` + FK on every harness table; RLS on
  with zero client policies. Note the service role **bypasses RLS** (ADR-0002), so
  the code assertion is load-bearing, not decorative.
- **Failure behavior:** cross-org input refused before any write with
  `blocked_reason='tenant_violation'`; session → `blocked`. A cross-org row observed
  in a Verify Step is a `verify_failed` terminal error, never a warning.
- **Regression test:** Runner 6A cross-org refusal case (a session for org A handed
  an entity from org B); slice 6 asserts `org_id NOT NULL` on all harness tables.
- **Guardrail:** G1, G2. **Related:** ADR-0002; the MCP `orgs limit 1` pattern is
  explicitly prohibited.

## D5 — Untrusted input stays untrusted, including after compaction

Inbound email, customer text, attachment names, and any model-derived summary of
them are **data**. Instructions found inside them are never actions.

- **Primary enforcement:** code — `ContextItem.trusted=false` plus delimiters; the
  assembler never emits untrusted content outside its delimiter block; compaction
  preserves both the flag and the delimiters; a summary of untrusted content is
  itself untrusted.
- **Second layer:** dispatch — tool inputs derived from untrusted content pass the
  groundedness check (D6/G11) before any write.
- **Failure behavior:** an untrusted item that cannot be delimited, or a compaction
  plan that would merge untrusted into a trusted section, aborts compaction; session
  fails closed to the human queue rather than shipping the packet.
- **Regression test:** H9/H10 unit suites — trust-label preservation across L1–L3;
  an attempted trust promotion fails the suite.
- **Guardrail:** G10. **Related:** AGENT_HARNESS.md §2, `buildPacket()` today.

## D6 — Verification determines success; absence of an exception does not

A tool that returns cleanly has proved nothing. A tool that throws after committing
has not necessarily failed.

- **Primary enforcement:** code — every non-`read` dispatch runs its Verify Step; the
  `DispatchResult` is `succeeded` only when `verify.ok` is true.
- **Second layer:** database — `agent_sessions` cannot transition to `completed`
  while any non-read `agent_tool_calls` row for the session has `verified` false or
  null (transition trigger).
- **Failure behavior:** step `terminal_error`, session cannot complete; terminal
  state is `failed` with `terminal_reason='verify_failed'`.
- **Regression test:** Runner 6A — a deliberately un-emitted event makes verify fail
  and blocks completion (non-vacuity per M2).
- **Guardrail:** G13. **Related:** MVP_SPEC § Verify Steps; `db.mjs:verify()`.

## D7 — Retry limits and retry eligibility are fixed by class, not by judgment

Eligibility comes from the error taxonomy, never from a caller's opinion.

- **Primary enforcement:** code — `failure/taxonomy.mjs` + `retry.mjs`: eight classes,
  fixed caps, exponential backoff with jitter, one repair attempt for
  `invalid_output`.
- **Second layer:** budget — every attempt is charged to the session's model-call and
  step budgets; the DB `enforce_agent_budget` trigger stops the ledger regardless.
- **Failure behavior:** cap reached ⇒ terminal `failed` (or fail-closed to human for
  `invalid_output`), event `agent.budget_exhausted` when a budget caused it.
- **Regression test:** H8 injected-failure unit suite covering every class; Runner 6A
  asserts retry counts appear as separate steps.
- **Guardrail:** G7, G8. **Related:** B2's fixed "1 call + ≤2 retries".

## D8 — Guardrail failures are never retried automatically

A refusal is a decision, not a transient fault.

- **Primary enforcement:** code — `guard_block` is classified non-retryable; the
  retry controller has no path that re-dispatches a blocked call.
- **Second layer:** ledger — a blocked call is written as `status='blocked'` with a
  reason; a second identical attempt within a session is itself a defect the eval
  detects.
- **Failure behavior:** terminal `blocked`, human queue, `agent.tool_blocked`.
- **Regression test:** H8/H13 — a guard-blocked dispatch produces exactly one
  `agent_tool_calls` row and zero retries.
- **Guardrail:** G6, and every guard it protects.

## D9 — Durable state is the only source of truth

In-memory state is a cache. A session is fully reconstructible from
`agent_sessions` + `agent_steps` + the latest snapshot.

- **Primary enforcement:** code — `resume()` rebuilds from the database only; no
  loop state survives a process boundary.
- **Second layer:** lease — `claimed_by` + `lease_expires_at` make an abandoned
  session recoverable rather than stuck.
- **Failure behavior:** a session whose durable state cannot be rebuilt terminates
  `failed` with `terminal_reason='unrecoverable_state'` instead of guessing.
- **Regression test:** H11/H13 resume-equivalence — kill mid-session, resume, reach
  the same terminal state and the same verified effects.
- **Guardrail:** G9 (lease/timeout). **Related:** ADR-0003.

## D10 — Idempotency for every side effect

Re-running must never double-write.

- **Primary enforcement:** database — partial unique index
  `(org_id, tool_name, idempotency_key)` on `agent_tool_calls`; domain-level natural
  keys unchanged (`(org, graph_message_id)`, `draft_key`, `(device_id, client_uuid)`).
- **Second layer:** code — the dispatcher resolves a unique violation to
  `status='deduped'` and returns the original output; retries reuse the same key.
- **Failure behavior:** `deduped`, never a second effect, never a silent failure.
- **Regression test:** Runner 6A — a repeated fixture run produces one effect and one
  `deduped`; H3 dry-run proves the index raises 23505 on a double insert.
- **Guardrail:** G14. **Related:** ADR-0005 (idempotent fixture session keys).

## D11 — Audit evidence is immutable

The ledger records what happened, including the attempts that failed.

- **Primary enforcement:** database — insert-only triggers on `agent_steps`,
  `agent_tool_calls`, `agent_model_calls`, `agent_context_snapshots`; `guard_no_delete`
  on every harness table.
- **Second layer:** code — the harness has no update or delete path against ledger
  tables; the layering lint keeps ledger writers isolated.
- **Failure behavior:** attempted mutation raises; the session fails rather than
  rewriting history.
- **Regression test:** slice 6 — an UPDATE and a DELETE against each ledger table are
  both rejected against real rows.
- **Guardrail:** G15. **Related:** 0014's `guard_approval_draft_immutability` idiom.

## D12 — Secrets are redacted everywhere, and never enter context

- **Primary enforcement:** code — deny-list redaction applied to every context item,
  every ledger payload, and every log line: API keys, JWTs, `sbp_` tokens,
  service-role keys, `Authorization` headers, connection strings.
- **Second layer:** design — adapters read credentials from env only; no credential
  is ever a function argument that could be logged; harness runtime holds no
  management token (ADR-0002).
- **Failure behavior:** a payload that fails the redaction check is replaced by a
  digest; the step records `redaction_applied=true`.
- **Regression test:** H16 redaction test — a synthetic secret planted in an input
  appears in none of the three planes (DB ledger, `integration_events`, JSONL trace).
- **Guardrail:** G17. **Related:** CONTEXT.md secrets rules.

## D13 — Compaction has boundaries it may not cross

- **Primary enforcement:** code — the pinned set (system rules, guardrail
  statements, session goal, tenant binding, quoted policy rows, current workflow
  ids, open approval constraints) is never compacted; trust labels and provenance
  survive every level; model summarization is off unless
  `agent_session_types.model_summarization_enabled` is true.
- **Second layer:** verification — a `derived_summary` may never be the source for a
  Verify Step; verification always re-reads real state.
- **Failure behavior:** if pinned content alone exceeds the budget, the session fails
  closed to the human queue. It never drops a guardrail to fit.
- **Regression test:** H10 unit suite — pinned-overflow fails closed; determinism
  (same input ⇒ same plan) across two runs; trust preservation L1→L3.
- **Guardrail:** G10, G13. **Related:** DESIGN §9.

## D14 — Model providers are replaceable

No domain module names a provider, a model id, or a provider-specific field.

- **Primary enforcement:** code — everything goes through `ModelAdapter`; model ids
  come from the router's tier table; `prompt_version` is recorded on every call.
- **Second layer:** layering lint — domain and registry modules may not import an
  adapter implementation.
- **Failure behavior:** an adapter that fails the conformance test cannot be
  registered; a provider outage falls through the router's fallback chain, and a
  fully exhausted chain is a `transient_provider` terminal after its cap.
- **Regression test:** H7 conformance suite; the `deny` adapter proves offline suites
  make no network call; Runner 2A stays byte-identical after the refactor.
- **Guardrail:** G20. **Related:** ADR-0004, DECISION_LOG 2026-07-20 (provider-agnostic).

## D15 — Fail closed, always toward a human

Unknown, ambiguous, unparseable, or unverifiable ⇒ a human queue, never a guess and
never a silent success.

- **Primary enforcement:** code — unparseable output ⇒ `unknown`/`needs_review`;
  unknown territory ⇒ null, never `out_of_territory`; failed verify ⇒ failure state.
- **Second layer:** database — 0011's emergency lock and scheduling guard, 0015's
  `blocked_reason` rows, 0013's `request.triage_required` event.
- **Failure behavior:** terminal `blocked` or `awaiting_human` with a reason a human
  can act on.
- **Regression test:** Runner 6A fail-closed cases inherited from B2's fixture corpus.
- **Guardrail:** G12. **Related:** MVP_SPEC § Failure states.

## D16 — The kill switch stops the next action, at three levels

- **Primary enforcement:** data — `agent_harness_settings.enabled` (default **false**),
  `agent_session_types.enabled`, `agent_tools.enabled`, checked at session start
  **and** before every dispatch.
- **Second layer:** code — a disabled check raises before the guard chain even runs.
- **Failure behavior:** running sessions stop at the next dispatch and terminate
  `cancelled` with `terminal_reason='kill_switch'`; no partial effect is left
  unverified.
- **Regression test:** H16 — flipping the switch mid-session stops the next dispatch
  and terminates cleanly.
- **Guardrail:** G16. **Related:** ADR-0007.

## D17 — Every session is bounded on five dimensions

Steps, model calls, tokens, cost, wall clock. No unbounded session can be
*configured*, not merely none is configured.

- **Primary enforcement:** code — `budget.mjs` checks before each phase and charges
  every attempt, including retries.
- **Second layer:** database — `enforce_agent_budget` BEFORE INSERT on `agent_steps`
  rejects beyond `max_steps`; `agent_session_types` check constraints require every
  budget column `NOT NULL` and `> 0`; lease expiry backstops wall clock.
- **Failure behavior:** terminal `failed`, `terminal_reason='budget_exhausted'`,
  event `agent.budget_exhausted`.
- **Regression test:** H11 — a 1-step budget terminates after one step; slice 6 —
  inserting a session type with a null or zero budget is rejected.
- **Guardrail:** G7, G8, G9.

## D18 — Side effects are classified, and the ceiling is enforced twice

`read` < `write_internal` < `human_visible` < `external`. A session may never
dispatch above its type's ceiling.

- **Primary enforcement:** code — dispatcher compares descriptor class to
  `agent_session_types.max_effect_class`.
- **Second layer:** database — check constraint on the type row (and, per D1, no
  `external` value is permitted at all in v1).
- **Failure behavior:** refusal before any write, `blocked_reason='effect_ceiling_exceeded'`.
- **Regression test:** H6 — a `human_visible` tool dispatched from a
  `write_internal`-ceiling session is refused, ledger shows one blocked row.
- **Guardrail:** G6. **Related:** DESIGN §8.

## D19 — TEST behavior differs from production only by being *more* restrictive

- **Primary enforcement:** code — fixture sessions may only touch fixture data
  (`fixture:%` ids, `@example.invalid` recipients); `is_fixture` propagates to every
  child row; the `deny` model adapter is mandatory in offline suites.
- **Second layer:** data — `agent_harness_settings.fixture_mode_only` (default true)
  refuses non-fixture session creation entirely.
- **Failure behavior:** `blocked_reason='test_mode_violation'`, no write.
- **Regression test:** Runner 6A — a fixture session pointed at a non-fixture row is
  refused; slice 6 asserts `fixture_mode_only` blocks non-fixture creation.
- **Guardrail:** G19. **Related:** `approval-matrix.mjs` `enforceTestMode`, ADR-0005.

## D20 — The registry is the only way to reach a side effect

An unregistered tool is not "unimplemented" — it is refused.

- **Primary enforcement:** code — dispatch by name resolves through the registry or
  raises `unknown_tool`; there is no ad-hoc DB call path in harness runtime.
- **Second layer:** parity — code descriptors and `agent_tools` rows must match on
  name/version/effect class/schemas/`code_digest`, checked in regression; drift fails
  the suite.
- **Failure behavior:** `blocked_reason='unregistered_tool'`, no write.
- **Regression test:** H4 registry parity validator (with a perturbation proving it
  can fail); H6 unknown-tool refusal.
- **Guardrail:** G18. **Related:** ADR-0001 (single side-effect edge).

---

## Doctrine → guardrail index

| Rule | Subject | Guardrails |
|---|---|---|
| D1 | zero external send | G3 |
| D2 | automation never approves | G4 |
| D3 | human-visible authorization | G5, G6 |
| D4 | tenant binding | G1, G2 |
| D5 | untrusted stays untrusted | G10 |
| D6 | verification decides success | G13 |
| D7 | retry limits | G7, G8 |
| D8 | guard failures never retried | G6 + all |
| D9 | durable state is truth | G9 |
| D10 | idempotency | G14 |
| D11 | immutable audit | G15 |
| D12 | secret redaction | G17 |
| D13 | compaction boundaries | G10, G13 |
| D14 | provider portability | G20 |
| D15 | fail closed | G12 |
| D16 | kill switch | G16 |
| D17 | budgets | G7, G8, G9 |
| D18 | effect classification | G6 |
| D19 | TEST vs production | G19 |
| D20 | registry is the only path | G18 |
