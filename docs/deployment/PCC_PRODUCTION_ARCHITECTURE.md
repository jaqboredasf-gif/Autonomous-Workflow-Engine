# PCC — production architecture

What the Purchasing Control Center actually is, as deployed. Written for whoever has to run it,
extend it, or replace part of it — and for the version of us that comes back to this in a year.

Operational commands live in `PCC_IT_DEPLOYMENT_HANDOFF.md`. The go/no-go list lives in
`PCC_PRODUCTION_PILOT_CHECKLIST.md`. This document is the shape.

---

## 1. The whole thing, on one page

```
   Browser (desk, phone in a yard)
        │  HTTPS
        ▼
   ┌──────────────────────────────┐
   │  Reverse proxy — LIPPOLIS IT │   TLS terminated here. PCC never sees a certificate.
   └──────────────┬───────────────┘
                  │  HTTP, 127.0.0.1:3000
                  ▼
   ┌────────────────────────────────────────────────────────────┐
   │  ONE Node 24 process — Next.js standalone server           │
   │                                                            │
   │   middleware.ts     signature + expiry of the session      │
   │        │            cookie. Edge runtime, no database.     │
   │        ▼                                                   │
   │   pages / routes    every one calls requireAccess() with   │
   │        │            the real user loaded. THIS is the      │
   │        │            security boundary; middleware is a     │
   │        ▼            turnstile in front of it.              │
   │   app/actions.ts    the only write path the browser has.   │
   │        │                                                   │
   │        ▼                                                   │
   │   application/      use cases. Authorize, guard the        │
   │        │            transition, write, audit.              │
   │        ▼                                                   │
   │   domain/*.mjs      the rules. No I/O, no framework.       │
   │        │                                                   │
   │        ▼                                                   │
   │   composition.ts    the ONE place that names an            │
   │                     implementation for each port.          │
   └───────────────┬────────────────────────────────────────────┘
                   │  node:sqlite, in-process
                   ▼
   ┌──────────────────────────────┐
   │  /data  — the mounted volume │   pcc.sqlite + -wal + -shm.
   │  THE COMPANY'S RECORDS       │   Everything else is disposable.
   └──────────────────────────────┘
```

No queue. No worker. No cron. No cache server. No outbound network. One process, one file.

That is not a stage PCC is passing through on the way to something bigger — it is the correct
shape for two purchasers and a few hundred purchase orders a year, and every part of it that
would have to change under load is behind an interface that says so.

---

## 2. Components

| Component | What it is | Where |
|---|---|---|
| Web server | Next.js 16 standalone output, Node 24 | `apps/purchasing` |
| Startup preflight | Refuses to serve a misconfigured production deployment | `src/instrumentation.ts` |
| Coarse gate | Verifies the session cookie's signature and expiry | `src/middleware.ts` |
| Authorization | `requireAccess()` per screen, permissions per role | `domain/roles.mjs` |
| Use cases | Purchasing workflow, one function per business act | `application/` |
| Domain rules | Pure. No database, no framework, no clock | `domain/*.mjs` |
| Composition root | Binds every port to an implementation | `purchasing/composition.ts` |
| Store | SQLite via `node:sqlite`, WAL, foreign keys on | `infrastructure/sqlite/` |
| PDF renderer | Hand-written, no dependency, byte-deterministic | `infrastructure/pdf-adapter.ts` |
| Health | Readiness and liveness, separately | `app/api/health/`, `.../live/` |
| Logging | JSON to stdout, redacted by field name | `infrastructure/logging.ts` |

### Why the process is single-writer, and what that costs

SQLite has one writer. `composition.ts` chains every write transaction onto a promise queue, so
only one `begin immediate` is ever open on the connection. Without it, a second request can run
between one transaction's `await` and its `commit` and interleave statements inside it — which is
not slowness, it is corruption.

The cost is that concurrent writes wait for each other. At this volume that is invisible. It is
also the reason **PCC runs as exactly one instance**: two containers against one SQLite file is
not supported, and the sign-in throttle counts per process.

---

## 3. Data

### Lippolis PCC Phase 1 — the decision, stated as a decision

| | |
|---|---|
| **Instances** | One. Not "one for now because we haven't scaled it" — one by design, see §2. |
| **Operational database** | SQLite (`node:sqlite`), one file |
| **Storage** | A persistent VM-backed volume, expandable |
| **Files** | Inline in the database (§4) |
| **Backup/restore** | `scripts/pcc-backup.mjs` / `pcc-restore.mjs`, rehearsed end to end |

**This is Phase 1, chosen deliberately. It is not a claim that SQLite is the permanent
architecture, and it is not an assumption nobody examined.** It is right for this deployment
because:

* **Small user population.** Two purchasers, a handful of foremen. Not two hundred.
* **A single application instance.** The single-writer store is only a constraint if something
  else needs to write, and nothing does.
* **A modest transaction rate.** A few hundred purchase orders a year — single digits a day, not
  a second.
* **A small operational footprint.** No database server for IT to install, patch, credential,
  monitor or back up separately. The whole system is one process and one file, and the backup is
  one verified file. For a company whose IT department has other work, that is the feature.

**SQLite is not indefinitely scalable and nothing here should be read as saying so.** It is
correct at this size and it will stop being correct. The point of naming it Phase 1 is so the
transition is a planned decision rather than an incident.

### Migration signals — when Phase 1 ends

Move to PostgreSQL when any of these becomes true. None of them is true today.

| Signal | Why it ends Phase 1 |
|---|---|
| **A second application instance is needed** — for availability, or because one process cannot keep up | Two processes against one SQLite file is not supported. This is the hard one: it forces the move on its own. |
| **Measurable write contention** — approvals or receipts visibly waiting on each other | The write queue in `composition.ts` serializes transactions. When the wait is noticeable to a person, the store is the ceiling. |
| **A materially larger concurrent user population** | Ten simultaneous writers is a different application from two. |
| **A materially larger workload** — thousands of POs a year, or bulk import | Both the write path and the backup copy scale with it. |
| **A centralized customer platform requirement** — IT wants purchasing data in the company database server, for reporting or policy | An architectural requirement from outside PCC, and a legitimate one. |
| **AWE reuse needing shared infrastructure** — several customers on managed infrastructure | Phase 1's advantages are all about a single customer-owned box. |

**Do not migrate for architectural purity.** A migration is a real project with a real risk of
losing purchasing records, and "Postgres is more proper" is not a reason to take that risk while
two people raise six requests a week.

### Postgres path — current readiness

Honest status: **built, parity-checked, never run in production.**

| | |
|---|---|
| Schema | `supabase/migrations/0016_purchasing_control.sql` onward — tenant-scoped, RLS policies, security-definer RPCs, `next_po_number()` under a row lock |
| Repositories | `infrastructure/supabase/repositories.ts` — complete, and every offline suite runs against them |
| Parity | `scripts/lib/validate-migration-0016.mjs` asserts both stores agree on tables, columns, statuses, roles and transitions. Runs in the eval suite. |
| Switch | `PURCHASING_PERSISTENCE=supabase`, which also requires `AUTH_PROVIDER=supabase` |
| **Not done** | No data migration from SQLite to Postgres exists. No production deployment has run on it. Attachment upload to object storage is **not implemented** on that path (§4). |

So the path is real but it is not a switch anybody should flip on a Friday. What it buys today is
that the domain layer has never assumed SQLite, which is what makes the eventual move a
configuration and data-migration exercise rather than a rewrite.

---

**PostgreSQL is where this ends up; SQLite is where the pilot is.** Both are real, both are
written, and the choice is one environment variable.

| | Pilot (`PURCHASING_PERSISTENCE=local`) | Postgres path (`=supabase`) |
|---|---|---|
| Store | `node:sqlite`, one file on the volume | Postgres with row level security |
| Schema | `infrastructure/sqlite/database.ts` | `supabase/migrations/0016_*.sql` onward |
| Scoping | Enforced in the application layer | Enforced by RLS, per caller token |
| Backup | One file, one command | The database server's own tooling |
| Requires | Nothing | A Postgres server, and `AUTH_PROVIDER=supabase` |

The two are held to **one data model**, not two: `scripts/lib/validate-migration-0016.mjs` asserts
that the table names, column names, statuses, roles and transitions in the SQLite schema and the
SQL migration stay in lockstep, and it runs in the eval suite. The pilot cannot quietly drift into
a second shape.

**The pilot ships on SQLite deliberately.** It means no second server for IT to own, no network
between the app and its records, no credentials to rotate, and a backup that is one verified file.
IT question #9 in the handoff asks whether a company database server exists; the answer decides
when this moves, and moving it is a configuration change plus a data migration, not a rewrite.

### Schema creation and migration

There is no separate migration tool and no migration step to forget. `migrate()` runs on every
start, is idempotent by construction (`create table if not exists`, guarded column adds), and
stamps `schema_meta.version` with the version the schema has been brought **to** — so a redeploy
against a live database changes structure and never records, and `/api/health` can tell an
operator when a container is running against a database it does not understand.

Full procedure — create, upgrade, failure, rollback — is in the handoff, §7.

### Transaction boundaries

One per use case, opened by `UnitOfWork.run`, nesting-aware so a use case calling another does not
open a second. History and audit rows are written inside the same transaction as the change they
describe: there is no state in which a purchase order exists and its record of being created does
not.

### The append-only parts

`purchase_history_lines` and the activity log have delete triggers that `raise(ABORT)`. Purchasing
history is written once, at the terminal transition, and nothing above infrastructure has a path
that edits it. What was asked for is preserved separately from what was bought — a rejected
request still records the demand.

---

## 4. Files

| Kind | Generated or uploaded | Stored | Retrievable |
|---|---|---|---|
| Purchase order PDF | Generated, byte-deterministic, SHA-256 recorded | `purchase_order_documents` | `/api/documents/[id]` |
| Request attachments | Uploaded (photo of a panel) | `purchase_request_attachments` | `/api/attachments/[id]` |
| Receipt attachments | Uploaded (packing slip) | `purchase_receipt_attachments` | `/api/attachments/[id]` |

**Files live in the database** (`STORAGE_DRIVER=inline`), base64 in the row beside their metadata.
For the pilot that is the right trade and it is worth naming why: the backup becomes one file, the
restore becomes one file, and there is no second thing that can be out of step with the database
after a restore. A filesystem path plus a row is two sources of truth that a recovery has to
reconcile.

Both download routes go through `server/file-response.ts`, which never trusts what was stored:
disposition is always `attachment`, the content type comes from a short allow-list (HTML and SVG
are served as octet-stream because both carry script), the filename is stripped of paths, quotes
and control characters, and `X-Content-Type-Options: nosniff` is set. Names are also cleaned where
files enter, in `app/actions.ts`.

Limits: 6 files per request, 5 MB each.

### What inline storage costs, and when to stop paying it

The consequence is not subtle and it compounds: **every attachment is in the database, so every
attachment is in every backup, and each backup is a full copy.** A photograph uploaded once and
never looked at again is copied into the backup directory every night for as long as retention
holds it. Retention multiplies the database; it does not add to it.

The risk is therefore **storage growth and backup duration**, not correctness. Both are gradual,
both are visible before they hurt, and neither has a number attached here because nobody yet knows
how often foremen will photograph things — inventing a usage figure would make this section look
more authoritative than it is. Watch it instead.

**Extraction path, when it is needed:**

```
   today                              later
   ─────                              ─────
   database row                       database row
     ├─ metadata                        ├─ metadata      (unchanged — stays in the database)
     └─ bytes (base64)                  └─ storage key ──▶ configurable file or object storage
```

The seam is `AttachmentPort` — `attachToRequest`, `attachToReceipt`, `fetch`. The domain layer has
never seen a path or a bucket, so a filesystem driver on the VM and an object store are both
adapters. Nothing in the application knows what a storage vendor is called, and nothing should
learn.

**Triggers — move when any one of these is true:**

| Trigger | How to see it |
|---|---|
| The database file passes **1 GB** | `ls -lh /data/pcc.sqlite` |
| A backup takes **longer than a few minutes**, or overruns its window | time the backup job |
| Retained backups consume **more than half** the volume | `du -sh /data/backups` against volume size |
| Receipt/photo usage visibly accelerates | the growth *rate* between two months, not the absolute size |

Those two commands are the whole of the monitoring guidance, and they belong on whatever already
watches disk on that VM. There is deliberately no in-application storage metric: a disk alert is
infrastructure monitoring, and IT already has some.

**Do not extract this now.** Inline storage is not threatening the pilot, the migration has a real
cost, and doing it early trades a working simple thing for a speculative complicated one.

---

## 5. The networking boundary

PCC's side of the line, and IT's:

| PCC provides | IT provides |
|---|---|
| An HTTP listener on `PORT` (default 3000) | TLS termination and certificate renewal |
| Cookies marked `Secure` in production | A hostname and a DNS record |
| `APP_BASE_URL` for links it generates | The reverse proxy, forwarding `Host` / `X-Forwarded-Proto` |
| `/api/health` for draining decisions | Reachability model: VPN, public + TLS, or allow-list |
| `/api/health/live` for restart decisions | Firewall rules for that decision |

No WebSockets, no server-sent events, no long polling — a default proxy timeout is fine. Request
bodies up to ~25 MB (photographs). **PCC does not terminate TLS and does not redirect HTTP to
HTTPS**; publish the container port to `127.0.0.1` so the plain-HTTP sign-in form is not on the
network.

**Off-network access is an IT decision and PCC must not make it.** The application is correct
behind any HTTPS endpoint that reaches it. See handoff §4 and IT question #4.

---

## 6. The identity boundary

The line that matters, stated once:

> **Authentication answers "who is this person?" — and is replaceable.**
> **Authorization answers "what may they do?" — and is PCC's, permanently.**

Authentication is one interface (`AuthPort`) with one binding line in
`infrastructure/auth/index.ts`. Two implementations exist: `local-auth.ts` (scrypt, PCC's own
store, no external dependency — the pilot) and `supabase-auth.ts`. Adding Microsoft Entra ID means
writing a third file against the same interface.

Authorization never moves. Roles live in PCC's own tables and permissions are computed in
`domain/roles.mjs` from PCC's concepts — purchasing administrators, approval authority, foremen
with assigned job numbers, system administrators. An identity provider tells PCC *who signed in*;
it does not get to say what they may approve. Job assignments are resolved server-side on every
request, so a browser claiming a role or a job number never reaches an authorization decision.

**What Entra ID would need, when IT is ready:** a tenant ID, an app registration, a client ID and
secret, and a redirect/callback URL of the form `https://<APP_BASE_URL>/api/auth/callback`. The
mapping from a Microsoft account to a PCC user is the `users.auth_user_id` column, which already
exists for exactly this. Nothing above `infrastructure/auth/` changes.

---

## 7. Dependencies

**Runtime:** Node 24 — required, not preferred: the store is `node:sqlite`, which is part of the
runtime rather than a compiled dependency, so there is no native module to rebuild per
architecture. Next.js and React. That is the list.

**External services: none.** PCC makes no outbound network calls. It does not send email — the
schema pins `external_send_enabled` to false with a CHECK constraint in *both* the SQLite schema
and the SQL migration, and `EmailDraftPort` has no `send` method, so no purchasing code can call
one by accident. Vendor emails are composed as drafts and a person sends them from their own
mailbox. Enabling sending would be a reviewed migration and a new adapter, not a flipped variable.

The PDF renderer is hand-written for the same reason the store is `node:sqlite`: no npm install on
the workshop PC, no network at build time, and the same bytes for the same purchase order every
time — the document is hashed and kept as evidence.

---

## 8. Resource sizing

Start conservative. The VM has far more available; PCC should not be given it.

| | Initial | Why |
|---|---|---|
| vCPU | **2** | One Node process, single-writer store. The second core is for the PDF render and the build, not for concurrency. |
| RAM | **4 GB** | The process idles in the hundreds of MB. Headroom is for attachment downloads, which are read into memory whole — 6 × 5 MB base64-decoded, per concurrent download. |
| Disk | **50 GB, expandable** | See below. This is the number to watch. |

**Disk is the one that grows, and backups dominate it.** SQLite's online backup writes a *full*
copy each time, so retention multiplies the database size rather than adding to it: with
attachments inline at roughly 30 MB per hundred requests, and `--keep 30` nightly copies, thirty
times the database is the storage bill. Logs are capped by the compose file (5 × 10 MB). **Make
the volume expandable and watch the backup directory, not the database file.**

**What would make PCC need more:**

* more than a handful of concurrent users — but the single-writer store is the ceiling that binds
  first, and more CPU will not move it;
* attachments growing past a few hundred MB — the fix is moving files out of the database (§4),
  not a larger VM;
* a second instance — which needs the shared sign-in throttle wired *and* a store that supports
  concurrent writers, i.e. the Postgres path.

Note the shape of that list: the honest answers are architectural, not dimensional. A bigger VM
buys PCC very little, which is why it should not ask for one.

---

## 9. What is deliberately absent

Named so that nobody adds them by reflex, and so the reasons are auditable:

* **No CI/CD pipeline.** The release path is `git pull` and a rebuild. A pipeline for a
  two-person application is machinery to maintain, not safety.
* **No container orchestrator.** One process on one host.
* **No cache, no queue, no background jobs.** Nothing in the workflow is asynchronous to the
  person doing it.
* **No object storage.** §4.
* **No email transport.** §7.
* **No MFA.** Passwords with a sign-in throttle today. MFA arrives with SSO, if IT wants it.
* **No multi-instance support.** §2.
