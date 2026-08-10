# PCC — Next Implementation Phase

Authorization is finished and green. BR-011 and BR-014 are both closed under one
capability model, documented in `PCC_PERMISSION_MATRIX.md` and held in place by
three guards with negative controls.

**This is the sequence. Work it in order.** The dependencies below are real, not
preference: C reads what A records, D and E attach at seams that already exist,
and H is last because a pilot with real users is the point at which every
earlier shortcut becomes someone's afternoon.

---

## A. Purchasing historical-memory system

> **Full implementation handoff: `PCC_CODEX_PHASE_A_HANDOFF.md`.** It carries
> the baseline, the existing substrate, BR-012/BR-013, the raw-history field
> list, the three-layer architecture and the acceptance tests. Read it first.

**Why first:** everything downstream reads from it, and history that was not
captured cannot be backfilled.

Partial substrate already exists — every request line stores its normalized form
and `NORMALIZER_VERSION` at write time (`domain/catalog.mjs`), and
`purchase_line_history` (migration 0018) projects one row per ordered line.

**But that view is a projection, not a snapshot.** It resolves `vendor_id` at
read time, so renaming a vendor silently rewrites what every historical row
says. Phase A therefore needs an **immutable observed-history table written at
completion, carrying snapshots** — not another view. It is also missing the
approver, the received and completed timestamps, the full receipt outcome,
vendor name and part number, and anything that never became an order
(cancelled/rejected requests are invisible to an INNER JOIN on purchase_orders).

Build:
- The immutable history table and its write point, with ID **and** snapshot for
  every entity reference (`HISTORY_FIELDS` is the contract).
- Derived read models, separate and recomputable, never written back into
  history (BR-012).
- Observed kept distinct from configured — "last ordered from" is not "preferred
  vendor" (BR-013).
- "What did we pay last time" on the review screen at line level, with the date
  and vendor beside it — a price with no date is a rumour.
- Reorder signal: how often, how recently, in what quantity.

Do not: re-cluster old rows under new normalization rules. `NORMALIZER_VERSION`
exists so history keeps the key it was matched under.

**Done when:** a purchaser reviewing a line sees what this company paid, to whom
and when, without leaving the screen — and a vendor rename does not change one
word of what history says.

---

## B. Material catalog import

**Why second:** it is the authoritative list, and A's history is what makes it
useful rather than a second empty table.

Already built and tested (`domain/material-import.mjs`): column-alias mapping,
unit normalization, money parsing (`call for pricing` → null, not zero), alias
splitting, RFC-4180 quoted CSV, duplicate detection by normalized description
with both row numbers, unmapped-column reporting.

Remaining:
- The XLSX reader — a library, at the edge, converting a sheet to the table
  `normalizeMaterialImport()` already takes.
- The review screen: problems shown **before** anything is written.
- The merge into the catalogue, keyed on normalized description, preserving
  history-derived aliases and counts.
- Resolve `preferredVendorName` against the vendor directory, reporting "no
  vendor called that" rather than inventing one.

**Done when:** Mike/Rick's spreadsheet imports with every problem listed by
spreadsheet row number, and nothing is silently dropped.

---

## C. Vendor–material history and intelligence

**Depends on A and B.**

- Per vendor: what we actually buy from them, how often, at what price, with
  what lead time (ordered → received).
- Per material: which vendors have supplied it, and what each charged.
- Price movement over time — **only** where there are at least two real
  observations. One data point is not a trend and must not be drawn as one.
- Vendor part numbers from the import, surfaced on the PO.

Carry forward the open decision: preferred vendor stays **attributed notes**,
not a written `vendor_id`. The catalogue reports the vendor an item was *last
actually bought from* — evidence, not a preference.

**Done when:** choosing a vendor on a review line is an informed decision made
on screen.

---

## D. Outlook one-click draft handoff

**Attaches at `EmailDraftProvider.prepare()`. No domain change.**

1. **`.eml` first** — the cheapest real gain. Generates an RFC 5322 / MIME
   message carrying the PO attachment and the full body; the user opens it in
   Outlook and sends. **No account connection, no OAuth, no token storage.**
   State plainly: Outlook applies signatures to messages *it* composes, so do
   not promise an automatic signature on this path.
2. **Graph draft** — `POST /me/messages`, delegated OAuth, scope
   `Mail.ReadWrite` (**not** `Mail.Send`, not application permissions). The
   draft lands in the user's own Drafts folder with their signature, and they
   send it.

Non-negotiable, and enforced by existing tests: `send()` stays **absent** from
the interface, `sent` stays typed `false`, the human review gate stays, and a
draft with no recipient is still refused.

**Done when:** a purchaser goes from PO to a ready-to-send draft in their own
mail client in one click, and the system still cannot send anything.

---

## E. QuickBooks canonical job autocomplete

**Attaches at `JobDirectoryProvider`. `/jobs` already consumes it.**

**Confirm before writing any code: QuickBooks Online or Desktop?** Different
integrations — REST + OAuth 2.0 versus Web Connector / qbXML against the machine
hosting the company file. The seam is identical; the transport, auth and sync
are not.

- Cache the directory locally, refresh on a schedule. Do **not** call QuickBooks
  per keystroke: a type-ahead that depends on a third party being up is a
  type-ahead that fails mid-purchase.
- `sourceId` becomes the QuickBooks id; `jobNumber` stays what people type.
- `byNumber()` stays exact with no fuzzy fallback — it is what re-verifies a
  submitted form.
- Unreachable → `available: false` with a reason, never an empty list.

**Done when:** typing a job number or customer name returns canonical jobs, and
the stored identifier is the one QuickBooks will still recognise next year.

---

## F. Receiving and evidence hardening

Authorization is done (BR-014). This is the operational half.

- Photo capture on mobile: orientation, size limits, offline-tolerant upload.
  Evidence already travels **with** the receipt in one call — keep that.
- Discrepancy workflow: damaged, short, over, wrong item — each with a reason
  and a route to the vendor conversation.
- Backorder tracking as a first-class state, not a note.
- Partial-receipt ergonomics for one hand, in a truck, in daylight.
- Accounting packet: receipt evidence against the invoice, discrepancies first.

Keep append-only. A miscounted receipt is corrected by recording another
receipt, and 0029 now enforces that at the database.

**Done when:** a foreman can record a damaged partial delivery with a photo, in
the rain, one-handed, and accounting can see exactly what arrived.

---

## G. Actionable notifications

- Notifications that carry an action, not just an announcement: approve from the
  alert, receive from the alert.
- Digest rather than per-event noise; overdue and blocked escalate.
- Route by capability and scope, using the same model as everything else — a
  foreman is told about **his** job sites.
- Read state that survives across devices.

**Done when:** the alert badge is worth looking at, and clicking it lands on the
thing that needs doing.

---

## H. Real-user auth and pilot readiness

Last, deliberately.

- Real accounts for real people; retire the demo cast and `DEMO_PASSWORD`.
- Supabase Auth as the credential owner, password reset, session lifetime
  reviewed against how the shop actually works.
- Per-person role and capability assignment through Administration — including
  who holds APPROVE_PURCHASE and RECORD_RECEIPT, which is now the whole of the
  authorization story.
- Job assignments loaded for real foremen.
- The pilot checklist: backup, restore, a named owner for the data, and a
  rollback plan.
- Re-run every suite against the hosted project, and mark hosted RLS **PROVEN**
  — it is currently, and honestly, NOT PROVEN.

**Done when:** the people named in the handoff can sign in as themselves and run
a week of real purchasing without a developer present.

---

## Standing rules for every phase

1. **Never fabricate analytics.** Count, sum, sort. No trend from one point, no
   placeholder series. An empty panel beats a confident wrong number.
2. **Authorization is capability plus scope.** No new identity exception. The
   ownership annotation guard will fail the build if one is attempted.
3. **Enforce server-side, then in the UI.** Hiding a button is a courtesy.
4. **A guard that cannot fail proves nothing.** Every new gate gets a negative
   control, as BR-011, BR-014 and the policy scan did.
5. **External systems attach at a provider.** Nothing external is imported into
   domain logic — see `PCC_INTEGRATION_ARCHITECTURE.md`.
