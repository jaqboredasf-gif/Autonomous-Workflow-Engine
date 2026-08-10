# PCC — Phase A Handoff: Purchasing Historical Memory

> **Phase A implementation status (2026-08-10): COMPLETE on
> `codex/pcc-phase-a-history`.** The immutable completion snapshot, separate
> terminal-outcome memory, derived observed-intelligence reads, provider parity,
> and line-level review context described below are implemented. No hosted
> migration has been applied. Remaining rollout risks and validation evidence
> are recorded in `docs/planning/AGENT_HANDOFF.md`.

For the next coding agent. Everything you need to start Phase A without
rediscovering the project.

**Do not re-derive the authorization model. It is finished.** BR-011 and BR-014
are complete, tested and documented. Phase A adds no authorization.

---

## CURRENT BASELINE

| | |
|---|---|
| **Repository** | `~/AWE-Purchasing` |
| **Branch** | `claude/purchasing-control-center` |
| **Clean commit** | `5c45094` — *Close the receiving gate at the layer that was actually open* |
| **Working tree** | Clean, apart from three untracked prior-session notes (`PCC_NEXT_SESSION_HANDOFF.md`, `PCC_NEXT_SESSION_PROMPT.md`, `SESSION_TRANSITION_COMMANDS.md`). Left untracked deliberately. |
| **Localhost** | `http://localhost:3100` — dev server, local SQLite persistence, hot reload |
| **Node** | 24 (strips TS types on import; the eval harnesses import app modules directly) |

### Test baseline — all green at `5c45094`

| Suite | Count | Command |
|---|---|---|
| tsc | clean | `npx tsc --noEmit -p apps/purchasing` |
| Domain | 258 | `bash scripts/eval-purchasing-domain.sh` |
| Authorization | 215 | `bash scripts/eval-purchasing-authorization.sh` |
| Integration | 222 | `bash scripts/eval-purchasing.sh` |
| Provider conformance | 268 | `bash scripts/eval-purchasing-providers.sh` |
| Tenant isolation | 136 | `bash scripts/eval-purchasing-isolation.sh` |
| Web acceptance | 89 | `bash scripts/eval-purchasing-web.sh` |
| Live Supabase E2E | 43 | `node scripts/eval-purchasing-e2e.mjs` (needs the Supabase-mode server, below) |
| Supabase web acceptance | 41 | `bash scripts/eval-purchasing-supabase-web.sh` |
| Live RLS + negative control | PASS | `bash scripts/verify-supabase-live.sh` |
| Production build | OK | `cd apps/purchasing && npx next build` |

Running the two live suites needs a server in Supabase mode. Next 16 refuses a
second `next dev` on the same directory, so build and `next start` on another
port:

```
node scripts/provision-local-tenants.mjs          # with the Supabase env set
cd apps/purchasing && npx next build && npx next start -p 3101
ACCEPTANCE_BASE_URL=http://localhost:3101 node scripts/eval-purchasing-e2e.mjs
```

Env required: `AUTH_PROVIDER=supabase`, `PURCHASING_PERSISTENCE=supabase`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`. Get the keys from
`npx supabase status`.

Migrations `0028` and `0029` are applied to the running local Postgres.

### Key documents now present

| File | What it is |
|---|---|
| `PCC_PERMISSION_MATRIX.md` | Who may do what, where enforced, which test proves it. **Read this before touching authorization.** |
| `PCC_INTEGRATION_ARCHITECTURE.md` | The five external seams (jobs, materials, vendors, email, time) and where each real integration attaches |
| `PCC_NEXT_IMPLEMENTATION_PHASE.md` | The A–H sequence. Phase A is this document. |
| `PCC_UI_HANDOFF/` | Original design packet — structure and screens |

### The unified capability model

```
APPROVE_PURCHASE  (roles.APPROVE_PURCHASE → 'purchase.request.approve' → review.decide)
RECORD_RECEIPT    (roles.RECORD_RECEIPT   → 'receiving.confirm'        → receiving.record)
                   + job/workshop scope, for receiving only
```

Independent in both directions. A foreman receives without approving; an office
approver approves without the workshop role. Scope comes from
`SHOP_COUNTER_ROLES` / `isFieldOnly()` in `domain/roles.mjs` — one definition,
used by `authorize()`, the receiving index and the deliveries index.

---

## IMPORTANT EXISTING RULES

Do not change any of these in Phase A.

1. **APPROVE_PURCHASE controls approval.** A holder may approve any request in
   their organization, **including their own**. Who raised it is *recorded*
   (`purchase_approvals.self_approved`), never consulted.
2. **RECORD_RECEIPT controls receiving**, within job/workshop scope. Who
   requested or approved the order is irrelevant to signing for it.
3. **Requester/approver identity never subtracts authority a user independently
   possesses.** Ownership may `AUDIT` (record a fact), `GRANT` (the permission
   is *defined* by ownership, e.g. `request.update.own`), or `WIDEN` (buy a
   cheaper permission — see `cancelPurchaseRequest`). It may never deny.
   **Enforced by a test:** every identity comparison in the domain and
   application layers must carry an `OWNERSHIP-OK: AUDIT|GRANTS|WIDENS` comment
   at the site, or `eval-purchasing-authorization.sh` fails.
4. **Receipt line immutability is intentional.** `purchase_receipt_items` has an
   INSERT policy only — no UPDATE, no DELETE, plus a no-delete trigger
   (migration `0029`). A miscounted receipt is corrected by recording **another
   receipt**. If Phase A wants to amend a line in place, it cannot, and that is
   the design.
5. **BR-011 and BR-014 are complete.** Three guards keep them true, each
   verified with a negative control: the migration parity lint, the
   effective-policy scan in the isolation suite, and the ownership annotation
   guard.
6. **Never fabricate analytics.** Count, sum, sort. No trend from one
   observation. An empty panel beats a confident wrong number.

---

## PHASE A GOAL

Build a durable purchasing historical-memory system, so completed purchasing
activity becomes reusable institutional knowledge.

---

## WHAT ALREADY EXISTS — read this before designing

Phase A is **not** starting from nothing, and it is **not** finished either.

### `purchase_line_history` (view, migration 0018; `security_invoker = on`, 0019)

One row per ordered line. Already provides:

`org_id`, `order_item_id`, `catalog_item_id`, `normalized_description`,
`ordered_description`, `requested_description`, `order_qty`, `unit`,
`estimated_unit_cost`, `actual_unit_cost`, `vendor_id`, `job_number`,
`po_number`, `request_id`, `ordered_at`, `requestor_id`, `received_qty`

### The gap that decides Phase A's architecture

**It is a VIEW over live entities, so it is a projection, not a snapshot.** It
resolves `vendor_id` at read time. Rename a vendor and every historical row
silently changes what it says. That directly violates the acceptance criterion
*"snapshot fields survive later entity renames"*, and it is why Phase A needs an
**immutable observed-history table written at completion**, not another view.

Missing from the view relative to the required raw-history list below:

| Missing | Note |
|---|---|
| request **number** | view has `request_id` only |
| purchase order **id** | view has `po_number` only |
| job **id** | view has `job_number` text only |
| **vendor name snapshot** | resolved live — this is the rename bug |
| **vendor part number** | not stored anywhere yet; arrives with Phase B's import |
| **approver** | `purchase_requests.approver_id` is not selected |
| **received / completed timestamps** | not present |
| **receipt outcome** | only `received_qty`; damaged / backordered / written-off are dropped |
| **cancelled / rejected state** | the view INNER JOINs purchase_orders, so anything that never became an order is invisible |

Also verify before trusting it: `ordered_at` is `purchase_orders.generated_at`
(PO generated), **not** `purchase_requests.ordered_at` (actually placed with the
vendor). Those differ, and lead-time maths in Phase C depends on which you mean.

### Other existing substrate

- `domain/catalog.mjs` — `normalizeDescription()`, `NORMALIZER_VERSION`,
  `catalogKeyFor()`, `matchCatalog()`, `rankMaterialMatches()` (exact → alias →
  frequent → recent), `HISTORY_FIELDS` (the contract for what history preserves)
- `purchase_item_catalog` (0018) — canonical material data per org, keyed
  `(org_id, normalized_description)`, with `default_vendor_id`,
  `canonical_description`, `catalog_number`, `first_seen_at`, `last_seen_at`
- `ItemCatalogRepository` — `list`, `suggest`, `findByNormalized`, `forVendor`
- `MaterialCatalogProvider` (`application/integrations.ts`) — the seam Phase B
  will bind an import to
- `domain/material-import.mjs` — already written and tested; Phase B, not A

**Do not re-cluster old rows under new normalization rules.**
`NORMALIZER_VERSION` exists so history keeps the key it was matched under.

---

## RAW HISTORY MUST PRESERVE

Written once, at completion. Snapshots are literal values, not foreign keys.

- request ID **and** request number
- PO ID **and** PO number
- job ID **and** job number
- material canonical ID where available
- **ordered material description snapshot**
- quantity
- unit
- vendor ID
- **vendor name snapshot**
- vendor part number
- estimated price
- actual / final price where available
- requester
- approver
- ordered timestamp
- received timestamp
- completed timestamp
- receipt outcome (received / damaged / backordered / written-off)
- cancelled / rejected state where relevant

The ID **and** the snapshot, together: the ID keeps the row joinable to current
data, the snapshot keeps the row true about what was bought at the time.

---

## BR-012 — history is immutable evidence

> Completed purchasing activity becomes immutable historical evidence and may be
> used to derive future purchasing suggestions, but derived recommendations must
> never rewrite the underlying historical record.

Implications:
- Append-only. No UPDATE path on history rows. Follow the pattern already
  enforced on `purchase_receipt_items` (0029): INSERT policy only, no-delete
  trigger.
- Derived read models are **separate tables or views**, recomputable from
  history, and never written back into it.
- Recomputing intelligence must be safe to run repeatedly and must not touch a
  single history row.

## BR-013 — observed is not configured

> Historical purchasing evidence may improve autocomplete, ranking, pricing
> context, and vendor recommendations, but observed history must remain distinct
> from configured preference.

**Do not conflate `historically used vendor` with `configured preferred
vendor`.** They are different claims with different authority:

| Observed | Configured |
|---|---|
| "last bought from Graybar on 2026-08-07 at $89.50" | "our preferred vendor for this item is Graybar" |
| derived from history, cannot be wrong | set by a human, can be wrong, can be overridden |
| lives in the derived read model | lives in `purchase_item_catalog.default_vendor_id` / attributed notes |

The existing code already respects this — `providers/builtin.ts` maps the
history-derived catalogue's last vendor and deliberately leaves
`preferredVendorId: null`, with a comment saying why. Keep that separation, and
label it in the UI: *"last ordered from"* is not *"preferred vendor"*.

---

## DERIVED INTELLIGENCE

Recomputable from history. Never authoritative over it.

**Material**
- last vendor · last purchase date · last price
- recent average price · common quantity · purchase frequency

**Vendor–material**
- order count · last used · last price
- recent average price · observed lead time where measurable

**Vendor**
- order count · recent activity · common materials
- observed lead time where measurable

*"Where measurable"* is load-bearing. Lead time needs both an ordered timestamp
and a received timestamp on the same line; report nothing when either is
missing. Same for averages — state the sample size, and do not draw a trend from
one observation.

---

## UI TARGET

A purchaser reviewing or entering a material sees, **without leaving the
screen**:

- last ordered from
- last price
- last ordered date
- purchase frequency

Natural homes: the workshop review screen (`/requests/[id]/review`) at line
level, and `MaterialSearch` on the new-request form. A price with no date beside
it is a rumour — always show the date.

---

## ARCHITECTURE

Three layers. Keep them separate.

```
1. IMMUTABLE OBSERVED TRANSACTION HISTORY
   append-only, snapshot-carrying, written at completion
   the record of what happened

2. CANONICAL MATERIAL / VENDOR DATA
   purchase_item_catalog, purchase_vendors, purchase_jobs
   the current names for things — mutable, curated

3. DERIVED READ MODELS / INTELLIGENCE
   recomputable from (1), joined to (2) for display only
   never written back into (1)
```

Follow the existing shape of the codebase:
- Rules that both providers must agree on go in `domain/` as pure `.mjs`, with
  the harness importing them directly.
- Repository interfaces in `domain/repositories.ts`, implementations in
  `infrastructure/sqlite/` and `infrastructure/supabase/`.
- Anything an external system will supply later goes behind a provider in
  `application/integrations.ts`.
- Every new table: `org_id`, RLS enabled, policies scoped with
  `current_org_id()`, and the isolation suite will check the **effective** policy
  set across all migrations.

---

## TESTS / ACCEPTANCE

Phase A is done when all of these pass:

1. **History is created from real completed orders** — drive the full workflow
   in `scripts/eval-purchasing.mjs` and assert the history rows that result.
2. **Snapshot fields survive later entity renames** — the decisive test. Record
   history, rename the vendor and the material, re-read: the historical row
   still says what was bought and from whom **at the time**. This is the test
   the current view would fail.
3. **Derived metrics never mutate history** — recompute intelligence twice and
   assert every history row is byte-identical, including timestamps.
4. **No cross-tenant leakage** — two orgs with identical materials and vendor
   names; neither sees the other's history or intelligence. Add the new tables
   to the isolation suite's tenant-owned scan.
5. **Autocomplete and intelligence read only tenant-scoped history** — assert
   the query path is org-scoped, not filtered after the fact.
6. **Cancellation / rejection behaviour is explicitly defined** — decide and
   *write down* whether a cancelled or rejected request contributes to
   frequency, pricing and vendor stats. Recommendation: record the row with its
   terminal state, exclude it from pricing and lead-time, and say so in the
   comment. Silence here is how a rejected request quietly inflates a
   frequency count.
7. **Existing suites stay green** — all of the baseline above, unchanged.

Also keep in mind:
- Both providers must agree. The provider-conformance suite (268 checks) exists
  to catch a rule implemented in SQL for one and JavaScript for the other.
- If you add a guard, give it a **negative control**: introduce the defect,
  confirm the guard fails, revert. Three existing guards were verified that way
  and it is the standard here.

---

## NEXT AFTER PHASE A

B. material catalog import
C. vendor-material intelligence
D. Outlook one-click draft handoff
E. QuickBooks canonical job autocomplete
F. receiving / evidence hardening
G. notifications
H. production pilot readiness

Detail for each is in `PCC_NEXT_IMPLEMENTATION_PHASE.md`.

---

## FIRST THREE ACTIONS

1. Read `PCC_PERMISSION_MATRIX.md`, then
   `supabase/migrations/0018_purchasing_history_and_jobs.sql` (the
   `purchase_line_history` view) and `domain/catalog.mjs`.
2. Confirm the baseline: `bash scripts/eval-purchasing.sh` and
   `bash scripts/eval-purchasing-authorization.sh` both green at `5c45094`.
3. Design the immutable history table and its write point — at request
   completion, carrying snapshots — before writing any read model. Decide the
   cancellation/rejection rule at the same time, and write it in the migration
   comment where the next reader will find it.
