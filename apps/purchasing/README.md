# Lippolis Electric — Purchasing Control Center

One responsive website for material purchasing. A foreman raises a request on a phone, the
workshop reviews stock and decides what to buy, approval issues a controlled purchase order
number, the PO PDF is generated and stored, a vendor email **draft** is prepared for a human to
send, the order is tracked, and whoever signs for the delivery — foreman on site or workshop at
the counter — records what actually turned up. Accounting reads the evidence behind it.

Everybody signs in at the same door and lands where their roles put them. There is one
application, one database and one set of rules; the workspaces are areas of it, not separate
apps.

---

## Run it

Requires **Node 24+** (the pilot store uses `node:sqlite`, which ships with Node).

```bash
npm install
npm run dev -w purchasing      # http://localhost:3000
```

That is the whole setup: no Docker, no database server, no credentials. The database is created
and seeded on first run at `apps/purchasing/.data/purchasing.db`; delete that file to start over.

Production build:

```bash
npm run build -w purchasing
npm run start -w purchasing
```

Configuration is documented in **`.env.example`** — copy it to `.env.local` when you need to
change anything. Nothing there is required to run the pilot locally.

### Demo accounts

Sign-in is a real email and password. Every seeded account uses the password:

```
Purchasing!2026
```

| Email | Role | Lands on | Notes |
| --- | --- | --- | --- |
| `dave@example.invalid` | FOREMAN | `/my-requests` | Assigned to jobs 24-118 and 25-007 |
| `luis@example.invalid` | FOREMAN | `/my-requests` | Assigned to job 24-203 only |
| `sam@example.invalid` | REQUESTOR | `/my-requests` | Field worker, no delivery signing |
| `mike@example.invalid` | WORKSHOP_APPROVER | `/workshop` | Primary approver |
| `rick@example.invalid` | WORKSHOP_APPROVER | `/workshop` | Authorized backup approver |
| `karen@example.invalid` | OFFICE | `/office` | **No** approval authority |
| `tom@example.invalid` | OFFICE | `/office` | Same role, approval authority **granted** |
| `ann@example.invalid` | ACCOUNTING | `/accounting` | Read-only evidence |
| `admin@example.invalid` | ADMIN | `/admin` | Users, roles, assignments, PO numbering, audit |
| `former@example.invalid` | — | — | **Disabled**: proves a disabled account cannot sign in |

Karen and Tom exist so "office cannot approve unless separately granted" is demonstrable in both
directions. Dave and Luis exist so "a foreman sees only their assigned sites" is demonstrable
rather than asserted.

### Routes

| Route | Who | What |
| --- | --- | --- |
| `/sign-in`, `/forgot-password` | anyone | The front door |
| `/my-requests` | requestors, foremen | Raise and follow requests (phone-first) |
| `/deliveries` | foremen with assigned jobs | Confirm what arrived on site |
| `/workshop` | Mike, Rick | The queue: review, decide, PO, email, receive |
| `/office` | office | Every active order, tracking, receiving |
| `/accounting` | accounting | Receipt evidence and AP packets |
| `/admin` | administrators | Users, roles, assignments, PO numbering, audit |
| `/requests/:id` | anyone who may see it | The request, its review, its history |
| `/purchase-orders/:id`, `/email-drafts/:id`, `/receipts/:id` | as above | Shareable links to one record |
| `/api/health` | anyone | Deployment status for a load balancer |
| `/unauthorized`, `/session-expired` | — | Said plainly, not as a blank 403 |

---

## The demo walkthrough

1. Sign in as **Dave**, narrow the window to phone width. **New request** → job `24-118`,
   need-by date and time, deliver to the job site, 20 × `2x4 LED troffer, 4000K`. Submit.
   The form asks nothing about vendors, prices, stock or priority.
2. Sign in as **Mike** → the workshop queue opens on **To review**. Open the request.
   - Section A is exactly what Dave submitted, read-only.
   - Section B: record **6** in stock → the suggestion becomes **14** → type **18** over it to
     keep four spare → Graybar → `86.40` → the line total computes to `$1,555.20`.
   - Section C: Approve.
3. **Generate purchase order** → `LE-52901` with a downloadable PDF. **Draft vendor email** →
   mark it reviewed (the words freeze) → approve to send → open it in your own mail client →
   mark it sent. **Mark ordered**, add tracking.
4. Sign in as **Dave** again → **Deliveries** shows the job. Confirm 12 of 18 → *Partially
   received*, and completion is refused. Receive the balance → *Received* → **Complete**.
5. Sign in as **Ann** → **Accounting** shows the packet: PO, who signed, when, and any
   discrepancy worth checking before paying.

Worth trying, because the refusals are the product: Dave opening `/workshop` or `/admin`;
Karen approving versus Tom approving; Mike approving a request Mike raised; Luis opening Dave's
job site.

---

## Authentication

Sign-in verifies a password on the server and issues a **signed, expiring, httpOnly session
cookie**. On every request the server verifies that cookie and then re-reads the person from the
database — roles, organization, active flag, job assignments. The cookie says *who*; the
database says *whether*, and the database wins, so revoking an account takes effect at once.

Two credential providers sit behind one `AuthPort`:

| Provider | When | Where credentials live |
| --- | --- | --- |
| **local** | the pilot, and every automated test | `auth_identities` — scrypt (N=16384) with a per-identity salt. A provider table, never a purchasing one. |
| **supabase** | production | Supabase Auth (`auth.users`). This app stores only `users.auth_user_id`. |

`AUTH_PROVIDER` chooses; with no Supabase URL and key configured it is `local`. Nothing above
the port can tell which is running.

Route protection is two layers. The middleware verifies the cookie's signature and expiry and
turns unauthenticated traffic away (it runs on the edge and cannot read the database, so it
decides nothing else). Every protected page then calls `requireAccess(path)`, which loads the
real user and applies `routeDecision()` — that is the security boundary. Knowing a URL is not
access.

The developer identity picker still exists, behind `PURCHASING_DEMO_MODE=1`, and
`validateEnvironment()` refuses it in production.

---

## How it is built

Purchasing is a **bounded context** inside AWE, in four layers. The dependency rule points
inward: UI → application → domain, with infrastructure implementing interfaces the domain
declares. Nothing in `domain/` imports React, a database, a clock or a network.

```
apps/purchasing/src/
  purchasing/                        THE BOUNDED CONTEXT
    domain/            entities + the LineQuantities value object, the status
                       machine, roles and permissions, workspaces and route
                       guards, money/quantity arithmetic, validation, email
                       templates, domain events, repository interfaces
    application/       use cases (one transaction each) + ports for the shared
                       AWE capabilities purchasing consumes but must not own
    infrastructure/    SQLite repositories, the auth providers, PDF, documents,
                       audit, notifications, attachments, identity, env, logging
    composition.ts     the composition root: which implementation backs each port
  app/, components/    the website — one shell, role-specific workspaces
  middleware.ts        the coarse gate in front of every route
  server/session.ts    sessions and requireAccess()
  server/service.ts    the public facade the UI and the tests import
```

Shared capabilities are consumed through ports, never rebuilt: `AuthPort` (Supabase Auth),
`IdentityPort` (users + purchasing roles), `AuditPort` (`integration_events`),
`NotificationPort`, `DocumentPort`/`AttachmentPort` (Supabase Storage), `DocumentRenderer`,
`EmailDraftPort` — which has **no `send` method**, on purpose — plus `Clock` and `UnitOfWork`.

Two persistence paths, one data model: `supabase/migrations/0016` and `0017` are the production
path (RLS, transition triggers, security-definer RPCs, `next_po_number()` under a row lock);
the pilot runs the same model on SQLite. `scripts/lib/validate-migration-0016.mjs` asserts the
two agree on statuses, roles, permissions, transitions and tables — in both directions.

---

## Tests

```bash
npm run test -w purchasing              # typecheck + all three suites
npm run test:unit -w purchasing         # 165 domain assertions, milliseconds, no database
npm run test:integration -w purchasing  # 152 assertions over the real use cases
npm run test:web -w purchasing          # 88 assertions over real HTTP (builds first)
```

- **Unit** — the invariants: the six distinct quantities, one job per request, the frozen
  original, workshop-only vendor/cost/stock, the closed transition graph in both directions,
  the draft-only email gate, exact money arithmetic.
- **Integration** — the use cases against a throwaway database, including PO uniqueness under
  eight concurrent worker threads and the full purchasing scenario end to end.
- **Website acceptance** — builds for production, starts the server on a spare port and drives
  it with real cookies and redirects: unauthenticated redirects, valid and invalid credentials,
  a disabled account, sign-out, role-based landing, every workspace boundary, assignment-scoped
  deliveries, session refresh, an expired session, a forged cookie, and the mobile pages.

Contract: `docs/testing/PURCHASING.md`.

---

## Documentation

| Document | For |
| --- | --- |
| [`docs/PURCHASING_USER_GUIDE.md`](../../docs/PURCHASING_USER_GUIDE.md) | foremen, workshop, office, accounting |
| [`docs/PURCHASING_ADMIN_GUIDE.md`](../../docs/PURCHASING_ADMIN_GUIDE.md) | administrators: users, roles, assignments, PO numbering |
| [`docs/PURCHASING_DEPLOYMENT.md`](../../docs/PURCHASING_DEPLOYMENT.md) | deploying privately: Supabase, environment, backup, rollback |
| [`docs/PURCHASING_PILOT_CHECKLIST.md`](../../docs/PURCHASING_PILOT_CHECKLIST.md) | running the Lippolis pilot |
| [`docs/PURCHASING_PRODUCTION_GAPS.md`](../../docs/PURCHASING_PRODUCTION_GAPS.md) | **what is unproven, and what does not exist** |
| [`docs/PURCHASING_ASYNC_REFACTOR_HANDOFF.md`](../../docs/PURCHASING_ASYNC_REFACTOR_HANDOFF.md) | the async boundary, the transaction contract, and the next step for Supabase |
| [`docs/testing/PURCHASING.md`](../../docs/testing/PURCHASING.md) | the test contract |

---

## Deploying to a private URL

Nothing here deploys automatically. The remaining steps, in order:

1. **Create the Supabase project** and apply `supabase/migrations/0001` … `0017`
   (`supabase db push`). Migrations 0016 and 0017 have never been executed — see below.
2. **Create the Supabase repository adapters**: a `supabasePurchasingContext()` beside the
   SQLite one in `composition.ts`. The interfaces and the SQL both already exist; no use case
   or screen changes.
3. **Set the environment** from `.env.example`: `SESSION_SECRET` (32+ random characters),
   `APP_BASE_URL`, `AUTH_PROVIDER=supabase`, the Supabase URL and keys, `AUTH_REDIRECT_URL`
   (allow-listed in Supabase), `STORAGE_DRIVER=supabase`.
4. **Invite the real users** through `/admin`, assign roles, assign foremen to their job sites,
   designate delivery receivers. Then disable the demo accounts.
5. **Host it** — any Node 24 host that can run `next start`, behind TLS on a private URL. Point
   the platform's health check at `/api/health`, which reports environment, database and
   migration status.
6. **Confirm before opening it up**: `/api/health` returns `ok`, `PURCHASING_DEMO_MODE` is unset,
   and signing in as a real user lands on the right workspace.

---

## Assumptions made (say if any are wrong)

1. One job per request, one vendor per purchase order. A request needing two vendors is split.
2. The workshop approves what the field asked for by default; Mike or Rick edit it.
3. Nobody decides on a request they raised, unless an admin enables `allow_self_approval`.
4. Office staff may record receiving (signing for a delivery is clerical) but may not make
   purchasing decisions without an explicit grant.
5. A foreman confirms deliveries only for job sites assigned to them.
6. Accounting is read-only. The role carries no write permission at all.
7. Only the requestor answers their own clarification.
8. Over-receipt needs a written reason; more than twice the ordered quantity is refused outright.
9. PO numbers start at `LE-52901`, five digits, forward-only.
10. The PO layout (`infrastructure/pdf-adapter.ts`, `LAYOUT`) is a placeholder carrying every
    required field; mapping it onto the real Lippolis form is an edit to that one object.
11. All vendors, contacts, jobs and addresses are invented; every address is `@example.invalid`.

## Shared, multi-user deployment

The application runs today on a **local provider**: one server, one file-backed database. That
is a demonstration host, not a shared system of record.

Shared data needs Supabase repositories. The boundary they plug into now **exists**: every
repository and port is asynchronous, the transaction boundary is an async, serialized unit of
work, and the domain stayed pure and synchronous throughout
([`docs/PURCHASING_ASYNC_REFACTOR_HANDOFF.md`](../../docs/PURCHASING_ASYNC_REFACTOR_HANDOFF.md)).
Writing the Supabase provider no longer requires an application-wide signature change — but it
still has not been written, and no Supabase project has ever been contacted.

## What is not finished

- **Supabase has never been contacted.** This environment has no Supabase project, CLI, Docker
  or credentials, so the Supabase auth adapter and migrations 0016/0017 are written, wired and
  parity-linted, but **not executed**. Everything that passes here runs on the local provider.
- **No Supabase repository implementations yet** — step 2 above.
- **Password reset is provider-shaped**: the local provider returns a reset code for an
  administrator to hand over (there is no mail transport); Supabase sends its own email, and
  `/reset-password` (the token exchange screen) is not built yet.
- **Attachments**: modelled, audited and stored, but the field forms do not yet upload photos
  or delivery tickets — the camera capture inputs are the next slice.
- **Notifications** are rows and events, shown in-app. Push and email delivery are not built.
- **No rate limiting** on the sign-in endpoint. Add it before the URL is public.
- `npm run lint` is broken repo-wide (`next/dist/compiled/babel/eslint-parser`) — pre-existing,
  and it fails identically on the untouched `apps/web`.
