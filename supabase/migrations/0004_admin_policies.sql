-- Admin dashboard needs: read org + settings, edit settings (payroll rules
-- input form), manage job sites / cost codes / employees.

create policy org_members_read_org on orgs
  for select using (id = current_org_id());

create policy org_members_read_settings on org_settings
  for select using (org_id = current_org_id());

create policy admin_update_settings on org_settings
  for update using (org_id = current_org_id() and current_role_is('admin'));

create policy admin_insert_users on users
  for insert with check (org_id = current_org_id() and current_role_is('admin'));

create policy admin_update_users on users
  for update using (org_id = current_org_id() and current_role_is('admin'));

create policy admin_write_job_sites on job_sites
  for all using (org_id = current_org_id() and current_role_is('admin'));

create policy admin_write_cost_codes on cost_codes
  for all using (org_id = current_org_id() and current_role_is('admin'));
