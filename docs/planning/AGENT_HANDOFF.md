# Agent Handoff

## updated_at

2026-08-10T15:30:00Z

## agent

Codex

## repository and branch

- Repository: `jaqboredasf-gif/Autonomous-Workflow-Engine`
- Source baseline: `origin/claude/purchasing-control-center` at `d1bc94c`
- Task branch: `codex/pcc-phase-a-history`
- Worktree: `/private/tmp/awe-pcc-history-phase-a`
- The old `claude/lippolis-purchasing-dashboard-3ixte2` prototype was not used.

## current objective

Phase A purchasing historical memory is implemented and verified. A request's
transition to `COMPLETED` now captures one immutable evidence row per PO line in
the same database transaction. IDs remain joinable and literal snapshots remain
true after vendor, material, or job names change.

## completed work

- Added `purchase_history_lines`, an append-only table with ID + snapshot
  semantics for request, PO, job, material, vendor, requester, approver, prices,
  lifecycle timestamps, and receipt outcomes.
- Added separate immutable `purchase_request_outcome_history` for rejected and
  cancelled requests. These rows are deliberately excluded from purchasing
  frequency, price, and lead-time intelligence.
- Added PostgreSQL and SQLite completion/outcome triggers. `ordered_at` is always
  actual vendor placement time from `purchase_requests.ordered_at`, never PO
  generation time.
- Added deterministic `BACKFILL` capture for pre-existing terminal records and
  `NATIVE` capture for future lifecycle transitions.
- Added update/delete refusal triggers, RLS read policies, no application write
  grants, composite tenant foreign keys, and `security_invoker` derived views.
- Added pure material, vendor-material, and vendor intelligence derivations with
  sample sizes and lead time only where both endpoints exist.
- Added read-only history repositories to both providers. The item catalog and
  vendor-material reads now use immutable completed history, not live order and
  vendor joins; configured default vendor is not presented as observed history.
- Added line-level review context: last observed vendor, date, price, completed
  order count, and common quantity.
- Added acceptance coverage for transactional capture, ID/snapshot values,
  immutability, rename survival, deterministic recomputation, rejected-request
  exclusion, actual order time, and cross-tenant reads.

## migration

`supabase/migrations/20260810133348_immutable_purchase_history.sql`

Migration behavior:

1. Adds `normalizer_version` to request/order lines.
2. Creates the two immutable evidence tables and tenant-safe references.
3. Installs private security-definer lifecycle capture and mutation-refusal
   functions/triggers.
4. Backfills existing completed and rejected/cancelled records without guessing
   unavailable facts.
5. Recreates the legacy `purchase_line_history` compatibility view over immutable
   evidence.
6. Creates three read-only observed-intelligence views.

No hosted migration was applied.

## verification

- `npm test -w purchasing`: all component suites passed except its nested web
  build initially collided with a deliberately concurrent standalone build;
  the web suite was rerun sequentially and passed.
- `npx tsc --noEmit -p apps/purchasing`: pass.
- Domain: 284 passed.
- Authorization: 215 passed.
- Provider conformance: 286 passed.
- Tenant isolation/static BR-012/013 guards: 167 passed.
- Integration: 243 local + 244 deferred passed.
- Web acceptance: 89 passed.
- Production `next build`: pass.
- All migrations through Phase A were applied successfully during local
  PostgreSQL syntax validation.
- `npm run lint -w purchasing` remains blocked by the pre-existing monorepo
  dependency-resolution error: `next/dist/compiled/babel/eslint-parser` cannot
  be resolved by `eslint-config-next`.

## local database incident

The Supabase CLI 2.112.0 treated a `--db-url` pointing at a separately named
database on the local Supabase port as the default local target. It reset the
local stack with `--no-seed` while validating migrations. No hosted project was
touched. The local schema was immediately restored to its prior migration
boundary, `0029`, and verified there. This branch contains no `supabase/seed.sql`,
so any ad hoc rows that existed in that local development database cannot be
restored from the repository. Do not repeat this validation method; use a
separate PostgreSQL container/network, not another database on port 54322.

## remaining risks and next actions

- Hosted RLS and lifecycle behavior remain unproven because no hosted project
  was touched. Apply the migration only with explicit approval, then run the
  live RLS and Supabase web suites.
- Backfill intentionally fails if a nominally completed record lacks the
  required real `ordered_at` or `completed_at`, or has no PO lines. Audit hosted
  data before rollout.
- Vendor part number remains nullable until Phase B imports authoritative
  vendor-material data.
- Actual line price is captured only where it exists at completion. Later
  accounting corrections must become separate append-only evidence; they must
  not mutate completed history.
- Lint infrastructure remains a separate repository-wide repair.

## publish state

Commit, push, and draft PR are completed at the end of this task; resolve the
exact commit and PR from branch `codex/pcc-phase-a-history` if this handoff is
read before the final publish metadata is inserted.
