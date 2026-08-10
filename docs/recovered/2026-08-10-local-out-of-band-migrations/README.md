# Recovered: four migrations that existed only in the local database

**These files are NOT migrations. Nothing applies them. Do not move them into
`supabase/migrations/`.** They are recovered evidence, kept so a decision can be made about
their contents rather than losing them.

## What happened

On 2026-08-10 the local Supabase stack (`supabase_db_exattime`) was found carrying four
migrations that exist in no branch of this repository:

| version | name | what it did |
| --- | --- | --- |
| `20260810133348` | `immutable_purchase_history` | a competing immutable-history design: `purchase_history_lines` (different column names), `purchase_request_outcome_history`, a `purchasing_private` schema, a **database trigger** capturing history on the terminal transition, a rewritten `purchase_line_history` view, and three intelligence views |
| `20260810140316` | `purchasing_intelligence_phase_b` | `vendor_part_number` on review and order items, with triggers copying it forward |
| `20260810173000` | `purchasing_receipt_damage_subset` | rewrote `record_purchase_receipt()` so `damaged_qty` is a **subset of** `received_qty` |
| `20260810190000` | `purchasing_pre_pilot_guards` | rewrote `guard_receipt_quantities()`, `guard_purchase_request_transition()` and `record_purchase_receipt()` again |

They were recovered from `supabase_migrations.schema_migrations.statements`, which is where the
Supabase CLI stores the text of everything it has applied. That is the only reason they still
exist: no file, no commit, no branch held them.

## Why the local database was reset instead of reconciled

The repository is the source of truth for what ships. Reproducibility means *a fresh database
built from `supabase/migrations/` behaves like the deployed one*, and that was not true while
these four lived only in one developer's container.

They also did more than add tables. Two of them **fork the domain's semantics**, in ways the
application, the domain module and six test suites contradict:

1. **`damaged_qty` as a subset of `received_qty`.** This repository treats them as separate
   facts: `received + damaged + writtenOff` is what resolves an ordered line
   (`domain/numbers.mjs: lineOutstandingQty`, and the receipt use case's
   `alreadyReceivedQty`). The recovered version treats damage as part of the arrival.
   Both are defensible. They are not compatible, and only one can be true.
2. **`ORDERED` requires recorded `SENT` evidence** on the vendor email. This repository requires
   the draft to have been **reviewed** (`domain/status.mjs`, `transitionGuard`,
   `order_before_email_review`). The recovered guard refuses the transition the application
   performs — which is why the Supabase-mode end-to-end suite could not run against this
   database.

A database that refuses what the application does is not a stricter database; it is a different
product. Resetting restores one answer.

## What was lost, precisely

Nothing of business value. The local database held only fixture data created the same day by
`scripts/provision-local-tenants.mjs` and the end-to-end harness: two organizations
(`Lippolis Electric`, `Northgate Mechanical`), eleven `@*.test` users, four purchase requests
(`PR-01001`–`PR-01004`), three purchase orders, one history row and one outcome row. No pilot
data, no customer data, no purchase order issued to a real vendor.

## What is worth arguing about, later

Kept here because dropping the schema should not drop the thinking. None of it is scheduled:

- **The row lock in `record_purchase_receipt()`.** The recovered version takes a request-scoped
  lock so concurrent receipt calls evaluate quantities after the previous one commits. The
  repository's RPC (migration 0019) has no such lock. If two receipts for one request can be
  recorded at the same moment, this is a real defect and the fix belongs in a migration of its
  own, with a test that fails without it.
- **`damaged_qty` semantics.** A product decision, not a code decision. Whichever way it goes,
  it has to move together across `domain/numbers.mjs`, both providers, the SQL guard and the
  suites.
- **`SENT` evidence before `ORDERED`.** Also a product decision: is "the workshop reviewed the
  draft" enough to call an order placed, or must a human first record that they sent it?
- **`vendor_part_number`.** The column the immutable history already reserves
  (`purchase_history_lines.vendor_part_number`) and nothing yet writes. The recovered migration
  is one way to populate it; the legacy-PO import is another.
