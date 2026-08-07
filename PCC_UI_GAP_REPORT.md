# PCC UI Gap Report — Checkpoint 0

Inspection of `apps/purchasing` against `PCC_UI_HANDOFF/`. Implementation control document, not prose.

## Stack

| Fact | Value |
| --- | --- |
| Framework | Next.js 16.2.10, App Router, React 19.2, Turbopack |
| Package manager | npm workspaces (root `package.json`, workspace `purchasing`) |
| Dev command | `npm run dev -w purchasing` (currently running on **:3100**) |
| Styling | Tailwind CSS v4 (`@import "tailwindcss"` + `@theme inline`), no component framework |
| Fonts | Geist / Geist Mono via `next/font/google` |
| Auth | signed httpOnly session cookie + `AUTH_PROVIDER` local\|supabase; `middleware.ts` (signature/expiry only) + `requireAccess()` per page |
| Persistence | `PURCHASING_PERSISTENCE` local (node:sqlite) \| supabase (RLS, caller's token) |
| Tests | `test:unit`, `test:integration`, `test:web` (production build + real HTTP), `test:providers`, `test:isolation`, `typecheck`, `lint` |

## EXISTING (working — preserve)

**Domain (pure `.mjs`, all covered by evals)**
- `status.mjs` — 14 statuses, closed transition graph, `transitionGuard`, `statusLabel`, `statusTone`.
- `roles.mjs` — 6 roles, 35 permissions, `authorize()`, `availableActions()`, capabilities, role presets, assignment-scoped receiving.
- `workspaces.mjs` — `WORKSPACES`, `ROUTE_GUARDS` (fail closed), `routeDecision()`, `PUBLIC_ROUTES`.
- `dashboard.mjs` — `summarize()`, `applyFilters()`, `lifecycleBoard()`, `LIFECYCLE_STAGES`, `isOverdue()`, `toTableRow()`.
- `catalog.mjs` — `normalizeDescription()`, `catalogKeyFor()`, `NORMALIZER_VERSION`.
- `numbers.mjs`, `email.mjs`, `activity.mjs`, `events.mjs`, `validation.mjs`, `po-number.mjs`.

**Application / infrastructure**
- Use cases: requests, review, decisions, fulfilment, administration, queries (read-side is authorized too).
- Two repository providers (sqlite + supabase) behind one port set; migrations 0016–0022 with RLS, guard triggers, `record_purchase_decision()` / `record_receipt()` RPCs.
- `getRequestDetail()` already returns `actions` computed from `availableActions()` — the UI never has to invent authority.

**Routes**
`/` (router), `/sign-in`, `/forgot-password`, `/session-expired`, `/unauthorized`, `/workshop`, `/office`, `/accounting`, `/admin`, `/my-requests`, `/deliveries`, `/notifications`, `/requests`, `/requests/new`, `/requests/[id]`, `/requests/[id]/review|po|email|receive`, `/purchase-orders/[id]`, `/email-drafts/[id]`, `/receipts/[id]`, `/api/health`, `/api/auth/*`, `/api/documents/[id]`.

**Components**
`ui.tsx` (StatusBadge, Card, Section, Field, Money, Qty, ReadOnly, Empty, `inputClass`/`buttonClass`/`secondaryButtonClass`, PilotBanner), `Nav`, `RequestTable`, `WorkshopQueue`, `NewRequestForm`, `ReviewForm`, `ReceiveForm`, `SignInForm`, `Timeline`, `AdminUsers`, `AdminDirectories`.

## PARTIAL

| Handoff requirement | State |
| --- | --- |
| 02 Design system | Slate/Geist palette, not PCC tokens. No `#2563EB` action colour, no Inter, no radius/elevation scale. |
| 03 Component library | ~8 of 22 families exist. Missing: Button (variants/sizes), Select/Textarea/Search wrappers, KPI card, DataTable primitives, Sidebar, Topbar, Breadcrumb, Tabs, Alert, ConfirmDialog, EmptyState, Skeleton, Toast, upload shell, receiving-item control, filter bar, activity item. |
| A3 Product shell | Topbar-only `Nav`, `max-w-6xl` centred content. No sidebar, no global search, no page-heading pattern, no role-aware sidebar grouping. |
| 01 Login | Works (email/password, forgot password, loading, invalid-credentials, unauthorized page). Missing: English/Español entry point, PCC visual treatment. |
| 02 Dashboard | `/workshop` has 6 count cards. Missing: the 4 named KPIs, queue preview as a distinct block, exceptions/alerts block, recent activity, quick actions. No route for non-approver management view. |
| 03 New Request | Job, need-by, items, units, notes, draft/submit all work. Missing: priority, preferred vendor, attachments control, material autocomplete against the catalog, canonical material id preservation. |
| 04 Purchasing Queue | `WorkshopQueue` covers tabs/search/job/vendor/overdue and keeps ordered work visible. Missing: requester filter, priority filter, date-range filter, clear-filters, item count, age, amount column, sticky header. |
| 05 PO Detail | `/requests/[id]` carries header context, items, timeline, receipts, documents, actions. Vendor email lives at `/requests/[id]/email` — reachable, but the handoff wants it presented on the PO surface itself. |
| 06 Receiving | `ReceiveForm` records per-line received/damaged/backordered and cannot close a PO early. Missing: mobile-first layout, remaining/previously-received presentation, exception vocabulary (missing/incorrect), evidence upload, large confirm. |
| 10 Administration | Users, roles, approval authority, job assignments, PO config, vendors, jobs, audit exist as one long page. Missing: module structure, permissions view, notifications module, org settings, destructive-action confirmations. |

## MISSING

- **07 Vendors** — no vendor list screen (only an admin directory form).
- **08 Vendor Profile** — no route, no per-vendor history/materials/lead-time aggregation.
- **09 Material Catalog** — `purchase_item_catalog` exists in **both** schemas (sqlite `database.ts:604`, migration `0018:162`) and `catalog.mjs` computes the keys, but **no repository method reads or writes it** and no line item is linked to it. Needs read methods on both providers before the screen can exist.
- **Reports** — sidebar destination in the handoff; no data model, no route.
- Toast, confirmation dialog, skeleton loading, unsaved-changes warning — no equivalents anywhere.
- No i18n catalogue. `statusMessageKey()` exists and returns keys nothing resolves.

## CONFLICTS (handoff vs. validated domain — resolution stated)

1. **Priority.** Screen 03/04 require `Normal / Urgent / Emergency`. `roles.mjs:272` lists `priority` in `REQUESTOR_FORBIDDEN_FIELDS` — "removed by design — replaced by need_by_date + need_by_time", and no column exists in either schema.
   **Resolution:** contract source-of-truth order puts validated domain behaviour first. Implement priority as **derived urgency** from need-by proximity (`Emergency` = overdue or due today, `Urgent` = within 48h, `Normal` otherwise), shown as text and filterable. No schema change, no silently altered business rule. Flagged for the product owner: making priority a stored, requester-set field is a migration + domain decision, not a UI decision.

2. **Status vocabulary.** Handoff lifecycle (`Requested → Needs Approval → … → Completed`) does not match the domain's 14 statuses (`SUBMITTED`, `PENDING_WORKSHOP_REVIEW`, `CLARIFICATION_REQUESTED`, `RESUBMITTED`, `PO_GENERATED`, …).
   **Resolution:** the domain identifiers stay authoritative; the UI renders handoff-facing labels through one mapping table beside `statusLabel()`. `SUBMITTED`/`PENDING_WORKSHOP_REVIEW` → "Needs Approval", `PO_GENERATED` → "PO Generated", etc. Nothing is renamed in the database.

3. **Backordered.** Listed as a status in the handoff; in the domain it is a per-line quantity (`backorderedQty`), not a request status.
   **Resolution:** surface as a line-level flag and a queue badge, not a request status.

4. **Sidebar destinations vs. existing routes.** `Dashboard / Requests / Purchasing / Receiving / Vendors / Materials / Reports / Administration` vs. `/workshop`, `/office`, `/my-requests`, `/deliveries`.
   **Resolution:** existing routes keep their paths (`scripts/eval-purchasing-web.mjs` pins default-workspace redirects and guard denials for all of them). The sidebar presents them under handoff names, and genuinely new destinations get new routes: `/dashboard`, `/vendors`, `/vendors/[id]`, `/materials`, `/reports`. Every new route MUST get a `ROUTE_GUARDS` entry — unlisted routes fail closed to `/unauthorized`.

5. **English/Español entry point** (screen 01) with no message catalogue.
   **Resolution:** ship the language control on the login screen backed by a small login-scoped string table and a `pcc_lang` cookie. A full catalogue is out of scope for this session and is recorded in the progress ledger.

## SAFE REUSE

- `applyFilters()` / `lifecycleBoard()` / `summarize()` / `isOverdue()` — the queue and dashboard must filter and count through these, not reimplement.
- `availableActions()` (already on `getRequestDetail().actions`) — every authority-sensitive button reads from it; buttons are courtesy, `authorize()` is the control.
- `statusLabel()` / `statusTone()` — keep as the single status vocabulary; add a label map, do not fork.
- `requireAccess()` + `purchasingRequestContext()` — the only correct way to open a new page.
- `Field`, `Section`, `StatusBadge`, `Money`, `Qty` — adapt in place rather than duplicating; every existing screen imports them.
- `normalizeDescription()` — material autocomplete and the catalog screen must match on this, not on `LIKE %text%`.
- `purchase_item_catalog` tables — already migrated in both providers; only the repository read path is missing.

## Order of work

CP1 tokens + components → CP2 shell → screens 01-06 → screens 07-10, verifying after each batch with `typecheck` + `test:unit`, and `test:web` (which includes the production build) at batch boundaries.
