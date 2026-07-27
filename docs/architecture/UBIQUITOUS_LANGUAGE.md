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
