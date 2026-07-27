-- S1 ROLLBACK: recreate the 16 dropped policies exactly as captured from
-- pg_policies on 2026-07-26 before the drop. Restores the pre-S1 state.
begin;
create policy crew_members_org_delete on public.crew_members as permissive for delete to authenticated
  using ((EXISTS ( SELECT 1
   FROM crews c
  WHERE ((c.id = crew_members.crew_id) AND (c.org_id = current_org_id())))));
create policy crew_members_org_insert on public.crew_members as permissive for insert to authenticated
  with check ((EXISTS ( SELECT 1
   FROM crews c
  WHERE ((c.id = crew_members.crew_id) AND (c.org_id = current_org_id())))));
create policy crew_members_org_select on public.crew_members as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM crews c
  WHERE ((c.id = crew_members.crew_id) AND (c.org_id = current_org_id())))));
create policy crew_members_org_update on public.crew_members as permissive for update to authenticated
  using ((EXISTS ( SELECT 1
   FROM crews c
  WHERE ((c.id = crew_members.crew_id) AND (c.org_id = current_org_id())))))
  with check ((EXISTS ( SELECT 1
   FROM crews c
  WHERE ((c.id = crew_members.crew_id) AND (c.org_id = current_org_id())))));
create policy crews_org_delete on public.crews as permissive for delete to authenticated
  using ((org_id = current_org_id()));
create policy crews_org_insert on public.crews as permissive for insert to authenticated
  with check ((org_id = current_org_id()));
create policy crews_org_select on public.crews as permissive for select to authenticated
  using ((org_id = current_org_id()));
create policy crews_org_update on public.crews as permissive for update to authenticated
  using ((org_id = current_org_id()))
  with check ((org_id = current_org_id()));
create policy integration_events_org_delete on public.integration_events as permissive for delete to authenticated
  using ((org_id = current_org_id()));
create policy integration_events_org_insert on public.integration_events as permissive for insert to authenticated
  with check ((org_id = current_org_id()));
create policy integration_events_org_select on public.integration_events as permissive for select to authenticated
  using ((org_id = current_org_id()));
create policy integration_events_org_update on public.integration_events as permissive for update to authenticated
  using ((org_id = current_org_id()))
  with check ((org_id = current_org_id()));
create policy time_entry_audits_org_delete on public.time_entry_audits as permissive for delete to authenticated
  using ((EXISTS ( SELECT 1
   FROM time_entries te
  WHERE ((te.id = time_entry_audits.time_entry_id) AND (te.org_id = current_org_id())))));
create policy time_entry_audits_org_insert on public.time_entry_audits as permissive for insert to authenticated
  with check ((EXISTS ( SELECT 1
   FROM time_entries te
  WHERE ((te.id = time_entry_audits.time_entry_id) AND (te.org_id = current_org_id())))));
create policy time_entry_audits_org_select on public.time_entry_audits as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM time_entries te
  WHERE ((te.id = time_entry_audits.time_entry_id) AND (te.org_id = current_org_id())))));
create policy time_entry_audits_org_update on public.time_entry_audits as permissive for update to authenticated
  using ((EXISTS ( SELECT 1
   FROM time_entries te
  WHERE ((te.id = time_entry_audits.time_entry_id) AND (te.org_id = current_org_id())))))
  with check ((EXISTS ( SELECT 1
   FROM time_entries te
  WHERE ((te.id = time_entry_audits.time_entry_id) AND (te.org_id = current_org_id())))));
commit;
