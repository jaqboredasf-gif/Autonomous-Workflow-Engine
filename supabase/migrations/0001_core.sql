-- Exattime core schema
-- Phase 0: orgs, users, job sites, cost codes, time entries, pay periods.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Organizations & settings
-- ---------------------------------------------------------------------------

create table orgs (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Payroll rules are configuration, not code. Defaults reflect current policy:
-- standard unpaid lunch 12:00-12:30, 15-minute rounding, 8h daily / 40h weekly OT.
create table org_settings (
  org_id                uuid primary key references orgs(id) on delete cascade,
  timezone              text not null default 'America/New_York',
  rounding_minutes      int  not null default 15,
  ot_daily_hours        numeric(4,2) not null default 8.0,
  ot_weekly_hours       numeric(4,2) not null default 40.0,
  lunch_start           time not null default '12:00',
  lunch_end             time not null default '12:30',
  lunch_paid            boolean not null default false,
  lunch_auto_deduct     boolean not null default true,
  require_punch_photo   boolean not null default false
);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

create type user_role as enum ('admin', 'foreman', 'worker');

-- Mirrors auth.users (Supabase auth); app-level profile.
create table users (
  id          uuid primary key,               -- = auth.users.id
  org_id      uuid not null references orgs(id) on delete cascade,
  role        user_role not null default 'worker',
  full_name   text not null,
  phone       text,
  hourly_rate numeric(8,2),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create index users_org_idx on users(org_id);

-- Foreman -> crew membership (crew clock-in punches whole crew).
create table crews (
  id         uuid primary key default uuid_generate_v4(),
  org_id     uuid not null references orgs(id) on delete cascade,
  name       text not null,
  foreman_id uuid not null references users(id)
);

create table crew_members (
  crew_id uuid not null references crews(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (crew_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Job sites & cost codes
-- ---------------------------------------------------------------------------

create table job_sites (
  id             uuid primary key default uuid_generate_v4(),
  org_id         uuid not null references orgs(id) on delete cascade,
  name           text not null,
  address        text,
  lat            double precision not null,
  lng            double precision not null,
  radius_m       int not null default 150,    -- geofence radius, meters
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);

create index job_sites_org_idx on job_sites(org_id);

create table cost_codes (
  id        uuid primary key default uuid_generate_v4(),
  org_id    uuid not null references orgs(id) on delete cascade,
  code      text not null,                    -- e.g. "FRAME", "ELEC-ROUGH"
  label     text not null,
  is_active boolean not null default true,
  unique (org_id, code)
);

-- ---------------------------------------------------------------------------
-- Time entries
-- ---------------------------------------------------------------------------

create type entry_status as enum ('open', 'submitted', 'approved', 'locked');
create type geo_flag as enum ('inside', 'outside', 'no_gps');

create table time_entries (
  id             uuid primary key default uuid_generate_v4(),
  org_id         uuid not null references orgs(id) on delete cascade,
  user_id        uuid not null references users(id),
  job_site_id    uuid references job_sites(id),
  cost_code_id   uuid references cost_codes(id),
  clock_in       timestamptz not null,
  clock_out      timestamptz,
  in_lat         double precision,
  in_lng         double precision,
  in_geo_flag    geo_flag not null default 'no_gps',
  out_lat        double precision,
  out_lng        double precision,
  out_geo_flag   geo_flag,
  in_photo_url   text,
  status         entry_status not null default 'open',
  -- offline sync bookkeeping
  device_id      text,
  client_uuid    uuid,                        -- idempotency key from device queue
  synced_at      timestamptz not null default now(),
  created_by     uuid references users(id),   -- foreman on crew punches
  notes          text,
  unique (device_id, client_uuid),
  check (clock_out is null or clock_out > clock_in)
);

create index time_entries_org_day_idx on time_entries(org_id, clock_in);
create index time_entries_user_idx on time_entries(user_id, clock_in);
create index time_entries_open_idx on time_entries(user_id) where clock_out is null;

-- Audit trail: edits to approved/locked entries never mutate silently.
create table time_entry_audits (
  id            uuid primary key default uuid_generate_v4(),
  time_entry_id uuid not null references time_entries(id) on delete cascade,
  edited_by     uuid not null references users(id),
  edited_at     timestamptz not null default now(),
  old_values    jsonb not null,
  new_values    jsonb not null,
  reason        text
);

-- ---------------------------------------------------------------------------
-- Payroll
-- ---------------------------------------------------------------------------

create type pay_period_status as enum ('open', 'closed', 'exported');

create table pay_periods (
  id         uuid primary key default uuid_generate_v4(),
  org_id     uuid not null references orgs(id) on delete cascade,
  starts_on  date not null,
  ends_on    date not null,
  status     pay_period_status not null default 'open',
  unique (org_id, starts_on),
  check (ends_on > starts_on)
);

create table payroll_exports (
  id            uuid primary key default uuid_generate_v4(),
  pay_period_id uuid not null references pay_periods(id),
  format        text not null,                -- 'csv' | 'quickbooks' | 'adp'
  exported_by   uuid not null references users(id),
  exported_at   timestamptz not null default now(),
  file_url      text
);
