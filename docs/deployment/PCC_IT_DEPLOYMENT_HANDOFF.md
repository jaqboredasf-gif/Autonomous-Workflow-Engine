# PCC — deployment handoff for IT

**Purchasing Control Center (PCC)** for Lippolis Electric. This document is for the person who
will run it on a company server. It states what the application needs, what it does not care
about, and what we still need from you.

Nothing here prescribes a hosting provider. PCC is an ordinary Linux container that listens on a
port; where that container runs is your decision, and the application has no opinion about it.

> **Start with `PCC_IT_INSTALLATION_PACKET.md`** — one page covering what to provision, what to
> connect, and the ten answers we need before installation. **This document is the operations
> runbook**: start, stop, logs, update, backup, restore. The other two in this directory are
> `PCC_PRODUCTION_ARCHITECTURE.md` (what PCC is and why) and `PCC_GO_LIVE_PLAN.md` (the pilot
> phases, the rollback procedure, and the go-live gate).

---

## 1. The application

| | |
|---|---|
| What it is | A web application replacing the paper/phone purchase-request workflow: a field worker raises a material request, the workshop reviews stock and vendor, a purchase order is printed and emailed, the order is marked placed, and whoever takes the delivery signs for it. |
| Runtime | Node.js 24 (bundled in the image — nothing to install on the host) |
| Packaging | One OCI/Docker image, built from `Dockerfile` in the repository root |
| Process | A single Node process. No workers, no queue, no cron, no background jobs. |
| Listening port | `3000` inside the container, configurable with `PORT` |
| Health endpoint | `GET /api/health` — see §5 |
| Outbound network | **None required.** PCC does not send email, call APIs, or phone home. |
| Inbound network | HTTP from your reverse proxy only |
| CPU / memory | **2 vCPU, 4 GB RAM, 50 GB expandable disk** to start. PCC is small, but do not size it at the floor: attachment downloads are read into memory whole, and the disk is dominated by backup retention rather than by the database. Reasoning in `PCC_PRODUCTION_ARCHITECTURE.md` §8. |
| State | One SQLite file. See §2. |

PCC composes vendor emails as **drafts** and cannot send them — a database constraint pins
external sending off. A person reviews each draft and sends it from their own mailbox. There is
no SMTP configuration because there is nothing to configure.

---

## 2. Persistent storage

**This is the part that matters.** Everything in the container is disposable except one file.

| | |
|---|---|
| What | A single SQLite database, plus its write-ahead log (`-wal`) and index (`-shm`) |
| Where | The directory mounted at `/data` inside the container |
| File | `/data/pcc.sqlite`, set by `PCC_DATABASE_PATH` |
| Owner | uid **1000**, gid **1000** (the `node` user the process runs as) |
| Permissions | The directory must be writable by uid 1000. `chown -R 1000:1000 /var/lib/pcc` if you bind mount a host path. |
| Size | Megabytes. Attachments are stored inside the database, so allow a few hundred MB of headroom. |

Use a Docker named volume or a bind mount to a directory on a disk you back up. Either works.

**The application refuses to start rather than guess this.** If `PCC_DATABASE_PATH` is unset, is
relative, points into a directory that does not exist, or points at a file that does not exist on
anything but a first install, PCC logs the reason and exits non-zero. This is deliberate: the
alternative is a container that comes up healthy against an empty database while the real one sits
unmounted, and nobody notices until somebody asks where their purchase orders went.

---

## 3. Configuration

All configuration is environment variables, supplied at runtime. **Nothing is baked into the
image**, and the image contains no secrets, no database and no `.env` file — the build fails if it
does (`scripts/check-deployable.mjs`).

Copy `.env.example` to `.env` and fill it in. Full explanations live in that file; the required
ones are:

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `SESSION_SECRET` | yes | 32+ random characters, e.g. `openssl rand -base64 48`. Signs the session cookie. Changing it signs everybody out. **Treat as a secret.** |
| `PCC_DATABASE_PATH` | yes | `/data/pcc.sqlite` |
| `APP_BASE_URL` | yes | The address people type, e.g. `https://pcc.lippoliselectric.com` |
| `PCC_PO_NUMBERING` | yes | How purchase orders are numbered. **Lippolis: `job-vendor-sequence`** — job number, vendor code, then a count starting at 1 for each job-and-vendor pair (`1234-COOPER-1`). PCC refuses to start without it rather than inherit another company's numbering. |
| `PORT` | no | Default `3000` |
| `PCC_RELEASE` | recommended | Whatever identifies this build — a git commit, a tag, a build number. It is echoed by `/api/health` so you can tell which build is running without guessing from file dates. Unset shows as `null`. |
| `PCC_DATABASE_ALLOW_CREATE` | first install only | `1` on the very first start, then remove |
| `PCC_ORG_NAME` | first install only | Appears on the printed purchase order |
| `PCC_BOOTSTRAP_ADMIN_EMAIL` | first install only | The first administrator |
| `PCC_BOOTSTRAP_ADMIN_PASSWORD` | first install only | 12+ characters. Remove after the first start. |

Put `SESSION_SECRET` and the bootstrap password in whatever secret store you already use. If that
is a root-owned `.env` file with mode `600`, that is acceptable for this pilot — say so and we will
document it that way.

### First install, exactly

```bash
cp .env.example .env          # fill in SESSION_SECRET, APP_BASE_URL, PCC_PO_NUMBERING
# add, for this one start only:
#   PCC_DATABASE_ALLOW_CREATE=1
#   PCC_BOOTSTRAP_ADMIN_EMAIL=<the first administrator>
#   PCC_BOOTSTRAP_ADMIN_PASSWORD=<12+ characters, temporary>
docker compose up -d --build
docker compose logs pcc | grep '\[pcc\]'
```

You should see `creating a NEW purchasing database` and `created the bootstrap administrator`.
Then sign in, invite the real users, change that password, and **remove
`PCC_DATABASE_ALLOW_CREATE` and `PCC_BOOTSTRAP_ADMIN_PASSWORD` from the environment.**

If you see `creating a NEW purchasing database` on any later start, **stop** — the volume is not
mounted where PCC is looking.

There are no default accounts. A PCC installation with no bootstrap administrator configured comes
up with nobody able to sign in, and says so in the log.

---

## 4. Network

```
Browser  ──HTTPS──▶  your reverse proxy  ──HTTP──▶  PCC container :3000
                     (TLS terminated here)
```

* **PCC does not terminate TLS and does not redirect HTTP to HTTPS.** Your proxy does both.
* Publish the container port to `127.0.0.1` only (the supplied `docker-compose.yml` does), so the
  plain-HTTP port is not reachable from the network.
* Forward `X-Forwarded-Proto` and `Host` as usual. PCC marks its session cookies `Secure`,
  `HttpOnly` and `SameSite=Lax`, so it must be reached over HTTPS in production or sign-in will
  not stick.
* No WebSockets, no server-sent events, no long polling. A default proxy timeout is fine.
* Uploads are small (photos of packing slips). Allow ~25 MB request bodies.

**Access model — your call, and we would like your recommendation.** The realistic options:

| | Reach | Trade-off |
|---|---|---|
| VPN only | Staff on the company VPN | Safest. Foremen must have VPN on their phones to sign for deliveries. |
| Public hostname + TLS | Anyone with credentials | Simplest for the field. Relies on passwords; PCC throttles guessing (5 failures per address in 15 minutes) but has no MFA today. |
| Public + IP allow-list | Named networks | Awkward for phones on mobile data. |

The workflow this replaces is people standing in a yard with a phone, so field reachability is not
a nice-to-have. If VPN-on-phone is realistic for your foremen, that is the better answer.

---

## 5. Health and monitoring

There are **two** endpoints, and pointing the wrong tool at the wrong one causes real trouble:

| | Question | A failure means | Point this at it |
|---|---|---|---|
| `GET /api/health` | **Readiness.** Is it configured, migrated, and able to read its database? | Do not send it traffic. **Do not restart it** — it will answer 503 until the configuration is fixed. | Monitoring, and the proxy's drain decision |
| `GET /api/health/live` | **Liveness.** Is the process up? | The process is wedged; restarting is right. | A supervisor's restart policy |

A supervisor pointed at *readiness* turns a typo in `PCC_DATABASE_PATH` into a restart loop that
fills the log and fixes nothing. Monitoring pointed at *liveness* reports green while the instance
serves nothing. The liveness endpoint deliberately touches no configuration, database or disk.

`GET /api/health` — unauthenticated by design (a load balancer cannot sign in). It reports state
only: no paths, no credentials, no configuration values, no user data.

* **200** — configuration loaded and the database can be read.
* **503** — something is wrong; the JSON names which check failed and which variable is at fault.

```json
{ "status": "ok", "release": "1.4.0", "schema": "0038-po-number-per-job-vendor",
  "poNumbering": "job-vendor-sequence", "authProvider": "local", "persistence": "local",
  "checks": { "environment": {"ok": true}, "database": {"ok": true}, "migrations": {"ok": true} } }
```

`release` answers "which build is deployed", `schema` answers "are migrations current", and
`poNumbering` answers "which numbering rule is this installation running". None of them is a
secret and none is a path.

### 5a. The nine questions, and where each is answered

Everything below is answerable without the developer.

| Question | How |
|---|---|
| Is PCC running? | `curl -fsS http://127.0.0.1:3000/api/health/live` — 200 means the process is up |
| Is the database reachable? | `curl -fsS .../api/health` — `checks.database.ok` |
| Which build is deployed? | the `release` field of `/api/health` |
| Are migrations current? | `checks.migrations.ok`; the applied version is the `schema` field |
| Where are the logs? | `docker compose logs pcc`, or `journalctl -u pcc` for the systemd unit. Startup lines are prefixed `[pcc]` |
| How do I restart it? | §6 |
| What configuration is required? | §3, and `node scripts/pcc-preflight.mjs` checks the machine without changing it |
| Is the machine ready before I start? | `node scripts/pcc-preflight.mjs --data /data --port 3000` — read-only, changes nothing |

### 5b. If something is wrong

| Symptom | Look at this first |
|---|---|
| **It will not start** | `docker compose logs pcc \| grep '\[pcc\]'`. The last line says whether the database was opened. "Nothing has been written" means the problem is a variable in §3; "The database was opened but could not be used" means permissions or the volume |
| **Nobody can sign in** | Check the log for `no enabled sign-in credentials` (nobody has been created — set the two bootstrap variables and restart). If people exist but sign-in fails over plain HTTP, that is §4: session cookies are `Secure` and will not stick without HTTPS |
| **One person cannot sign in** | Their account may be deactivated — check Administration → Users. Five wrong passwords locks an account briefly; it clears on its own |
| **Generating a purchase order fails** | It needs a vendor with a code and a job. If the message mentions the sequence, the pair has paper history that has not been settled — Administration → PO numbering. If the message names `PCC_PO_NUMBERING`, the installation is misconfigured and would not have started |
| **The vendor email draft is missing or wrong** | PCC never sends email; it prepares a draft a person copies. There is no mail server, relay or credential involved, so this is never a network problem. Check the request's own page — the draft lives at `/requests/<id>/email` |
| **The printed PO is blank or unstyled** | The static assets did not get staged into the build. Rebuild — `npm run build` runs the staging step automatically — and check `docker compose logs` for 404s on `/_next/static` |
| **It was fine yesterday and is slow today** | Check free disk on the data volume. Each backup is a full copy and attachments live in the database; `/data/backups` fills before `pcc.sqlite` does |

Point your monitoring at it. A 503 means the instance should be drained, not restarted in a loop —
it will keep answering 503 until the configuration is fixed. The container also has a Docker
`HEALTHCHECK` against the same endpoint.

Logs go to stdout/stderr as plain lines and JSON events. Startup lines are prefixed `[pcc]`.

---

## 6. Operations

Assuming `docker compose` from the repository directory:

| Task | Command |
|---|---|
| Start | `docker compose up -d` |
| Stop | `docker compose stop pcc` |
| Restart | `docker compose restart pcc` |
| Logs (follow) | `docker compose logs -f pcc` |
| Startup diagnostics | `docker compose logs pcc \| grep '\[pcc\]'` |
| Health | `curl -fsS http://127.0.0.1:3000/api/health` |
| Update | see §7 |
| Backup | see §8 |
| Restore | see §8 |

### 6a. Keeping it running — process supervision

**PCC must not depend on somebody leaving a terminal open.** It has to come back after a VM
reboot, restart after a crash, and put its logs somewhere you can read them. Which mechanism
does that depends on the VM's operating system, **which we do not know yet — see question #1.**
Both supported answers are ready:

| Situation | Use | Ships as |
|---|---|---|
| Linux **with** Docker/Podman | Compose's `restart: unless-stopped` for crashes, plus a systemd unit so the project starts at boot | `deploy/pcc-docker.service` |
| Linux **without** a container runtime | systemd running the Node process directly | `deploy/pcc-node.service` |
| Windows Server | **Open — tell us and we will finish it.** Either Docker Desktop / Windows containers with the compose file above, or the Node process wrapped as a service with NSSM or `sc.exe`. The application itself is portable; nothing in it assumes Linux. |

Each unit file's header lists its prerequisites and the exact commands. Both are written to
**restart on a crash but NOT on a refusal**: the startup preflight exits non-zero on purpose when
production configuration is wrong, and looping on that would bury the one log line that explains
it. `deploy/pcc-node.service` encodes this as `RestartPreventExitStatus=1`.

Whichever is chosen: **test it by rebooting the VM once, before the pilot**, and confirm PCC comes
back on its own. It is on the pilot checklist for that reason.

---

## 7. Updating

The full procedure, in order. Steps 1 and 6 are the ones people skip and the ones that matter.

```bash
# 1. BACK UP FIRST. Thirty seconds, and it is the only thing that makes step 7 possible.
node scripts/pcc-backup.mjs

# 2. Take the approved revision — never an arbitrary tip of main.
git fetch && git checkout <approved tag or commit>

# 3. Build. Dependencies install from the lockfile; asset staging runs automatically.
docker compose build            # or: npm ci && npm run build --workspace purchasing

# 4. Migrate — there is no separate command. Schema changes apply on start, idempotently.

# 5. Restart.
docker compose up -d

# 6. Verify, before telling anybody it is done.
curl -fsS http://127.0.0.1:3000/api/health     # status ok, and `release` is the build you deployed
docker compose logs pcc | grep '\[pcc\]'      # must say "opening the existing purchasing database"

# 7. Smoke test: sign in, raise a request, approve it, print the PO. Five minutes.
```

If step 6 says `creating a NEW purchasing database`, **stop and do not let anyone use it** — the
volume is not mounted and the records are still on disk where the old container left them.

**Rollback is manual, and it is honest to say so.** There is no automated rollback and no
blue/green: you redeploy the previous image or commit against the same volume, exactly as above.
That is safe for a code-only change. Across a schema change it may not be — an older build does not
know a newer database — which is why step 1 is a backup and why the restore procedure in §8 is the
real rollback plan for that case.

**Code updates never touch the database.** The image contains no database; the volume is not
rebuilt; the container is replaced and the new one opens the same file. Schema changes are applied
on start and are written to be idempotent, so starting a new version against an existing database
changes structure, never records. This is tested: `scripts/eval-deployment.mjs` writes purchasing
data, the image is rebuilt from scratch and the container destroyed and recreated, and the same
data is verified through the web interface afterwards.

Rollback is covered above: manual, previous revision, same volume, backup first.

---

## 7a. Verifying the database before a pilot

`check-deployable.mjs` (§7) asks whether the image is safe to ship. The other half is whether the
DATABASE it opens is the company's own rather than somebody's demonstration:

```bash
docker run --rm -v pcc-data:/data -v /path/to/repo/scripts:/scripts:ro \
  node:24-bookworm-slim \
  node /scripts/pcc-verify-production.mjs --db /data/pcc.sqlite --strict
```

It reports demonstration accounts (the pilot seed's `@example.invalid` cast, whose password is
published), seeded vendors and jobs, an unset purchase order sequence, a missing workshop
location, and whether anybody can sign in at all. Exit 0 means fit for real work.

Every mechanism that keeps demo data out of production is a rule about how the database was
CREATED. None of them help if a database made on a laptop is copied to the server, which is
exactly what happens at five o'clock on the day of a pilot. This looks at the rows.

## 8. Backup and restore

PCC does not implement backup scheduling, retention, encryption or offsite copies. It gives you one
command that produces one good file; point your existing backup system at the output directory.

**Do not simply copy `pcc.sqlite`.** The database runs in WAL mode: at any moment most recent
transactions live in the `-wal` file, not the main one. On the test system the main file was 4 KB
while the log was 1.6 MB — a naive copy would have captured an almost empty database and looked
like it worked.

### Backup (safe while PCC is running)

```bash
docker run --rm \
  -v pcc-data:/data \
  -v /path/to/repo/scripts:/scripts:ro \
  --user 1000:1000 \
  node:24-bookworm-slim \
  node /scripts/pcc-backup.mjs --db /data/pcc.sqlite --out /data/backups --keep 30
```

Uses SQLite's online backup, so the application keeps serving. The output is a single
timestamped, already-checkpointed `.sqlite` file, and the script **verifies what it wrote**
(integrity check plus row counts) and exits non-zero if it is not usable. `--keep N` prunes older
backups; omit it to keep everything.

Run it from cron or your scheduler — nightly is sensible for this volume of work — and copy
`/data/backups` offsite with whatever you already use.

### Restore (PCC must be stopped)

```bash
docker compose stop pcc
docker run --rm -v pcc-data:/data -v /path/to/repo/scripts:/scripts:ro \
  node:24-bookworm-slim \
  node /scripts/pcc-restore.mjs --from /data/backups/pcc-<timestamp>.sqlite --db /data/pcc.sqlite --force
docker compose start pcc
curl -fsS http://127.0.0.1:3000/api/health
```

Restoring is destructive — everything entered since the backup is lost — so the script is built to
be hard to run by accident:

* it verifies the backup **before** touching the live database;
* it refuses to run if anything is still answering on the application URL;
* it refuses without `--force` when a live database exists;
* it moves the replaced database aside as `pcc.sqlite.replaced-<timestamp>` and tells you where,
  so a mistaken restore is itself recoverable;
* it restores the original file's ownership, so the application can still write to it.

Delete the `.replaced-*` file once you are satisfied.

### The restore test — do this before the pilot, then twice a year

**A backup nobody has restored is a hypothesis.** This rehearses the real thing without touching
the live system, and takes about ten minutes.

> **It has been done, automatically, and it passes.** `bash scripts/restore-rehearsal.sh` performs
> the whole drill unattended: it builds the image, stands up a source instance and fills it with a
> real purchasing system (two users, vendor, job, a request with an attachment, an approved PO, a
> received delivery with a packing slip), takes a backup while that instance keeps serving,
> restores into a throwaway volume, starts a second instance against the restored data, and
> verifies **23 facts** through the web interface — including downloading both attachments and
> comparing them byte for byte, confirming the second user can still sign in and is still refused
> administration, and checking the PO sequence was not rewound. It then proves the source instance
> was never touched, and removes everything it made.
>
> Run it on the VM after installation, so the result describes *that* machine. The manual steps
> below are the same drill for an operator who wants to watch it happen.

```bash
# 1. Take a backup, and note what is in the system right now.
docker run --rm -v pcc-data:/data -v /path/to/repo/scripts:/scripts:ro --user 1000:1000 \
  node:24-bookworm-slim node /scripts/pcc-backup.mjs --db /data/pcc.sqlite --out /data/backups
#    In PCC: note the most recent purchase order number and who raised it.

# 2. Restore that backup into a THROWAWAY volume — never the live one.
docker volume create pcc-restore-test
docker run --rm -v pcc-data:/src:ro -v pcc-restore-test:/data \
  node:24-bookworm-slim sh -c 'cp /src/backups/$(ls -t /src/backups | head -1) /data/pcc.sqlite'

# 3. Verify the restored database is fit for work — not merely present.
docker run --rm -v pcc-restore-test:/data -v /path/to/repo/scripts:/scripts:ro \
  node:24-bookworm-slim node /scripts/pcc-verify-production.mjs --db /data/pcc.sqlite --strict

# 4. Start a SECOND PCC against it, on another port, and look at it.
docker run --rm -p 127.0.0.1:3001:3000 -v pcc-restore-test:/data \
  --env-file .env -e APP_BASE_URL=http://127.0.0.1:3001 pcc:local
curl -fsS http://127.0.0.1:3001/api/health      # expect "status":"ok"
#    Sign in. Find the purchase order from step 1. Open its PDF. Open an
#    attachment. If any of those is missing, the backup is not a backup.

# 5. Tear down.
docker volume rm pcc-restore-test
```

**Record the date it was last done and who did it.** A restore procedure nobody has run in a year
is the same hypothesis with more confidence attached.

---

## 9. Domain

Example target: `pcc.lippoliselectric.com`

DNS, certificates and renewal are infrastructure, not application configuration. PCC needs to be
told its own address once, via `APP_BASE_URL`, because password-reset links have to point
somewhere. Nothing else in the application knows or cares what the hostname is.

---

## 10. Security notes

* Sessions are signed cookies: `HttpOnly`, `SameSite=Lax`, `Secure` in production. Default lifetime
  12 hours (`SESSION_TTL_SECONDS`).
* Passwords are stored salted and hashed (scrypt). PCC never logs a password and masks email
  addresses in its logs.
* Sign-in is rate limited: 5 failures per address per 15 minutes, 30 per source. **The counters
  live in the server process**, so this is a real limit for a single container and a weaker one if
  you ever run several. A shared-store version exists in the schema and is not yet wired; tell us if
  you plan to run more than one instance.
* The container runs as a non-root user (uid 1000).
* There is no MFA and no SSO today. See §12.

---

## 11. What we need from you

Please answer these — they are what the next decisions depend on.

| # | Question | Why it matters |
|---|---|---|
| 1 | **Server OS and environment** — which host, which distribution, physical/VM/cloud? | Determines whether the container approach fits at all |
| 2 | **Is Docker (or Podman) available?** If not, what is the supported way to run a long-lived service? | Everything in §6 assumes a container runtime |
| 3 | **Hostname / IP** for the server | Needed for `APP_BASE_URL` and the proxy configuration |
| 4 | **Public or VPN-only?** See §4 | Decides whether foremen can sign for deliveries from a job site |
| 5 | **Who controls DNS** for `lippoliselectric.com`, and can a subdomain be added? | Needed before any hostname works |
| 6 | **What terminates TLS** — nginx, Caddy, Traefik, IIS, a hardware appliance? Who issues certificates? | PCC does not do TLS |
| 7 | **What backup system exists**, and can it collect a directory on this server? How often, retained how long, stored where? | §8 produces files for it; retention is yours |
| 8 | **What monitoring exists** that can poll an HTTP endpoint and alert somebody? | `/api/health` is ready for it |
| 9 | **Is there a company database server** (SQL Server, PostgreSQL, MySQL) that PCC should eventually use instead of SQLite? Version and access model? | The repository layer already supports swapping; we would rather know now than migrate twice |
| 10 | **Microsoft 365 / Entra ID** — is there a tenant, and would you want staff signing in with their work accounts? | Would replace PCC's own passwords, and add MFA |
| 11 | **Outbound email policy** — if PCC ever needs to send (it does not today), is there a relay or a policy against it? | Affects whether vendor email stays draft-only |
| 12 | **Who holds the operational owner ROLE** — who restarts it at 7am if it is down? Name the role and its current holder, not just a person: this hands over | Determines how much of §6 needs to be written down for somebody else |

---

## 11a. Who owns what

Stated as roles. People change; the responsibilities do not.

| Responsibility | Role | Notes |
|---|---|---|
| Application code, migrations, releases, this document | **Application developer (AWE)** | Supplies the build and the upgrade procedure |
| Server, OS patching, storage, network, TLS, DNS, firewall | **Lippolis IT infrastructure owner** | Currently the contact is Jose; the role outlives the individual |
| `SESSION_SECRET` and every other production secret | **Lippolis IT infrastructure owner** | Generated by them, stored in their secret store. AWE never holds them |
| Starting, stopping, restarting, watching health | **Operational owner** | May be the same person as above. §6 is written so it need not be |
| Backups running, retained and *tested* | **Lippolis IT infrastructure owner** | §8. AWE supplies the commands; retention and offsite are IT's policy |
| Deciding who may approve, order and receive | **Purchasing owner (the business)** | Administration screens, no IT involvement |
| Vendors, jobs, users, and the paper PO sequences | **Purchasing owner (the business)** | Entered in the application |
| Deciding the numbering rule (`PCC_PO_NUMBERING`) | **Purchasing owner**, implemented by **AWE** | Lippolis: `job-vendor-sequence`, established with Mike and Paul |

---

## 12. Deliberately not decided

These are open on purpose, pending this conversation:

* **Hosting provider.** Nothing in the application assumes one.
* **Database engine.** SQLite for the pilot; the repository abstraction exists so PostgreSQL or a
  company server can replace it without touching business logic.
* **Identity.** PCC's own passwords today. Microsoft/Entra SSO is a provider swap, not a rewrite,
  and needs your tenant details before it can be scoped.
* **Multiple instances.** PCC is written to run as one process against one database. Running
  several needs the shared sign-in throttle wired and a database that supports concurrent writers.

---

## 13. Known limitations, stated plainly

* **One instance only.** Two containers against one SQLite file is not supported.
* **The sign-in throttle is per process** (§10).
* **Attachments live in the database**, which keeps backup to a single file and will not scale to
  years of photographs. Fine for the pilot; revisit when the file passes a few hundred MB. Note
  that this is what makes backup retention, not the records themselves, the thing that fills the
  disk — each nightly backup is a full copy. Watch `/data/backups`, not `pcc.sqlite`.
* **No MFA, no SSO** today.
* **Purchase order numbers count per job and vendor** (`1234-COOPER-1`), starting at 1 for each
  pair, so a fresh installation needs no numbering setup. The exception: a job and vendor the
  office already wrote paper purchase orders for must be set in Administration → PO numbering
  before the first live order on that job, or PCC issues a number the supplier already holds.
  `scripts/pcc-verify-production.mjs` lists every pair about to issue its first number.
