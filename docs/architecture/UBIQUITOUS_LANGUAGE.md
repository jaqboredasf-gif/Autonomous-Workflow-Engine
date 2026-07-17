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
  message type. Entity: `message_policies.approver_role` (B3). Invariant:
  customer-facing sends require an approval row from an authorized role.

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
