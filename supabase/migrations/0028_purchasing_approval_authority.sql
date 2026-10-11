-- ---------------------------------------------------------------------------
-- 0028 — BR-011: approval AUTHORITY supersedes requester IDENTITY.
--
-- WHAT WAS WRONG
-- 0016 refused any decision made by the person who raised the request, unless
-- an org-wide `allow_self_approval` flag was switched on. That is the wrong
-- rule for this business. At Lippolis the people with purchasing authority are
-- the same people who need the material: Mike raises a request for wire and
-- Mike is the person the company has authorized to buy wire. The old rule made
-- the ordinary case a policy violation and forced a global toggle whose only
-- honest setting was "on" — at which point it protected nothing at all.
--
-- THE RULE NOW
-- One question decides it: does the caller hold `review.decide` (the
-- APPROVE_PURCHASE capability)?
--
--   * REQUEST-ONLY user  — no `review.decide`. Cannot approve their own
--                          request, cannot approve anyone else's. Unchanged,
--                          and enforced by the capability check that was
--                          already here.
--   * AUTHORIZED BUYER   — holds `review.decide`, by role or by the explicit
--                          approval grant. May approve others, and may approve
--                          their own.
--
-- Authority is granted per user (purchasing_user_roles + users.can_approve),
-- which is where a decision about who may spend money belongs — not in a
-- boolean shared by the whole organization.
--
-- AUDITABILITY IS NOT REDUCED, IT IS INCREASED
-- Refusing self-approval recorded nothing, because nothing happened. Allowing
-- it records MORE: purchase_requests.requestor_id keeps the requester,
-- purchase_approvals.approver_id keeps the decider, and the new
-- `self_approved` column below states outright when they are one person, so
-- nobody has to compare two uuids by eye to find out. The application path
-- (application/decisions.ts) writes the same column with the same meaning.
--
-- The domain mirror of this rule is apps/purchasing/src/purchasing/domain/
-- roles.mjs — authorize() no longer has an ownership test on `review.decide`,
-- and 'self_approval' is gone from its denial vocabulary.
-- ---------------------------------------------------------------------------

-- --- the audit stamp -------------------------------------------------------

alter table purchase_approvals
  add column if not exists self_approved boolean not null default false;

comment on column purchase_approvals.self_approved is
  'BR-011: the approver also raised this request. A recorded fact, never a refusal.';

-- Backfill. Most historical rows are decisions by someone other than the
-- requester — the old rule refused the rest — but an org that had switched
-- `allow_self_approval` on could have recorded self-approvals, and those rows
-- deserve the same stamp as the ones written from today on. Computed from the
-- data rather than assumed from the old policy.
update purchase_approvals a
   set self_approved = true
  from purchase_requests r
 where r.id = a.request_id
   and (r.requestor_id = a.approver_id or r.created_by = a.approver_id)
   and a.self_approved = false;

-- --- the setting that no longer gates anything -----------------------------
--
-- The column stays: dropping it would rewrite history for orgs that set it,
-- and 0016's insert path still names it. It is no longer READ by any
-- authorization path, in the database or in the application.

comment on column purchasing_settings.allow_self_approval is
  'DEPRECATED by BR-011 (migration 0028). Approval authority is a per-user '
  'capability; this flag gates nothing. Retained so existing rows keep their '
  'history. Do not read it for an authorization decision.';

-- --- the decision RPC, without the identity refusal ------------------------

/**
 * record_purchase_decision() — approve, reject, or return for clarification.
 *
 * Refuses: no session, a caller without `review.decide`, a cross-org request, a
 * request that is not in the queue, a rejection without a reason, and an
 * approval with nothing to order or with a line missing its vendor or cost.
 *
 * It does NOT refuse a decision by the person who raised the request. BR-011:
 * that is what approval authority means. The decision is stamped instead.
 */
create or replace function record_purchase_decision(
  p_request  uuid,
  p_decision purchase_decision,
  p_notes    text default null,
  p_reason   text default null
) returns purchase_request_status language plpgsql security definer as $$
declare
  r              purchase_requests%rowtype;
  v_uid          uuid := auth.uid();
  v_self         boolean;
  v_ordering     integer;
  v_missing      integer;
  v_changes      jsonb;
begin
  if v_uid is null then
    raise exception 'a purchasing decision requires an authenticated human; automation has no approval authority';
  end if;

  select * into r from purchase_requests where id = p_request;
  if r.id is null then
    raise exception 'purchase request % not found', p_request;
  end if;
  if r.org_id is distinct from current_org_id() then
    raise exception 'cross-org decision refused (request %)', p_request;
  end if;

  -- BR-011: the ONE authorization question. A user without this capability
  -- cannot decide any request — their own included, since they never reach
  -- here. A user with it can decide any request in their organization.
  if not purchasing_can(v_uid, 'review.decide') then
    raise exception 'user % does not hold review.decide', v_uid;
  end if;

  if r.status not in ('PENDING_WORKSHOP_REVIEW', 'RESUBMITTED') then
    raise exception 'a % request is not awaiting a decision', r.status;
  end if;

  -- Recorded, not refused.
  v_self := (r.requestor_id = v_uid or r.created_by = v_uid);

  select jsonb_agg(jsonb_build_object(
           'line_no', i.line_no, 'description', i.description,
           'requested_qty', i.requested_qty, 'approved_qty', ri.approved_qty,
           'usable_stock_qty', ri.usable_stock_qty, 'suggested_order_qty', ri.suggested_order_qty,
           'final_order_qty', ri.final_order_qty, 'override_reason', ri.override_reason,
           'substitute_description', ri.substitute_description))
    into v_changes
    from purchase_request_items i
    join purchase_reviews rv on rv.request_id = i.request_id
    join purchase_review_items ri on ri.request_item_id = i.id and ri.review_id = rv.id
   where i.request_id = p_request
     and (i.requested_qty is distinct from ri.final_order_qty or ri.substitute_description is not null);

  if p_decision = 'APPROVED' then
    select count(*) into v_ordering
      from purchase_reviews rv join purchase_review_items ri on ri.review_id = rv.id
     where rv.request_id = p_request and ri.final_order_qty > 0;
    if v_ordering = 0 then
      raise exception 'approve with at least one line to order, or reject the request';
    end if;
    select count(*) into v_missing
      from purchase_reviews rv join purchase_review_items ri on ri.review_id = rv.id
     where rv.request_id = p_request and ri.final_order_qty > 0
       and (ri.vendor_id is null or ri.estimated_unit_cost is null);
    if v_missing > 0 then
      raise exception 'every ordered line needs a vendor and an estimated unit cost';
    end if;

    update purchase_requests
       set status = 'APPROVED', approver_id = v_uid, decided_at = now(),
           decision_notes = p_notes, updated_by = v_uid
     where id = p_request;

    -- Stock the workshop gives up to this job is an inventory movement, and it
    -- gets a row: inventory never changes silently.
    insert into inventory_adjustments (org_id, request_id, request_item_id, item_description,
                                       delta_qty, unit, reason, adjusted_by)
    select r.org_id, p_request, i.id, i.description, -ri.stock_applied_qty, i.unit, 'STOCK_APPLIED', v_uid
      from purchase_request_items i
      join purchase_reviews rv on rv.request_id = i.request_id
      join purchase_review_items ri on ri.request_item_id = i.id and ri.review_id = rv.id
     where i.request_id = p_request and ri.stock_applied_qty > 0;

  elsif p_decision = 'REJECTED' then
    if p_reason is null or length(p_reason) = 0 then
      raise exception 'a rejection must record a reason';
    end if;
    update purchase_requests
       set status = 'REJECTED', approver_id = v_uid, decided_at = now(),
           decision_notes = p_notes, rejection_reason = p_reason, updated_by = v_uid
     where id = p_request;

  else
    if p_reason is null or length(p_reason) = 0 then
      raise exception 'a clarification must ask something';
    end if;
    update purchase_requests
       set status = 'CLARIFICATION_REQUESTED', approver_id = v_uid,
           clarification_question = p_reason, clarification_answer = null, updated_by = v_uid
     where id = p_request;
  end if;

  insert into purchase_approvals (request_id, approver_id, decision, notes, reason, changes, self_approved)
  values (p_request, v_uid, p_decision, p_notes, p_reason, coalesce(v_changes, '[]'::jsonb), v_self);

  return (select status from purchase_requests where id = p_request);
end $$;

-- The grant from 0020 is on the signature, which has not changed; `create or
-- replace` keeps it. Restated so a fresh database built from these files in
-- order ends up in the same place either way.
grant execute on function record_purchase_decision(uuid, purchase_decision, text, text) to authenticated;
