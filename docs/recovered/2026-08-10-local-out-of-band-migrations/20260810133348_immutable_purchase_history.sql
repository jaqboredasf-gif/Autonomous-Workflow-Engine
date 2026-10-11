-- ---------------------------------------------------------------------------
-- 20260810133348_immutable_purchase_history.sql — PCC Phase A
--
-- BR-012: completed purchasing activity becomes immutable evidence. The row
-- keeps BOTH identifiers and literal snapshots: ids remain joinable to the
-- current directories, while names, numbers, descriptions and prices remain
-- true even after those directories are renamed.
--
-- BR-013: observed behaviour is evidence, not configuration. Everything in
-- the intelligence views below is derived from completed history. Configured
-- preference remains in purchase_item_catalog.default_vendor_id and is never
-- promoted to "last vendor" or mixed into these observations.
--
-- LIFECYCLE RULE
--   * A line snapshot is written exactly once, in the SAME transaction that
--     moves a request to COMPLETED. PO generation is not ordering, and
--     generated_at is therefore never used as ordered_at.
--   * REJECTED and CANCELLED requests are recorded in the request-level
--     purchase_request_outcome_history table. No purchase-line fact is
--     invented for an order that never completed, and those outcomes are not
--     inputs to pricing, frequency or lead-time intelligence.
--   * Existing terminal records are deterministically backfilled and marked
--     BACKFILL. Unavailable facts remain NULL; the migration never guesses.
--
-- This migration is repository-only. It is not applied to any hosted project
-- by this change.
-- ---------------------------------------------------------------------------

create schema if not exists purchasing_private;
revoke all on schema purchasing_private from public, anon, authenticated;
-- The matching rule version belongs beside the key it produced. Existing
-- lines were all written under v1; future writes supply the current version.
alter table purchase_request_items
  add column if not exists normalizer_version integer not null default 1;
alter table purchase_order_items
  add column if not exists normalizer_version integer not null default 1;
alter table purchase_order_items
  add constraint purchase_order_items_id_org_key unique (id, org_id);
create table purchase_history_lines (
  id                                uuid primary key default uuid_generate_v4(),
  org_id                            uuid not null references orgs(id) on delete restrict,

  request_id                        uuid not null,
  request_number_snapshot           text not null,
  purchase_order_id                 uuid not null,
  purchase_order_item_id            uuid not null,
  po_number_snapshot                text not null,

  job_id                            uuid,
  job_number_snapshot               text not null,
  job_name_snapshot                 text,

  catalog_item_id                   uuid,
  normalizer_version                integer not null,
  normalized_description_snapshot   text not null,
  material_description_snapshot     text not null,
  requested_description_snapshot    text,

  quantity_ordered                  numeric(14,3) not null,
  unit_snapshot                     text not null,

  vendor_id                         uuid not null,
  vendor_name_snapshot              text not null,
  vendor_part_number_snapshot       text,

  estimated_unit_price              numeric(12,2),
  estimated_total_price             numeric(12,2),
  actual_unit_price                 numeric(12,2),
  actual_total_price                numeric(12,2),

  requester_user_id                 uuid not null references users(id) on delete restrict,
  requester_name_snapshot           text not null,
  approver_user_id                  uuid not null references users(id) on delete restrict,
  approver_name_snapshot            text not null,

  requested_at                      timestamptz,
  approved_at                       timestamptz,
  ordered_at                        timestamptz not null,
  received_at                       timestamptz,
  completed_at                      timestamptz not null,

  received_qty                      numeric(14,3) not null default 0,
  damaged_qty                       numeric(14,3) not null default 0,
  backordered_qty_snapshot          numeric(14,3) not null default 0,
  was_backordered                   boolean not null default false,
  written_off_qty                   numeric(14,3) not null default 0,
  receipt_outcome                   text not null,

  capture_source                    text not null,
  recorded_at                       timestamptz not null,

  constraint purchase_history_lines_request_same_org
    foreign key (request_id, org_id)
    references purchase_requests(id, org_id) on delete restrict,
  constraint purchase_history_lines_order_same_org
    foreign key (purchase_order_id, org_id)
    references purchase_orders(id, org_id) on delete restrict,
  constraint purchase_history_lines_order_item_same_org
    foreign key (purchase_order_item_id, org_id)
    references purchase_order_items(id, org_id) on delete restrict,
  constraint purchase_history_lines_job_same_org
    foreign key (job_id, org_id)
    references purchase_jobs(id, org_id) on delete restrict,
  constraint purchase_history_lines_catalog_same_org
    foreign key (catalog_item_id, org_id)
    references purchase_item_catalog(id, org_id) on delete restrict,
  constraint purchase_history_lines_vendor_same_org
    foreign key (vendor_id, org_id)
    references purchase_vendors(id, org_id) on delete restrict,

  constraint purchase_history_lines_source
    check (capture_source in ('NATIVE', 'BACKFILL')),
  constraint purchase_history_lines_outcome
    check (receipt_outcome in ('RECEIVED', 'DAMAGED', 'WRITTEN_OFF', 'MIXED')),
  constraint purchase_history_lines_qty
    check (quantity_ordered > 0 and received_qty >= 0 and damaged_qty >= 0
           and backordered_qty_snapshot >= 0 and written_off_qty >= 0),
  constraint purchase_history_lines_prices
    check ((estimated_unit_price is null or estimated_unit_price >= 0)
       and (estimated_total_price is null or estimated_total_price >= 0)
       and (actual_unit_price is null or actual_unit_price >= 0)
       and (actual_total_price is null or actual_total_price >= 0)),
  unique (org_id, purchase_order_item_id)
);
create index purchase_history_lines_material_idx
  on purchase_history_lines(org_id, normalized_description_snapshot, completed_at desc);
create index purchase_history_lines_vendor_material_idx
  on purchase_history_lines(org_id, vendor_id, normalized_description_snapshot, completed_at desc);
create index purchase_history_lines_vendor_idx
  on purchase_history_lines(org_id, vendor_id, completed_at desc);
create index purchase_history_lines_request_idx
  on purchase_history_lines(org_id, request_id);
comment on table purchase_history_lines is
  'BR-012 immutable observed purchasing evidence. One row per COMPLETED order line, '
  'written transactionally at completion. IDs remain joinable; *_snapshot values '
  'remain literal. No UPDATE or DELETE path exists. Derived intelligence may read '
  'these rows and must never write back into them.';
comment on column purchase_history_lines.ordered_at is
  'The actual order-placement timestamp from purchase_requests.ordered_at. Never PO generated_at.';
comment on column purchase_history_lines.vendor_part_number_snapshot is
  'NULL until the material import/provider supplies a vendor part number. The history writer never guesses one.';
comment on column purchase_history_lines.backordered_qty_snapshot is
  'The most recently recorded backordered quantity at completion; was_backordered preserves whether any receipt ever reported a backorder.';
-- Terminal attempts are organizational memory, but not purchase lines. Keeping
-- them separate prevents a rejected request from inflating purchase frequency
-- or contaminating price and lead-time evidence.
create table purchase_request_outcome_history (
  id                       uuid primary key default uuid_generate_v4(),
  org_id                   uuid not null references orgs(id) on delete restrict,
  request_id               uuid not null,
  request_number_snapshot  text not null,
  job_id                   uuid,
  job_number_snapshot      text not null,
  job_name_snapshot        text,
  requester_user_id        uuid not null references users(id) on delete restrict,
  requester_name_snapshot  text not null,
  approver_user_id         uuid references users(id) on delete restrict,
  approver_name_snapshot   text,
  outcome                  text not null,
  reason_snapshot          text not null,
  requested_at             timestamptz,
  outcome_at               timestamptz not null,
  capture_source           text not null,
  recorded_at              timestamptz not null,
  constraint purchase_request_outcomes_request_same_org
    foreign key (request_id, org_id)
    references purchase_requests(id, org_id) on delete restrict,
  constraint purchase_request_outcomes_job_same_org
    foreign key (job_id, org_id)
    references purchase_jobs(id, org_id) on delete restrict,
  constraint purchase_request_outcomes_kind check (outcome in ('REJECTED', 'CANCELLED')),
  constraint purchase_request_outcomes_source check (capture_source in ('NATIVE', 'BACKFILL')),
  unique (org_id, request_id, outcome)
);
create index purchase_request_outcomes_org_time_idx
  on purchase_request_outcome_history(org_id, outcome_at desc);
comment on table purchase_request_outcome_history is
  'Immutable request-level memory for REJECTED and CANCELLED attempts. It contains '
  'no purchase-line, price, vendor-use or lead-time facts and is excluded from all '
  'derived purchasing intelligence.';
alter table purchase_history_lines enable row level security;
alter table purchase_request_outcome_history enable row level security;
create policy purchase_history_lines_read on purchase_history_lines
  for select to authenticated
  using (org_id = current_org_id());
create policy purchase_request_outcome_history_read on purchase_request_outcome_history
  for select to authenticated
  using (org_id = current_org_id());
-- Read access is explicit because newer Supabase projects may not expose new
-- public tables automatically. There are deliberately no INSERT, UPDATE or
-- DELETE grants for application roles; the lifecycle triggers are the writer.
revoke all on purchase_history_lines from anon, authenticated;
revoke all on purchase_request_outcome_history from anon, authenticated;
grant select on purchase_history_lines to authenticated;
grant select on purchase_request_outcome_history to authenticated;
-- Belt and suspenders beside the absence of write policies: even a privileged
-- accidental UPDATE/DELETE is refused. Corrections are new operational facts,
-- never revisions to the snapshot.
create or replace function purchasing_private.refuse_history_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception '% is immutable; write a new operational record instead', tg_table_name;
end
$$;
create trigger purchase_history_lines_immutable
  before update or delete on purchase_history_lines
  for each row execute function purchasing_private.refuse_history_mutation();
create trigger purchase_request_outcomes_immutable
  before update or delete on purchase_request_outcome_history
  for each row execute function purchasing_private.refuse_history_mutation();
-- One implementation for native capture and deterministic backfill. Callers
-- supply the source and timestamps; every other value is selected from the
-- completed operational records while those values are still current.
create or replace function purchasing_private.capture_completed_purchase(
  p_request purchase_requests,
  p_source text
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
begin
  if p_request.status <> 'COMPLETED' then
    raise exception 'history can only be captured for a COMPLETED request';
  end if;
  if p_request.ordered_at is null or p_request.completed_at is null then
    raise exception 'completed request % is missing ordered_at or completed_at', p_request.id;
  end if;

  insert into purchase_history_lines (
    org_id, request_id, request_number_snapshot,
    purchase_order_id, purchase_order_item_id, po_number_snapshot,
    job_id, job_number_snapshot, job_name_snapshot,
    catalog_item_id, normalizer_version, normalized_description_snapshot,
    material_description_snapshot, requested_description_snapshot,
    quantity_ordered, unit_snapshot,
    vendor_id, vendor_name_snapshot, vendor_part_number_snapshot,
    estimated_unit_price, estimated_total_price, actual_unit_price, actual_total_price,
    requester_user_id, requester_name_snapshot, approver_user_id, approver_name_snapshot,
    requested_at, approved_at, ordered_at, received_at, completed_at,
    received_qty, damaged_qty, backordered_qty_snapshot, was_backordered, written_off_qty,
    receipt_outcome, capture_source, recorded_at
  )
  select
    p_request.org_id, p_request.id, p_request.request_number,
    po.id, oi.id, po.po_number,
    j.id, p_request.job_number, j.name,
    oi.catalog_item_id, oi.normalizer_version, oi.normalized_description,
    oi.description, ri.description,
    oi.order_qty, oi.unit,
    po.vendor_id, v.name, null,
    oi.unit_cost, oi.line_total, oi.actual_unit_cost, oi.actual_line_total,
    p_request.requestor_id, requestor.full_name, po.approver_id, approver.full_name,
    coalesce(p_request.submitted_at, p_request.created_at), p_request.decided_at,
    p_request.ordered_at, p_request.received_at, p_request.completed_at,
    receipt.received_qty, receipt.damaged_qty, receipt.backordered_qty_snapshot,
    receipt.was_backordered, receipt.written_off_qty,
    case
      when receipt.damaged_qty > 0 and receipt.written_off_qty > 0 then 'MIXED'
      when receipt.damaged_qty > 0 then 'DAMAGED'
      when receipt.written_off_qty > 0 then 'WRITTEN_OFF'
      else 'RECEIVED'
    end,
    p_source, p_request.completed_at
  from purchase_orders po
  join purchase_order_items oi
    on oi.purchase_order_id = po.id and oi.org_id = po.org_id
  left join purchase_request_items ri
    on ri.id = oi.request_item_id and ri.org_id = oi.org_id
  join purchase_vendors v
    on v.id = po.vendor_id and v.org_id = po.org_id
  join users requestor on requestor.id = p_request.requestor_id
  join users approver on approver.id = po.approver_id
  left join purchase_jobs j
    on j.org_id = p_request.org_id and j.job_number = p_request.job_number
  left join lateral (
    select
      coalesce(sum(pri.received_qty), 0) as received_qty,
      coalesce(sum(pri.damaged_qty), 0) as damaged_qty,
      coalesce(sum(pri.written_off_qty), 0) as written_off_qty,
      coalesce(bool_or(pri.backordered_qty > 0), false) as was_backordered,
      coalesce((
        select newest.backordered_qty
        from purchase_receipt_items newest
        join purchase_receipts newest_receipt on newest_receipt.id = newest.receipt_id
        where newest.purchase_order_item_id = oi.id
        order by newest_receipt.created_at desc, newest.created_at desc, newest.id desc
        limit 1
      ), 0) as backordered_qty_snapshot
    from purchase_receipt_items pri
    where pri.purchase_order_item_id = oi.id
  ) receipt on true
  where po.request_id = p_request.id
    and po.org_id = p_request.org_id
  on conflict (org_id, purchase_order_item_id) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 and not exists (
    select 1 from purchase_history_lines
    where org_id = p_request.org_id and request_id = p_request.id
  ) then
    raise exception 'completed request % has no order lines to preserve', p_request.id;
  end if;
  return v_inserted;
end
$$;
revoke all on function purchasing_private.capture_completed_purchase(purchase_requests, text)
  from public, anon, authenticated;
create or replace function purchasing_private.capture_request_terminal_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text;
  v_at timestamptz;
begin
  if new.status = 'COMPLETED' and old.status is distinct from new.status then
    perform purchasing_private.capture_completed_purchase(new, 'NATIVE');
  end if;

  if new.status in ('REJECTED', 'CANCELLED') and old.status is distinct from new.status then
    v_reason := case when new.status = 'REJECTED' then new.rejection_reason else new.cancel_reason end;
    v_at := case when new.status = 'REJECTED' then new.decided_at else new.cancelled_at end;

    insert into purchase_request_outcome_history (
      org_id, request_id, request_number_snapshot,
      job_id, job_number_snapshot, job_name_snapshot,
      requester_user_id, requester_name_snapshot,
      approver_user_id, approver_name_snapshot,
      outcome, reason_snapshot, requested_at, outcome_at, capture_source, recorded_at
    )
    select
      new.org_id, new.id, new.request_number,
      j.id, new.job_number, j.name,
      new.requestor_id, requestor.full_name,
      new.approver_id, approver.full_name,
      new.status, v_reason, coalesce(new.submitted_at, new.created_at), v_at,
      'NATIVE', v_at
    from users requestor
    left join users approver on approver.id = new.approver_id
    left join purchase_jobs j on j.org_id = new.org_id and j.job_number = new.job_number
    where requestor.id = new.requestor_id
    on conflict (org_id, request_id, outcome) do nothing;
  end if;
  return new;
end
$$;
revoke all on function purchasing_private.capture_request_terminal_history()
  from public, anon, authenticated;
create trigger purchase_requests_capture_terminal_history
  after update of status on purchase_requests
  for each row execute function purchasing_private.capture_request_terminal_history();
-- Deterministic backfill. Snapshot timestamps come from the operational row;
-- migration execution time is not presented as a historical fact.
do $$
declare
  r purchase_requests%rowtype;
begin
  for r in
    select * from purchase_requests where status = 'COMPLETED' order by id
  loop
    perform purchasing_private.capture_completed_purchase(r, 'BACKFILL');
  end loop;
end
$$;
insert into purchase_request_outcome_history (
  org_id, request_id, request_number_snapshot,
  job_id, job_number_snapshot, job_name_snapshot,
  requester_user_id, requester_name_snapshot,
  approver_user_id, approver_name_snapshot,
  outcome, reason_snapshot, requested_at, outcome_at, capture_source, recorded_at
)
select
  r.org_id, r.id, r.request_number,
  j.id, r.job_number, j.name,
  r.requestor_id, requestor.full_name,
  r.approver_id, approver.full_name,
  r.status,
  case when r.status = 'REJECTED' then r.rejection_reason else r.cancel_reason end,
  coalesce(r.submitted_at, r.created_at),
  case when r.status = 'REJECTED' then r.decided_at else r.cancelled_at end,
  'BACKFILL',
  case when r.status = 'REJECTED' then r.decided_at else r.cancelled_at end
from purchase_requests r
join users requestor on requestor.id = r.requestor_id
left join users approver on approver.id = r.approver_id
left join purchase_jobs j on j.org_id = r.org_id and j.job_number = r.job_number
where r.status in ('REJECTED', 'CANCELLED')
on conflict (org_id, request_id, outcome) do nothing;
-- Compatibility: the old view name now reads immutable completed snapshots.
-- Its columns are unchanged, but ordered_at now means actual placement rather
-- than PO generation.
drop view purchase_line_history;
create view purchase_line_history as
select
  org_id,
  purchase_order_item_id           as order_item_id,
  catalog_item_id,
  normalized_description_snapshot  as normalized_description,
  material_description_snapshot    as ordered_description,
  requested_description_snapshot   as requested_description,
  quantity_ordered                 as order_qty,
  unit_snapshot                    as unit,
  estimated_unit_price             as estimated_unit_cost,
  actual_unit_price                as actual_unit_cost,
  vendor_id,
  job_number_snapshot              as job_number,
  po_number_snapshot               as po_number,
  request_id,
  ordered_at,
  requester_user_id                as requestor_id,
  received_qty
from purchase_history_lines;
alter view purchase_line_history set (security_invoker = on);
grant select on purchase_line_history to authenticated;
comment on view purchase_line_history is
  'Compatibility view over immutable COMPLETED line snapshots. security_invoker '
  'is ON. ordered_at is the actual order-placement time, not PO generation.';
-- ---------------------------------------------------------------------------
-- Derived read models. Recomputable, tenant-scoped, and read-only. Averages
-- expose their sample sizes; lead time exists only when both endpoints exist.
-- None of these views has a write path back into history.
-- ---------------------------------------------------------------------------

create or replace view purchase_material_intelligence as
with ranked as (
  select h.*,
         row_number() over (
           partition by org_id, normalized_description_snapshot
           order by completed_at desc, id desc
         ) as recency_rank
  from purchase_history_lines h
)
select
  org_id,
  normalized_description_snapshot,
  (array_agg(material_description_snapshot order by completed_at desc, id desc))[1]
    as last_description_snapshot,
  (array_agg(vendor_id order by completed_at desc, id desc))[1] as last_vendor_id,
  (array_agg(vendor_name_snapshot order by completed_at desc, id desc))[1]
    as last_vendor_name_snapshot,
  max(completed_at) as last_completed_at,
  (array_agg(coalesce(actual_unit_price, estimated_unit_price)
             order by completed_at desc, id desc)
     filter (where coalesce(actual_unit_price, estimated_unit_price) is not null))[1]
    as last_unit_price,
  avg(coalesce(actual_unit_price, estimated_unit_price))
    filter (where recency_rank <= 10
            and coalesce(actual_unit_price, estimated_unit_price) is not null)
    as recent_average_unit_price,
  count(*) filter (where recency_rank <= 10
                   and coalesce(actual_unit_price, estimated_unit_price) is not null)
    as recent_price_sample_size,
  mode() within group (order by quantity_ordered) as common_quantity,
  count(*) as completed_line_count,
  count(distinct purchase_order_id) as completed_order_count
from ranked
group by org_id, normalized_description_snapshot;
alter view purchase_material_intelligence set (security_invoker = on);
grant select on purchase_material_intelligence to authenticated;
create or replace view purchase_vendor_material_intelligence as
with ranked as (
  select h.*,
         row_number() over (
           partition by org_id, vendor_id, normalized_description_snapshot
           order by completed_at desc, id desc
         ) as recency_rank
  from purchase_history_lines h
)
select
  org_id,
  vendor_id,
  (array_agg(vendor_name_snapshot order by completed_at desc, id desc))[1]
    as vendor_name_snapshot,
  normalized_description_snapshot,
  (array_agg(material_description_snapshot order by completed_at desc, id desc))[1]
    as material_description_snapshot,
  count(distinct purchase_order_id) as completed_order_count,
  max(completed_at) as last_completed_at,
  (array_agg(coalesce(actual_unit_price, estimated_unit_price)
             order by completed_at desc, id desc)
     filter (where coalesce(actual_unit_price, estimated_unit_price) is not null))[1]
    as last_unit_price,
  avg(coalesce(actual_unit_price, estimated_unit_price))
    filter (where recency_rank <= 10
            and coalesce(actual_unit_price, estimated_unit_price) is not null)
    as recent_average_unit_price,
  count(*) filter (where recency_rank <= 10
                   and coalesce(actual_unit_price, estimated_unit_price) is not null)
    as recent_price_sample_size,
  avg(extract(epoch from (received_at - ordered_at)) / 3600.0)
    filter (where received_at is not null and ordered_at is not null)
    as observed_lead_time_hours,
  count(*) filter (where received_at is not null and ordered_at is not null)
    as lead_time_sample_size
from ranked
group by org_id, vendor_id, normalized_description_snapshot;
alter view purchase_vendor_material_intelligence set (security_invoker = on);
grant select on purchase_vendor_material_intelligence to authenticated;
create or replace view purchase_vendor_intelligence as
select
  org_id,
  vendor_id,
  (array_agg(vendor_name_snapshot order by completed_at desc, id desc))[1]
    as vendor_name_snapshot,
  count(distinct purchase_order_id) as completed_order_count,
  max(completed_at) as last_completed_at,
  array_agg(distinct material_description_snapshot) as purchased_materials,
  avg(extract(epoch from (received_at - ordered_at)) / 3600.0)
    filter (where received_at is not null and ordered_at is not null)
    as observed_lead_time_hours,
  count(*) filter (where received_at is not null and ordered_at is not null)
    as lead_time_sample_size
from purchase_history_lines
group by org_id, vendor_id;
alter view purchase_vendor_intelligence set (security_invoker = on);
grant select on purchase_vendor_intelligence to authenticated;
comment on view purchase_material_intelligence is
  'BR-013 observed material evidence from completed immutable history only. '
  'Configured vendor preference is intentionally absent.';
comment on view purchase_vendor_material_intelligence is
  'Observed vendor/material evidence. Averages and lead times include sample sizes; '
  'missing endpoints produce no lead-time observation.';
comment on view purchase_vendor_intelligence is
  'Observed vendor evidence from completed history only. It is not a vendor rating.'
