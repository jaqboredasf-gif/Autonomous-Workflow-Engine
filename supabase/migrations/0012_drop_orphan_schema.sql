-- Cleanup: drop the orphan schema found on the live project 2026-07-17.
-- An external session created a generic workflow engine (organizations/people/
-- roles + workflow_* tables) directly on the live DB with no committed
-- migrations, and overwrote current_org_id() to read organization_members —
-- silently breaking RLS for every Workstream A user. All orphan tables were
-- verified empty (roles had 9 foreign-seeded rows only); no repo migration,
-- policy, or code references any of them. This migration memorializes the
-- removal and the helper restore so the repo stays the source of truth.
--
-- Deliberately no CASCADE: every drop is explicit so nothing repo-owned can
-- be swept up by accident. Drop order: event trigger, then children before
-- parents, then orphan-only functions.

-- Event trigger that auto-enabled RLS on every DDL command.
drop event trigger if exists ensure_rls;
drop function if exists rls_auto_enable();

-- Workflow engine tables, children first.
drop table if exists workflow_errors;
drop table if exists workflow_queue;
drop table if exists workflow_approvals;
drop table if exists workflow_events;
drop table if exists workflow_step_runs;
drop table if exists workflow_runs;
drop table if exists workflow_step_connections;
drop table if exists workflow_triggers;
drop table if exists workflow_steps;
drop table if exists workflow_versions;
drop table if exists workflow_definitions;

-- Org/people/roles model, children first.
drop table if exists organization_member_roles;
drop table if exists organization_members;
drop table if exists people;
drop table if exists roles;
drop table if exists organizations;

-- Helpers used only by the tables above (verified: no repo triggers/policies
-- reference them; audit_time_entry_edit + set-updated patterns in repo
-- migrations are separate, repo-owned objects).
drop function if exists current_person_id();
drop function if exists current_role_key(text);
drop function if exists set_updated_at();

-- Re-assert the repo-owned current_org_id() (migration 0002 semantics).
-- The orphan schema had replaced it; it was restored live on 2026-07-17 —
-- this makes that restore part of the committed migration history.
create or replace function public.current_org_id() returns uuid
language sql stable security definer set search_path to 'public' as $$
  select org_id from users where id = auth.uid()
$$;
