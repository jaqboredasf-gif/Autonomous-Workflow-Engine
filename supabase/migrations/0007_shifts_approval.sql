-- Scheduling core (calendar-agnostic — M365 Graph sync attaches later) and
-- approval-flow hardening: workers can no longer self-approve, and any edit
-- to an approved/locked entry writes an audit row automatically.

-- ---------------------------------------------------------------------------
-- Shifts
-- ---------------------------------------------------------------------------

create type shift_status as enum ('planned', 'published', 'cancelled');

create table shifts (
  id           uuid primary key default uuid_generate_v4(),
  org_id       uuid not null references orgs(id) on delete cascade,
  user_id      uuid not null references users(id),
  job_site_id  uuid references job_sites(id),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  status       shift_status not null default 'planned',
  notes        text,
  created_by   uuid references users(id),
  -- set when the shift has been pushed to the M365 calendar (Phase 4 sync)
  external_event_id text,
  created_at   timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index shifts_org_time_idx on shifts(org_id, starts_at);
create index shifts_user_idx on shifts(user_id, starts_at);

alter table shifts enable row level security;

create policy shifts_org_read on shifts
  for select using (org_id = current_org_id());

create policy shifts_manage on shifts
  for all using (
    org_id = current_org_id()
    and (current_role_is('admin') or current_role_is('foreman'))
  );

-- ---------------------------------------------------------------------------
-- Approval-flow hardening
-- ---------------------------------------------------------------------------

-- Workers may edit their own open/submitted entries but can only move them
-- between those two states — approval requires foreman/admin.
drop policy te_worker_update on time_entries;
create policy te_worker_update on time_entries
  for update using (
    org_id = current_org_id()
    and user_id = auth.uid()
    and status in ('open', 'submitted')
  )
  with check (status in ('open', 'submitted'));

drop policy te_foreman_update on time_entries;
create policy te_foreman_update on time_entries
  for update using (
    org_id = current_org_id()
    and current_role_is('foreman')
    and status in ('open', 'submitted')
  )
  with check (status in ('open', 'submitted', 'approved'));

-- Locking (approved -> locked) is admin-only via admin_all_time_entries.

-- Audit trail: edits to approved/locked entries never mutate silently.
-- edited_by is null when the change came through the service role.
alter table time_entry_audits alter column edited_by drop not null;

create or replace function audit_time_entry_edit() returns trigger
language plpgsql security definer as $$
begin
  if old.status in ('approved', 'locked') then
    insert into time_entry_audits (time_entry_id, edited_by, old_values, new_values)
    values (old.id, auth.uid(), to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end $$;

create trigger time_entries_audit
  after update on time_entries
  for each row execute function audit_time_entry_edit();
