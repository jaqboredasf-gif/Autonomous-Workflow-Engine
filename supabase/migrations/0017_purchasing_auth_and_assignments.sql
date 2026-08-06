-- ---------------------------------------------------------------------------
-- 0017_purchasing_auth_and_assignments.sql
--
-- What the website needs that the domain did not: a link to the authentication
-- provider, and the job assignments that scope a foreman's delivery
-- confirmations.
--
-- THERE IS NO CREDENTIAL TABLE HERE, AND THERE MUST NEVER BE ONE.
-- Supabase Auth owns passwords, sessions and resets in `auth.users`. This
-- migration adds `users.auth_user_id` — a reference to that identity — and
-- nothing else about credentials. The pilot's local provider keeps its hashes
-- in its own table on the pilot's own store (apps/purchasing, auth_identities),
-- which is the same boundary drawn in a different place: purchasing tables
-- reference a user, never a secret.
--
-- Additive only. Follows the 0016 idioms: org-scoped, RLS-first, fail closed.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The link to the credential provider.
-- ---------------------------------------------------------------------------

alter table users
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null,
  -- Designated to sign for deliveries on their assigned job sites. Distinct
  -- from the FOREMAN role: a role says what kind of work you do, this says the
  -- office has made you responsible for signing.
  add column if not exists purchasing_is_delivery_receiver boolean not null default false;

create unique index if not exists users_auth_user_id_uidx on users(auth_user_id)
  where auth_user_id is not null;

-- ---------------------------------------------------------------------------
-- Job assignments. A foreman confirms deliveries for the sites he is assigned
-- to and no others — the row is the authority, and its absence is a refusal.
-- ---------------------------------------------------------------------------

create table if not exists purchasing_job_assignments (
  user_id     uuid not null references users(id) on delete cascade,
  job_number  text not null,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references users(id),
  primary key (user_id, job_number)
);

create index if not exists purchasing_job_assignments_job_idx
  on purchasing_job_assignments(job_number);

alter table purchasing_job_assignments enable row level security;

-- Everyone in the org can see who covers which site; only an administrator
-- changes it (assigning yourself to a job is assigning yourself authority).
create policy purchasing_job_assignments_read on purchasing_job_assignments
  for select using (
    exists (select 1 from users u where u.id = user_id and u.org_id = current_org_id())
  );

create policy purchasing_job_assignments_admin on purchasing_job_assignments
  for all using (
    purchasing_can(auth.uid(), 'admin.assignments')
    and exists (select 1 from users u where u.id = user_id and u.org_id = current_org_id())
  );

-- ---------------------------------------------------------------------------
-- The assignment scope, in SQL. Mirrors ASSIGNMENT_SCOPED in
-- apps/purchasing/src/purchasing/domain/roles.mjs: office, accounting, workshop
-- and admin users receive anywhere (the shop counter is their job); a field
-- user is confined to their assigned sites.
-- ---------------------------------------------------------------------------

create or replace function purchasing_is_field_only(p_user uuid)
returns boolean language sql stable security definer as $$
  select not exists (
    select 1 from purchasing_user_roles ur
     where ur.user_id = p_user
       and ur.role in ('OFFICE', 'ACCOUNTING', 'WORKSHOP_APPROVER', 'ADMIN')
  );
$$;

create or replace function purchasing_may_receive(p_user uuid, p_request uuid)
returns boolean language plpgsql stable security definer as $$
declare
  v_job text;
begin
  if not purchasing_can(p_user, 'receiving.record') then
    return false;
  end if;
  if not purchasing_is_field_only(p_user) then
    return true;
  end if;
  select job_number into v_job from purchase_requests where id = p_request;
  return exists (
    select 1 from purchasing_job_assignments
     where user_id = p_user and job_number = v_job
  );
end $$;

-- Receiving now answers to the assignment, not only to the permission.
drop policy if exists purchase_receipts_write on purchase_receipts;
create policy purchase_receipts_write on purchase_receipts
  for insert with check (
    org_id = current_org_id() and purchasing_may_receive(auth.uid(), request_id)
  );

-- ---------------------------------------------------------------------------
-- Accounting reads the evidence behind a receipt. It gets SELECT on receipts,
-- their lines and their attachments — and no write policy anywhere, which is
-- how "read-only" is enforced rather than merely intended.
-- ---------------------------------------------------------------------------

create policy purchase_receipt_attachments_accounting_read on purchase_receipt_attachments
  for select using (
    exists (
      select 1 from purchase_receipts r
       where r.id = receipt_id and r.org_id = current_org_id()
    )
    and purchasing_can(auth.uid(), 'accounting.read')
  );

-- ---------------------------------------------------------------------------
-- Existing installs: nobody is a foreman or an accountant until a human says
-- so. Roles are business decisions and a migration does not get to infer them.
-- ---------------------------------------------------------------------------
