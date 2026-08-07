-- ---------------------------------------------------------------------------
-- 0020_purchasing_membership_and_provisioning.sql  (Checkpoint 1E)
--
-- Four things:
--   A. GRANTS. Found by running 0016-0019 against a real Postgres: the
--      purchasing tables had row level security and policies but were never
--      granted to the `authenticated` role. Supabase does not auto-expose new
--      tables, so through PostgREST every purchasing query would have returned
--      "permission denied" — the whole schema unreachable in production. RLS
--      decides WHICH ROWS; a grant decides whether the table is addressable at
--      all, and we had the second half of a two-part answer.
--   B. MEMBERSHIP. Which organization a user belongs to becomes a record with a
--      lifecycle, instead of a single column on the user.
--   C. PROVISIONING. Creating an organization becomes one atomic call that
--      leaves a VALID tenant or nothing at all.
--   D. INVITATIONS. The minimum path to adding a person without editing rows by
--      hand, with no way for the invited party to choose their own role.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A. Make the schema addressable.
--
-- Every table below already has RLS enabled and organization-scoped policies,
-- so a grant here widens nothing: it lets the request reach the policy. Without
-- it, PostgREST answers 403 before RLS is ever consulted.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  purchasing_tables text[] := array[
    'purchase_vendors', 'purchase_vendor_contacts', 'purchase_delivery_locations',
    'purchase_requests', 'purchase_request_items', 'purchase_request_attachments',
    'purchase_reviews', 'purchase_review_items', 'purchase_approvals',
    'purchase_orders', 'purchase_order_items', 'purchase_order_documents',
    'purchase_email_templates', 'purchase_email_drafts',
    'purchase_receipts', 'purchase_receipt_items', 'purchase_receipt_attachments',
    'inventory_observations', 'inventory_adjustments',
    'purchase_activity_log', 'purchase_notifications', 'purchasing_settings',
    'purchase_item_catalog', 'purchase_jobs',
    'purchasing_user_roles', 'purchasing_job_assignments',
    'po_number_sequences', 'request_number_sequences',
    'purchasing_role_permissions', 'purchasing_grant_permissions',
    'orgs', 'users'
  ];
begin
  foreach t in array purchasing_tables loop
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end $$;

-- Reference tables are read-only to the application; nothing should write them
-- at runtime.
revoke insert, update on public.purchasing_role_permissions from authenticated;
revoke insert, update on public.purchasing_grant_permissions from authenticated;

grant select on public.purchase_line_history to authenticated;

-- The functions the application calls.
grant execute on function next_po_number(uuid) to authenticated;
grant execute on function next_request_number(uuid) to authenticated;
grant execute on function record_purchase_decision(uuid, purchase_decision, text, text) to authenticated;
grant execute on function generate_purchase_order(uuid) to authenticated;
grant execute on function mark_purchase_email_sent(uuid) to authenticated;
grant execute on function record_purchase_receipt(uuid, date, jsonb, text, text) to authenticated;
grant execute on function purchasing_can(uuid, text) to authenticated;
grant execute on function current_org_id() to authenticated;

-- ---------------------------------------------------------------------------
-- A2. users.email
--
-- Found by running against a real database: the AWE `users` table (migration
-- 0001) has NO email column. Purchasing assumed one everywhere — for linking an
-- authentication identity, for invitations, for showing who someone is — and
-- the assumption survived four checkpoints because the pilot's own SQLite
-- schema was written with the column present and the parity lint compared table
-- NAMES, not columns.
--
-- Additive: nullable, because existing AWE users have no address recorded and
-- backfilling one would be inventing data.
-- ---------------------------------------------------------------------------

alter table users add column if not exists email text;

-- An address identifies a person within an organization, so it may not repeat
-- inside one. Two organizations may legitimately both have jane@contractor.com.
create unique index if not exists users_org_email_uidx
  on users(org_id, lower(email)) where email is not null;

-- ---------------------------------------------------------------------------
-- B. Organization membership
--
-- `users.org_id` said which organization a person belonged to and could not
-- express joining, leaving, or being suspended. Membership is now a record, and
-- it is the ONLY thing that answers "which tenant is this caller in" — never a
-- value the client sends.
-- ---------------------------------------------------------------------------

create type purchasing_membership_status as enum ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');

create table purchasing_org_memberships (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid not null references orgs(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  status      purchasing_membership_status not null default 'INVITED',
  -- Which organization this person lands in when they sign in. Multi-org
  -- membership is representable; choosing between them is a later checkpoint.
  is_primary  boolean not null default true,
  invited_by  uuid references users(id),
  invited_at  timestamptz not null default now(),
  accepted_at timestamptz,
  suspended_at timestamptz,
  removed_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, user_id)
);

create index purchasing_org_memberships_user_idx on purchasing_org_memberships(user_id, status);
create index purchasing_org_memberships_org_idx on purchasing_org_memberships(org_id, status);

alter table purchasing_org_memberships enable row level security;
grant select, insert, update on public.purchasing_org_memberships to authenticated;

-- You can see the memberships of your own organization, and your own.
create policy purchasing_memberships_read on purchasing_org_memberships
  for select using (org_id = current_org_id() or user_id = auth.uid());

-- Only an administrator of THAT organization changes membership. Note the
-- with check: an admin cannot move a membership to another organization.
create policy purchasing_memberships_admin on purchasing_org_memberships
  for all using (org_id = current_org_id() and purchasing_can(auth.uid(), 'admin.users'))
  with check (org_id = current_org_id() and purchasing_can(auth.uid(), 'admin.users'));

/**
 * The tenant boundary, resolved from membership.
 *
 * Replaces the 0002 definition, which read users.org_id. The fallback keeps
 * every existing policy in migrations 0002-0015 working for users who have no
 * membership row yet, so this is additive rather than a cutover.
 *
 * A SUSPENDED or REMOVED membership resolves to nothing — access stops at the
 * next request, because every policy calls this.
 */
create or replace function current_org_id() returns uuid
language sql stable security definer as $$
  select coalesce(
    (select m.org_id
       from purchasing_org_memberships m
      where m.user_id = auth.uid() and m.status = 'ACTIVE'
      order by m.is_primary desc, m.created_at
      limit 1),
    -- The legacy fallback serves users who have NO membership row at all —
    -- the AWE users that migrations 0002-0015 were written for. It must NOT
    -- serve someone whose membership was suspended or removed: found by the
    -- live suite, where a suspended member kept their access through this
    -- column. Once a membership exists, membership is the only answer.
    (select u.org_id from users u
      where u.id = auth.uid()
        and not exists (select 1 from purchasing_org_memberships m2 where m2.user_id = u.id))
  )
$$;

/** Is this caller an active member of that organization? */
create or replace function purchasing_is_member(p_user uuid, p_org uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from purchasing_org_memberships
     where user_id = p_user and org_id = p_org and status = 'ACTIVE'
  );
$$;

grant execute on function purchasing_is_member(uuid, uuid) to authenticated;

-- Existing users become active members of the organization they already belong
-- to, so nothing changes for them.
insert into purchasing_org_memberships (org_id, user_id, status, accepted_at)
select u.org_id, u.id, 'ACTIVE', now() from users u
on conflict (org_id, user_id) do nothing;

-- ---------------------------------------------------------------------------
-- C. Atomic provisioning
--
-- 1D found that creating an `orgs` row is not enough: without settings and
-- number sequences a new tenant cannot raise its first request, and a
-- half-provisioned organization is an unknown state nobody can debug.
--
-- A VALID PROVISIONED ORGANIZATION HAS, ALL OR NOTHING:
--   1. an orgs row
--   2. a purchasing_settings row
--   3. a po_number_sequences row
--   4. a request_number_sequences row
--   5. one ACTIVE membership holding the ADMIN purchasing role
--   6. that member's users row, linked to their auth identity
--
-- A function is the atomic boundary: it runs in one transaction, so a failure
-- at step 5 removes steps 1-4 as well.
-- ---------------------------------------------------------------------------

create or replace function provision_organization(
  p_name           text,
  p_admin_auth_id  uuid,
  p_admin_email    text,
  p_admin_name     text,
  p_po_prefix      text default 'PO-',
  p_po_start       bigint default 1001
) returns table (out_org_id uuid, out_admin_user_id uuid)
language plpgsql security definer as $$
declare
  v_org  uuid;
  v_user uuid;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'an organization needs a name';
  end if;
  if coalesce(trim(p_admin_email), '') = '' then
    raise exception 'an organization needs a first administrator';
  end if;
  if p_admin_auth_id is null then
    raise exception 'the first administrator must already exist in the authentication provider';
  end if;
  if p_po_start < 1 then
    raise exception 'a purchase order sequence must start at 1 or more';
  end if;

  insert into orgs (name) values (trim(p_name)) returning id into v_org;

  insert into purchasing_settings (org_id) values (v_org);
  insert into po_number_sequences (org_id, prefix, next_value)
       values (v_org, p_po_prefix, p_po_start);
  insert into request_number_sequences (org_id) values (v_org);

  -- The administrator's application profile. `users.id` IS the authentication
  -- provider's user id — migration 0001 gives the column no default, and
  -- current_org_id() matches `users.id = auth.uid()`. Generating a fresh id
  -- here would produce a profile that no signed-in caller ever resolves to.
  insert into users (id, org_id, role, full_name, email, is_active, auth_user_id)
       values (p_admin_auth_id, v_org, 'admin', trim(p_admin_name),
               lower(trim(p_admin_email)), true, p_admin_auth_id)
    returning id into v_user;

  insert into purchasing_user_roles (user_id, role) values (v_user, 'ADMIN');

  insert into purchasing_org_memberships (org_id, user_id, status, accepted_at, is_primary)
       values (v_org, v_user, 'ACTIVE', now(), true);

  out_org_id := v_org;
  out_admin_user_id := v_user;
  return next;
end $$;

comment on function provision_organization is
  'Creates a COMPLETE tenant or nothing: organization, settings, both number '
  'sequences, the first administrator profile and their ACTIVE admin membership. '
  'Any failure rolls the whole thing back — a half-created organization is an '
  'unknown state, not a recoverable one.';

-- Provisioning is not something an ordinary authenticated caller may do: it
-- creates an organization and an administrator. It is reachable only with the
-- service role, from a server the operator controls.
revoke execute on function provision_organization(text, uuid, text, text, text, bigint) from public, authenticated;

-- ---------------------------------------------------------------------------
-- D. Invitations
--
-- The invited person cannot choose their own role: the roles are recorded on
-- the invitation by the administrator who sent it, and acceptance copies them.
-- ---------------------------------------------------------------------------

create table purchasing_invitations (
  id           uuid primary key default uuid_generate_v4(),
  org_id       uuid not null references orgs(id) on delete cascade,
  email        text not null,
  roles        purchasing_role[] not null,
  can_approve  boolean not null default false,
  is_delivery_receiver boolean not null default false,
  job_numbers  text[] not null default '{}',
  invited_by   uuid not null references users(id),
  invited_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '14 days',
  accepted_at  timestamptz,
  accepted_user_id uuid references users(id),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  -- One live invitation per address per organization.
  constraint purchasing_invitations_roles_not_empty check (array_length(roles, 1) >= 1)
);

create unique index purchasing_invitations_live_uidx
  on purchasing_invitations(org_id, lower(email))
  where accepted_at is null and revoked_at is null;

alter table purchasing_invitations enable row level security;
grant select, insert, update on public.purchasing_invitations to authenticated;

create policy purchasing_invitations_admin on purchasing_invitations
  for all using (org_id = current_org_id() and purchasing_can(auth.uid(), 'admin.invite'))
  with check (org_id = current_org_id() and purchasing_can(auth.uid(), 'admin.invite'));

-- An invited person may see their OWN invitation before they have a
-- membership — that is how they discover which organization invited them.
create policy purchasing_invitations_invitee_read on purchasing_invitations
  for select using (
    lower(email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
  );

/**
 * Accept an invitation.
 *
 * The caller proves who they are with their own JWT; the invitation says what
 * they get. Roles come from the INVITATION, never from the caller — an invited
 * user cannot elevate themselves by asking for more.
 */
create or replace function accept_purchasing_invitation(p_invitation uuid)
returns table (out_org_id uuid, out_user_id uuid)
language plpgsql security definer as $$
declare
  inv    purchasing_invitations%rowtype;
  v_uid  uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_user uuid;
  r      purchasing_role;
begin
  if v_uid is null then
    raise exception 'accepting an invitation requires an authenticated user';
  end if;

  select * into inv from purchasing_invitations where id = p_invitation;
  if inv.id is null then raise exception 'invitation not found'; end if;
  if inv.accepted_at is not null then raise exception 'this invitation has already been accepted'; end if;
  if inv.revoked_at is not null then raise exception 'this invitation was withdrawn'; end if;
  if inv.expires_at < now() then raise exception 'this invitation has expired'; end if;

  -- The invitation is for an address, and the caller must own it.
  if v_email = '' or lower(inv.email) <> v_email then
    raise exception 'this invitation was issued to a different email address';
  end if;

  select id into v_user from users where id = v_uid or lower(email) = v_email limit 1;
  if v_user is null then
    -- Same rule: the profile's id is the authentication identity.
    insert into users (id, org_id, role, full_name, email, is_active, auth_user_id)
         values (v_uid, inv.org_id, 'worker', split_part(inv.email, '@', 1), inv.email, true, v_uid)
      returning id into v_user;
  else
    update users set auth_user_id = coalesce(auth_user_id, v_uid), is_active = true where id = v_user;
  end if;

  -- Roles are copied from the invitation. Nothing the caller sent is read.
  delete from purchasing_user_roles where user_id = v_user;
  foreach r in array inv.roles loop
    insert into purchasing_user_roles (user_id, role, granted_by) values (v_user, r, inv.invited_by);
  end loop;

  update users
     set purchasing_can_approve = inv.can_approve,
         purchasing_is_delivery_receiver = inv.is_delivery_receiver
   where id = v_user;

  insert into purchasing_org_memberships (org_id, user_id, status, accepted_at, invited_by)
       values (inv.org_id, v_user, 'ACTIVE', now(), inv.invited_by)
  on conflict (org_id, user_id) do update
       set status = 'ACTIVE', accepted_at = now(), removed_at = null, suspended_at = null;

  insert into purchasing_job_assignments (user_id, job_number, assigned_by)
  select v_user, unnest(inv.job_numbers), inv.invited_by
  on conflict do nothing;

  update purchasing_invitations
     set accepted_at = now(), accepted_user_id = v_user
   where id = p_invitation;

  out_org_id := inv.org_id;
  out_user_id := v_user;
  return next;
end $$;

grant execute on function accept_purchasing_invitation(uuid) to authenticated;

comment on function accept_purchasing_invitation is
  'The invited person proves their identity with their own JWT; the invitation '
  'decides what they receive. Roles are copied from the invitation row, so an '
  'invited user cannot grant themselves anything the administrator did not.';
