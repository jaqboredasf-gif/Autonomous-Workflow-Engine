-- ---------------------------------------------------------------------------
-- 0033 — a history row may not lie about who wrote it or how the request ended.
--
-- WHAT 0030's INSERT POLICY ALREADY GOT RIGHT
--   * the row belongs to the caller's organization
--   * the request it describes has already reached a terminal state
--
-- WHAT IT LEFT OPEN
--
-- Everything else on the row was taken on trust. A signed-in user talking to
-- PostgREST directly — which is a normal thing to be able to do; the anon key
-- and their own JWT are all it takes — could write, for their OWN organization:
--
--   * `recorded_by` naming a colleague, so the audit trail attributes the entry
--     to somebody who was not there;
--   * `terminal_state = 'CANCELLED'` for a request that in fact COMPLETED, or
--     the reverse, which changes whether the line counts as a purchase at all.
--
-- Neither is a cross-tenant leak. Both are worse in the way that matters for
-- evidence: they are lies told inside a tenant, by a real user, about their own
-- company's record, and nothing downstream could detect them — the whole point
-- of the table is that its contents are not re-derivable from anything else.
--
-- WHAT THIS DOES
--
-- Two facts stop being inputs and become assertions the database checks:
--
--   recorded_by  = auth.uid()   the recorder is whoever is holding the session.
--                               `users.id` IS the auth user id in this schema
--                               (see current_org_id()), so the application's
--                               `actor.id` already satisfies this.
--   terminal_state = the request's ACTUAL status, rather than any of the three
--                               terminal values. A row that says a purchase was
--                               cancelled must belong to a cancelled request.
--
-- Everything else on the row remains a snapshot the application supplies, and
-- deliberately so: `vendor_name` is the name the purchase order carried, which
-- the database can no longer look up by the time history is written, and
-- checking it against the vendor's CURRENT name would reintroduce exactly the
-- read-time resolution that migration 0030 exists to remove.
-- ---------------------------------------------------------------------------

drop policy if exists purchase_history_lines_insert on purchase_history_lines;

create policy purchase_history_lines_insert on purchase_history_lines
  for insert with check (
    org_id = current_org_id()
    -- The recorder is the caller. Not a name the caller chose.
    and recorded_by = auth.uid()
    and exists (
      select 1 from purchase_requests r
       where r.id = request_id
         and r.org_id = current_org_id()
         and r.status in ('COMPLETED', 'CANCELLED', 'REJECTED')
         -- and the row's account of HOW it ended matches how it actually ended
         and r.status::text = terminal_state::text
    )
  );

comment on policy purchase_history_lines_insert on purchase_history_lines is
  'History may be written only by the caller, only into the caller''s organization, only for a '
  'request that has already ended, and only with the terminal state that request actually reached.';
