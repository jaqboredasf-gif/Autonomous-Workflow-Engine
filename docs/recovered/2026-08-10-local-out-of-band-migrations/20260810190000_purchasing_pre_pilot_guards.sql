-- Pre-pilot corrections proven against the disposable local Supabase stack.
--
-- 1. 20260810173000 made damaged_qty a subset of received_qty in the receipt
--    RPC, but the older purchase_receipt_items trigger still added damage a
--    second time. A legitimate 8 received / 2 damaged / 2 replacement sequence
--    was therefore rejected as 12 against an order of 10.
-- 2. The request transition trigger used that same double-counting arithmetic.
-- 3. Both application and database allowed ORDERED after email REVIEWED even
--    though the operator-facing contract says the vendor must have been sent
--    the PO and a human must record SENT evidence first.
-- 4. Concurrent receipt RPC calls need one request-scoped row lock so each call
--    evaluates quantities after the previous call commits.
--
-- This is a forward correction. It does not rewrite receipts, history, or any
-- other business evidence, and it sends no email or order autonomously.

create or replace function guard_receipt_quantities() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ordered numeric(14,3);
  v_already numeric(14,3);
  v_remaining_after_received numeric(14,3);
begin
  select order_qty into v_ordered
    from purchase_order_items
   where id = new.purchase_order_item_id;

  -- received_qty already includes damaged_qty. Only physical arrivals and an
  -- explicit write-off resolve ordered units.
  select coalesce(sum(received_qty + written_off_qty), 0) into v_already
    from purchase_receipt_items
   where purchase_order_item_id = new.purchase_order_item_id
     and id is distinct from new.id;

  if new.damaged_qty > new.received_qty then
    raise exception 'damaged quantity is part of what arrived and cannot exceed the received quantity';
  end if;

  v_remaining_after_received := greatest(v_ordered - v_already - new.received_qty, 0);
  if new.written_off_qty > v_remaining_after_received then
    raise exception 'not-coming quantity cannot exceed what remains after this delivery';
  end if;

  if v_already + new.received_qty > v_ordered and not new.over_receipt_override then
    raise exception 'receiving % against an order of % needs an explicit over-receipt override',
      v_already + new.received_qty, v_ordered;
  end if;
  if v_already + new.received_qty > v_ordered * 2 then
    raise exception 'received quantity % is more than twice the ordered quantity %; correct the entry',
      v_already + new.received_qty, v_ordered;
  end if;
  return new;
end $$;
comment on function guard_receipt_quantities() is
  'Validates append-only receipt lines with damaged_qty as a subset of received_qty; received plus written off resolves an order.';
create or replace function guard_purchase_request_transition() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_has_review   boolean;
  v_has_po       boolean;
  v_has_mail     boolean;
  v_has_receipt  boolean;
  v_outstanding  integer;
begin
  if new.status is distinct from old.status then
    if not (
         (old.status = 'DRAFT'                   and new.status in ('SUBMITTED','CANCELLED'))
      or (old.status = 'SUBMITTED'               and new.status in ('PENDING_WORKSHOP_REVIEW','CANCELLED'))
      or (old.status = 'PENDING_WORKSHOP_REVIEW' and new.status in ('CLARIFICATION_REQUESTED','APPROVED','REJECTED','CANCELLED'))
      or (old.status = 'CLARIFICATION_REQUESTED' and new.status in ('RESUBMITTED','CANCELLED'))
      or (old.status = 'RESUBMITTED'             and new.status in ('PENDING_WORKSHOP_REVIEW','CANCELLED'))
      or (old.status = 'APPROVED'                and new.status in ('PO_GENERATED','CANCELLED'))
      or (old.status = 'PO_GENERATED'             and new.status in ('EMAIL_DRAFTED','CANCELLED'))
      or (old.status = 'EMAIL_DRAFTED'           and new.status in ('ORDERED','CANCELLED'))
      or (old.status = 'ORDERED'                 and new.status in ('PARTIALLY_RECEIVED','RECEIVED','CANCELLED'))
      or (old.status = 'PARTIALLY_RECEIVED'      and new.status in ('PARTIALLY_RECEIVED','RECEIVED','CANCELLED'))
      or (old.status = 'RECEIVED'                and new.status in ('COMPLETED','CANCELLED'))
    ) then
      raise exception 'illegal purchase request transition % -> % (request %)',
        old.status, new.status, old.id;
    end if;

    if new.status = 'APPROVED' then
      select saved_at is not null into v_has_review
        from purchase_reviews where request_id = old.id;
      if not coalesce(v_has_review, false) then
        raise exception 'approval requires a completed workshop review (request %)', old.id;
      end if;
    end if;

    if new.status = 'PO_GENERATED' then
      select exists (select 1 from purchase_orders where request_id = old.id) into v_has_po;
      if not v_has_po then
        raise exception 'PO_GENERATED requires a purchase order row (request %)', old.id;
      end if;
    end if;

    if new.status = 'EMAIL_DRAFTED' then
      select exists (
        select 1 from purchase_email_drafts
         where request_id = old.id and template_key = 'VENDOR_PURCHASE_ORDER'
      ) into v_has_mail;
      if not v_has_mail then
        raise exception 'a vendor email draft must exist before EMAIL_DRAFTED (request %)', old.id;
      end if;
    end if;

    if new.status = 'ORDERED' then
      select exists (
        select 1 from purchase_email_drafts
         where request_id = old.id
           and template_key = 'VENDOR_PURCHASE_ORDER'
           and status = 'SENT'
           and sent_at is not null
           and sent_marked_by is not null
      ) into v_has_mail;
      if not v_has_mail then
        raise exception 'the vendor email must have recorded SENT evidence before the order is placed (request %)', old.id;
      end if;
    end if;

    if new.status in ('PARTIALLY_RECEIVED', 'RECEIVED') then
      select exists (select 1 from purchase_receipts where request_id = old.id) into v_has_receipt;
      if not v_has_receipt then
        raise exception 'receiving requires a recorded receipt (request %)', old.id;
      end if;
    end if;

    if new.status in ('RECEIVED', 'COMPLETED') then
      select count(*) into v_outstanding
        from purchase_order_items oi
        join purchase_orders po on po.id = oi.purchase_order_id
       where po.request_id = old.id
         and oi.order_qty > coalesce((
               select sum(ri.received_qty + ri.written_off_qty)
                 from purchase_receipt_items ri
                where ri.purchase_order_item_id = oi.id), 0);
      if v_outstanding > 0 then
        raise exception '% line(s) are not fully resolved (request %)', v_outstanding, old.id;
      end if;
    end if;
  end if;

  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
comment on function guard_purchase_request_transition() is
  'Canonical database lifecycle guard: SENT evidence precedes ORDERED; received plus written off resolves quantities.';
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

  -- Resolve tenancy before taking a lock, so a cross-tenant caller cannot use
  -- guessed identifiers to hold another tenant's request row.
  select * into r from purchase_requests where id = p_request;
  if r.id is null then raise exception 'purchase request % not found', p_request; end if;
  if r.org_id is distinct from current_org_id() then
    raise exception 'purchase request % not found', p_request;
  end if;
  if not purchasing_may_receive(v_uid, p_request) then
    raise exception 'user % may not receive against job % (assignment or role)', v_uid, r.job_number;
  end if;

  -- Serialize receipts for this request. A waiting call re-reads the committed
  -- status and aggregate quantities after the previous call releases the lock.
  select * into r from purchase_requests where id = p_request for update;
  if r.status not in ('ORDERED', 'PARTIALLY_RECEIVED') then
    raise exception 'a % request is not awaiting delivery', r.status;
  end if;

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
  'Atomic, request-serialized receipt write. received_qty is physical arrivals; damaged_qty is its unusable subset; written_off_qty resolves units that will not arrive.'
