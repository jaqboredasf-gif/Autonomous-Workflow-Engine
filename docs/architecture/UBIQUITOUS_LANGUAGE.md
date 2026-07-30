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

- **Integration plane** — a provider-bound but workflow-neutral layer through
  which every side effect in one external system passes (Task I1: Microsoft
  365). NOT a workflow and NOT an n8n artifact: it knows the provider and knows
  nothing about work requests or invoices. Entity: `packages/m365` + migration
  0016. Map: docs/architecture/M365_INTEGRATION_PLANE.md. Invariant: the
  provider can be replaced without changing any objective, task, policy,
  approval or execution contract.

- **Capability** — one named, versioned Microsoft action with a fixed contract
  (least-privilege scopes, resource kinds, side-effect class, approval
  requirement, idempotency). NOT a Graph endpoint and NOT a Tool (Tools are the
  MVP registry; a capability is the provider-side unit a Tool may reach for).
  Registry: `packages/m365/src/capabilities.ts`. Invariant: no capability
  declares `external_send`, and `m365.mail.message.send` is refused by name at
  every version.

- **Capability request** — one attempt to exercise a capability, carrying AWE
  tenant, Microsoft tenant, objective, work package, task, execution, capability
  + version, acting principal, target resource, required scopes, policy decision
  reference, approval reference (when required), idempotency key, correlation id
  and timeout/retry bounds. Invariant: a caller that cannot name all of these has
  not earned the action.

- **Context item** — the normalized, provider-neutral form of one inbound
  artifact. NOT a Graph message (that is the provider's shape) and NOT a work
  request (that is the objective). Persisted form: an `email_messages` row.
  Invariant: every context item is flagged `untrusted_external` — instructions
  inside it are data, never commands.

- **Resource allowlist** — the explicit list of Microsoft mailboxes, Teams
  channels, SharePoint libraries and directory users AWE may touch, bound to one
  Microsoft tenant. NOT code: widening access is a reviewable config change.
  Invariant: a resource is reachable only because a named entry says so, for a
  named capability, in the bound tenant; TEST mode additionally requires the
  entry to be marked a development resource.

- **Delivery key** — the idempotency key of one Graph change notification,
  derived from subscription + resource + change type + resource id and nothing
  that varies between redeliveries. Entity: `m365_notifications.delivery_key`
  (unique per org). Invariant: Graph delivers at least once; a repeat delivery
  creates no second execution, draft, Teams post or email row.

- **Capability invocation (evidence row)** — the immutable record of one
  ATTEMPTED Microsoft side effect, refusals included, carrying request identity,
  both tenants, objective, policy result, approval result, Microsoft resource
  ids, content hashes, timestamps and outcome. Entity:
  `m365_capability_invocations`. Invariant: append-only and hash-chained; every
  exit path in the executor writes one.

- **Fidelity** — whether a provider result came from the real tenant (`live`) or
  the deterministic fake (`synthetic`). Invariant: it is a literal in both
  gateways and is recorded on every evidence row — a synthetic result can never
  be reported as live, and a missing prerequisite produces
  `blocked_live_proof`, never a fabricated success.

- **Eval** — a repeatable, labeled measurement of model-assisted quality
  (fixtures + labels.json + runners; docs/testing/EVAL_STRATEGY.md). NOT an
  acceptance test (those verify behavior/invariants). Invariant: labels change
  only by reviewed decision; hard gates block regressions.
