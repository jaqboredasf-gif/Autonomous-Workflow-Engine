-- ---------------------------------------------------------------------------
-- 0016 — work_request becomes source-neutral (manual intake bridge)
--
-- WHY
--
-- A work_request is conceptually SOURCE-NEUTRAL: email is ONE intake source,
-- authorized manual/phone entry is another. `work_requests.email_message_id
-- not null` encoded the original email-first IMPLEMENTATION, not a domain
-- truth, and it forced non-email production work to masquerade as email.
--
-- Email-first remains the primary AUTOMATED intake target (DECISION_LOG
-- 2026-07-16), and that same locked decision already anticipated this bridge:
-- "manual intake form for office staff to enter phone requests into the same
-- work_request pipeline". Graph inbound (B9) is blocked on an Entra
-- registration owned by IT, and until it lands nothing can enter AWE in
-- production at all.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   * It does not touch `email_messages`. Every existing email invariant --
--     including `check (graph_message_id is not null or is_fixture)` and
--     `from_addr not null` -- survives completely unchanged. A manual request
--     simply has no email row, rather than a weakened one.
--   * It fabricates nothing: no fake email row, no invented graph_message_id,
--     no invented address, no abuse of is_fixture for production data.
--   * It builds no omni-channel framework. `request_source` has exactly two
--     values, because exactly two intake paths exist.
--   * It does not classify, draft, or send anything.
--
-- DEPENDENCY TRACE behind making email_message_id nullable (full trace in the
-- session report):
--   * create_outbound_draft() never reads email_messages; recipients arrive as
--     p_to_addrs from the caller. Outbound has NO structural dependency here.
--   * approval-queue.ts embeds the email via the FK and already types it
--     `QueueEmail | null`, reading it with `?.` -- null-safe today.
--   * db.mjs candidateOriginals() INNER JOINs through email_message_id and is
--     scoped to `graph_message_id like 'fixture:%'`, so manual rows are
--     naturally excluded from duplicate matching -- correct, since they carry
--     no sender address to match on.
--   * 0013's emergency payload passes email_message_id to jsonb_build_object,
--     which is null-safe.
--   * from_addr is used ONLY for display (requesterLine, the approvals detail
--     panel) and for that fixture-scoped duplicate query. It is never an
--     outbound destination.
-- ---------------------------------------------------------------------------

-- --- 1. Name the two intake sources ----------------------------------------

create type request_source as enum ('email', 'manual');

alter table work_requests
  add column source_type request_source not null default 'email';

-- Actor provenance. NOT duplicative of the audit log: emit_work_request_events
-- fires `request.classified` only when classification <> 'unknown', so a manual
-- insert (which stays 'unknown') emits nothing from it, and integration_events
-- is service-role-only with zero client policies -- so the row itself is the
-- only place an operator's identity is queryable by the product.
alter table work_requests
  add column entered_by uuid references users(id);

-- The real-world origin in the operator's words: "Phone call from
-- 914-555-0134", "Walk-in". Deliberately NOT stored in email_messages.from_addr,
-- which is an email address used for display and duplicate matching.
alter table work_requests
  add column source_reference text;

-- The request text itself. Email intake keeps the body on the email row
-- (email_messages.body_text); a manual request has no email row, so it needs
-- somewhere to live. It may NOT live only on the audit event: integration_events
-- is service-role-only with zero client policies, so a body stored only there
-- could never be displayed by the product. Read path becomes
-- `email_messages.body_text ?? request_text`, which mirrors the two sources.
alter table work_requests add column request_text text;

-- Idempotency for the browser, mirroring the offline punch queue's
-- (device_id, client_uuid) convention: a double-clicked form must not create a
-- second request.
alter table work_requests
  add column intake_client_key text;

create unique index work_requests_intake_client_key_idx
  on work_requests(org_id, intake_client_key)
  where intake_client_key is not null;

create index work_requests_org_source_idx on work_requests(org_id, source_type);

-- --- 2. The relationship becomes conditional, not absent -------------------
-- Existing rows are all email rows with an email_message_id, so the default
-- 'email' plus this constraint leaves every one of them valid.

alter table work_requests alter column email_message_id drop not null;

alter table work_requests add constraint work_requests_source_shape check (
  case source_type
    when 'email' then
      -- Existing email invariants, now stated explicitly.
      email_message_id is not null
      and entered_by is null
      and source_reference is null
      and intake_client_key is null
    when 'manual' then
      -- A manual request may never claim email provenance.
      email_message_id is null
      and entered_by is not null
      and source_reference is not null
      and request_text is not null
  end
);

-- Provenance is set once, at creation, and can never be rewritten afterwards:
-- a manual request that could later be relabelled 'email' would defeat the
-- point of recording provenance at all.
create or replace function guard_work_request_provenance() returns trigger
language plpgsql as $$
begin
  if new.source_type       is distinct from old.source_type
     or new.email_message_id is distinct from old.email_message_id
     or new.entered_by       is distinct from old.entered_by
     or new.source_reference is distinct from old.source_reference
     or new.intake_client_key is distinct from old.intake_client_key
     or new.request_text     is distinct from old.request_text
     or new.org_id           is distinct from old.org_id
  then
    raise exception 'work request provenance is immutable after creation (request %)', old.id;
  end if;
  return new;
end $$;

create trigger work_requests_provenance_immutability
  before update on work_requests
  for each row execute function guard_work_request_provenance();

-- --- 3. The one governed door ----------------------------------------------
-- SECURITY DEFINER, matching every other privileged write in this schema
-- (record_approval, mark_message_sent, create_outbound_draft). There is
-- deliberately NO insert policy on work_requests: the browser must never choose
-- org_id, source_type or entered_by. This function decides all three.
--
-- The narrowest capability that accomplishes the objective: "create a manual
-- work request for my authorized organization" -- and nothing else.

create or replace function create_manual_work_request(
  p_body_text        text,
  p_source_reference text,
  p_received_at      timestamptz default now(),
  p_customer_name    text default null,
  p_customer_email   text default null,
  p_customer_phone   text default null,
  p_customer_address text default null,
  p_county           text default null,
  p_zip              text default null,
  p_urgency          request_urgency default 'standard',
  p_client_key       text default null
) returns uuid language plpgsql security definer as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid := current_org_id();
  v_wr  uuid;
begin
  if v_uid is null then
    raise exception 'manual intake requires an authenticated human';
  end if;
  if v_org is null then
    raise exception 'manual intake requires an organization context';
  end if;
  if not current_role_is('admin') then
    raise exception 'user % is not authorized to create work requests', v_uid;
  end if;

  if coalesce(btrim(p_body_text), '') = '' then
    raise exception 'a work request needs the customer request text';
  end if;
  if coalesce(btrim(p_source_reference), '') = '' then
    raise exception 'a manual work request must record where it came from';
  end if;
  if p_received_at > now() + interval '1 minute' then
    raise exception 'received_at cannot be in the future';
  end if;

  -- Idempotency: a double-clicked form returns the SAME request.
  if p_client_key is not null then
    select id into v_wr
      from work_requests
     where org_id = v_org and intake_client_key = p_client_key;
    if v_wr is not null then
      return v_wr;
    end if;
  end if;

  -- classification stays 'unknown'. Manual intake records what a human was
  -- told; it does not decide what the request IS. That is exactly the state an
  -- unprocessed email sits in, so downstream classification treats both alike.
  insert into work_requests (
    org_id, source_type, email_message_id, entered_by, source_reference,
    intake_client_key, request_text, customer_name, customer_email,
    customer_phone, customer_address, county, zip, urgency, created_at
  ) values (
    v_org, 'manual', null, v_uid, btrim(p_source_reference),
    p_client_key, btrim(p_body_text),
    nullif(btrim(coalesce(p_customer_name, '')), ''),
    nullif(btrim(coalesce(p_customer_email, '')), ''),
    nullif(btrim(coalesce(p_customer_phone, '')), ''),
    nullif(btrim(coalesce(p_customer_address, '')), ''),
    nullif(btrim(coalesce(p_county, '')), ''),
    nullif(btrim(coalesce(p_zip, '')), ''),
    coalesce(p_urgency, 'standard'),
    p_received_at
  ) returning id into v_wr;

  -- Audit event. The request text lives on the row (readable by the product);
  -- this records the INTAKE ACT, which no existing trigger emits because
  -- emit_work_request_events only fires once classification <> 'unknown'.
  perform emit_event('request.manual_intake', 'work_request', v_wr, v_org,
    jsonb_build_object('entered_by', v_uid,
                       'source_reference', btrim(p_source_reference),
                       'received_at', p_received_at,
                       'urgency', coalesce(p_urgency, 'standard'),
                       'customer_name', nullif(btrim(coalesce(p_customer_name, '')), ''),
                       'customer_phone', nullif(btrim(coalesce(p_customer_phone, '')), '')));

  return v_wr;
end $$;
