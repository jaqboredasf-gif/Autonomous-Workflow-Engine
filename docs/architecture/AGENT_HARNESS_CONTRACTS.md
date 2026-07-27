# Agent Harness — implementation contracts (H0, 2026-07-27)

Implementation-ready contracts for the six harness subsystems. Type sketches are
specification, **not production code** — H1+ implements them. Doctrine references
are to `AGENT_HARNESS_DOCTRINE.md` (D1–D20); guardrails to
`AGENT_HARNESS_GUARDRAILS.md` (G1–G20).

Status: **PROPOSED** with ADR-0001…0008.

---

## 1. Tool Registry

### 1.1 Descriptor schema

```ts
interface ToolDescriptor {
  // identity — immutable once registered
  name: string;              // snake_case, unique per org; matches MVP_SPEC registry names
  version: number;           // integer, starts at 1; bump = new row, old row retained
  code_digest: string;       // sha256 over the normalized descriptor (minus this field)

  // contract
  description: string;
  input_schema: JSONSchema;  // authored with zod, emitted as JSON Schema
  output_schema: JSONSchema;

  // tenancy
  tenancy: 'org_required';   // the ONLY permitted value in v1 (D4/G1)

  // authorization
  authz: {
    actor: 'service' | 'human';        // 'human' ⇒ a service actor is always refused (D2/G4)
    role?: BusinessRole;               // additional role requirement, checked by the RPC too
  };

  // side effects
  effect_class: 'read' | 'write_internal' | 'human_visible' | 'external';
                                        // 'external' may not appear in v1 (D1/G3)

  // execution
  timeout_ms: number;                   // per-attempt ceiling, ≤ session deadline
  retry: { eligible: boolean; classes: ErrorClass[]; max_attempts: number };
                                        // guard blocks are never eligible (D8)

  // idempotency
  idempotency: {
    kind: 'none' | 'natural_key' | 'caller_key';
    key?(input: unknown, ctx: ToolContext): string;   // PURE, deterministic (D10/G14)
  };

  // verification
  verify: { kind: 'pure' | 'db_read' | 'none';
            run?(result: unknown, ctx: ToolContext): Promise<VerifyResult> };
                                        // 'none' permitted ONLY for effect_class 'read'

  // audit + privacy
  audit: { event_type?: string;         // integration_events type the DB is expected to emit
           ledger: 'full' | 'digest' };  // 'digest' = payload stored as hash only
  redaction: { input_fields: string[]; output_fields: string[] };  // always digested

  handler(input: unknown, ctx: ToolContext): Promise<unknown>;
}
```

Validation rules (enforced by `descriptor.mjs`, unit-tested at H1):

1. `effect_class='external'` ⇒ **reject at load time** (D1).
2. `verify.kind='none'` ⇒ `effect_class` must be `read` (D6).
3. `effect_class ≠ 'read'` ⇒ `idempotency.kind ≠ 'none'` (D10).
4. `authz.actor='human'` ⇒ handler must route through an RPC that itself enforces
   the role; the registry records which (D2).
5. `timeout_ms > 0` and `≤ 60_000`.
6. `tenancy` must be `'org_required'`.
7. `code_digest` must match the recomputed digest — a mismatch is a load error.

### 1.2 Identity and versioning

`(org_id, name, version)` is the identity. Descriptors are immutable; a contract
change is a **new version**. Old versions stay in `agent_tools` with
`deprecated_at` set so historical `agent_tool_calls` rows remain interpretable.
`agent_session_types.allowed_tools` references names; the registry resolves to the
highest non-deprecated version at session start and pins it for the session's life.

### 1.3 Registration lifecycle

```
authored (code) → validated (descriptor.mjs) → digested → seeded (agent_tools row)
   → enabled (data) → [deprecated_at set] → superseded by version N+1
```
- Seeding is a migration or an explicit seed script — never an automatic upsert at
  runtime. The harness reads the registry; it never writes it.
- Parity between code and rows is checked every regression run (G18); drift fails
  the suite rather than widening authority silently.
- Disabling is data (`agent_tools.enabled=false`) and takes effect at the next
  dispatch.

### 1.4 Refusal behavior

| Situation | Result | Written |
|---|---|---|
| Name not in registry | `blocked: unregistered_tool` | no tool-call row; one `guard_block` step |
| In registry, not in `allowed_tools` | `blocked: tool_not_allowed` | one `guard_block` step |
| `enabled=false` (tool, type, or harness) | `blocked: disabled` | one `guard_block` step |
| Effect class above the type ceiling | `blocked: effect_ceiling_exceeded` | one `guard_block` step |
| `authz.actor='human'` and actor is service | `blocked: unauthorized_external_action` | one `guard_block` step |
| Input fails `input_schema` | `blocked: invalid_input` | one `guard_block` step |
| Code/DB digest mismatch | session refuses to start | none |

Refusals are terminal for that dispatch and are **never retried** (D8).

---

## 2. Dispatcher

### 2.1 Request

```ts
interface DispatchRequest {
  tool: string; version?: number;      // omitted ⇒ session-pinned version
  input: unknown;
  ctx: ToolContext;                    // org_id, session_id, step_seq, actor, is_fixture,
                                       // deadline_at, trace_id, db, log
  idempotency_key?: string;            // required when idempotency.kind='caller_key'
}
```

### 2.2 Validation sequence (fixed order, cheapest and most absolute first)

1. **Kill switch** — harness → session type → tool (G16).
2. **Session liveness** — session is `running`, lease held, `deadline_at` not passed (G9).
3. **Tenant binding** — `ctx.org_id` present, matches the session row; every id in
   the input that references a domain row is org-checked before use (G1).
4. **Registry lookup** — name+version resolve, digest matches (G18).
5. **Allowlist** — tool ∈ `agent_session_types.allowed_tools` (G5).
6. **Effect ceiling** — descriptor class ≤ type ceiling; `external` always refused (G3, G6).
7. **Actor authorization** — `authz.actor`/`role` vs `ctx.actor` (G4).
8. **Input validation** — `input_schema`; redaction applied to logged copy (G17).
9. **Groundedness** — for inputs derived from untrusted content (G11).
10. **Budget** — step/model/token/cost/wall-clock headroom (G7, G8, G9).
11. **Idempotency** — derive key, pre-check `agent_tool_calls`; existing success ⇒
    return `deduped` without executing (G14).

Any failure in 1–11 produces a **structured refusal**, one `agent_steps` row with
`kind='guard_block'`, and no tool-call row (except step 11, which writes a
`deduped` tool-call row referencing the original).

### 2.3 Execution → verification → audit

12. **Execute** `handler(input, ctx)` under `timeout_ms`; unique-violation (23505)
    is caught and resolved to `deduped`.
13. **Verify** per `verify.kind`. Non-read tools **must** verify. `verify.ok=false`
    ⇒ result `failed(error_class='verify_failed')`, non-retryable (D6/G13).
14. **Audit** — write `agent_tool_calls` (input/output per `audit.ledger`, redacted
    per `redaction`), link `step_id`, record `expected_event_type` and the observed
    `integration_events` id found by the Verify Step.
15. **Retry delegation** — on a retryable failure, return to the retry engine (§6);
    the dispatcher itself never loops.
16. **Human-gate routing** — a `human_visible` success that requires a human next
    action sets `session.status='awaiting_human'` with a pointer
    (`outbound_message_id` or block reason) and emits `agent.human_input_required`.

### 2.4 Structured refusal output

```ts
type BlockedReason =
  // dispatcher/gate refusals (no domain write)
  | 'unregistered_tool' | 'tool_not_allowed' | 'disabled'
  | 'effect_ceiling_exceeded' | 'external_effect_forbidden'
  | 'unauthorized_external_action' | 'invalid_input' | 'tenant_violation'
  | 'test_mode_violation' | 'ungrounded_extraction' | 'budget_exhausted'
  | 'duplicate_call' | 'kill_switch' | 'session_not_live'
  // routing refusals inherited from B3 (persist a blocked row)
  | 'no_policy' | 'policy_inactive' | 'missing_approver_role' | 'no_backup_approver'
  | 'missing_approval_limit' | 'missing_escalation_role'
  | 'draft_build_failed' | 'forbidden_content';

interface Refusal { status:'blocked'; reason: BlockedReason; detail?: string;
                    tool: string; step_seq: number; retryable: false }
```
The first group is new and harness-owned; the second is the existing B3 vocabulary
(`approval-matrix.mjs`) reused verbatim — **not** re-spelled. Any new reason must be
added to this union and to the eval's exhaustiveness check.

---

## 3. Verification Engine

A Verify Step is a deterministic read of **actual** state after a claimed action.
Model output and handler return values are never evidence (D6).

### 3.1 Six questions it must answer

| Question | Method | Evidence |
|---|---|---|
| **Did the effect occur?** | re-read the target row by id; compare the fields the tool claims to have set; confirm the expected `integration_events` row exists for `(entity_type, entity_id, event_type)`; confirm `org_id` matches | `{row_updated, values_match, org_scoped, event_present, no_duplicate_side_effect}` — the shape `db.mjs:verify()` already returns |
| **Did the effect NOT occur?** (refusals) | assert absence: target row unchanged (compare digest taken before dispatch), no new event for the entity, no new row in the tool's target table within the session | `{unchanged, no_event, no_new_row}` — absence is asserted, never assumed |
| **Is it pending?** | the effect is not yet observable but a durable marker exists (queued row, `processing_status='pending'` event) | `status='pending'` with the marker id; the session may not report success and may not retry the side effect — it re-verifies on the next step, up to a bounded poll count |
| **Is it ambiguous?** | handler threw, timed out, or the connection dropped **and** the target state is neither clearly written nor clearly absent | resolved by **idempotency key lookup first** (`agent_tool_calls` by key), then a natural-key read. If still ambiguous ⇒ terminal `verify_failed`, human queue. Never resolved by retrying blind |
| **Was it duplicated?** | count rows matching the natural key; > 1 is a duplication defect | `no_duplicate_side_effect` (already in B2's verify); a duplicate is a terminal error and blocks completion |
| **Did rollback/compensation succeed?** | v1 has **no compensating actions** — the harness cannot undo a write (no hard deletes, D11/G15). "Rollback" means only: the transaction did not commit. Verify asserts the absence case above | `{unchanged, no_event, no_new_row}`; if a partial effect is found, the session terminates `failed` with `terminal_reason='partial_effect_unresolved'` and is escalated to a human — the harness never writes a "fix" |

### 3.2 Contract

```ts
interface VerifyResult {
  ok: boolean;
  status: 'confirmed' | 'absent' | 'pending' | 'ambiguous' | 'duplicated';
  checks: Record<string, boolean>;
  observed?: { row?: unknown; event_id?: string; count?: number };
  polled?: number;
}
```
Rules: verification always re-reads through the same `DbClient` as the write;
it never reads a cache, a summary, or a model claim (D13); a `pending` result may
be re-polled at most `verify_poll_max` (session-type config, default 3) times with
backoff, then becomes `ambiguous`; `ambiguous` and `duplicated` are terminal.

---

## 4. Context and Compaction

### 4.1 Item model

```ts
interface ContextItem {
  id: string;                       // stable within the session
  kind: 'domain_facts' | 'workflow_state' | 'tool_result' | 'policy'
      | 'human_decision' | 'untrusted_content' | 'derived_summary';
  trusted: boolean;                 // untrusted content and its summaries are false
  pinned: boolean;
  provenance: { source: 'db' | 'tool' | 'model' | 'static';
                ref?: {table:string; id:string}; step_seq?: number; digest: string };
  body: string;
  token_estimate: number;
}
```

### 4.2 Pinned set (never compacted, D13)

system rules and guardrail statements · session goal · tenant binding (`org_id`) ·
policy rows quoted verbatim · current workflow-state ids · open approval
constraints. If the pinned set alone exceeds the budget ⇒ **fail closed to human**,
never drop a pin.

### 4.3 Ladder

| Level | Trigger | Action | Reversible |
|---|---|---|---|
| L0 | < 60% of budget | none | — |
| L1 | ≥ 60% | replace large `tool_result` bodies with `{tool_call_id, one-line summary, digest}`; re-fetchable via a read tool | yes |
| L2 | ≥ 60% after L1 | **deterministic** template summarization of completed sub-goals, rendered from the step ledger — no model | yes (regenerable from ledger) |
| L3 | ≥ 85% | checkpoint: persist snapshot, discard window, restart context = pinned + snapshot + current workflow state | ledger retains everything |
| fail | ≥ 95% after L3 | terminate `blocked`, human queue | — |

### 4.4 Model summarization policy

Off unless `agent_session_types.model_summarization_enabled=true`. When on:
output is `kind='derived_summary'`, `trusted=false`, `provenance.source='model'`;
it may never be a Verify Step source; it may never summarize untrusted content into
a trusted item; its token cost is charged to the session budget like any other call.
**Deterministic fallback:** if the summarization call fails or its output fails
validation, the engine falls back to L2 template summarization — it never proceeds
with an unvalidated summary and never skips compaction.

### 4.5 Token estimation

Deterministic local heuristic (character/word based), never a provider tokenizer
call: compaction plans must be reproducible offline and identical across runs.
The estimator is calibrated to over-estimate; under-estimating risks a provider-side
truncation the harness cannot see.

### 4.6 Audit record and blocking conditions

Every compaction writes `agent_context_snapshots` (level, `produced_by`,
`covers_seq_from/to`, `summary`, `pinned` jsonb, `token_estimate`, `source_digest`)
plus an `agent_steps` row with `kind='compaction'`.

Compaction is **blocked** (and the session fails closed) when: a pin would be
dropped · a trust label would be promoted · an untrusted item would lose its
delimiters · the snapshot write fails · the plan is non-deterministic across a
double evaluation in a fixture run.

---

## 5. Session Manager

### 5.1 Session types

Config rows (`agent_session_types`), not code: `key`, `allowed_tools[]`,
`max_effect_class`, `model_tier`, five budgets, `requires_human_gate`,
`compaction_enabled`, `model_summarization_enabled`, `verify_poll_max`, `enabled`.
v1 ships exactly one: **`triage_email`** — fixture-only, ceiling `write_internal`
(raised to `human_visible` at H14).

### 5.2 States and transitions

```
created → claimed → running → { compacting → running
                              | awaiting_tool → running
                              | awaiting_human → running (after human action)
                              | completed | failed | blocked | cancelled }
claimed|running --lease expiry--> expired --resume--> claimed
```
Terminal: `completed`, `failed`, `blocked`, `cancelled`. `completed` requires
`verify_ok=true` **and** zero unverified non-read tool calls (G13, DB-enforced).

### 5.3 Lease

Acquisition is a conditional UPDATE — no advisory locks, no new infrastructure:
```sql
update agent_sessions set claimed_by=$w, lease_expires_at=now()+$sec, status='claimed'
 where id=$id and (lease_expires_at is null or lease_expires_at < now())
   and status in ('created','claimed','running','expired')
returning *;
```
Zero rows ⇒ someone else owns it. Renewal is the same statement issued by the
holder each loop iteration; a holder that cannot renew **stops** rather than
continuing unowned (duplicate-worker prevention). `expire_agent_leases()` marks
lapsed sessions `expired`.

### 5.4 Durable checkpoints and crash recovery

Checkpoint = the ledger itself. After every step the session row's counters and
status are updated in the same call that appends the step. `resume()` reads
session + steps + latest snapshot and rebuilds context; **no in-memory state is
authoritative** (D9). Acceptance: kill mid-session, resume, reach the same terminal
state and the same verified effects.

### 5.5 Cancellation, expiry, handoff, isolation

- **Cancellation:** `cancel(session, reason)` sets `cancelled`; the loop checks the
  status before each dispatch, so cancellation takes effect at the next boundary,
  never mid-write.
- **Expiry:** lease lapse ⇒ `expired`; resumable; budgets already consumed stay
  consumed.
- **Handoff:** `awaiting_human` carries a pointer to the artifact a human must act
  on; the human action (approval RPC) is what moves the session on. The harness
  never polls itself into approval (D2).
- **Isolation:** one org per session, always explicit; a child session inherits the
  parent's org and cannot widen it; fixture sessions may touch only fixture rows
  (G19).

---

## 6. Retry Engine

### 6.1 The eight classes

| # | Class | Examples | Retryable | Max attempts | Backoff |
|---|---|---|---|---|---|
| 1 | `transient_provider` | HTTP 429/5xx, timeout, connection reset | yes | 3 | exp 1s/2s/4s + jitter, cap 30s |
| 2 | `transient_infra` | Supabase 429/5xx, transient DB error | yes | 5 | exp, cap 30s (matches `db.mjs`) |
| 3 | `invalid_output` | parse failure, schema violation | yes, **once** | 1 repair | none (immediate repair prompt) |
| 4 | `tool_error_retryable` | lease race, optimistic-concurrency conflict | yes | 2 | exp 0.5s/1s + jitter |
| 5 | `tool_error_terminal` | constraint violation, authz denial, unknown tool | **no** | 0 | — |
| 6 | `guard_block` | any guard refusal | **never** | 0 | — |
| 7 | `budget_exhausted` | any of five budget dimensions | **never** | 0 | — |
| 8 | `verify_failed` | Verify Step false, ambiguous, duplicated | **no** | 0 | — |

### 6.2 Rules

- **Retry budget:** every attempt is a step and is charged to the session's step,
  model-call, token and cost budgets. There is no free retry (D7).
- **Jitter:** full jitter (`random(0, backoff)`), computed from a seeded RNG in
  fixture mode so replay stays deterministic (D19).
- **Verification between attempts:** before retrying a side-effecting tool, the
  engine re-runs the tool's Verify Step. If the effect already landed, the retry is
  abandoned and the result is `deduped` — this is the ambiguous-failure path (§3.1).
- **Duplicate-effect prevention:** a retry always reuses the original idempotency
  key (G14).
- **Ledger representation:** attempt N is an `agent_steps` row with `attempt=N`,
  `error_class`, `error_message`; the eventual success (or terminal failure) is the
  last row in that chain. `agent_model_calls.retry_of` links a retried model call to
  its predecessor. Nothing is collapsed or summarized in the ledger (D11).
- **Exhaustion:** class 1/2/4 exhaustion ⇒ terminal `failed` with the class as
  `terminal_reason`. Class 3 exhaustion ⇒ **fail closed** to `needs_review` (the B2
  behavior), not `failed`.

---

## 7. Cross-contract invariants (review checklist)

1. Every side effect passes through the dispatcher; there is no second write path.
2. Every non-read dispatch is followed by a Verify Step in the same step.
3. Every refusal reason is in the `BlockedReason` union and is exhaustively tested.
4. Every retry reuses an idempotency key and re-verifies first.
5. Every ledger row is insert-only; nothing is updated or deleted.
6. Every context item carries trust + provenance, and both survive compaction.
7. Every budget is checked in code and backstopped in the database.
8. `org_id` appears in every context, every query, and every assertion.
