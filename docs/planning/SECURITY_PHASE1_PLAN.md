# Security Remediation Phase 1 Plan

## Scope and approval boundary

Phase 1 addresses C1 through C4 in repository code only. No migration in this
branch may be applied to a local, linked, remote, or production database without
separate explicit approval. The branch does not change n8n or send external
communications.

## Ordered changes

1. `20260727142118_phase1_c1_remove_undeclared_policies.sql`
   - Drop the 16 live-only `authenticated` policies on
     `integration_events`, `time_entry_audits`, `crews`, and `crew_members`.
   - Keep RLS enabled and assert that the four tables have no client policies.
   - Reuse the verified SQL from `security/c1-policy-cleanup`; do not reuse its
     live-data rehearsal or vulnerable rollback as deployment paths.
2. `20260727142120_phase1_c2_restrict_privileged_rpcs.sql`
   - Revoke default `PUBLIC`, `anon`, and `authenticated` execution on public
     functions.
   - Restore `anon`/`authenticated` execution only for the two RLS identity
     helpers, which are not application RPCs.
   - Restore `authenticated` execution only for
     `business_role_matches(uuid,business_role)` and
     `record_approval(uuid,text,text)`.
   - Keep `apply_timecard_correction(uuid)` and `mark_message_sent(uuid)`
     service-only pending reviewed internal routes.
   - Revoke and verify by exact identity arguments so overloads fail closed.
   - Require the executor to own every public function before changing its
     owner-specific default privileges.
   - Harden `set_geo_flags()` as a fixed-path definer trigger so its internal
     `haversine_m()` dependency stays closed to clients; require that API roles
     cannot create objects in `public`.
3. `20260727142121_phase1_c3_bind_time_and_crew_authorization.sql`
   - Replace broad time-entry policies with tenant-bound worker, assigned-crew
     foreman, and admin policies using both `USING` and `WITH CHECK`.
   - Add tenant-reference guards for time entries, crews, and crew membership.
   - Add narrow crew/crew-member read and admin-management policies.
4. `20260727142123_phase1_c4_mcp_tenant_contract.sql`
   - Add a service-role-only tenant assertion RPC used during MCP startup.
   - Revoke client execution and fail closed for missing or unknown tenants.
   - Pair it with server code that requires one deployment-bound `MCP_ORG_ID`,
     scopes every read and write to it, and forbids payload tenant overrides.

## Affected objects and files

- Policies: the 16 undeclared C1 policies; all `time_entries`, `crews`, and
  `crew_members` policies.
- Functions/RPCs: every function in `public` for exact-signature privilege
  reconciliation; client RLS helpers `current_org_id()` and
  `current_role_is(user_role)`; authenticated application RPCs
  `business_role_matches(uuid,business_role)` and
  `record_approval(uuid,text,text)`; new tenant guards and `assert_mcp_tenant`.
- Triggers: tenant-reference validation on `time_entries`, `crews`, and
  `crew_members`.
- Grants: function execution for `PUBLIC`, `anon`, `authenticated`, and
  `service_role`; no table grants are broadened.
- Server: `packages/mcp-server/src/index.js` plus a tenant-scoping module and
  focused tests.
- Evidence: security findings, regression checklist, planning context, decision
  log, handoff, and offline validators.

## Rollback boundaries

- C1 rollback is policy recreation, but it reopens the documented vulnerability
  and is emergency-only.
- C2 rollback restores only the previously required function grants; it must not
  restore blanket `PUBLIC` execution.
- C3 rollback restores the prior broad policies and removes validation triggers;
  this also reopens cross-crew authorization and is emergency-only.
- C4 rollback removes the assertion RPC and reverts the MCP server as one unit.
  A mixed server/database version must fail startup rather than run unbound.

Each migration is a separate transaction boundary in normal Supabase migration
execution. No rollback is executed or tested against a live project in this
task.

## Compatibility and tenant assumptions

- Mobile crew punch currently selects arbitrary org users rather than declared
  `crew_members`; after C3, a foreman may act only for members of a crew they
  lead. Existing empty crew tables mean crew mode will remain denied until
  legitimate assignments are created by an admin/service workflow.
- Browser approvals retain exactly the two RPCs they currently use.
- Corrections and send-marking need a reviewed internal route before their UI
  workflows can ship; direct authenticated RPC execution is denied.
- Service-role jobs retain only explicitly listed entry points. Service-role
  table access remains outside RLS and must be tenant-filtered in code.
- One MCP process serves exactly one organization. `MCP_ORG_ID` is trusted
  deployment configuration, never a tool argument or model-controlled value.
- User, crew, job-site, and cost-code references must belong to the same
  organization as the row being written.

## Required validation

- Offline SQL structural validation for C1-C4, including policy, grant, trigger,
  and post-condition checks.
- RLS scenarios: worker own-row success; cross-user and cross-tenant denial;
  foreman assigned-crew success; unassigned-crew denial; admin same-tenant
  success; cross-tenant reference rejection.
- RPC scenarios: exact-signature allow-list success; overload denial; anonymous
  and authenticated denial for every other signature; trigger/internal denial;
  and explicitly justified service paths.
- MCP scenarios: missing/invalid tenant fails startup, tenant override is
  rejected, every read is scoped, every insert is forced to the bound tenant,
  and startup rejects an unknown tenant.
- Repository handoff validator, `git diff --check`, JavaScript tests, existing
  offline evals, and relevant builds/typechecks.
- Live-only regression and SQL behavior commands are recorded as not run when
  credentials or explicit migration approval are unavailable.

## Pre-deployment verification and approval gate

Historical migrations 0001-0015 were applied as raw SQL outside
`supabase_migrations`; no live history repair is authorized. Complete
`MIGRATION_HISTORY_RECONCILIATION_PLAN.md` before deployment.

Immediately before any future live apply, compare the live policy/function/grant
inventory and migration history with this branch. Stop on any mismatch. Dry-run
all four migrations inside an explicitly rolled-back transaction, run the full
pre-change regression, obtain explicit approval, then apply in order. Afterward,
run RLS/RPC cross-tenant tests, MCP tenant-binding tests, database advisors, and
the full regression suite. No part of that live procedure is authorized here.

C2 narrows execution privileges only. It does not claim the entire RPC surface
is secure: remaining `SECURITY DEFINER` functions without a fixed safe
`search_path` must be remediated or explicitly gated before deployment.
