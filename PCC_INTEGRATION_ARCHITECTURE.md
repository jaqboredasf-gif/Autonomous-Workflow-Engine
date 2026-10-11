# PCC Integration Architecture

How other systems attach to the Purchasing Control Center — and why the seams
look the way they do.

Nothing described here is speculative plumbing. Every seam listed is declared in
code, bound to a working implementation over purchasing's own data, and covered
by tests. What is missing is the external adapter, and each section says exactly
where it plugs in.

- Interfaces: `apps/purchasing/src/purchasing/application/integrations.ts`
- Current bindings: `apps/purchasing/src/purchasing/infrastructure/providers/builtin.ts`
- Wiring: `apps/purchasing/src/purchasing/composition.ts` and
  `infrastructure/supabase/context.ts`
- Tests: `scripts/eval-purchasing.mjs` ("integration seams"),
  `scripts/eval-purchasing-domain.mjs` (ranking and import rules)

---

## 1. The rule the whole design rests on

**PCC stays excellent at purchasing.** It does not become an accounting system,
a mail client or a time clock. Where another system owns a fact, purchasing asks
for it through an interface written in purchasing's own vocabulary.

Concretely, five rules bind every provider:

| # | Rule | Why |
|---|------|-----|
| 1 | A provider supplies **facts**, never decisions | Approval, ordering and authorization stay in `authorize()` and the use cases. An integration cannot approve anything. |
| 2 | The **canonical identifier survives** — every record carries `sourceId` | When a user picks "24-118 — Harrison Gym", what is stored is the id the source will still recognise next year, not the label. |
| 3 | **No credentials above infrastructure** | An adapter may hold a token; nothing that imports the interface can see one. Browser paths go through a server action, never a client fetch with a secret. |
| 4 | **Unavailable is a state, not an exception** — `available` + `unavailableReason` | A screen says "QuickBooks is not connected". It never renders an empty list, which would read as "this company has no jobs". |
| 5 | **A missing integration is null, not a stub** | `timeTracking` is `null` today. An adapter returning `0 hours` is indistinguishable from a job nobody worked, and that lie would be believed. |

---

## 2. The seams

| Seam | Interface | Bound to today | Intended source |
|------|-----------|----------------|-----------------|
| Jobs | `JobDirectoryProvider` | `purchase_jobs` (this org's directory) | QuickBooks |
| Materials | `MaterialCatalogProvider` | the catalogue built from purchase history | the maintained material list (CSV/XLSX import) |
| Vendors | `VendorDirectoryProvider` | `vendors` + primary contacts | QuickBooks, possibly |
| Vendor email | `EmailDraftProvider` | display + `mailto:` | Microsoft 365 (Graph draft) |
| Labour hours | `TimeTrackingProvider` | **null — not connected** | Exact Time |

All five hang off `ctx.integrations`. A use case reaches for
`ctx.integrations.jobs`; it can never reach for QuickBooks.

---

## 3. Outlook / Microsoft 365 — the vendor email

### The flow, end to end

```
PO Detail
  → Create vendor email          (email.draft permission)
  → draft composed from the PO   (domain/email.mjs — body, subject, line table)
  → HUMAN REVIEWS IT             (require_email_review = true, enforced in SQL)
  → handoff to the mail client   (EmailDraftProvider.prepare)
  → the PERSON presses send      (in Outlook, with their own signature)
  → mark ordered                 (order.mark_ordered — a separate, deliberate act)
```

### What must never happen, and how it is prevented

| Risk | Control |
|------|---------|
| The system sends mail | `send()` is **absent from the interface**, not unimplemented. There is no method to call. |
| A draft is reported as sent | `EmailDraftHandoffResult.sent` is typed `false`. No code can branch on it being true. |
| Mail escapes in v1 | `purchasing_settings_no_external_send` — a **CHECK constraint**, not a setting. The migration lint refuses any `pg_net`, `http_post` or `smtp` reference. |
| A vendor is emailed about an unapproved order | `purchase_email_vendor_needs_po` — no vendor email exists without a purchase order, which needs an approval. |
| An email addressed to nobody | `prepare()` refuses an empty recipient list (`reason: 'no_recipient'`) rather than producing a draft. |

### The four handoffs

`EmailHandoff` is ordered by how much the user's own mail client is involved.

1. **`display`** — the draft is shown in the PCC, copied by hand. Always
   available. Implemented.
2. **`mailto`** — opens the local client pre-filled. Implemented, with a guard:
   `MAILTO_SAFE_LENGTH` (1800 chars). Clients silently truncate long `mailto:`
   URLs, so a long draft falls back to `display` rather than opening a mangled
   message. Attachments cannot ride on a `mailto:` at all, so a draft carrying
   the PO also falls back.
3. **`eml`** — *not built.* A generated `.eml` (RFC 5322 / MIME multipart) the
   user downloads and opens in Outlook. Carries the PO PDF and the full body.
   **Needs no account connection at all**, which makes it the cheapest real
   improvement and the recommended next step. Attaches at `prepare()`, returning
   `{ handoff: 'eml', url: '/api/email-drafts/<id>.eml' }`.
   Caveat to state to the user: Outlook applies a signature to a message *it*
   composes, and does not reliably apply one to an opened `.eml`. Do not promise
   an automatic signature on this path.
4. **`graph`** — *not built.* `POST /me/messages` creates a real draft in the
   user's own Microsoft 365 mailbox; it appears in their Drafts folder, their
   signature is applied by Outlook, and they send it. This is the destination
   the handoff describes.

### What the Graph adapter will need

- **Auth**: OAuth 2.0 authorization code flow, *delegated* — scope
  `Mail.ReadWrite` (create a draft). **Not** `Mail.Send`, and not application
  permissions: the draft must be created *as the user*, in their mailbox, or the
  signature and the audit trail both belong to the wrong identity.
- **Token storage**: refresh token per user, server-side, encrypted at rest.
  Never in a cookie readable by the browser, never in `NEXT_PUBLIC_*`.
- **Placement**: `infrastructure/providers/microsoft365.ts`, implementing
  `EmailDraftProvider`. `handoffs` becomes `['graph', 'eml', 'mailto', 'display']`.
- **Degradation**: when the user has not connected their mailbox, `available`
  stays true but `handoffs` drops `graph`. The screen offers what works.
- **Still no send.** Adding one is a visible change to the interface, reviewed
  on its own merits, with the human-review gate re-examined at the same time.

---

## 4. QuickBooks — the job directory

### What is wanted

Type part of a job number or name, get matching jobs, pick one, and have the
**canonical identity** stored rather than the text that was typed.

### How it is shaped

`JobDirectoryProvider` has three methods, and the split matters:

- `search(orgId, query, limit)` — the type-ahead. Ranked: exact job number,
  then number prefix, then name prefix, then contains. Ranking lives in
  `rankJobMatches()` so a QuickBooks adapter cannot quietly reorder it.
- `byNumber(orgId, jobNumber)` — **exact, case-insensitive, no fuzzy fallback.**
  This is the call a server action makes to re-verify what the browser
  submitted. A near-match here would let a typo become a real purchase order.
- `list(orgId)` — the whole active directory, for pickers small enough not to
  need a search.

`JobRecord` deliberately separates `sourceId` (what QuickBooks knows it by) from
`jobNumber` (what people type). Today they are the local row id and the job
number; after integration the first becomes the QuickBooks id and **nothing
above the provider changes**.

### Before building it — one decision to confirm

**QuickBooks Online or QuickBooks Desktop?** They are different integrations,
not different endpoints:

| | Online | Desktop |
|---|---|---|
| Access | REST API, OAuth 2.0 | Web Connector (SOAP/qbXML) or a third-party bridge |
| Runs | anywhere | against the machine hosting the company file |
| Jobs modelled as | sub-customers of a customer | sub-customers of a customer |
| Sync | on demand | scheduled, pull-based |

Ask before writing an adapter. The seam is the same; the transport, the auth and
the sync story are not.

### Sync, when it exists

Cache the directory locally and refresh on a schedule — do **not** call
QuickBooks on every keystroke. A type-ahead that depends on a third-party API
being up is a type-ahead that stops working during a purchase. The cache is the
provider's implementation detail; the interface does not change.

---

## 5. Materials — the authoritative list

### The position taken

**Do not invent a catalogue.** Two things already exist and are kept separate:

1. **The history-derived catalogue** (live today). Every request line stores the
   normalized form of what was typed, so the organization's real vocabulary —
   with aliases, frequency and last price — accumulates without anyone
   maintaining it. This is what autocomplete reads now.
2. **The maintained list** (to be imported). The authoritative spreadsheet, with
   canonical descriptions, part numbers and categories.

The import merges the second into the first. It does not replace it: history is
evidence of what this company actually buys, and a spreadsheet is a statement of
what it intends to.

### The import pipeline

```
CSV / XLSX
  → parse to a table          (parseDelimited() for CSV; an XLSX reader for sheets)
  → mapColumns()              header aliases → canonical fields
  → normalizeMaterialImport() per-row normalization + problem report
  → review screen             the user sees problems BEFORE anything is written
  → merge into the catalogue  by normalized description (catalog.mjs)
```

`domain/material-import.mjs` is **pure** — no file system, no XLSX library, no
database. Format handling stays outside it, which is why the rules that matter
are testable without a fixture file and identical whether the list arrives as
CSV, as a sheet, or one day through an API.

**What it refuses to do:** guess. A row it cannot understand is *reported*, not
skipped silently. An import that quietly drops 40 of 900 lines is worse than one
that fails, because nobody finds out until a material is missing mid-order.

Handled, with tests:

- Header aliases — `Mfr. Part #`, `UOM`, `Preferred Vendor`, ~60 spellings
- Unit normalization — `Each`/`ea`/`pcs` → `EA`, `ft.`/`LF` → `FT`
- Money — `$1,250.50` → cents; `call for pricing` → **null, not zero**
- Aliases split on `;`, `|`, newline, and commas outside parentheses
- Quoted CSV fields, so `"Cable, 12/2, 250ft"` does not shift every column after it
- Duplicates detected on the normalized description, reported with **both**
  spreadsheet row numbers
- Unmapped columns reported — a column nobody mapped is how an import silently
  loses data
- Inactive rows imported *as inactive* rather than dropped

Still to build: the XLSX reader (a library, at the edge), the review screen, and
the merge write. The rules they will use are done.

### Autocomplete order

The handoff specifies: **exact → alias → frequent → recent.** Implemented in
`rankMaterialMatches()` (`domain/catalog.mjs`), not in any adapter's SQL, so
every provider and every future integration produces the same list. A part
number is treated as an identifier, not prose: typing `QO120` lands on that
part, not on the popular item whose description contains it.

---

## 6. Exact Time — labour hours

Declared as `TimeTrackingProvider`, bound to `null`.

The seam exists so that "what did this job cost" is one day assembled *through
an interface* rather than through a join somebody writes into a purchasing
query. Purchasing does not need labour hours to buy material, and building an
adapter before the question is asked would be inventing a requirement.

`labourForJob(orgId, jobNumber, from, to)` is the whole surface. A screen that
wants it must handle `null` and say the system is not connected.

---

## 7. Open product decisions (do not change casually)

Carried forward from the handoff, and still true:

1. **Priority is derived from need-by**, not stored. `priority` is in
   `REQUESTOR_FORBIDDEN_FIELDS`. A self-declared priority flag drifts; a date
   does not.
2. **Preferred vendor is stored as attributed notes**, not by writing
   `vendor_id`. The history-derived catalogue therefore reports the vendor an
   item was *last actually bought from* — evidence — and does not promote it to
   "preferred". The import carries `preferredVendorName` from the spreadsheet
   separately, and resolving that name to a vendor id is the import use case's
   job, so it can report "no vendor called that" rather than inventing one.

---

## 8. Adding an adapter — the checklist

1. Write it in `infrastructure/providers/<system>.ts`, implementing the existing
   interface. Do not widen the interface to fit the vendor's API shape; that is
   what the adapter is for.
2. Map the external record to purchasing's type, filling `sourceId` with the
   external identifier.
3. Handle unreachable by returning `available: false` with a reason — never by
   returning an empty list.
4. Keep ranking and normalization in the domain. If the external API ranks
   differently, ignore its ranking.
5. Bind it in `composition.ts` (and the Supabase context). That line is the only
   change outside the adapter file.
6. Add the credentials to server-side configuration only. Nothing
   `NEXT_PUBLIC_*`.
7. Extend the "integration seams" section of `scripts/eval-purchasing.mjs` so
   the contract is asserted against the new adapter too.
