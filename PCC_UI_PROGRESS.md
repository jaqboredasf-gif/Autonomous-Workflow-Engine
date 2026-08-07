# PCC UI Progress

## Repository State
Branch: `claude/purchasing-control-center`
Commit at session start: `20e8aef` (Establish what each authenticated person may do)
Working tree: modified, **not committed** — everything below is uncommitted work.

Local environment: Next 16 dev server on **http://localhost:3100**, `PURCHASING_PERSISTENCE=supabase`
against the local Supabase stack (`http://127.0.0.1:54321`, container `supabase_db_exattime`).

## Completed

### Checkpoints
- **CP0** — repository inspection, `PCC_UI_GAP_REPORT.md`
- **CP1** — design tokens + reusable component library
- **CP2** — authenticated product shell
- **CP3** — screens 01–10
- **CP4/CP5** — states, verification (see below)

### Components (`apps/purchasing/src/components/pcc/`)
`Button`/`ButtonLink`/`ButtonRow` · `TextInput`/`SelectInput`/`TextArea`/`SearchInput`/`CurrencyInput`/`CheckboxField`/`Field` ·
`Badge`/`StatusBadge`/`UrgencyBadge`/`CountPill` · `Card`/`Panel`/`KpiCard`/`DataPoint`/`DataGrid` ·
`TableFrame`/`Table`/`THead`/`TH`/`TBody`/`TR`/`TD`/`TDLink`/`TableEmpty`/`TableSkeleton`/`TableCount` ·
`Alert`/`InlineError`/`EmptyState`/`Skeleton`/`CardSkeleton`/`Breadcrumb`/`PageHeader`/`ToneLabel` ·
`Tabs`/`SubTabs` · `Timeline`/`ActivityItem`/`ActivityFeed` · `ConfirmSubmit`/`UnsavedChangesGuard` ·
`FileUpload`/`PhotoUpload` · `ReceivingItem` · `MaterialSearch` · `PurchasingQueue`/`QueueFilters`/`VendorFilters` ·
`AppShell`/`ShellChrome` · `status-display` (label map, derived urgency, next-action) · `login-strings` (en/es).

`components/ui.tsx` is now a thin adapter over the library, so the older screens share one implementation.
There is **no toast**: mutations are server actions that re-render, so state lives in `Alert`s that persist.

### Screens
| # | Screen | Route |
| --- | --- | --- |
| 01 | Login | `/sign-in` (English/Español entry point, unauthorized state) |
| 02 | Dashboard | `/dashboard` (4 KPIs, exceptions, queue preview, activity, quick actions) |
| 03 | New Request | `/requests/new` (catalog autocomplete, derived priority, attachments) |
| 04 | Purchasing Queue | `/workshop` and `/office` (URL-driven filters, lifecycle tabs, next action) |
| 05 | PO Detail | `/requests/[id]` (vendor email on the PO, receiving progress, timeline, confirmations) |
| 06 | Receiving | `/receiving` index + `/requests/[id]/receive` (mobile-first, exceptions, evidence) |
| 07 | Vendors | `/vendors` |
| 08 | Vendor Profile | `/vendors/[id]` (counted metrics only) |
| 09 | Material Catalog | `/materials` (read from history via `normalized_description`) |
| 10 | Administration | `/admin?module=…` (9 modules) |
| — | Reports | `/reports` (spend by job/vendor, counted) |

New route guards were added to `ROUTE_GUARDS` for every new path — an unlisted route fails closed.

## Verification

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` (in `apps/purchasing`) | clean |
| `npm run test:unit -w purchasing` | 203 passed, 0 failed |
| `npm run test:providers -w purchasing` | 268 passed, 0 failed |
| `npm run test:isolation -w purchasing` | 123 passed, 0 failed |
| `npm run test:integration -w purchasing` | 177 passed, 0 failed |
| `npm run test:web -w purchasing` | **production build OK**, 89 passed, 0 failed |
| `npm run pcc:e2e` (against :3100 on Supabase) | 43 passed, 0 failed |

## Defects found and fixed (not UI — these blocked the product)

1. **`saveReviewAndDecide` never awaited its two steps** (`application/decisions.ts`) — the decision raced the
   save, threw `nothing_to_order` into a floating promise, and returned `{decided:true}`. Approvals silently
   did nothing; pressing Approve twice appeared to work.
2. **`getDocumentForDownload` never awaited its authorization check** (`application/queries.ts`) — the
   record-level check its own comment promised did not run. Any org member could fetch any PO document.
3. **`recomputeTotals` unawaited** (`application/review.ts`) — the reviewSaved event recorded an empty totals
   object and the roll-up onto the request raced whatever read it next.
4. **`authzView` dropped `jobNumber`** (`application/context.ts`, `queries.ts`) — assignment-scoped
   authorization compared against `undefined`, so no foreman could ever record a receipt. Failed closed.
5. **RLS refused the entire lifecycle on Supabase** — migrations `0023`–`0027`:
   - `0023` no INSERT policy on `purchase_activity_log` / `purchase_notifications`; every write path failed.
   - `0024` `purchase_requests` owner-UPDATE had USING and no WITH CHECK, so a draft could never be submitted;
     no policy at all for purchasing staff, so no later transition could happen.
   - `0025` missing INSERT policies on orders, order documents, email drafts, approvals, receipt attachments.
   - `0026` `purchase_email_drafts` same WITH CHECK trap — a draft could never leave `GENERATED`, which also
     made `ORDERED` unreachable.
   - `0027` the receiver could not READ what they were signing for; `purchasing_may_receive()` already existed
     and was simply never used on the read side.
6. **Supabase PO view selected `orgs.phone`/`orgs.address`** — columns that schema has never had; every PO
   sheet 500'd.
7. **Supabase line-item inserts never wrote `normalized_description` or `org_id`** — the material catalog would
   have been permanently empty in production while working locally.

## Known issues

- **`npm run lint` cannot run** — `eslint-config-next` requires `next/dist/compiled/babel/eslint-parser`, which
  does not exist in the installed Next 16 tree. Pre-existing; not caused by this work and not worked around.
- **Migrations 0023–0027 were applied to the running local database by hand** (`docker exec … psql`). They are
  committed as files and will apply on a fresh `supabase start`, but a running stack elsewhere needs them run.
- **`scripts/eval-purchasing-e2e.mjs` was a broken WIP** at session start (it targeted button labels and form
  fields that never existed). Its selectors now match the shipped UI and all 43 checks pass.
- **Priority is derived, not stored.** The handoff asks for Normal/Urgent/Emergency; the domain forbids a
  requester-set `priority` (`REQUESTOR_FORBIDDEN_FIELDS`) and has no column. Urgency is computed from the
  need-by moment. Making it a stored field is a migration + domain decision, not a UI one.
- **Preferred vendor is captured as a suggestion in the request notes**, not as `vendor_id` — that column is
  also forbidden to requesters, because choosing the supplier is a purchasing decision.
- **Vendor categories, preferred status, emergency availability and delivery/pickup capability are not in the
  schema.** Screens 07/08 say so rather than showing invented values.
- **i18n covers the sign-in screen only** (`components/pcc/login-strings.ts`). `statusMessageKey()` still
  returns keys nothing resolves.
- **No curation writes to `purchase_item_catalog`** — screen 09 reads it and would show curated names
  immediately, but nothing writes it yet.

## Local development access

```
npm run pcc:dev-user      # idempotent; refuses any non-127.0.0.1 Supabase URL and NODE_ENV=production
npm run pcc:dev           # next dev
npm run pcc:e2e           # end-to-end over HTTP (needs a running server + Supabase env)
```

Inspection account: `dev@lippolis.test` / `pilot-password-9137`, Lippolis Electric, holding every role plus
approval authority and an assignment to job 24-118. It is an ordinary user — password sign-in, RLS applies,
no bypass anywhere in the application.

## Exact Next Action

1. **Commit this work.** The tree is clean and green but nothing is committed.
2. **Development role switcher in Administration** (requested): change the simulated authorization context in
   local development only, so one account can be viewed as admin/purchaser/foreman/requester/receiver. Must be
   impossible to activate in production and must not add a bypass to any route.
3. Consider `scripts/eval-purchasing-e2e.mjs` for the `test:` chain in `apps/purchasing/package.json` — it is
   the only suite that exercises the Supabase provider through the browser's own path.
