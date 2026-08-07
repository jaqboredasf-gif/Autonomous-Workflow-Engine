-- ---------------------------------------------------------------------------
-- 0023 — the activity log and the notification inbox need WRITE policies.
--
-- THE BUG THIS FIXES
-- Migration 0016 enabled row level security on `purchase_activity_log` and
-- `purchase_notifications` and gave each of them a SELECT policy — and no
-- INSERT policy at all. Under RLS that is not "no restriction", it is a
-- refusal: every insert from a caller's client is rejected.
--
-- Every purchasing use case emits at least one activity event, and most emit a
-- notification too. So on the Supabase provider, raising a request failed with
--
--   new row violates row-level security policy for table "purchase_activity_log"
--
-- and nothing could be created at all. The local provider was unaffected,
-- which is why it went unnoticed: SQLite has no RLS to forget.
--
-- WHY THESE POLICIES AND NOT BROADER ONES
-- The audit trail is append-only evidence. These grant INSERT and nothing
-- else: there is deliberately no UPDATE and no DELETE policy on either table,
-- so a row, once written, cannot be altered or removed by any caller —
-- including the one who wrote it. That is what makes it evidence rather than
-- notes.
--
-- An actor may only write activity attributed to THEMSELVES. `actor_id is
-- null` is allowed for the system rows the application writes with no human
-- behind them (scheduled work, provisioning), and those carry actor_name
-- 'system' by convention.
-- ---------------------------------------------------------------------------

-- Activity: write your own history, in your own organization.
create policy purchase_activity_write on purchase_activity_log
  for insert with check (
    org_id = current_org_id()
    and purchasing_is_member(auth.uid(), org_id)
    and (actor_id = auth.uid() or actor_id is null)
  );

-- Notifications: a use case fans an event out to its audience, so the row's
-- recipient is somebody ELSE by design. The tenant boundary is what bounds it:
-- a caller may only create notifications inside their own organization, and
-- the existing read policy still means only the recipient can see one.
create policy purchase_notifications_write on purchase_notifications
  for insert with check (
    org_id = current_org_id()
    and purchasing_is_member(auth.uid(), org_id)
  );

comment on table purchase_activity_log is
  'Append-only. INSERT is policy-allowed for members writing their own actions; there is no UPDATE or DELETE policy, on purpose.';
