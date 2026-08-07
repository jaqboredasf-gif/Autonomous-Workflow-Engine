# Purchasing — history, catalog, and why the schema looks like this

Checkpoint 1C. Migration `0018_purchasing_history_and_jobs.sql`.

None of the features below are built. This document exists because the *data* they need has to
be captured now: a company's purchasing history cannot be reconstructed later from records that
never held it.

Planned, not implemented: material autocomplete from previous purchases, a standardized
organization catalog, frequently-purchased ranking, recent-item suggestions, preferred-vendor
association, unit/description reuse, reorder suggestions, purchasing analytics.

---

## 1. Line items carry their own organization

**Before:** a line item's tenant was reachable only by joining up to its request or order.

**Now:** `purchase_request_items`, `purchase_order_items`, `purchase_receipt_items` and
`purchase_review_items` each carry `org_id`, indexed with `created_at`.

Why, given the parent already has it:

- Every future feature reads across a company's **whole** history. Joining to the parent on every
  such query puts the tenant boundary one join away from the data, and an RLS policy on the item
  table has to re-derive it.
- With `org_id` on the row, the policy is `org_id = current_org_id()`, the analytics query is one
  index scan, and a line item cannot be read by the wrong tenant **even if a join is written
  carelessly**.

Denormalized data drifts, so it is constrained rather than trusted:

- `guard_line_item_org()` (Postgres trigger) forces the value to match the parent on insert and
  **refuses to let it change** — a row that could be moved between organizations is a
  cross-tenant leak with extra steps.
- The local provider has no triggers, so its repositories read the organization **from the
  parent** on every insert. It is never taken from an argument, so it cannot be spoofed.
- The integration suite asserts `count(*) where item.org_id <> parent.org_id` is zero.

Foreign keys on the item tables changed from `on delete cascade` to `on delete restrict`.
History is evidence; a parent going away must not silently take it. Business records are already
append-only, so this only ever fires on a mistake.

## 2. Two descriptions, kept separately, forever

| Column | Holds | Rewritten? |
| --- | --- | --- |
| `description` | exactly what the person typed | **never** |
| `normalized_description` | what it matched on, computed at write time | never |

Normalization (`domain/catalog.mjs`) folds case, accents, punctuation and spacing, and converges
dimensions (`2 x 4` → `2x4`). It runs in the **domain**, so both providers produce the same key
byte for byte.

The normalized form is **stored, not recomputed on read**, because these rules will change. When
they do, new lines normalize differently and old lines keep the key they were matched under —
history does not silently re-cluster because someone improved a regular expression.
`NORMALIZER_VERSION` records which rules produced a value.

### One decision worth arguing with

**Word order is preserved.** Sorting the tokens would make `1/2 to 3/4 reducer` and
`3/4 to 1/2 reducer` the same catalog entry, and those are two different fittings. So a reordered
description produces a *second* entry, which a human can merge later with the evidence in front
of them.

Over-collapsing is the more expensive mistake, because it is silent: nobody notices that two
items became one until a reorder suggestion buys the wrong part. Both behaviours are asserted in
the domain suite.

## 3. The catalog is built from history, not instead of it

`purchase_item_catalog` is an organization's own vocabulary: the normalized key, a canonical
description it can curate, a default unit, a default vendor, an optional catalog number.

Unique on `(org_id, normalized_description)` — two organizations that buy the same troffer have
**two entries**, and neither can see the other's. The organization is part of the key, not a
filter applied afterwards.

**Deliberately not present: usage counters.** A `times_ordered` column drifts the moment anything
writes a line item without updating it, and every count it could hold is derivable from the line
items, which are now indexed by organization. *Ranking is a query, not a column.*

## 4. `purchase_line_history` — the view the future features read

One row per ordered line, with organization, normalized and original descriptions, quantity,
unit, vendor, job, PO, requestor, estimated cost, actual cost and received quantity.

A view rather than a table: it cannot drift out of step with the rows it summarizes, and the
tenant boundary is written once, in one place. Read it with `org_id = current_org_id()`; never
across organizations.

## 5. Estimated cost and actual cost are different facts

A purchaser may order without knowing the price. That is normal, not a gap in the data.

| Column | Means |
| --- | --- |
| `unit_cost` / `estimated_total` | what the workshop thought at approval |
| `actual_unit_cost` / `actual_total` | what the invoice said |

Either may be unknown, and **unknown is `NULL`**. Zero means someone recorded a price of zero,
which is a different claim. The integration suite asserts actual cost stays null until something
reconciles it.

## 6. The job directory, without rewriting history

`purchase_jobs` gives jobs a record: number, name, customer, site address, status, project
manager, primary foreman, delivery instructions, default receiving location, cost code, phase.

`purchase_requests.job_number` **stays free text on purpose**, and there is deliberately no
foreign key to the directory:

- it is what the field typed, and what the vendor sees on the purchase order;
- a job later renamed, closed or removed must not rewrite the history of an order already placed.

The directory is what the interface *offers*; the text is what the record *preserves*.

---

## Internationalization — recorded as a product requirement

The interface will ship **English and Spanish**. Not built in 1C. What 1C did was avoid making it
harder:

- **Identifiers are never translated.** Statuses, roles, permissions, actions and events are
  stable keys (`PENDING_WORKSHOP_REVIEW`), stored as keys and compared as keys.
- **The domain emits keys, not sentences.** `statusMessageKey(status)` →
  `purchasing.status.PENDING_WORKSHOP_REVIEW`. `activityMessage(entry)` → a key plus the values
  to interpolate, rather than a built sentence. The timeline is the most language-sensitive
  surface in the application, because it is prose.
- **The existing English helpers remain, explicitly labelled as fallbacks.** `statusLabel()` and
  `describeActivity()` still serve the current UI; replacing those call sites with a message
  catalogue is the i18n checkpoint and needs no further domain change.
- Normalization folds accents, so `Válvula` and `Valvula` are one catalog entry — a Spanish
  interface will not fragment a company's catalog.

Still English-only, and known to be: UI strings in `app/**` and `components/**`, email templates
(they are per-organization rows, so a Spanish template is data rather than code), and validation
messages, which return codes *and* English text — the codes are the contract, so a translated UI
can use those.
