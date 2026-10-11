-- ---------------------------------------------------------------------------
-- 0026 — a vendor email draft has to be able to advance.
--
-- Same defect as 0024, on a different table. `purchase_email_drafts_edit` read
--
--     using (org_id = current_org_id()
--            and purchasing_can(auth.uid(), 'email.draft')
--            and status = 'GENERATED')
--
-- with no WITH CHECK, so Postgres reused the USING expression to check the NEW
-- row — and a draft could therefore never leave GENERATED. Every draft was
-- permanently unreviewable.
--
-- That mattered beyond the email screen: transitionGuard refuses ORDERED
-- without `hasReviewedEmailDraft`, so an order could never be marked placed
-- either. The lifecycle stopped at PO_GENERATED for good.
--
-- The replacement keeps the tenant boundary and the permission, and drops the
-- status clause from the check. WHICH transitions a draft may make
-- (GENERATED → REVIEWED → APPROVED_TO_SEND → SENT) is the application's rule,
-- in advanceEmailDraft(); a policy that also encodes it is a second copy that
-- will disagree.
--
-- What RLS still guarantees here: only somebody who may draft vendor email, in
-- this organization, can touch these rows at all.
--
-- Sending remains impossible regardless of any policy: `external_send_enabled`
-- is pinned false by a CHECK constraint in 0016, so enabling it is a reviewed
-- migration and a new adapter, not a flag anybody can flip.
-- ---------------------------------------------------------------------------

drop policy if exists purchase_email_drafts_edit on purchase_email_drafts;

create policy purchase_email_drafts_edit on purchase_email_drafts
  for update
  using (
    org_id = current_org_id()
    and purchasing_can(auth.uid(), 'email.draft')
  )
  with check (
    org_id = current_org_id()
    and purchasing_can(auth.uid(), 'email.draft')
  );
