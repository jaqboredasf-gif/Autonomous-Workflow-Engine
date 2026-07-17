-- Punch immutability + first-class corrections (spec rules 8 & 10).
-- Original punch times can never be overwritten directly: changes go through
-- a correction record carrying original values, corrected values, reason,
-- requester, approver, and timestamps. Non-destructive: adds objects only.

create table timecard_corrections (
  id               uuid primary key default uuid_generate_v4(),
  org_id           uuid not null references orgs(id) on delete cascade,
  time_entry_id    uuid not null references time_entries(id) on delete cascade,
  requested_by     uuid not null references users(id),
  reason           text not null,
  original_values  jsonb not null default '{}'::jsonb,  -- captured server-side
  corrected_values jsonb not null,                       -- e.g. {"clock_out": "...", "cost_code_id": "..."}
  status           text not null default 'pending'
                   check (status in ('pending', 'approved', 'rejected')),
  approved_by      uuid references users(id),
  applied_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index timecard_corrections_org_idx on timecard_corrections(org_id, status);

alter table timecard_corrections enable row level security;

create policy corrections_read on timecard_corrections
  for select using (
    org_id = current_org_id()
    and (requested_by = auth.uid() or current_role_is('admin') or current_role_is('foreman'))
  );

create policy corrections_request on timecard_corrections
  for insert with check (org_id = current_org_id() and requested_by = auth.uid());

-- Reject only; approval goes through apply_timecard_correction().
create policy corrections_admin_update on timecard_corrections
  for update using (org_id = current_org_id() and current_role_is('admin'))
  with check (status in ('pending', 'rejected'));

-- Capture the original values at request time, server-side (never trusted
-- from the client).
create or replace function capture_correction_original() returns trigger
language plpgsql security definer as $$
declare e time_entries%rowtype;
begin
  select * into e from time_entries where id = new.time_entry_id;
  if e.id is null then
    raise exception 'time entry % not found', new.time_entry_id;
  end if;
  new.original_values := jsonb_build_object(
    'clock_in', e.clock_in, 'clock_out', e.clock_out,
    'cost_code_id', e.cost_code_id, 'job_site_id', e.job_site_id,
    'notes', e.notes, 'status', e.status
  );
  return new;
end $$;

create trigger timecard_corrections_capture
  before insert on timecard_corrections
  for each row execute function capture_correction_original();

-- Immutability guard on time_entries:
--   clock_in never changes directly; clock_out may be SET once (the normal
--   punch-out) but never changed after. Approved corrections bypass via a
--   transaction-local flag only apply_timecard_correction() sets.
create or replace function guard_punch_immutability() returns trigger
language plpgsql as $$
begin
  if current_setting('app.correction', true) = 'on' then
    return new;
  end if;
  if new.clock_in is distinct from old.clock_in then
    raise exception 'punch times are immutable — file a timecard correction';
  end if;
  if old.clock_out is not null and new.clock_out is distinct from old.clock_out then
    raise exception 'punch times are immutable — file a timecard correction';
  end if;
  return new;
end $$;

create trigger time_entries_immutability
  before update on time_entries
  for each row execute function guard_punch_immutability();

-- Admin-only application of a pending correction.
create or replace function apply_timecard_correction(p_correction_id uuid)
returns jsonb language plpgsql security definer as $$
declare
  c timecard_corrections%rowtype;
begin
  if not current_role_is('admin') then
    raise exception 'only admins can apply corrections';
  end if;
  select * into c from timecard_corrections where id = p_correction_id for update;
  if c.id is null then
    raise exception 'correction not found';
  end if;
  if c.status <> 'pending' then
    raise exception 'correction already %', c.status;
  end if;

  perform set_config('app.correction', 'on', true);
  update time_entries set
    clock_in     = coalesce((c.corrected_values->>'clock_in')::timestamptz, clock_in),
    clock_out    = coalesce((c.corrected_values->>'clock_out')::timestamptz, clock_out),
    cost_code_id = coalesce((c.corrected_values->>'cost_code_id')::uuid, cost_code_id),
    notes        = coalesce(c.corrected_values->>'notes', notes)
  where id = c.time_entry_id;
  perform set_config('app.correction', 'off', true);

  update timecard_corrections
     set status = 'approved', approved_by = auth.uid(),
         applied_at = now(), updated_at = now()
   where id = p_correction_id;

  return jsonb_build_object('applied', true, 'time_entry_id', c.time_entry_id);
end $$;

-- n8n events: request + application.
create or replace function emit_correction_events() returns trigger
language plpgsql security definer as $$
begin
  if tg_op = 'INSERT' then
    perform emit_event('timecard.correction_requested', 'timecard_correction', new.id, new.org_id,
      jsonb_build_object('time_entry_id', new.time_entry_id, 'requested_by', new.requested_by,
                         'reason', new.reason, 'corrected_values', new.corrected_values));
  elsif tg_op = 'UPDATE' and new.status = 'approved' and old.status = 'pending' then
    perform emit_event('timecard.correction_applied', 'timecard_correction', new.id, new.org_id,
      jsonb_build_object('time_entry_id', new.time_entry_id, 'approved_by', new.approved_by));
  end if;
  return new;
end $$;

create trigger timecard_corrections_events
  after insert or update on timecard_corrections
  for each row execute function emit_correction_events();
