-- ---------------------------------------------------------------------------
-- 0025 — the rest of the write policies.
--
-- 0016 gave several tables a SELECT policy and no INSERT policy. Under RLS
-- that is a refusal, so on the Supabase provider the workflow stopped dead at
-- the first write to each of them:
--
--   purchase_orders               generating a purchase order
--   purchase_order_documents      storing the rendered PO sheet
--   purchase_email_drafts         drafting the vendor email (BR-010)
--   purchase_approvals            recording who decided and why (BR-008)
--   purchase_receipt_attachments  the photo a foreman takes at the gate
--
-- The approval and receipt paths partly survived because they run through
-- security-definer RPCs, which bypass RLS — but the local provider and any
-- future caller do not, so the policies belong here regardless. Defence in
-- depth means the table is safe whoever writes to it, not just safe when the
-- RPC is the one writing.
--
-- SHAPE OF EVERY POLICY BELOW
--   tenant     org_id = current_org_id()
--   authority  the permission that use case already checks in authorize()
--   append     INSERT only; the audit-bearing tables get no UPDATE and no
--              DELETE policy, and `guard_no_delete` still refuses deletion
--              (BR-009).
-- ---------------------------------------------------------------------------

-- A purchase order is created by whoever may generate one, and is then
-- IMMUTABLE except for the fields the later workflow legitimately fills in
-- (actual cost, once an invoice exists). The PO NUMBER is protected by its own
-- trigger from 0016, not by this policy.
create policy purchase_orders_write on purchase_orders
  for insert with check (
    org_id = current_org_id()
    and purchasing_can(auth.uid(), 'po.generate')
  );

create policy purchase_orders_update on purchase_orders
  for update
  using (
    org_id = current_org_id()
    and (
      purchasing_can(auth.uid(), 'po.generate')
      or purchasing_can(auth.uid(), 'order.track')
      or purchasing_can(auth.uid(), 'accounting.packet')
    )
  )
  with check (org_id = current_org_id());

-- The rendered PO sheet is evidence of what was sent. Written once, never
-- updated: there is deliberately no UPDATE policy.
create policy purchase_order_documents_write on purchase_order_documents
  for insert with check (
    exists (
      select 1 from purchase_orders o
       where o.id = purchase_order_id
         and o.org_id = current_org_id()
    )
    and purchasing_can(auth.uid(), 'po.generate')
  );

-- Vendor email drafts. `external_send_enabled` is still pinned false by the
-- CHECK constraint in 0016 — this grants the right to DRAFT, and nothing in
-- this database can grant the right to send.
create policy purchase_email_drafts_write on purchase_email_drafts
  for insert with check (
    org_id = current_org_id()
    and purchasing_can(auth.uid(), 'email.draft')
  );

-- The decision record (BR-008): actor, action, timestamp, previous and new
-- state. INSERT only — an approval that could be edited afterwards is not a
-- record of a decision, it is a note about one.
-- purchase_approvals carries no org_id of its own; its tenant is its request's.
create policy purchase_approvals_write on purchase_approvals
  for insert with check (
    exists (
      select 1 from purchase_requests r
       where r.id = request_id
         and r.org_id = current_org_id()
    )
    and purchasing_can(auth.uid(), 'review.decide')
    and approver_id = auth.uid()
  );

-- Receipt evidence: the photo of the damaged pallet, the packing slip. Written
-- by whoever recorded the receipt it belongs to.
create policy purchase_receipt_attachments_write on purchase_receipt_attachments
  for insert with check (
    exists (
      select 1 from purchase_receipts r
       where r.id = receipt_id
         and r.org_id = current_org_id()
    )
    and purchasing_can(auth.uid(), 'receiving.record')
  );

-- A receipt is a statement about what physically arrived. It is corrected by
-- recording another receipt, never by editing one — so INSERT exists (0016)
-- and UPDATE deliberately still does not.
