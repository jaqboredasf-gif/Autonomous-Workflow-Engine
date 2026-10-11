-- ---------------------------------------------------------------------------
-- 0024 — a purchase request has to be able to MOVE.
--
-- THE BUG THIS FIXES
-- `purchase_requests` had exactly one UPDATE policy, `purchase_requests_owner_update`,
-- and it carried a USING clause with no WITH CHECK. Postgres reuses USING as
-- the check for the NEW row in that case, so the policy read:
--
--     the row must be mine AND in DRAFT/CLARIFICATION_REQUESTED
--     ...both before AND after the update
--
-- which forbids the one thing a draft exists to do. A requester submitting
-- their own request got
--
--     new row violates row-level security policy for table "purchase_requests"
--
-- And there was NO policy at all for purchasing staff, so every later
-- transition — PO generated, email drafted, ordered, completed, cancelled,
-- tracking updated — was refused too. The whole lifecycle was unreachable on
-- the Supabase provider. (The approve/reject and receipt paths survived only
-- because they run through security-definer RPCs, which bypass RLS.)
--
-- WHAT THESE POLICIES ARE FOR, AND WHAT THEY ARE NOT
-- RLS here is the TENANT boundary and a coarse "may this person touch
-- purchasing records at all". It deliberately does NOT re-implement the
-- transition graph: `purchase_requests_transition_guard` already enforces
-- which status may follow which, in the database, on every update. Encoding
-- the graph in a policy as well would give us two copies to keep in step, and
-- the copy that silently drifts is the one that refuses a legal transition at
-- 4pm on a Friday.
--
-- The row-level rules that RLS cannot see — is this person the requestor, are
-- they assigned to this job, are they approving their own request — stay in
-- authorize(), which runs with the record in hand.
-- ---------------------------------------------------------------------------

-- 1. The owner. USING still bounds WHICH rows they may touch (their own, while
--    still editable); WITH CHECK bounds what they may leave behind (their own,
--    in their own organization). Submitting is now possible; editing somebody
--    else's request, or moving a row into another tenant, is not.
drop policy if exists purchase_requests_owner_update on purchase_requests;
create policy purchase_requests_owner_update on purchase_requests
  for update
  using (
    org_id = current_org_id()
    and (requestor_id = auth.uid() or created_by = auth.uid())
    and status in ('DRAFT', 'CLARIFICATION_REQUESTED')
    and purchasing_can(auth.uid(), 'request.update.own')
  )
  with check (
    org_id = current_org_id()
    and (requestor_id = auth.uid() or created_by = auth.uid())
  );

-- 2. Purchasing staff. Anybody holding one of the permissions that legitimately
--    moves a request forward may update rows in their own organization. Which
--    of those actions they may take on THIS record is authorize()'s decision,
--    and which status may follow is the guard trigger's.
create policy purchase_requests_processing_update on purchase_requests
  for update
  using (
    org_id = current_org_id()
    and (
      purchasing_can(auth.uid(), 'review.decide')
      or purchasing_can(auth.uid(), 'po.generate')
      or purchasing_can(auth.uid(), 'email.draft')
      or purchasing_can(auth.uid(), 'order.mark_ordered')
      or purchasing_can(auth.uid(), 'order.track')
      or purchasing_can(auth.uid(), 'receiving.record')
      or purchasing_can(auth.uid(), 'request.complete')
      or purchasing_can(auth.uid(), 'request.cancel.any')
    )
  )
  with check (org_id = current_org_id());

-- 3. Cancelling your own request. `request.cancel.own` is held by requesters
--    and foremen, who hold none of the permissions above; without this a
--    person could raise a request and never withdraw it.
--
--    BR-009: this is a CANCEL, not a delete. `purchase_requests_no_delete`
--    still refuses deletion, and no policy here grants it.
create policy purchase_requests_owner_cancel on purchase_requests
  for update
  using (
    org_id = current_org_id()
    and (requestor_id = auth.uid() or created_by = auth.uid())
    and purchasing_can(auth.uid(), 'request.cancel.own')
  )
  with check (
    org_id = current_org_id()
    and (requestor_id = auth.uid() or created_by = auth.uid())
  );

-- Line items move with their request: replaceItems() rewrites them while a
-- draft is still editable, and generating a PO writes the normalized
-- description back. Same shape as above — tenant-bounded, with the parent's
-- own guard trigger enforcing that the organizations agree.
drop policy if exists purchase_request_items_write on purchase_request_items;
create policy purchase_request_items_write on purchase_request_items
  for all
  using (
    org_id = current_org_id()
    and exists (
      select 1 from purchase_requests r
       where r.id = request_id
         and r.org_id = current_org_id()
         and (
           r.requestor_id = auth.uid()
           or r.created_by = auth.uid()
           or purchasing_can(auth.uid(), 'review.set_quantities')
         )
    )
  )
  with check (org_id = current_org_id());
