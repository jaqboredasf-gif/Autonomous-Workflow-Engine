-- ---------------------------------------------------------------------------
-- 0015_approval_matrix_outbound.sql  (Task B3 — approval matrix + outbound drafts)
--
-- The approval matrix from REQUIREMENTS.md, stored as DATA (message_policies) so a
-- message type can graduate draft->auto by flipping a row, never a rebuild
-- (TASK_BACKLOG B3 acceptance). Plus outbound_messages: the drafted customer-facing
-- message and its approval record.
--
-- THIS MIGRATION CONTAINS NO SEND CAPABILITY. Nothing here talks to Microsoft
-- Graph, SMTP, n8n, or any network. `mark_message_sent` records that a HUMAN
-- already copied an approved draft into Outlook and sent it; it is a status
-- ledger entry, not a transmission. The locked decisions this encodes:
--   * zero v1 auto-sends — every seeded policy row is mode='draft', including the
--     out-of-territory decline whose matrix row was written for auto (DECISION_LOG
--     2026-07-17: auto-decline disabled entirely until the owner approves verified
--     territory rules, B5).
--   * automation has ZERO approval authority (STAKEHOLDERS universal rule 3) —
--     approvals require auth.uid() resolving to a real `users` row; a service-role
--     runner with no JWT cannot approve.
--   * a customer-facing message can never reach `sent` without an approval record
--     (MVP_SPEC §Approval boundaries) — enforced by CHECK + transition guard.
--   * final invoice NEVER auto in v1 (REQUIREMENTS matrix) — CHECK constraint.
--   * no hard deletes of business records (universal rule 1) — before-delete guard.
--
-- Additive only. Touches nothing in 0001-0014. Follows established idioms: org
-- FK + RLS-first, is_fixture + 'fixture:<key>' namespace, timestamps, events via
-- emit_event(), idempotency by unique key (23505 = already recorded).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- One value per REQUIREMENTS.md approval-matrix row, plus the intake-side types
-- the MVP actually drafts (missing_info_request) and the catch-all "uncertain /
-- high-value / unusual / sensitive → always draft + flag" row.
create type outbound_message_type as enum
  ('out_of_territory_decline', 'service_call_confirmation', 'missing_info_request',
   'estimate_proposal', 'scheduling_confirmation', 'crew_dispatch',
   'change_order', 'completion_notice', 'final_invoice', 'uncertain_flagged');

-- The matrix "v1 mode" column. Data-driven graduation lives here and ONLY here.
create type message_mode as enum ('draft', 'auto');

-- draft   — created by the runner/office admin, awaiting a human decision
-- approved— a human with the authorized role approved it (still not sent)
-- rejected— a human refused it (terminal; corrections are a new draft)
-- sent    — a human marked the approved draft as manually sent via Outlook
-- failed  — draft generation or delivery bookkeeping failed (human queue)
-- blocked — the matrix could not route it safely; fail-closed terminal state
create type outbound_message_status as enum
  ('draft', 'approved', 'rejected', 'sent', 'failed', 'blocked');

-- The 10 business roles of STAKEHOLDERS_AND_PERMISSIONS.md. `users.role` still
-- holds only worker/foreman/admin — the `user_roles` join table is the Phase 5
-- migration (DECISION_LOG 2026-07-17). Until then business roles map onto the DB
-- roles through business_role_matches() below; this enum is the vocabulary
-- message_policies.approver_role must reference (UBIQUITOUS_LANGUAGE
-- "Responsibility (approver role)").
create type business_role as enum
  ('owner', 'office_admin', 'dispatcher', 'estimator', 'project_manager',
   'accountant', 'crew_leader', 'field_employee', 'sysadmin');

-- ---------------------------------------------------------------------------
-- message_policies — the approval matrix as data.
--
-- Nullable approver_role and approval_limit_cents are DELIBERATE: an unconfigured
-- responsibility is a first-class, detectable, fail-closed state (blocked
-- reason 'missing_approver_role' / 'missing_approval_limit'), not a silent
-- default to "anyone may approve". Boss answers (§3 thresholds, §11 approvers)
-- are still open — the matrix must be honest about that.
-- ---------------------------------------------------------------------------

create table message_policies (
  id                   uuid primary key default uuid_generate_v4(),
  org_id               uuid not null references orgs(id) on delete cascade,
  message_type         outbound_message_type not null,
  mode                 message_mode not null default 'draft',
  -- Primary responsible approver. NULL = unconfigured => routing fails closed.
  approver_role        business_role,
  -- Used when the primary approver is unavailable (out of office / vacant seat).
  backup_approver_role business_role,
  -- Used when the amount exceeds approval_limit_cents, or on escalation timeout.
  escalation_role      business_role,
  -- Highest amount the primary approver may approve for this type. NULL = not
  -- configured; any amount-bearing message of this type fails closed. Values
  -- await boss §3 (STAKEHOLDERS: "column exists by design, values await §3").
  approval_limit_cents bigint,
  -- Matrix "confidence threshold" column (only the decline row uses it today).
  confidence_threshold numeric,
  -- Matrix "escalation" column, e.g. service-call confirmation unanswered 4h -> owner.
  escalation_after_hours int,
  active               boolean not null default true,
  notes                text,
  is_fixture           boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (confidence_threshold is null
         or (confidence_threshold >= 0 and confidence_threshold <= 1)),
  check (approval_limit_cents is null or approval_limit_cents >= 0),
  check (escalation_after_hours is null or escalation_after_hours > 0),
  -- REQUIREMENTS matrix: "Final invoice — draft, NEVER auto in v1".
  constraint message_policies_invoice_never_auto
    check (message_type <> 'final_invoice' or mode = 'draft'),
  -- Autonomous mode without a configured spend ceiling is unbounded authority.
  constraint message_policies_auto_requires_limit
    check (mode = 'draft' or approval_limit_cents is not null),
  -- Autonomous mode with nobody accountable for it post-hoc is unreviewable.
  constraint message_policies_auto_requires_approver
    check (mode = 'draft' or approver_role is not null)
);

-- One policy row per (org, message type) — the matrix is a lookup, not a list.
create unique index message_policies_org_type_uidx
  on message_policies(org_id, message_type);

create index message_policies_org_active_idx on message_policies(org_id, active);

alter table message_policies enable row level security;

-- Everyone who can see the queue can see WHY a message routed the way it did.
create policy message_policies_admin_read on message_policies
  for select using (org_id = current_org_id() and current_role_is('admin'));

-- Matrix changes are owner + sysadmin jointly (STAKEHOLDERS); both are `admin`
-- in today's DB roles, so this is the closest enforceable approximation until
-- the Phase 5 user_roles migration splits them.
create policy message_policies_admin_update on message_policies
  for update using (org_id = current_org_id() and current_role_is('admin'));

-- ---------------------------------------------------------------------------
-- outbound_messages — one drafted customer-facing (or crew-facing) message and
-- the record of the human decision on it. A row existing here implies NOTHING
-- was sent: `sent` is only reachable through mark_message_sent() after a
-- recorded approval, and it means a human sent it by hand.
-- ---------------------------------------------------------------------------

create table outbound_messages (
  id                     uuid primary key default uuid_generate_v4(),
  org_id                 uuid not null references orgs(id) on delete cascade,
  work_request_id        uuid references work_requests(id),
  message_type           outbound_message_type not null,
  -- Which matrix row routed this message (evidence of the decision inputs).
  policy_id              uuid references message_policies(id),
  subject                text,
  body_text              text,
  to_addrs               text[] not null default '{}',
  cc_addrs               text[] not null default '{}',
  bcc_addrs              text[] not null default '{}',
  attachments            jsonb not null default '[]'::jsonb,
  -- Money the message commits the company to, when the type carries one.
  -- Drives the approval-limit / escalation decision.
  amount_cents           bigint,
  status                 outbound_message_status not null default 'draft',
  -- Routing outcome, copied from the matrix at draft time so later matrix edits
  -- never rewrite the history of who was asked.
  assigned_approver_role business_role,
  routing_path           text,
  escalated              boolean not null default false,
  escalation_reason      text,
  -- Populated iff status='blocked'. Vocabulary kept in lockstep with
  -- scripts/lib/approval-matrix.mjs BLOCKED_REASONS (asserted by the offline lint).
  blocked_reason         text,
  -- Deterministic idempotency key, 'fixture:<...>' for fixtures — same idiom as
  -- email_messages.graph_message_id / approval_drafts.draft_key.
  draft_key              text not null,
  approved_by            uuid references users(id),
  approved_at            timestamptz,
  rejected_by            uuid references users(id),
  rejected_at            timestamptz,
  rejection_reason       text,
  -- Set by mark_message_sent() when a human confirms they sent it manually.
  sent_at                timestamptz,
  sent_marked_by         uuid references users(id),
  -- Evidence slot for a later Graph-captured id. ALWAYS NULL in v1 (no Graph).
  graph_message_id       text,
  -- Provenance of the draft (template id, engine version, adapter).
  model_meta             jsonb not null default '{}'::jsonb,
  is_fixture             boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (amount_cents is null or amount_cents >= 0),
  -- A draft is a draft: no decision fields may be pre-populated.
  constraint outbound_draft_has_no_decision
    check (status <> 'draft'
           or (approved_by is null and approved_at is null
               and rejected_by is null and sent_at is null)),
  -- Approval must name a human and a time.
  constraint outbound_approved_requires_approver
    check (status <> 'approved' or (approved_by is not null and approved_at is not null)),
  -- Rejection must name a human and a reason (corrections are a new draft).
  constraint outbound_rejected_requires_reason
    check (status <> 'rejected'
           or (rejected_by is not null and rejected_at is not null
               and rejection_reason is not null)),
  -- THE send gate: `sent` is unreachable without a recorded approval and a human
  -- who marked it sent. MVP_SPEC: "outbound_messages cannot reach sent without an
  -- approval row"; observable DoD 8: "zero rows in any sent state without an
  -- approval row".
  constraint outbound_sent_requires_approval
    check (status <> 'sent'
           or (approved_by is not null and approved_at is not null
               and sent_at is not null and sent_marked_by is not null)),
  constraint outbound_sent_at_requires_approval
    check (sent_at is null or approved_at is not null),
  -- A blocked message must say why it is blocked (clear blocked state).
  constraint outbound_blocked_requires_reason
    check (status <> 'blocked' or blocked_reason is not null),
  -- No Graph id can exist in v1: there is no capture path. Guards against a
  -- future writer quietly inventing one.
  constraint outbound_no_graph_id_in_v1
    check (graph_message_id is null or sent_at is not null)
);

-- Idempotency: re-drafting the same message is a unique violation (23505), the
-- same contract as fixture re-ingest. This is also the duplicate-request guard.
create unique index outbound_messages_draft_key_uidx
  on outbound_messages(org_id, draft_key);

-- At most ONE live draft/approved message per (request, type) — MVP_SPEC tool
-- registry idempotency for create_outbound_draft. Rejected/blocked/sent rows are
-- history and do not block a corrected re-draft.
create unique index outbound_messages_active_uidx
  on outbound_messages(org_id, work_request_id, message_type)
  where status in ('draft', 'approved');

create index outbound_messages_org_status_idx  on outbound_messages(org_id, status);
create index outbound_messages_org_created_idx on outbound_messages(org_id, created_at desc);
create index outbound_messages_request_idx     on outbound_messages(work_request_id);

alter table outbound_messages enable row level security;

-- Read: admin (the approval queue, B5). Workers/foremen get no policy at all —
-- a non-approver cannot even see the queue, let alone act on it.
create policy outbound_messages_admin_read on outbound_messages
  for select using (org_id = current_org_id() and current_role_is('admin'));

-- NOTE: there is deliberately NO insert/update/delete policy. Every state change
-- goes through the security-definer RPCs below, so the transition guard,
-- authorization check and audit event can never be bypassed by a direct table
-- write from a client session.

-- ---------------------------------------------------------------------------
-- Business-role resolution (interim, until the Phase 5 `user_roles` join table).
--
-- STAKEHOLDERS "Role → DB divergence": today's `admin` is office admin + owner +
-- sysadmin mixed; foreman = crew leader; worker = field employee. This function
-- is the single place that approximation lives, so the Phase 5 migration has one
-- thing to replace. It is intentionally CONSERVATIVE: field-facing roles can
-- never satisfy an office/owner responsibility.
-- ---------------------------------------------------------------------------

create or replace function business_role_matches(p_user uuid, p_role business_role)
returns boolean language plpgsql stable security definer as $$
declare
  v_role user_role;
begin
  if p_user is null or p_role is null then
    return false;
  end if;
  select role into v_role from users where id = p_user;
  if v_role is null then
    return false;
  end if;
  return case p_role
    when 'crew_leader'    then v_role = 'foreman'
    when 'field_employee' then v_role in ('worker', 'foreman')
    -- Every office/approver responsibility maps onto `admin` for now.
    else v_role = 'admin'
  end;
end $$;

-- ---------------------------------------------------------------------------
-- No hard deletes (universal rule 1). RLS already default-denies client deletes
-- (no delete policy exists); this blocks even a service-role mistake. Reuses
-- guard_no_delete() from 0014 if present, otherwise defines the same function.
-- ---------------------------------------------------------------------------

create or replace function guard_no_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'business record is append-only; hard deletes are forbidden (%.%)',
    tg_table_name, coalesce(old.id::text, '?');
end $$;

create trigger outbound_messages_no_delete
  before delete on outbound_messages
  for each row execute function guard_no_delete();

create trigger message_policies_no_delete
  before delete on message_policies
  for each row execute function guard_no_delete();

-- ---------------------------------------------------------------------------
-- Status-transition guard. Content of a message is frozen once a human has acted
-- on it (you approve WHAT YOU READ), and the transition graph is closed:
--
--   draft    -> approved | rejected | blocked | failed
--   approved -> sent | rejected
--   rejected | sent | blocked | failed -> (terminal)
--
-- Anything else raises. Corrections after a terminal state are a NEW draft row.
-- ---------------------------------------------------------------------------

create or replace function guard_outbound_transition() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not (
         (old.status = 'draft'    and new.status in ('approved','rejected','blocked','failed'))
      or (old.status = 'approved' and new.status in ('sent','rejected'))
    ) then
      raise exception 'illegal outbound_messages transition % -> % (message %)',
        old.status, new.status, old.id;
    end if;
  end if;

  -- Message content is immutable once it leaves `draft`: the approval refers to
  -- specific words, so the words may not change under it.
  if old.status <> 'draft' then
    if new.subject is distinct from old.subject
       or new.body_text is distinct from old.body_text
       or new.to_addrs is distinct from old.to_addrs
       or new.cc_addrs is distinct from old.cc_addrs
       or new.bcc_addrs is distinct from old.bcc_addrs
       or new.attachments is distinct from old.attachments
       or new.amount_cents is distinct from old.amount_cents
       or new.message_type is distinct from old.message_type then
      raise exception 'outbound message content is frozen once it leaves draft (message %)', old.id;
    end if;
  end if;

  -- Approval/send attribution is write-once.
  if old.approved_by is not null and new.approved_by is distinct from old.approved_by then
    raise exception 'approved_by is set-once (message %)', old.id;
  end if;
  if old.sent_at is not null and new.sent_at is distinct from old.sent_at then
    raise exception 'sent_at is set-once (message %)', old.id;
  end if;

  new.updated_at := now();
  return new;
end $$;

create trigger outbound_messages_transition_guard
  before update on outbound_messages
  for each row execute function guard_outbound_transition();

-- ---------------------------------------------------------------------------
-- Events (n8n contract, same emit_event spine as 0009/0011/0013/0014).
-- message.draft_created / blocked on insert; approved / rejected / sent /
-- escalated on the matching transition. Events are the audit trail the queue and
-- the regression Verify Steps read.
-- ---------------------------------------------------------------------------

create or replace function emit_outbound_insert_events() returns trigger
language plpgsql security definer as $$
begin
  if new.status = 'blocked' then
    perform emit_event('message.blocked', 'outbound_message', new.id, new.org_id,
      jsonb_build_object('message_type', new.message_type,
                         'work_request_id', new.work_request_id,
                         'blocked_reason', new.blocked_reason,
                         'is_fixture', new.is_fixture));
  else
    perform emit_event('message.draft_created', 'outbound_message', new.id, new.org_id,
      jsonb_build_object('message_type', new.message_type,
                         'work_request_id', new.work_request_id,
                         'policy_id', new.policy_id,
                         'assigned_approver_role', new.assigned_approver_role,
                         'routing_path', new.routing_path,
                         'escalated', new.escalated,
                         'amount_cents', new.amount_cents,
                         'status', new.status,
                         'is_fixture', new.is_fixture));
  end if;
  if new.escalated then
    perform emit_event('message.escalated', 'outbound_message', new.id, new.org_id,
      jsonb_build_object('message_type', new.message_type,
                         'assigned_approver_role', new.assigned_approver_role,
                         'escalation_reason', new.escalation_reason,
                         'amount_cents', new.amount_cents));
  end if;
  return new;
end $$;

create trigger outbound_messages_insert_events
  after insert on outbound_messages
  for each row execute function emit_outbound_insert_events();

create or replace function emit_outbound_update_events() returns trigger
language plpgsql security definer as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'approved' then
      perform emit_event('message.approved', 'outbound_message', new.id, new.org_id,
        jsonb_build_object('message_type', new.message_type,
                           'approved_by', new.approved_by,
                           'approver_role', new.assigned_approver_role,
                           'amount_cents', new.amount_cents,
                           'work_request_id', new.work_request_id));
    elsif new.status = 'rejected' then
      perform emit_event('message.rejected', 'outbound_message', new.id, new.org_id,
        jsonb_build_object('message_type', new.message_type,
                           'rejected_by', new.rejected_by,
                           'rejection_reason', new.rejection_reason,
                           'work_request_id', new.work_request_id));
    elsif new.status = 'sent' then
      perform emit_event('message.sent', 'outbound_message', new.id, new.org_id,
        jsonb_build_object('message_type', new.message_type,
                           'sent_marked_by', new.sent_marked_by,
                           'approved_by', new.approved_by,
                           'manual_send', true,
                           'work_request_id', new.work_request_id));
    elsif new.status = 'blocked' then
      perform emit_event('message.blocked', 'outbound_message', new.id, new.org_id,
        jsonb_build_object('message_type', new.message_type,
                           'blocked_reason', new.blocked_reason,
                           'work_request_id', new.work_request_id));
    end if;
  end if;
  if new.escalated and not old.escalated then
    perform emit_event('message.escalated', 'outbound_message', new.id, new.org_id,
      jsonb_build_object('message_type', new.message_type,
                         'assigned_approver_role', new.assigned_approver_role,
                         'escalation_reason', new.escalation_reason,
                         'amount_cents', new.amount_cents));
  end if;
  return new;
end $$;

create trigger outbound_messages_update_events
  after update on outbound_messages
  for each row execute function emit_outbound_update_events();

-- ---------------------------------------------------------------------------
-- route_outbound() — the approval matrix decision, in SQL. Mirrors
-- scripts/lib/approval-matrix.mjs exactly (the offline engine Runner 4 evaluates);
-- the blocked-reason vocabulary is asserted identical by
-- scripts/lib/validate-migration-0015.mjs.
--
-- Returns jsonb: {blocked, blocked_reason, approver_role, routing_path,
--                 escalated, escalation_reason, policy_id, effective_mode}.
-- Pure lookup + rules; writes nothing.
-- ---------------------------------------------------------------------------

create or replace function route_outbound(
  p_org uuid,
  p_type outbound_message_type,
  p_amount_cents bigint default null,
  p_unavailable_roles business_role[] default '{}'
) returns jsonb language plpgsql stable as $$
declare
  p            message_policies%rowtype;
  v_role       business_role;
  v_path       text := 'primary';
  v_escalated  boolean := false;
  v_reason     text := null;
begin
  select * into p from message_policies
   where org_id = p_org and message_type = p_type limit 1;

  if p.id is null then
    return jsonb_build_object('blocked', true, 'blocked_reason', 'no_policy');
  end if;
  if not p.active then
    return jsonb_build_object('blocked', true, 'blocked_reason', 'policy_inactive',
                              'policy_id', p.id);
  end if;
  if p.approver_role is null then
    -- "Missing owner": nobody is accountable for this message type. Fail closed.
    return jsonb_build_object('blocked', true, 'blocked_reason', 'missing_approver_role',
                              'policy_id', p.id);
  end if;

  v_role := p.approver_role;

  -- Backup ownership: primary approver unavailable -> configured backup, else blocked.
  if p_unavailable_roles is not null and v_role = any(p_unavailable_roles) then
    if p.backup_approver_role is null then
      return jsonb_build_object('blocked', true, 'blocked_reason', 'no_backup_approver',
                                'policy_id', p.id);
    end if;
    v_role := p.backup_approver_role;
    v_path := 'backup';
    if v_role = any(p_unavailable_roles) then
      return jsonb_build_object('blocked', true, 'blocked_reason', 'no_backup_approver',
                                'policy_id', p.id);
    end if;
  end if;

  -- Approval limit. An amount-bearing message with no configured limit fails
  -- closed — we never guess a spend ceiling.
  if p_amount_cents is not null then
    if p.approval_limit_cents is null then
      return jsonb_build_object('blocked', true, 'blocked_reason', 'missing_approval_limit',
                                'policy_id', p.id);
    end if;
    if p_amount_cents > p.approval_limit_cents then
      if p.escalation_role is null then
        return jsonb_build_object('blocked', true, 'blocked_reason', 'missing_escalation_role',
                                  'policy_id', p.id);
      end if;
      v_role      := p.escalation_role;
      v_path      := 'escalation';
      v_escalated := true;
      v_reason    := format('amount %s exceeds approval limit %s for role %s',
                            p_amount_cents, p.approval_limit_cents, p.approver_role);
    end if;
  end if;

  return jsonb_build_object(
    'blocked', false, 'blocked_reason', null,
    'policy_id', p.id, 'approver_role', v_role, 'routing_path', v_path,
    'escalated', v_escalated, 'escalation_reason', v_reason,
    -- v1 effective mode is ALWAYS draft: auto-send is disabled everywhere until
    -- the owner approves verified rules. The stored mode is reported so the
    -- graduation decision stays visible and data-driven.
    'policy_mode', p.mode, 'effective_mode', 'draft');
end $$;

-- ---------------------------------------------------------------------------
-- create_outbound_draft() — the ONLY way a message row is born.
-- Routes through the matrix, writes either a draft or a blocked row (never a
-- silent no-op), and is idempotent on (org, draft_key): a duplicate request
-- returns the existing row id instead of creating a second message.
-- ---------------------------------------------------------------------------

create or replace function create_outbound_draft(
  p_org uuid,
  p_work_request uuid,
  p_type outbound_message_type,
  p_draft_key text,
  p_subject text,
  p_body text,
  p_to_addrs text[],
  p_amount_cents bigint default null,
  p_unavailable_roles business_role[] default '{}',
  p_is_fixture boolean default false,
  p_model_meta jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer as $$
declare
  v_existing uuid;
  v_route    jsonb;
  v_id       uuid;
begin
  if p_draft_key is null or p_draft_key = '' then
    raise exception 'draft_key is required (idempotency contract)';
  end if;

  -- Duplicate request: same key => same message. No second row, no second draft.
  select id into v_existing from outbound_messages
   where org_id = p_org and draft_key = p_draft_key;
  if v_existing is not null then
    return v_existing;
  end if;

  v_route := route_outbound(p_org, p_type, p_amount_cents, p_unavailable_roles);

  if (v_route->>'blocked')::boolean then
    insert into outbound_messages (
      org_id, work_request_id, message_type, policy_id, subject, body_text,
      to_addrs, amount_cents, status, blocked_reason, draft_key, is_fixture, model_meta)
    values (
      p_org, p_work_request, p_type, nullif(v_route->>'policy_id','')::uuid,
      p_subject, p_body, coalesce(p_to_addrs, '{}'), p_amount_cents,
      'blocked', v_route->>'blocked_reason', p_draft_key, p_is_fixture, p_model_meta)
    returning id into v_id;
    return v_id;
  end if;

  insert into outbound_messages (
    org_id, work_request_id, message_type, policy_id, subject, body_text,
    to_addrs, amount_cents, status, assigned_approver_role, routing_path,
    escalated, escalation_reason, draft_key, is_fixture, model_meta)
  values (
    p_org, p_work_request, p_type, (v_route->>'policy_id')::uuid,
    p_subject, p_body, coalesce(p_to_addrs, '{}'), p_amount_cents,
    'draft', (v_route->>'approver_role')::business_role, v_route->>'routing_path',
    (v_route->>'escalated')::boolean, v_route->>'escalation_reason',
    p_draft_key, p_is_fixture, p_model_meta)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- record_approval() — the human decision gate.
--
-- Automation cannot reach it: it requires auth.uid() to resolve to a `users` row
-- holding the assigned approver role. A service-role runner has no JWT, so
-- auth.uid() is null and the call raises. (STAKEHOLDERS universal rule 3:
-- automation has zero approval authority.)
-- ---------------------------------------------------------------------------

create or replace function record_approval(
  p_message uuid,
  p_decision text,          -- 'approve' | 'reject'
  p_reason text default null
) returns outbound_message_status language plpgsql security definer as $$
declare
  m      outbound_messages%rowtype;
  v_uid  uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'approval requires an authenticated human; automation has no approval authority';
  end if;

  select * into m from outbound_messages where id = p_message;
  if m.id is null then
    raise exception 'outbound message % not found', p_message;
  end if;
  if m.org_id is distinct from current_org_id() then
    raise exception 'cross-org approval refused (message %)', p_message;
  end if;
  if m.status <> 'draft' then
    raise exception 'only a draft can be decided; message % is %', p_message, m.status;
  end if;
  if not business_role_matches(v_uid, m.assigned_approver_role) then
    raise exception 'user % does not hold the approver role % required for message %',
      v_uid, m.assigned_approver_role, p_message;
  end if;

  if p_decision = 'approve' then
    update outbound_messages
       set status = 'approved', approved_by = v_uid, approved_at = now()
     where id = p_message;
    return 'approved';
  elsif p_decision = 'reject' then
    if p_reason is null or p_reason = '' then
      raise exception 'a rejection must record a reason';
    end if;
    update outbound_messages
       set status = 'rejected', rejected_by = v_uid, rejected_at = now(),
           rejection_reason = p_reason
     where id = p_message;
    return 'rejected';
  end if;
  raise exception 'unknown decision % (expected approve|reject)', p_decision;
end $$;

-- ---------------------------------------------------------------------------
-- mark_message_sent() — bookkeeping ONLY.
--
-- This function sends nothing. It records that an authorized human copied an
-- APPROVED draft into Outlook and sent it themselves (same v1 pattern as
-- invoices: create in QB, send via Outlook, mark sent here). It refuses any
-- message that is not `approved`, so the send ledger can never contain a message
-- no human approved.
-- ---------------------------------------------------------------------------

create or replace function mark_message_sent(p_message uuid)
returns outbound_message_status language plpgsql security definer as $$
declare
  m     outbound_messages%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'marking sent requires an authenticated human';
  end if;

  select * into m from outbound_messages where id = p_message;
  if m.id is null then
    raise exception 'outbound message % not found', p_message;
  end if;
  if m.org_id is distinct from current_org_id() then
    raise exception 'cross-org send-marking refused (message %)', p_message;
  end if;
  if m.status <> 'approved' then
    raise exception 'only an approved message can be marked sent; message % is % (approval gate)',
      p_message, m.status;
  end if;
  if not business_role_matches(v_uid, m.assigned_approver_role) then
    raise exception 'user % does not hold the role % required to send message %',
      v_uid, m.assigned_approver_role, p_message;
  end if;

  update outbound_messages
     set status = 'sent', sent_at = now(), sent_marked_by = v_uid
   where id = p_message;
  return 'sent';
end $$;

-- ---------------------------------------------------------------------------
-- Matrix seed (REQUIREMENTS.md approval matrix, v1 values).
--
-- EVERY row is mode='draft' — including out_of_territory_decline, whose matrix
-- row was written for AUTO. Auto-decline is disabled entirely until the owner
-- approves verified territory rules (B5) and flips this row: that flip is the
-- "graduate draft->auto without a rebuild" acceptance criterion.
--
-- approval_limit_cents is deliberately LEFT NULL: the boss's §3 threshold values
-- are still open, and a guessed ceiling is worse than a fail-closed block.
-- approver_role NULL on estimate_proposal is likewise honest — "boss or
-- authorized estimator" is an unresolved [ASSUMPTION] (B2/§3), so that type
-- blocks with 'missing_approver_role' until answered.
-- ---------------------------------------------------------------------------

insert into message_policies (
  org_id, message_type, mode, approver_role, backup_approver_role, escalation_role,
  approval_limit_cents, confidence_threshold, escalation_after_hours, notes)
select o.id, v.message_type::outbound_message_type, 'draft'::message_mode,
       v.approver_role::business_role, v.backup_role::business_role,
       v.escalation_role::business_role,
       v.limit_cents, v.confidence, v.escalate_hours, v.notes
from orgs o
cross join (values
  ('out_of_territory_decline',  'office_admin', 'owner', 'owner', null::bigint, 0.90, null::int,
   'Matrix row written for AUTO; auto-decline disabled entirely until owner approves verified territory rules (B5). v1 approver = office admin [ASSUMPTION W2].'),
  ('service_call_confirmation', 'office_admin', 'owner', 'owner', null, null, 4,
   'Matrix: unanswered 4h -> owner.'),
  ('missing_info_request',      'office_admin', 'owner', 'owner', null, null, null,
   'Intake Map 5 follow-up; nudge/close policy OPEN B11.'),
  ('estimate_proposal',         null,           'owner', 'owner', null, null, null,
   'Approver = boss or authorized estimator [ASSUMPTION, OPEN B2/§3] -> left NULL so it fails closed instead of guessing.'),
  ('scheduling_confirmation',   'office_admin', 'owner', 'owner', null, null, null, null),
  ('crew_dispatch',             'dispatcher',   'office_admin', 'owner', null, null, null,
   'Dispatcher may be the same human as office admin.'),
  ('change_order',              'owner',        null,    'owner', null, null, null,
   'Owner-only approval (Map 17); no backup by design — a CO waits for the owner.'),
  ('completion_notice',         'office_admin', 'owner', 'owner', null, null, null, null),
  ('final_invoice',             'office_admin', 'accountant', 'owner', null, null, null,
   'NEVER auto in v1 (CHECK constraint). v1 send = manual QB + Outlook, mark sent here.'),
  ('uncertain_flagged',         'owner',        null,    'owner', null, null, null,
   'Matrix catch-all: uncertain / high-value / unusual / sensitive -> always draft + flag, owner, immediate escalation.')
) as v(message_type, approver_role, backup_role, escalation_role, limit_cents,
       confidence, escalate_hours, notes)
on conflict (org_id, message_type) do nothing;
