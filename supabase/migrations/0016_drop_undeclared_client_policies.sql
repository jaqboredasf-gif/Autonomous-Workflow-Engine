-- ===========================================================================
-- S1 MIGRATION — PROMOTED, NOT YET APPLIED.
--
-- Promoted from scripts/s1-migration-0016-PENDING.sql after the required live
-- inventory check, full regression baseline, rehearsal, and BEGIN/ROLLBACK
-- migration dry-run. It remains unapplied until explicit user approval.
--
-- WHAT IT DOES
-- Drops the 16 client RLS policies found on the live project 2026-07-26 and
-- re-verified 2026-07-27. No migration in this repo creates them; they are
-- residue of the orphan schema that 0012 removed (DECISION_LOG 2026-07-17 B1).
-- All 16 are `TO authenticated` while every repo-declared policy is `TO public`.
-- They gate on current_org_id() with no role check, so any authenticated org
-- member can read, forge and DELETE integration_events, and the owner of an
-- edited time entry can read, delete and forge that entry's own audit rows.
--
-- Repo intent for all four tables is service-role only — RLS on, no client
-- policy: 0002 (crews, crew_members, time_entry_audits), 0009 (integration_events,
-- comment: "Service-role only: RLS on, no client policies.").
--
-- This removes access. It never grants any. RLS stays ENABLED on every table,
-- no row is read, written or deleted, and no other object is touched.
--
-- REPLAYABLE: on a database built from 0001-0015 these policies never existed,
-- so every statement is a no-op and the post-conditions still hold.
--
-- ROLLBACK: DROP POLICY is not recoverable after commit — rollback is re-create.
-- scripts/s1-policy-cleanup-rollback.sql restores all 16 byte-identically
-- (verified by round-trip 2026-07-27). Restoring re-opens the vulnerability; the
-- correct answer to a real consumer need is a narrow, role-gated policy in a new
-- migration, not a wholesale restore.
-- ===========================================================================

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

-- Self-guarding post-conditions. These hold both on the live project and on a
-- fresh replay, and abort the transaction if the outcome is not what the
-- migration claims. Deliberately no pre-condition on "exactly 16 exist" — that
-- belongs in the apply wrapper, not in a file that must replay on a clean DB.
do $$
declare n int;
begin
  select count(*) into n from pg_policies
   where schemaname='public'
     and tablename in ('integration_events','time_entry_audits','crews','crew_members');
  if n <> 0 then
    raise exception '0016 FAIL: % client policies remain on the service-role-only tables', n;
  end if;

  select count(*) into n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='public'
     and c.relname in ('integration_events','time_entry_audits','crews','crew_members')
     and c.relrowsecurity;
  if n <> 4 then
    raise exception '0016 FAIL: RLS is enabled on only % of the 4 tables', n;
  end if;

  if to_regprocedure('public.emit_event(text,text,uuid,uuid,jsonb)') is null
     or to_regprocedure('public.audit_time_entry_edit()') is null then
    raise exception '0016 FAIL: a dependent SECURITY DEFINER function is missing';
  end if;
end $$;
