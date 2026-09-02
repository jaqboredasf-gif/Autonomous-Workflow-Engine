-- 0016 manual intake bridge — integration assertions against a real PostgreSQL.
-- Run by scripts/pg-harness.sh after the migration chain is applied.
--
-- Covers the founder's required scenarios plus the schema invariants the
-- offline lint can only assert as SQL text.

do $$
declare
  admin_a uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  worker_a uuid := 'aaaaaaaa-0000-4000-8000-000000000002';
  admin_b uuid := 'aaaaaaaa-0000-4000-8000-000000000003';
  org_a uuid := '11111111-1111-4111-8111-111111111111';
  org_b uuid := '22222222-2222-4222-8222-222222222222';
  v uuid; v2 uuid; r record; n int; em_before int; em_after int;
begin
  select count(*) into em_before from email_messages;
  perform set_config('request.jwt.claims', json_build_object('sub',admin_a,'role','authenticated')::text, true);

  -- 1-9: an authorized admin creates a real manual request
  v := create_manual_work_request(
        p_body_text => 'Kitchen outlet stopped working, needs someone this week.',
        p_source_reference => 'Phone call from 914-555-0134',
        p_received_at => '2026-09-02T15:30:00Z',
        p_customer_name => '  Maria Lopez  ',
        p_customer_phone => '914-555-0134',
        p_urgency => 'urgent',
        p_client_key => 'ck-alpha');
  select * into r from work_requests where id = v;
  select count(*) into em_after from email_messages;

  perform t_pass('1. authorized admin can create a manual request', v is not null);
  perform t_pass('2. source_type = manual', r.source_type = 'manual');
  perform t_pass('3. email_message_id IS NULL', r.email_message_id is null);
  perform t_pass('4. NO email_message row was fabricated', em_after = em_before);
  perform t_pass('5. entered_by is the authenticated actor', r.entered_by = admin_a);
  perform t_pass('6. org derived from the actor, not the caller', r.org_id = org_a);
  perform t_pass('7. request_text persists and is readable from the row',
                 r.request_text = 'Kitchen outlet stopped working, needs someone this week.');
  perform t_pass('8. source_reference persists', r.source_reference = 'Phone call from 914-555-0134');
  perform t_pass('9. received_at is honoured', r.created_at = '2026-09-02T15:30:00Z'::timestamptz);
  perform t_pass('9b. optional text is trimmed, not stored raw', r.customer_name = 'Maria Lopez');
  perform t_pass('9c. urgency recorded as stated', r.urgency = 'urgent');
  perform t_pass('9d. manual intake performs NO classification', r.classification = 'unknown');

  -- 10: idempotency
  v2 := create_manual_work_request('Kitchen outlet stopped working, needs someone this week.',
                                   'Phone call from 914-555-0134', p_client_key => 'ck-alpha');
  select count(*) into n from work_requests where intake_client_key = 'ck-alpha';
  perform t_pass('10. a repeated client key returns the SAME request', v2 = v);
  perform t_pass('10b. and creates no second row', n = 1);

  -- 14: audit
  select count(*) into n from integration_events
   where event_type='request.manual_intake' and entity_id=v and payload->>'entered_by' = admin_a::text;
  perform t_pass('14. request.manual_intake audit event names the actor', n = 1);

  -- 11: unauthenticated (valid JWT shape, no subject -> auth.uid() is NULL)
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform t_pass('11-pre. auth.uid() is genuinely NULL here', auth.uid() is null);
  begin
    perform create_manual_work_request('body','origin');
    perform t_pass('11. unauthenticated caller refused', false);
  exception when others then
    perform t_pass('11. unauthenticated caller refused by the guard', sqlerrm like '%authenticated human%');
  end;

  -- 12: unauthorized role
  perform set_config('request.jwt.claims', json_build_object('sub',worker_a,'role','authenticated')::text, true);
  begin
    perform create_manual_work_request('body','origin');
    perform t_pass('12. non-admin refused', false);
  exception when others then
    perform t_pass('12. non-admin refused', sqlerrm like '%not authorized%');
  end;

  -- 13: tenant isolation
  perform set_config('request.jwt.claims', json_build_object('sub',admin_b,'role','authenticated')::text, true);
  v2 := create_manual_work_request('Org B request','Walk-in', p_client_key=>'ck-b');
  select org_id into r.org_id from work_requests where id = v2;
  select count(*) into n from work_requests where org_id = org_a and intake_client_key = 'ck-b';
  perform t_pass('13. another org''s admin writes only to their own org', r.org_id = org_b);
  perform t_pass('13b. nothing crossed into the first tenant', n = 0);

  -- 15/16: existing email-backed and fixture rows unaffected
  select count(*) into n from work_requests where source_type='email' and email_message_id is not null;
  perform t_pass('15. pre-existing email-backed requests remain valid', n = 2);
  select count(*) into n from work_requests wr
    join email_messages em on em.id = wr.email_message_id where em.is_fixture;
  perform t_pass('16. fixture requests stay identifiable via their email row', n = 1);
  select count(*) into n from work_requests where source_type='manual' and email_message_id is not null;
  perform t_pass('16b. no manual request carries an email row', n = 0);

  perform set_config('request.jwt.claims', json_build_object('sub',admin_a,'role','authenticated')::text, true);

  -- constraint: neither source may impersonate the other
  begin
    insert into work_requests (org_id, source_type, email_message_id, entered_by, source_reference, request_text)
    values (org_a,'manual','e0000000-0000-4000-8000-000000000001',admin_a,'Phone','t');
    perform t_pass('C1. a manual row claiming an email_message is REFUSED', false);
  exception when check_violation then perform t_pass('C1. a manual row claiming an email_message is REFUSED', true); end;
  begin
    insert into work_requests (org_id, source_type, email_message_id) values (org_a,'email',null);
    perform t_pass('C2. an email row with no email_message is REFUSED', false);
  exception when check_violation then perform t_pass('C2. an email row with no email_message is REFUSED', true); end;
  begin
    insert into work_requests (org_id, source_type, entered_by, source_reference, request_text)
    values (org_a,'manual',null,'Phone','t');
    perform t_pass('C3. a manual row with no author is REFUSED', false);
  exception when check_violation then perform t_pass('C3. a manual row with no author is REFUSED', true); end;
  begin
    insert into work_requests (org_id, source_type, entered_by, source_reference, request_text)
    values (org_a,'manual',admin_a,'Phone',null);
    perform t_pass('C4. a manual row with no request text is REFUSED', false);
  exception when check_violation then perform t_pass('C4. a manual row with no request text is REFUSED', true); end;

  -- provenance immutability
  begin
    update work_requests set source_type='email' where id=v;
    perform t_pass('P1. relabelling manual -> email is REFUSED', false);
  exception when others then perform t_pass('P1. relabelling manual -> email is REFUSED', sqlerrm like '%provenance is immutable%'); end;
  begin
    update work_requests set entered_by=null where id=v;
    perform t_pass('P2. erasing the operator is REFUSED', false);
  exception when others then perform t_pass('P2. erasing the operator is REFUSED', sqlerrm like '%provenance is immutable%'); end;
  begin
    update work_requests set request_text='rewritten later' where id=v;
    perform t_pass('P3. rewriting the request text is REFUSED', false);
  exception when others then perform t_pass('P3. rewriting the request text is REFUSED', sqlerrm like '%provenance is immutable%'); end;
  update work_requests set classification='service_call', status='needs_review' where id=v;
  perform t_pass('P4. ordinary workflow updates still succeed', true);

  -- input guards
  begin
    perform create_manual_work_request('body','origin', now() + interval '2 hours');
    perform t_pass('F1. a future received_at is REFUSED', false);
  exception when others then perform t_pass('F1. a future received_at is REFUSED', sqlerrm like '%future%'); end;
  begin
    perform create_manual_work_request('   ','origin');
    perform t_pass('F2. blank request text is REFUSED', false);
  exception when others then perform t_pass('F2. blank request text is REFUSED', true); end;
  begin
    perform create_manual_work_request('body','   ');
    perform t_pass('F3. a blank real-world origin is REFUSED', false);
  exception when others then perform t_pass('F3. a blank real-world origin is REFUSED', true); end;

  -- downstream triggers fire for manual requests exactly as for email
  v2 := create_manual_work_request('Sparks from the panel','Phone call', p_client_key=>'ck-emg');
  update work_requests set classification='emergency' where id=v2;
  select count(*) into n from work_requests where id=v2 and status='escalated' and urgency='emergency';
  perform t_pass('D1. emergency invariants fire on a MANUAL request', n=1);
  select count(*) into n from integration_events where entity_id=v2 and event_type='request.emergency_escalated';
  perform t_pass('D2. emergency escalation event emitted for a manual request', n=1);
  select count(*) into n from integration_events where entity_id=v2 and event_type='request.classified';
  perform t_pass('D3. request.classified emitted once classified', n>=1);
end $$;

-- RLS: the product read path, exercised as the real roles
do $$ begin
  execute 'grant usage on schema public to authenticated';
  execute 'grant select, update on work_requests to authenticated';
  execute 'grant select on email_messages to authenticated';
  execute 'grant select on users to authenticated';
end $$;

do $$
declare n int;
begin
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}',true);
  select count(*) into n from work_requests where source_type='manual';
  perform t_pass('R1. an admin SEES their manual requests through RLS', n >= 1);
  select count(*) into n from work_requests wr left join email_messages em on em.id=wr.email_message_id
   where wr.source_type='manual' and em.id is null;
  perform t_pass('R2. the product LEFT JOIN yields manual rows with a null email', n >= 1);
  select count(*) into n from work_requests where org_id='22222222-2222-4222-8222-222222222222';
  perform t_pass('R3. an admin sees NO other-tenant rows', n = 0);

  perform set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000002","role":"authenticated"}',true);
  select count(*) into n from work_requests;
  perform t_pass('R4. a non-admin sees no requests at all', n = 0);
  perform set_config('role','none',true);
end $$;
