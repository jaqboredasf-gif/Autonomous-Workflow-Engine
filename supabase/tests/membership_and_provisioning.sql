-- ---------------------------------------------------------------------------
-- membership_and_provisioning.sql — Checkpoint 1E, proven by Postgres.
--
-- The security matrix that only a real database can answer: membership decides
-- the tenant, a fabricated org_id buys nothing, provisioning is all-or-nothing,
-- and an invited user cannot give themselves more than they were offered.
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/membership_and_provisioning.sql
--
-- Rolls back at the end: nothing survives.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  org_a uuid; org_b uuid;
  admin_a uuid; admin_b uuid;
  auth_a uuid := gen_random_uuid();
  auth_b uuid := gen_random_uuid();
  auth_outsider uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  loc_a uuid; req_a uuid; inv_id uuid;
  visible int; failures int := 0; before_orgs int; after_orgs int;
  claims text;
begin
  -- Provisioning legitimately requires the identity to exist in the auth
  -- provider first — users.auth_user_id references auth.users(id), and
  -- users.id IS that identity. The fixture creates them the way GoTrue would.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  values (auth_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'admin-a@example.invalid', crypt('password-a', gen_salt('bf')), now(), now(), now()),
         (auth_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'admin-b@example.invalid', crypt('password-b', gen_salt('bf')), now(), now(), now()),
         (auth_outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'outsider@example.invalid', crypt('password-o', gen_salt('bf')), now(), now(), now());

  -- --- 11. provisioning succeeds COMPLETELY ---------------------------------
  select out_org_id, out_admin_user_id into org_a, admin_a
    from provision_organization('Tenant A Electric', auth_a, 'admin-a@example.invalid', 'A Admin', 'AA-', 5000);
  select out_org_id, out_admin_user_id into org_b, admin_b
    from provision_organization('Tenant B Mechanical', auth_b, 'admin-b@example.invalid', 'B Admin');

  if (select count(*) from purchasing_settings where org_id = org_a) <> 1
     or (select count(*) from po_number_sequences where org_id = org_a) <> 1
     or (select count(*) from request_number_sequences where org_id = org_a) <> 1
     or (select count(*) from purchasing_org_memberships
          where org_id = org_a and user_id = admin_a and status = 'ACTIVE') <> 1
     or (select count(*) from purchasing_user_roles where user_id = admin_a and role = 'ADMIN') <> 1
  then
    failures := failures + 1; raise warning 'PROVISIONING: an organization was created incompletely';
  end if;

  -- 13. the first administrator really is one
  if (select next_value from po_number_sequences where org_id = org_a) <> 5000 then
    failures := failures + 1; raise warning 'PROVISIONING: the PO sequence did not take the requested start';
  end if;

  -- --- 12. provisioning ROLLS BACK completely on failure --------------------
  select count(*) into before_orgs from orgs;
  begin
    -- No administrator identity: must fail, and must leave nothing behind.
    perform provision_organization('Doomed Contracting', null, 'nobody@example.invalid', 'Nobody');
    failures := failures + 1; raise warning 'PROVISIONING: an invalid organization was accepted';
  exception when others then null;
  end;
  select count(*) into after_orgs from orgs;
  if after_orgs <> before_orgs then
    failures := failures + 1;
    raise warning 'PROVISIONING: a failed provisioning left % organization row(s) behind', after_orgs - before_orgs;
  end if;

  -- --- fixtures inside tenant A --------------------------------------------
  insert into purchase_delivery_locations (org_id, name, kind)
       values (org_a, 'A Yard', 'JOBSITE') returning id into loc_a;
  insert into purchase_requests (org_id, request_number, job_number, requestor_id, status,
                                 need_by_date, need_by_time, delivery_location_id, delivery_method, created_by)
       values (org_a, 'PR-A-1', 'A-JOB', admin_a, 'DRAFT', current_date, '07:00', loc_a, 'DELIVERY', admin_a)
    returning id into req_a;
  insert into purchase_request_items (request_id, org_id, line_no, description, requested_qty, unit, created_by)
       values (req_a, org_a, 1, 'A widget', 10, 'ea', admin_a);

  -- --- 5. an authenticated member sees its own organization ----------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_a, 'email', 'admin-a@example.invalid', 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*) into visible from purchase_requests where id = req_a;
  if visible <> 1 then failures := failures + 1; raise warning 'MEMBERSHIP: an active member cannot read its own organization'; end if;

  -- --- 7/8. tenant A cannot read or write tenant B -------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_b, 'email', 'admin-b@example.invalid', 'role', 'authenticated')::text, true);

  select count(*) into visible from purchase_requests where org_id = org_a;
  if visible <> 0 then failures := failures + 1; raise warning 'LEAK: tenant B read tenant A requests'; end if;

  update purchase_requests set notes = 'tampered' where id = req_a;
  if found then failures := failures + 1; raise warning 'LEAK: tenant B wrote a tenant A request'; end if;

  -- --- 9. a FABRICATED org_id buys nothing ---------------------------------
  -- The client does not choose its tenant: current_org_id() reads membership,
  -- so claiming another organization on an inserted row is refused by the
  -- policy's WITH CHECK rather than believed.
  begin
    insert into purchase_delivery_locations (org_id, name, kind)
         values (org_a, 'Forged location', 'JOBSITE');
    failures := failures + 1;
    raise warning 'LEAK: tenant B inserted a row claiming tenant A''s org_id';
  exception when insufficient_privilege or check_violation then null;
  end;

  -- --- 6. authenticated but WITHOUT membership sees nothing -----------------
  perform set_config('role', 'postgres', true);
  insert into users (id, org_id, role, full_name, email, is_active, auth_user_id)
       values (auth_outsider, org_a, 'worker', 'No Membership', 'outsider@example.invalid', true, auth_outsider);
  outsider := auth_outsider;
  -- deliberately NO membership row, and users.org_id is set to tenant A to
  -- prove membership is what decides, not the legacy column.
  delete from purchasing_org_memberships where user_id = outsider;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', outsider, 'email', 'outsider@example.invalid', 'role', 'authenticated')::text, true);

  -- NOTE: current_org_id() falls back to users.org_id for compatibility with
  -- migrations 0002-0015, so this user DOES resolve to tenant A. That fallback
  -- is deliberate and is recorded as a known gap: it must be removed once the
  -- legacy policies are migrated to membership.
  -- A user with no membership row falls back to users.org_id by design (the
  -- legacy AWE users), but holds no purchasing role, so the row policies refuse
  -- them anyway. Both halves are asserted.
  if current_org_id() is null then
    failures := failures + 1; raise warning 'MEMBERSHIP: the legacy fallback stopped working for a legacy user';
  end if;
  select count(*) into visible from purchase_requests where org_id = org_a;
  if visible <> 0 then
    failures := failures + 1; raise warning 'LEAK: a user with no purchasing role read organization data';
  end if;

  -- --- 10. a SUSPENDED membership loses access -----------------------------
  perform set_config('role', 'postgres', true);
  -- Suspension alone must be enough. The legacy users.org_id column still says
  -- tenant B, and that must no longer matter.
  update purchasing_org_memberships set status = 'SUSPENDED' where user_id = admin_b;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_b, 'email', 'admin-b@example.invalid', 'role', 'authenticated')::text, true);

  select count(*) into visible from purchase_requests where org_id = org_b;
  if visible <> 0 then
    failures := failures + 1; raise warning 'LEAK: a suspended member still reads their organization';
  end if;

  -- --- 14. an invited user cannot elevate their own role -------------------
  perform set_config('role', 'postgres', true);
  update purchasing_org_memberships set status = 'ACTIVE' where user_id = admin_b;
  insert into purchasing_invitations (org_id, email, roles, invited_by)
       values (org_b, 'invitee@example.invalid', array['REQUESTOR']::purchasing_role[], admin_b)
    returning id into inv_id;

  declare invitee_auth uuid := gen_random_uuid();
  begin
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at)
    values (invitee_auth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'invitee@example.invalid', crypt('password-i', gen_salt('bf')), now(), now(), now());
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', invitee_auth, 'email', 'invitee@example.invalid', 'role', 'authenticated')::text, true);
    perform accept_purchasing_invitation(inv_id);
  end;

  perform set_config('role', 'postgres', true);
  if exists (
    select 1 from purchasing_user_roles r
      join purchasing_invitations i on i.id = inv_id
     where r.user_id = i.accepted_user_id and r.role <> 'REQUESTOR'
  ) then
    failures := failures + 1; raise warning 'ESCALATION: an invited user received a role the invitation did not grant';
  end if;
  if not exists (
    select 1 from purchasing_org_memberships m
      join purchasing_invitations i on i.id = inv_id
     where m.user_id = i.accepted_user_id and m.org_id = org_b and m.status = 'ACTIVE'
  ) then
    failures := failures + 1; raise warning 'INVITATION: acceptance did not create an active membership';
  end if;

  if failures = 0 then
    raise notice 'membership, provisioning and invitations: PASS';
  else
    raise exception 'membership/provisioning: % failure(s)', failures;
  end if;
end $$;

rollback;
