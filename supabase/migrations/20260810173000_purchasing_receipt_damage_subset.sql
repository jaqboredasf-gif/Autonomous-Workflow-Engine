-- Receipt quantities use one unambiguous convention throughout PCC:
--
--   received_qty = every unit that physically arrived
--   damaged_qty  = the unusable subset of received_qty
--
-- The original RPC added both columns when deciding whether a line was
-- fulfilled. That could close 10 ordered units after recording 10 received,
-- of which 2 were damaged, as though 12 had arrived. Inventory already uses
-- the correct subset arithmetic (+received, -damaged); this forward migration
-- makes completion use the same meaning and rejects evidence-free receipts.
--
-- Repository-only in workflow hardening. Do not apply to hosted Supabase
-- without the explicit rollout approval required by AGENTS.md.

create or replace function record_purchase_receipt(
  p_request       uuid,
  p_received_date date,
  p_lines         jsonb,
  p_packing_slip  text default null,
  p_notes         text default null
) returns table (receipt_id uuid, outstanding_lines integer)
language plpgsql security definer
set search_path = public
as $$
declare
  r              purchase_requests%rowtype;
  v_uid          uuid := auth.uid();
  v_order        purchase_orders%rowtype;
  v_receipt      uuid;
  v_line         jsonb;
  v_item         purchase_order_items%rowtype;
  v_already      numeric(14,3);
  v_received     numeric(14,3);
  v_damaged      numeric(14,3);
  v_backordered  numeric(14,3);
  v_written_off  numeric(14,3);
  v_outstanding  integer;
  v_has_quantity boolean := false;
begin
  if v_uid is null then
    raise exception 'recording a receipt requires an authenticated human';
  end if;

  select * into r from purchase_requests where id = p_request;
  if r.id is null then raise exception 'purchase request % not found', p_request; end if;

  if r.org_id is distinct from current_org_id() then
    raise exception 'purchase request % not found', p_request;
  end if;

  if not purchasing_may_receive(v_uid, p_request) then
    raise exception 'user % may not receive against job % (assignment or role)', v_uid, r.job_number;
  end if;

  if r.status not in ('ORDERED', 'PARTIALLY_RECEIVED') then
    raise exception 'a % request is not awaiting delivery', r.status;
  end if;

  -- Validate the whole payload before inserting the receipt header. The
  -- application performs the same check for a useful message; this one keeps
  -- direct RPC callers from writing an empty evidence row.
  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_received    := coalesce((v_line->>'received_qty')::numeric, 0);
    v_damaged     := coalesce((v_line->>'damaged_qty')::numeric, 0);
    v_backordered := coalesce((v_line->>'backordered_qty')::numeric, 0);
    v_written_off := coalesce((v_line->>'written_off_qty')::numeric, 0);
    if v_damaged > v_received then
      raise exception 'damaged quantity is part of what arrived and cannot exceed the received quantity';
    end if;
    if v_received + v_damaged + v_backordered + v_written_off > 0 then
      v_has_quantity := true;
    end if;
  end loop;
  if not v_has_quantity then
    raise exception 'enter at least one received, damaged, backordered, or not-coming quantity';
  end if;

  select * into v_order from purchase_orders where request_id = p_request;

  insert into purchase_receipts (
    org_id, request_id, purchase_order_id, received_date,
    received_by, packing_slip_number, notes
  ) values (
    r.org_id, p_request, v_order.id, p_received_date,
    v_uid, p_packing_slip, p_notes
  ) returning id into v_receipt;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_item from purchase_order_items
     where id = (v_line->>'purchase_order_item_id')::uuid;
    if v_item.id is null or v_item.org_id is distinct from r.org_id
       or v_item.purchase_order_id is distinct from v_order.id then
      raise exception 'line % is not on this purchase order', v_line->>'purchase_order_item_id';
    end if;

    v_received    := coalesce((v_line->>'received_qty')::numeric, 0);
    v_damaged     := coalesce((v_line->>'damaged_qty')::numeric, 0);
    v_backordered := coalesce((v_line->>'backordered_qty')::numeric, 0);
    v_written_off := coalesce((v_line->>'written_off_qty')::numeric, 0);
    continue when v_received + v_damaged + v_backordered + v_written_off = 0;

    select coalesce(sum(received_qty + written_off_qty), 0) into v_already
      from purchase_receipt_items where purchase_order_item_id = v_item.id;

    if v_written_off > greatest(v_item.order_qty - v_already - v_received, 0) then
      raise exception 'not-coming quantity cannot exceed what remains after this delivery';
    end if;

    if v_received > 0 and v_already + v_received > v_item.order_qty
       and coalesce(v_line->>'override_reason', '') = '' then
      raise exception 'receiving % against an order of % needs an explicit over-receipt override',
        v_already + v_received, v_item.order_qty;
    end if;

    insert into purchase_receipt_items (
      receipt_id, org_id, purchase_order_item_id, received_qty,
      damaged_qty, backordered_qty, written_off_qty,
      over_receipt_override, override_reason, notes
    ) values (
      v_receipt, r.org_id, v_item.id, v_received,
      v_damaged, v_backordered, v_written_off,
      coalesce(v_line->>'override_reason', '') <> '',
      nullif(v_line->>'override_reason', ''), v_line->>'notes'
    );

    if v_received > 0 then
      insert into inventory_adjustments (
        org_id, request_id, request_item_id, item_description,
        delta_qty, unit, reason, adjusted_by
      ) values (
        r.org_id, p_request, v_item.request_item_id, v_item.description,
        v_received, v_item.unit, 'RECEIVED', v_uid
      );
    end if;
    if v_damaged > 0 then
      insert into inventory_adjustments (
        org_id, request_id, request_item_id, item_description,
        delta_qty, unit, reason, adjusted_by
      ) values (
        r.org_id, p_request, v_item.request_item_id, v_item.description,
        -v_damaged, v_item.unit, 'DAMAGE', v_uid
      );
    end if;
  end loop;

  select count(*) into v_outstanding
    from purchase_order_items oi
   where oi.purchase_order_id = v_order.id
     and oi.order_qty > coalesce((
       select sum(ri.received_qty + ri.written_off_qty)
         from purchase_receipt_items ri
        where ri.purchase_order_item_id = oi.id
     ), 0);

  if v_outstanding = 0 then
    update purchase_receipts set is_final = true where id = v_receipt;
    update purchase_requests
       set status = 'RECEIVED', received_at = now(), updated_by = v_uid
     where id = p_request;
  elsif r.status <> 'PARTIALLY_RECEIVED' then
    update purchase_requests
       set status = 'PARTIALLY_RECEIVED', updated_by = v_uid
     where id = p_request;
  end if;

  receipt_id := v_receipt;
  outstanding_lines := v_outstanding;
  return next;
end $$;

comment on function record_purchase_receipt(uuid, date, jsonb, text, text) is
  'Atomic receipt write. received_qty is physical arrivals; damaged_qty is its unusable subset; written_off_qty resolves units that will not arrive.';
