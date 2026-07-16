-- Data the n8n automation layer needs: where we're licensed to work,
-- what each employee specializes in, and a log of every inbound lead.

-- Licensed service territory. A row = an area we CAN work in.
create table service_areas (
  id      uuid primary key default uuid_generate_v4(),
  org_id  uuid not null references orgs(id) on delete cascade,
  kind    text not null check (kind in ('county', 'zip')),
  value   text not null,          -- e.g. 'Westchester County, NY' or '10803'
  note    text,
  unique (org_id, kind, value)
);

alter table service_areas enable row level security;
create policy service_areas_read on service_areas
  for select using (org_id = current_org_id());
create policy service_areas_admin on service_areas
  for all using (org_id = current_org_id() and current_role_is('admin'));

-- Employee specialties, matched by the dispatch brain (find_best_worker).
alter table users add column skills text[] not null default '{}';

-- Every inbound request gets logged, whatever its disposition — this becomes
-- quoting/demand data later.
create table leads (
  id           uuid primary key default uuid_generate_v4(),
  org_id       uuid not null references orgs(id) on delete cascade,
  received_at  timestamptz not null default now(),
  source       text not null default 'email',
  from_contact text,
  subject      text,
  summary      text,
  address      text,
  county       text,
  zip          text,
  trade        text,                -- classified specialty needed
  priority     text,                -- p1_emergency | routine | quote
  disposition  text,                -- dispatched | declined_territory | replied | pending
  notes        text
);

create index leads_org_time_idx on leads(org_id, received_at);

alter table leads enable row level security;
create policy leads_read on leads
  for select using (org_id = current_org_id());
create policy leads_admin on leads
  for all using (org_id = current_org_id() and current_role_is('admin'));
