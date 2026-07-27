# Agent Harness — implementation-ready architecture (design, 2026-07-27)

Status: **DESIGN ONLY.** No code, no migration, no live change is authorized by
this document. It defines the next major AWE subsystem so it can be built one
small approved task at a time (H0–H17, §16).

**H0 amendments (2026-07-27)** — two defects in this document were found during H0
inspection and are corrected by ADR:
- the kill switch is **`agent_harness_settings`**, not `org_settings.harness_enabled`
  (that column does not exist; `org_settings` is the payroll config table) —
  **ADR-0007**;
- the harness eval is **Runner 6**, not Runner 4 (Runners 1–5 are allocated) —
  **ADR-0008**.

H0 outputs that extend this document: `AGENT_HARNESS_DECISIONS.md` (O1–O5 resolved),
`AGENT_HARNESS_DOCTRINE.md` (D1–D20), `AGENT_HARNESS_GUARDRAILS.md` (G1–G20),
`AGENT_HARNESS_CONTRACTS.md`, `AGENT_HARNESS_H0_EXIT.md`, `AGENT_HARNESS_H1_BRIEF.md`,
`decisions/ADR-0001…0008`.

Foundation documents (authority order): `docs/architecture/UBIQUITOUS_LANGUAGE.md`
(vocabulary) → `docs/planning/MVP_SPEC.md` (tool registry, Verify Steps,
guardrails) → `docs/architecture/AGENT_HARNESS.md` (the built/partial/task
mapping this design extends) → `docs/planning/DATA_MODEL.md` (schema rules) →
`docs/testing/EVAL_STRATEGY.md` + `docs/testing/APPROVAL_MATRIX.md` (gates) →
`docs/API_CONTRACT.md` (endpoint conventions).

---

## 0. Why now — the doctrine trigger

DECISION_LOG 2026-07-17 locked: *"no generic agent runtime, no engine tables, no
tool-dispatch layer **until a second consumer exists**."* That condition has now
been met, and this design is the cash-out of that clause — not a reversal of it.

Consumers that today each re-implement harness concerns independently:

| Consumer | Re-implements |
|---|---|
| `scripts/classify.mjs` + `lib/classification.mjs` | packet build, retry budget, parse/validate, fail-closed, Verify Step, telemetry |
| `scripts/lib/outbound-draft.mjs` + `approval-matrix.mjs` | authz gate, allowed-action list, idempotency (`draft_key`), blocked-reason vocabulary, TEST-mode guard |
| `packages/mcp-server` | tool descriptors, input schemas, org/authz assumptions, error shape |
| `apps/web` API routes (B5) | the same authz + RFC7807 error surface |
| B12 n8n consumers (blocked) | retry/attempt accounting against `integration_events` |

Five copies of the same five concerns, with three different blocked-reason
vocabularies and two different DB access paths. **The harness is the extraction
of what already exists**, plus session state that does not exist yet. It is
still not a generic workflow engine: there are no `workflow_definitions`-style
tables, no DSL, no user-authored graphs. Behavior stays map-driven over concrete
domain tables (UBIQUITOUS_LANGUAGE §AWE).

**H0 must record this supersede in DECISION_LOG before H1 starts.** If the
trigger evidence above is judged insufficient, the correct outcome is to stop at
H0, not to build half of it.

### Non-goals (explicit, so they cannot creep in)

- No autonomous external send. Zero-v1-auto-send survives unchanged (§11).
- No long-lived daemon or queue worker in the first cut. Sessions are batch- or
  request-invoked and finite.
- No cross-session memory store, no RAG, no vector index.
- No user-facing agent chat surface.
- No replacement of DB triggers by application logic. Anything the database can
  enforce stays in the database.
- No new model capability. The first harness session type must reproduce Runner
  2A byte-for-byte (§16 H12).

---

## 1. Responsibilities

The harness owns exactly seven responsibilities. Anything else belongs to the
domain slice or the database.

1. **Session lifecycle** — create, claim, advance, checkpoint, terminate, resume
   a bounded unit of agent work, with durable state in the DB, never in memory.
2. **Tool dispatch** — one entry point through which every side effect passes:
   validate → authorize → guard → idempotency → execute → **verify** → record →
   emit event.
3. **Context assembly + compaction** — build the per-call packet from typed
   primitives, keep untrusted content quarantined, and shrink it deterministically
   when it grows.
4. **Model abstraction** — provider/model choice, tiering, replay for tests,
   token/cost metering, prompt versioning.
5. **Failure policy** — error classification, retry/backoff budgets, fail-closed
   terminal states, human-queue handoff.
6. **Guardrail enforcement** — budgets, allowlists, effect-class ceilings, tenant
   binding, kill switch. Code- and schema-enforced only; never prompt-only.
7. **Observability** — immutable step ledger, cost ledger, domain events,
   redacted developer trace, replayable session reconstruction.

**Not** harness responsibilities: business classification rules, approval matrix
semantics, draft templates, territory logic, payroll math. Those stay in the
domain modules the harness calls.

---

## 2. Components

New workspace package `packages/harness/` (ESM, Node ≥20, matching the existing
`packages/*` npm-workspaces layout). Consumed by `scripts/`, `packages/mcp-server`,
`apps/web`, and later n8n.

```
packages/harness/
  src/
    registry/
      descriptor.mjs      ToolDescriptor shape + validator (pure)
      registry.mjs        load descriptors, index by name@version, parity check vs agent_tools
      tools/              one file per tool binding (ingest_email, classify_request, …)
    dispatch/
      dispatcher.mjs      invokeTool(): the single side-effect gate
      idempotency.mjs     key derivation + dedupe resolution
      effects.mjs         effect-class ladder + ceiling enforcement
    verify/
      verify.mjs          Verify Step kinds + runner (generalizes lib/db.mjs verify())
    context/
      primitives.mjs      typed context primitives (AGENT_HARNESS.md §2)
      assembler.mjs       packet build, pinning, untrusted delimitation
      compaction.mjs      L0–L3 ladder, snapshot writer
      tokens.mjs          deterministic token estimator
    model/
      adapter.mjs         ModelAdapter interface + conformance check
      adapters/anthropic.mjs | replay.mjs | deny.mjs
      router.mjs          tier → adapter+model, fallback chain, cost table
      prompts.mjs         versioned prompt registry (PROMPT_VERSION ids)
    session/
      manager.mjs         create/claim/lease/advance/close, resume from DB
      loop.mjs            bounded step machine
      budget.mjs          step/call/token/cost/wall-clock accounting
    failure/
      taxonomy.mjs        error classes
      retry.mjs           policy + backoff + repair prompt
    guard/
      chain.mjs           pre-dispatch guard chain
      guards/*.mjs        tenant, allowlist, effect-ceiling, groundedness, kill-switch
    telemetry/
      logger.mjs          structured JSONL + redaction
      ledger.mjs          agent_steps / agent_tool_calls / agent_model_calls writers
    db/
      client.mjs          service-role Supabase client (see O1)
    index.mjs             public surface (only these exports are stable)
```

Layering rule (enforced by an import-lint check in H1): `registry` and `context`
and `failure` are **pure** — no network, no DB, no clock, no randomness. Only
`db`, `telemetry/ledger`, `dispatch`, `session`, and `model/adapters/anthropic`
may perform I/O. This is the same purity discipline `approval-matrix.mjs` and
`approval-diff.mjs` already prove works for evaluability.

---

## 3. Interfaces

Sketches for design review — not production code.

```ts
// ---- registry/descriptor -----------------------------------------------
type EffectClass = 'read' | 'write_internal' | 'human_visible' | 'external';
type VerifyKind  = 'pure' | 'db_read' | 'none';

interface ToolDescriptor {
  name: string;                 // 'classify_request'
  version: number;              // bump = new row in agent_tools, old stays for audit
  effect_class: EffectClass;
  description: string;
  input_schema: JSONSchema;     // zod-derived; zod is already a dep of mcp-server
  output_schema: JSONSchema;
  authz: { actor: 'service' | 'human'; role?: BusinessRole };
  idempotency: { kind: 'none' | 'natural_key' | 'caller_key';
                 key?(input, ctx): string };          // pure
  verify: { kind: VerifyKind; run?(result, ctx): Promise<VerifyResult> };
  event_type?: string;          // integration_events type this tool is expected to produce
  handler(input, ctx: ToolContext): Promise<unknown>;
}

interface VerifyResult { ok: boolean; checks: Record<string, boolean>; observed?: unknown }
```

```ts
// ---- dispatch ------------------------------------------------------------
interface ToolContext {
  org_id: string; session_id: string; step_seq: number;
  actor: { kind: 'service' | 'human'; user_id?: string; role?: BusinessRole };
  is_fixture: boolean; deadline_at: string; trace_id: string;
  db: DbClient; log: Logger;
}

type DispatchResult =
  | { status: 'succeeded'; output: unknown; verify: VerifyResult; tool_call_id: string }
  | { status: 'deduped';   output: unknown; tool_call_id: string }   // prior identical effect
  | { status: 'blocked';   reason: BlockedReason; detail?: string }  // never retried
  | { status: 'failed';    error_class: ErrorClass; message: string; retryable: boolean };

function invokeTool(ctx: ToolContext, name: string, input: unknown): Promise<DispatchResult>;
```

```ts
// ---- model ---------------------------------------------------------------
interface ModelInvocation {
  system: string; messages: {role:'user'|'assistant'; content:string}[];
  max_tokens: number; prompt_version: string; tier: 'fast'|'standard'|'deep';
}
interface ModelResult {
  text: string; usage: {input_tokens:number; output_tokens:number};
  latency_ms: number; finish_reason: string; provider: string; model: string;
}
interface ModelAdapter { name: string; model: string; invoke(i: ModelInvocation): Promise<ModelResult> }
```

```ts
// ---- context -------------------------------------------------------------
type PrimitiveKind =
  | 'domain_facts' | 'workflow_state' | 'tool_result' | 'policy'
  | 'human_decision' | 'untrusted_content' | 'derived_summary';

interface ContextItem {
  kind: PrimitiveKind; pinned: boolean; trusted: boolean;
  label: string; body: string; source_ref?: {table:string; id:string};
  token_estimate: number; step_seq?: number;
}
interface Packet { system: string; user: string; items: ContextItem[];
                   token_estimate: number; prompt_version: string }

function assemble(items: ContextItem[], budget: TokenBudget): Packet;      // pure
function compact(items: ContextItem[], budget: TokenBudget): CompactionPlan; // pure
```

```ts
// ---- session -------------------------------------------------------------
interface SessionSpec {
  org_id: string; type_key: string;             // agent_session_types.key
  goal: string; input_ref: {entity_type:string; entity_id:string};
  created_by: string; is_fixture: boolean; parent_session_id?: string;
}
function createSession(spec: SessionSpec): Promise<Session>;
function claim(session_id: string, worker: string, lease_seconds: number): Promise<Session>;
function advance(session_id: string): Promise<StepOutcome>;   // exactly one step
function run(session_id: string): Promise<SessionOutcome>;     // advance until terminal
function resume(session_id: string): Promise<Session>;         // rebuild from DB, no memory state
```

Stability rule: only `packages/harness/src/index.mjs` exports are consumable.
Anything reaching into a subpath is a review failure.

---

## 4. Data flow

```
 trigger (CLI fixture run | web API | n8n event | MCP tool)
        │
        ▼
 SessionManager.createSession ──► agent_sessions (status=created)  ──► integration_events: agent.session_started
        │                                     ▲
        ▼                                     │ lease/claim guard (single writer)
 SessionManager.claim ────────────────────────┘
        │
        ▼
 ┌───────────────────── bounded step loop (loop.mjs) ─────────────────────┐
 │ 1 assemble    ContextAssembler ← primitives ← domain reads (read tools)│──► agent_steps(kind=context_assembled)
 │ 2 compact?    token budget exceeded → CompactionPlan                   │──► agent_context_snapshots
 │ 3 decide      ModelRouter → adapter.invoke(packet)                     │──► agent_model_calls (+ cost)
 │ 4 parse       schema validate; invalid → RetryController(repair)       │──► agent_steps(attempt++)
 │ 5 guard       GuardChain: tenant, allowlist, effect ceiling,           │──► agent_steps(kind=guard_block)
 │               groundedness, kill switch, budget                        │
 │ 6 dispatch    Dispatcher.invokeTool → domain handler (RPC / SQL fn)    │──► agent_tool_calls
 │ 7 verify      VerifyStep: deterministic re-read of real state          │──► agent_tool_calls.verified
 │ 8 record      ledger writes; domain event emitted BY THE DB trigger    │──► integration_events
 │ 9 budget      steps/calls/tokens/cost/wall-clock → continue | terminate│
 └────────────────────────────────────────────────────────────────────────┘
        │
        ▼
 terminal: completed | failed | blocked | awaiting_human | cancelled | expired
        │                                            │
        ▼                                            ▼
 agent_sessions(ended_at, terminal_reason)   human queue (B5 UI / message_policies approval)
        │
        ▼
 integration_events: agent.session_completed | agent.session_failed | agent.human_input_required
        │
        ▼
 n8n consumers (B12, blocked) / eval Runner 4 / cost views
```

Two invariants visible in the diagram:

- **Every side effect crosses exactly one edge** (step 6). There is no path from
  the model to the database that skips the dispatcher.
- **Domain events are emitted by database triggers**, not by the harness. The
  harness records that it *expected* an event; the DB decides whether one
  exists. Verify Step (step 7) compares the two. This preserves MVP_SPEC's
  "DB-trigger events count by construction".

---

## 5. Database tables

Two additive migrations, deliberately split so each is small enough to review
and dry-run independently. Numbers assume S1's `0016` lands first; if not,
renumber at build time.

Schema rules inherited from DATA_MODEL.md and the S1 incident:
UUID PKs · `org_id` on every table · `created_at`/`updated_at` ·
**RLS enabled with ZERO client policies** (service-role only — the S1 finding was
exactly undeclared `TO authenticated` policies) · no hard deletes
(`guard_no_delete`) · append-only ledgers immutable after insert · statuses as
`text` + `check` constraint rather than PG enums, so adding a status is an
additive migration instead of an `ALTER TYPE`.

### 0017_agent_harness_core.sql — config + lifecycle

**`agent_harness_settings`** (added by ADR-0007) — org-level kill switch and
runtime defaults: `org_id` PK, `enabled` (default **false**), `max_concurrent_sessions`,
`default_lease_seconds`, `fixture_mode_only` (default **true**), `disabled_reason`,
`updated_at`. The harness arrives dormant; activation is a separate, auditable data
change. No harness migration touches a Workstream A table.

**`agent_session_types`** — data-driven session policy. Graduating budgets or
tool allowlists is a *data* change, exactly like `message_policies`.
```
id, org_id, key, display_name,
allowed_tools text[] not null,            -- names must exist in agent_tools
max_effect_class text not null check in (read|write_internal|human_visible|external)
                                          -- ceiling; 'external' forbidden in v1 by check
model_tier text check in (fast|standard|deep),
max_steps int, max_model_calls int, max_input_tokens int, max_output_tokens int,
max_cost_cents int, max_wall_seconds int,
requires_human_gate bool default true,
compaction_enabled bool default true, model_summarization_enabled bool default false,
enabled bool default true,
created_at, updated_at
unique (org_id, key)
```
Checks: every budget column `not null` and `> 0` (no unbounded session can be
configured); `max_effect_class <> 'external'` for v1 (drop the check in the
migration that first ships a real send, never before).

**`agent_sessions`**
```
id, org_id, session_type_key, parent_session_id null references agent_sessions(id),
status text check in (created|claimed|running|awaiting_human|awaiting_tool|
                      compacting|completed|failed|blocked|cancelled|expired),
goal text not null, input_entity_type text, input_entity_id uuid,
created_by text not null,                 -- user uuid or 'system:<runner>'
claimed_by text null, lease_expires_at timestamptz null,
started_at, ended_at, terminal_reason text null,
step_count int default 0, model_call_count int default 0,
input_tokens int default 0, output_tokens int default 0, cost_cents numeric default 0,
prompt_version text, model_id text, adapter text,
verify_ok bool null,                      -- null until terminal; completed REQUIRES true
is_fixture bool not null default false,
created_at, updated_at
```
Triggers:
- `guard_agent_session_transition` — allowed-transition matrix (mirrors
  `guard_outbound_transition` in 0015). `completed` unreachable unless
  `verify_ok = true` **and** zero `agent_tool_calls` rows for the session with
  `verified = false` and `effect_class <> 'read'`.
- `emit_agent_session_events` — `agent.session_started` / `agent.session_completed`
  / `agent.session_failed` / `agent.human_input_required` into `integration_events`.
- `guard_no_delete`.
- Single-writer: `claim` is a conditional UPDATE
  (`where status in ('created','claimed') and (lease_expires_at is null or lease_expires_at < now())`)
  — no advisory locks, no new infrastructure.

**`agent_steps`** — immutable ledger, one row per attempt (retries included).
```
id, org_id, session_id, seq int,
kind text check in (context_assembled|model_call|tool_call|guard_block|
                    compaction|human_gate|verify|terminal),
status text check in (ok|retryable_error|terminal_error|blocked),
attempt int default 0,
payload jsonb not null,                   -- redacted; digests for large bodies
error_class text null, error_message text null, duration_ms int,
created_at
unique (session_id, seq)
```
Triggers: `guard_agent_step_immutability` (no UPDATE of any column after
insert), `guard_no_delete`, `enforce_agent_budget` (BEFORE INSERT: reject when
`step_count >= max_steps` for the session's type — defense in depth behind the
in-code budget, so a harness bug cannot produce an unbounded run).

### 0018_agent_harness_ledger.sql — registry + call ledgers

**`agent_tools`** — DB mirror of the code registry; the enable/disable switch and
the audit record of what was callable when.
```
id, org_id, name, version int, effect_class text, description text,
input_schema jsonb, output_schema jsonb,
authz_actor text check in (service|human), authz_role business_role null,
idempotency_kind text check in (none|natural_key|caller_key),
verify_kind text check in (pure|db_read|none),
event_type text null, enabled bool default true, deprecated_at timestamptz null,
code_digest text not null,                -- sha256 of the descriptor; parity-checked
created_at, updated_at
unique (org_id, name, version)
```
Parity is enforced the way 0015↔`approval-matrix.mjs` already is: an offline
validator (`scripts/lib/validate-agent-registry.mjs`) asserts the code
descriptors and the seeded rows match on name/version/effect_class/schemas/
`code_digest`, and it runs in `regression.sh`. Drift fails the suite instead of
silently widening authority — the S1 lesson applied to tools.

**`agent_tool_calls`**
```
id, org_id, session_id, step_id, tool_name, tool_version, effect_class,
idempotency_key text null, input jsonb, output jsonb,
verify_result jsonb null, verified bool null,
expected_event_type text null, observed_event_id uuid null,
status text check in (succeeded|failed|blocked|deduped),
blocked_reason text null, created_at
unique (org_id, tool_name, idempotency_key) where idempotency_key is not null
```
That unique index is the **cross-session** dedupe: a retried or re-run
side effect resolves to `deduped` with the original output rather than a second
write. Same idiom as `(deviceId, clientUuid)` punches and `(org, graph_message_id)`
ingest.

**`agent_model_calls`**
```
id, org_id, session_id, step_id, provider, model, tier, prompt_version,
input_tokens, output_tokens, cost_cents numeric, latency_ms, finish_reason,
request_digest text, response_digest text, retry_of uuid null, is_fixture bool,
created_at
```
Bodies are **not** stored here by default — digests only (§13 redaction).
Fixture sessions may store bodies (`is_fixture = true`), which is what makes
eval replay possible without a PII surface.

**`agent_context_snapshots`**
```
id, org_id, session_id, level int check in (1,2,3),
produced_by text check in (deterministic|model),
covers_seq_from int, covers_seq_to int,
summary text, pinned jsonb, token_estimate int, source_digest text,
created_at
```
Immutable; `source_digest` makes a snapshot reproducible-or-detectably-stale.

### Views (read-only, service role)

- `agent_session_costs` — per session/type/day: calls, tokens, cost, p50/p95 latency.
- `agent_blocked_sessions` — sessions in `blocked`/`awaiting_human` with last
  block reason; the human queue's data source.
- `agent_tool_health` — per tool: calls, failure rate, verify-fail rate, dedupe rate.

### New `integration_events` types

`agent.session_started`, `agent.session_completed`, `agent.session_failed`,
`agent.human_input_required`, `agent.budget_exhausted`, `agent.tool_blocked`.
Six, all session-scoped. Domain events (`request.classified`, `message.approved`, …)
stay owned by the domain tables' own triggers — the harness never emits them.

---

## 6. APIs

### 6.1 SQL RPCs (security definer, service role)

| RPC | Purpose | Guard |
|---|---|---|
| `start_agent_session(org, type_key, goal, entity_type, entity_id, created_by, is_fixture)` | insert session | type must exist + `enabled`; org kill switch off ⇒ raise |
| `claim_agent_session(session, worker, lease_seconds)` | single-writer claim | conditional update; returns null when already leased |
| `record_agent_step(session, seq, kind, status, payload, …)` | ledger append | immutability + budget triggers |
| `record_tool_call(session, step, tool, input, output, verify, status, idem_key)` | ledger append + dedupe | unique index resolves duplicates |
| `record_model_call(session, step, provider, model, usage…)` | cost ledger | — |
| `close_agent_session(session, status, terminal_reason, verify_ok)` | terminal transition | transition matrix; `completed` requires `verify_ok` |
| `expire_agent_leases()` | reclaim dead leases → `expired` | idempotent, safe to run repeatedly |

### 6.2 Internal HTTP (`apps/web/src/app/api/agent/*`)

Follows API_CONTRACT.md: org-scoped by auth token, RFC 7807 `problem+json`
errors. Admin-role only in v1.

| Method | Route | Notes |
|---|---|---|
| POST | `/api/agent/sessions` | body: `{type_key, goal, input_ref, is_fixture}` → 201 + session. Refuses `is_fixture:false` while the org kill switch or type is disabled. |
| GET | `/api/agent/sessions?status&type&from&to` | queue/list |
| GET | `/api/agent/sessions/:id` | session + budget consumption |
| GET | `/api/agent/sessions/:id/trace` | ordered steps + tool calls + model-call metadata (redacted) |
| POST | `/api/agent/sessions/:id/advance` | run exactly one step (debug/stepping) |
| POST | `/api/agent/sessions/:id/run` | run to terminal, bounded by budget; 202 + terminal state |
| POST | `/api/agent/sessions/:id/cancel` | body `{reason}` → `cancelled` |
| POST | `/api/agent/sessions/:id/resume` | rebuild from DB after a crash |

No public route. No unauthenticated route. No route that sends anything.

### 6.3 MCP tools (`packages/mcp-server`)

Thin wrappers, read-mostly: `get_agent_session`, `list_blocked_sessions`,
`get_agent_session_trace`, `run_fixture_triage_session` (**fixture-only** —
refuses `is_fixture:false` outright). Consistent with the existing server's
"org-internal automation, never an untrusted surface" header comment.

### 6.4 CLI

```
node scripts/agent.mjs --type triage_email --fixture fixtures/emails/01.json \
                       --adapter fixture|live [--persist] [--max-steps N]
node scripts/agent.mjs --resume <session-id>
node scripts/agent.mjs --selftest        # offline guard checks, no DB, no network
```
Same shape as `classify.mjs`: thin entrypoint, JSON to stdout, non-zero exit when
any Verify Step fails. The model never decides the exit code.

---

## 7. Execution lifecycle

### Session states

```
created ──claim──► claimed ──► running ──┬──► completed        (all writes verified)
   │                  │           │      ├──► failed           (terminal error / budget)
   │                  │           │      ├──► blocked          (guard refusal, human queue)
   │                  │           │      ├──► awaiting_human   (approval gate reached)
   │                  │           │      └──► cancelled        (operator)
   │                  │           ├──► compacting ──► running
   │                  │           └──► awaiting_tool ──► running
   └──────────────────┴──lease expiry──► expired ──resume──► claimed
```
Transitions not on this diagram are rejected by `guard_agent_session_transition`.
Terminal states are final; a resumed `expired` session continues as a new claim
on the same row, and every attempt stays in the step ledger.

### Step machine (one iteration of `loop.mjs`)

| # | Phase | Failure behavior |
|---|---|---|
| 1 | Budget precheck | over budget → `agent.budget_exhausted`, terminal `failed` |
| 2 | Context assembly (read tools only) | read failure → retryable (§12) |
| 3 | Compaction if over threshold | compaction failure → checkpoint at L3, else terminal |
| 4 | Model call (skipped for deterministic steps) | provider error → retryable; budget-capped |
| 5 | Output parse + schema validate | invalid → one repair attempt, then fail-closed |
| 6 | Guard chain | block → `agent.tool_blocked`, `blocked` (never retried) |
| 7 | Dispatch | terminal tool error → `failed`; retryable → §12 |
| 8 | Verify Step | verify fail → step `terminal_error`; session may not complete |
| 9 | Ledger + budget update | ledger write failure → retryable; if unrecoverable, session `failed` (never silently continues) |

**Determinism rule:** with the replay adapter and a fixed fixture set, the entire
step sequence — including retries, blocks, and compaction decisions — must be
byte-identical across runs. That property is what makes Runner 4 a real gate
rather than a smoke test.

---

## 8. Tool registry

Single source of truth = **code descriptors**, mirrored into `agent_tools` and
parity-checked every regression run. Why both: code gives schemas and handlers;
the table gives an auditable "what was callable, and enabled, at time T" record
plus an ops kill switch that needs no deploy.

### Effect-class ladder (the core authority control)

| Class | Meaning | v1 status |
|---|---|---|
| `read` | no state change | allowed |
| `write_internal` | writes AWE tables, invisible outside the org | allowed |
| `human_visible` | creates something a human will see and act on (a draft, a queue item) | allowed |
| `external` | leaves the system (email, calendar, QB, SMS) | **structurally refused**: no descriptor may declare it, `agent_session_types.max_effect_class` check forbids it, and the dispatcher raises on it |

A session may never dispatch above its type's `max_effect_class`. The ceiling is
checked twice — code (dispatcher) and data (`agent_session_types` check) — because
the S1 finding was precisely a case where one enforcement layer was absent.

### Seed registry (the 10 MVP_SPEC tools, unchanged semantics)

| Tool | Effect | Idempotency | Verify | Notes |
|---|---|---|---|---|
| `ingest_email` | write_internal | natural_key `(org, graph_message_id)` | db_read | 23505 ⇒ `deduped` |
| `check_emergency_keywords` | read | none | pure | wraps `is_emergency_text()` |
| `check_territory` | read | none | pure | wraps `check_territory()` |
| `classify_request` | write_internal | natural_key (work_request per email) | db_read | the only model-assisted tool |
| `create_work_request` | write_internal | natural_key (email_message_id) | db_read | emergency lock is trigger-enforced |
| `link_duplicate` | human_visible | caller_key | db_read | `authz.actor = 'human'` |
| `escalate_emergency` | — | — | — | **not registered**: DB trigger owns it; registering it would imply the agent can choose to escalate |
| `create_outbound_draft` | human_visible | natural_key `draft_key` | db_read | delegates to `create_outbound_draft()` RPC |
| `record_approval` | human_visible | caller_key | db_read | `actor='human'`; agent may never be the approver |
| `mark_message_sent` | human_visible | caller_key | db_read | ledger entry after a human sent it |

Registering a tool does **not** grant an agent access to it: `agent_session_types.allowed_tools`
does, per session type, as data.

---

## 9. Context compaction strategy

Budget: `context_budget_tokens` per session type. Thresholds as fractions —
compact at 0.60, checkpoint at 0.85, hard-fail at 0.95 (fail-closed to human
rather than truncating silently).

**Pinned, never compacted:** system rules and guardrail statements · session goal ·
`org_id` and tenant binding · the active policy rows quoted verbatim · the current
workflow-state ids · any open approval constraint. If pinned content alone exceeds
the budget, the session fails closed — it never drops a guardrail to fit.

**Ladder**

| Level | Action | Reversible? |
|---|---|---|
| L0 | none | — |
| L1 | Replace large tool-result bodies with `{tool_call_id, summary_line, digest}` pointers; the agent can re-fetch via a read tool | yes (pointer resolvable) |
| L2 | Deterministic structured summarization of completed sub-goals — template-rendered from the step ledger, no model. Written to `agent_context_snapshots(produced_by='deterministic')` | yes (regenerable from ledger) |
| L3 | Checkpoint: persist snapshot, discard the window, restart context = pinned + snapshot + current workflow state | ledger retains everything |

Model summarization (`produced_by='model'`) is **off by default**
(`model_summarization_enabled=false`) and, when enabled, is subject to three rules:
it is stored as `derived_summary` (trusted=false for evidentiary purposes), it can
never be the source for a Verify Step, and it may never summarize untrusted
content into a trusted section.

**Untrusted-content rule survives compaction.** Untrusted items keep their
delimiters and their `trusted:false` flag through every level; L2/L3 summaries of
untrusted material are themselves marked untrusted. Compaction is a size
operation, never a trust-laundering operation.

**Determinism:** the token estimator is deterministic (character/word heuristic,
not a provider tokenizer call), so the compaction plan for a given item list is a
pure function — unit-testable and replay-stable.

---

## 10. Session management

- **Durable-state-only.** In-memory state is a cache; a session is fully
  reconstructible from `agent_sessions` + `agent_steps` + latest snapshot.
  `resume()` proves it, and Runner 4 includes a mid-session kill-and-resume test.
- **Single writer via lease.** `claimed_by` + `lease_expires_at`; a conditional
  UPDATE is the lock. `expire_agent_leases()` reclaims dead workers. Two runners
  cannot advance one session.
- **Session types are config, not code** (`agent_session_types`): allowed tools,
  budgets, tier, human-gate flag, compaction switches. Adding a session type is a
  data change plus a bound tool set; changing budgets never requires a deploy.
- **First type: `triage_email`.** Input = one `email_messages` row (or fixture);
  it invokes `classify_request` through the harness and reaches `completed` only
  when the existing Verify Step passes. It must reproduce Runner 2A exactly.
- **Parent/child sessions** are schema-supported (`parent_session_id`) but no
  spawning API ships in v1 — the column exists so sub-agents don't require a
  migration later.
- **Fixture isolation.** `is_fixture` propagates from session → steps → tool calls
  → model calls, and fixture sessions may only touch fixture rows
  (`graph_message_id LIKE 'fixture:%'` / `@example.invalid` recipients), enforced
  by the TEST-mode guard already proven in `approval-matrix.mjs`.

---

## 11. Guardrails

Enforceable only. A rule that exists solely in a prompt is not a guardrail here.

| # | Guardrail | Mechanism | Layer |
|---|---|---|---|
| G1 | Tenant boundary | `org_id` on every table + RLS + dispatcher asserts every touched row's `org_id` equals session org | DB + code |
| G2 | Service-role-only harness tables | RLS on, **zero** client policies, pinned by an acceptance check counting `pg_policies` (the S1 pattern) | DB + test |
| G3 | Zero external send | no `external` descriptor exists; `agent_session_types` check forbids the ceiling; dispatcher raises | absence + DB + code |
| G4 | Automation approves nothing | `record_approval`/`link_duplicate` declare `authz.actor='human'`; a service actor is refused | code + registry |
| G5 | Tool allowlist | `agent_session_types.allowed_tools` | data |
| G6 | Effect ceiling | `max_effect_class` check + dispatcher | DB + code |
| G7 | Step budget | in-code counter + `enforce_agent_budget` BEFORE INSERT trigger | code + DB |
| G8 | Model-call / token / cost budget | `budget.mjs` + `agent_sessions` counters; exceeded ⇒ `agent.budget_exhausted` | code |
| G9 | Wall-clock timeout | `deadline_at` in `ToolContext`; lease expiry as backstop | code + DB |
| G10 | Untrusted content is data | delimited, `trusted:false`, preserved through compaction; instructions inside it never become actions | code |
| G11 | Groundedness | generalization of `hallucinationCheck()` — extracted field values absent from the source text block the write | code |
| G12 | Fail-closed | unparseable output / unknown classification / failed verify ⇒ human queue, never a guess | code |
| G13 | Verify-before-success | `completed` unreachable with an unverified non-read tool call | DB trigger |
| G14 | Idempotent side effects | unique index on `(org, tool, idempotency_key)` | DB |
| G15 | No hard deletes / immutable ledger | `guard_no_delete` + immutability triggers | DB |
| G16 | Kill switch | `agent_harness_settings.enabled` (ADR-0007; default false) + `agent_session_types.enabled` + `agent_tools.enabled`; checked at session start and at every dispatch | data + code |
| G17 | Secrets never in context | redaction filter on every context item and every log line; adapters read credentials from env only | code |
| G18 | Registry drift | code↔`agent_tools` parity validator in `regression.sh` | test |

Guard chain order (cheapest and most absolute first): kill switch → tenant →
allowlist → effect ceiling → authz actor → budget → idempotency → groundedness.

---

## 12. Model abstraction

- **Interface**: `ModelAdapter` (§3). Domain code depends on the interface only —
  the existing `classification.mjs` already proves this pattern; the harness
  generalizes it.
- **Adapters**: `anthropic` (extends today's raw-fetch adapter — no SDK
  dependency), `replay` (recorded outputs, deterministic, used by all
  regression-time runners), `deny` (throws on any invocation; used to prove
  offline suites never touch the network).
- **Router**: session type declares a tier (`fast|standard|deep`); the router maps
  tier → `(provider, model)` from one config table, with an ordered fallback chain
  for provider outages. Model ids are never hard-coded in domain modules.
- **Prompt registry**: prompts live in `model/prompts.mjs`, each with a version id
  (`b2-classify-v1` today). `agent_sessions.prompt_version` and
  `agent_model_calls.prompt_version` record the exact version; evals key on it, so
  a prompt change is a measurable event, not a silent regression.
- **Cost meter**: per-model USD/token table (already sketched in
  `model-adapters.mjs`); every call writes `cost_cents`; `agent_session_costs`
  aggregates. Cost is a budget dimension (G8), not merely a report.
- **Structured output**: v1 keeps the current JSON-in-text contract with strict
  parse + schema validation. Native provider tool-calling is a v2 adapter
  capability flag (see O3) — deferred until a session needs multiple tool calls
  per model turn.

---

## 13. Retry system

**Error taxonomy** (`failure/taxonomy.mjs`):

| Class | Examples | Retryable | Policy |
|---|---|---|---|
| `transient_provider` | 429, 5xx, timeout, connection reset | yes | ≤3 attempts, exp backoff 1s/2s/4s + jitter, cap 30s |
| `transient_infra` | Supabase 429/5xx (already handled in `lib/db.mjs`) | yes | ≤5, exp backoff cap 30s |
| `invalid_output` | parse failure, schema violation | yes, **once** | one repair attempt (error text appended as untrusted diagnostic), then fail-closed |
| `tool_error_retryable` | lost race, lease conflict | yes | ≤2 |
| `tool_error_terminal` | constraint violation, authz denial | no | terminal `failed` |
| `guard_block` | any guard refusal | **never** | terminal `blocked` → human queue |
| `budget_exhausted` | any budget dimension | never | terminal `failed` + event |
| `verify_failed` | Verify Step false | no | step `terminal_error`; session cannot complete |

Rules:
1. Retries are **steps**. Every attempt gets an `agent_steps` row — the ledger
   shows what actually happened, not a summarized final state.
2. Retries consume budget. There is no free retry.
3. Side-effecting retries reuse the same idempotency key, so a retry after an
   ambiguous failure resolves to `deduped`, never a double write.
4. **Success is decided by the Verify Step, never by the absence of an
   exception.** A tool that throws after a successful commit is caught by verify;
   a tool that returns cleanly without a verifiable effect is a failure.
5. Guard blocks are never retried — retrying a refusal is how systems talk
   themselves into unsafe actions.

Cross-consumer note: the existing `integration_events.attempt_count` /
`processing_status` substrate stays the retry record for **event consumers**
(n8n, B12). The harness's retry state is the step ledger. Two different queues,
two different owners, no shared counter.

---

## 14. Logging & observability

Three planes, deliberately separate:

1. **Durable audit (DB, immutable):** `agent_steps`, `agent_tool_calls`,
   `agent_model_calls`, `agent_context_snapshots`. Sufficient to reconstruct any
   session without any log file.
2. **Domain events (`integration_events`):** the six `agent.*` types for external
   consumers. Business events remain owned by domain triggers.
3. **Developer trace (ephemeral):** structured JSONL to
   `.harness-logs/<session_id>.jsonl` (gitignored) plus stdout for the CLI.
   Correlation keys `trace_id` / `session_id` / `step_seq` on every line.

**Redaction (code-enforced, G17):** deny-list on API keys, JWTs, management
tokens, service-role keys, `Authorization` headers; email bodies and customer PII
stored as digests unless `is_fixture=true`; prompts/responses persisted only for
fixture sessions. A redaction unit test asserts a synthetic secret never survives
into any of the three planes.

**Metrics from views:** sessions/day by terminal state, verify-fail rate, block
rate by reason, retry rate by error class, dedupe rate, tokens and cost per
session type, p50/p95 step latency. Alert-worthy defaults (thresholds set at
build time): verify-fail > 0, block rate spike, cost per session type over
budget, any `expired` session.

---

## 15. Future extensibility

Designed-for (schema/interface hooks exist; no code ships now):

| Extension | Hook already in this design |
|---|---|
| Sub-agents / delegation | `agent_sessions.parent_session_id` |
| Native provider tool-calling | `ModelAdapter` capability flag + `agent_tool_calls` shape |
| Additional providers/models | `ModelRouter` tier table + fallback chain |
| Real external send (post-Entra, B10) | `external` effect class exists but is refused; enabling it = one descriptor + one check change + a new approval gate, all reviewable in one diff |
| n8n consumers (B12) | `agent.*` events on the existing `integration_events` contract |
| Human-in-the-loop UI | `agent_blocked_sessions` view + `/api/agent/sessions/:id/trace` |
| Scheduled / triggered sessions | `createSession` is trigger-agnostic; a cron or webhook is a caller, not a new subsystem |
| Cross-session memory | deliberately absent; `agent_context_snapshots` is per-session and would be the extension point |
| Multi-tenant beyond one org | already org-scoped everywhere; no per-org code |

Explicitly **not** designed for: user-authored workflow graphs, a prompt-template
DSL, agent-authored tools, autonomous scheduling of its own work.

---

## 16. Task breakdown

Smallest independently implementable units, in the repo's backlog template
(goal / why / files / deps / acceptance / testing / done / handoff). One short
session each; each ends with `bash scripts/regression.sh` ALL GREEN. Sequence
respects the operating rule that no task may leave the suite red.

**Sequencing note:** H2/H3 create migrations but **do not apply them**; live apply
is an explicit approval checkpoint, exactly like S1/0016. Everything from H4
onward that needs tables is written and tested offline first, then verified live
after the apply checkpoint.

---

### H0 — Doctrine decision + design interrogation — *planning, no code*
- **Goal**: DECISION_LOG entry recording that the "second consumer" trigger is met (§0 evidence table), the harness scope, and the non-goals; resolve O1–O5 (§17); add `agent session`, `step`, `tool descriptor`, `effect class`, `snapshot` to UBIQUITOUS_LANGUAGE.
- **Why**: building against a locked doctrine without superseding it is exactly the drift the operating model exists to prevent.
- **Files**: `docs/planning/DECISION_LOG.md`, `docs/architecture/UBIQUITOUS_LANGUAGE.md`, `docs/planning/TASK_BACKLOG.md` (H1–H17 entries), `docs/planning/SESSION_HANDOFF.md`.
- **Deps**: none. **Blocks everything else.**
- **Acceptance**: decision recorded; O1–O5 answered; no code changed.
- **Handoff**: the answers to O1–O5, since H1–H3 depend on them.

### H1 — `packages/harness` skeleton + pure core
- **Goal**: workspace package; `descriptor.mjs` (shape + validator), `tokens.mjs` (deterministic estimator), digest util, `taxonomy.mjs`, layering-lint script asserting pure modules import no I/O.
- **Why**: everything else imports these; pure and offline means fully unit-testable with zero infrastructure.
- **Files**: `packages/harness/**`, `scripts/eval-harness-unit.sh` (+ `.mjs`), `scripts/regression.sh`, root `package.json` workspaces.
- **Deps**: H0.
- **Acceptance**: unit runner green; layering lint fails on a deliberately added `fetch` import; regression ALL GREEN.
- **Testing**: `bash scripts/eval-harness-unit.sh`; `bash scripts/regression.sh`.

### H2 — Migration 0017 (core tables) — *written + dry-run, NOT applied*
- **Goal**: `agent_session_types`, `agent_sessions`, `agent_steps` + RLS (zero client policies) + `guard_no_delete` + immutability + transition matrix + `enforce_agent_budget` + `emit_agent_session_events`; offline `scripts/lib/validate-migration-0017.mjs`; `scripts/acceptance-slice6.sh` (state-aware PENDING/APPLIED, same pattern as `acceptance-s1-security.sh`).
- **Why**: durable session state is the one thing the harness cannot fake in memory.
- **Deps**: H0, H1.
- **Acceptance**: offline validator PASS; `begin; … rollback;` dry-run returns `[]`; slice 6 green in PENDING state; regression ALL GREEN; **nothing applied**.
- **Handoff**: migration number, exact dry-run output, apply checkpoint stated.

### H3 — Migration 0018 (registry + ledgers) — *written + dry-run, NOT applied*
- **Goal**: `agent_tools`, `agent_tool_calls` (+ partial unique idempotency index), `agent_model_calls`, `agent_context_snapshots`, the three views; offline validator; slice 6 extended.
- **Why**: split from H2 so each migration is small enough to review line by line.
- **Deps**: H2.
- **Acceptance**: same as H2; the unique idempotency index proven by a dry-run double insert raising 23505.

### H4 — Tool registry + code↔DB parity validator
- **Goal**: descriptors for the seed tools (§8) as pure data + `registry.mjs` loader + `scripts/lib/validate-agent-registry.mjs` (name/version/effect_class/schema/`code_digest` parity, offline against the seed SQL).
- **Why**: the registry is an authority surface; undetected drift between code and DB is the S1 failure mode.
- **Deps**: H1, H3.
- **Acceptance**: parity validator PASS; perturbing one descriptor makes it FAIL (non-vacuity, the repo's standing evidence rule); in regression.

### H5 — Verify Step library
- **Goal**: `verify.mjs` with the three kinds; per-tool verify functions generalized from `lib/db.mjs verify()`; contract `{ok, checks, observed}`.
- **Why**: G13 is the harness's central claim; it needs one implementation, not per-slice copies.
- **Deps**: H4.
- **Acceptance**: existing B2 verify behavior reproduced exactly against a fixture work_request; a deliberately un-emitted event makes verify fail.

### H6 — Dispatcher (read + write_internal only)
- **Goal**: `invokeTool()` — validate → authz → guard chain → idempotency → execute → verify → ledger → result union. `external` raises unconditionally. `human_visible` deferred to H14's gate work.
- **Why**: the single side-effect edge; everything downstream assumes it exists.
- **Deps**: H4, H5.
- **Acceptance**: dedupe returns `deduped` without a second write; guard block is never retried; an `external` descriptor (added only in the test) raises; unverified write cannot report `succeeded`.

### H7 — Model abstraction + router
- **Goal**: `ModelAdapter` interface + conformance test; `anthropic`/`replay`/`deny` adapters; tier router + cost table + prompt registry. Refactor `scripts/lib/model-adapters.mjs` to conform **with zero behavior change**.
- **Why**: provider-agnostic is already doctrine; this makes it enforceable and metered.
- **Deps**: H1.
- **Acceptance**: Runner 2A output byte-identical before and after; `deny` adapter proves the offline suites make no network call; conformance test rejects a non-conforming adapter.

### H8 — Retry controller
- **Goal**: `retry.mjs` — classification, attempt caps, exp backoff + jitter, one repair attempt for `invalid_output`, budget-charged retries, guard blocks never retried. Wired into H6 and H7.
- **Why**: retry policy currently lives in three places with three different caps.
- **Deps**: H6, H7.
- **Acceptance**: injected-failure unit tests for every taxonomy class; retries visible as separate `agent_steps` rows; a side-effect retry resolves to `deduped`.

### H9 — Context assembler
- **Goal**: `primitives.mjs` + `assemble()`; pinning, untrusted delimitation, token estimate, redaction. Port `buildPacket()` behind it.
- **Why**: the packet is the model's entire world; it deserves one typed, tested builder.
- **Deps**: H1.
- **Acceptance**: assembled packet for each fixture is byte-identical to today's `buildPacket()` output; pinned-overflow fails closed; an untrusted item can never be emitted outside its delimiters.

### H10 — Compaction ladder
- **Goal**: `compact()` L1–L3 + snapshot persistence + thresholds; model summarization present but **disabled by default**.
- **Why**: sessions longer than one model call are otherwise unbounded in context.
- **Deps**: H9, H3.
- **Acceptance**: pure and deterministic (same input ⇒ same plan); L3 checkpoint round-trips a session's meaning with pinned content intact; untrusted material stays untrusted through every level; snapshot regenerable from the ledger.

### H11 — Session manager + bounded loop
- **Goal**: create/claim/lease/advance/run/resume/close + budget accounting + terminal-state handling + `expire_agent_leases()` usage.
- **Why**: this is the subsystem's spine; everything before it is a component.
- **Deps**: H2, H6, H8, H10.
- **Acceptance**: two concurrent claimants — exactly one advances; kill mid-session then `resume()` reaches the same terminal state; budget exhaustion terminates with the event; `completed` refused while any non-read tool call is unverified.

### H12 — First session type `triage_email` + CLI + parity gate
- **Goal**: `scripts/agent.mjs`; session type seeded (fixture-only, `max_effect_class='write_internal'`); the triage session calls the existing classification domain service **through** the harness.
- **Why**: proves the harness on a real slice without changing a single business rule.
- **Deps**: H11, H4, H7.
- **Acceptance**: **hard parity gate** — for all 12 fixtures with the replay adapter, harness output matches Runner 2A field-for-field (classification, status, urgency, extracted fields, duplicate link, verify result). Any divergence is a harness bug, never a label change.

### H13 — Runner 6 (harness eval) + regression wiring
- **Goal**: `scripts/eval-harness.sh` (+ `.mjs`) = **Runner 6A** — deterministic, replay adapter, real DB persistence + Verify Steps, gates: parity 12/12, verify-pass 100%, zero unintended writes, resume-equivalence, dedupe correctness, determinism across two runs. **Runner 6B** = `eval-harness-live.sh`, key-gated, **not** in regression. (Runner numbering per ADR-0008 — Runners 1–5 are already allocated.)
- **Why**: EVAL_STRATEGY's 2A/2B split, applied to the harness.
- **Deps**: H12.
- **Acceptance**: Runner 6A green and in `regression.sh`; perturbation (e.g. disabling a guard) makes it fail — non-vacuity proven.

### H14 — Human gate + `human_visible` dispatch
- **Goal**: enable `human_visible` tools through the dispatcher: `create_outbound_draft` via the existing 0015 RPC, `awaiting_human` terminal state, `agent.human_input_required`, and refusal of any service actor for `record_approval` / `mark_message_sent` / `link_duplicate`.
- **Why**: G4 — automation approves nothing — must hold at the dispatcher, not only at the RPC.
- **Deps**: H12, H6.
- **Acceptance**: a session can create a draft and reach `awaiting_human`; a service actor attempting `record_approval` is blocked with `unauthorized_external_action`; slice 4/5 stay green; zero rows reach `sent`.

### H15 — Web API `/api/agent/*`
- **Goal**: the eight routes (§6.2), admin-only, RFC 7807 errors, redacted trace; refuses non-fixture sessions while the kill switch or type is disabled.
- **Why**: gives operators a surface without a UI build.
- **Deps**: H11.
- **Acceptance**: web build passes with the new routes; unauthenticated and non-admin requests rejected; `POST /run` on a disabled type returns problem+json, writes nothing.

### H16 — MCP wrappers + observability + kill switch
- **Goal**: `get_agent_session`, `get_agent_session_trace`, `list_blocked_sessions`, `run_fixture_triage_session` (fixture-only); the three views; JSONL trace + redaction test; `org_settings.harness_enabled` honored at session start **and** each dispatch.
- **Why**: ops needs a stop button and a way to see what ran, before anything runs unattended.
- **Deps**: H14, H3.
- **Acceptance**: MCP tool count check updated and green; flipping the kill switch mid-session stops the next dispatch and terminates cleanly; redaction test proves a synthetic secret appears in none of the three planes.

### H17 — Docs, mapping update, handoff
- **Goal**: rewrite `AGENT_HARNESS.md` §1–5 to point at the built subsystem (built/partial/task tags refreshed); add `docs/architecture/AGENT_HARNESS_RUNBOOK.md` (create/inspect/cancel/resume/kill); update `EVAL_STRATEGY.md` with Runner 4; `TASK_BACKLOG` + `SESSION_HANDOFF` records; add the harness fixture-reaper design note to the AR backlog.
- **Why**: the AR backlog already shows undocumented conventions drifting within weeks.
- **Deps**: H16.
- **Acceptance**: no doc claims a capability the code lacks; every runbook command executed once and its real output pasted.

**Parallelizable** (no shared files): {H2, H3} ∥ {H7} ∥ {H9}. Everything else is
sequential on the chain above.

**Apply checkpoints (explicit approval, never inside another task):**
AC-1 apply 0017 (after H2 review) · AC-2 apply 0018 (after H3 review). Both use
the reviewed management-API path from CONTEXT.md; both are re-verified against
live state immediately before running, per the S1 protocol.

---

## 17. Open questions (must be closed in H0)

- **O1 — DB access path for the harness.** `scripts/lib/db.mjs` uses the Supabase
  **management** query API with a hard-coded project ref and org id, and already
  needs 429 backoff. The MCP server uses a **service-role** `supabase-js` client.
  *Recommendation:* harness uses the service-role client (correct auth surface,
  no mgmt rate limit, no hard-coded ref); the mgmt path stays for migrations and
  acceptance scripts only. Consequence: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  become harness runtime requirements, and the hard-coded ids in `db.mjs` become an
  AR cleanup item.
- **O2 — Where the loop runs.** *Recommendation:* library-first — CLI invokes it
  now, the web route invokes it later, n8n invokes it after B12. No daemon, no
  queue worker in v1 (the lease design already permits one later).
- **O3 — Native tool-calling vs JSON-in-text.** *Recommendation:* keep the strict
  JSON contract until a session genuinely needs multiple tool calls per model
  turn; revisit as an adapter capability flag.
- **O4 — Harness fixture reaper.** Slices 4/5 already accumulate fixture rows (AR
  backlog); harness sessions will add step/call rows per run. Decide whether
  fixture sessions are pruned (respecting `guard_no_delete` — likely a
  `void`/archive status, not a delete) or allowed to accumulate.
- **O5 — Human-gate UI ownership.** Does `awaiting_human` surface in the B5
  approval queue, or in a separate harness queue page? *Recommendation:* reuse the
  B5 queue; a second queue splits the operator's attention.

---

## 18. Risks

| Risk | Mitigation |
|---|---|
| Harness becomes the generic engine the doctrine forbade | Non-goals (§0) are testable: no workflow tables, no DSL, session types are config rows with a bound tool set, `external` structurally refused. H17 re-checks each. |
| Abstraction regresses B2/B3 behavior | H7/H9/H12 are all parity-gated against Runner 2A byte-for-byte; parity failure blocks the task. |
| New service-role tables reintroduce S1-style policy drift | G2 + a `pg_policies` count pin in slice 6, present from H2 onward. |
| Session state and DB state diverge after a crash | Durable-state-only + resume-equivalence gate in Runner 4. |
| Cost blowup once live inference runs | Cost is a hard budget dimension (G8), metered per call, with per-type ceilings and a `agent_session_costs` view. |
| Scope creep into sends | `external` has no descriptor, no allowed ceiling, and no code path; enabling it is a visible one-diff change requiring its own approval. |
