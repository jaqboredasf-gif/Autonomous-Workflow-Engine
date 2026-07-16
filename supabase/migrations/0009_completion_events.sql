-- Slice 1: integration-event spine for n8n, completion reports, and
-- evidence-grade punch capture (GPS accuracy + measured distance).

-- ---------------------------------------------------------------------------
-- Integration events — the durable n8n contract. n8n consumers poll/receive
-- these, process idempotently keyed on id, and write status back.
-- ---------------------------------------------------------------------------

create table integration_events (
  id                uuid primary key default uuid_generate_v4(),
  event_type        text not null,
  schema_version    int not null default 1,
  occurred_at       timestamptz not null default now(),
  source            text not null default 'db',
  entity_type       text not null,
  entity_id         uuid not null,
  org_id            uuid not null references orgs(id) on delete cascade,
  payload           jsonb not null,
  processing_status text not null default 'pending'
                    check (processing_status in ('pending','processing','done','error','ignored')),
  attempt_count     int not null default 0,
  last_error        text,
  processed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index integration_events_pending_idx
  on integration_events(processing_status, occurred_at);
create index integration_events_entity_idx
  on integration_events(entity_type, entity_id);

-- Service-role only: RLS on, no client policies.
alter table integration_events enable row level security;

create or replace function emit_event(
  p_type text, p_entity_type text, p_entity_id uuid, p_org uuid, p_payload jsonb
) returns void language sql security definer as $$
  insert into integration_events (event_type, entity_type, entity_id, org_id, payload)
  values (p_type, p_entity_type, p_entity_id, p_org, p_payload);
$$;

-- ---------------------------------------------------------------------------
-- Punch evidence: GPS accuracy + measured distance from the fence center.
-- Geofence v2 gives the worker the benefit of GPS error: inside when
-- distance <= radius + reported accuracy. Full evidence stored either way —
-- flags mark for review, they never accuse.
-- ---------------------------------------------------------------------------

alter table time_entries
  add column in_accuracy_m  double precision,
  add column out_accuracy_m double precision,
  add column in_distance_m  double precision,
  add column out_distance_m double precision;

create or replace function set_geo_flags() returns trigger
language plpgsql as $$
declare
  s job_sites%rowtype;
begin
  if new.job_site_id is not null then
    select * into s from job_sites where id = new.job_site_id;
  end if;

  if s.id is null or new.in_lat is null or new.in_lng is null then
    new.in_geo_flag := 'no_gps';
    new.in_distance_m := null;
  else
    new.in_distance_m := haversine_m(new.in_lat, new.in_lng, s.lat, s.lng);
    if new.in_distance_m <= s.radius_m + coalesce(new.in_accuracy_m, 0) then
      new.in_geo_flag := 'inside';
    else
      new.in_geo_flag := 'outside';
    end if;
  end if;

  if new.clock_out is not null then
    if s.id is null or new.out_lat is null or new.out_lng is null then
      new.out_geo_flag := 'no_gps';
      new.out_distance_m := null;
    else
      new.out_distance_m := haversine_m(new.out_lat, new.out_lng, s.lat, s.lng);
      if new.out_distance_m <= s.radius_m + coalesce(new.out_accuracy_m, 0) then
        new.out_geo_flag := 'inside';
      else
        new.out_geo_flag := 'outside';
      end if;
    end if;
  end if;

  return new;
end $$;

-- Event emission for punches: created on insert; flagged when a flag first
-- turns outside (insert or update), exactly once per boundary crossing.
create or replace function emit_punch_events() returns trigger
language plpgsql security definer as $$
begin
  if tg_op = 'INSERT' then
    perform emit_event('punch.created', 'time_entry', new.id, new.org_id,
      jsonb_build_object('user_id', new.user_id, 'job_site_id', new.job_site_id,
                         'clock_in', new.clock_in, 'in_geo_flag', new.in_geo_flag,
                         'in_distance_m', new.in_distance_m));
    if new.in_geo_flag = 'outside' then
      perform emit_event('punch.flagged', 'time_entry', new.id, new.org_id,
        jsonb_build_object('which', 'in', 'distance_m', new.in_distance_m,
                           'accuracy_m', new.in_accuracy_m, 'user_id', new.user_id));
    end if;
  elsif tg_op = 'UPDATE' then
    if new.out_geo_flag = 'outside'
       and (old.out_geo_flag is distinct from 'outside') then
      perform emit_event('punch.flagged', 'time_entry', new.id, new.org_id,
        jsonb_build_object('which', 'out', 'distance_m', new.out_distance_m,
                           'accuracy_m', new.out_accuracy_m, 'user_id', new.user_id));
    end if;
  end if;
  return new;
end $$;

create trigger time_entries_events
  after insert or update on time_entries
  for each row execute function emit_punch_events();

-- ---------------------------------------------------------------------------
-- Completion reports
-- ---------------------------------------------------------------------------

create table completion_reports (
  id                 uuid primary key default uuid_generate_v4(),
  org_id             uuid not null references orgs(id) on delete cascade,
  user_id            uuid not null references users(id),
  time_entry_id      uuid references time_entries(id) on delete set null,
  job_site_id        uuid references job_sites(id),
  completed_at       timestamptz not null default now(),
  work_complete      boolean not null,
  return_trip_needed boolean not null default false,
  return_trip_reason text,
  materials_used     text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index completion_reports_org_idx on completion_reports(org_id, completed_at);

alter table completion_reports enable row level security;

create policy completion_read on completion_reports
  for select using (
    org_id = current_org_id()
    and (user_id = auth.uid() or current_role_is('admin') or current_role_is('foreman'))
  );

create policy completion_insert on completion_reports
  for insert with check (org_id = current_org_id() and user_id = auth.uid());

create policy completion_admin on completion_reports
  for all using (org_id = current_org_id() and current_role_is('admin'));

create or replace function emit_completion_events() returns trigger
language plpgsql security definer as $$
begin
  perform emit_event('job.completed', 'completion_report', new.id, new.org_id,
    jsonb_build_object('user_id', new.user_id, 'job_site_id', new.job_site_id,
                       'work_complete', new.work_complete,
                       'return_trip_needed', new.return_trip_needed));
  if new.return_trip_needed then
    perform emit_event('completion.return_trip_required', 'completion_report', new.id, new.org_id,
      jsonb_build_object('job_site_id', new.job_site_id,
                         'reason', new.return_trip_reason, 'user_id', new.user_id));
  end if;
  return new;
end $$;

create trigger completion_reports_events
  after insert on completion_reports
  for each row execute function emit_completion_events();
