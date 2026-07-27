# Security Findings

Findings remain open until repository changes are explicitly approved, applied
to the live project, and verified there. This branch prepares fixes only.

## C1 — Undeclared client policies on service-only tables

The documented live inventory contains 16 `authenticated` policies on
`integration_events`, `time_entry_audits`, `crews`, and `crew_members` that no
repository migration declares. They allow ordinary org users to read, forge,
rewrite, or delete integration and audit evidence. The C1 migration removes
only those policies, preserves RLS, and writes no rows.

Prepared work reused: the exact 16-policy inventory, drop set, and RLS
post-condition from `security/c1-policy-cleanup`.

Prepared work not promoted: the rehearsal writes probe data and is safe only
inside its rollback; the rollback recreates vulnerable policies. Neither is an
apply path for Phase 1.

## C2 — Public execution on privileged functions

Postgres grants function execution to `PUBLIC` by default. Existing migrations
create security-definer and mutation RPCs without a complete privilege
declaration, making the exposed surface depend on project defaults. C2 revokes
client execution across `public`, explicitly restores only required identity
helpers and authenticated-human RPCs, preserves service-role execution, and
changes future defaults to fail closed.

## C3 — Broad time-entry and crew authorization

Current time-entry policies let any foreman read and update every employee in
the organization. The insert policy also treats `created_by = auth.uid()` as
sufficient without requiring the caller to be a foreman or the employee to be
assigned to that foreman's crew. Foreign keys do not ensure referenced users,
sites, cost codes, crews, and members share a tenant.

C3 adds same-tenant validation triggers and policies for worker ownership,
declared-crew foreman authority, and same-tenant admin authority. Cross-tenant
references and unassigned crew actions fail closed.

## C4 — MCP service role is not tenant bound

The MCP server currently uses a service-role key and performs unscoped queries;
`log_lead` chooses the first organization in the database. Because service role
bypasses RLS, a caller can observe or act across tenants.

C4 requires a deployment-bound `MCP_ORG_ID`, verifies it through a
service-role-only startup RPC, scopes every read by `org_id`, forces every insert
to the bound tenant, and rejects payload overrides. One server process serves
one tenant.

## Live state

No Phase 1 migration has been applied by this task. The documented C1 live
inventory was last verified on 2026-07-27 on the preserved preparation branch.
C2-C4 require a fresh authorized live inventory and rolled-back dry run before
deployment. Repository declarations and live state must be compared again at
that approval gate; any disagreement stops the deployment.
