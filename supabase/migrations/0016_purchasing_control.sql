-- ---------------------------------------------------------------------------
-- 0016_purchasing_control.sql — the Purchasing Control Center (Lippolis).
--
-- Requests from the field -> workshop review (stock, vendor, cost, quantity) ->
-- approval -> a controlled PO number -> the PO document -> a vendor email DRAFT
-- -> ordering, tracking, partial receiving -> completion. Every step audited.
--
-- THIS MIGRATION CONTAINS NO SEND CAPABILITY. Nothing here reaches Microsoft
-- Graph, SMTP, n8n or any network. `mark_purchase_email_sent()` records that a
-- HUMAN copied an approved draft into their own mail client — a ledger entry,
-- not a transmission. Same locked decision as 0015: zero auto-sends in v1.
--
-- Additive only; touches nothing in 0001-0015. It follows the idioms those
-- migrations established, deliberately and in the same order:
--   * org_id FK + RLS on every table, `current_org_id()` / `current_role_is()`
--   * security-definer RPCs as the ONLY write path for state changes, so the
--     transition guard, the authorization check and the audit event cannot be
--     bypassed by a direct table write from a client session
--   * a closed transition graph enforced by a BEFORE UPDATE trigger
--   * emit_event() for the n8n contract (0009/0011/0013/0014/0015 spine)
--   * idempotency by unique key (23505 = "already recorded")
--   * guard_no_delete() — business records are append-only
--   * fail closed: an unconfigured approver, an unapproved request, an
--     unreviewed email draft all BLOCK rather than default to permissive
--
-- PARITY WITH THE PILOT: apps/purchasing runs the same data model on SQLite so
-- the shop can pilot it with no credentials (apps/purchasing/src/server/db.ts).
-- scripts/lib/validate-migration-0016.mjs asserts the table names, the status
-- vocabulary, the role/permission matrix and the transition graph here match
-- the TypeScript/JS modules the app ships. The only deliberate difference is
-- storage of numbers:
--
--     pilot (SQLite)                 production (Postgres)
--     *_cents  integer               *          numeric(12,2)
--     *_qty    integer thousandths   *_qty      numeric(14,3)
--
-- Both are exact; neither is floating point. The app converts at the edge.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Enums — the vocabularies, closed.
-- ---------------------------------------------------------------------------

create type purchase_request_status as enum (
  'DRAFT', 'SUBMITTED', 'PENDING_WORKSHOP_REVIEW', 'CLARIFICATION_REQUESTED',
  'RESUBMITTED', 'REJECTED', 'APPROVED', 'PO_GENERATED', 'EMAIL_DRAFTED',
  'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'COMPLETED', 'CANCELLED'
);

-- The purchasing roles. `users.role` (0001) still holds worker/foreman/admin;
-- these are the purchasing responsibilities, held in a join table, exactly the
-- Phase 5 `user_roles` shape STAKEHOLDERS asked for.
create type purchasing_role as enum ('REQUESTOR', 'OFFICE', 'WORKSHOP_APPROVER', 'ADMIN');

create type purchase_decision as enum ('APPROVED', 'REJECTED', 'CLARIFICATION_REQUESTED');

create type purchase_delivery_method as enum ('DELIVERY', 'PICKUP');

create type purchase_location_kind as enum ('JOBSITE', 'WORKSHOP', 'OFFICE', 'VENDOR_PICKUP');

create type purchase_email_template as enum (
  'APPROVAL_REQUEST', 'VENDOR_PURCHASE_ORDER', 'CLARIFICATION_REQUEST',
  'REJECTION_NOTICE', 'ORDER_FOLLOW_UP', 'MATERIAL_READY_NOTICE'
);

create type purchase_email_status as enum (
  'GENERATED', 'REVIEWED', 'APPROVED_TO_SEND', 'SENT', 'CANCELLED', 'FAILED'
);

create type inventory_adjustment_reason as enum (
  'STOCK_APPLIED', 'RECEIVED', 'REPLENISHMENT', 'CORRECTION', 'DAMAGE'
);

-- ---------------------------------------------------------------------------
-- Roles and permissions, as DATA (same discipline as 0015's message_policies:
-- a permission change is a row, never a rebuild). The seeded rows are the exact
-- contents of ROLE_PERMISSIONS in apps/purchasing/src/domain/roles.mjs, and the
-- offline validator asserts they stay identical.
-- ---------------------------------------------------------------------------

create table purchasing_user_roles (
  user_id    uuid not null references users(id) on delete cascade,
  role       purchasing_role not null,
  granted_at timestamptz not null default now(),
  granted_by uuid references users(id),
  primary key (user_id, role)
);

create index purchasing_user_roles_role_idx on purchasing_user_roles(role);

alter table purchasing_user_roles enable row level security;

create policy purchasing_user_roles_read on purchasing_user_roles
  for select using (
    exists (select 1 from users u where u.id = user_id and u.org_id = current_org_id())
  );

create policy purchasing_user_roles_admin_write on purchasing_user_roles
  for all using (
    current_role_is('admin')
    and exists (select 1 from users u where u.id = user_id and u.org_id = current_org_id())
  );

-- The approval GRANT: separate from the role, because "office users cannot
-- approve unless separately granted approval authority" is a grant, not a role.
alter table users
  add column purchasing_can_approve boolean not null default false,
  add column purchasing_is_primary_approver boolean not null default false,
  add column purchasing_is_backup_approver boolean not null default false;

create table purchasing_role_permissions (
  role       purchasing_role not null,
  permission text not null,
  primary key (role, permission)
);

alter table purchasing_role_permissions enable row level security;
create policy purchasing_role_permissions_read on purchasing_role_permissions
  for select using (auth.uid() is not null);

-- Permissions the approval GRANT adds on top of whatever role a user holds.
create table purchasing_grant_permissions (
  permission text primary key
);

alter table purchasing_grant_permissions enable row level security;
create policy purchasing_grant_permissions_read on purchasing_grant_permissions
  for select using (auth.uid() is not null);

insert into purchasing_role_permissions (role, permission) values
  ('REQUESTOR', 'request.create'),
  ('REQUESTOR', 'request.read.own'),
  ('REQUESTOR', 'request.update.own'),
  ('REQUESTOR', 'request.submit'),
  ('REQUESTOR', 'request.cancel.own'),
  ('REQUESTOR', 'request.respond_clarification'),
  ('REQUESTOR', 'request.attach'),
  ('REQUESTOR', 'request.note'),

  ('OFFICE', 'request.create'),
  ('OFFICE', 'request.read.own'),
  ('OFFICE', 'request.read.all'),
  ('OFFICE', 'request.update.own'),
  ('OFFICE', 'request.submit'),
  ('OFFICE', 'request.cancel.own'),
  ('OFFICE', 'request.respond_clarification'),
  ('OFFICE', 'request.attach'),
  ('OFFICE', 'request.note'),
  ('OFFICE', 'order.track'),
  ('OFFICE', 'receiving.record'),

  ('WORKSHOP_APPROVER', 'request.create'),
  ('WORKSHOP_APPROVER', 'request.read.own'),
  ('WORKSHOP_APPROVER', 'request.read.all'),
  ('WORKSHOP_APPROVER', 'request.update.own'),
  ('WORKSHOP_APPROVER', 'request.submit'),
  ('WORKSHOP_APPROVER', 'request.cancel.own'),
  ('WORKSHOP_APPROVER', 'request.respond_clarification'),
  ('WORKSHOP_APPROVER', 'request.attach'),
  ('WORKSHOP_APPROVER', 'request.note'),
  ('WORKSHOP_APPROVER', 'order.track'),
  ('WORKSHOP_APPROVER', 'receiving.record'),
  ('WORKSHOP_APPROVER', 'review.read_queue'),
  ('WORKSHOP_APPROVER', 'review.record_stock'),
  ('WORKSHOP_APPROVER', 'review.set_quantities'),
  ('WORKSHOP_APPROVER', 'review.set_vendor'),
  ('WORKSHOP_APPROVER', 'review.set_cost'),
  ('WORKSHOP_APPROVER', 'review.decide'),
  ('WORKSHOP_APPROVER', 'po.generate'),
  ('WORKSHOP_APPROVER', 'email.draft'),
  ('WORKSHOP_APPROVER', 'email.review'),
  ('WORKSHOP_APPROVER', 'order.mark_ordered'),
  ('WORKSHOP_APPROVER', 'inventory.adjust'),
  ('WORKSHOP_APPROVER', 'request.complete'),
  ('WORKSHOP_APPROVER', 'request.cancel.any');

-- ADMIN holds every permission there is; enumerated so a new permission has to
-- be granted deliberately rather than inherited by accident.
insert into purchasing_role_permissions (role, permission)
select 'ADMIN'::purchasing_role, p from (
  select distinct permission as p from purchasing_role_permissions
  union values
    ('admin.users'), ('admin.vendors'), ('admin.templates'), ('admin.po_config'),
    ('admin.locations'), ('admin.settings'), ('admin.audit')
) as all_permissions
on conflict do nothing;

insert into purchasing_grant_permissions (permission) values
  ('review.read_queue'), ('review.record_stock'), ('review.set_quantities'),
  ('review.set_vendor'), ('review.set_cost'), ('review.decide'),
  ('po.generate'), ('email.draft'), ('email.review'), ('order.mark_ordered');

-- ---------------------------------------------------------------------------
-- purchasing_can() — THE authorization decision, in SQL.
--
-- Mirrors authorize() in apps/purchasing/src/domain/roles.mjs. Every RPC below
-- calls it, and the RLS policies call it too, so a client that bypasses the
-- RPCs still cannot read or write what its roles do not carry.
-- ---------------------------------------------------------------------------

create or replace function purchasing_can(p_user uuid, p_permission text)
returns boolean language sql stable security definer as $$
  select exists (
    select 1
      from purchasing_user_roles ur
      join purchasing_role_permissions rp on rp.role = ur.role
     where ur.user_id = p_user and rp.permission = p_permission
  )
  or exists (
    select 1 from users u
      join purchasing_grant_permissions gp on gp.permission = p_permission
     where u.id = p_user and u.purchasing_can_approve and u.is_active
  );
$$;

create or replace function purchasing_is_approver(p_user uuid)
returns boolean language sql stable security definer as $$
  select purchasing_can(p_user, 'review.decide');
$$;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

create table purchase_vendors (
  id             uuid primary key default uuid_generate_v4(),
  org_id         uuid not null references orgs(id) on delete cascade,
  name           text not null,
  account_number text,
  phone          text,
  address        text,
  notes          text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references users(id),
  updated_by     uuid references users(id),
  unique (org_id, name)
);

create table purchase_vendor_contacts (
  id         uuid primary key default uuid_generate_v4(),
  vendor_id  uuid not null references purchase_vendors(id) on delete cascade,
  name       text not null,
  email      text not null,
  phone      text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index purchase_vendor_contacts_primary_uidx
  on purchase_vendor_contacts(vendor_id) where is_primary;

create table purchase_delivery_locations (
  id         uuid primary key default uuid_generate_v4(),
  org_id     uuid not null references orgs(id) on delete cascade,
  name       text not null,
  address    text,
  kind       purchase_location_kind not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

-- ---------------------------------------------------------------------------
-- Requests. The requestor's words live here and are never overwritten by a
-- purchasing decision: everything the workshop decides lives on
-- purchase_review_items, one row per requested line.
-- ---------------------------------------------------------------------------

create table purchase_requests (
  id                     uuid primary key default uuid_generate_v4(),
  org_id                 uuid not null references orgs(id) on delete cascade,
  request_number         text not null,
  -- One request, one job. The multi-job purchase order is explicitly out of
  -- scope for this milestone and this column is why.
  job_number             text not null,
  requestor_id           uuid not null references users(id),
  status                 purchase_request_status not null default 'DRAFT',
  need_by_date           date not null,
  need_by_time           time not null,
  delivery_location_id   uuid not null references purchase_delivery_locations(id),
  delivery_method        purchase_delivery_method not null default 'DELIVERY',
  reason                 text,
  notes                  text,
  submitted_at           timestamptz,
  approver_id            uuid references users(id),
  decided_at             timestamptz,
  decision_notes         text,
  rejection_reason       text,
  clarification_question text,
  clarification_answer   text,
  vendor_id              uuid references purchase_vendors(id),
  estimated_total        numeric(12,2) not null default 0,
  expected_arrival_date  date,
  tracking_number        text,
  tracking_carrier       text,
  ordered_at             timestamptz,
  received_at            timestamptz,
  completed_at           timestamptz,
  cancelled_at           timestamptz,
  cancel_reason          text,
  version                integer not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid not null references users(id),
  updated_by             uuid references users(id),
  unique (org_id, request_number),
  check (estimated_total >= 0),
  -- A rejection names its reason; a cancellation names its reason. Corrections
  -- are a new request, never a silent edit of a decided one.
  constraint purchase_requests_rejected_has_reason
    check (status <> 'REJECTED' or (rejection_reason is not null and length(rejection_reason) > 0)),
  constraint purchase_requests_cancelled_has_reason
    check (status <> 'CANCELLED' or (cancel_reason is not null and length(cancel_reason) > 0)),
  constraint purchase_requests_clarification_has_question
    check (status <> 'CLARIFICATION_REQUESTED' or clarification_question is not null),
  constraint purchase_requests_decision_names_approver
    check (status not in ('APPROVED', 'REJECTED') or (approver_id is not null and decided_at is not null))
);

create index purchase_requests_org_status_idx on purchase_requests(org_id, status);
create index purchase_requests_org_requestor_idx on purchase_requests(org_id, requestor_id);
create index purchase_requests_org_job_idx on purchase_requests(org_id, job_number);
create index purchase_requests_need_by_idx on purchase_requests(org_id, need_by_date);

create table purchase_request_items (
  id            uuid primary key default uuid_generate_v4(),
  request_id    uuid not null references purchase_requests(id) on delete cascade,
  line_no       integer not null,
  description   text not null,
  requested_qty numeric(14,3) not null,
  unit          text not null,
  stock_number  text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid not null references users(id),
  unique (request_id, line_no),
  check (requested_qty > 0)
);

create table purchase_request_attachments (
  id           uuid primary key default uuid_generate_v4(),
  request_id   uuid not null references purchase_requests(id) on delete cascade,
  filename     text not null,
  content_type text,
  byte_size    bigint,
  -- Files live in Supabase Storage (0005 idiom); this is the object path.
  storage_path text not null,
  caption      text,
  created_at   timestamptz not null default now(),
  created_by   uuid not null references users(id)
);

-- ---------------------------------------------------------------------------
-- Workshop review. Six quantities, none of which may overwrite another.
-- ---------------------------------------------------------------------------

create table purchase_reviews (
  id             uuid primary key default uuid_generate_v4(),
  request_id     uuid not null references purchase_requests(id) on delete cascade,
  reviewer_id    uuid not null references users(id),
  workshop_notes text,
  started_at     timestamptz not null default now(),
  saved_at       timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (request_id)
);

create table purchase_review_items (
  id                      uuid primary key default uuid_generate_v4(),
  review_id               uuid not null references purchase_reviews(id) on delete cascade,
  request_item_id         uuid not null references purchase_request_items(id),
  usable_stock_qty        numeric(14,3) not null default 0,
  approved_qty            numeric(14,3) not null default 0,
  suggested_order_qty     numeric(14,3) not null default 0,
  final_order_qty         numeric(14,3) not null default 0,
  stock_applied_qty       numeric(14,3) not null default 0,
  replenishment_qty       numeric(14,3) not null default 0,
  vendor_id               uuid references purchase_vendors(id),
  estimated_unit_cost     numeric(12,2),
  estimated_line_total    numeric(12,2) not null default 0,
  substitute_description  text,
  expected_arrival_date   date,
  line_notes              text,
  override_reason         text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  updated_by              uuid references users(id),
  unique (review_id, request_item_id),
  check (usable_stock_qty >= 0),
  check (approved_qty >= 0),
  -- The suggestion is a calculation, and it can never be negative: a workshop
  -- with more stock than the job needs suggests ordering nothing, not a credit.
  check (suggested_order_qty >= 0),
  check (final_order_qty >= 0),
  check (estimated_unit_cost is null or estimated_unit_cost >= 0),
  check (estimated_line_total >= 0)
);

-- The suggestion is derived, so the database derives it. A writer cannot store
-- a "suggested" quantity that is not approved - stock.
create or replace function purchase_review_item_derivations() returns trigger
language plpgsql as $$
begin
  new.suggested_order_qty := greatest(0, new.approved_qty - new.usable_stock_qty);
  new.stock_applied_qty   := greatest(0, least(new.approved_qty, new.usable_stock_qty));
  new.replenishment_qty   := greatest(0, new.final_order_qty - new.suggested_order_qty);
  new.estimated_line_total := round(coalesce(new.estimated_unit_cost, 0) * new.final_order_qty, 2);
  -- An override must say why: "why did we buy 18 when we needed 14" is a
  -- question the data should answer without anyone having to remember.
  if new.final_order_qty <> new.suggested_order_qty and new.override_reason is null then
    new.override_reason := 'workshop override';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger purchase_review_items_derivations
  before insert or update on purchase_review_items
  for each row execute function purchase_review_item_derivations();

create table purchase_approvals (
  id           uuid primary key default uuid_generate_v4(),
  request_id   uuid not null references purchase_requests(id) on delete cascade,
  approver_id  uuid not null references users(id),
  decision     purchase_decision not null,
  decided_at   timestamptz not null default now(),
  notes        text,
  reason       text,
  -- What the workshop changed relative to the original request, frozen at the
  -- moment of decision: the approval refers to THESE numbers.
  changes      jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  constraint purchase_approvals_non_approval_has_reason
    check (decision = 'APPROVED' or (reason is not null and length(reason) > 0))
);

create index purchase_approvals_request_idx on purchase_approvals(request_id);

-- ---------------------------------------------------------------------------
-- PO numbering. A database-controlled sequence under a row lock — never a
-- frontend counter, and never nextval() (a rolled-back transaction would burn
-- a number a vendor was told to expect).
-- ---------------------------------------------------------------------------

create table po_number_sequences (
  org_id     uuid primary key references orgs(id) on delete cascade,
  prefix     text not null default 'LE-',
  padding    integer not null default 5,
  suffix     text not null default '',
  next_value bigint not null default 52901,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id),
  check (padding between 1 and 12),
  check (next_value > 0)
);

create table request_number_sequences (
  org_id     uuid primary key references orgs(id) on delete cascade,
  prefix     text not null default 'PR-',
  padding    integer not null default 5,
  suffix     text not null default '',
  next_value bigint not null default 1001,
  updated_at timestamptz not null default now(),
  check (next_value > 0)
);

-- A sequence may only move FORWARD. Winding it back would re-issue numbers that
-- vendors and invoices already reference.
create or replace function guard_po_sequence_forward() returns trigger
language plpgsql as $$
begin
  if new.next_value < old.next_value then
    raise exception 'a PO sequence can only move forward (% -> %); issued numbers are permanent',
      old.next_value, new.next_value;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger po_number_sequences_forward_only
  before update on po_number_sequences
  for each row execute function guard_po_sequence_forward();

/**
 * next_po_number() — allocate the next number for an org.
 *
 * `for update` takes the row lock, so two approvers pressing Approve in the
 * same second serialize here rather than racing. It must be called INSIDE the
 * transaction that writes the purchase_orders row: the bump and the row that
 * consumes it commit together or not at all.
 */
create or replace function next_po_number(p_org uuid)
returns table (po_number text, sequence_value bigint)
language plpgsql security definer as $$
declare
  s po_number_sequences%rowtype;
begin
  select * into s from po_number_sequences where org_id = p_org for update;
  if s.org_id is null then
    raise exception 'no PO number sequence configured for org %', p_org;
  end if;
  update po_number_sequences set next_value = s.next_value + 1 where org_id = p_org;
  po_number := s.prefix || lpad(s.next_value::text, s.padding, '0') || s.suffix;
  sequence_value := s.next_value;
  return next;
end $$;

create or replace function next_request_number(p_org uuid)
returns text language plpgsql security definer as $$
declare
  s request_number_sequences%rowtype;
begin
  select * into s from request_number_sequences where org_id = p_org for update;
  if s.org_id is null then
    raise exception 'no request number sequence configured for org %', p_org;
  end if;
  update request_number_sequences set next_value = s.next_value + 1 where org_id = p_org;
  return s.prefix || lpad(s.next_value::text, s.padding, '0') || s.suffix;
end $$;

create table purchase_orders (
  id                   uuid primary key default uuid_generate_v4(),
  org_id               uuid not null references orgs(id) on delete cascade,
  request_id           uuid not null references purchase_requests(id),
  po_number            text not null,
  sequence_value       bigint not null,
  vendor_id            uuid not null references purchase_vendors(id),
  vendor_contact_id    uuid references purchase_vendor_contacts(id),
  job_number           text not null,
  approver_id          uuid not null references users(id),
  delivery_location_id uuid not null references purchase_delivery_locations(id),
  delivery_method      purchase_delivery_method not null,
  need_by_date         date not null,
  need_by_time         time not null,
  estimated_total      numeric(12,2) not null default 0,
  notes                text,
  status               text not null default 'ISSUED',
  generated_at         timestamptz not null default now(),
  generated_by         uuid not null references users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, po_number),
  unique (org_id, sequence_value),
  -- One purchase order per request in this milestone. Splitting a request
  -- across vendors is a designed extension point, not an accident.
  unique (request_id),
  check (estimated_total >= 0)
);

-- The PO number is permanent. Not "should not change" — cannot.
create or replace function guard_po_number_permanent() returns trigger
language plpgsql as $$
begin
  if new.po_number is distinct from old.po_number
     or new.sequence_value is distinct from old.sequence_value
     or new.request_id is distinct from old.request_id then
    raise exception 'the purchase order number is permanent (PO %)', old.po_number;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger purchase_orders_permanent_number
  before update on purchase_orders
  for each row execute function guard_po_number_permanent();

create table purchase_order_items (
  id                     uuid primary key default uuid_generate_v4(),
  purchase_order_id      uuid not null references purchase_orders(id) on delete cascade,
  line_no                integer not null,
  request_item_id        uuid not null references purchase_request_items(id),
  description            text not null,
  substitute_description text,
  order_qty              numeric(14,3) not null,
  unit                   text not null,
  unit_cost              numeric(12,2) not null default 0,
  line_total             numeric(12,2) not null default 0,
  expected_arrival_date  date,
  created_at             timestamptz not null default now(),
  unique (purchase_order_id, line_no),
  check (order_qty > 0),
  check (unit_cost >= 0)
);

create table purchase_order_documents (
  id                uuid primary key default uuid_generate_v4(),
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  kind              text not null check (kind in ('PDF', 'HTML')),
  filename          text not null,
  content_type      text not null,
  byte_size         bigint not null,
  storage_path      text not null,
  sha256            text not null,
  generated_at      timestamptz not null default now(),
  generated_by      uuid not null references users(id),
  template_key      text not null
);

-- ---------------------------------------------------------------------------
-- Email drafts. Draft-only: there is no transport in this schema.
-- ---------------------------------------------------------------------------

create table purchase_email_templates (
  id           uuid primary key default uuid_generate_v4(),
  org_id       uuid not null references orgs(id) on delete cascade,
  template_key purchase_email_template not null,
  subject      text not null,
  body         text not null,
  is_active    boolean not null default true,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references users(id),
  unique (org_id, template_key)
);

create table purchase_email_drafts (
  id                    uuid primary key default uuid_generate_v4(),
  org_id                uuid not null references orgs(id) on delete cascade,
  request_id            uuid not null references purchase_requests(id) on delete cascade,
  purchase_order_id     uuid references purchase_orders(id),
  template_key          purchase_email_template not null,
  status                purchase_email_status not null default 'GENERATED',
  subject               text not null,
  body                  text not null,
  to_addrs              text[] not null default '{}',
  cc_addrs              text[] not null default '{}',
  attachments           jsonb not null default '[]'::jsonb,
  draft_key             text not null,
  generated_at          timestamptz not null default now(),
  generated_by          uuid not null references users(id),
  reviewed_at           timestamptz,
  reviewed_by           uuid references users(id),
  approved_to_send_at   timestamptz,
  approved_to_send_by   uuid references users(id),
  sent_at               timestamptz,
  sent_marked_by        uuid references users(id),
  cancelled_at          timestamptz,
  failure_reason        text,
  -- Proof in the row itself that no transport was involved. The CHECK makes
  -- `true` unstorable: enabling sending is a migration, reviewed by a human,
  -- not a config flag someone flips at 4pm.
  external_send_enabled boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, draft_key),
  constraint purchase_email_no_external_send check (external_send_enabled = false),
  -- A vendor purchase-order email cannot exist without a purchase order.
  constraint purchase_email_vendor_needs_po
    check (template_key <> 'VENDOR_PURCHASE_ORDER' or purchase_order_id is not null),
  -- THE send gate: `sent` is unreachable without a recorded human review and a
  -- human who marked it sent.
  constraint purchase_email_sent_requires_review
    check (status <> 'SENT' or (reviewed_at is not null and reviewed_by is not null
                                and sent_at is not null and sent_marked_by is not null)),
  constraint purchase_email_sent_at_requires_review
    check (sent_at is null or reviewed_at is not null),
  constraint purchase_email_failed_has_reason
    check (status <> 'FAILED' or failure_reason is not null)
);

create index purchase_email_drafts_request_idx on purchase_email_drafts(request_id);
create index purchase_email_drafts_org_status_idx on purchase_email_drafts(org_id, status);

-- Draft transitions are closed, and the words freeze the moment a human reviews
-- them: you approve WHAT YOU READ.
create or replace function guard_purchase_email_transition() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not (
         (old.status = 'GENERATED'        and new.status in ('REVIEWED','CANCELLED','FAILED'))
      or (old.status = 'REVIEWED'         and new.status in ('APPROVED_TO_SEND','CANCELLED','FAILED'))
      or (old.status = 'APPROVED_TO_SEND' and new.status in ('SENT','CANCELLED','FAILED'))
    ) then
      raise exception 'illegal email draft transition % -> % (draft %)', old.status, new.status, old.id;
    end if;
  end if;

  if old.status <> 'GENERATED' then
    if new.subject is distinct from old.subject
       or new.body is distinct from old.body
       or new.to_addrs is distinct from old.to_addrs
       or new.cc_addrs is distinct from old.cc_addrs
       or new.attachments is distinct from old.attachments then
      raise exception 'a reviewed email draft is frozen (draft %)', old.id;
    end if;
  end if;

  new.updated_at := now();
  return new;
end $$;

create trigger purchase_email_drafts_transition_guard
  before update on purchase_email_drafts
  for each row execute function guard_purchase_email_transition();

-- ---------------------------------------------------------------------------
-- Receiving. Nothing assumes the whole order arrived at once.
-- ---------------------------------------------------------------------------

create table purchase_receipts (
  id                  uuid primary key default uuid_generate_v4(),
  org_id              uuid not null references orgs(id) on delete cascade,
  request_id          uuid not null references purchase_requests(id) on delete cascade,
  purchase_order_id   uuid references purchase_orders(id),
  received_date       date not null,
  received_by         uuid not null references users(id),
  packing_slip_number text,
  notes               text,
  is_final            boolean not null default false,
  created_at          timestamptz not null default now()
);

create index purchase_receipts_request_idx on purchase_receipts(request_id);

create table purchase_receipt_items (
  id                     uuid primary key default uuid_generate_v4(),
  receipt_id             uuid not null references purchase_receipts(id) on delete cascade,
  purchase_order_item_id uuid not null references purchase_order_items(id),
  received_qty           numeric(14,3) not null default 0,
  damaged_qty            numeric(14,3) not null default 0,
  backordered_qty        numeric(14,3) not null default 0,
  written_off_qty        numeric(14,3) not null default 0,
  over_receipt_override  boolean not null default false,
  override_reason        text,
  notes                  text,
  created_at             timestamptz not null default now(),
  check (received_qty >= 0 and damaged_qty >= 0 and backordered_qty >= 0 and written_off_qty >= 0),
  -- Accepting more than was ordered is a decision a human makes on the record.
  constraint purchase_receipt_override_has_reason
    check (over_receipt_override = false or (override_reason is not null and length(override_reason) > 0))
);

create table purchase_receipt_attachments (
  id           uuid primary key default uuid_generate_v4(),
  receipt_id   uuid not null references purchase_receipts(id) on delete cascade,
  filename     text not null,
  content_type text,
  byte_size    bigint,
  storage_path text not null,
  caption      text,
  created_at   timestamptz not null default now(),
  created_by   uuid not null references users(id)
);

/**
 * Over-receipt guard. Refuses more than was ordered unless the line carries an
 * explicit override, and refuses an obvious data-entry error even then
 * (2x the ordered quantity is a typo, not a delivery).
 */
create or replace function guard_receipt_quantities() returns trigger
language plpgsql as $$
declare
  v_ordered numeric(14,3);
  v_already numeric(14,3);
begin
  select order_qty into v_ordered from purchase_order_items where id = new.purchase_order_item_id;
  select coalesce(sum(received_qty + damaged_qty + written_off_qty), 0) into v_already
    from purchase_receipt_items
   where purchase_order_item_id = new.purchase_order_item_id
     and id is distinct from new.id;

  if v_already + new.received_qty > v_ordered and not new.over_receipt_override then
    raise exception 'receiving % against an order of % needs an explicit over-receipt override',
      v_already + new.received_qty, v_ordered;
  end if;
  if v_already + new.received_qty > v_ordered * 2 then
    raise exception 'received quantity % is more than twice the ordered quantity %; correct the entry',
      v_already + new.received_qty, v_ordered;
  end if;
  return new;
end $$;

create trigger purchase_receipt_items_quantity_guard
  before insert or update on purchase_receipt_items
  for each row execute function guard_receipt_quantities();

-- ---------------------------------------------------------------------------
-- Inventory. Observation-grade, not a warehouse system — but every movement is
-- a row, because inventory that changes silently is inventory nobody trusts.
-- ---------------------------------------------------------------------------

create table inventory_observations (
  id               uuid primary key default uuid_generate_v4(),
  org_id           uuid not null references orgs(id) on delete cascade,
  request_id       uuid references purchase_requests(id) on delete cascade,
  request_item_id  uuid references purchase_request_items(id),
  item_description text not null,
  observed_qty     numeric(14,3) not null,
  unit             text not null,
  observed_at      timestamptz not null default now(),
  observed_by      uuid not null references users(id),
  notes            text,
  created_at       timestamptz not null default now(),
  check (observed_qty >= 0)
);

create table inventory_adjustments (
  id               uuid primary key default uuid_generate_v4(),
  org_id           uuid not null references orgs(id) on delete cascade,
  request_id       uuid references purchase_requests(id) on delete cascade,
  request_item_id  uuid references purchase_request_items(id),
  item_description text not null,
  -- Signed: negative = consumed by the job, positive = received into stock.
  delta_qty        numeric(14,3) not null,
  unit             text not null,
  reason           inventory_adjustment_reason not null,
  adjusted_at      timestamptz not null default now(),
  adjusted_by      uuid not null references users(id),
  notes            text,
  created_at       timestamptz not null default now(),
  check (delta_qty <> 0)
);

-- ---------------------------------------------------------------------------
-- Audit, notifications, settings
-- ---------------------------------------------------------------------------

create table purchase_activity_log (
  id              uuid primary key default uuid_generate_v4(),
  org_id          uuid not null references orgs(id) on delete cascade,
  -- Correlation id: every row touching one request carries the request id.
  request_id      uuid references purchase_requests(id) on delete cascade,
  actor_id        uuid references users(id),
  actor_name      text,
  action          text not null,
  entity_type     text not null,
  entity_id       uuid,
  previous_values jsonb,
  new_values      jsonb,
  notes           text,
  at              timestamptz not null default now(),
  seq             bigint not null
);

create index purchase_activity_request_idx on purchase_activity_log(request_id, at, seq);
create index purchase_activity_org_idx on purchase_activity_log(org_id, at desc);

create table purchase_notifications (
  id           uuid primary key default uuid_generate_v4(),
  org_id       uuid not null references orgs(id) on delete cascade,
  request_id   uuid references purchase_requests(id) on delete cascade,
  event        text not null,
  recipient_id uuid references users(id),
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);

create index purchase_notifications_recipient_idx
  on purchase_notifications(recipient_id, read_at);

create table purchasing_settings (
  org_id                  uuid primary key references orgs(id) on delete cascade,
  allow_self_approval     boolean not null default false,
  external_send_enabled   boolean not null default false,
  require_email_review    boolean not null default true,
  overdue_grace_hours     integer not null default 0,
  default_delivery_method purchase_delivery_method not null default 'DELIVERY',
  po_template_key         text not null default 'lippolis_default',
  updated_at              timestamptz not null default now(),
  updated_by              uuid references users(id),
  -- Both of these are structural, not preferences: v1 has no send path and no
  -- unreviewed-send path, and the schema says so.
  constraint purchasing_settings_no_external_send check (external_send_enabled = false),
  constraint purchasing_settings_review_required check (require_email_review = true)
);

-- ---------------------------------------------------------------------------
-- The request transition guard. The closed graph from
-- apps/purchasing/src/domain/status.mjs, enforced by the database.
-- ---------------------------------------------------------------------------

create or replace function guard_purchase_request_transition() returns trigger
language plpgsql as $$
declare
  v_has_review        boolean;
  v_has_po            boolean;
  v_has_reviewed_mail boolean;
  v_has_receipt       boolean;
  v_outstanding       integer;
begin
  if new.status is distinct from old.status then
    if not (
         (old.status = 'DRAFT'                   and new.status in ('SUBMITTED','CANCELLED'))
      or (old.status = 'SUBMITTED'               and new.status in ('PENDING_WORKSHOP_REVIEW','CANCELLED'))
      or (old.status = 'PENDING_WORKSHOP_REVIEW' and new.status in ('CLARIFICATION_REQUESTED','APPROVED','REJECTED','CANCELLED'))
      or (old.status = 'CLARIFICATION_REQUESTED' and new.status in ('RESUBMITTED','CANCELLED'))
      or (old.status = 'RESUBMITTED'             and new.status in ('PENDING_WORKSHOP_REVIEW','CANCELLED'))
      or (old.status = 'APPROVED'                and new.status in ('PO_GENERATED','CANCELLED'))
      or (old.status = 'PO_GENERATED'            and new.status in ('EMAIL_DRAFTED','CANCELLED'))
      or (old.status = 'EMAIL_DRAFTED'           and new.status in ('ORDERED','CANCELLED'))
      or (old.status = 'ORDERED'                 and new.status in ('PARTIALLY_RECEIVED','RECEIVED','CANCELLED'))
      or (old.status = 'PARTIALLY_RECEIVED'      and new.status in ('PARTIALLY_RECEIVED','RECEIVED','CANCELLED'))
      or (old.status = 'RECEIVED'                and new.status in ('COMPLETED','CANCELLED'))
    ) then
      raise exception 'illegal purchase request transition % -> % (request %)',
        old.status, new.status, old.id;
    end if;

    -- Content preconditions — the same ones transitionGuard() applies.
    if new.status = 'APPROVED' then
      select saved_at is not null into v_has_review from purchase_reviews where request_id = old.id;
      if not coalesce(v_has_review, false) then
        raise exception 'approval requires a completed workshop review (request %)', old.id;
      end if;
    end if;

    if new.status = 'PO_GENERATED' then
      select exists (select 1 from purchase_orders where request_id = old.id) into v_has_po;
      if not v_has_po then
        raise exception 'PO_GENERATED requires a purchase order row (request %)', old.id;
      end if;
    end if;

    if new.status = 'EMAIL_DRAFTED' then
      select exists (
        select 1 from purchase_email_drafts
         where request_id = old.id and template_key = 'VENDOR_PURCHASE_ORDER'
      ) into v_has_reviewed_mail;
      if not v_has_reviewed_mail then
        raise exception 'a vendor email draft must exist before EMAIL_DRAFTED (request %)', old.id;
      end if;
    end if;

    if new.status = 'ORDERED' then
      select exists (
        select 1 from purchase_email_drafts
         where request_id = old.id and template_key = 'VENDOR_PURCHASE_ORDER'
           and reviewed_at is not null
      ) into v_has_reviewed_mail;
      if not v_has_reviewed_mail then
        raise exception 'the vendor email draft must be reviewed by a human before the order is placed (request %)', old.id;
      end if;
    end if;

    if new.status in ('PARTIALLY_RECEIVED', 'RECEIVED') then
      select exists (select 1 from purchase_receipts where request_id = old.id) into v_has_receipt;
      if not v_has_receipt then
        raise exception 'receiving requires a recorded receipt (request %)', old.id;
      end if;
    end if;

    if new.status in ('RECEIVED', 'COMPLETED') then
      select count(*) into v_outstanding
        from purchase_order_items oi
        join purchase_orders po on po.id = oi.purchase_order_id
       where po.request_id = old.id
         and oi.order_qty > coalesce((
               select sum(ri.received_qty + ri.damaged_qty + ri.written_off_qty)
                 from purchase_receipt_items ri
                where ri.purchase_order_item_id = oi.id), 0);
      if v_outstanding > 0 then
        raise exception '% line(s) are not fully resolved (request %)', v_outstanding, old.id;
      end if;
    end if;
  end if;

  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;

create trigger purchase_requests_transition_guard
  before update on purchase_requests
  for each row execute function guard_purchase_request_transition();

-- The requestor's submitted numbers are immutable once the workshop owns the
-- request. Section A of the approval screen is a promise, and this keeps it.
create or replace function guard_request_item_immutability() returns trigger
language plpgsql as $$
declare
  v_status purchase_request_status;
begin
  select status into v_status from purchase_requests where id = coalesce(new.request_id, old.request_id);
  if v_status not in ('DRAFT', 'CLARIFICATION_REQUESTED') then
    raise exception 'the original request is read-only once the workshop owns it (status %)', v_status;
  end if;
  return coalesce(new, old);
end $$;

create trigger purchase_request_items_immutability
  before insert or update or delete on purchase_request_items
  for each row execute function guard_request_item_immutability();

-- ---------------------------------------------------------------------------
-- No hard deletes of business records (universal rule 1).
-- ---------------------------------------------------------------------------

create trigger purchase_requests_no_delete
  before delete on purchase_requests for each row execute function guard_no_delete();
create trigger purchase_orders_no_delete
  before delete on purchase_orders for each row execute function guard_no_delete();
create trigger purchase_approvals_no_delete
  before delete on purchase_approvals for each row execute function guard_no_delete();
create trigger purchase_email_drafts_no_delete
  before delete on purchase_email_drafts for each row execute function guard_no_delete();
create trigger purchase_receipts_no_delete
  before delete on purchase_receipts for each row execute function guard_no_delete();
create trigger purchase_activity_log_no_delete
  before delete on purchase_activity_log for each row execute function guard_no_delete();
create trigger inventory_adjustments_no_delete
  before delete on inventory_adjustments for each row execute function guard_no_delete();

-- ---------------------------------------------------------------------------
-- Events (the n8n contract — same emit_event spine as 0009/0011/0013/0014/0015).
-- ---------------------------------------------------------------------------

create or replace function emit_purchase_request_events() returns trigger
language plpgsql security definer as $$
begin
  if tg_op = 'INSERT' then
    perform emit_event('purchase_request.created', 'purchase_request', new.id, new.org_id,
      jsonb_build_object('request_number', new.request_number, 'job_number', new.job_number,
                         'requestor_id', new.requestor_id, 'need_by_date', new.need_by_date));
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'PENDING_WORKSHOP_REVIEW' then
      perform emit_event('purchase_request.awaiting_review', 'purchase_request', new.id, new.org_id,
        jsonb_build_object('request_number', new.request_number, 'job_number', new.job_number,
                           'need_by_date', new.need_by_date, 'need_by_time', new.need_by_time));
    elsif new.status = 'CLARIFICATION_REQUESTED' then
      perform emit_event('purchase_request.clarification_requested', 'purchase_request', new.id, new.org_id,
        jsonb_build_object('question', new.clarification_question, 'requestor_id', new.requestor_id));
    elsif new.status = 'APPROVED' then
      perform emit_event('purchase_request.approved', 'purchase_request', new.id, new.org_id,
        jsonb_build_object('approver_id', new.approver_id, 'estimated_total', new.estimated_total));
    elsif new.status = 'REJECTED' then
      perform emit_event('purchase_request.rejected', 'purchase_request', new.id, new.org_id,
        jsonb_build_object('approver_id', new.approver_id, 'reason', new.rejection_reason));
    elsif new.status = 'PARTIALLY_RECEIVED' then
      perform emit_event('purchase_receipt.partial', 'purchase_request', new.id, new.org_id,
        jsonb_build_object('request_number', new.request_number));
    elsif new.status = 'RECEIVED' then
      perform emit_event('purchase_receipt.completed', 'purchase_request', new.id, new.org_id,
        jsonb_build_object('request_number', new.request_number));
      perform emit_event('purchase_material.ready_for_pickup', 'purchase_request', new.id, new.org_id,
        jsonb_build_object('requestor_id', new.requestor_id, 'location', new.delivery_location_id));
    end if;
  end if;
  return new;
end $$;

create trigger purchase_requests_events
  after insert or update on purchase_requests
  for each row execute function emit_purchase_request_events();

create or replace function emit_purchase_order_events() returns trigger
language plpgsql security definer as $$
begin
  perform emit_event('purchase_order.generated', 'purchase_order', new.id, new.org_id,
    jsonb_build_object('po_number', new.po_number, 'request_id', new.request_id,
                       'vendor_id', new.vendor_id, 'estimated_total', new.estimated_total));
  return new;
end $$;

create trigger purchase_orders_events
  after insert on purchase_orders
  for each row execute function emit_purchase_order_events();

create or replace function emit_purchase_email_events() returns trigger
language plpgsql security definer as $$
begin
  if tg_op = 'INSERT' then
    perform emit_event('purchase_email.draft_ready', 'purchase_email_draft', new.id, new.org_id,
      jsonb_build_object('template_key', new.template_key, 'request_id', new.request_id,
                         'purchase_order_id', new.purchase_order_id, 'to_addrs', new.to_addrs));
  elsif new.status is distinct from old.status and new.status = 'SENT' then
    perform emit_event('purchase_email.marked_sent', 'purchase_email_draft', new.id, new.org_id,
      jsonb_build_object('template_key', new.template_key, 'sent_marked_by', new.sent_marked_by,
                         'manual_send', true));
  end if;
  return new;
end $$;

create trigger purchase_email_drafts_events
  after insert or update on purchase_email_drafts
  for each row execute function emit_purchase_email_events();

-- ---------------------------------------------------------------------------
-- The activity log writes itself for the state changes, so an RPC that forgets
-- to log still leaves a trail.
-- ---------------------------------------------------------------------------

create or replace function log_purchase_request_activity() returns trigger
language plpgsql security definer as $$
declare
  v_seq bigint;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  select coalesce(max(seq), 0) + 1 into v_seq from purchase_activity_log where request_id = new.id;
  insert into purchase_activity_log (org_id, request_id, actor_id, actor_name, action, entity_type,
                                     entity_id, previous_values, new_values, seq)
  values (
    new.org_id, new.id, auth.uid(),
    (select full_name from users where id = auth.uid()),
    case when tg_op = 'INSERT' then 'request.created' else 'request.status_changed' end,
    'purchase_request', new.id,
    case when tg_op = 'INSERT' then null else jsonb_build_object('status', old.status) end,
    jsonb_build_object('status', new.status), v_seq);
  return new;
end $$;

create trigger purchase_requests_activity
  after insert or update on purchase_requests
  for each row execute function log_purchase_request_activity();

-- ---------------------------------------------------------------------------
-- RLS. Every table is org-scoped; the purchasing permission decides the rest.
--
-- Requestors see their own requests. Anyone holding request.read.all sees the
-- organization's. Nobody sees another organization's, admin included.
-- ---------------------------------------------------------------------------

alter table purchase_vendors             enable row level security;
alter table purchase_vendor_contacts     enable row level security;
alter table purchase_delivery_locations  enable row level security;
alter table purchase_requests            enable row level security;
alter table purchase_request_items       enable row level security;
alter table purchase_request_attachments enable row level security;
alter table purchase_reviews             enable row level security;
alter table purchase_review_items        enable row level security;
alter table purchase_approvals           enable row level security;
alter table po_number_sequences          enable row level security;
alter table request_number_sequences     enable row level security;
alter table purchase_orders              enable row level security;
alter table purchase_order_items         enable row level security;
alter table purchase_order_documents     enable row level security;
alter table purchase_email_templates     enable row level security;
alter table purchase_email_drafts        enable row level security;
alter table purchase_receipts            enable row level security;
alter table purchase_receipt_items       enable row level security;
alter table purchase_receipt_attachments enable row level security;
alter table inventory_observations       enable row level security;
alter table inventory_adjustments        enable row level security;
alter table purchase_activity_log        enable row level security;
alter table purchase_notifications       enable row level security;
alter table purchasing_settings          enable row level security;

-- Reference data: readable by anyone in the org, writable by admins only.
create policy purchase_vendors_read on purchase_vendors
  for select using (org_id = current_org_id());
create policy purchase_vendors_admin on purchase_vendors
  for all using (org_id = current_org_id() and purchasing_can(auth.uid(), 'admin.vendors'));

create policy purchase_vendor_contacts_read on purchase_vendor_contacts
  for select using (exists (select 1 from purchase_vendors v where v.id = vendor_id and v.org_id = current_org_id()));
create policy purchase_vendor_contacts_admin on purchase_vendor_contacts
  for all using (
    exists (select 1 from purchase_vendors v where v.id = vendor_id and v.org_id = current_org_id())
    and purchasing_can(auth.uid(), 'admin.vendors')
  );

create policy purchase_locations_read on purchase_delivery_locations
  for select using (org_id = current_org_id());
create policy purchase_locations_admin on purchase_delivery_locations
  for all using (org_id = current_org_id() and purchasing_can(auth.uid(), 'admin.locations'));

-- Requests: own, or all — never another org's.
create policy purchase_requests_read on purchase_requests
  for select using (
    org_id = current_org_id()
    and (requestor_id = auth.uid() or created_by = auth.uid()
         or purchasing_can(auth.uid(), 'request.read.all'))
  );

create policy purchase_requests_insert on purchase_requests
  for insert with check (
    org_id = current_org_id()
    and purchasing_can(auth.uid(), 'request.create')
    -- The requestor of record is the person creating it. A client cannot file a
    -- request in someone else's name.
    and (requestor_id = auth.uid() or created_by = auth.uid())
  );

-- NOTE: there is deliberately NO general update policy on purchase_requests.
-- Every state change goes through the security-definer RPCs below, so the
-- transition guard, the authorization check and the audit row cannot be
-- bypassed by a direct table write from a client session. The one exception is
-- the requestor editing their OWN request while it is still theirs to edit.
create policy purchase_requests_owner_update on purchase_requests
  for update using (
    org_id = current_org_id()
    and (requestor_id = auth.uid() or created_by = auth.uid())
    and status in ('DRAFT', 'CLARIFICATION_REQUESTED')
    and purchasing_can(auth.uid(), 'request.update.own')
  );

create policy purchase_request_items_read on purchase_request_items
  for select using (exists (select 1 from purchase_requests r where r.id = request_id));
create policy purchase_request_items_owner_write on purchase_request_items
  for all using (
    exists (
      select 1 from purchase_requests r
       where r.id = request_id and r.org_id = current_org_id()
         and (r.requestor_id = auth.uid() or r.created_by = auth.uid())
         and r.status in ('DRAFT', 'CLARIFICATION_REQUESTED')
    )
  );

create policy purchase_request_attachments_read on purchase_request_attachments
  for select using (exists (select 1 from purchase_requests r where r.id = request_id));
create policy purchase_request_attachments_write on purchase_request_attachments
  for insert with check (
    exists (select 1 from purchase_requests r where r.id = request_id and r.org_id = current_org_id())
    and purchasing_can(auth.uid(), 'request.attach')
  );

-- Review: only people who may make purchasing decisions can see or write the
-- purchasing numbers. A requestor cannot read the cost, let alone set it.
create policy purchase_reviews_read on purchase_reviews
  for select using (
    exists (select 1 from purchase_requests r where r.id = request_id and r.org_id = current_org_id())
    and purchasing_can(auth.uid(), 'request.read.all')
  );
create policy purchase_reviews_write on purchase_reviews
  for all using (
    exists (select 1 from purchase_requests r where r.id = request_id and r.org_id = current_org_id())
    and purchasing_can(auth.uid(), 'review.record_stock')
  );

create policy purchase_review_items_read on purchase_review_items
  for select using (
    exists (
      select 1 from purchase_reviews rv join purchase_requests r on r.id = rv.request_id
       where rv.id = review_id and r.org_id = current_org_id()
    )
    and purchasing_can(auth.uid(), 'request.read.all')
  );
create policy purchase_review_items_write on purchase_review_items
  for all using (
    exists (
      select 1 from purchase_reviews rv join purchase_requests r on r.id = rv.request_id
       where rv.id = review_id and r.org_id = current_org_id()
    )
    and purchasing_can(auth.uid(), 'review.set_quantities')
  );

create policy purchase_approvals_read on purchase_approvals
  for select using (exists (select 1 from purchase_requests r where r.id = request_id and r.org_id = current_org_id()));
-- Approvals are written by record_purchase_decision() only.

create policy po_sequences_read on po_number_sequences
  for select using (org_id = current_org_id() and purchasing_can(auth.uid(), 'po.generate'));
create policy po_sequences_admin on po_number_sequences
  for update using (org_id = current_org_id() and purchasing_can(auth.uid(), 'admin.po_config'));
create policy request_sequences_read on request_number_sequences
  for select using (org_id = current_org_id());

create policy purchase_orders_read on purchase_orders
  for select using (
    org_id = current_org_id()
    and (purchasing_can(auth.uid(), 'request.read.all')
         or exists (select 1 from purchase_requests r
                     where r.id = request_id
                       and (r.requestor_id = auth.uid() or r.created_by = auth.uid())))
  );

create policy purchase_order_items_read on purchase_order_items
  for select using (exists (select 1 from purchase_orders po where po.id = purchase_order_id));
create policy purchase_order_documents_read on purchase_order_documents
  for select using (exists (select 1 from purchase_orders po where po.id = purchase_order_id));

create policy purchase_email_templates_read on purchase_email_templates
  for select using (org_id = current_org_id() and purchasing_can(auth.uid(), 'email.draft'));
create policy purchase_email_templates_admin on purchase_email_templates
  for all using (org_id = current_org_id() and purchasing_can(auth.uid(), 'admin.templates'));

create policy purchase_email_drafts_read on purchase_email_drafts
  for select using (org_id = current_org_id() and purchasing_can(auth.uid(), 'email.draft'));
create policy purchase_email_drafts_edit on purchase_email_drafts
  for update using (
    org_id = current_org_id()
    and purchasing_can(auth.uid(), 'email.draft')
    -- Edits stop at review: you approve what you read (the trigger enforces it
    -- too, because a policy alone would not survive a service-role write).
    and status = 'GENERATED'
  );

create policy purchase_receipts_read on purchase_receipts
  for select using (org_id = current_org_id());
create policy purchase_receipts_write on purchase_receipts
  for insert with check (org_id = current_org_id() and purchasing_can(auth.uid(), 'receiving.record'));

create policy purchase_receipt_items_read on purchase_receipt_items
  for select using (exists (select 1 from purchase_receipts r where r.id = receipt_id and r.org_id = current_org_id()));
create policy purchase_receipt_items_write on purchase_receipt_items
  for insert with check (
    exists (select 1 from purchase_receipts r where r.id = receipt_id and r.org_id = current_org_id())
    and purchasing_can(auth.uid(), 'receiving.record')
  );

create policy purchase_receipt_attachments_read on purchase_receipt_attachments
  for select using (exists (select 1 from purchase_receipts r where r.id = receipt_id and r.org_id = current_org_id()));

create policy inventory_observations_read on inventory_observations
  for select using (org_id = current_org_id() and purchasing_can(auth.uid(), 'request.read.all'));
create policy inventory_observations_write on inventory_observations
  for insert with check (org_id = current_org_id() and purchasing_can(auth.uid(), 'review.record_stock'));

create policy inventory_adjustments_read on inventory_adjustments
  for select using (org_id = current_org_id() and purchasing_can(auth.uid(), 'request.read.all'));
create policy inventory_adjustments_write on inventory_adjustments
  for insert with check (org_id = current_org_id() and purchasing_can(auth.uid(), 'inventory.adjust'));

-- The timeline is visible to anyone who can see the request it belongs to; the
-- org-wide audit log needs admin.audit.
create policy purchase_activity_read on purchase_activity_log
  for select using (
    org_id = current_org_id()
    and (purchasing_can(auth.uid(), 'admin.audit')
         or exists (select 1 from purchase_requests r
                     where r.id = request_id
                       and (r.requestor_id = auth.uid() or r.created_by = auth.uid()
                            or purchasing_can(auth.uid(), 'request.read.all'))))
  );

create policy purchase_notifications_read on purchase_notifications
  for select using (org_id = current_org_id() and recipient_id = auth.uid());
create policy purchase_notifications_ack on purchase_notifications
  for update using (org_id = current_org_id() and recipient_id = auth.uid());

create policy purchasing_settings_read on purchasing_settings
  for select using (org_id = current_org_id());
create policy purchasing_settings_admin on purchasing_settings
  for update using (org_id = current_org_id() and purchasing_can(auth.uid(), 'admin.settings'));

-- ---------------------------------------------------------------------------
-- RPCs — the write path for every decision. Each one requires an authenticated
-- human: automation has no approval authority (STAKEHOLDERS universal rule 3),
-- so a service-role runner with no JWT cannot reach any of these.
-- ---------------------------------------------------------------------------

/**
 * record_purchase_decision() — approve, reject, or return for clarification.
 *
 * Refuses: no session, a decision on a request the caller raised (unless the
 * org allows self-approval), a request that is not in the queue, a rejection
 * without a reason, and an approval with nothing to order or with a line
 * missing its vendor or cost.
 */
create or replace function record_purchase_decision(
  p_request  uuid,
  p_decision purchase_decision,
  p_notes    text default null,
  p_reason   text default null
) returns purchase_request_status language plpgsql security definer as $$
declare
  r              purchase_requests%rowtype;
  v_uid          uuid := auth.uid();
  v_allow_self   boolean;
  v_ordering     integer;
  v_missing      integer;
  v_changes      jsonb;
begin
  if v_uid is null then
    raise exception 'a purchasing decision requires an authenticated human; automation has no approval authority';
  end if;

  select * into r from purchase_requests where id = p_request;
  if r.id is null then
    raise exception 'purchase request % not found', p_request;
  end if;
  if r.org_id is distinct from current_org_id() then
    raise exception 'cross-org decision refused (request %)', p_request;
  end if;
  if not purchasing_can(v_uid, 'review.decide') then
    raise exception 'user % does not hold review.decide', v_uid;
  end if;
  if r.status not in ('PENDING_WORKSHOP_REVIEW', 'RESUBMITTED') then
    raise exception 'a % request is not awaiting a decision', r.status;
  end if;

  select coalesce(allow_self_approval, false) into v_allow_self
    from purchasing_settings where org_id = r.org_id;
  if (r.requestor_id = v_uid or r.created_by = v_uid) and not coalesce(v_allow_self, false) then
    raise exception 'a request cannot be decided by the person who raised it';
  end if;

  select jsonb_agg(jsonb_build_object(
           'line_no', i.line_no, 'description', i.description,
           'requested_qty', i.requested_qty, 'approved_qty', ri.approved_qty,
           'usable_stock_qty', ri.usable_stock_qty, 'suggested_order_qty', ri.suggested_order_qty,
           'final_order_qty', ri.final_order_qty, 'override_reason', ri.override_reason,
           'substitute_description', ri.substitute_description))
    into v_changes
    from purchase_request_items i
    join purchase_reviews rv on rv.request_id = i.request_id
    join purchase_review_items ri on ri.request_item_id = i.id and ri.review_id = rv.id
   where i.request_id = p_request
     and (i.requested_qty is distinct from ri.final_order_qty or ri.substitute_description is not null);

  if p_decision = 'APPROVED' then
    select count(*) into v_ordering
      from purchase_reviews rv join purchase_review_items ri on ri.review_id = rv.id
     where rv.request_id = p_request and ri.final_order_qty > 0;
    if v_ordering = 0 then
      raise exception 'approve with at least one line to order, or reject the request';
    end if;
    select count(*) into v_missing
      from purchase_reviews rv join purchase_review_items ri on ri.review_id = rv.id
     where rv.request_id = p_request and ri.final_order_qty > 0
       and (ri.vendor_id is null or ri.estimated_unit_cost is null);
    if v_missing > 0 then
      raise exception 'every ordered line needs a vendor and an estimated unit cost';
    end if;

    update purchase_requests
       set status = 'APPROVED', approver_id = v_uid, decided_at = now(),
           decision_notes = p_notes, updated_by = v_uid
     where id = p_request;

    -- Stock the workshop gives up to this job is an inventory movement, and it
    -- gets a row: inventory never changes silently.
    insert into inventory_adjustments (org_id, request_id, request_item_id, item_description,
                                       delta_qty, unit, reason, adjusted_by)
    select r.org_id, p_request, i.id, i.description, -ri.stock_applied_qty, i.unit, 'STOCK_APPLIED', v_uid
      from purchase_request_items i
      join purchase_reviews rv on rv.request_id = i.request_id
      join purchase_review_items ri on ri.request_item_id = i.id and ri.review_id = rv.id
     where i.request_id = p_request and ri.stock_applied_qty > 0;

  elsif p_decision = 'REJECTED' then
    if p_reason is null or length(p_reason) = 0 then
      raise exception 'a rejection must record a reason';
    end if;
    update purchase_requests
       set status = 'REJECTED', approver_id = v_uid, decided_at = now(),
           decision_notes = p_notes, rejection_reason = p_reason, updated_by = v_uid
     where id = p_request;

  else
    if p_reason is null or length(p_reason) = 0 then
      raise exception 'a clarification must ask something';
    end if;
    update purchase_requests
       set status = 'CLARIFICATION_REQUESTED', approver_id = v_uid,
           clarification_question = p_reason, clarification_answer = null, updated_by = v_uid
     where id = p_request;
  end if;

  insert into purchase_approvals (request_id, approver_id, decision, notes, reason, changes)
  values (p_request, v_uid, p_decision, p_notes, p_reason, coalesce(v_changes, '[]'::jsonb));

  return (select status from purchase_requests where id = p_request);
end $$;

/**
 * generate_purchase_order() — allocate the number and write the order.
 *
 * Idempotent: a request that already has a purchase order returns the same
 * permanent number and burns no sequence value. Refuses any request that is not
 * APPROVED — there is no path from a rejected or draft request to a PO.
 */
create or replace function generate_purchase_order(p_request uuid)
returns table (purchase_order_id uuid, po_number text) language plpgsql security definer as $$
declare
  r          purchase_requests%rowtype;
  v_uid      uuid := auth.uid();
  v_existing purchase_orders%rowtype;
  v_vendors  uuid[];
  v_seq      record;
  v_po       uuid;
  v_total    numeric(12,2);
  v_contact  uuid;
begin
  if v_uid is null then
    raise exception 'generating a purchase order requires an authenticated human';
  end if;

  select * into r from purchase_requests where id = p_request;
  if r.id is null then raise exception 'purchase request % not found', p_request; end if;
  if r.org_id is distinct from current_org_id() then
    raise exception 'cross-org purchase order refused (request %)', p_request;
  end if;
  if not purchasing_can(v_uid, 'po.generate') then
    raise exception 'user % does not hold po.generate', v_uid;
  end if;

  select * into v_existing from purchase_orders where request_id = p_request;
  if v_existing.id is not null then
    purchase_order_id := v_existing.id;
    po_number := v_existing.po_number;
    return next;
    return;
  end if;

  if r.status <> 'APPROVED' then
    raise exception 'a % request cannot produce a purchase order', r.status;
  end if;

  select array_agg(distinct ri.vendor_id) into v_vendors
    from purchase_reviews rv join purchase_review_items ri on ri.review_id = rv.id
   where rv.request_id = p_request and ri.final_order_qty > 0;
  if v_vendors is null or array_length(v_vendors, 1) <> 1 or v_vendors[1] is null then
    raise exception 'this milestone issues one purchase order to one vendor';
  end if;

  select id into v_contact from purchase_vendor_contacts
   where vendor_id = v_vendors[1] order by is_primary desc limit 1;

  select coalesce(sum(ri.estimated_line_total), 0) into v_total
    from purchase_reviews rv join purchase_review_items ri on ri.review_id = rv.id
   where rv.request_id = p_request and ri.final_order_qty > 0;

  select * into v_seq from next_po_number(r.org_id);

  insert into purchase_orders (org_id, request_id, po_number, sequence_value, vendor_id, vendor_contact_id,
                               job_number, approver_id, delivery_location_id, delivery_method,
                               need_by_date, need_by_time, estimated_total, notes, generated_by)
  values (r.org_id, p_request, v_seq.po_number, v_seq.sequence_value, v_vendors[1], v_contact,
          r.job_number, coalesce(r.approver_id, v_uid), r.delivery_location_id, r.delivery_method,
          r.need_by_date, r.need_by_time, v_total, r.decision_notes, v_uid)
  returning id into v_po;

  insert into purchase_order_items (purchase_order_id, line_no, request_item_id, description,
                                    substitute_description, order_qty, unit, unit_cost, line_total,
                                    expected_arrival_date)
  select v_po, row_number() over (order by i.line_no), i.id, i.description,
         ri.substitute_description, ri.final_order_qty, i.unit,
         coalesce(ri.estimated_unit_cost, 0), ri.estimated_line_total, ri.expected_arrival_date
    from purchase_request_items i
    join purchase_reviews rv on rv.request_id = i.request_id
    join purchase_review_items ri on ri.request_item_id = i.id and ri.review_id = rv.id
   where i.request_id = p_request and ri.final_order_qty > 0;

  update purchase_requests
     set status = 'PO_GENERATED', estimated_total = v_total, updated_by = v_uid
   where id = p_request;

  purchase_order_id := v_po;
  po_number := v_seq.po_number;
  return next;
end $$;

/**
 * mark_purchase_email_sent() — bookkeeping ONLY.
 *
 * This function sends nothing. It records that an authorized human copied an
 * approved draft into their own mail client and sent it. It refuses any draft
 * that is not APPROVED_TO_SEND, so the ledger can never claim a message was
 * sent that no human reviewed.
 */
create or replace function mark_purchase_email_sent(p_draft uuid)
returns purchase_email_status language plpgsql security definer as $$
declare
  d     purchase_email_drafts%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'marking sent requires an authenticated human'; end if;
  select * into d from purchase_email_drafts where id = p_draft;
  if d.id is null then raise exception 'email draft % not found', p_draft; end if;
  if d.org_id is distinct from current_org_id() then
    raise exception 'cross-org send-marking refused (draft %)', p_draft;
  end if;
  if not purchasing_can(v_uid, 'email.review') then
    raise exception 'user % does not hold email.review', v_uid;
  end if;
  if d.status <> 'APPROVED_TO_SEND' then
    raise exception 'only an approved draft can be marked sent; draft % is % (review gate)', p_draft, d.status;
  end if;

  update purchase_email_drafts
     set status = 'SENT', sent_at = now(), sent_marked_by = v_uid
   where id = p_draft;
  return 'SENT';
end $$;

-- ---------------------------------------------------------------------------
-- Seeds: one settings row and one sequence per existing org, so a fresh install
-- is usable without a second migration. Values are the pilot's defaults.
-- ---------------------------------------------------------------------------

insert into purchasing_settings (org_id) select id from orgs on conflict do nothing;
insert into po_number_sequences (org_id) select id from orgs on conflict do nothing;
insert into request_number_sequences (org_id) select id from orgs on conflict do nothing;

-- Existing users get a purchasing role that matches what they already do:
-- admins administer, foremen and workers request. WORKSHOP_APPROVER is granted
-- BY NAME, deliberately, because "who may approve purchasing" is a business
-- decision and not something a migration should infer.
insert into purchasing_user_roles (user_id, role)
select id, case when role = 'admin' then 'ADMIN'::purchasing_role else 'REQUESTOR'::purchasing_role end
  from users
on conflict do nothing;
