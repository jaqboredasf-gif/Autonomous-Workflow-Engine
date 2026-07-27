# Agent Handoff

## updated_at

2026-07-27T18:30:00Z

## agent

Codex

## repository

jaqboredasf-gif/Autonomous-Workflow-Engine

## branch

`chore/agent-handoff-integration` (read-only deployment review performed from
the existing worktree; PR #3 was inspected at immutable head
`30d222d00b1ac48121bd52a1ff67dcdf07aa5cde`).

## commit

No commit created. The user explicitly prohibited commits, pushes, merges, and
code changes.

## current objective

Completed a read-only Phase 1 deployment-readiness review. Do not deploy Phase
1. Repository declarations, migration history, and live state disagree, so the
mandatory repository stop condition is active.

## completed work

- Read every requested repository planning/security source, all four Phase 1
  migrations, the migration chain, and the validation harnesses.
- Reviewed draft PR #3 at its immutable head as a deployment artifact.
- Inventoried live RLS, policies, roles, grants, RPCs, triggers, indexes,
  constraints, extensions, schemas, migration history, and aggregate tenant
  integrity using read-only queries.
- Compared repository assumptions to documented and freshly queried live state.
- Produced the migration-by-migration deployment matrix, verification SQL,
  rollback checkpoints, risks, confidence scores, approval gates, and next
  prompt in this handoff.

## pull request

- Draft PR #3: https://github.com/jaqboredasf-gif/Autonomous-Workflow-Engine/pull/3
- Base: `main` at `dbf8f1755f1afefa8f7e44caa6c59bdf7e2863b1`
- Head: `security/phase-1-remediation` at
  `30d222d00b1ac48121bd52a1ff67dcdf07aa5cde`
- State: open draft, mergeable, two validation checks passed.
- Deployment review result: not deployable; passing checks are repository-only
  and do not prove live compatibility.

## deployment readiness review

Deployment readiness score: **38/100**.

The linked live project is `qgoiacwdntaqeghcyjlw`; the repository project ref,
hard-coded validation targets, and documented integration target all agree.
There is also a second active project named `AWE`
(`mzlzbnnikwblqirjyqap`), so the target must be restated at approval time.

Live evidence that matches repository assumptions:

- PostgreSQL is 17 and the required `public`, `auth`, `storage`, `extensions`,
  and `graphql_public` schemas exist.
- Required roles exist; `service_role` has `BYPASSRLS`; `anon` and
  `authenticated` do not.
- All 24 live `public` tables have RLS enabled.
- The exact 16 C1 live-only policies still exist on `integration_events`,
  `time_entry_audits`, `crews`, and `crew_members`.
- The five C3 predecessor time-entry policies exist with the expected names.
- All C3 prerequisite tables, types, functions, foreign keys, and primary keys
  exist.
- Tenant aggregate checks found 1 org, 2 users, 0 crews, 0 crew members, and 42
  time entries, with zero cross-tenant user, creator, job-site, or cost-code
  references and zero invalid crew assignments.
- None of the three C3 validation triggers or the C4 assertion RPC exists yet,
  as expected before Phase 1.

Blocking disagreements and unknowns:

- Supabase's migration-list API returns zero migrations and the live database
  has no `supabase_migrations` schema, although repository migrations 0001-0015
  are materially present in the schema. This is migration drift/manual-SQL
  evidence and activates the mandatory stop condition.
- PR #3 documentation says C2 restores only two browser RPCs, but the migration
  directly grants four mutation/helper RPCs to `authenticated`:
  `business_role_matches`, `record_approval`,
  `apply_timecard_correction`, and `mark_message_sent`. The intended contract
  is internally inconsistent.
- C2 revokes execution from every public function. Live inventory shows broad
  `PUBLIC` execution plus direct `anon`/`authenticated` grants on many helper
  and trigger functions. No authenticated client-call inventory proves that
  removing `check_territory`, `route_outbound`, or other direct RPC access is
  compatible.
- C2's `ALTER DEFAULT PRIVILEGES` is owner-specific. The effective migration
  execution role and existing `pg_default_acl` must be proven before relying on
  the future-function fail-closed claim.
- Several live security-definer RPCs do not pin a safe `search_path`, including
  `business_role_matches`, `record_approval`, `mark_message_sent`, and
  `create_outbound_draft`. Phase 1 does not repair that existing risk.
- The C3 crew policy joins need indexes on `crews(foreman_id)` and
  `crew_members(user_id)` for predictable RLS performance; neither exists.
- C3 triggers validate only new/changed rows. Current aggregate data is clean,
  but a final pre-apply check must be performed in the same maintenance window.
- Empty crew tables mean foreman crew operations will be denied until legitimate
  assignments are provisioned. This is fail-closed but operationally breaking.
- C4 requires a coordinated database/server release and a verified
  deployment-secret `MCP_ORG_ID`; neither runtime configuration nor rollout
  mechanism was verified.
- Live Auth server configuration (site URL, redirect allow-list, JWT lifetime,
  anonymous sign-in, enabled providers, SMTP, CAPTCHA, MFA) is control-plane
  state and cannot be completely proven with PostgreSQL `SELECT` statements.
- Table/sequence grants, storage bucket configuration, PostgREST exposed-schema
  configuration, database advisors, backups/PITR, and rollback scripts require
  explicit review before approval.

## migration deployment matrix

### C1 — remove undeclared policies

- Prerequisites: four tables exist, RLS is enabled, and exactly the named 16
  policies are the only policies on those tables.
- Expected before-state: verified live; 16 named authenticated policies exist.
- Expected after-state: zero policies on the four tables and RLS enabled on all
  four.
- Rollback: recreating policies restores the vulnerability; emergency-only.
- Failure conditions: table missing, unexpected extra policy, RLS disabled, or
  insufficient policy ownership.
- Data-loss risk: no row writes; policy metadata only.
- Tenant-isolation risk: low on successful apply; high if rolled back.
- Confidence: 85/100, conditional on same-window recheck.

### C2 — restrict privileged RPCs

- Prerequisites: every referenced function signature/type exists; complete
  client RPC dependency inventory; migration role/default ACL identified.
- Expected before-state: verified broad `PUBLIC` and direct client execution.
- Expected after-state: only the explicit allow-list is client executable and
  service-role execution remains.
- Rollback: restore only proven required function grants, never blanket
  `PUBLIC`.
- Failure conditions: missing/modified signature, undocumented client caller,
  overloaded routine, owner mismatch, default-ACL mismatch, or a grant not
  visible through the migration's whitelist query.
- Data-loss risk: none directly; application outage/blocked workflows possible.
- Tenant-isolation risk: improves on success; remains high through unpinned
  security-definer search paths.
- Confidence: 35/100.

### C3 — bind time and crew authorization

- Prerequisites: predecessor policies/functions/types/tables exist; all existing
  tenant-reference aggregate checks return zero; legitimate crew data and
  client behavior are understood.
- Expected before-state: verified five broad predecessor policies, no three
  validation triggers, clean aggregate data, and empty crews.
- Expected after-state: three enabled tenant-validation triggers; three
  time-entry policies; two crew policies; two crew-member policies; client
  execution revoked on trigger functions.
- Rollback: dropping guards and restoring broad policies reopens cross-crew and
  cross-tenant authorization risks; emergency-only.
- Failure conditions: invalid existing workflow, modified enum/signature,
  policy-name drift, missing table/function privilege, trigger interaction, or
  RLS query-plan regression.
- Data-loss risk: no direct row changes; legitimate writes may be rejected.
- Tenant-isolation risk: materially improves, but performance and runtime
  behavior remain unproven.
- Confidence: 60/100.

### C4 — MCP tenant contract

- Prerequisites: `public.orgs` exists; C2 applied first; service-role grant
  works; database and MCP server deploy atomically; valid `MCP_ORG_ID` is
  provisioned outside Git.
- Expected before-state: verified assertion RPC absent; one live org exists.
- Expected after-state: assertion RPC exists, is security-definer with fixed
  search path, and is executable only by service role; MCP startup fails closed
  for missing/unknown tenant.
- Rollback: database RPC and server must roll back together; mixed versions
  intentionally fail startup.
- Failure conditions: missing/wrong tenant ID, grant drift, stale API schema
  cache, database/server version skew, or unscoped code path outside wrapper.
- Data-loss risk: no direct database row change; service outage possible.
- Tenant-isolation risk: high until runtime integration is proven, low after
  complete coordinated verification.
- Confidence: 45/100.

Recommended deployment order remains C1 → C2 → C3 → C4, but only after migration
history reconciliation. Checkpoints: capture catalogs before C1; verify zero C1
policies; verify exact C2 ACL allow-list and browser workflows; verify C3
triggers/policies and tenant scenarios; deploy C4 database/server together and
verify startup binding. Stop and restore the last known-safe application
version at any failed checkpoint; do not use vulnerable policy recreation as a
routine rollback.

## exact verification commands

Run against the explicitly confirmed production ref
`qgoiacwdntaqeghcyjlw`. Every statement below is read-only.

```sql
SELECT current_database(), current_user, session_user, version();

SELECT n.nspname AS schema_name, pg_get_userbyid(n.nspowner) AS owner
FROM pg_namespace n
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
ORDER BY n.nspname;

SELECT e.extname, e.extversion, n.nspname AS schema_name
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY e.extname;

SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
       rolreplication, rolbypassrls
FROM pg_roles
WHERE rolname IN ('postgres','anon','authenticated','service_role',
                  'authenticator','supabase_auth_admin',
                  'supabase_storage_admin')
ORDER BY rolname;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','storage')
ORDER BY n.nspname, c.relname;

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual,
       with_check
FROM pg_policies
WHERE schemaname IN ('public','storage')
ORDER BY schemaname, tablename, policyname;

SELECT table_schema, table_name, grantee, privilege_type, is_grantable
FROM information_schema.table_privileges
WHERE table_schema IN ('public','storage')
  AND grantee IN ('PUBLIC','anon','authenticated','service_role')
ORDER BY table_schema, table_name, grantee, privilege_type;

SELECT object_schema, object_name, column_name, grantee, privilege_type,
       is_grantable
FROM information_schema.column_privileges
WHERE object_schema IN ('public','storage')
  AND grantee IN ('PUBLIC','anon','authenticated','service_role')
ORDER BY object_schema, object_name, column_name, grantee, privilege_type;

SELECT sequence_schema, sequence_name, grantee, privilege_type
FROM information_schema.usage_privileges
WHERE object_type = 'SEQUENCE'
  AND sequence_schema = 'public'
  AND grantee IN ('PUBLIC','anon','authenticated','service_role')
ORDER BY sequence_name, grantee, privilege_type;

SELECT n.nspname AS schema_name, p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       p.prosecdef AS security_definer, p.provolatile AS volatility,
       pg_get_userbyid(p.proowner) AS owner, p.proconfig,
       pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.proname, identity_arguments;

SELECT routine_name, specific_name, grantee, privilege_type, is_grantable
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND grantee IN ('PUBLIC','anon','authenticated','service_role')
ORDER BY routine_name, specific_name, grantee;

SELECT defaclrole::regrole AS owner, n.nspname AS schema_name,
       defaclobjtype, defaclacl
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
ORDER BY owner::text, schema_name, defaclobjtype;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       t.tgname AS trigger_name, t.tgenabled,
       pg_get_triggerdef(t.oid, true) AS definition,
       pn.nspname AS function_schema, p.proname AS function_name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
JOIN pg_namespace pn ON pn.oid = p.pronamespace
WHERE NOT t.tgisinternal AND n.nspname = 'public'
ORDER BY c.relname, t.tgname;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       i.relname AS index_name, ix.indisunique, ix.indisprimary,
       ix.indisvalid, ix.indisready, pg_get_indexdef(i.oid) AS definition
FROM pg_index ix
JOIN pg_class c ON c.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
ORDER BY c.relname, i.relname;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       con.conname AS constraint_name, con.contype AS constraint_type,
       con.convalidated, pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
ORDER BY c.relname, con.conname;

SELECT to_regnamespace('supabase_migrations') AS migration_schema,
       to_regclass('supabase_migrations.schema_migrations')
         AS migration_table;

SELECT version, name
FROM supabase_migrations.schema_migrations
ORDER BY version;

SELECT
  (SELECT count(*) FROM public.orgs) AS org_count,
  (SELECT count(*) FROM public.users) AS user_count,
  (SELECT count(*) FROM public.crews) AS crew_count,
  (SELECT count(*) FROM public.crew_members) AS crew_member_count,
  (SELECT count(*) FROM public.time_entries) AS time_entry_count,
  (SELECT count(*) FROM public.time_entries te
     JOIN public.users u ON u.id=te.user_id
    WHERE u.org_id IS DISTINCT FROM te.org_id) AS bad_entry_user_tenant,
  (SELECT count(*) FROM public.time_entries te
     JOIN public.users u ON u.id=te.created_by
    WHERE u.org_id IS DISTINCT FROM te.org_id) AS bad_entry_creator_tenant,
  (SELECT count(*) FROM public.time_entries te
     JOIN public.job_sites j ON j.id=te.job_site_id
    WHERE j.org_id IS DISTINCT FROM te.org_id) AS bad_entry_site_tenant,
  (SELECT count(*) FROM public.time_entries te
     JOIN public.cost_codes cc ON cc.id=te.cost_code_id
    WHERE cc.org_id IS DISTINCT FROM te.org_id) AS bad_entry_cost_tenant,
  (SELECT count(*) FROM public.crews c
     JOIN public.users u ON u.id=c.foreman_id
    WHERE u.org_id IS DISTINCT FROM c.org_id
       OR u.role::text <> 'foreman' OR NOT u.is_active) AS bad_foremen,
  (SELECT count(*) FROM public.crew_members cm
     JOIN public.crews c ON c.id=cm.crew_id
     JOIN public.users u ON u.id=cm.user_id
    WHERE u.org_id IS DISTINCT FROM c.org_id
       OR NOT u.is_active) AS bad_crew_members;

SELECT i.provider, count(*) AS identity_count
FROM auth.identities i
GROUP BY i.provider
ORDER BY i.provider;

SELECT count(*) AS auth_users,
       count(*) FILTER (WHERE is_anonymous) AS anonymous_users,
       count(*) FILTER (WHERE banned_until > now()) AS currently_banned_users
FROM auth.users;
```

The `SELECT version, name ...` statement is expected to fail while the
`supabase_migrations` schema/table remains absent; that failure is itself the
blocking evidence. Auth control-plane settings must additionally be exported
read-only from the Supabase dashboard/API because SQL cannot fully inventory
them.

## approval gates

1. Confirm the exact production project ref is `qgoiacwdntaqeghcyjlw`, not the
   second project named `AWE`.
2. Reconcile how repository migrations 0001-0015 reached live while
   `supabase_migrations` is absent. Do not fabricate or backfill history without
   a separately reviewed recovery plan and explicit approval.
3. Resolve the C2 allow-list contradiction and produce a proven client RPC
   call-site inventory.
4. Prove the migration execution role and default ACL behavior.
5. Review/fix or explicitly accept unsafe search paths on security-definer RPCs.
6. Verify all SQL above again in the deployment window; every tenant mismatch
   count must be zero and every catalog diff must be explained.
7. Export and review Auth/Data API control-plane configuration read-only.
8. Add a reviewed rollback artifact per migration and verify backup/PITR
   availability; do not use vulnerable policy recreation as normal rollback.
9. Run pre-deployment application regression and authenticated role scenarios
   in an isolated non-production clone/branch under separate authorization.
10. Obtain explicit approval for PR merge, migration execution, and coordinated
    C4 server rollout. These are three distinct approvals.

## files changed

- `docs/planning/AGENT_HANDOFF.md` only.

All pre-existing modified and untracked user files were preserved.

## migrations

No migration was created, modified, applied, rehearsed, or rolled back.

## commands run

- Read-only local file and Git status inspection.
- Read-only GitHub PR #3 metadata, immutable file-content, and diff inspection.
- Supabase project listing.
- Supabase migration listing.
- Live `SELECT` catalog and aggregate tenant-integrity queries only.
- Official Supabase documentation/changelog lookup.

## tests passed

- Live target correlation to repository project ref.
- C1 exact policy-name and RLS prerequisite verification.
- C3 schema prerequisite and aggregate tenant-integrity verification.
- PR #3 remains draft and its existing GitHub validation checks pass.

## tests failed

- Migration-history reconciliation: live history is empty/absent while the
  schema materially reflects repository migrations.
- Deployment-readiness review: failed closed.

## live changes

None. Supabase was queried read-only. GitHub was queried read-only. No code,
migration, Git ref, PR state, or external service was modified.

## approvals required

All gates in `approval gates` above. No deployment approval should be issued
until migration history is reconciled and C2's contract is made internally
consistent.

## risks

See `deployment readiness review` and `migration deployment matrix`.

## blockers

Primary blocker: repository migration history and live migration history
disagree. Secondary blockers: C2 allow-list/documentation contradiction,
unproven RPC compatibility, incomplete Auth/control-plane inventory, and
unverified C4 coordinated rollout.

## exact next prompt

Perform a read-only migration-history forensics task for Supabase project
`qgoiacwdntaqeghcyjlw`. Determine exactly how repository migrations 0001-0015
reached the live schema despite the absent `supabase_migrations` history.
Compare immutable repository SQL to live object definitions and produce a
non-mutating reconciliation plan. Also resolve the PR #3 C2 RPC allow-list
contradiction with a complete application call-site inventory. Do not modify
code or documentation, do not commit/push/merge, do not apply or repair
migration history, and do not modify Supabase.
