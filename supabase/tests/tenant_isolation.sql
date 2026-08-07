-- ---------------------------------------------------------------------------
-- tenant_isolation.sql — the live proof. NOT YET RUN.
--
-- Everything in scripts/eval-purchasing-isolation.mjs is static analysis and
-- application-level behaviour. Row level security is enforced by Postgres, and
-- only Postgres can demonstrate it. Until this file has been executed against a
-- real project, the policies in this repository are REVIEWED, NOT PROVEN.
--
-- Run against a development project only:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/tenant_isolation.sql
--
-- It creates two organizations, sets the session to each in turn using the same
-- JWT claims PostgREST sets, and asserts that neither can see or touch the
-- other. It rolls back at the end: nothing survives the run.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  org_a uuid := gen_random_uuid();
  org_b uuid := gen_random_uuid();
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  req_a uuid;
  loc_a uuid;
  loc_b uuid;
  visible int;
  failures int := 0;

  procedure_note text;
begin
  -- --- fixtures, created as the owner (RLS bypassed) -----------------------
  insert into orgs (id, name) values (org_a, 'Tenant A'), (org_b, 'Tenant B');

  insert into users (id, org_id, role, full_name, is_active)
  values (user_a, org_a, 'admin', 'A Admin', true),
         (user_b, org_b, 'admin', 'B Admin', true);

  insert into purchasing_user_roles (user_id, role) values (user_a, 'ADMIN'), (user_b, 'ADMIN');
  insert into purchasing_settings (org_id) values (org_a), (org_b);
  insert into po_number_sequences (org_id) values (org_a), (org_b);
  insert into request_number_sequences (org_id) values (org_a), (org_b);

  insert into purchase_delivery_locations (id, org_id, name, kind)
  values (gen_random_uuid(), org_a, 'A Yard', 'JOBSITE') returning id into loc_a;
  insert into purchase_delivery_locations (id, org_id, name, kind)
  values (gen_random_uuid(), org_b, 'B Yard', 'JOBSITE') returning id into loc_b;

  insert into purchase_requests (org_id, request_number, job_number, requestor_id, status,
                                 need_by_date, need_by_time, delivery_location_id,
                                 delivery_method, created_by)
  values (org_a, 'PR-A-1', 'A-JOB', user_a, 'DRAFT', current_date, '07:00', loc_a, 'DELIVERY', user_a)
  returning id into req_a;

  insert into purchase_request_items (request_id, org_id, line_no, description, requested_qty, unit, created_by)
  values (req_a, org_a, 1, 'A widget', 10, 'ea', user_a);

  -- --- become tenant B, exactly as PostgREST would -------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*) into visible from purchase_requests where id = req_a;
  if visible <> 0 then failures := failures + 1; raise warning 'LEAK: tenant B can read tenant A requests'; end if;

  select count(*) into visible from purchase_request_items where org_id = org_a;
  if visible <> 0 then failures := failures + 1; raise warning 'LEAK: tenant B can read tenant A line items'; end if;

  select count(*) into visible from purchase_delivery_locations where org_id = org_a;
  if visible <> 0 then failures := failures + 1; raise warning 'LEAK: tenant B can read tenant A locations'; end if;

  -- The view was the defect 0019 fixed. Without security_invoker it returns
  -- every organization's history to whoever asks.
  select count(*) into visible from purchase_line_history where org_id = org_a;
  if visible <> 0 then failures := failures + 1; raise warning 'LEAK: purchase_line_history exposes tenant A'; end if;

  -- Writes must be refused, not silently ignored.
  begin
    update purchase_requests set notes = 'tampered' where id = req_a;
    if found then failures := failures + 1; raise warning 'LEAK: tenant B updated a tenant A request'; end if;
  exception when insufficient_privilege then null;
  end;

  -- A cross-tenant REFERENCE must be structurally impossible (0019 composite
  -- foreign keys), not merely hidden.
  begin
    insert into purchase_requests (org_id, request_number, job_number, requestor_id, status,
                                   need_by_date, need_by_time, delivery_location_id,
                                   delivery_method, created_by)
    values (org_b, 'PR-B-X', 'B-JOB', user_b, 'DRAFT', current_date, '07:00', loc_a, 'DELIVERY', user_b);
    failures := failures + 1;
    raise warning 'LEAK: tenant B created a request pointing at tenant A''s location';
  exception when foreign_key_violation or insufficient_privilege then null;
  end;

  -- --- and the reverse direction -------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);

  select count(*) into visible from purchase_requests where org_id = org_b;
  if visible <> 0 then failures := failures + 1; raise warning 'LEAK: tenant A can read tenant B requests'; end if;

  select count(*) into visible from purchase_requests where id = req_a;
  if visible <> 1 then failures := failures + 1; raise warning 'BROKEN: tenant A cannot read its OWN request'; end if;

  if failures = 0 then
    raise notice 'tenant isolation: PASS';
  else
    raise exception 'tenant isolation: % failure(s) — see warnings above', failures;
  end if;
end $$;

rollback;
