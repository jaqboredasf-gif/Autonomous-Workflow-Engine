-- ---------------------------------------------------------------------------
-- 0027 — the person who signs for the delivery has to be able to READ the order.
--
-- THE BUG THIS FIXES
-- `purchase_requests_read` let a row through for its requestor, its creator, or
-- anybody holding `request.read.all`. A foreman is none of those: he holds
-- `receiving.record` and `deliveries.confirm` and reads nobody else's
-- requests — by design.
--
-- So the field user who is the WHOLE POINT of the receiving workflow could not
-- see the orders arriving on his own job site. /deliveries listed nothing, and
-- opening a receiving screen by its URL returned a 404, because the read that
-- backs it found no row.
--
-- `purchasing_may_receive()` already exists and already encodes exactly the
-- right rule — it was written for the WRITE side (0016) and never added to the
-- read side. It grants nothing new: a field-only user still only reaches the
-- jobs they are assigned to, and everyone else must already hold
-- `receiving.record`.
--
-- The application makes the same allowance in getRequestDetail(), so the two
-- layers agree: you may read what you may be asked to sign for, and nothing
-- else.
-- ---------------------------------------------------------------------------

drop policy if exists purchase_requests_read on purchase_requests;

create policy purchase_requests_read on purchase_requests
  for select using (
    org_id = current_org_id()
    and (
      requestor_id = auth.uid()
      or created_by = auth.uid()
      or purchasing_can(auth.uid(), 'request.read.all')
      -- A receiver, scoped to their assigned jobs when they are field-only.
      or purchasing_may_receive(auth.uid(), id)
    )
  );

-- The line items of a request follow the request: if you may see the order you
-- are signing for, you may see WHAT you are signing for. Without this the
-- receiving screen renders an order with no lines on it.
drop policy if exists purchase_request_items_read on purchase_request_items;

create policy purchase_request_items_read on purchase_request_items
  for select using (
    exists (
      select 1 from purchase_requests r
       where r.id = request_id
         and r.org_id = current_org_id()
         and (
           r.requestor_id = auth.uid()
           or r.created_by = auth.uid()
           or purchasing_can(auth.uid(), 'request.read.all')
           or purchasing_may_receive(auth.uid(), r.id)
         )
    )
  );

-- Same for the purchase order and its lines: the quantities a receiver checks
-- against the pallet are the ORDER's, not the original request's.
drop policy if exists purchase_orders_read on purchase_orders;

create policy purchase_orders_read on purchase_orders
  for select using (
    org_id = current_org_id()
    and (
      purchasing_can(auth.uid(), 'request.read.all')
      or purchasing_may_receive(auth.uid(), request_id)
      or exists (
        select 1 from purchase_requests r
         where r.id = request_id
           and (r.requestor_id = auth.uid() or r.created_by = auth.uid())
      )
    )
  );
