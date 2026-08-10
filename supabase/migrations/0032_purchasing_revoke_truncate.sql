-- ---------------------------------------------------------------------------
-- 0032 — TRUNCATE is not filtered by row level security.
--
-- THE DEFECT, FOUND BY ASKING THE LIVE DATABASE THE OBVIOUS QUESTION
--
-- Every append-only guarantee in this system is built from three fences:
-- an INSERT-only policy set, no UPDATE or DELETE grant, and a BEFORE DELETE
-- trigger. All three are about ROWS. `TRUNCATE` is not a row operation:
--
--   * row level security does NOT apply to it — there is no per-row check to
--     make, so the tenant boundary is simply not consulted;
--   * `BEFORE DELETE ... FOR EACH ROW` triggers do NOT fire for it;
--   * it is a privilege of its own, and Supabase's default privileges grant it
--     to `anon` and `authenticated` on every new table in `public`.
--
-- Which meant, verified against the local stack before this migration was
-- written: an ordinary signed-in user of ONE organization could execute
--
--     truncate purchase_history_lines;
--
-- and delete EVERY organization's purchasing history in one statement. The same
-- was true of the audit log, the receipts, the approvals and the orders — 57
-- tables in total. Nothing in the application issues TRUNCATE, so this was pure
-- exposure: a privilege granted by default, used by nobody, and sufficient on
-- its own to destroy the evidence the other fences exist to protect.
--
-- It predates the immutable history and is not caused by it. It is fixed here
-- because history is the reason it matters: a record that one user can erase
-- for every tenant is not evidence, however carefully its rows are guarded.
--
-- WHAT THIS DOES
--   1. revokes TRUNCATE from anon and authenticated on every table in `public`
--   2. revokes it from the DEFAULT privileges too, so a table created by a
--      later migration does not quietly get it back
--   3. adds a statement-level guard to the append-only business records, so
--      even a caller that somehow holds the privilege is refused with a message
--      that says why
--
-- The application is unaffected: neither provider issues TRUNCATE, and the
-- pilot's SQLite store has no such statement at all.
-- ---------------------------------------------------------------------------

-- --- 1. take the privilege away --------------------------------------------

do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('revoke truncate on public.%I from anon, authenticated', t.relname);
  end loop;
end $$;

-- --- 2. and stop it coming back on the next table --------------------------
--
-- Migrations run as `postgres`, so these are the defaults that would apply to
-- anything a later migration creates. Without this, migration 0033 would create
-- a table with the same hole and nobody would notice.

alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated;

-- --- 3. a statement-level guard on the records that are evidence ------------
--
-- guard_no_delete() is `for each row` and cannot see a TRUNCATE. This is its
-- statement-level counterpart, and it is deliberately narrow: it protects the
-- records whose value comes from being complete — the ones where a missing row
-- is itself the damage.

create or replace function guard_no_truncate() returns trigger
language plpgsql as $$
begin
  raise exception
    'truncate is refused on %.%: these records are evidence, and evidence is not cleared in bulk',
    tg_table_schema, tg_table_name;
end $$;

comment on function guard_no_truncate() is
  'Statement-level counterpart to guard_no_delete(): row triggers do not fire for TRUNCATE and RLS does not apply to it.';

create trigger purchase_history_lines_no_truncate
  before truncate on purchase_history_lines for each statement execute function guard_no_truncate();

create trigger purchase_receipts_no_truncate
  before truncate on purchase_receipts for each statement execute function guard_no_truncate();

create trigger purchase_receipt_items_no_truncate
  before truncate on purchase_receipt_items for each statement execute function guard_no_truncate();

create trigger purchase_approvals_no_truncate
  before truncate on purchase_approvals for each statement execute function guard_no_truncate();

create trigger purchase_activity_log_no_truncate
  before truncate on purchase_activity_log for each statement execute function guard_no_truncate();
