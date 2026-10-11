# PCC — simplification around Mike's real workflow

Post-pilot. Gate document: matrix and design comparison first, implementation after.

Mike's feedback: technically functional, too complex for how he works. He wants four
things — see incoming requests, record workshop stock, print a PO, email a vendor —
and he keeps paper. **PCC supports the paper workflow rather than replacing it.**

---

## Phase 1 — simplification matrix

### The request/review screen (`ReviewForm`) — where the complexity actually is

Nine inputs per line today. Mike needs one.

| Current element | Why it exists | Mike needs it? | Action |
|---|---|---|---|
| Usable stock in workshop | The purchasing decision aid | **Yes — this is the one thing he types** | **KEEP**, make it the primary field |
| Approved quantity needed | Lets the workshop approve less than asked | Rarely | **HIDE** — defaults to requested; reachable under "Adjust" |
| Suggested to order (read-only) | `approved − stock` | Yes, as the *answer* | **KEEP**, promote to "To order" |
| Final quantity to order | Override to restock the shop | Sometimes | **MERGE** into "To order" as an editable derived field |
| Vendor (per line) | Multi-vendor support | **No — Mike picks the vendor himself, off-system** | **MOVE TO ADVANCED** |
| Estimated unit cost | Budget estimate | No | **MOVE TO ADVANCED** |
| Estimated line total | Derived from cost | No | **HIDE** |
| Expected vendor arrival | Tracking | No | **MOVE TO ADVANCED** |
| Substitute item | Ordering something different | Occasionally | **MOVE TO ADVANCED** |
| Workshop notes (per line) | Context | Occasionally | **MOVE TO ADVANCED** |
| Override reason | Audit for an override | Only when overriding | **KEEP**, conditional |
| Section A/B/C headings | Structure | No — jargon | **REMOVE** |
| Approve / Reject / Clarify radio | The decision | Approve, yes. Others rarely. | **KEEP** approve as the primary button; others secondary |

### Workflow stages Mike currently operates by hand

| Stage | Genuinely required? | Action |
|---|---|---|
| Save review | No — never a decision on its own | **FOLD** into the single action |
| Approve | Yes (authorization + audit) | **FOLD** into "Approve & print PO" |
| Generate PO | Yes (PO number, immutable document) | **FOLD** into the same action |
| Create email draft | Yes when he emails | **KEEP** as a one-click output |
| Mark ordered | **Yes** — it is the fact "placed with the vendor", and it drives receiving and lead time | **KEEP**, one button on the same screen |
| Receiving | Yes | **KEEP** — unchanged |
| Complete | Yes | **KEEP** — unchanged |

### Dashboard

| Current | Mike needs it? | Action |
|---|---|---|
| 4 KPI cards | Partly | **KEEP**, re-pointed at *today* |
| Exceptions | Yes | **KEEP** |
| Queue preview | **Yes — this is his screen** | **PROMOTE** to the top |
| Purchasing/receiving status panels | No | **HIDE** below the fold |
| Vendor activity | No — he knows his vendors | **REMOVE** from the dashboard |
| Spend / volume / cycle-time trends (milestone 2) | Not daily | **MOVE** to `/reports` |
| Recent activity feed | Marginal | **DE-EMPHASISE** |
| — missing — | **By-day activity graph, today-weighted** | **ADD** |

Nothing above deletes a backend capability. Vendor, cost, arrival and substitute all
keep their columns, their validation and their audit; they stop being *demanded* of
Mike on the main path.

---

## Ousterhout review — two designs for Mike's request management

### Design A — "Progressive disclosure on the existing screens"

Keep the route structure (`/workshop` → `/requests/[id]/review` → `/po` → `/email`).
Collapse the nine per-line inputs into one visible field (stock) with an "Advanced"
disclosure holding the rest. Rename the sections in plain English. Add an
"Approve & print PO" button that chains save → decide → generate PO.

- User decisions per line: **1** (plus optional override)
- Clicks, request → printed PO: **~5** (open, type stock, expand nothing, approve&print, print)
- Conceptual complexity: still four routes and the status vocabulary is still visible
- Implementation complexity: **low** — one component rewrite, one composed action
- Risk to architecture: **very low** — no route, domain or authorization change

### Design B — "One screen per request"

A single `/requests/[id]` working screen. Stock check, the to-order table, print and
email all live on it; the review/po/email routes become sub-views of the same page.
The status machine is never named — the page shows one primary button whose label is
the next physical act ("Print PO", then "Mark ordered", then "Receive").

- User decisions per line: **1**
- Clicks, request → printed PO: **~3** (open, type stock, print)
- Conceptual complexity: **lowest** — one page, one button, no status vocabulary
- Implementation complexity: **medium-high** — merges four routes; `/po` and `/email`
  are linked from elsewhere and pinned by the web and E2E suites
- Risk to architecture: **medium** — route changes touch `ROUTE_GUARDS`, and the E2E
  suite navigates the existing paths. Breaking the pilot-critical 43/43 on the first
  post-pilot milestone is a bad trade.

### Chosen: **A, with B's primary-action idea grafted on**

A gets almost all of B's simplicity for a fraction of the risk. The measurable gap is
two clicks; the real gap is B's "one button named after the physical act", and that
does not require merging the routes — it only requires that the review screen ends in
a single primary action and that the PO screen offers Print and Email as first-class
buttons. So: **A's structure, B's single-primary-action discipline.** Routes stay,
guards stay, the E2E suite keeps passing.

The Ousterhout point: the depth goes in `composeOrder()` — one application-level call
absorbing save → decide → PO — not in a new screen. Mike loses the ceremony; the state
machine, the authorization checks and the audit rows all still happen, one layer down.

---

## What stays untouched, deliberately

Tenant isolation, `authorize()`, the capability crosswalk, immutable
`purchase_history_lines`, the closed transition graph, the six quantities, domain
events, both providers. The surface gets simpler; the guarantees do not move.
