-- ---------------------------------------------------------------------------
-- 0031 — make purchase_history_lines reachable, and only in the two ways it
--        is allowed to be reached.
--
-- THE DEFECT THIS FIXES
--
-- Migration 0030 created the table with row level security and two policies,
-- and stopped there. Supabase does not auto-expose a new table: PostgREST
-- answers "permission denied for table purchase_history_lines" BEFORE RLS is
-- ever consulted, so a correct policy on an ungranted table protects nothing
-- and serves nobody.
--
-- The effect in production would have been silent and total: every purchase
-- would have completed on the pilot store and failed to record history on
-- Supabase — or, worse, failed the completion itself, since the history write
-- is inside the terminal transition and a completion that cannot be recorded
-- does not complete.
--
-- No offline suite could have caught it. The pilot's SQLite store has no
-- concept of a grant, and the static conformance suite reads table NAMES, not
-- privileges. It took applying 0030 to a real Supabase stack, which is the
-- same way 0020 found that the whole purchasing schema was unreachable
-- (documented in docs/PURCHASING_PRODUCTION_GAPS.md §4a0).
--
-- WHY select AND insert, AND NOTHING ELSE
--
-- 0020's block grants `select, insert, update` to every purchasing table. This
-- table deliberately does not follow that pattern. BR-012 makes history
-- append-only, and the grant is the outermost of the three fences that say so:
--
--   1. GRANT      — the privilege to UPDATE or DELETE is never handed out
--   2. RLS        — no UPDATE policy and no DELETE policy exist (0030)
--   3. TRIGGER    — guard_no_update() / guard_no_delete() raise (0030)
--
-- Any one of the three would refuse the statement. Having all three means a
-- future migration that carelessly adds a policy still cannot make history
-- editable, and a future migration that carelessly grants UPDATE still cannot
-- either. A correction is a new request, and it takes three mistakes rather
-- than one to change that.
--
-- WHY NOT service_role
--
-- service_role bypasses RLS. Granting it write access to history would create
-- exactly one path by which a row could be written outside the tenant boundary
-- and outside the terminal-state check, and nothing in the application needs
-- it: history is written by the request-scoped client, as the signed-in user
-- who ended the request, which is also what makes `recorded_by` mean something.
-- The privileged client is used for administrative identity writes only (see
-- infrastructure/supabase/context.ts) and must never touch this table.
-- ---------------------------------------------------------------------------

grant select, insert on public.purchase_history_lines to authenticated;

-- Stated rather than assumed. `grant select, insert` does not imply the others,
-- but writing the revoke down means a reader does not have to know that, and a
-- copy-paste of 0020's `select, insert, update` block into a later migration
-- gets undone here rather than silently widening the table.
revoke update, delete on public.purchase_history_lines from authenticated;
revoke update, delete on public.purchase_history_lines from anon;
revoke update, delete on public.purchase_history_lines from service_role;

-- anon is not a member of any organization and has no business reading a
-- company's purchasing history. Nothing granted it anything; this says so.
revoke all on public.purchase_history_lines from anon;
