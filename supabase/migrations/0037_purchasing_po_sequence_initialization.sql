-- ---------------------------------------------------------------------------
-- 0037 — record WHEN the office set its own purchase order sequence.
--
-- A fresh installation starts on a built-in placeholder (LE-52901) so the
-- column is never null and the application is demonstrable from the first
-- start. That placeholder is a made-up number. The first purchase order
-- generated from it goes to a real supplier carrying a number from nobody's
-- book, colliding with wherever the company's paper sequence has actually
-- reached — and a purchase order number cannot be un-issued, because the
-- vendor already has it.
--
-- Everything else about the sequence was already safe: allocation is atomic
-- under a row lock, winding it backwards is refused, and a restore does not
-- reset it. None of that helps if the STARTING number was never the company's.
--
-- So generation refuses while this column is null, and an administrator saving
-- the sequence in Administration is what fills it in. Nullable rather than a
-- boolean with a default, because the ABSENCE is the state being recorded:
-- every row that predates this migration predates the office being asked.
--
-- Mirrors the pilot store — see the same column in
-- apps/purchasing/src/purchasing/infrastructure/sqlite/database.ts, which
-- scripts/lib/validate-migration-0016.mjs holds in lockstep with this file.
-- ---------------------------------------------------------------------------

alter table if exists public.po_number_sequences
  add column if not exists initialized_at timestamptz;

comment on column public.po_number_sequences.initialized_at is
  'When an administrator first set this organization''s own PO sequence. NULL means the built-in placeholder is still in place and purchase order generation is refused.';
