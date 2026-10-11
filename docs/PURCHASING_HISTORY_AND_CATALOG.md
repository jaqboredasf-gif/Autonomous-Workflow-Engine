# Purchasing — history, catalog, and why the schema looks like this

Checkpoint 1C. Migration `0018_purchasing_history_and_jobs.sql`.

> **Superseded in part by Phase A.** Section 4 described `purchase_line_history`, a VIEW.
> Migration `0030_purchasing_immutable_history.sql` **drops that view** and replaces it with
> `purchase_history_lines`, an immutable snapshot table. Everything else here still holds.
> Read [§4](#4-purchase_history_lines--the-immutable-record) for what replaced it and why.

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

## 4. `purchase_history_lines` — the immutable record

Migration `0030_purchasing_immutable_history.sql`. This replaces `purchase_line_history`, which
was a view.

### Why the view had to go

The view was one row per ordered line, resolved from live entities at read time. That is the
right shape for a projection and the wrong shape for history, and the difference only becomes
visible once a company has been using the system for a year:

| The view did this | Which meant |
| --- | --- |
| resolved `vendor_id` at read time | renaming a vendor rewrote every historical row that mentioned it |
| read `description` from the live line item | re-describing a material rewrote what past purchases said |
| `INNER JOIN purchase_orders` | a **cancelled or rejected** request was invisible — history recorded only the purchases that succeeded |
| had no approver, no received/completed timestamps | "who approved this and how long did it take" was unanswerable |
| collapsed everything into `received_qty` | damaged, backordered and written-off quantities were lost |
| used `purchase_orders.generated_at` as `ordered_at` | lead time measured from the wrong event |

BR-012 makes completed purchasing activity **immutable evidence**. A record that changes when
somebody edits a vendor is not evidence, and no number of extra columns on a view would make it
one.

### The rule the table encodes: the id **and** the snapshot

Every entity a history row refers to appears twice — as an id, and as the value it had at the
time:

| Id | Snapshot |
| --- | --- |
| `vendor_id` | `vendor_name` |
| `request_id` | `request_number` |
| `purchase_order_id` | `po_number` |
| `job_id` | `job_number` |
| `requestor_id` / `approver_id` | `requestor_name` / `approver_name` |
| `request_item_id` | `requested_description`, `ordered_description`, `unit` |

The id keeps the row **joinable** to whatever the entity is called today. The snapshot keeps the
row **true** about what was bought at the time. Neither is derived from the other on read,
because the point is that they are allowed to disagree.

### Written once, at the terminal transition

One row per **request line**, written when the request reaches `COMPLETED`, `CANCELLED` or
`REJECTED` — including a line the workshop filled entirely from stock, which never became an
order line and is still part of what happened.

- **Write point:** `application/history.ts`, called from `completePurchaseRequest`,
  `cancelPurchaseRequest` and the reject branch of `decidePurchaseRequest`. It runs *inside* the
  terminal transition's unit of work: if history cannot be written, the request does not end.
- **Not a trigger.** A trigger would have to exist twice — plpgsql for production, JavaScript for
  the pilot — and two copies of a rule are two rules. `domain/history.mjs` builds the rows;
  both providers only write them.
- **Idempotent.** Unique on `(org_id, request_id, request_item_id)`; both providers
  insert-or-ignore, so a retried completion completes rather than failing on a duplicate.

### Append-only, enforced rather than intended

| Where | How |
| --- | --- |
| Postgres RLS | a SELECT policy and an INSERT policy, and **no UPDATE or DELETE policy at all** |
| Postgres triggers | `guard_no_update()` and `guard_no_delete()` — for the callers RLS does not reach |
| The INSERT policy | additionally requires the request to be *already* terminal |
| SQLite (pilot) | `BEFORE UPDATE` / `BEFORE DELETE` triggers that `raise(ABORT, …)` |
| The repository interface | offers `record`, `forRequest`, `listForOrg` — and no way to change a row |

A correction is a new request, exactly as a miscounted receipt is a new receipt.

### Cancellation and rejection — the policy

Stated in three places that must agree: this document, the migration header, and
`domain/history.mjs` where the functions that depend on it live.

1. **A cancelled or rejected request IS recorded**, with `terminal_state` and the reason given
   verbatim. "We asked for this and were refused" is exactly the fact a manager reconstructing a
   decision needs, and it is the fact the old view threw away.
2. **Whether a row counts toward money and timing follows from the facts on the row, not from its
   label:**
   - *pricing* requires `ordered_at is not null and ordered_qty > 0` — the line actually reached a
     vendor. A rejected request can never satisfy that (`REJECTED` cannot reach `ORDERED` in the
     transition graph), so it is excluded by construction rather than by a special case.
   - a request **cancelled after** it was placed did commit money at a real price, so it **is**
     price evidence and counts.
   - *lead time* requires `ordered_at` **and** `received_at`. A line that never arrived reports
     nothing — never a zero.
3. **Demand is a different question from purchase.** Every row is demand; only ordered rows are
   purchases. `countsTowardDemand` / `countsTowardPurchaseFrequency` / `countsTowardPricing` keep
   them apart, because conflating them is how a rejected request quietly inflates a frequency
   count.

### What reads it

The item catalogue's "last ordered from", "last price" and "last ordered at" now come from these
snapshots on **both** providers. Previously the local provider joined `vendors` and the Supabase
provider embedded `purchase_vendors` — the same rename bug, written twice. The integration suite
renames the vendor, the material, the job and the approver, re-reads, and asserts nothing moved;
removing the fix makes that assertion fail (verified by negative control).

Derived intelligence (`summarizeMaterial`, `summarizeByMaterial` in `domain/history.mjs`) is a
pure fold over these rows: recomputable, never written back, and every average reported with its
sample size.

### One consequence worth stating plainly

History is written **at the terminal transition**, so a purchase that has been ordered but not yet
completed contributes nothing to "last ordered from" or "last price" until it ends. That is the
correct reading of BR-012 — the row cannot be written early and corrected later, because
correcting it is exactly what the table forbids — but it means a material bought for the first
time last week shows no price to the purchaser until that request completes.

The counts the catalogue shows for *requests* (`timesRequested`, `lastRequestedAt`) are unchanged
and still come from the live request lines, so a newly requested item still appears in
autocomplete immediately. It appears **without** a vendor or a price, which is the honest answer:
nobody has finished buying it yet.

If the pilot finds that gap unacceptable, the fix is a **separate, clearly-labelled read** of
in-flight orders ("on order from …"), not an early write into history.

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
