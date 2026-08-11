# PCC Production Readiness — Milestone 2

Gate document. Written before implementation, as required. Every item is either
**DONE** (already true in the repository, verified by inspection), **GAP** (missing,
in scope), or **DEFERRED** (out of scope for this milestone, with the reason).

Baseline: commit `9e9f60a`. Authorization and administration foundation complete —
23-capability crosswalk, 7 role presets, 338 authorization checks.

## On "pilot feedback"

**There is no pilot feedback document in this repository.** `docs/PURCHASING_PRODUCTION_GAPS.md`
§1 records that a pilot with real Lippolis users has *never been performed*. The
items treated as pilot feedback in this milestone are the ones named directly in
the milestone brief — the LE logo, multiple job sites per user, and the workshop
as a first-class location — plus the open items already recorded in
`PCC_UI_PROGRESS.md` and the gap register. If verbal feedback exists that is not
written down anywhere, it is not in this checklist and cannot be.

---

## 1. Dashboard

| # | Item | State |
|---|---|---|
| 1.1 | Four KPI cards (pending approval, waiting to order, ordered, awaiting receipt) | **DONE** — `app/dashboard/page.tsx`, from `summarize()` |
| 1.2 | Exceptions block with explicit all-clear | **DONE** |
| 1.3 | Queue preview, soonest need-by first | **DONE** |
| 1.4 | Purchasing / receiving status panels | **DONE** — `purchasingStatus()`, `receivingStatus()` |
| 1.5 | Vendor activity, recent POs | **DONE** — `vendorActivity()`, `recentPurchaseOrders()` |
| 1.6 | Recent activity widget | **DONE** — `recentPurchasingActivity()` + `ActivityFeed` |
| 1.7 | URL-driven filters | **DONE** — `DashboardFilters` |
| 1.8 | **Spend trend over time** | **DONE** — `spendTrend()`, six months, gaps drawn as gaps |
| 1.9 | **Volume trend over time** | **DONE** — `volumeTrend()` |
| 1.10 | **Cycle-time analytics** | **DONE** — `cycleTimes()`, medians with sample sizes |
| 1.11 | **On-time delivery rate** | **DONE** — `onTimeDelivery()`, null when unmeasurable |
| 1.12 | **Chart primitives** | **DONE** — `BarSeries`, `MetricStat`, no dependency |

**Constraint carried forward, non-negotiable.** The dashboard's own header states that
no figure on it is invented. Trends must be computed from `purchase_history_lines`
(immutable, ordered lines only) and live requests — never sampled, never
extrapolated, never zero-filled in a way that reads as data. A month with no
purchases renders as a gap, not a zero. The header comment must be updated to say
what is now shown and on what basis, rather than left contradicting the screen.

**Design note (Ousterhout).** Analytics belong in `domain/dashboard.mjs` beside
`summarize()` — pure, both providers, tested offline. A chart component is a
*presentation* primitive that takes computed series; it must not fetch, aggregate
or decide. No charting dependency: the PDF writer precedent applies (offline
workshop PC, deterministic output).

## 2. Navigation

| # | Item | State |
|---|---|---|
| 2.1 | Single brand component, one image path | **DONE** — `BrandMark`, with SVG→PNG fallback |
| 2.2 | Role-aware sidebar grouping (WORK / DIRECTORY / RECORDS / CONFIGURE) | **DONE** — `ShellChrome` |
| 2.3 | Every route has a `ROUTE_GUARDS` entry, unlisted fails closed | **DONE** |
| 2.4 | **LE logo returns to Dashboard** | **DONE** — `homeFor()` |
| 2.5 | Dashboard as home | **DONE via `homeFor()`.** `WORKSPACES` order deliberately unchanged — it decides sign-in landing, which the web suite pins per role and which is a separate question from where "back to the start" goes. |
| 2.6 | **Logo destination is permission-aware** | **DONE** — asserted per preset, including that each home passes its own route guard |
| 2.7 | Active-route highlighting consistent across shell | **VERIFIED** — one `activeFor()` in `ShellChrome` |
| 2.8 | Skip-to-content link | **GAP, REMAINING** — not present in the shell |

## 3. Job Site Access

| # | Item | State |
|---|---|---|
| 3.1 | Multiple job sites per user — data model | **DONE** — `purchasing_job_assignments` is a join table; `assignJob`/`unassignJob` are per-row |
| 3.2 | Multiple locations per user — admin UI | **DONE** — relabelled "Receiving locations", workshop offered first, existence validated |
| 3.3 | Scope enforced server-side, never from the browser | **DONE** — `assignedJobNumbers` resolved in `session.ts` |
| 3.4 | Scope enforced at the database | **DONE** — `purchasing_may_receive()` (migration 0029) |
| 3.5 | **Workshop as a first-class location** | **DONE in the application; migration 0034 written, NOT APPLIED** |
| 3.6 | **Permission-aware filtering includes the workshop** | **DONE** — both indexes call `mayReceiveAt()`; scope copy via `describeLocations()` |
| 3.7 | Admin assignment UI shows the workshop | **DONE** |

### 3.5 — what the gap actually is

`purchase_location_kind` already has `WORKSHOP` (migration 0016), so an order's
*destination* is already known. What is missing is on the **authority** side:
receiving scope is inferred from a user's **role** (`SHOP_COUNTER_ROLES` — office,
accounting, workshop approver, admin are unscoped; everyone else is job-scoped).

The consequence: a foreman who also works the shop counter cannot be given shop
receiving authority without handing them an office or workshop role — which
carries far more than receiving. Authority is inferred where it should be
*declared*.

**Design (Ousterhout: deepen the existing module, do not add a parallel one).**
Assignment already exists and already supports many rows per user. Extend it
rather than inventing a second scoping system:

- `WORKSHOP_LOCATION = 'WORKSHOP'` — one reserved location key, in `roles.mjs`,
  beside the scope rule it modifies.
- `receivingScopeFor(user)` → `{unscoped, locations[]}`. One function answering
  what three call sites currently answer separately.
- `mayReceiveAt(user, {jobNumber, locationKind})` → boolean. The single predicate
  `authorize()`, the receiving index and the deliveries index all call. Today
  that logic is inlined in `authorize()` and re-derived in two page components —
  exactly the three-copy problem `SHOP_COUNTER_ROLES` was extracted to fix, one
  level up.

**Invariants that must survive:** shop-counter roles stay unscoped (no
regression); a field user gains authority **only** by explicit assignment (never
by inference); the reserved key can never collide with a real job number
(asserted); the database keeps the final word.

**Database.** `purchasing_may_receive()` must learn the same rule or the app will
offer an action Postgres refuses. That is a new migration (`0034`). **It will be
written but not applied** — `AGENTS.md`: never apply live migrations without
explicit approval. Until it is applied, workshop assignment is inert on the
Supabase provider, and this document and the handoff must say so plainly rather
than the feature appearing complete.

## 4. Workshop Ordering

| # | Item | State |
|---|---|---|
| 4.1 | Queue with lifecycle tabs, URL-driven filters, next-action column | **DONE** — `PurchasingQueue` |
| 4.2 | Review → decide → PO → vendor email → mark ordered | **DONE** |
| 4.3 | Vendor and cost required to order; override records a reason | **DONE** |
| 4.4 | PO number permanent, forward-only sequence | **DONE** |
| 4.5 | Ordering respects the capability model (no identity test) | **DONE** — BR-011, 338 checks |
| 4.6 | Statuses `VENDOR_CONFIRMED`, `SHIPPED`, `ARCHIVED` | **DEFERRED** — three new statuses in a closed 14-state graph is a domain change with migration, transition-guard and test consequences. Not a polish item. Gap register Phase 8. |
| 4.7 | Delivery destination declared per order | **DEFERRED** — depends on 3.5 landing first; the column exists, the workflow does not set it |

## 5. UX Polish

| # | Item | State |
|---|---|---|
| 5.1 | Loading states | **DONE** — `Skeleton`, `CardSkeleton`, `TableSkeleton` |
| 5.2 | Empty states | **DONE** — `EmptyState`, `TableEmpty` |
| 5.3 | Error handling | **DONE** — `Alert`, `InlineError`, `app/error.tsx`, `not-found.tsx` |
| 5.4 | Success feedback | **DONE (by design, no toast)** — mutations are server actions that re-render; state lives in persistent `Alert`s. Recorded in `PCC_UI_PROGRESS.md`. |
| 5.5 | Destructive-action confirmation | **DONE** — `ConfirmSubmit`, `UnsavedChangesGuard` |
| 5.6 | Responsive layouts | **DONE** — verified at 375px by the web suite |
| 5.7 | Charts legible without colour alone | **DONE** — every bar carries its value as text |
| 5.8 | Charts responsive and screen-reader reachable | **DONE** — flex layout; a real `<table>` carries the same numbers |

## 6. Validation

| # | Item | State |
|---|---|---|
| 6.1 | Request intake validation | **DONE** — `validation.mjs` |
| 6.2 | Requestor field firewall | **DONE** — `REQUESTOR_FORBIDDEN_FIELDS` |
| 6.3 | Quantity/money arithmetic exact, no float | **DONE** |
| 6.4 | Over-receipt guard | **DONE** |
| 6.5 | Closed transition graph, 14 × 14 | **DONE** |
| 6.6 | **Assignment validates the job exists** | **DONE** — refused on the way in; unassigning still always works, so an old bad row is not permanent |
| 6.7 | **Reserved key cannot be a job number** | **DONE** — `createJob` refuses it; CHECK constraint in 0034 |

## 7. Production Readiness

| # | Item | State |
|---|---|---|
| 7.1 | Typecheck, unit, providers, isolation, integration, web suites | **DONE** — green at baseline |
| 7.2 | Production build | **DONE** |
| 7.3 | Live RLS suite + negative control | **DONE locally**, not on a hosted project |
| 7.4 | Tenant isolation, static and live | **DONE** |
| 7.5 | Immutable history, four fences | **DONE** |
| 7.6 | **`npm run lint` cannot run** | **BLOCKER, PRE-EXISTING** — `eslint-config-next` requires `next/dist/compiled/babel/eslint-parser`, absent from the installed Next 16 tree. Repo-wide, affects `apps/web` identically. The milestone asks for lint; it cannot pass until the dependency is fixed, which is a dependency change, not a polish change. |
| 7.7 | Supabase Storage for attachments | **DEFERRED** — attachments are inline in the pilot database. Gap register. |
| 7.8 | Sign-in rate limiting | **DEFERRED, SECURITY-RELEVANT** — a password can be guessed as fast as the server answers. Named here because a pilot with real credentials makes it real. |
| 7.9 | Password reset redemption screen | **DEFERRED** — admin hands over a temporary password today |
| 7.10 | Tenant-aware sign-in branding | **DEFERRED** — cosmetic for one customer, wrong for two |
| 7.11 | Hosted deployment | **DEFERRED** — no host, domain, TLS or credentials exist |
| 7.12 | Documentation updated | Required at the end of this milestone |

---

## Implementation order

Dependencies first, so nothing is built twice:

1. **Job site access domain** (3.5, 3.6, 6.7) — `roles.mjs` predicate + tests. Everything
   else in §3 depends on it, and it is the only change touching authorization.
2. **Migration 0034** for `purchasing_may_receive()` — written, not applied.
3. **Admin assignment UI** (3.2, 3.7, 6.6) — multi-site, workshop, validated.
4. **Permission-aware filtering** (3.6) — receiving and deliveries indexes.
5. **Navigation** (2.4–2.6) — `homeFor(user)` in `workspaces.mjs`, one function, used
   by `BrandMark`'s link and the root redirect alike.
6. **Dashboard analytics domain** (1.8–1.11) — pure functions in `dashboard.mjs`.
7. **Chart primitive** (1.12, 5.7, 5.8) — inline SVG, accessible, no dependency.
8. **Dashboard screen** — wire the series in; correct the header comment.
9. **Verification** — full suite chain, production build.
10. **Documentation** — this file, `PCC_UI_PROGRESS.md`, gap register, handoff.

## Out of scope, stated so it is not mistaken for oversight

Legacy PO Import (all of it). New request statuses. Supabase Storage. Hosted
deployment. i18n beyond the sign-in screen. Toasts. Any redesign of the shell,
the queue or the request lifecycle.
