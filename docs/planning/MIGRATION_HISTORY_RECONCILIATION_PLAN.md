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
