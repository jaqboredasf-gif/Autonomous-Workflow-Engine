-- ---------------------------------------------------------------------------
-- 0013_triage_events.sql
--
-- B2 classification harness needs two more intake events on the same n8n
-- contract established in 0011. Additive and idempotent: CREATE OR REPLACE of
-- emit_work_request_events, preserving the existing request.classified and
-- request.emergency_escalated emits and adding:
--
--   request.triage_required  -- whenever a request lands in needs_review
--                               (fail-closed unknowns, un-geocodable jobs,
--                                fuzzy/content duplicates a human must judge)
--   duplicate_flagged        -- whenever a request is linked to an original
--                               (duplicate_of set) but NOT auto-closed as a
--                               hard duplicate — honors the locked rule that
--                               fuzzy/content duplicates are never auto-closed.
--
-- Each emit is guarded on INSERT or the specific transition, so idempotent
-- re-ingest of a fixture does not multiply events.
-- ---------------------------------------------------------------------------

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

  if new.status = 'needs_review'
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform emit_event('request.triage_required', 'work_request', new.id, new.org_id,
      jsonb_build_object('classification', new.classification,
                         'confidence', new.confidence,
                         'status', new.status,
                         'territory_result', new.territory_result));
  end if;

  if new.duplicate_of_work_request_id is not null
     and new.status <> 'duplicate'
     and (tg_op = 'INSERT'
          or old.duplicate_of_work_request_id is distinct from new.duplicate_of_work_request_id) then
    perform emit_event('duplicate_flagged', 'work_request', new.id, new.org_id,
      jsonb_build_object('duplicate_of_work_request_id', new.duplicate_of_work_request_id,
                         'status', new.status,
                         'classification', new.classification));
  end if;

  return new;
end $$;

-- Trigger definition is unchanged (0011 already binds this function); replacing
-- the function body is sufficient.
