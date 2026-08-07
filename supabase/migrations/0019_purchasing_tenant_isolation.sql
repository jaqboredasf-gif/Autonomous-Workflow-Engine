-- ---------------------------------------------------------------------------
-- 0019_purchasing_tenant_isolation.sql  (Checkpoint 1D)
--
-- Tenant isolation, made structural. Three defects and one missing atomic
-- boundary, found by auditing 0016-0018 rather than by assuming they were fine.
--
--   1. purchase_line_history BYPASSED RLS. A Postgres view runs with the
--      privileges of its OWNER unless it is marked security_invoker, so row
--      level security on the underlying tables was never evaluated for the
--      caller. Any authenticated user could have read every organization's
--      purchasing history through it. This is the most serious defect found in
--      the project so far.
--
--   2. Foreign keys could point across organizations. Referential integrity is
--      checked by the system with RLS bypassed, so organization A could create
--      a request referencing organization B's delivery location, or a purchase
--      order referencing B's vendor. RLS then hid the referenced row while the
--      reference itself remained — data owned by nobody coherent.
--
--   3. Receiving was several writes with no atomic boundary. On the local
--      provider a transaction covers them; through PostgREST each is its own
--      request, so a failure between them leaves a receipt whose lines are
--      missing and a request whose status disagrees with its receipts.
--
-- Additive and non-destructive: no table is dropped, no row is rewritten. The
-- composite foreign keys REPLACE single-column ones covering the same
-- relationship, which is a constraint change rather than a data change.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The view must run as the caller.
--
-- Without this, `select * from purchase_line_history` returns every tenant's
-- rows to anyone who can reach the view. With it, the view sees exactly what
-- the caller's RLS policies allow on the underlying tables.
-- ---------------------------------------------------------------------------

alter view purchase_line_history set (security_invoker = on);

comment on view purchase_line_history is
  'Tenant-scoped purchasing history, one row per ordered line. security_invoker '
  'is ON: the view evaluates the CALLER''s row level security, not its owner''s. '
  'Removing that setting silently exposes every organization.';

-- ---------------------------------------------------------------------------
-- 2. References cannot cross organizations.
--
-- A composite foreign key is the structural version of this rule: the child
-- carries org_id, the parent is unique on (id, org_id), and the constraint
-- makes a cross-organization reference unrepresentable. That is stronger than
-- a trigger, because it cannot be disabled for a bulk load and forgotten.
-- ---------------------------------------------------------------------------

-- Parents need a unique key that includes the organization for the composite
-- reference to target. These are redundant indexes on already-unique ids, and
-- that is the price of the guarantee.
alter table purchase_vendors              add constraint purchase_vendors_id_org_key              unique (id, org_id);
alter table purchase_delivery_locations   add constraint purchase_delivery_locations_id_org_key   unique (id, org_id);
alter table purchase_requests             add constraint purchase_requests_id_org_key             unique (id, org_id);
alter table purchase_orders               add constraint purchase_orders_id_org_key               unique (id, org_id);
alter table purchase_receipts             add constraint purchase_receipts_id_org_key             unique (id, org_id);
alter table purchase_item_catalog         add constraint purchase_item_catalog_id_org_key         unique (id, org_id);
alter table purchase_jobs                 add constraint purchase_jobs_id_org_key                 unique (id, org_id);

-- A request may only point at ITS OWN organization's location and vendor.
alter table purchase_requests
  drop constraint if exists purchase_requests_delivery_location_id_fkey,
  add constraint purchase_requests_delivery_location_same_org
    foreign key (delivery_location_id, org_id)
    references purchase_delivery_locations(id, org_id),
  drop constraint if exists purchase_requests_vendor_id_fkey,
  add constraint purchase_requests_vendor_same_org
    foreign key (vendor_id, org_id)
    references purchase_vendors(id, org_id);

-- A purchase order may only point at its own organization's vendor, location
-- and request.
alter table purchase_orders
  drop constraint if exists purchase_orders_vendor_id_fkey,
  add constraint purchase_orders_vendor_same_org
    foreign key (vendor_id, org_id)
    references purchase_vendors(id, org_id),
  drop constraint if exists purchase_orders_delivery_location_id_fkey,
  add constraint purchase_orders_delivery_location_same_org
    foreign key (delivery_location_id, org_id)
    references purchase_delivery_locations(id, org_id),
  drop constraint if exists purchase_orders_request_id_fkey,
  add constraint purchase_orders_request_same_org
    foreign key (request_id, org_id)
    references purchase_requests(id, org_id);

-- Line items (which carry org_id since 0018) belong to a parent in the same
-- organization. This is the composite form of the trigger 0018 added, and the
-- two agree: the trigger sets the value, the constraint makes it unforgeable.
alter table purchase_request_items
  drop constraint if exists purchase_request_items_request_id_fkey,
  add constraint purchase_request_items_request_same_org
    foreign key (request_id, org_id)
    references purchase_requests(id, org_id) on delete restrict;

alter table purchase_order_items
  drop constraint if exists purchase_order_items_purchase_order_id_fkey,
  add constraint purchase_order_items_order_same_org
    foreign key (purchase_order_id, org_id)
    references purchase_orders(id, org_id) on delete restrict;

alter table purchase_receipt_items
  drop constraint if exists purchase_receipt_items_receipt_id_fkey,
  add constraint purchase_receipt_items_receipt_same_org
    foreign key (receipt_id, org_id)
    references purchase_receipts(id, org_id) on delete restrict;

-- A receipt belongs to the same organization as the request and order it
-- records.
alter table purchase_receipts
  drop constraint if exists purchase_receipts_request_id_fkey,
  add constraint purchase_receipts_request_same_org
    foreign key (request_id, org_id)
    references purchase_requests(id, org_id),
  drop constraint if exists purchase_receipts_purchase_order_id_fkey,
  add constraint purchase_receipts_order_same_org
    foreign key (purchase_order_id, org_id)
    references purchase_orders(id, org_id);

-- An email draft is about one organization's request and order.
alter table purchase_email_drafts
  drop constraint if exists purchase_email_drafts_request_id_fkey,
  add constraint purchase_email_drafts_request_same_org
    foreign key (request_id, org_id)
    references purchase_requests(id, org_id),
  drop constraint if exists purchase_email_drafts_purchase_order_id_fkey,
  add constraint purchase_email_drafts_order_same_org
    foreign key (purchase_order_id, org_id)
    references purchase_orders(id, org_id);

-- Catalog defaults and job defaults stay inside the organization.
alter table purchase_item_catalog
  drop constraint if exists purchase_item_catalog_default_vendor_id_fkey,
  add constraint purchase_item_catalog_vendor_same_org
    foreign key (default_vendor_id, org_id)
    references purchase_vendors(id, org_id);

alter table purchase_jobs
  drop constraint if exists purchase_jobs_default_location_id_fkey,
  add constraint purchase_jobs_location_same_org
    foreign key (default_location_id, org_id)
    references purchase_delivery_locations(id, org_id);

-- Catalog links on line items: same organization, always.
alter table purchase_request_items
  drop constraint if exists purchase_request_items_catalog_item_id_fkey,
  add constraint purchase_request_items_catalog_same_org
    foreign key (catalog_item_id, org_id)
    references purchase_item_catalog(id, org_id);

alter table purchase_order_items
  drop constraint if exists purchase_order_items_catalog_item_id_fkey,
  add constraint purchase_order_items_catalog_same_org
    foreign key (catalog_item_id, org_id)
    references purchase_item_catalog(id, org_id);

-- ---------------------------------------------------------------------------
-- Write policies for the line-item tables.
--
-- 0018 added row-local READ policies. Writes were still governed only by the
-- parent-derived policies from 0016, which means an insert had to be checked by
-- following a join. These make the write rule row-local too, and — because a
-- policy with USING and no WITH CHECK applies USING to new rows as well — an
-- insert carrying another organization's org_id is refused outright.
-- ---------------------------------------------------------------------------

create policy purchase_request_items_org_write on purchase_request_items
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());

create policy purchase_order_items_org_write on purchase_order_items
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());

create policy purchase_receipt_items_org_write on purchase_receipt_items
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());

create policy purchase_review_items_org_write on purchase_review_items
  for all using (org_id = current_org_id()) with check (org_id = current_org_id());

-- ---------------------------------------------------------------------------
-- 3. record_purchase_receipt() — receiving as ONE write.
--
-- Receiving is: a receipt row, its lines, an inventory movement per line, and a
-- status transition that depends on what is now outstanding. Through PostgREST
-- those are four round trips and four transactions; a failure between them
-- leaves a receipt with no lines, or a request whose status disagrees with the
-- quantities recorded against it.
--
-- The over-receipt rule is enforced here as well as in the domain. That is
-- deliberate duplication: the domain refuses it so a person gets a sensible
-- message, and the database refuses it so a different client, a script or a
-- future adapter cannot write a quantity nobody agreed to.
-- ---------------------------------------------------------------------------

create or replace function record_purchase_receipt(
  p_request      uuid,
  p_received_date date,
  p_lines        jsonb,                  -- [{purchase_order_item_id, received_qty, damaged_qty, backordered_qty, written_off_qty, override_reason, notes}]
  p_packing_slip text default null,
  p_notes        text default null
) returns table (receipt_id uuid, outstanding_lines integer)
language plpgsql security definer as $$
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
begin
  if v_uid is null then
    raise exception 'recording a receipt requires an authenticated human';
  end if;

  select * into r from purchase_requests where id = p_request;
  if r.id is null then raise exception 'purchase request % not found', p_request; end if;

  -- The tenant check comes FIRST, and it is not a filter: a request in another
  -- organization is not found, never forbidden.
  if r.org_id is distinct from current_org_id() then
    raise exception 'purchase request % not found', p_request;
  end if;

  if not purchasing_may_receive(v_uid, p_request) then
    raise exception 'user % may not receive against job % (assignment or role)', v_uid, r.job_number;
  end if;

  if r.status not in ('ORDERED', 'PARTIALLY_RECEIVED') then
    raise exception 'a % request is not awaiting delivery', r.status;
  end if;

  select * into v_order from purchase_orders where request_id = p_request;

  insert into purchase_receipts (org_id, request_id, purchase_order_id, received_date,
                                 received_by, packing_slip_number, notes)
  values (r.org_id, p_request, v_order.id, p_received_date, v_uid, p_packing_slip, p_notes)
  returning id into v_receipt;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_item from purchase_order_items
     where id = (v_line->>'purchase_order_item_id')::uuid;
    if v_item.id is null then
      raise exception 'line % is not on this purchase order', v_line->>'purchase_order_item_id';
    end if;
    -- A line from another organization's order cannot be received here even if
    -- its id is guessed: the item carries org_id since 0018.
    if v_item.org_id is distinct from r.org_id then
      raise exception 'line % is not on this purchase order', v_line->>'purchase_order_item_id';
    end if;

    v_received    := coalesce((v_line->>'received_qty')::numeric, 0);
    v_damaged     := coalesce((v_line->>'damaged_qty')::numeric, 0);
    v_backordered := coalesce((v_line->>'backordered_qty')::numeric, 0);
    v_written_off := coalesce((v_line->>'written_off_qty')::numeric, 0);
    continue when v_received + v_damaged + v_backordered + v_written_off = 0;

    select coalesce(sum(received_qty + damaged_qty + written_off_qty), 0) into v_already
      from purchase_receipt_items where purchase_order_item_id = v_item.id;

    if v_received > 0 and v_already + v_received > v_item.order_qty
       and coalesce(v_line->>'override_reason', '') = '' then
      raise exception 'receiving % against an order of % needs an explicit over-receipt override',
        v_already + v_received, v_item.order_qty;
    end if;

    insert into purchase_receipt_items (receipt_id, org_id, purchase_order_item_id, received_qty,
                                        damaged_qty, backordered_qty, written_off_qty,
                                        over_receipt_override, override_reason, notes)
    values (v_receipt, r.org_id, v_item.id, v_received, v_damaged, v_backordered, v_written_off,
            coalesce(v_line->>'override_reason', '') <> '', nullif(v_line->>'override_reason', ''),
            v_line->>'notes');

    if v_received > 0 then
      insert into inventory_adjustments (org_id, request_id, request_item_id, item_description,
                                         delta_qty, unit, reason, adjusted_by)
      values (r.org_id, p_request, v_item.request_item_id, v_item.description,
              v_received, v_item.unit, 'RECEIVED', v_uid);
    end if;
    if v_damaged > 0 then
      insert into inventory_adjustments (org_id, request_id, request_item_id, item_description,
                                         delta_qty, unit, reason, adjusted_by)
      values (r.org_id, p_request, v_item.request_item_id, v_item.description,
              -v_damaged, v_item.unit, 'DAMAGE', v_uid);
    end if;
  end loop;

  select count(*) into v_outstanding
    from purchase_order_items oi
   where oi.purchase_order_id = v_order.id
     and oi.order_qty > coalesce((
           select sum(ri.received_qty + ri.damaged_qty + ri.written_off_qty)
             from purchase_receipt_items ri where ri.purchase_order_item_id = oi.id), 0);

  -- The status follows the quantities, in the same transaction that wrote them.
  if v_outstanding = 0 then
    update purchase_receipts set is_final = true where id = v_receipt;
    update purchase_requests set status = 'RECEIVED', received_at = now(), updated_by = v_uid
     where id = p_request;
  elsif r.status <> 'PARTIALLY_RECEIVED' then
    update purchase_requests set status = 'PARTIALLY_RECEIVED', updated_by = v_uid
     where id = p_request;
  end if;

  receipt_id := v_receipt;
  outstanding_lines := v_outstanding;
  return next;
end $$;

comment on function record_purchase_receipt is
  'Receiving as one transaction: receipt, lines, inventory movements and the '
  'status transition that depends on them. Rolls back entirely on any failure, '
  'including the over-receipt refusal.';

-- ---------------------------------------------------------------------------
-- Storage: the policies that will govern attachments, written now so the
-- bucket cannot be created without them.
--
-- The bucket itself is created through the Storage API, not SQL, so this
-- migration cannot make it. What it CAN do is ensure that when the bucket
-- appears, cross-tenant access is already refused: every object path begins
-- with the owning organization's id, and these policies compare that prefix to
-- the caller's organization.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'storage' and table_name = 'objects') then

    execute $policy$
      create policy purchasing_storage_read on storage.objects
        for select using (
          bucket_id = 'purchasing'
          and (storage.foldername(name))[1] = current_org_id()::text
        );
    $policy$;

    execute $policy$
      create policy purchasing_storage_write on storage.objects
        for insert with check (
          bucket_id = 'purchasing'
          and (storage.foldername(name))[1] = current_org_id()::text
          and purchasing_can(auth.uid(), 'request.attach')
        );
    $policy$;
  end if;
exception
  when duplicate_object then null;  -- already applied
end $$;
