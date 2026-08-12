# PCC — deployment handoff for IT

**Purchasing Control Center (PCC)** for Lippolis Electric. This document is for the person who
will run it on a company server. It states what the application needs, what it does not care
about, and what we still need from you.

Nothing here prescribes a hosting provider. PCC is an ordinary Linux container that listens on a
port; where that container runs is your decision, and the application has no opinion about it.

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
| CPU / memory | Small. Two users and a few hundred purchase orders a year; 1 vCPU and 512 MB is ample. |
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
| Permissions | The directory must be writable by uid 1000. `chown -R 1000:1000 /srv/pcc/data` if you bind mount a host path. |
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
| `PORT` | no | Default `3000` |
| `PCC_DATABASE_ALLOW_CREATE` | first install only | `1` on the very first start, then remove |
| `PCC_ORG_NAME` | first install only | Appears on the printed purchase order |
| `PCC_BOOTSTRAP_ADMIN_EMAIL` | first install only | The first administrator |
| `PCC_BOOTSTRAP_ADMIN_PASSWORD` | first install only | 12+ characters. Remove after the first start. |

Put `SESSION_SECRET` and the bootstrap password in whatever secret store you already use. If that
is a root-owned `.env` file with mode `600`, that is acceptable for this pilot — say so and we will
document it that way.

### First install, exactly

```bash
cp .env.example .env          # fill in SESSION_SECRET, APP_BASE_URL
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

`GET /api/health` — unauthenticated by design (a load balancer cannot sign in). It reports state
only: no paths, no credentials, no configuration values, no user data.

* **200** — configuration loaded and the database can be read.
* **503** — something is wrong; the JSON names which check failed and which variable is at fault.

```json
{ "status": "ok", "authProvider": "local", "persistence": "local",
  "checks": { "environment": {"ok": true}, "database": {"ok": true}, "migrations": {"ok": true} } }
```

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

---

## 7. Updating

```bash
git pull                      # or take the new image
docker compose up -d --build
```

**Code updates never touch the database.** The image contains no database; the volume is not
rebuilt; the container is replaced and the new one opens the same file. Schema changes are applied
on start and are written to be idempotent, so starting a new version against an existing database
changes structure, never records. This is tested: `scripts/eval-deployment.mjs` writes purchasing
data, the image is rebuilt from scratch and the container destroyed and recreated, and the same
data is verified through the web interface afterwards.

**Roll back** by deploying the previous image against the same volume. Take a backup first (§8) —
a rollback across a schema change is the one case where the older code may not understand the
newer database.

---

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

Delete the `.replaced-*` file once you are satisfied. **Test a restore before you rely on one** — a
backup nobody has restored is a hypothesis.

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
| 12 | **Who is the operational owner** — who restarts it at 7am if it is down? | Determines how much of §6 needs to be written down for somebody else |

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
  years of photographs. Fine for the pilot; revisit when the file passes a few hundred MB.
* **No MFA, no SSO** today.
* **The PO sequence starts at a placeholder.** An administrator must set the office's real next
  purchase order number in Administration → Organization before the first live order. The screen
  warns that the sequence can only move forward.
