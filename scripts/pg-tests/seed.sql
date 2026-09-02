-- Representative production-SHAPED rows for the migration harness.
-- Synthetic by construction: two orgs, three users, one real-graph email +
-- request, one fixture email + request. These are the rows a new migration's
-- constraints must not invalidate.
insert into orgs (id, name) values
  ('11111111-1111-4111-8111-111111111111','Harness Org A'),
  ('22222222-2222-4222-8222-222222222222','Harness Org B');

insert into auth.users (id,email) values
  ('aaaaaaaa-0000-4000-8000-000000000001','admin.a@example.invalid'),
  ('aaaaaaaa-0000-4000-8000-000000000002','worker.a@example.invalid'),
  ('aaaaaaaa-0000-4000-8000-000000000003','admin.b@example.invalid');

insert into users (id, org_id, full_name, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','Admin A','admin'),
  ('aaaaaaaa-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','Worker A','worker'),
  ('aaaaaaaa-0000-4000-8000-000000000003','22222222-2222-4222-8222-222222222222','Admin B','admin');

-- a real (graph-sourced) email and its work request
insert into email_messages (id, org_id, direction, mailbox, graph_message_id, from_addr, to_addrs, subject, body_text, raw, received_at, is_fixture)
values ('e0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','inbound','requests@example.invalid','GRAPH-REAL-1','customer@example.invalid','{}','Outlet dead','Kitchen outlet stopped working.','{}','2026-08-01T10:00:00Z',false);
insert into work_requests (id, org_id, email_message_id, customer_name, classification)
values ('c0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','e0000000-0000-4000-8000-000000000001','Real Customer','service_call');

-- a fixture email and its work request
insert into email_messages (id, org_id, direction, mailbox, graph_message_id, from_addr, to_addrs, subject, body_text, raw, received_at, is_fixture)
values ('e0000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','inbound','fixtures@local','fixture:01','dana@example.invalid','{}','Fixture','Fixture body.','{}','2026-08-02T10:00:00Z',true);
insert into work_requests (id, org_id, email_message_id, customer_name, classification)
values ('c0000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','e0000000-0000-4000-8000-000000000002','Dana Fixture','service_call');

create or replace function t_pass(label text, cond boolean) returns void language plpgsql as $$
begin
  if cond then raise notice 'PASS  %', label; else raise notice 'FAIL  %', label; end if;
end $$;
