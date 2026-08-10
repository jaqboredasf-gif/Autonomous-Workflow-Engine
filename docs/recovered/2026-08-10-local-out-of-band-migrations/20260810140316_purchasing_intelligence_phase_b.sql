-- Phase B: purchasing intelligence, kept additive to the frozen Phase A
-- immutable-history architecture.

alter table purchase_review_items
  add column vendor_part_number text;
alter table purchase_order_items
  add column vendor_part_number text;
comment on column purchase_review_items.vendor_part_number is
  'Vendor-specific identifier entered or explicitly reused by a purchaser.';
comment on column purchase_order_items.vendor_part_number is
  'Order-time snapshot copied from the review line; later review edits do not rewrite it.';
-- The application provider passes the value explicitly. This insert-only
-- fallback keeps the database generate_purchase_order RPC on the same contract
-- without replacing that large, established function.
create or replace function purchasing_private.copy_review_vendor_part_number()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.vendor_part_number is null then
    select ri.vendor_part_number
      into new.vendor_part_number
      from purchase_review_items ri
      join purchase_reviews r on r.id = ri.review_id
      join purchase_orders po on po.id = new.purchase_order_id
     where ri.request_item_id = new.request_item_id
       and r.request_id = po.request_id;
  end if;
  return new;
end $$;
create trigger purchase_order_items_copy_vendor_part_number
  before insert on purchase_order_items
  for each row execute function purchasing_private.copy_review_vendor_part_number();
-- Phase A remains the sole history writer. This trigger only fills one
-- snapshot column on INSERT from the order line referenced by the new history
-- row. UPDATE and DELETE remain rejected by the Phase A immutability guards.
create or replace function purchasing_private.snapshot_vendor_part_number()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.vendor_part_number_snapshot is null then
    select oi.vendor_part_number
      into new.vendor_part_number_snapshot
      from purchase_order_items oi
     where oi.id = new.purchase_order_item_id
       and oi.org_id = new.org_id;
  end if;
  return new;
end $$;
create trigger purchase_history_lines_snapshot_vendor_part_number
  before insert on purchase_history_lines
  for each row execute function purchasing_private.snapshot_vendor_part_number()
