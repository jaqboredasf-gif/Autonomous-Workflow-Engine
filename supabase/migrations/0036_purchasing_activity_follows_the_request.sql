-- ---------------------------------------------------------------------------
-- 0036 — the activity trail follows the request, for everyone who may read it.
--
-- WHAT WAS WRONG
--
-- 0016 gave `purchase_activity_log` a read policy under a comment saying "the
-- timeline is visible to anyone who can see the request it belongs to". The
-- policy did not say that. It said: an auditor, the requestor, the creator, or
-- somebody holding `request.read.all`.
--
-- 0027 then widened who may see a request — a receiver may read the order they
-- are going to sign for — and updated `purchase_requests`, its items and the
-- purchase order. It did not update the activity log, because nothing pointed
-- at it.
--
-- The result is the combination worth naming: the foreman who signs for the
-- delivery may WRITE activity (0023 lets any member record their own actions)
-- and may not READ any, including the row recording the receipt he just took.
-- His request page renders the Activity panel — titled "every meaningful
-- action, with who did it and when" — containing the words "Nothing recorded
-- yet", about an order with a dozen recorded events. That is not a hidden
-- panel. It is a panel that states something false.
--
-- WHAT THIS DOES
--
-- Restates the read policy so it means what 0016's comment always claimed:
-- if you may see the request, you may see what has happened to it. The added
-- clause is `purchasing_may_receive()`, the SAME predicate 0027 used, so this
-- grants nobody anything they cannot already read on the request itself — a
-- field-only user still only reaches their assigned jobs, and everybody else
-- must already hold `receiving.record`.
--
-- Deliberately NOT widened: the org-wide audit log still needs `admin.audit`.
-- Reading one order's history because you are receiving it is a different
-- thing from reading the company's.
--
-- APPEND-ONLY IS UNTOUCHED. This is a SELECT policy. There is still no UPDATE
-- and no DELETE policy on this table, so the trail remains evidence.
-- ---------------------------------------------------------------------------

drop policy if exists purchase_activity_read on purchase_activity_log;

create policy purchase_activity_read on purchase_activity_log
  for select using (
    org_id = current_org_id()
    and (
      purchasing_can(auth.uid(), 'admin.audit')
      or exists (
        select 1 from purchase_requests r
         where r.id = request_id
           and (
             r.requestor_id = auth.uid()
             or r.created_by = auth.uid()
             or purchasing_can(auth.uid(), 'request.read.all')
             -- The receiver, scoped exactly as 0027 scopes them on the request.
             or purchasing_may_receive(auth.uid(), r.id)
           )
      )
    )
  );

comment on policy purchase_activity_read on purchase_activity_log is
  'The timeline follows the request: whoever may read the request may read its history. '
  'The org-wide log still needs admin.audit.';
