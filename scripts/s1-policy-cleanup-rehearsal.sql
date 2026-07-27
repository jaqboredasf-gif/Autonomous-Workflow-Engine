-- =============================================================================
-- S1 REHEARSAL — DRY-RUN INSTRUMENT ONLY. NEVER APPLY THIS FILE.
-- =============================================================================
-- Purpose: drop the 16 undeclared client policies inside a transaction, assert
-- the resulting state, then ROLL BACK. This file exists solely for validation
-- and testing of the S1 change. It is not, and must never become, the artifact
-- that is applied to production.
--
-- THIS FILE INTENTIONALLY WRITES TEMPORARY PROBE DATA. Beyond the 16 drops it
-- mutates live data to prove the surviving paths still work: it emits an
-- `S1.DEFINER_PROBE` event (B5), appends ` s1-probe` to the `notes` of every
-- `approved` time entry and writes an audit row (C1), and issues probe
-- delete/insert statements against `integration_events`, `crews` and
-- `time_entry_audits` (B2-B4, B7). Those writes are safe ONLY because the
-- transaction is discarded.
--
-- ANY REHEARSAL EXECUTION MUST END IN ROLLBACK. Do not change the final
-- `rollback;` to `commit;`, do not append a `commit;`, and do not run this file
-- through any wrapper that commits on success. Doing so writes every probe
-- above permanently into the production audit log.
--
-- THE ONLY AUTHORIZED PRODUCTION MIGRATION IS:
--     supabase/migrations/0016_drop_undeclared_client_policies.sql
-- Apply that file and nothing else. Do not describe, adapt or reuse this
-- rehearsal as an apply procedure.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- PRE-CHANGE ASSERTIONS
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  -- P1: exactly 16 policies on the four affected tables
  select count(*) into n from pg_policies
   where schemaname='public'
     and tablename in ('integration_events','time_entry_audits','crews','crew_members');
  if n <> 16 then raise exception 'PRE P1 FAIL: expected 16 policies on the 4 tables, found %', n; end if;

  -- P2: all 16 match the orphan naming convention and target role `authenticated`
  select count(*) into n from pg_policies
   where schemaname='public'
     and tablename in ('integration_events','time_entry_audits','crews','crew_members')
     and policyname ~ '^(integration_events|time_entry_audits|crews|crew_members)_org_(select|insert|update|delete)$'
     and roles::text = '{authenticated}';
  if n <> 16 then raise exception 'PRE P2 FAIL: only % of 16 match the orphan name+role fingerprint', n; end if;

  -- P3: 55 policies live in public overall (39 repo-declared + these 16)
  select count(*) into n from pg_policies where schemaname='public';
  if n <> 55 then raise exception 'PRE P3 FAIL: expected 55 public policies, found %', n; end if;

  -- P4: RLS is ON and NOT forced on all four tables (so definer functions still bypass)
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='public'
     and c.relname in ('integration_events','time_entry_audits','crews','crew_members')
     and c.relrowsecurity and not c.relforcerowsecurity and pg_get_userbyid(c.relowner)='postgres';
  if n <> 4 then raise exception 'PRE P4 FAIL: RLS/ownership precondition holds for only % of 4 tables', n; end if;

  -- P5: the only functions touching these tables are SECURITY DEFINER, owned by postgres
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public'
     and p.prosrc ~* '(integration_events|time_entry_audits|crew_members|\mcrews\M)'
     and not (p.prosecdef and pg_get_userbyid(p.proowner)='postgres');
  if n <> 0 then raise exception 'PRE P5 FAIL: % dependent function(s) are not definer/postgres-owned', n; end if;

  -- P6: the orphan `ensure_rls` event trigger is gone (would re-create policies on DDL)
  if exists (select 1 from pg_event_trigger where evtname='ensure_rls') then
    raise exception 'PRE P6 FAIL: ensure_rls event trigger present';
  end if;

  -- P7: crews / crew_members are empty (nothing to lose access to)
  if (select count(*) from crews) <> 0 or (select count(*) from crew_members) <> 0 then
    raise exception 'PRE P7 FAIL: crews/crew_members are no longer empty';
  end if;
end $$;

-- Row-count baseline: this change must not delete a single row.
create temp table s1_baseline as
select (select count(*) from integration_events)                                    as events,
       (select count(*) from integration_events where event_type='message.approved') as approved_events,
       (select count(*) from time_entry_audits)                                      as audits,
       (select count(*) from crews)                                                  as crews,
       (select count(*) from crew_members)                                           as crew_members;

-- ---------------------------------------------------------------------------
-- CHANGE — 16 drops, no CASCADE, no other object touched
-- ---------------------------------------------------------------------------
drop policy if exists integration_events_org_select  on public.integration_events;
drop policy if exists integration_events_org_insert  on public.integration_events;
drop policy if exists integration_events_org_update  on public.integration_events;
drop policy if exists integration_events_org_delete  on public.integration_events;

drop policy if exists time_entry_audits_org_select   on public.time_entry_audits;
drop policy if exists time_entry_audits_org_insert   on public.time_entry_audits;
drop policy if exists time_entry_audits_org_update   on public.time_entry_audits;
drop policy if exists time_entry_audits_org_delete   on public.time_entry_audits;

drop policy if exists crews_org_select               on public.crews;
drop policy if exists crews_org_insert               on public.crews;
drop policy if exists crews_org_update               on public.crews;
drop policy if exists crews_org_delete               on public.crews;

drop policy if exists crew_members_org_select        on public.crew_members;
drop policy if exists crew_members_org_insert        on public.crew_members;
drop policy if exists crew_members_org_update        on public.crew_members;
drop policy if exists crew_members_org_delete        on public.crew_members;

-- ---------------------------------------------------------------------------
-- POST-CHANGE ASSERTIONS — structure
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  -- A1: zero client policies remain on the four tables (0009's stated contract)
  select count(*) into n from pg_policies
   where schemaname='public'
     and tablename in ('integration_events','time_entry_audits','crews','crew_members');
  if n <> 0 then raise exception 'POST A1 FAIL: % policies remain', n; end if;

  -- A2: RLS still enabled on all four (dropping policies must not disable RLS)
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='public'
     and c.relname in ('integration_events','time_entry_audits','crews','crew_members')
     and c.relrowsecurity;
  if n <> 4 then raise exception 'POST A2 FAIL: RLS enabled on only % of 4 tables', n; end if;

  -- A3: every repo-declared policy is untouched — 55 - 16 = 39
  select count(*) into n from pg_policies where schemaname='public';
  if n <> 39 then raise exception 'POST A3 FAIL: expected 39 remaining public policies, found %', n; end if;

  -- A4: no rows were deleted by the change
  if exists (
    select 1 from s1_baseline b
     where b.events       <> (select count(*) from integration_events)
        or b.approved_events <> (select count(*) from integration_events where event_type='message.approved')
        or b.audits       <> (select count(*) from time_entry_audits)
        or b.crews        <> (select count(*) from crews)
        or b.crew_members <> (select count(*) from crew_members)
  ) then raise exception 'POST A4 FAIL: row counts changed'; end if;

  -- A5: no other schema object was dropped (tables, functions, triggers intact)
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='public' and c.relkind='r';
  if n <> 24 then raise exception 'POST A5 FAIL: expected 24 base tables, found %', n; end if;
  if to_regprocedure('public.emit_event(text,text,uuid,uuid,jsonb)') is null
     or to_regprocedure('public.audit_time_entry_edit()') is null then
    raise exception 'POST A5 FAIL: a dependent function disappeared';
  end if;
  if not exists (select 1 from pg_trigger where tgname='time_entries_audit' and not tgisinternal) then
    raise exception 'POST A5 FAIL: time_entries_audit trigger missing';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- POST-CHANGE ASSERTIONS — behaviour under a real client JWT
-- The fixture worker f1000000-…-001 is the same principal slice 4/5 use.
-- ---------------------------------------------------------------------------
do $$
declare n int; denied boolean;
begin
  perform set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';

  -- B1: worker reads zero events (was 377)
  select count(*) into n from integration_events;
  if n <> 0 then raise exception 'POST B1 FAIL: worker still reads % events', n; end if;

  -- B2: worker cannot delete events (was: 16 message.approved deleted)
  begin
    delete from integration_events where event_type='message.approved';
    if found then raise exception 'POST B2 FAIL: worker deleted event rows'; end if;
  exception when insufficient_privilege then null;
  end;

  -- B3: worker cannot forge an event
  denied := false;
  begin
    insert into integration_events (event_type, entity_type, entity_id, org_id, payload)
    values ('S1.FORGED_PROBE','probe', gen_random_uuid(), '2b219aa5-1148-4e3e-a1a0-1725d62b935c', '{}'::jsonb);
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'POST B3 FAIL: worker inserted a forged event'; end if;

  -- B4: worker cannot create a crew
  denied := false;
  begin
    insert into crews (org_id, name, foreman_id)
    values ('2b219aa5-1148-4e3e-a1a0-1725d62b935c','S1 PROBE CREW','f1000000-0000-4000-8000-000000000001');
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'POST B4 FAIL: worker created a crew'; end if;

  -- B5: the SECURITY DEFINER event path still works from a client session
  perform emit_event('S1.DEFINER_PROBE','probe', gen_random_uuid(),
                     '2b219aa5-1148-4e3e-a1a0-1725d62b935c', '{"probe":true}'::jsonb);
end $$;

do $$
declare n int; denied boolean;
begin
  -- SET LOCAL inside a DO block survives to end of transaction, so the previous
  -- block left us as `authenticated`. Come back to the privileged role first.
  execute 'reset role';

  -- B6: emit_event() actually wrote (checked back as the privileged role)
  select count(*) into n from integration_events where event_type='S1.DEFINER_PROBE';
  if n <> 1 then raise exception 'POST B6 FAIL: emit_event wrote % rows from a client session', n; end if;

  -- B7: the audited user can no longer read, delete or forge their own audit rows
  perform set_config('request.jwt.claims','{"sub":"22f34395-0e5a-400b-af49-62c2500c7da7","role":"authenticated"}', true);
  execute 'set local role authenticated';
  select count(*) into n from time_entry_audits;
  if n <> 0 then raise exception 'POST B7 FAIL: audited user still reads % audit rows', n; end if;
  begin
    delete from time_entry_audits;
    if found then raise exception 'POST B7 FAIL: audited user deleted audit rows'; end if;
  exception when insufficient_privilege then null;
  end;
  denied := false;
  begin
    insert into time_entry_audits (time_entry_id, edited_by, old_values, new_values)
    values ('5edfd051-9f64-419b-a099-030825b057b1', null, '{}'::jsonb, '{}'::jsonb);
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'POST B7 FAIL: audited user forged an audit row'; end if;
end $$;

do $$
declare n int;
begin
  execute 'reset role';
  -- B8: anon (logged-out) was never granted by these policies and still reads 0.
  -- This is slice 1 check 5's assertion, executed against the post-drop catalog.
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
  select count(*) into n from integration_events;
  if n <> 0 then raise exception 'POST B8 FAIL: anon reads % events', n; end if;
  select count(*) into n from time_entry_audits;
  if n <> 0 then raise exception 'POST B8 FAIL: anon reads % audits', n; end if;
end $$;

-- ---------------------------------------------------------------------------
-- POST-CHANGE ASSERTIONS — the audit trigger still writes
-- ---------------------------------------------------------------------------
do $$
declare before_n int; after_n int;
begin
  execute 'reset role';
  select count(*) into before_n from time_entry_audits;
  update time_entries set notes = coalesce(notes,'') || ' s1-probe' where status='approved';
  select count(*) into after_n from time_entry_audits;
  if after_n <> before_n + 1 then
    raise exception 'POST C1 FAIL: audit trigger wrote % rows (expected 1)', after_n - before_n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- DRY-RUN ONLY
-- ---------------------------------------------------------------------------
rollback;
