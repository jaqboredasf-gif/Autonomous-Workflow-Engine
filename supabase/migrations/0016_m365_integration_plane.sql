-- Task I1 (AWE slice 6): Microsoft 365 Integration Plane — subscription
-- lifecycle, notification ledger (at-least-once -> exactly-once), execution
-- records and the capability-invocation evidence trail.
--
-- Additive only. NOT YET APPLIED to the live project: applying migrations is
-- human-gated (AGENTS.md). Structural validation runs offline in
-- scripts/lib/validate-migration-0016.mjs, which also asserts that every
-- vocabulary below is IDENTICAL to the engine in packages/m365 — the same
-- engine/SQL parity contract 0015 established for the approval matrix.
--
-- What this migration does NOT create, deliberately:
--   * no table that stores a Microsoft credential, token or clientState secret
--     (only a hash of clientState, so a leak of this schema leaks nothing);
--   * no send state, no transmit column, nothing that could record an email
--     having left the building — because nothing in this plane can send one;
--   * no generic workflow/engine tables (DECISION_LOG 2026-07-17). An objective
--     is a pointer at work_requests; work package and task are columns.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type m365_subscription_state as enum
  ('pending', 'active', 'expired', 'revoked', 'reauthorization_required', 'failed');

create type m365_execution_status as enum
  ('running', 'succeeded', 'partially_succeeded', 'failed', 'rejected', 'duplicate');

create type m365_capability_outcome as enum
  ('succeeded', 'denied', 'failed', 'replayed', 'blocked_live_proof');

create type m365_provider_fidelity as enum ('live', 'synthetic');

-- ---------------------------------------------------------------------------
-- m365_subscriptions — one row per Graph change subscription we own.
--
-- The clientState SECRET never lands here: only its sha256. Validation compares
-- the incoming notification against the secret held in the environment, and this
-- row exists so lifecycle state, expiry and scope are auditable without it.
-- ---------------------------------------------------------------------------

create table m365_subscriptions (
  id                    uuid primary key default uuid_generate_v4(),
  org_id                uuid not null references orgs(id) on delete cascade,
  subscription_id       text not null,
  microsoft_tenant_id   text not null,
  resource              text not null,
  resource_kind         text not null
                        check (resource_kind in ('mailbox', 'teams_channel', 'sharepoint_library')),
  -- The allowlist unit this subscription is bound to (mailbox UPN, channel id).
  resource_unit_id      text not null,
  change_types          text[] not null default '{}',
  notification_url      text not null,
  client_state_hash     text not null,
  expires_at            timestamptz not null,
  state                 m365_subscription_state not null default 'pending',
  last_renewed_at       timestamptz,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- A subscription secret must never be stored in the clear. 64 hex chars = sha256.
  constraint m365_sub_client_state_is_hash
    check (client_state_hash ~ '^[0-9a-f]{64}$'),
  constraint m365_sub_has_change_types
    check (array_length(change_types, 1) >= 1)
);

-- One row per Graph subscription id, per tenant. A re-created subscription gets
-- a NEW id from Graph, so this never collides with a renewal.
create unique index m365_subscriptions_sub_uidx
  on m365_subscriptions(org_id, subscription_id);
create index m365_subscriptions_state_idx on m365_subscriptions(org_id, state, expires_at);

-- Service-role only: subscription config is operational, not user-facing.
alter table m365_subscriptions enable row level security;

-- ---------------------------------------------------------------------------
-- m365_notifications — the delivery ledger. THE idempotency boundary.
--
-- Graph notifications are at-least-once. The unique index on
-- (org_id, delivery_key) is what turns "at least once" into "exactly one
-- execution": the second delivery is a 23505, the same idiom as offline punches
-- (device_id, client_uuid) and email_messages (org_id, graph_message_id).
--
-- Refused notifications are recorded here too, WITHOUT a delivery key, so a
-- refusal is provable — a rejected event that left no trace would be the same
-- as a silent drop.
-- ---------------------------------------------------------------------------

create table m365_notifications (
  id                   uuid primary key default uuid_generate_v4(),
  org_id               uuid not null references orgs(id) on delete cascade,
  delivery_key         text,
  subscription_id      text not null,
  microsoft_tenant_id  text not null,
  resource             text not null,
  change_type          text not null,
  accepted             boolean not null,
  -- Vocabulary in lockstep with NOTIFICATION_REJECTIONS in
  -- packages/m365/src/notifications.ts (asserted offline).
  rejection_reason     text
                       check (rejection_reason is null or rejection_reason in (
                         'malformed_notification',
                         'unknown_subscription',
                         'subscription_not_active',
                         'subscription_expired',
                         'client_state_mismatch',
                         'tenant_mismatch',
                         'resource_mismatch',
                         'resource_not_allowlisted',
                         'change_type_not_subscribed'
                       )),
  detail               text,
  execution_id         text,
  delivery_count       int not null default 1,
  received_at          timestamptz not null,
  created_at           timestamptz not null default now(),
  -- An accepted notification must say which delivery it was and which execution
  -- it drove; a refused one must say why it was refused. Neither may be vague.
  constraint m365_notif_accepted_has_key
    check (not accepted or (delivery_key is not null and execution_id is not null)),
  constraint m365_notif_rejected_has_reason
    check (accepted or rejection_reason is not null),
  constraint m365_notif_delivery_count_positive
    check (delivery_count >= 1)
);

-- The exactly-once guarantee, in one line.
create unique index m365_notifications_delivery_uidx
  on m365_notifications(org_id, delivery_key)
  where delivery_key is not null;

create index m365_notifications_sub_idx on m365_notifications(org_id, subscription_id, received_at desc);
create index m365_notifications_rejected_idx
  on m365_notifications(org_id, rejection_reason) where accepted = false;

alter table m365_notifications enable row level security;

-- ---------------------------------------------------------------------------
-- m365_executions — one row per accepted delivery that did work.
--
-- objective_id references work_requests: the objective IS the customer ask, not
-- a new abstraction. work_package_id and task_id are names, deliberately columns
-- and not tables (no generic engine schema).
-- ---------------------------------------------------------------------------

create table m365_executions (
  id                   uuid primary key default uuid_generate_v4(),
  org_id               uuid not null references orgs(id) on delete cascade,
  execution_id         text not null,
  microsoft_tenant_id  text not null,
  objective_id         text not null,
  work_request_id      uuid references work_requests(id),
  work_package_id      text not null,
  task_id              text not null,
  correlation_id       text not null,
  delivery_key         text not null,
  subscription_id      text not null,
  status               m365_execution_status not null default 'running',
  started_at           timestamptz not null,
  ended_at             timestamptz,
  detail               text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint m365_exec_finished_has_end
    check (status = 'running' or ended_at is not null)
);

-- One execution per delivery: a duplicate notification cannot mint a second one.
create unique index m365_executions_execution_uidx on m365_executions(org_id, execution_id);
create unique index m365_executions_delivery_uidx  on m365_executions(org_id, delivery_key);
create index m365_executions_objective_idx on m365_executions(org_id, objective_id);

alter table m365_executions enable row level security;

create policy m365_executions_admin_read on m365_executions
  for select using (org_id = current_org_id() and current_role_is('admin'));

-- ---------------------------------------------------------------------------
-- m365_capability_invocations — the evidence trail.
--
-- One immutable row per ATTEMPTED side effect, including every refusal. This is
-- the table that answers "who did what, to which Microsoft resource, under whose
-- authority, and what happened" without asking Microsoft.
--
-- Append-only: the guard trigger below rejects UPDATE and DELETE outright. There
-- is no correction path — a wrong row is answered by a new row.
-- ---------------------------------------------------------------------------

create table m365_capability_invocations (
  id                     uuid primary key default uuid_generate_v4(),
  org_id                 uuid not null references orgs(id) on delete cascade,
  evidence_id            text not null,
  recorded_at            timestamptz not null,
  microsoft_tenant_id    text not null,
  objective_id           text not null,
  work_package_id        text not null,
  task_id                text not null,
  execution_id           text not null,
  correlation_id         text not null,
  idempotency_key        text not null,
  -- Vocabulary in lockstep with CAPABILITY_CATALOG in
  -- packages/m365/src/capabilities.ts (asserted offline). Note what is absent:
  -- there is no send capability, so no evidence row can describe one.
  capability             text not null
                         check (capability in (
                           'm365.identity.resolve',
                           'm365.mail.message.read',
                           'm365.mail.attachment.read',
                           'm365.mail.draft.create',
                           'm365.teams.notification.create',
                           'm365.teams.approval.request',
                           'm365.document.store'
                         )),
  capability_version     int not null,
  acting_principal       jsonb not null,
  target_resource        jsonb not null,
  required_scopes        text[] not null default '{}',
  policy_decision_id     text not null,
  policy_effect          text not null check (policy_effect in ('permit', 'deny')),
  approval_id            text,
  approval_state         text check (approval_state is null or approval_state in ('pending', 'approved', 'rejected')),
  outcome                m365_capability_outcome not null,
  -- Vocabulary in lockstep with DENIAL_REASONS in packages/m365/src/contracts.ts.
  denial_reason          text
                         check (denial_reason is null or denial_reason in (
                           'invalid_request',
                           'unknown_capability',
                           'unsupported_capability_version',
                           'external_send_forbidden',
                           'test_mode_violation',
                           'cross_tenant_denied',
                           'tenant_binding_missing',
                           'resource_not_allowlisted',
                           'scope_not_declared',
                           'insufficient_scope',
                           'policy_decision_missing',
                           'policy_decision_mismatch',
                           'policy_decision_expired',
                           'policy_denied',
                           'approval_missing',
                           'approval_not_granted',
                           'approval_mismatch',
                           'approval_expired',
                           'approval_by_service_principal'
                         )),
  -- Vocabulary in lockstep with FAILURE_REASONS in packages/m365/src/contracts.ts.
  failure_reason         text
                         check (failure_reason is null or failure_reason in (
                           'provider_error',
                           'provider_throttled',
                           'provider_timeout',
                           'provider_unavailable',
                           'resource_not_found',
                           'live_access_blocked'
                         )),
  fidelity               m365_provider_fidelity not null,
  microsoft_resource_ids jsonb not null default '{}'::jsonb,
  -- Hashes, never payloads: the trail proves what was seen without holding it.
  input_hash             text not null,
  output_hash            text,
  attempts               int not null default 0,
  gates                  jsonb not null default '[]'::jsonb,
  previous_evidence_hash text,
  evidence_hash          text not null,
  created_at             timestamptz not null default now(),
  constraint m365_inv_denied_has_reason
    check (outcome <> 'denied' or denial_reason is not null),
  constraint m365_inv_failed_has_reason
    check (outcome <> 'failed' or failure_reason is not null),
  -- A success is a success: it cannot also carry a refusal.
  constraint m365_inv_success_is_clean
    check (outcome <> 'succeeded' or (denial_reason is null and failure_reason is null)),
  -- A denial never touched the provider, so it can have made no attempt.
  constraint m365_inv_denied_made_no_attempt
    check (outcome <> 'denied' or attempts = 0),
  constraint m365_inv_hashes_are_sha256
    check (evidence_hash ~ '^[0-9a-f]{64}$'
           and input_hash ~ '^[0-9a-f]{64}$'
           and (output_hash is null or output_hash ~ '^[0-9a-f]{64}$')
           and (previous_evidence_hash is null or previous_evidence_hash ~ '^[0-9a-f]{64}$'))
);

-- Idempotency: one completed invocation per key. A replay records its own row
-- (outcome 'replayed') and is excluded from the constraint on purpose — the
-- attempt is evidence, the side effect is not repeated.
create unique index m365_invocations_idem_uidx
  on m365_capability_invocations(org_id, idempotency_key)
  where outcome = 'succeeded';

create unique index m365_invocations_evidence_uidx
  on m365_capability_invocations(org_id, evidence_id);
create index m365_invocations_exec_idx on m365_capability_invocations(org_id, execution_id, recorded_at);
create index m365_invocations_capability_idx on m365_capability_invocations(org_id, capability, outcome);

alter table m365_capability_invocations enable row level security;

-- Audit rows are readable by admins (the evidence view), writable by nobody
-- through the client: there is deliberately no insert/update/delete policy.
create policy m365_invocations_admin_read on m365_capability_invocations
  for select using (org_id = current_org_id() and current_role_is('admin'));

-- ---------------------------------------------------------------------------
-- Append-only guard. Same posture as the email immutability guard in 0011 and
-- the no-hard-delete rule throughout: evidence is never edited or removed.
-- ---------------------------------------------------------------------------

create or replace function guard_m365_evidence_immutability() returns trigger
language plpgsql as $$
begin
  raise exception 'm365_capability_invocations is append-only (attempted %)', tg_op;
end;
$$;

create trigger m365_invocations_no_update
  before update on m365_capability_invocations
  for each row execute function guard_m365_evidence_immutability();

create trigger m365_invocations_no_delete
  before delete on m365_capability_invocations
  for each row execute function guard_m365_evidence_immutability();

-- ---------------------------------------------------------------------------
-- Events (n8n contract, same emit_event spine as 0009/0011/0013/0014/0015).
-- ---------------------------------------------------------------------------

create or replace function emit_m365_notification_events() returns trigger
language plpgsql as $$
begin
  if new.accepted then
    perform emit_event('m365.notification.accepted', 'm365_notification', new.id, new.org_id,
      jsonb_build_object(
        'subscription_id', new.subscription_id,
        'delivery_key', new.delivery_key,
        'execution_id', new.execution_id,
        'change_type', new.change_type));
  else
    perform emit_event('m365.notification.rejected', 'm365_notification', new.id, new.org_id,
      jsonb_build_object(
        'subscription_id', new.subscription_id,
        'rejection_reason', new.rejection_reason,
        'detail', new.detail));
  end if;
  return new;
end;
$$;

create trigger m365_notifications_events
  after insert on m365_notifications
  for each row execute function emit_m365_notification_events();

create or replace function emit_m365_invocation_events() returns trigger
language plpgsql as $$
begin
  if new.outcome = 'denied' then
    perform emit_event('m365.capability.denied', 'm365_capability_invocation', new.id, new.org_id,
      jsonb_build_object(
        'capability', new.capability,
        'denial_reason', new.denial_reason,
        'execution_id', new.execution_id,
        'target_resource', new.target_resource));
  elsif new.outcome = 'failed' then
    perform emit_event('m365.capability.failed', 'm365_capability_invocation', new.id, new.org_id,
      jsonb_build_object(
        'capability', new.capability,
        'failure_reason', new.failure_reason,
        'execution_id', new.execution_id,
        'attempts', new.attempts));
  else
    perform emit_event('m365.capability.invoked', 'm365_capability_invocation', new.id, new.org_id,
      jsonb_build_object(
        'capability', new.capability,
        'outcome', new.outcome,
        'execution_id', new.execution_id,
        'microsoft_resource_ids', new.microsoft_resource_ids,
        'fidelity', new.fidelity));
  end if;
  return new;
end;
$$;

create trigger m365_invocations_events
  after insert on m365_capability_invocations
  for each row execute function emit_m365_invocation_events();

-- ---------------------------------------------------------------------------
-- updated_at maintenance. Defined here rather than reused: the shared
-- set_updated_at() was an orphan and was dropped in 0012, and each slice since
-- has kept its own (0011, 0015). Following that, not resurrecting the orphan.
-- ---------------------------------------------------------------------------

create or replace function touch_m365_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger m365_subscriptions_touch
  before update on m365_subscriptions
  for each row execute function touch_m365_updated_at();

create trigger m365_executions_touch
  before update on m365_executions
  for each row execute function touch_m365_updated_at();
