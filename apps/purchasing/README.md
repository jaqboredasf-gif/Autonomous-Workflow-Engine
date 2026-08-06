# Lippolis Electric — Purchasing Control Center

One shared web application for material purchasing: a foreman raises a request on a phone,
the workshop reviews stock and decides what to buy, an approval issues a controlled purchase
order number, the PO PDF is generated and stored, a vendor email **draft** is prepared for a
human to send, and the order is tracked and received — partially if that is what turns up.
Every meaningful action lands on an audit timeline.

This is not a mockup. It has a real data model, real role-based authorization enforced on the
server, real transactions, a real PO sequence that survives two people pressing Approve at the
same second, real PDF generation, and an automated test suite.

---

## Run it

Requires **Node 24+** (the app uses `node:sqlite`, which ships with Node). From the repository
root:

```bash
npm install
npm run dev -w purchasing      # http://localhost:3000
```

Production build:

```bash
npm run build -w purchasing
npm run start -w purchasing
```

Other scripts: `npm run typecheck -w purchasing`, `npm run lint -w purchasing`.

The database is created on first run at `apps/purchasing/.data/purchasing.db` and seeded with
one organization, the cast below, three vendors, five delivery locations and three jobs.
Delete that file to start over. Override the location with `PURCHASING_DB_PATH`.

### Signing in

There is no password. The sign-in page lists the seeded people; picking one sets an httpOnly
session cookie, and **the server derives your identity from that cookie only** — a form field
claiming to be Mike does not make you Mike. This is identification, not authentication: see
"What is not finished" below.

| Person | Role | Notes |
| --- | --- | --- |
| Mike | `WORKSHOP_APPROVER` | primary approver |
| Rick | `WORKSHOP_APPROVER` | authorized backup approver |
| Dave Kearns | `REQUESTOR` | foreman |
| Sam Ortiz | `REQUESTOR` | field |
| Karen Doyle | `OFFICE` | full visibility, **no** approval authority |
| Tom Reilly | `OFFICE` | office **with** an explicit approval grant |
| System Administrator | `ADMIN` | users, PO numbering, settings, audit |

Karen and Tom exist so the rule "office users cannot approve unless separately granted
approval authority" is demonstrable in both directions.

---

## The demo walkthrough

1. Sign in as **Dave** (a phone-sized window is the right way to see this). **New request** →
   job `24-118`, need-by date and time, deliver to a job site, one line: 20 × `2x4 LED troffer,
   4000K`. Submit. Note what the form does *not* ask for: no vendor, no price, no stock, and no
   priority — need-by date and time replaced it.
2. Sign in as **Mike** → **Workshop queue** → open the request.
   - Section A shows exactly what Dave submitted, read-only.
   - Section B: record **6** usable in stock. The suggestion becomes **14** (approved − stock,
     never below zero). Type **18** over it to keep four spare on the shelf, pick Graybar, enter
     `86.40`. The line total computes to `$1,555.20`.
   - Section C: Approve.
3. Back on the request: **Generate purchase order** → `LE-52901`, with a stored PDF you can
   download or print.
4. **Draft vendor email** → the draft carries the PO number, the job number, the need-by date
   and time, the order summary and the PDF attachment. Edit it, mark it reviewed (it freezes),
   approve to send, open it in your own mail client, then mark it sent.
5. **Mark ordered**, add a tracking number, then **Record receiving**: 12 of 18. The request
   goes to *Partially received* and refuses to complete. Receive the remaining 6 → *Received*,
   the requestor is notified the material is ready → **Complete**.
6. The **Activity** panel shows every step, with who did it, when, and what changed.

Try the refusals, too — they are the point:

- As Dave, open `/queue` or `/admin`: refused.
- As Dave, open another person's request: not found.
- As Karen, approve something: refused. As Tom (same role, explicit grant): allowed.
- As Mike, approve a request Mike raised: refused — an approver is not an independent reviewer
  of their own request. (`allow_self_approval` in settings exists for a one-approver shop.)

---

## How it is built

Purchasing is a **bounded context** inside AWE, in four layers. The dependency
rule points inward: UI → application → domain, with infrastructure implementing
interfaces the domain declares. Nothing in `domain/` imports React, a database,
a clock or a network.

```
apps/purchasing/src/
  purchasing/                        THE BOUNDED CONTEXT
    domain/                          pure — no I/O, no clock, no framework
      entities.mjs      entities + the LineQuantities value object (the six
                        quantities, kept apart by construction)
      status.mjs        the 14 statuses and the closed transition graph
      roles.mjs         roles, permissions, authorize()
      numbers.mjs       money (integer cents), quantity (integer thousandths)
      validation.mjs    intake rules + the requestor field firewall
      email.mjs         six templates, draft statuses, the send gate
      po-number.mjs     PO number formatting (allocation is the database's)
      activity.mjs      the audit + notification vocabularies
      events.mjs        domain events, one builder per meaningful fact
      dashboard.mjs     summary cards and filters
      repositories.ts   repository INTERFACES (types only)
    application/                     use cases — one transaction each
      ports.ts          interfaces for the shared AWE capabilities consumed
      context.ts        the context + the three checks (authorize, tenant, transition)
      requests.ts       create · update · submit · respond · cancel · note · attach
      review.ts         record workshop stock · select vendor and pricing
      decisions.ts      approve · reject · return for clarification
      fulfilment.ts     PO · vendor email draft · ordered · tracking · receive · complete
      queries.ts        the read side (reads are authorization decisions too)
      administration.ts approval authority · PO numbering
    infrastructure/                  the only code that knows how things are stored
      sqlite/database.ts     schema + transactions (node:sqlite)
      sqlite/repositories.ts the only file with table names in it
      adapters.ts            identity · audit · notifications · documents ·
                             attachments · email drafting · PDF rendering
      pdf-adapter.ts         the PO PDF, written by hand (deterministic bytes)
      seed.ts                the pilot's starting data
    composition.ts                   the composition root: which implementation
                                     backs each port. Swap it for Supabase here.
  app/, components/                  the UI (role-specific screens)
  server/service.ts                  the public facade the UI and tests import
  server/session.ts                  the server-side session
```

### What Purchasing owns, and what it borrows

It owns purchase requests and their lines, workshop reviews and stock
observations, the six quantities, vendor selection *for a purchase*, estimated
pricing, approval decisions, purchase orders and their lines, vendor email draft
records, receiving records, the purchasing status model, and purchasing activity
events.

It owns none of these, and consumes each through a port in
`application/ports.ts` — the pilot binds them to local implementations, and the
named production capability replaces the binding without touching a use case:

| Port | Production capability |
| --- | --- |
| `IdentityPort` | Supabase Auth + `users` (0001) + `purchasing_user_roles` (0016) |
| `AuditPort` | the org audit trail / `integration_events` (0009) |
| `NotificationPort` | the notification layer, same `emit_event` contract |
| `DocumentPort` / `AttachmentPort` | Supabase Storage (the 0005 idiom) |
| `DocumentRenderer` | PDF rendering |
| `EmailDraftPort` | draft composition; **there is no `send` on the port** |
| `Clock`, `UnitOfWork` | time and the transaction boundary |

Tenant management, general role infrastructure, generic approval machinery,
inventory management, accounting and job management stay outside the boundary.
Purchasing records a *stock observation* and an *inventory adjustment* against a
request; it does not try to be a warehouse.

**Two persistence paths, one data model.** `supabase/migrations/0016_purchasing_control.sql`
is the production path: the same tables, RLS policies, a transition trigger, security-definer
RPCs, and `next_po_number()` under a row lock. The pilot runs SQLite so the shop can use it
with no credentials, no Docker and no network. `scripts/lib/validate-migration-0016.mjs`
asserts the two stay in lockstep — statuses, roles, permissions, transitions and tables — so a
change in one cannot silently diverge from the other.

**Authorization is server-side.** Every mutation calls `authorize()` before anything else, and
a refusal is written to the activity log before it is thrown. Hidden buttons are a courtesy;
the server is the control. The UI derives what to offer from the same function, so an offered
action always succeeds and an unoffered one always fails.

**Money and quantities never touch a float.** Money is integer cents (numeric(12,2) in
Postgres); quantities are integer thousandths (numeric(14,3)). 18 × $86.40 is $1,555.20,
exactly, every time.

**Email cannot be sent.** There is no transport in this module: no SMTP, no Graph, no fetch.
"Sent" means a human copied an approved draft into their own mail client. The database refuses
to store `external_send_enabled = true`, so turning sending on is a reviewed migration, not a
flag someone flips.

---

## Tests

```bash
npm run test -w purchasing        # typecheck + unit + integration
npm run test:unit -w purchasing   # domain invariants, milliseconds, no database
npm run test:integration -w purchasing
```

**Unit** (`scripts/eval-purchasing-domain.sh`) — 165 assertions over
`src/purchasing/domain/**` alone: the six quantities stay distinct and the
derived ones are derived, one job per request, the original frozen after
submission, vendor/cost/stock as workshop-only decisions, the closed transition
graph and its preconditions, every domain event naming a known action, the
draft-only email gate, and exact money arithmetic.

**Integration and end-to-end** (`scripts/eval-purchasing.sh`) — 152 assertions
driving the real use cases against a throwaway SQLite database, including PO
uniqueness under eight concurrent worker threads and the full §16 demo scenario.

Both are offline, need no credentials, and finish in about fifteen seconds. It drives the modules the app actually
ships (Node strips the TypeScript types on import) against a throwaway database, and covers the
intake rules, the field firewall, every authorization rule, the quantity algebra, the state
machine, PO-number uniqueness **under eight concurrent worker threads**, the draft-only email
gate, partial receiving and the over-receipt override, the audit timeline, tenant isolation, and
the full demo scenario end to end. Contract: `docs/testing/PURCHASING.md`.

---

## Assumptions made (say if any are wrong)

1. **One job per request and one vendor per purchase order.** A request needing two vendors is
   split into two requests. Multi-vendor splitting is a designed extension, not a hidden rule.
2. **The workshop approves what the field asked for by default.** Approved quantity starts at
   the requested quantity and Mike or Rick edit it.
3. **Nobody decides on a request they raised**, unless an admin turns on `allow_self_approval`.
4. **Office staff may record receiving** (signing for a delivery is clerical) but may not make
   purchasing decisions without an explicit grant.
5. **Only the requestor answers their own clarification.** Office can see and annotate; the
   answer is evidence of who said what.
6. **Over-receipt needs a written reason**, and more than twice the ordered quantity is refused
   outright as a data-entry error.
7. **PO numbers start at `LE-52901`**, five digits. Admin → PO numbering changes it; the
   sequence can only move forward.
8. **The PO template is a placeholder layout** (`src/server/pdf.ts`, `LAYOUT`) carrying every
   required field. Mapping it onto the real Lippolis form is an edit to that one object.
9. All vendors, contacts, jobs and addresses in the seed are invented, and every email address
   is `@example.invalid`.

## What is not finished (and is deliberately visible)

- **Authentication.** Sign-in identifies, it does not authenticate. Swap `src/server/session.ts`
  for Supabase Auth before this is reachable from outside the shop — every policy in migration
  0016 is already written against `auth.uid()`, and `service.ts` only ever receives an actor.
- **Admin editing** covers approval authority and PO numbering. Vendors, delivery locations and
  email templates are read-only screens in this milestone; the tables, permissions and RLS for
  editing them already exist, so it is screens, not architecture.
- **Attachments** are modelled and recorded end to end, but the intake form does not yet upload
  files; the production path stores them in Supabase Storage rather than inline.
- **Notifications** are written as rows and emitted as events (the same `emit_event` contract as
  the rest of AWE). Delivering them to a phone is the next integration, not a new subsystem.
- **The migration has not been run against a live Postgres** — no local Supabase or Docker was
  available in this environment. Its parity with the app is linted; its execution is not.
  Run `supabase db push` (or apply `0016` via the management API) before relying on it.
