-- ---------------------------------------------------------------------------
-- 0034 — the workshop is a place somebody is assigned to, not a role they hold.
--
-- WHAT WAS WRONG
--
-- `purchasing_may_receive()` (0017) decides receiving scope in two steps:
--
--     if not purchasing_is_field_only(user) then return true;   -- shop staff
--     ... else the user must be assigned to the request's JOB NUMBER
--
-- So authority over the shop counter was INFERRED FROM A ROLE. A foreman who
-- also works the counter could be given shop receiving authority only by being
-- handed OFFICE or WORKSHOP_APPROVER — which carries approving purchases,
-- generating purchase orders and reading every request in the company. The
-- smallest grant available for "sign for a box at the shop" was most of
-- purchasing.
--
-- The destination was already known. `purchase_location_kind` has carried
-- WORKSHOP since 0016 and every request names a `delivery_location_id`. What
-- was missing was the other half: a way to say WHO covers that destination.
--
-- WHAT THIS DOES
--
-- The workshop becomes an assignable location, travelling through the
-- assignment table that has always existed and has always been one row per
-- person per location:
--
--     insert into purchasing_job_assignments (user_id, job_number)
--     values (:user, 'WORKSHOP');
--
-- and `purchasing_may_receive()` learns to read the destination's KIND rather
-- than assuming every delivery lands on a job site.
--
--   destination JOBSITE (or unknown)  -> assignment to that job number
--   destination WORKSHOP/OFFICE/
--               VENDOR_PICKUP         -> assignment to 'WORKSHOP'
--
-- Unknown-means-jobsite is what every existing row already meant, so no record
-- changes meaning and no existing assignment changes what it grants.
--
-- THE RULE IS WRITTEN TWICE, DELIBERATELY, AND MUST NOT DIVERGE
--
-- `domain/roles.mjs` `mayReceiveAt()` is the application's copy, because the
-- pilot's SQLite store has no policies and the two providers must agree. This
-- is the database's copy, and it is the one that has the last word for any
-- client — a script, a future adapter, or somebody with the anon key and their
-- own JWT. Defence in depth, the same arrangement `record_purchase_decision()`
-- already has with `decidePurchaseRequest()`.
--
-- WHY 'WORKSHOP' IS SAFE AS A KEY IN A JOB-NUMBER COLUMN
--
-- It is reserved: `RESERVED_LOCATIONS` in roles.mjs, checked by the admin write
-- path, and asserted by the authorization suite. A job cannot be numbered
-- WORKSHOP, so an assignment row carrying it can only have come from somebody
-- deliberately assigning the workshop. The alternative — a second column, or a
-- second assignment table — would be a parallel scoping system to keep in step
-- with this one, which is the thing worth avoiding.
--
-- NOT APPLIED. Written under AGENTS.md: live migrations need explicit
-- approval. Until this runs, workshop assignment works on the pilot's SQLite
-- provider and is refused by Postgres on the Supabase provider — the
-- application would offer an action the database declines. Apply it before
-- using workshop assignment on Supabase.
-- ---------------------------------------------------------------------------

create or replace function purchasing_may_receive(p_user uuid, p_request uuid)
returns boolean language plpgsql stable security definer as $$
declare
  v_job  text;
  v_kind purchase_location_kind;
begin
  if not purchasing_can(p_user, 'receiving.record') then
    return false;
  end if;

  -- Shop-counter roles are unscoped, exactly as before.
  if not purchasing_is_field_only(p_user) then
    return true;
  end if;

  select r.job_number, l.kind
    into v_job, v_kind
    from purchase_requests r
    left join purchase_delivery_locations l on l.id = r.delivery_location_id
   where r.id = p_request;

  -- Anything that does not land on a job site is covered by the workshop
  -- assignment: material delivered to the shop, dropped at the office, or
  -- collected from the vendor and brought back.
  if v_kind in ('WORKSHOP', 'OFFICE', 'VENDOR_PICKUP') then
    return exists (
      select 1 from purchasing_job_assignments
       where user_id = p_user and job_number = 'WORKSHOP'
    );
  end if;

  -- JOBSITE, or a request with no destination recorded: the job site, which is
  -- what this function has always meant.
  return exists (
    select 1 from purchasing_job_assignments
     where user_id = p_user and job_number = v_job
  );
end $$;

comment on function purchasing_may_receive(uuid, uuid) is
  'Receiving authority: the capability, plus the scope. Shop-counter roles are unscoped; '
  'a field user must be assigned to the destination — the job number for a JOBSITE delivery, '
  'or the reserved location ''WORKSHOP'' for a workshop, office or vendor-pickup delivery. '
  'Mirrored by mayReceiveAt() in domain/roles.mjs, which the pilot provider uses; the two '
  'must not diverge.';

-- A job may not be numbered WORKSHOP, or it would confer shop receiving
-- authority on everybody assigned to it. The application refuses this too
-- (isReservedLocation); this is the fence that holds for every other client.
alter table purchase_jobs
  add constraint purchase_jobs_number_not_reserved
    check (upper(btrim(job_number)) <> 'WORKSHOP');
