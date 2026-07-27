# Migration History Reconciliation Plan

## Boundary

This is a plan only. Do not connect production credentials to the replay
environment, alter the live project, or backfill its migration ledger.
Historical migrations 0001-0015 were applied as raw SQL outside
`supabase_migrations`; final object-name similarity is not proof of provenance.

## Canonical inputs

- Immutable repository migrations 0001-0015 and the four Phase 1 candidates.
- A read-only live schema-only dump and separately reviewed live-only changes.
- Seed values, row counts for every row-bearing object, enum labels/order,
  extensions and placement, storage dependencies, ownership, ACL/default ACL,
  RLS policies, function definitions/configuration, constraints, indexes, and
  triggers.
- A SHA-256 manifest of every replayed migration. No secret or production
  credential may be written to a file or committed.

## Isolated replay

1. Confirm backup/PITR status and the exact production project reference without
   changing either.
2. Provision a disposable local PostgreSQL/Supabase environment, or obtain
   separate approval for an isolated Supabase project.
3. Start from an empty application schema and replay 0001-0015 in filename order.
4. Capture a normalized schema dump plus seed/data manifest.
5. Compare it with the read-only live dump. Classify every difference as
   repository-declared, known live-only, platform-owned, or unexplained.
6. Optionally replay C1-C4 on a fresh copy, capture a second normalized dump, and
   run authorization tests there. Never reuse production credentials.

## Required comparisons

- Tables, columns, row-bearing objects, row counts, and tenant references.
- Enums including label order; constraints; indexes; triggers; extensions and
  extension schemas; storage objects and dependencies.
- RLS enablement and full policy expressions.
- Function bodies, exact signatures/overloads, return types, owners,
  `SECURITY DEFINER`/invoker mode, configuration, and `search_path`.
- Direct grants, inherited grants, PUBLIC ACLs, and owner-specific default ACLs.
- Seed rows including stable keys and values.

## Reconciliation decision

- **Verified history backfill** is eligible only if every migration boundary,
  checksum, ordered effect, ownership/default-ACL assumption, seed mutation, and
  cumulative schema state is reproducible and explained.
- **Reviewed canonical baseline** is preferred when the final intended schema can
  be proved but historical boundaries cannot. Generate it from the reviewed
  clean replay, not from an unexplained live dump.
- **Explicit ledger replacement/raw-SQL model** is a last-resort operational
  decision requiring named ownership, immutable execution records, checksums,
  drift checks, and approval for abandoning the Supabase ledger.

Do not choose history backfill solely because expected object names exist.

## Hard stops

Stop on any unexplained live object, row-bearing table mismatch, seed mismatch,
enum mismatch/order drift, unclassified ACL/default-ACL drift, unsafe
`SECURITY DEFINER` function, unknown project target or executor, missing
backup/PITR confirmation, storage dependency mismatch, or inability to reproduce
the schema in isolation. Phase 1 deployment stays blocked until every stop is
resolved or explicitly rejected through a documented security approval.

## 2026-07-27 isolated replay attempt

- The immutable PR #3 head was confirmed as
  `f42ffb3dbeb3ed5a7235f25dec6e7ebcff137168`; the PR remained open and draft
  with both reported Actions checks successful.
- Repository configuration, planning context, integration documentation,
  acceptance scripts, and database helpers independently identify production
  project `qgoiacwdntaqeghcyjlw`. The Supabase project inventory confirmed that
  project is active and distinct from the separate project
  `mzlzbnnikwblqirjyqap`.
- No supported disposable database runtime was available: Docker, PostgreSQL,
  and Supabase CLI were absent. No remote replay project was created because
  separate approval was not supplied.
- `CANONICAL_0015` and `CANONICAL_PHASE1` were therefore not produced. No
  migration was executed or transaction behavior tested.
- Read-only production catalog queries reconfirmed PostgreSQL 17.6, 24
  application tables with RLS enabled, no `supabase_migrations` schema, and
  broad owner-specific default function ACLs for `PUBLIC`, `anon`,
  `authenticated`, and `service_role`.
- The live public schema contains 18 `SECURITY DEFINER` functions. Nine have no
  function-level `search_path`: `business_role_matches`,
  `create_outbound_draft`, `emit_approval_outcome_events`,
  `emit_email_events`, `emit_outbound_insert_events`,
  `emit_outbound_update_events`, `emit_work_request_events`,
  `mark_message_sent`, and `record_approval` (nine exact signatures total).
  The remaining fixed configurations use `search_path=public`, not the safer
  `pg_catalog, public` form.
- Offline Phase 1 structural validation, migrations 0014/0015 validators,
  deterministic Runners 3-5, MCP tenant-binding tests, handoff validation, and
  `git diff --check` passed.

The inability to reproduce `CANONICAL_0015`, unclassified privileged-function
search paths, missing migration ledger, unknown migration executor, and
unconfirmed backup/PITR status activate the hard stop. Strategy D ("none are
safe yet") is the only supported reconciliation recommendation. History
backfill, baseline generation, Phase 1 merge, and deployment remain blocked.
