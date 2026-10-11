# AWE deployment model — reconstructed from PCC

**What this is.** The deployment architecture PCC *actually* has, verified against repository
files rather than against handoff prose, with every decision sorted by whether it belongs to AWE,
to a customer, to PCC, or to Lippolis.

**What this is not.** A design for an AWE platform. One deployment is one data point. This
document exists so the *reasoning* survives long enough to be tested against a second customer.

**Read `PCC_REUSABLE_DEPLOYMENT_LESSONS.md` first** — it records what the deployment cost and why.
This document is the structural companion: what exists, and which layer owns it.

---

## 1. The deployment model that exists

Every row verified against a file. Where a claim rests on prose only, it says so.

| Concern | What PCC actually does | Verified in |
|---|---|---|
| **Runtime** | Node.js **≥24**, hard requirement — the datastore is `node:sqlite`, part of the runtime. Node 20 fails at import with an unactionable error. | `package.json` `engines`, `_engines_note` |
| **Framework** | Next.js 16.2.10, App Router, server components. HTML is served by the same process; there is no separate front end. | `apps/purchasing/package.json` |
| **Build artifact** | `output: 'standalone'` → a self-contained server directory. **`.next/static` and `public` are not folded in by Next** and are staged by a post-build step. | `next.config.ts`, `scripts/stage-standalone.mjs` |
| **Datastore** | SQLite, one file. A Postgres/Supabase path exists behind the same repository interfaces and is selected by `PURCHASING_PERSISTENCE`. | `composition.ts`, `infrastructure/{sqlite,supabase}` |
| **Persistent filesystem** | Exactly one directory. The database file plus backups. Attachments are stored **inside** the database. | `database-location.ts` |
| **Config contract** | One module reads the environment; `validateEnvironment()` is the only validator. Four variables are required in production. | `infrastructure/env.ts` |
| **Secrets** | `.env` gitignored; `.env.example` committed with names and owners only. On Linux `/etc/pcc.env`, mode `640`, `root:pcc`. | `.env.example`, `deploy/pcc-node.service` |
| **Service management** | Two systemd units shipped — plain Node and Docker. Windows is documented as a wrapper, not implemented. | `deploy/*.service` |
| **Restart policy** | `Restart=on-failure` **with `RestartPreventExitStatus=1`** — crashes restart, deliberate config refusals do not. | `deploy/pcc-node.service` |
| **Health** | Two endpoints with opposite remedies: `/api/health` (readiness: config, database, migrations) and `/api/health/live` (liveness). | `app/api/health/{route.ts,live/route.ts}` |
| **Logging** | JSON lines to stdout/stderr, collected by journald or Docker. Redaction is **by field name** (`password`, `token`, `secret`, `authorization`, `cookie`, `anonKey`, `serviceRoleKey`). | `infrastructure/logging.ts` |
| **Reverse proxy** | Assumed, not provided. PCC serves plain HTTP and terminates nothing. | `PCC_PRODUCTION_HANDOFF.md` §3 |
| **Hostname / DNS** | Customer-owned. `APP_BASE_URL` is the single variable that tells the app its own address. | `env.ts` |
| **TLS** | Entirely outside the application. Session cookies are `Secure`, so HTTP breaks sign-in persistence. | `env.ts`, handoff §3 |
| **Backup / restore** | `pcc-backup.mjs` (online, verifies what it wrote) and `pcc-restore.mjs`. One file is the whole backup. | `scripts/pcc-{backup,restore}.mjs` |
| **Update** | `git pull` → build → `check-deployable` → rsync → restart → health. No pipeline. | handoff §10 |
| **Rollback** | Application directory is disposable; database is not. Migrations move forward only. | handoff §11 |
| **OS** | Linux assumed by the shipped units; Windows explicitly supported-but-unwritten. | `deploy/*`, runbook |
| **Network** | Inbound one port from the proxy. **No outbound connections at all.** | `RestrictAddressFamilies`, handoff §3 |
| **Auth** | Pluggable: local scrypt or Supabase, chosen by `AUTH_PROVIDER`. Authorization is PCC's own and is not pluggable. | `infrastructure/auth/`, `domain/roles.mjs` |
| **Email** | No transport exists. Drafts only, pinned by a database CHECK constraint. | `env.ts` (`externalSendEnabled: false`) |
| **Monitoring** | None shipped. An endpoint to poll, and that is the contract. | — |
| **Migration / bootstrap** | Migrations run automatically at startup, idempotently. **No separate migrate command.** Bootstrap admin from environment on first start. | `sqlite/database.ts` `migrate()`, `bootstrap.ts` |

### The two enforced contracts worth naming

Most of the table is convention. Two things are enforced by code that **refuses to start**, and
they are the load-bearing parts of the model.

**The persistent-state contract.** `database-location.ts` refuses, in production, to: default to a
path inside the container, accept a relative path, create a missing directory, put the database
inside a git working tree, or create a new database without one-time authorization
(`PCC_DATABASE_ALLOW_CREATE=1`). Each refusal names the variable and says what the operator should
check. This is the single most transferable piece of engineering in the deployment.

**The configuration contract.** `validateEnvironment()` refuses production start without
`SESSION_SECRET`, `PCC_DATABASE_PATH` or `APP_BASE_URL`, and refuses `PURCHASING_DEMO_MODE=1`
outright. It reports the *variable*, never the *value*.

---

## 2. Classification

### AWE UNIVERSAL PRIMITIVE

Reasoning contains no reference to Lippolis, PCC's domain, or a specific technology.

| Primitive | Why universal |
|---|---|
| **One config module, validated once, fatal in production** | Any application deployed to a machine you do not administer will be misconfigured at some point. The only question is whether it says so at 09:00 on install day or at 16:00 three weeks later. |
| **Persistent-state contract enforced by the app** | Every deployed application has state that must outlive the release. Documentation saying "don't put it there" is a hope; a startup refusal is a guarantee. Found by reading our own runbook as a stranger. |
| **Readiness and liveness as separate endpoints** | They have opposite remedies. Conflating them turns a config typo into a restart loop. Costs nothing to separate at the start. |
| **Restart on crash, not on refusal** | A supervisor that loops on a deliberate configuration failure buries the one line explaining it. |
| **Migrations that run at startup, idempotently** | Removes an entire class of "did anyone run the migration?" failure, and makes repeat deployment safe by construction. |
| **Secret separation with a committed template that holds none** | The template is documentation; the secret is infrastructure. They must never be the same file. |
| **Structured logs, redacted by field name** | By *name*, not by discipline — discipline fails the first time somebody logs a new object. |
| **Read-only preflight before touching anything** | Disk, port, config, paths. PASS/WARNING/FAIL. It changes nothing, so it can be run by somebody nervous. |
| **Backup that verifies what it wrote** | A backup nobody has read back is not a backup. |
| **Restore rehearsal as an executable artifact** | A written restore procedure gets marked GREEN and never run. |
| **Build-time provenance assertion** | An ignore rule is a hope; a failing build is a guarantee. Pair every exclusion with a check that it worked. |
| **Row-level production verifier** | Provenance rules govern how a database was *created*; they cannot catch a laptop database copied to the server, which is exactly what happens the evening before go-live. |
| **Deployment evidence per gate** | Requiring an evidence column is what stops optimistic green. |
| **Authentication replaceable, authorization not** | Costs nothing on day one; makes "they want SSO" a non-event instead of a rewrite. |
| **The app requires only: a port, HTTPS in front, proxy headers, its own address** | Anything more couples the product to one customer's network. |

### AWE DEFAULT POLICY

Sensible starting positions AWE can offer; each may vary per organization.

| Default | Why a default and not a primitive |
|---|---|
| Linux VM + systemd | Correct here and probably common. A Windows-only customer changes it and nothing else. |
| Node LTS as the runtime | AWE's language choice, not a law of deployment. |
| Reverse proxy terminates TLS | Near-universal, but a managed platform may terminate elsewhere. |
| Port 3000, `0.0.0.0` | Arbitrary and configurable. |
| `/opt/<app>` code, `/var/lib/<app>` data | Linux convention; meaningless on Windows. |
| Nightly backup, 30 days | Fits a small dataset. Volume changes it. |
| Docker as packaging | Worked; the customer had it. **Needs a customer who does not.** |
| Two supervision variants shipped | Right with an unknown OS. May collapse to one once AWE knows its market. |

### ORGANIZATION CONFIGURATION

Must be *received*, never guessed. See `AWE_DEPLOYMENT_DISCOVERY_CONTRACT.md`.

Hostname and DNS control · exposure (internal/VPN/public) · who terminates TLS and issues certs ·
OS and hosting environment · persistent storage location and backup platform · identity provider ·
outbound network policy · who restarts it · allowed change windows · data residency.

### APPLICATION-SPECIFIC REQUIREMENT (PCC, not AWE)

Node ≥24 *because* of `node:sqlite` · the purchasing schema and its migrations · the PO-number
sequence · workshop/receiving roles · the review→send→ordered email gate · `pcc-verify-production`'s
actual checks (demo vendors, PO pairs, workshop location) — the *idea* generalizes, the *checks* do
not.

### LIPPOLIS-SPECIFIC DETAIL — must not leak into any AWE model

SQLite as the operational store · attachments inline · draft-only email (a *business* rule) ·
2 vCPU / 2–4 GB / 20–50 GB sizing · `pcc.lippolis.local`-style naming · the bootstrap-admin pattern
(a customer with SSO from day one would never use it) · the specific storage thresholds.

---

## 3. Hidden assumptions

Assumptions that held at Lippolis and may not hold next time.

| Assumption | Verdict | What to do |
|---|---|---|
| **Linux** | Should become a discovery question | Units are Linux; the app is not. Windows path is documented, unwritten, untested. |
| **root/sudo on the VM** | Discovery question | Needed to install a service and create `/var/lib`. A managed host may forbid it entirely. |
| **Node 24 installable on the host** | **Genuine limitation** | Not negotiable while the store is `node:sqlite`. A locked-down host with Node 18 cannot run PCC without changing the datastore. Ask early. |
| **No outbound internet needed at runtime** | Safe universal | A real strength — makes PCC deployable in a segmented network. Preserve it deliberately. |
| **Outbound internet at *build* time** | Should become configurable | `npm ci` and `git pull` need registry and repo access. An air-gapped customer needs a prebuilt artifact — the standalone directory is already exactly that. |
| **GitHub reachable from the server** | Discovery question | Build-elsewhere-and-copy is already supported by the artifact shape; it is not documented as a first-class path. |
| **Static private IP / stable hostname** | Safe universal | Any server application needs this. |
| **Customer owns the reverse proxy** | Safe universal (boundary) | The boundary is right. *Whether one exists* is a discovery question. |
| **Customer manages TLS certs** | Discovery question | A customer with no PKI needs AWE to recommend one (Caddy/ACME). |
| **Customer controls DNS** | Discovery question | Without it, deployment falls back to IP + hosts entries, which is workable and ugly. |
| **Local persistent disk** | Should be abstracted | SQLite requires a real local filesystem. Rules out most container platforms with ephemeral disk, and NFS is a known SQLite hazard. **This is the assumption most likely to break next.** |
| **VM reboots cleanly and starts services** | Safe universal, must be *tested* | Cheap to verify, embarrassing to assume. |
| **No SMTP needed** | Should become a capability | PCC deliberately cannot send. Customer two will likely want sending — that is an adapter behind the existing email port, not a redesign. |
| **Permissive internal firewall** | Discovery question | One inbound port from the proxy is a small ask, but must be asked. |
| **No SSO** | Should be abstracted (already is) | The auth boundary exists. A Microsoft-shop customer needs an Entra adapter — new file, existing interface. |
| **Internal-only, no external users** | Discovery question | External users change TLS, exposure, session policy and probably MFA. |
| **Customer has a backup platform** | Discovery question | We ship the command; they own schedule and offsite. A customer with neither needs AWE to say so plainly. |
| **Customer has monitoring that can poll a URL** | Discovery question | If not, `Restart=on-failure` plus a weekly human check is the honest fallback. |
| **An IT person exists at all** | **Biggest single risk** | Every artifact here assumes a Jose. A customer with no IT staff needs AWE (or a partner) to own the infrastructure, which is a different commercial model, not a different document. |

---

## 4. What the productionization pass added

Five defects found by running a **production build against an empty database** — none visible to
the test suite, which builds every database from the development fixture. Four are new universal
lessons.

**UNIVERSAL — a green health check does not mean a working product.** The standalone build served
`200` on `/api/health` and `404` on every stylesheet. The process was healthy; the product was
unusable. *Health checks answer "is the process up", never "is the product right". Deployment
validation must load a real page and assert on its content.*

**UNIVERSAL — the build artifact is not finished when the build tool exits.** Next leaves
`.next/static` and `public` outside the standalone tree for the packager to copy. Docker did it;
the systemd path documented it; running it in place did neither. *Whatever step completes the
artifact must be part of the build, so every deployment path gets the same directory.*

**UNIVERSAL — computation that matters must be server-authoritative.** The quantity to order was
computed in the browser into a hidden field. An unhydrated page posted the pre-stock value, so a
job needing 10 with 2 in stock would have ordered **10, not 8** — wrong quantity, no error, on a
purchase order sent to a supplier. *If a number has business consequences, the server derives it;
the client may preview it.*

**UNIVERSAL — a verifier that cries wolf on a correct system is worse than no verifier.** The
go/no-go check detected demo vendors *by name*, and the fixture names are real suppliers the
customer buys from — so a correctly configured production database reported NOT READY and would
have told IT to delete the real vendor directory. It also counted jobs from a legacy table. *Detect
fixture data by a marker that only fixtures carry, never by a value a real customer might share.
The next genuine finding gets waved through with the false one.*

**Confirming the existing lesson** — the fourth defect (a state guard evaluated against a row read
before entering the write queue) is the same shape as "test the second deployment, not the first":
correctness under repetition is invisible to a single-pass test.
