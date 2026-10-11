-- ---------------------------------------------------------------------------
-- 0029 — BR-014, finished at the persistence layer: the lines and the evidence
-- answer to the same authority as the receipt they belong to.
--
-- WHAT WAS WRONG
-- The receipt HEADER was properly gated. 0017 replaced its insert policy with
-- `purchasing_may_receive(auth.uid(), request_id)` — capability plus job scope,
-- exactly what BR-014 asks for.
--
-- The receipt LINES were not, and they are where the numbers live:
--
--   0016  purchase_receipt_items_write      insert, requires receiving.record
--                                           (capability, but NO job scope)
--   0019  purchase_receipt_items_org_write  FOR ALL, requires only that the row
--                                           belongs to the caller's org
--
-- Postgres ORs permissive policies together, so the weakest one decided: any
-- authenticated member of the organization could write, alter or remove the
-- quantities on a receipt, including a requester holding no receiving
-- capability at all. The header said who may sign for a delivery; the lines
-- said what was delivered, and asked nobody.
--
-- `FOR ALL` also quietly granted UPDATE and DELETE. Receipts are append-only —
-- purchase_receipts has a no-delete trigger and is corrected by recording
-- ANOTHER receipt, never by editing one — but its lines had neither the trigger
-- nor a policy that stopped it. An audit trail whose numbers can be revised in
-- place is not an audit trail.
--
-- WHAT THIS DOES
--   1. one INSERT policy on the lines, matching the header: tenancy AND
--      purchasing_may_receive() against the parent receipt's request
--   2. no UPDATE or DELETE policy at all, so both are refused by RLS
--   3. the same no-delete trigger the other business records carry
--   4. the same authority on receipt EVIDENCE — a photograph of a damaged
--      pallet is part of the receipt, so it follows the receipt's scope rather
--      than only its capability
--
-- Both application providers only ever INSERT receipt lines (sqlite and
-- Supabase repositories alike), so nothing legitimate loses a write path.
--
-- The RPC is unaffected: record_purchase_receipt() is SECURITY DEFINER and
-- re-checks purchasing_may_receive() itself before writing anything.
-- ---------------------------------------------------------------------------

-- --- receipt lines ---------------------------------------------------------

drop policy if exists purchase_receipt_items_write on purchase_receipt_items;
drop policy if exists purchase_receipt_items_org_write on purchase_receipt_items;

create policy purchase_receipt_items_write on purchase_receipt_items
  for insert with check (
    org_id = current_org_id()
    and exists (
      select 1 from purchase_receipts r
       where r.id = receipt_id
         and r.org_id = current_org_id()
         -- The SAME question the header asked. A line cannot be attached to a
         -- receipt the caller would not have been allowed to create.
         and purchasing_may_receive(auth.uid(), r.request_id)
    )
  );

-- No UPDATE policy and no DELETE policy, deliberately. A miscounted receipt is
-- corrected by recording another one, which leaves both statements in the
-- history with their own actor and timestamp.
create trigger purchase_receipt_items_no_delete
  before delete on purchase_receipt_items for each row execute function guard_no_delete();

-- --- receipt evidence ------------------------------------------------------
--
-- 0025 gated this on the capability alone. A foreman could therefore attach a
-- photograph to a receipt for a job site he is not assigned to — harmless in
-- itself, incoherent as a rule, and the kind of gap that gets copied.

drop policy if exists purchase_receipt_attachments_write on purchase_receipt_attachments;

create policy purchase_receipt_attachments_write on purchase_receipt_attachments
  for insert with check (
    exists (
      select 1 from purchase_receipts r
       where r.id = receipt_id
         and r.org_id = current_org_id()
         and purchasing_may_receive(auth.uid(), r.request_id)
    )
  );

comment on table purchase_receipt_items is
  'Append-only. Written only by someone who may receive against the parent request (BR-014); corrected by recording another receipt, never by editing.';
