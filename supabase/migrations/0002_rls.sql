-- Row-level security: every row is scoped to the caller's org;
-- workers see only their own time entries, foremen see their crew, admins see all.

alter table orgs              enable row level security;
alter table org_settings      enable row level security;
alter table users             enable row level security;
alter table crews             enable row level security;
alter table crew_members      enable row level security;
alter table job_sites         enable row level security;
alter table cost_codes        enable row level security;
alter table time_entries      enable row level security;
alter table time_entry_audits enable row level security;
alter table pay_periods       enable row level security;
alter table payroll_exports   enable row level security;

-- Helper: current user's org and role.
create or replace function current_org_id() returns uuid
language sql stable security definer as $$
  select org_id from users where id = auth.uid()
$$;

create or replace function current_role_is(r user_role) returns boolean
language sql stable security definer as $$
  select exists (select 1 from users where id = auth.uid() and role = r)
$$;

-- Org-scoped read for reference data.
create policy org_read_job_sites on job_sites
  for select using (org_id = current_org_id());

create policy org_read_cost_codes on cost_codes
  for select using (org_id = current_org_id());

create policy org_read_users on users
  for select using (org_id = current_org_id());

-- Time entries: workers insert/read own; foremen also rows they created;
-- admins full access within org.
create policy te_worker_read on time_entries
  for select using (
    org_id = current_org_id()
    and (user_id = auth.uid() or created_by = auth.uid()
         or current_role_is('admin') or current_role_is('foreman'))
  );

create policy te_worker_insert on time_entries
  for insert with check (
    org_id = current_org_id()
    and (user_id = auth.uid() or created_by = auth.uid())
  );

-- Only open/submitted entries are editable by their owner; approved/locked
-- entries change only through the audited admin path (service role + audit row).
create policy te_worker_update on time_entries
  for update using (
    org_id = current_org_id()
    and user_id = auth.uid()
    and status in ('open', 'submitted')
  );

create policy admin_all_time_entries on time_entries
  for all using (org_id = current_org_id() and current_role_is('admin'));

-- Payroll objects: admin only.
create policy admin_pay_periods on pay_periods
  for all using (org_id = current_org_id() and current_role_is('admin'));

create policy admin_exports on payroll_exports
  for all using (
    exists (select 1 from pay_periods p
            where p.id = pay_period_id and p.org_id = current_org_id())
    and current_role_is('admin')
  );
