# Lippolis Electric — Purchasing Control Dashboard (Demo)

A clickable prototype of a purchasing-control workflow: a foreman or office staffer
raises a material request, it clears (or skips) approval, a PO number is issued, and the
office produces a printable purchase order and a supplier email draft.

**This is a mock built for a walkthrough.** It has no database, no server, no credentials,
and no ability to send an email or place an order. The point is to put the workflow in
front of management, find the rules we got wrong, and fix them before anything is wired
to a real system.

---

## Install and run

From the repository root (npm workspaces, Node 20+):

```bash
npm install
npm run dev -w purchasing
```

Then open **http://localhost:3000**.

To run the production build instead:

```bash
npm run build -w purchasing
npm run start -w purchasing
```

Other scripts: `npm run typecheck -w purchasing`.

### Demo login

There is **no login and no authentication**. Use the **Acting as** dropdown in the yellow
DEMO MODE bar to switch between people — whoever is selected is recorded as the actor in
the request history. Real roles and permissions are a phase-two decision (see below).

### Demo data

All data lives in this browser's `localStorage`, so each person demoing gets their own
copy and nothing is shared. **Settings → Reset demo data** restores the seeded vendors,
jobs, requestors, and requests and sets the next PO number back to `DEMO-52901`.

---

## The demo walkthrough

1. **Dashboard** — seeded requests across every status, with filters for status, job
   number, vendor, and requestor.
2. **New Purchase Request** — press Submit with the form empty to show the validation.
   Then fill it in: one job, one vendor, and as many material rows as you like. The form
   tells you up front whether the request will need approval.
3. **Request detail** — status timeline, approve/reject, notes, and full history.
4. **Generate PO** — issues the next sequential number (`DEMO-52901`, `DEMO-52902`, …) and
   opens the printable purchase order. **Print** and **Save as PDF** both use the browser's
   own print dialog.
5. **Generate Email Draft** — a pre-written supplier email you can edit, copy, or open in
   your own mail client. Nothing is sent.
6. **Mark Ordered → Mark Received → Mark Completed** — records what happened; no order is
   transmitted anywhere.
7. **Settings** — change the approval rule and watch step 2 change behavior with no rebuild.

---

## What is real vs simulated

| Real | Simulated / placeholder |
|---|---|
| The workflow, statuses, and allowed transitions | All vendors, supplier contacts, jobs, requestors, and requests |
| Form validation rules | Estimated costs — requestor guesses, not quotes |
| Configurable approval behavior | Approval authority — anyone can approve in the demo |
| Sequential PO numbering, persisted across reloads | PO numbers are `DEMO-` prefixed and unrelated to the real PO book |
| The printable PO layout and print/PDF output | Company address and phone on the PO are placeholders |
| Email subject/body composition and the `mailto:` link | Email delivery — there is no mail server, API key, or send path |
| Data persistence (per browser) | Data storage — `localStorage` only; nothing is on a server |
| — | Attachments — the PO attachment on the email screen is a label, not a file |

### Why it cannot send anything

The app makes **zero network requests** beyond loading its own pages — verified in the
browser during testing. There is no `fetch`, no mail library, no API client, and no
environment variables. The only outward-facing control is **Open in email client**, a
`mailto:` link that hands a draft to whatever mail app is on the machine; the person still
has to press send there. Every printed PO carries the footer *"DEMO PROTOTYPE — NOT A
VALID PURCHASE ORDER."*

---

## Assumptions baked in (change these if they're wrong)

1. **One job and one vendor per request.** Two suppliers means two requests. This is
   structural — the form has single selects and validation re-checks it.
2. **A PO number is required before a request can be marked ordered**, and a PO can only
   be cut after approval.
3. **PO numbers are issued at PO-generation time**, not when the request is created, and
   are never reused.
4. **Job name and job address come from the job record**, filled in automatically from the
   job number rather than typed by the requestor.
5. **Approval default:** required at or above **$1,000**, and always required for
   Emergency priority. Configurable in Settings.
6. **Rejected and canceled are terminal.** Neither can be reopened — you raise a new
   request.
7. **Supplier suggestion is advisory.** Vendors serving the job's area sort to the top of
   the picker, but any vendor can be chosen.
8. **Estimated cost is a single number** entered by the requestor — no per-line pricing,
   tax, or freight.

## Missing business decisions (what we need from management)

1. **Who approves, and at what dollar amount?** Is it one threshold company-wide, or does
   it vary by job, requestor, or vendor?
2. **Does a foreman's request need approval at all**, or only office-originated ones?
3. **Where does the real PO number come from?** Which system owns the sequence once this
   is live, and how do we avoid colliding with the paper book?
4. **Should the PO number be assigned at request time** so the field can reference it on
   the phone, or only when the order is actually placed?
5. **What happens to a request canceled after it was ordered?** Return, restock fee, or
   credit — none of that is modeled.
6. **Partial receipts.** Backorders are common; today Received is all-or-nothing.
7. **Job numbers.** What is the source of truth, and what does a foreman do when the job
   has no number yet?
8. **Pricing.** Do we want quoted unit prices per line, tax and freight, and a real total —
   or is a rough estimate enough for control purposes?
9. **Attachments.** Do requests need photos, quotes, or spec sheets?
10. **Who is allowed to see what?** Should a foreman see other crews' requests and costs?

## Recommended phase-two integrations

- **Replace the demo store with a real API.** All persistence goes through
  `src/lib/store.ts`; swapping it for route handlers against the existing Supabase
  database is the whole migration on the client side. `src/lib/types.ts` is already
  shaped like a schema.
- **Join purchasing to jobs.** Jobs, sites, and people already exist in the Exattime
  database (`job_sites`, `users`) — the demo's `jobs`/`requestors` lists should become
  reads from those tables so job numbers stop being retyped.
- **Real vendor list** with contacts, account numbers, and per-branch coverage.
- **Email through the approval pipeline that already exists.** Workstream B has
  `message_policies` and `outbound_messages` with a draft/auto toggle per message type —
  supplier POs should ride that, not a new send path.
- **PDF generation server-side** so a PO can be attached to an email instead of printed.
- **Cost tracking against the job** — link received material to job costing and the
  invoice pipeline.
- **Roles and permissions**, once the approval questions above are answered.

---

## Layout

```
src/app/                    Routes
  page.tsx                  Dashboard: filters + recent requests
  requests/new/             New purchase request form
  requests/[id]/            Request detail: timeline, actions, history
  requests/[id]/po/         Printable purchase order
  requests/[id]/email/      Email draft preview
  settings/                 Approval rules, PO counter, reset
src/components/             Reusable UI (StatusBadge, RequestTable, FilterBar, …)
src/lib/
  types.ts                  Domain types — the shape a real schema would take
  demo-data.ts              ALL invented seed data; replace this one file
  store.ts                  The only read/write path for demo data
  store-context.tsx         React binding for the store
  status.ts                 Status machine + approval policy
  validation.ts             Request validation rules
  po.ts                     PO numbering (DEMO- prefix, starts at 52901)
  email-draft.ts            Email composition (returns strings; no transport)
```

### Known issue

`npm run lint` does not run in this monorepo: `eslint-config-next` is hoisted to the root
`node_modules` where `next` is not resolvable. This affects `apps/web` identically and
predates this app. Type safety is covered by `npm run typecheck -w purchasing` and by
`next build`, which type-checks the whole app.
