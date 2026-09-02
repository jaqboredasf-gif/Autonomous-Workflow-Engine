-- ---------------------------------------------------------------------------
-- 0016 — manual intake bridge (TEMPORARY PRODUCTION BOOTSTRAP)
--
-- WHY THIS EXISTS, AND WHY IT IS NOT A STRATEGY CHANGE
--
-- The MVP intake architecture is EMAIL-FIRST and remains so. DECISION_LOG
-- (2026-07-16) locked that decision and, in the same breath, named this bridge:
-- "manual intake form for office staff to enter phone requests into the same
-- work_request pipeline — scope it in Phase 4 as shortly-after-MVP."
--
-- Graph inbound (B9) is blocked on an Entra app registration owned by IT. Until
-- it lands, NOTHING can enter AWE in production: no UI creates an
-- email_messages or work_requests row, and every existing insert path is an
-- acceptance script running as service-role. This migration opens exactly one
-- authorized, audited, operator-attributed door — and no more.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * It does not fabricate an email. A manual row can NEVER carry a
--     graph_message_id, and the constraint below enforces that structurally.
--   * It does not become a fixture. Manual rows are REAL production data;
--     is_fixture stays false, so LIVE-mode gates treat them as real.
--   * It does not duplicate downstream logic. The existing insert triggers
--     (emit_email_events, enforce_emergency_invariants, emit_work_request_events)
--     fire unchanged, so the emergency net, audit events and territory data all
--     behave exactly as they do for email intake.
--   * It does not auto-send, auto-classify or auto-draft anything.
--
-- REMOVAL PATH: when Graph inbound ships, stop calling
-- create_manual_work_request(). Rows already created stay valid and clearly
-- labelled `source = 'manual'`, so history remains honest and queryable.
-- ---------------------------------------------------------------------------

-- --- 1. Name the three ways an intake record can come to exist --------------

create type intake_source as enum ('graph', 'manual', 'fixture');

alter table email_messages add column source intake_source;

-- Backfill is unambiguous because the OLD constraint
-- `check (graph_message_id is not null or is_fixture)` left only two shapes.
update email_messages
   set source = case when is_fixture then 'fixture' else 'graph' end;

alter table email_messages alter column source set not null;

-- Who typed it in. Required for manual rows: an unattributed manual record is
-- an anonymous claim about the real world, which is exactly what this system
-- refuses to store anywhere else.
alter table email_messages
  add column manual_entered_by uuid references users(id);

-- The real-world origin, in the operator's words: "Phone call from
-- 914-555-0134", "Walk-in", "Text to Mike's cell". This is NOT an address and
-- is never used as a recipient.
alter table email_messages add column source_reference text;

-- Idempotency for the browser, mirroring the offline punch queue's
-- (device_id, client_uuid) convention: a double-clicked form must not create a
-- second request.
alter table email_messages add column manual_client_key text;

create unique index email_messages_manual_client_key_idx
  on email_messages(org_id, manual_client_key)
  where manual_client_key is not null;

-- from_addr is a genuine email address or nothing. apps/web/src/lib/approval-queue.ts
-- falls back to from_addr as a RECIPIENT when customer_email is absent, so
-- putting a phone number here would risk addressing a reply to a phone number
-- and would pollute duplicate matching (scripts/lib/db.mjs candidateOriginals).
alter table email_messages alter column from_addr drop not null;

-- --- 2. Replace the shape constraint ---------------------------------------
-- The old inline check cannot admit a manual row: it would force either a
-- forged graph_message_id (masquerading as email) or is_fixture = true
-- (real customer data labelled synthetic). Both are unacceptable, so the
-- constraint is replaced rather than worked around.

do $$
declare c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'email_messages'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%graph_message_id%'
     and pg_get_constraintdef(oid) like '%is_fixture%';
  if c is not null then
    execute format('alter table email_messages drop constraint %I', c);
  end if;
end $$;

alter table email_messages add constraint email_messages_source_shape check (
  case source
    when 'graph' then
      graph_message_id is not null
      and from_addr is not null
      and not is_fixture
      and manual_entered_by is null
      and manual_client_key is null
    when 'fixture' then
      is_fixture
      and manual_entered_by is null
    when 'manual' then
      -- Structurally cannot masquerade as email, and cannot hide as a fixture.
      graph_message_id is null
      and not is_fixture
      and manual_entered_by is not null
      and source_reference is not null
  end
);

-- Immutability guard must protect the new provenance columns too: a manual row
-- that could be relabelled 'graph' after the fact would defeat the point.
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
     or new.source            is distinct from old.source
     or new.manual_entered_by is distinct from old.manual_entered_by
     or new.source_reference  is distinct from old.source_reference
     or new.manual_client_key is distinct from old.manual_client_key
  then
    raise exception 'email_messages are immutable after insert';
  end if;
  if old.work_request_id is not null
     and new.work_request_id is distinct from old.work_request_id then
    raise exception 'email attachment to a work request is set-once';
  end if;
  return new;
end $$;

-- --- 3. The one authorized door --------------------------------------------
-- SECURITY DEFINER, matching every other privileged write in this schema
-- (record_approval, mark_message_sent, create_outbound_draft). There is
-- deliberately NO insert policy on email_messages or work_requests: the browser
-- must never choose org_id, source, is_fixture or graph_message_id. This
-- function decides all four.

create or replace function create_manual_work_request(
  p_body_text        text,
  p_source_reference text,
  p_received_at      timestamptz default now(),
  p_subject          text default null,
  p_customer_name    text default null,
  p_customer_email   text default null,
  p_customer_phone   text default null,
  p_customer_address text default null,
  p_county           text default null,
  p_zip              text default null,
  p_client_key       text default null
) returns uuid language plpgsql security definer as $$
declare
  v_uid   uuid := auth.uid();
  v_org   uuid := current_org_id();
  v_email uuid;
  v_wr    uuid;
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
    select work_request_id into v_wr
      from email_messages
     where org_id = v_org and manual_client_key = p_client_key;
    if v_wr is not null then
      return v_wr;
    end if;
  end if;

  insert into email_messages (
    org_id, direction, mailbox, graph_message_id, from_addr, to_addrs,
    subject, body_text, raw, received_at, is_fixture,
    source, manual_entered_by, source_reference, manual_client_key
  ) values (
    v_org, 'inbound', 'manual:web', null,
    nullif(btrim(coalesce(p_customer_email, '')), ''), '{}',
    nullif(btrim(coalesce(p_subject, '')), ''), p_body_text,
    jsonb_build_object(
      'manual_entry', true,
      'entered_by', v_uid,
      'entered_at', now(),
      'source_reference', p_source_reference,
      'note', 'Operator-entered while Graph inbound is unavailable. Not an email.'),
    p_received_at, false,
    'manual', v_uid, btrim(p_source_reference), p_client_key
  ) returning id into v_email;

  -- classification stays 'unknown': manual intake records what a human was
  -- told, it does not decide what the request IS. Downstream classification
  -- handles that exactly as it does for email.
  insert into work_requests (
    org_id, email_message_id, customer_name, customer_email, customer_phone,
    customer_address, county, zip
  ) values (
    v_org, v_email,
    nullif(btrim(coalesce(p_customer_name, '')), ''),
    nullif(btrim(coalesce(p_customer_email, '')), ''),
    nullif(btrim(coalesce(p_customer_phone, '')), ''),
    nullif(btrim(coalesce(p_customer_address, '')), ''),
    nullif(btrim(coalesce(p_county, '')), ''),
    nullif(btrim(coalesce(p_zip, '')), '')
  ) returning id into v_wr;

  update email_messages set work_request_id = v_wr where id = v_email;

  perform emit_event('request.manual_intake', 'work_request', v_wr, v_org,
    jsonb_build_object('email_message_id', v_email,
                       'entered_by', v_uid,
                       'source_reference', btrim(p_source_reference),
                       'received_at', p_received_at));

  return v_wr;
end $$;
