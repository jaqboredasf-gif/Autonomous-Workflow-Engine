# Ubiquitous Language — AWE domain vocabulary

Authority for terminology in planning and implementation. Do not introduce a
synonym when a term below exists. Format per term: meaning / what it is NOT /
database entity / key invariant.

- **AWE (Autonomous Workflow Engine)** — Workstream B: the work-request →
  invoice pipeline built on the shared Supabase DB. NOT a generic
  workflow-engine product; there are no `workflow_definitions`-style tables —
  behavior is map-driven (WORKFLOW_MAPS.md) over concrete domain tables.
  Entity: the Workstream B table set. Invariant: automation has zero approval
  authority; zero v1 auto-sends.

- **Organization** — the tenant boundary (Lippolis Electric). NOT
  "organizations" — that orphan table was dropped (0012); the entity is `orgs`.
  Invariant: every business table carries `org_id` + RLS via
  `current_org_id()`.

- **Person / User** — a human with a login, member of one org. NOT the dropped
  `people` table; NOT a customer. Entity: `users` (FK to `auth.users`).
  Invariant: `users.role` (worker/foreman/admin) drives RLS until the Phase 5
  `user_roles` migration.

- **Worker (field employee)** — a `users` row with role `worker`; punches
  in/out, files completion reports. NOT office staff. Invariant: sees only own
  punches/schedule; nothing customer-facing.

- **Role** — a named capability set (Phase 2 defines 10; DB holds 3 today).
  NOT a person: several roles may be one human. Entity: `users.role` now,
  `user_roles` join table in Phase 5. Invariant: permissions are designed
  per-role, never per-person.

- **Responsibility (approver role)** — which role may approve/send a given
  message type. Entity: `message_policies.approver_role` (B3, built 2026-07-26).
  Invariant: customer-facing sends require an approval row from an authorized
  role; an unconfigured responsibility blocks the message
  (`missing_approver_role`) and never falls back to a default approver.

- **Message policy (approval-matrix row)** — one stored row per (org, message
  type) carrying mode, approver role, backup approver, escalation role, approval
  limit, confidence threshold. NOT code: graduating a type draft→auto is a data
  change. Entity: `message_policies`. Invariant: every v1 row is `mode='draft'`;
  `final_invoice` can never hold `auto`; `auto` requires both a named approver
  and a configured limit.

- **Outbound message** — one drafted customer- or crew-facing message and the
  human decision recorded on it. NOT an email that was sent, and NOT an
  `email_messages` row (that table is the audit-grade record of real mail).
  Entity: `outbound_messages`. Invariant: `sent` is unreachable without a
  recorded approval; content is frozen once it leaves `draft`.

- **Approval limit** — the highest amount the primary approver role may approve
  for a message type; above it the message routes to the escalation role.
  Entity: `message_policies.approval_limit_cents` (NULL = unconfigured).
  Invariant: an amount-bearing message with no configured limit fails closed
  (`missing_approval_limit`) — a ceiling is never guessed.

- **Backup approver** — the role that takes a responsibility when the primary is
  unavailable. NOT an escalation (that is amount-driven). Entity:
  `message_policies.backup_approver_role`. Invariant: no usable backup blocks the
  message (`no_backup_approver`); approval is re-routed, never skipped.

- **Blocked state** — a message the matrix could not route safely, written with a
  `blocked_reason` so a human sees it in the queue. NOT a rejection (that is a
  human decision) and NOT a silent drop. Entity:
  `outbound_messages.status='blocked'` + `message.blocked`. Invariant: gate-level
  refusals (unauthorized action, duplicate, build failure, forbidden content,
  TEST-mode violation) refuse before any write; routing-level refusals persist a
  blocked row.

- **Manual send (mark-sent)** — a human copied an approved draft into Outlook,
  sent it, and recorded that fact. NOT a transmission by the system: no send
  machinery exists. Entity: `outbound_messages.sent_at` / `sent_marked_by` via
  `mark_message_sent()`. Invariant: only an `approved` message can be marked sent.

- **Work request** — one distinct customer ask, however many emails carry it.
  NOT an email, NOT a job. Entity: `work_requests` (originating
  `email_message_id` mandatory). Invariant: classification `emergency` forces
  `status=escalated` + `urgency=emergency`.

- **Job** — approved, schedulable work derived from a work request (B8, not
  yet built). NOT a work request (pre-approval) and NOT a shift. Entity:
  `jobs` (planned). Invariant: invoicing waits for FINAL completion.

- **Shift** — a scheduled block of worker time, optionally tied to a work
  request. Entity: `shifts` (`work_request_id` nullable). Invariant: cannot
  reference an `escalated` work request — emergencies are never auto-scheduled.

- **Assignment** — the pairing of worker(s) to a shift/job (crew assignment,
  Map 12). Entity: `shifts.user_id` / `crews`. Invariant: modifiable until job
  completion, always audited.

- **Email message** — the audit-grade record of one email exactly as it
  arrived or was sent. NOT the work request it produces. Entity:
  `email_messages`. Invariant: content is immutable after insert; only
  permitted update is the set-once attach to a work request.

- **Classification** — the assigned type of an inbound request: emergency /
  service_call / estimate_job / out_of_territory / not_a_work_request /
  unknown. NOT a status. Entity: `work_requests.classification` (+confidence,
  reasoning). Invariant: AI is never the only line of defense — the keyword
  net (`is_emergency_text`) runs on every inbound before any short-circuit.

- **Urgency** — how fast a request needs action: emergency / urgent /
  standard. NOT classification (a routine ask can be urgent). Entity:
  `work_requests.urgency`.

- **Emergency** — an immediate electrical hazard (burning smell, smoke,
  sparking, live wiring, shock, safety-equipment power loss, flooding near
  electrical). Invariant: halts auto-scheduling, requires human response,
  never receives troubleshooting advice.

- **Escalation** — routing a request to a human with notification, outside
  normal queue flow. NOT a decline. Entity: `work_requests.status='escalated'`
  + `request.emergency_escalated` event; contacts/config = B4. Invariant:
  every emergency escalates; a human must respond.

- **Territory** — where the company will take work. Entity: rules in
  `service_areas`, verdicts in `work_requests.territory_result`. Invariant:
  unknown location → `in_territory: null`, never treated as out-of-territory.

- **Service area** — one territory rule row (county or zip we CAN work in).
  Currently SAMPLE data. Entity: `service_areas`. Invariant: real rules
  required (B5) before the auto-decline flag may ever turn on.

- **Approval** — a recorded human authorization for a specific action
  (message send, estimate, correction). NOT an automated status change.
  Entities: `outbound_messages.approved_by` (B3),
  `timecard_corrections.approved_by`. Invariant: automation never approves;
  every approval writes who/what/when.

- **Workflow** — one mapped business process (Maps 1–21 in WORKFLOW_MAPS.md).
  NOT a DB object and NOT an n8n artifact.

- **Workflow definition** — the 12-field written map of a workflow in
  WORKFLOW_MAPS.md. NOT a `workflow_definitions` table (dropped orphan, 0012).
  Invariant: implementation follows the map; deviations go back through
  planning.

- **Workflow run** — the progression of one entity (work request, job,
  invoice) through its mapped statuses, reconstructable from
  `integration_events`. NOT a `workflow_runs` table (dropped orphan).

- **Event** — an immutable fact record emitted at a boundary via
  `emit_event()`. NOT a notification (n8n consumers deliver those). Entity:
  `integration_events`. Invariant: exactly-once per boundary; consumers
  idempotent.

- **Fixture** — synthetic test data exercising the real pipeline. NOT mock
  code. Entities: `fixtures/emails/*.json`, rows with `is_fixture=true`.
  Invariant: only fixture rows may lack `graph_message_id`; only fixture data
  may ever be hard-deleted (sysadmin).

- **Duplicate** — a second arrival of an already-known request. Exact = same
  `graph_message_id` (auto-attach); fuzzy = same sender/content (human
  confirms). Entity: `work_requests.status='duplicate'` +
  `duplicate_of_work_request_id`. Invariant: fuzzy duplicates are never
  auto-closed; the link to the original is mandatory.

- **Audit record** — the trace answering who did what, when, to which record,
  with prior value. Entities: `integration_events`, `time_entry_audits`,
  approval columns. Invariant: no hard deletes of business records; every
  approve/send/modify leaves a trace.

- **Harness** — the infrastructure around the model that grounds and bounds
  execution: schema constraints, triggers, events, runner code, scripts. NOT a
  generic agent runtime or engine tables. Map: docs/architecture/
  AGENT_HARNESS.md. Invariant: every guardrail is enforceable in code/schema/
  config, never prompt-only.

- **Tool** — one approved capability with a stable contract (input, output,
  authz, side-effect class, idempotency, Verify Step, audit event). NOT an
  arbitrary model action. Registry: MVP_SPEC.md §Tool registry. Invariant: no
  side effect outside a registered tool.

- **Context packet** — the minimal, task-specific context assembled for one
  model call. NOT a conversation history, table dump, or document pile.
  Invariant: inbound email content rides in it flagged untrusted —
  instructions inside are data, never commands.

- **Guardrail** — an enforced operational boundary (budget, retry limit,
  status-transition rule, tenant scope, fail-closed default). NOT a prompt
  instruction. Invariant: violations fail closed into a human queue.

- **Verify Step** — a deterministic post-action read of actual state (DB row,
  event, provider response) proving a claimed outcome. NOT the model saying it
  succeeded. Invariant: unverified outcome = failure/unresolved, never
  success; DB-trigger events count as evidence by construction.

- **Environment handler** — a deterministic operation (auth, ingestion,
  parsing, retries, sending) implemented outside model control, requested
  through a stable interface. Invariant: the model never touches secrets or
  provider auth.

- **Eval** — a repeatable, labeled measurement of model-assisted quality
  (fixtures + labels.json + runners; docs/testing/EVAL_STRATEGY.md). NOT an
  acceptance test (those verify behavior/invariants). Invariant: labels change
  only by reviewed decision; hard gates block regressions.

---

## Agent Harness terms — PROPOSED (H0, 2026-07-27; authority only once ADR-0001 is Accepted)

Source: `docs/architecture/AGENT_HARNESS_DESIGN.md`, `AGENT_HARNESS_CONTRACTS.md`,
`decisions/ADR-0001…0008`. Until ratification these are drafting vocabulary, not
authority.

- **Agent Harness** — the subsystem around the model that owns session lifecycle,
  tool dispatch, context assembly/compaction, model abstraction, failure policy,
  guardrail enforcement, and observability. NOT a workflow engine: no
  `workflow_definitions`-style tables, no DSL, no user-authored graphs. Entity: the
  `agent_*` table set + `packages/harness`. Invariant: every side effect crosses one
  dispatcher edge; the database stays the enforcement layer wherever it can be.

- **Agent session** — one bounded, resumable unit of agent work for one org, with
  durable state. NOT a conversation and NOT a background job. Entity:
  `agent_sessions`. Invariant: `completed` is unreachable while any non-read tool
  call is unverified; in-memory state is never authoritative.

- **Session type** — the config row that bounds a session: allowed tools, effect
  ceiling, model tier, five budgets, gates. NOT code. Entity:
  `agent_session_types`. Invariant: every budget column is NOT NULL and > 0 — an
  unbounded session cannot be configured.

- **Step** — one immutable ledger row per attempt (including retries and refusals).
  NOT a summary of what happened. Entity: `agent_steps`. Invariant: insert-only; a
  retry is a new step, never an overwrite.

- **Tool descriptor** — the code-authored contract for one callable tool: identity,
  schemas, tenancy, authz actor, effect class, timeout, retry eligibility,
  idempotency, verify kind, audit and redaction. Entity: code + mirrored
  `agent_tools` row. Invariant: unregistered ⇒ refused, not "unimplemented";
  code↔row drift fails regression.

- **Effect class** — the side-effect ladder `read` < `write_internal` <
  `human_visible` < `external`. Entity: `agent_tools.effect_class`,
  `agent_session_types.max_effect_class`. Invariant: `external` has no descriptor,
  no permitted ceiling and no code path in v1; the ceiling is enforced in code and
  in the schema.

- **Context item / packet** — a typed, trust-labeled, provenance-carrying unit of
  context, assembled into one packet per model call. Invariant: untrusted content
  stays untrusted through every compaction level; instructions inside it are data.

- **Compaction snapshot** — the durable record of a compaction (level, coverage,
  summary, pinned set, digest). Entity: `agent_context_snapshots`. Invariant: a
  derived summary is never evidence for a Verify Step; pinned guardrails are never
  compacted.

- **Blocked reason** (harness) — the structured refusal vocabulary of the
  dispatcher, extending B3's existing routing/gate reasons rather than re-spelling
  them. Invariant: a refusal is never retried automatically.

## Context and execution-surface terms (2026-07-27, IMPLEMENTED)

Unlike the harness terms above, these name things that exist in code today
(`packages/awe-kernel`, `packages/awe-runtime`, `packages/mcp-server`) and are
covered by Runner C and Runner M.

- **Context item** — one unit of context carrying the facts a later consumer
  cannot re-derive: stable id, kind, source, tenant binding, declared trust,
  sensitivity, priority, timestamp, content or artifact reference, estimated
  token cost, provenance and a content fingerprint. Entity:
  `packages/awe-kernel/src/context-item.mjs`. Invariant: trust defaults to
  `false` and sensitivity to `internal` — a source that does not say is treated
  as the riskier case.

- **Execution context bundle** — the deterministic, serializable record of what
  ONE run was given: run metadata, ordered items, budget, exclusions,
  provenance, compaction state, self-digest. Schema `awe.context_bundle/v1`.
  Invariant: every item that was offered either appears in `items` or appears in
  `exclusions` with a reason. There is no third outcome and no silent
  truncation.

- **Exclusion reason** — the closed vocabulary explaining why an item is not in
  a bundle: `tenant_mismatch`, `duplicate_id`, `duplicate_content`,
  `sensitivity_ceiling`, `budget_tokens`, `budget_items`, `provider_error`,
  `item_invalid`. Invariant: an operator can always distinguish "we chose not
  to" from "it did not fit" from "something upstream broke".

- **Compaction ledger** — the per-item record of what compaction did:
  `retained`, `dropped_duplicate`, `dropped_expired`, `dropped_priority`,
  `dropped_budget`, `summarized`, `substituted_artifact`, `created_summary`.
  Invariant: a summary inherits the MAXIMUM sensitivity and the MINIMUM trust of
  its inputs, so compaction can never launder untrusted or restricted material
  into a less restricted class — enforced by the kernel regardless of whether a
  model wrote the summary text.

- **Context checkpoint** — the resumable form of a compacted bundle, bound to a
  tenant and a workflow. Schema `awe.context_checkpoint/v1`. Invariant:
  restoring into a different tenant or a different workflow is refused, which is
  what makes resumable unattended work safe in a multi-tenant system.

- **Tool descriptor** (implemented, neutral) — transport-independent tool
  identity: name, version, workflow id, schema REFERENCES, side-effect
  classification, `requires_tenant`, lifecycle, self-digest. Entity:
  `packages/awe-kernel/src/tools.mjs`. Invariant: it classifies and declares; it
  never authorizes. `side_effect` describes what a tool does to the world and
  `requires_tenant` says a run must NAME a tenant — neither says who may invoke
  it. That remains ADR-0002 and is asserted absent by Runner M.

- **Data port** — the org-scoped data-access boundary an execution surface is
  handed. Entity: `packages/mcp-server/src/data-port.mjs`. Invariant: every
  method takes `org_id` and REFUSES without it. Not "defaults to", not "falls
  back to". A tenant is never inferred, discovered, or remembered from a
  previous call.

- **Platform service** — the composition layer between the pure kernel and any
  surface: submit run, inspect outcome, retrieve report and audit trail,
  assemble and compact context, checkpoint and resume. Entity:
  `packages/awe-runtime/src/service.mjs`. Invariant: it executes what it is
  asked to execute and decides nothing about whether the caller may.

## Durable execution terms (2026-07-28, IMPLEMENTED — ADR-0010)

These name things that exist in code today (`supabase/migrations/0017`,
`packages/awe-runtime/src/postgres/`) and are covered by Runner D. The migration
is written and validated but **not applied**; the vocabulary is not conditional
on that, because the adapter and the port are in use either way.

- **Durable execution repository** — the storage substrate a run depends on to
  survive its own process: the journal (control), the leases (who may write) and
  the results (data), each behind one port with three implementations. Entity:
  `packages/awe-runtime/src/{journal,lease,result}-store.mjs` plus
  `packages/awe-runtime/src/postgres/`. Invariant: it stores and serializes; it
  decides nothing. Every rule it appears to enforce is a pure function in
  `packages/awe-control-plane/`.

- **Store backend** — which of `memory`, `local_file` or `postgres` a surface is
  running on, chosen in exactly one place. Entity:
  `packages/awe-runtime/src/store-selection.mjs`. Invariant: the default is
  `memory`, which claims no durability, and asking for `postgres` without an
  executor is a THROW and never a downgrade. A silent fallback would leave a
  worker with no cross-process exclusion while believing it had some.

- **Executor** — the transport a durable store is handed: one method,
  `call(fn, payload)`. Entity: `packages/awe-runtime/src/postgres/executor.mjs`.
  Invariant: no SQL, table name, column or connection string crosses this
  boundary, which is what keeps `@exattime/awe-runtime` free of a database
  driver and of any credential.

- **Store unavailability** — the store could not answer: timeout, dead socket,
  permission denied. Entity: `StoreUnavailableError`. Invariant: it is NOT a
  `KernelError` and must never be reported as one. A domain refusal means "the
  answer is no"; unavailability means "there is no answer", and a caller may
  retry only the second.

- **Journal write conflict** vs **journal append-only refusal** — two distinct
  reasons a durable write is refused. `journal_write_conflict`: this writer's
  view of the chain head is stale, so somebody else got there first.
  `journal_append_only`: this writer's document DROPS or REWRITES history the
  store already holds. Invariant: both are returned as DATA. A worker pulling
  from a queue meets the first constantly and it is not an error.

- **Fence** — the monotonic integer stamped on every lease acquisition that is
  not a renewal. Entity: `packages/awe-control-plane/src/lease.mjs`, enforced in
  the durable store by a trigger that refuses any update lowering it. Invariant:
  it never goes backwards, which is why an expired lease record is reported and
  never deleted — deleting restarts it at 1 and re-validates a zombie worker.

- **Store conformance** — one behavioural contract answered identically by every
  implementation. Entity: `scripts/lib/store-conformance.mjs`. Invariant: it is
  sequential and therefore **not** a concurrency proof; the concurrency evidence
  is separate, and lives in `scripts/eval-durable-store.mjs` where genuinely
  parallel database backends race and a held-open transaction is observed
  blocking another.

## Governed agent terms (2026-07-28, IMPLEMENTED — ADR-0011)

These name things that exist in code today (`packages/awe-agent`,
`packages/awe-runtime/src/agent-service.mjs`) and are covered by Runner G. Unlike
the H0 harness terms above, none of them is conditional on an unratified ADR and
none of them names a table.

- **Governed Agent Execution Plane** — the layer that lets a specialized agent
  do real business work while staying tenant-bound, capability-limited,
  policy-constrained, approval-aware, durable and replayable. NOT an agent
  framework: a framework runs what a model asks for, and this runs what a
  runtime the model cannot reach has authorized. Entity:
  `packages/awe-agent`. Invariant: an agent PROPOSES; the runtime AUTHORIZES and
  EXECUTES (ADR-0011). There is no code path by which a planner reaches a tool.

- **Agent definition** — the versioned, digest-pinned document stating one
  agent's complete bounded action space: identity, tenant scope, status,
  capabilities and denied capabilities, tools, policy set, approval profile,
  context requirements, memory profile, model preference, budget, output
  contract, evaluation profile and provenance. NOT a prompt and NOT a class.
  Entity: `agent-definition.mjs`. Invariant: new behaviour requires a NEW
  VERSION — there is no mutate path, and `active` requires a recorded approver
  and activator.

- **Agent status** — `draft` (never executable), `active`, `deprecated`
  (executable only when a caller pins the exact version AND opts in), `disabled`
  (never executable, and NOT overridable by any argument). Invariant: a kill
  switch an argument can turn off is not a kill switch.

- **Capability** — a versioned BUSINESS PERMISSION: which operations exist,
  which tools may serve them at which versions, the side-effect ceiling, the
  data-classification ceiling, risk, approval threshold, tenant scope, actor
  roles, idempotency and audit obligations. NOT a tool and NOT a role. Entity:
  `capability.mjs`. Invariant: **tool access never implies business
  authorization** — an agent may call a tool only when the definition declares
  the capability, the capability binds that tool for that operation, the tenant
  grant exists, the policy allows, and the approval (where obliged) is in force.

- **Agent Execution Surface** — the workflow manifest an agent definition
  COMPILES to, whose steps are the enumerated (capability, operation, tool)
  bindings it permits. NOT an execution order: nothing walks it, and the run
  engine is not used by the agent harness. Entity: `surface.mjs`. Invariant: it
  is the COARSE ceiling — every finer capability rule is applied on top of it, so
  compiling can only ever refuse more.

- **Action proposal** — what a planner returns: a requested capability,
  operation, tool, arguments and idempotency key, plus a SELF-REPORT (reason,
  evidence, risk, side effect, confidence, claimed approval requirement). NOT an
  instruction and NOT an authorization. Entity: `proposal.mjs`. Invariant: the
  self-report is recorded as what the planner believed and is never an input to a
  decision; an argument key beginning with `_` is refused by the grammar, because
  it would let a proposal rewrite the tenant a tool executes under.

- **Policy Decision Record** — the immutable, digest-pinned answer to "may this
  action happen?", naming tenant, actor, agent version, capability version, tool
  version, operation, data classification, decision, reason codes, evaluated
  policies and the approval binding. NOT a boolean. Entity:
  `authorization.mjs`, appended as `agent.policy_decided`. Invariant: a model
  never reaches its constructor, and a rewritten record does not match its own
  digest.

- **Approval binding** — the digest an approval attaches to: tenant, agent
  version, RESOLVED capability and tool versions, operation and arguments,
  exactly. NOT the proposal digest — rewording an explanation must not invalidate
  a decision, and changing an argument must. Invariant: a material change is
  `approval_binding_mismatch`, an approval expires, and a resume RE-AUTHORIZES
  from scratch rather than treating the approval as a token.

- **Planning view** — the closed, redacted document a planner is handed: the
  agent's identity, the capability surface as names and constraints, the
  context with its trust and sensitivity labels intact, this run's observations,
  the remaining budget and the refusals already recorded. Entity: `planner.mjs`.
  Invariant: no grant, no policy engine, no approval state, no credential, no
  environment and no handle to anything executable — asserted by a key-set check
  and a source lint, not by convention.

- **Planner** — what turns a planning view into a proposal: `deterministic`
  (rules; a first-class production implementation) or `model` (an injected
  PORT). NOT the thing that decides whether the action happens. Invariant: no
  vendor is named anywhere in the plane; a planner that returns junk is
  `planner_output_malformed` (a domain refusal) and one that throws is
  `planner_unavailable` (an infrastructure failure), and the two are never
  conflated.

- **Observation** — a tool result, recorded for the next turn as labelled DATA
  (`trusted: false`, `treated_as: 'data'`). NOT an instruction. Invariant: text
  inside a result — including text that asks to skip an approval — can only
  become an action by way of a proposal the runtime authorizes from scratch.

- **Agent phase** — the finer projection over the same journal entries the run
  state is projected from: requested, validating, assembling_context, planning,
  validating_action, awaiting_approval, executing, validating_result,
  evaluating, completed, failed, cancelled, timed_out, policy_denied,
  budget_exhausted. NOT a stored field and NOT a second state machine. Entity:
  `harness.mjs:projectAgentPhase`. Invariant: `policy_denied` ("the controls
  worked") and `budget_exhausted` ("it ran out of room") are the distinction the
  control plane's single `failed` cannot make.

- **Execution budget** — four independent limits (turns, steps, tool calls, wall
  clock), each with its OWN refusal reason, projected from the run's own history
  so a resuming process reconstructs it exactly. Entity: `budget.mjs`.
  Invariant: every dimension is NOT NULL and > 0 — an unbounded agent cannot be
  configured — and time is measured over ACTIVE segments, so waiting for a human
  costs nothing.

- **Carry document** — the run's DATA: its proposals, observations, outputs and
  evaluation records, held in the result store. NOT in the journal, because a
  proposal's arguments are tenant data and a journal is a control-plane record.
  Invariant: two stores, two jobs — the same rule step outputs already follow.

- **Evaluation record** — the immutable measurement of one run: deterministic
  checks, policy compliance, tool-use and approval correctness, cost, failure
  class and a score DERIVED from the checks. Entity: `evaluation.mjs`, captured
  before every terminal event including refusals. Invariant: it activates
  nothing.

- **Improvement candidate** — a PROPOSAL to change a prompt, an agent
  definition, a policy, a capability, a tool, a context strategy, a memory
  retrieval rule or a model configuration. Invariant: it cannot exist without
  evaluation evidence, cannot be reviewed or promoted by automation, and
  promotion produces a DRAFT version that still cannot execute until a separate
  human activation and a redeploy. Rollback is automatic because nothing is ever
  replaced.
