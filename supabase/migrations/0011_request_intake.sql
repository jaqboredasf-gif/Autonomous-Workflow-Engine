-- Task B1 (AWE slice 1): intake spine — immutable email ingestion,
-- work_requests with classification substrate, deterministic emergency
-- keyword net, territory check, emergency scheduling lock, intake events.
-- Additive only. No sends of any kind exist in this slice (locked decision:
-- zero v1 auto-sends; outbound_messages/message_policies arrive in B3).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type email_direction as enum ('inbound', 'outbound');

create type request_classification as enum
  ('emergency', 'service_call', 'estimate_job', 'out_of_territory',
   'not_a_work_request', 'unknown');

create type request_property_type as enum ('commercial', 'residential', 'unknown');

create type request_urgency as enum ('emergency', 'urgent', 'standard');

create type work_request_status as enum
  ('new', 'awaiting_info', 'needs_review', 'escalated', 'awaiting_approval',
   'scheduled', 'declined', 'duplicate', 'converted', 'closed');

-- ---------------------------------------------------------------------------
-- email_messages — ingestion layer, isolated from routing. Rows are the
-- audit-grade original: content is immutable after insert (guard below).
-- Ingestion is service-role only (fixtures now, Graph later) — no client
-- insert policy on purpose.
-- ---------------------------------------------------------------------------

create table email_messages (
  id               uuid primary key default uuid_generate_v4(),
  org_id           uuid not null references orgs(id) on delete cascade,
  direction        email_direction not null,
  mailbox          text not null,
  graph_message_id text,
  from_addr        text not null,
  to_addrs         text[] not null default '{}',
  subject          text,
  body_text        text,
  body_html        text,
  attachments      jsonb not null default '[]'::jsonb,
  raw              jsonb not null,
  received_at      timestamptz not null,
  is_fixture       boolean not null default false,
  created_at       timestamptz not null default now(),
  -- Only real (Graph) mail may omit nothing: fixtures are the only rows
  -- allowed without a graph_message_id.
  check (graph_message_id is not null or is_fixture)
);

-- Exact-duplicate dedupe: same Graph message ingested twice = unique
-- violation (23505), same idempotency idiom as offline punches.
create unique index email_messages_graph_id_key
  on email_messages(org_id, graph_message_id)
  where graph_message_id is not null;

create index email_messages_org_received_idx on email_messages(org_id, received_at desc);
-- Fuzzy-duplicate candidate lookup (same sender, recent window).
create index email_messages_org_from_idx on email_messages(org_id, from_addr);

alter table email_messages enable row level security;

create policy email_messages_admin_read on email_messages
  for select using (org_id = current_org_id() and current_role_is('admin'));

-- ---------------------------------------------------------------------------
-- work_requests — one row per distinct customer request. Originating email is
-- mandatory; later emails (thread replies, confirmed duplicates) attach via
-- email_messages.work_request_id (added below, after this table exists).
-- ---------------------------------------------------------------------------

create table work_requests (
  id                           uuid primary key default uuid_generate_v4(),
  org_id                       uuid not null references orgs(id) on delete cascade,
  email_message_id             uuid not null references email_messages(id),
  customer_name                text,
  customer_email               text,
  customer_phone               text,
  customer_address             text,
  -- Extracted from the address text; inputs to check_territory(). Geocoded
  -- lat/lng deliberately deferred until a geocoder exists.
  county                       text,
  zip                          text,
  classification               request_classification not null default 'unknown',
  confidence                   numeric,
  classification_reasoning     text,
  property_type                request_property_type not null default 'unknown',
  urgency                      request_urgency not null default 'standard',
  status                       work_request_status not null default 'new',
  territory_result             jsonb,
  assigned_to                  uuid references users(id),
  duplicate_of_work_request_id uuid references work_requests(id),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  check (confidence is null or (confidence >= 0 and confidence <= 1)),
  -- A request may only be closed as duplicate WITH the link to the original
  -- (fuzzy duplicates are never auto-closed — human sets this).
  check (status <> 'duplicate' or duplicate_of_work_request_id is not null),
  check (duplicate_of_work_request_id is null or duplicate_of_work_request_id <> id)
);

create index work_requests_org_status_idx on work_requests(org_id, status);
create index work_requests_org_created_idx on work_requests(org_id, created_at desc);
create index work_requests_email_idx on work_requests(email_message_id);

alter table work_requests enable row level security;

create policy work_requests_admin_read on work_requests
  for select using (org_id = current_org_id() and current_role_is('admin'));

create policy work_requests_admin_update on work_requests
  for update using (org_id = current_org_id() and current_role_is('admin'));

-- Attachment link: replies / confirmed duplicates point at their request.
alter table email_messages
  add column work_request_id uuid references work_requests(id);

create index email_messages_work_request_idx on email_messages(work_request_id);

-- ---------------------------------------------------------------------------
-- Immutability guard: email content never changes after insert. The ONLY
-- permitted update is setting work_request_id once (attach). Corrections to a
-- bad ingest = insert a new row; never edit the record of what arrived.
-- ---------------------------------------------------------------------------

create or replace function guard_email_immutability() returns trigger
language plpgsql as $$
begin
  if new.org_id           is distinct from old.org_id
     or new.direction        is distinct from old.direction
     or new.mailbox          is distinct from old.mailbox
     or new.graph_message_id is distinct from old.graph_message_id
     or new.from_addr        is distinct from old.from_addr
     or new.to_addrs         is distinct from old.to_addrs
     or new.subject          is distinct from old.subject
     or new.body_text        is distinct from old.body_text
     or new.body_html        is distinct from old.body_html
     or new.attachments      is distinct from old.attachments
     or new.raw              is distinct from old.raw
     or new.received_at      is distinct from old.received_at
     or new.is_fixture       is distinct from old.is_fixture
     or new.created_at       is distinct from old.created_at
  then
    raise exception 'email_messages are immutable after insert';
  end if;
  if old.work_request_id is not null
     and new.work_request_id is distinct from old.work_request_id then
    raise exception 'email attachment to a work request is set-once';
  end if;
  return new;
end $$;

create trigger email_messages_immutability
  before update on email_messages
  for each row execute function guard_email_immutability();

-- ---------------------------------------------------------------------------
-- Deterministic emergency keyword net (REQUIREMENTS: AI classification is
-- never the only line of defense). Biased toward false positives: a false
-- alarm costs a human review; a miss is a safety failure. Runs on EVERY
-- inbound before any short-circuit (locked, WORKFLOW_MAPS spine).
-- ---------------------------------------------------------------------------

create or replace function is_emergency_text(p_text text) returns boolean
language sql immutable as $$
  select case when p_text is null then false else
    lower(p_text) ~ any (array[
      'burning smell', 'smell.{0,20}burning', 'smoke', 'spark',
      'electrical fire', 'fire.{0,20}(panel|outlet|wire|wiring|breaker|electrical)',
      'live wire', 'exposed wir', 'bare wire',
      'shock', 'electrocut',
      '(no|lost|loss of) power.{0,40}(medical|oxygen|safety|alarm|sump|life)',
      'flood.{0,40}(electrical|panel|outlet|wire|wiring|breaker)',
      '(panel|outlet|breaker|wire|wiring).{0,40}(hot|melt|buzz|sizzl|hum)'
    ])
  end
$$;

-- ---------------------------------------------------------------------------
-- Territory check against service_areas (currently SAMPLE data — real rules
-- are B5, and auto-decline stays disabled regardless). Unknown inputs return
-- in_territory = null, which must NEVER be treated as out-of-territory.
-- ---------------------------------------------------------------------------

create or replace function check_territory(p_org uuid, p_county text, p_zip text)
returns jsonb language plpgsql stable as $$
declare
  m service_areas%rowtype;
begin
  if p_zip is not null then
    select * into m from service_areas
     where org_id = p_org and kind = 'zip' and value = p_zip limit 1;
    if m.id is not null then
      return jsonb_build_object('in_territory', true,
        'matched_kind', 'zip', 'matched_value', m.value, 'rule_id', m.id);
    end if;
  end if;
  if p_county is not null then
    select * into m from service_areas
     where org_id = p_org and kind = 'county'
       and lower(value) like lower(p_county) || '%' limit 1;
    if m.id is not null then
      return jsonb_build_object('in_territory', true,
        'matched_kind', 'county', 'matched_value', m.value, 'rule_id', m.id);
    end if;
  end if;
  if p_zip is null and p_county is null then
    return jsonb_build_object('in_territory', null,
      'reason', 'no county or zip available');
  end if;
  return jsonb_build_object('in_territory', false,
    'checked_county', p_county, 'checked_zip', p_zip);
end $$;

-- ---------------------------------------------------------------------------
-- Emergency invariants: when a request is (re)classified emergency, status is
-- forced to escalated and urgency to emergency — automation cannot leave an
-- emergency in a schedulable state. Humans (admin) may move it out of
-- escalated afterward; that update IS the acknowledgement until B4 builds the
-- formal ack flow.
-- ---------------------------------------------------------------------------

create or replace function enforce_emergency_invariants() returns trigger
language plpgsql as $$
begin
  if new.classification = 'emergency'
     and (tg_op = 'INSERT' or old.classification is distinct from 'emergency') then
    new.status  := 'escalated';
    new.urgency := 'emergency';
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end $$;

create trigger work_requests_emergency_invariants
  before insert or update on work_requests
  for each row execute function enforce_emergency_invariants();

-- ---------------------------------------------------------------------------
-- Intake events (n8n contract, same pattern as punch/completion events).
-- request.received on ingest; request.classified whenever classification is
-- set to a real value; request.emergency_escalated exactly on the transition
-- into emergency.
-- ---------------------------------------------------------------------------

create or replace function emit_email_events() returns trigger
language plpgsql security definer as $$
begin
  perform emit_event('request.received', 'email_message', new.id, new.org_id,
    jsonb_build_object('from_addr', new.from_addr, 'subject', new.subject,
                       'mailbox', new.mailbox, 'received_at', new.received_at,
                       'is_fixture', new.is_fixture));
  return new;
end $$;

create trigger email_messages_events
  after insert on email_messages
  for each row execute function emit_email_events();

create or replace function emit_work_request_events() returns trigger
language plpgsql security definer as $$
begin
  if new.classification <> 'unknown'
     and (tg_op = 'INSERT' or old.classification is distinct from new.classification) then
    perform emit_event('request.classified', 'work_request', new.id, new.org_id,
      jsonb_build_object('classification', new.classification,
                         'confidence', new.confidence,
                         'urgency', new.urgency, 'status', new.status,
                         'territory_result', new.territory_result));
  end if;
  if new.classification = 'emergency'
     and (tg_op = 'INSERT' or old.classification is distinct from 'emergency') then
    perform emit_event('request.emergency_escalated', 'work_request', new.id, new.org_id,
      jsonb_build_object('email_message_id', new.email_message_id,
                         'customer_name', new.customer_name,
                         'customer_phone', new.customer_phone,
                         'customer_address', new.customer_address));
  end if;
  return new;
end $$;

create trigger work_requests_events
  after insert or update on work_requests
  for each row execute function emit_work_request_events();

-- ---------------------------------------------------------------------------
-- Emergency scheduling lock: a shift can never be created for (or moved onto)
-- a request that is sitting in escalated — auto-scheduling of emergencies is
-- forbidden until a human moves the request out of escalated.
-- ---------------------------------------------------------------------------

alter table shifts
  add column work_request_id uuid references work_requests(id);

create index shifts_work_request_idx on shifts(work_request_id);

create or replace function guard_emergency_scheduling() returns trigger
language plpgsql as $$
declare
  r_status work_request_status;
begin
  if new.work_request_id is not null
     and (tg_op = 'INSERT' or new.work_request_id is distinct from old.work_request_id) then
    select status into r_status from work_requests where id = new.work_request_id;
    if r_status = 'escalated' then
      raise exception 'work request % is escalated (emergency) — scheduling blocked until a human takes it out of escalated',
        new.work_request_id;
    end if;
  end if;
  return new;
end $$;

create trigger shifts_emergency_guard
  before insert or update on shifts
  for each row execute function guard_emergency_scheduling();
