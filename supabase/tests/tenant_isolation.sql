-- ---------------------------------------------------------------------------
-- tenant_isolation.sql — the live proof.
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
  req_a_done uuid;
  item_a uuid;
  item_a_done uuid;
  item_a_done2 uuid;
  item_a_done3 uuid;
  item_a_done4 uuid;
  req_b uuid;
  item_b uuid;
  hist_a uuid;
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
  values (req_a, org_a, 1, 'A widget', 10, 'ea', user_a)
  returning id into item_a;

  -- A request that has ENDED, so tenant A has something history may legally be
  -- written against. The history INSERT policy asks the request whether it is
  -- already terminal — a row written for a purchase still in flight would have
  -- to be corrected later, and correcting it is what the table forbids.
  --
  -- It is walked to CANCELLED rather than inserted as COMPLETED, because the
  -- database means both of its own rules: the request lines are frozen once the
  -- workshop owns the request (guard_request_item_immutability), and the status
  -- only moves along the legal graph (guard_purchase_request_transition).
  -- DRAFT -> CANCELLED is the one terminal transition with no content
  -- preconditions, so the fixture obeys the same rules the application does.
  insert into purchase_requests (org_id, request_number, job_number, requestor_id, status,
                                 need_by_date, need_by_time, delivery_location_id,
                                 delivery_method, created_by)
  values (org_a, 'PR-A-2', 'A-JOB', user_a, 'DRAFT', current_date, '07:00', loc_a, 'DELIVERY', user_a)
  returning id into req_a_done;

  insert into purchase_request_items (request_id, org_id, line_no, description, requested_qty, unit, created_by)
  values (req_a_done, org_a, 1, 'A cancelled widget', 10, 'ea', user_a)
  returning id into item_a_done;

  insert into purchase_request_items (request_id, org_id, line_no, description, requested_qty, unit, created_by)
  values (req_a_done, org_a, 2, 'A second cancelled widget', 4, 'ea', user_a)
  returning id into item_a_done2;

  -- Distinct lines for the forgery checks below. Aiming them at a request item
  -- that already has a history row would have them refused by the unique key
  -- instead of by the policy — a test that passes for the wrong reason.
  insert into purchase_request_items (request_id, org_id, line_no, description, requested_qty, unit, created_by)
  values (req_a_done, org_a, 3, 'A third cancelled widget', 1, 'ea', user_a)
  returning id into item_a_done3;

  insert into purchase_request_items (request_id, org_id, line_no, description, requested_qty, unit, created_by)
  values (req_a_done, org_a, 4, 'A fourth cancelled widget', 1, 'ea', user_a)
  returning id into item_a_done4;

  update purchase_requests
     set status = 'CANCELLED', cancel_reason = 'isolation fixture'
   where id = req_a_done;

  -- Tenant B's OWN request, still in flight. Without this, the premature-write
  -- check below aimed at a tenant A request and was refused by the composite
  -- foreign key — it proved the key, not the terminal-state rule.
  insert into purchase_requests (org_id, request_number, job_number, requestor_id, status,
                                 need_by_date, need_by_time, delivery_location_id,
                                 delivery_method, created_by)
  values (org_b, 'PR-B-1', 'B-JOB', user_b, 'DRAFT', current_date, '07:00', loc_b, 'DELIVERY', user_b)
  returning id into req_b;

  insert into purchase_request_items (request_id, org_id, line_no, description, requested_qty, unit, created_by)
  values (req_b, org_b, 1, 'B widget', 3, 'ea', user_b)
  returning id into item_b;

  -- One history row, written as the owner, so the read and mutation checks
  -- below have something real to aim at.
  insert into purchase_history_lines (
    org_id, terminal_state, recorded_by, request_id, request_number, request_item_id, line_no,
    job_number, normalized_description, normalizer_version, requested_description, unit,
    requested_qty, ordered_qty, requestor_id, outcome)
  values (org_a, 'CANCELLED', user_a, req_a_done, 'PR-A-2', item_a_done, 1,
          'A-JOB', 'a cancelled widget', 1, 'A cancelled widget', 'ea',
          10, 0, user_a, 'NOT_ORDERED')
  returning id into hist_a;

  -- --- become tenant B, exactly as PostgREST would -------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*) into visible from purchase_requests where id = req_a;
  if visible <> 0 then failures := failures + 1; raise warning 'LEAK: tenant B can read tenant A requests'; end if;

  select count(*) into visible from purchase_request_items where org_id = org_a;
  if visible <> 0 then failures := failures + 1; raise warning 'LEAK: tenant B can read tenant A line items'; end if;

  select count(*) into visible from purchase_delivery_locations where org_id = org_a;
  if visible <> 0 then failures := failures + 1; raise warning 'LEAK: tenant B can read tenant A locations'; end if;

  -- --- BR-012: the immutable history, from the other tenant's seat ----------
  --
  -- Its predecessor was a VIEW, and the defect 0019 fixed was that a view runs
  -- with its OWNER's privileges unless security_invoker is set — so RLS on the
  -- underlying tables was never evaluated for the caller. 0030 replaced it with
  -- a table, which removes that failure mode entirely and introduces its own
  -- question: can the other tenant read, write, edit or remove it?

  -- A missing GRANT raises here rather than returning zero. That is a refusal,
  -- so it is not a leak — but it must not abort the run either, because the
  -- check that a tenant can read its OWN history is further down and is the one
  -- that catches it. See 0031.
  begin
    select count(*) into visible from purchase_history_lines where org_id = org_a;
  exception when insufficient_privilege then visible := 0;
  end;
  if visible <> 0 then failures := failures + 1; raise warning 'LEAK: tenant B can read tenant A purchasing history'; end if;

  -- Naming the row directly must not help either. `where id = …` and
  -- `where org_id = …` are the same question to RLS, and a policy that only
  -- filtered the second would be a policy that leaks to anyone holding an id.
  begin
    select count(*) into visible from purchase_history_lines where id = hist_a;
  exception when insufficient_privilege then visible := 0;
  end;
  if visible <> 0 then failures := failures + 1; raise warning 'LEAK: tenant B can read a tenant A history row by id'; end if;

  -- Writing history INTO another organization must be refused, not accepted
  -- and hidden. This is the one that matters most: a tenant that could insert
  -- rows under org_a would be able to forge another company's purchase record.
  begin
    insert into purchase_history_lines (
      org_id, terminal_state, recorded_by, request_id, request_number, request_item_id, line_no,
      job_number, normalized_description, normalizer_version, requested_description, unit,
      requested_qty, ordered_qty, requestor_id, outcome)
    values (org_a, 'CANCELLED', user_b, req_a_done, 'PR-A-2-FORGED', item_a_done, 2,
            'A-JOB', 'forged', 1, 'forged', 'ea', 1, 0, user_b, 'NOT_ORDERED');
    failures := failures + 1;
    raise warning 'LEAK: tenant B wrote purchasing history into tenant A';
  exception when insufficient_privilege or check_violation then null;
  end;

  -- And history for its OWN organization still cannot be written against a
  -- request that has not ended. Without this the table would accept a row for a
  -- purchase in flight, which would then have to be corrected — the one thing
  -- an append-only record cannot do.
  begin
    insert into purchase_history_lines (
      org_id, terminal_state, recorded_by, request_id, request_number, request_item_id, line_no,
      job_number, normalized_description, normalizer_version, requested_description, unit,
      requested_qty, ordered_qty, requestor_id, outcome)
    values (org_b, 'COMPLETED', user_b, req_b, 'PR-B-1', item_b, 1,
            'B-JOB', 'premature', 1, 'premature', 'ea', 1, 0, user_b, 'NOT_ORDERED');
    failures := failures + 1;
    raise warning 'LEAK: history was written for a request that has not reached a terminal state';
  exception when insufficient_privilege or check_violation then null;
  end;

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

  -- --- the positive half: the application path must actually WORK -----------
  --
  -- An isolation suite that only proves refusals passes just as well on a table
  -- nobody can reach at all. That is not hypothetical here: 0030 shipped
  -- without a GRANT, so every one of the refusals above passed while the
  -- feature was completely unusable on Supabase. 0031 fixed it and these two
  -- checks are what would have caught it.

  -- The permission error is caught rather than allowed to abort the run: a
  -- missing GRANT is the exact defect 0031 fixed, and it should be REPORTED as
  -- one failure among the others rather than stopping the suite where it stands.
  begin
    select count(*) into visible from purchase_history_lines where org_id = org_a;
  exception when insufficient_privilege then
    visible := -1;
  end;
  if visible <> 1 then
    failures := failures + 1;
    raise warning 'BROKEN: tenant A cannot read its OWN purchasing history (grant or policy missing)';
  end if;

  begin
    insert into purchase_history_lines (
      org_id, terminal_state, recorded_by, request_id, request_number, request_item_id, line_no,
      job_number, normalized_description, normalizer_version, requested_description, unit,
      requested_qty, ordered_qty, requestor_id, outcome)
    values (org_a, 'CANCELLED', user_a, req_a_done, 'PR-A-2', item_a_done2, 2,
            'A-JOB', 'a second line', 1, 'A second line', 'ea', 4, 0, user_a, 'NOT_ORDERED');
  exception when others then
    failures := failures + 1;
    raise warning 'BROKEN: tenant A cannot write history for its own completed request (%)', sqlerrm;
  end;

  -- --- 0033: a row may not lie about who wrote it, or how the request ended --
  --
  -- Neither of these is a cross-tenant leak. Both are worse in the way that
  -- matters for evidence: a real user, inside their own organization, writing
  -- something untrue into the one record that is not re-derivable from
  -- anything else.

  begin
    insert into purchase_history_lines (
      org_id, terminal_state, recorded_by, request_id, request_number, request_item_id, line_no,
      job_number, normalized_description, normalizer_version, requested_description, unit,
      requested_qty, ordered_qty, requestor_id, outcome)
    values (org_a, 'CANCELLED', user_b, req_a_done, 'PR-A-2', item_a_done3, 3,
            'A-JOB', 'misattributed', 1, 'Misattributed', 'ea', 1, 0, user_a, 'NOT_ORDERED');
    failures := failures + 1;
    raise warning 'LEAK: a history row was attributed to someone other than the caller';
  exception when insufficient_privilege or check_violation then null;
  end;

  begin
    insert into purchase_history_lines (
      org_id, terminal_state, recorded_by, request_id, request_number, request_item_id, line_no,
      job_number, normalized_description, normalizer_version, requested_description, unit,
      requested_qty, ordered_qty, requestor_id, outcome)
    values (org_a, 'COMPLETED', user_a, req_a_done, 'PR-A-2', item_a_done4, 4,
            'A-JOB', 'wrong ending', 1, 'Wrong ending', 'ea', 1, 0, user_a, 'NOT_ORDERED');
    failures := failures + 1;
    raise warning 'LEAK: history claims a request COMPLETED when it was CANCELLED';
  exception when insufficient_privilege or check_violation then null;
  end;

  -- --- BR-012: nobody edits history, including its owner --------------------
  --
  -- Three fences, and the assertion is on the OUTCOME rather than on which one
  -- caught it: the privilege is not granted (0031), no UPDATE or DELETE policy
  -- exists (0030), and guard_no_update / guard_no_delete raise (0030). Any one
  -- refuses; all three must hold for the record to be evidence.

  begin
    update purchase_history_lines set vendor_name = 'tampered' where id = hist_a;
  exception when others then null;
  end;
  select count(*) into visible from purchase_history_lines
   where id = hist_a and vendor_name is distinct from 'tampered';
  if visible <> 1 then
    failures := failures + 1;
    raise warning 'LEAK: a purchasing history row was EDITED — history is not evidence';
  end if;

  begin
    delete from purchase_history_lines where id = hist_a;
  exception when others then null;
  end;
  select count(*) into visible from purchase_history_lines where id = hist_a;
  if visible <> 1 then
    failures := failures + 1;
    raise warning 'LEAK: a purchasing history row was DELETED — history is not evidence';
  end if;

  -- TRUNCATE is not a row operation: row level security does not apply to it
  -- and `for each row` triggers do not fire. Supabase's default privileges hand
  -- it to `authenticated` on every new table, so before 0032 one signed-in user
  -- of one organization could erase EVERY tenant's history in one statement —
  -- verified against the live stack, which is the only place it is visible.
  begin
    truncate purchase_history_lines;
  exception when others then null;
  end;

  -- The same two statements as the table OWNER, with row level security out of
  -- the picture entirely. This is the fence that still has to hold for a
  -- migration, a service-role client, or a person at psql.
  perform set_config('role', 'postgres', true);

  -- Counted as the owner, because a tenant B session cannot see tenant A's rows
  -- whether they still exist or not — asking B whether it destroyed something
  -- it cannot see would answer "gone" either way, and pass forever.
  select count(*) into visible from purchase_history_lines where org_id = org_a;
  if visible < 1 then
    failures := failures + 1;
    raise warning 'LEAK: purchasing history was TRUNCATED by another tenant — RLS does not apply to truncate';
  end if;

  begin
    truncate purchase_history_lines;
    failures := failures + 1;
    raise warning 'LEAK: the table owner truncated purchasing history — the no-truncate guard is missing';
  exception when others then null;
  end;

  begin
    update purchase_history_lines set vendor_name = 'tampered by owner' where id = hist_a;
    failures := failures + 1;
    raise warning 'LEAK: the table owner edited purchasing history — the no-update trigger is missing';
  exception when others then null;
  end;

  begin
    delete from purchase_history_lines where id = hist_a;
    failures := failures + 1;
    raise warning 'LEAK: the table owner deleted purchasing history — the no-delete trigger is missing';
  exception when others then null;
  end;

  if failures = 0 then
    raise notice 'tenant isolation: PASS';
  else
    raise exception 'tenant isolation: % failure(s) — see warnings above', failures;
  end if;
end $$;

rollback;
