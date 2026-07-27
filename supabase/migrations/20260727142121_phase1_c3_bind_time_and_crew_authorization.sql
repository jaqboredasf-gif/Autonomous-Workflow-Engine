-- C3: tenant-bind references and restrict foremen to declared crew membership.

create or replace function public.validate_time_entry_tenant()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.users u
    where u.id = new.user_id and u.org_id = new.org_id
  ) then
    raise exception 'time entry user is not in the row tenant';
  end if;
  if new.created_by is not null and not exists (
    select 1 from public.users u
    where u.id = new.created_by and u.org_id = new.org_id
  ) then
    raise exception 'time entry creator is not in the row tenant';
  end if;
  if new.job_site_id is not null and not exists (
    select 1 from public.job_sites j
    where j.id = new.job_site_id and j.org_id = new.org_id
  ) then
    raise exception 'time entry job site is not in the row tenant';
  end if;
  if new.cost_code_id is not null and not exists (
    select 1 from public.cost_codes c
    where c.id = new.cost_code_id and c.org_id = new.org_id
  ) then
    raise exception 'time entry cost code is not in the row tenant';
  end if;
  return new;
end
$$;

create or replace function public.validate_crew_tenant()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.users u
    where u.id = new.foreman_id
      and u.org_id = new.org_id
      and u.role = 'foreman'
      and u.is_active
  ) then
    raise exception 'crew foreman is not an active foreman in the crew tenant';
  end if;
  return new;
end
$$;

create or replace function public.validate_crew_member_tenant()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.crews c
    join public.users u on u.id = new.user_id and u.org_id = c.org_id
    where c.id = new.crew_id and u.is_active
  ) then
    raise exception 'crew member is not an active user in the crew tenant';
  end if;
  return new;
end
$$;

drop trigger if exists time_entries_validate_tenant on public.time_entries;
create trigger time_entries_validate_tenant
before insert or update of org_id, user_id, created_by, job_site_id, cost_code_id
on public.time_entries
for each row execute function public.validate_time_entry_tenant();

drop trigger if exists crews_validate_tenant on public.crews;
create trigger crews_validate_tenant
before insert or update of org_id, foreman_id on public.crews
for each row execute function public.validate_crew_tenant();

drop trigger if exists crew_members_validate_tenant on public.crew_members;
create trigger crew_members_validate_tenant
before insert or update of crew_id, user_id on public.crew_members
for each row execute function public.validate_crew_member_tenant();

drop policy if exists te_worker_read on public.time_entries;
drop policy if exists te_worker_insert on public.time_entries;
drop policy if exists te_worker_update on public.time_entries;
drop policy if exists te_foreman_update on public.time_entries;
drop policy if exists admin_all_time_entries on public.time_entries;

create policy te_authenticated_read on public.time_entries
for select to authenticated
using (
  org_id = (select public.current_org_id())
  and (
    user_id = (select auth.uid())
    or (select public.current_role_is('admin'))
    or (
      (select public.current_role_is('foreman'))
      and (
        created_by = (select auth.uid())
        or exists (
          select 1
          from public.crew_members cm
          join public.crews c on c.id = cm.crew_id
          where cm.user_id = time_entries.user_id
            and c.foreman_id = (select auth.uid())
            and c.org_id = time_entries.org_id
        )
      )
    )
  )
);

create policy te_authenticated_insert on public.time_entries
for insert to authenticated
with check (
  org_id = (select public.current_org_id())
  and (
    (
      user_id = (select auth.uid())
      and (created_by is null or created_by = (select auth.uid()))
    )
    or (
      (select public.current_role_is('foreman'))
      and created_by = (select auth.uid())
      and exists (
        select 1
        from public.crew_members cm
        join public.crews c on c.id = cm.crew_id
        where cm.user_id = time_entries.user_id
          and c.foreman_id = (select auth.uid())
          and c.org_id = time_entries.org_id
      )
    )
    or (select public.current_role_is('admin'))
  )
);

create policy te_authenticated_update on public.time_entries
for update to authenticated
using (
  org_id = (select public.current_org_id())
  and (
    (select public.current_role_is('admin'))
    or (
      status in ('open', 'submitted')
      and user_id = (select auth.uid())
    )
    or (
      status in ('open', 'submitted')
      and
      (select public.current_role_is('foreman'))
      and (
        created_by = (select auth.uid())
        or exists (
          select 1
          from public.crew_members cm
          join public.crews c on c.id = cm.crew_id
          where cm.user_id = time_entries.user_id
            and c.foreman_id = (select auth.uid())
            and c.org_id = time_entries.org_id
        )
      )
    )
  )
)
with check (
  org_id = (select public.current_org_id())
  and (
    (select public.current_role_is('admin'))
    or (
      status in ('open', 'submitted')
      and user_id = (select auth.uid())
    )
    or (
      status in ('open', 'submitted', 'approved')
      and
      (select public.current_role_is('foreman'))
      and exists (
        select 1
        from public.crew_members cm
        join public.crews c on c.id = cm.crew_id
        where cm.user_id = time_entries.user_id
          and c.foreman_id = (select auth.uid())
          and c.org_id = time_entries.org_id
      )
    )
  )
);

create policy crews_authorized_read on public.crews
for select to authenticated
using (
  org_id = (select public.current_org_id())
  and (
    foreman_id = (select auth.uid())
    or (select public.current_role_is('admin'))
  )
);

create policy crews_admin_manage on public.crews
for all to authenticated
using (
  org_id = (select public.current_org_id())
  and (select public.current_role_is('admin'))
)
with check (
  org_id = (select public.current_org_id())
  and (select public.current_role_is('admin'))
);

create policy crew_members_authorized_read on public.crew_members
for select to authenticated
using (
  exists (
    select 1 from public.crews c
    where c.id = crew_members.crew_id
      and c.org_id = (select public.current_org_id())
      and (
        c.foreman_id = (select auth.uid())
        or (select public.current_role_is('admin'))
      )
  )
);

create policy crew_members_admin_manage on public.crew_members
for all to authenticated
using (
  (select public.current_role_is('admin'))
  and exists (
    select 1 from public.crews c
    where c.id = crew_members.crew_id
      and c.org_id = (select public.current_org_id())
  )
)
with check (
  (select public.current_role_is('admin'))
  and exists (
    select 1 from public.crews c
    where c.id = crew_members.crew_id
      and c.org_id = (select public.current_org_id())
  )
);

revoke execute on function public.validate_time_entry_tenant() from public, anon, authenticated;
revoke execute on function public.validate_crew_tenant() from public, anon, authenticated;
revoke execute on function public.validate_crew_member_tenant() from public, anon, authenticated;
grant execute on function public.validate_time_entry_tenant() to service_role;
grant execute on function public.validate_crew_tenant() to service_role;
grant execute on function public.validate_crew_member_tenant() to service_role;
