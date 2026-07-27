-- C1: reconcile live-only policies with the repository declaration.
-- RLS remains enabled; these four audit/integration tables are service-role only.

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

do $$
declare
  policy_count integer;
  rls_count integer;
begin
  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename in (
      'integration_events', 'time_entry_audits', 'crews', 'crew_members'
    );

  if policy_count <> 0 then
    raise exception 'C1 failed: % client policies remain', policy_count;
  end if;

  select count(*) into rls_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'integration_events', 'time_entry_audits', 'crews', 'crew_members'
    )
    and c.relrowsecurity;

  if rls_count <> 4 then
    raise exception 'C1 failed: RLS enabled on % of 4 protected tables', rls_count;
  end if;
end
$$;
