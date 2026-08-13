# PCC — production handoff for Lippolis IT

**For Jose.** Everything needed to install, run, back up and update the Purchasing
Control Center on a Lippolis server, without the developer's laptop being involved.

The step-by-step install lives in **`PCC_VM_INSTALLATION_RUNBOOK.md`**. This document is
the reference beside it: what PCC is, what it needs, and what only you can supply.

---

## 1. System overview

PCC replaces a paper purchasing process. A foreman asks for material, the workshop
checks the shelf and chooses a supplier, PCC issues a numbered purchase order, and that
purchase order is printed, emailed to the vendor and filed with the receipt.

**One process, one file.**

| Component | What it is |
|---|---|
| Application | A Node.js server (Next.js). One process. Serves HTML — no separate front end. |
| Database | **SQLite**, a single file on disk. No database server to install or run. |
| Attachments | Stored **inside** that same file. One file is the whole backup. |
| Email | PCC **cannot send email.** It composes drafts; a person sends them from their own mailbox. There is no SMTP configuration because there is no transport. |
| Outbound network | None. PCC makes no outbound connections. It only listens. |

That is the entire runtime. There is no message queue, no cache, no worker, no second
service.

---

## 2. Infrastructure requirements

**Node.js 24 or later — not negotiable, and not "20 or later".** The database driver is
`node:sqlite`, which is part of the Node runtime itself. On Node 20 the application
fails at startup with a module-not-found error that names nothing actionable.

| Resource | Guidance | Confidence |
|---|---|---|
| CPU | 2 vCPU | Comfortable. Not measured under load — the pilot is a handful of users. |
| RAM | 2 GB | The process itself is small; this is headroom, not a measurement. |
| Disk | 20 GB | The database is well under 1 MB today. **Attachments and nightly backups are what grow**, not the records. |
| OS | Linux preferred, Windows Server supported | See §8. |

**Be aware of the disk shape.** Every backup is a *full copy* of the database, and
photographs of deliveries live inside it. Watch the backup directory, not the database
file. If attachments pass a few hundred MB, move them to object storage — that is a
configuration change (`STORAGE_DRIVER`), not a rewrite.

---

## 3. Network

| Item | Value |
|---|---|
| Listens on | `HOSTNAME` (default `0.0.0.0`), port `PORT` (default `3000`) |
| Protocol | Plain HTTP |
| Outbound | None |
| Exposure | **Internal only.** PCC is not intended to face the internet. |

**PCC does not terminate TLS.** Put a reverse proxy in front of it (nginx, Caddy, IIS —
whatever Lippolis already runs) and let that hold the certificate.

**HTTPS is not optional in practice.** Session cookies are marked `Secure`, so over plain
`http://` they are set and never sent back — sign-in appears to succeed and then bounces
the user straight back to the sign-in page. If you must run without TLS for a first
smoke test, use `http://` in `APP_BASE_URL` and expect that behaviour; do not report it
as a bug.

Firewall: allow the proxy to reach PCC's port. Nothing else needs to.

### DNS / hostname — your decision

Pick the internal hostname (for example `pcc.lippolis.local`), then:

1. Point it at the VM.
2. Issue or install a certificate for it on the reverse proxy.
3. Set `APP_BASE_URL` to exactly that address, including `https://`.

`APP_BASE_URL` is not cosmetic: it is the address password-reset links are built from,
and the origin session cookies are scoped against. **PCC now refuses to start in
production if it is not set** — that is deliberate, because the old default was
`http://localhost:3000`, which works on a developer's machine and nowhere else.

---

## 4. Environment variables

The authoritative list with descriptions is **`.env.example`** — it is committed, it
contains no secrets, and it says who supplies each value.

**Required.** PCC refuses to start without these:

| Variable | Who supplies it | Notes |
|---|---|---|
| `NODE_ENV=production` | — | |
| `SESSION_SECRET` | Jack generates, you store | ≥32 chars. `openssl rand -hex 32`. Rotating it signs everybody out; nothing else. |
| `PCC_DATABASE_PATH` | Agreed with you | Absolute path, on the volume you back up. |
| `APP_BASE_URL` | **You** | The hostname above, with scheme. |

**Optional.** Sensible defaults:

| Variable | Default |
|---|---|
| `PORT` | `3000` |
| `HOSTNAME` | `0.0.0.0` |
| `SESSION_TTL_SECONDS` | 12 hours |
| `STORAGE_DRIVER` | `inline` |

**Set before the first real order** — all three print on the sheet that goes to a
supplier: `PCC_ORG_NAME`, `PCC_ORG_PHONE`, `PCC_ORG_ADDRESS`.

**First start only, then delete from the environment:**
`PCC_DATABASE_ALLOW_CREATE`, `PCC_BOOTSTRAP_ADMIN_EMAIL`, `PCC_BOOTSTRAP_ADMIN_PASSWORD`.

`PCC_DATABASE_ALLOW_CREATE` deserves a sentence. It authorizes creating a database that
does not exist. Left set, it is not destructive — but it removes the check that catches
**an unmounted volume**, which is the failure it exists for: without it, a missing mount
produces a new empty database instead of a refusal to start.

**Secrets never go in the repository.** `.env` is gitignored. On Linux, `/etc/pcc.env`
should be `root:pcc` mode `640` — the service reads it, nobody else does.

---

## 5. Database

**Provisioning:** none. The file is created on first start when
`PCC_DATABASE_ALLOW_CREATE=1`.

**Migrations:** applied automatically at startup, in order, every time. **There is no
separate migration command and no migration step for you to run.** Migrations are
idempotent; starting twice changes nothing.

**Persistence:** the file at `PCC_DATABASE_PATH`. Put it on a volume that survives the
VM and that your backup system already visits. Nothing else on disk is state — the
application directory can be deleted and reinstalled at any time.

**Verified in this session:** a clean database, a full purchase through to received, a
process restart, and the data intact afterwards with no new database created.

---

## 6. Deployment

```bash
# 1. Dependencies, from the lockfile
npm ci --workspaces --include-workspace-root

# 2. Production build (this also stages static assets into the standalone output —
#    without that step the application runs and serves no CSS)
npm run build --workspace purchasing

# 3. Refuse to ship a database or build artefacts that do not belong on a server
node scripts/check-deployable.mjs

# 4. Read-only readiness check: disk, port, config, database path
node scripts/pcc-preflight.mjs --data /var/lib/pcc --port 3000

# 5. Start
node apps/purchasing/.next/standalone/apps/purchasing/server.js
```

Step 5 is what the service unit runs. Nothing here needs the developer's machine, and
**Claude Code is not involved in any of it.**

Docker is supported and is packaging, not a dependency: `docker compose up -d --build`
using the committed `Dockerfile` and `docker-compose.yml`.

---

## 7. Persistent service

**PCC must not depend on a terminal window.** Two units are provided, both with restart
policies. Choose one:

| File | Use when |
|---|---|
| `deploy/pcc-node.service` | Linux, no container runtime. PCC as a plain Node process. |
| `deploy/pcc-docker.service` | Linux with Docker. |

Both set `Restart=on-failure` with `RestartPreventExitStatus=1`. That distinction is
deliberate: a **crash** is restarted; a **refusal to start** because the configuration is
wrong is not, because restarting that is a loop that fills the journal and fixes nothing.
The unit stops, `systemctl status pcc` shows it failed, and the reason is the last line
in the journal.

```bash
sudo cp deploy/pcc-node.service /etc/systemd/system/pcc.service
sudo systemctl daemon-reload && sudo systemctl enable --now pcc
```

`enable` is what makes it come back after a reboot.

**If you choose Windows Server**, the equivalent is a service wrapper (NSSM or
`sc.exe`) pointing at the same `node …/server.js` command with the same environment, set
to *Automatic* start and *Restart on failure*. The application does not care; nothing in
it is Linux-specific.

---

## 8. Health check

```bash
curl -fsS http://127.0.0.1:3000/api/health      # is it working?
curl -fsS http://127.0.0.1:3000/api/health/live # is the process alive?
```

`/api/health` returns `status: "ok"` or `"degraded"`, and reports whether configuration,
the database and migrations are each in order. It **names a variable that is wrong
without printing its value**. Point your monitoring at it.

`/api/health/live` answers as long as the process is up. Use it for restart supervision;
use `/api/health` for "is it actually usable".

**A green health check is necessary, not sufficient.** During this session the
application answered `200` while serving no stylesheets at all. If PCC looks wrong,
check the page, not only the endpoint.

---

## 9. Logs

JSON lines to stdout and stderr. The service collects them.

```bash
journalctl -u pcc -f                  # follow
journalctl -u pcc | grep '\[pcc\]'    # startup diagnostics and decisions
docker compose logs -f                # Docker instead
```

Startup prints which database it opened, whether it created one, which providers are
bound, and any configuration problem — by name, never by value. Fields that could carry
secrets are redacted and email addresses are masked.

---

## 10. Update procedure

```bash
node scripts/pcc-backup.mjs                     # 1. back up first, always
git pull                                        # 2. take the new version
npm ci --workspaces --include-workspace-root    # 3.
npm run build --workspace purchasing            # 4.
node scripts/check-deployable.mjs               # 5.
sudo rsync -a --delete apps/purchasing/.next/standalone/ /opt/pcc/   # 6.
sudo systemctl restart pcc                      # 7.
curl -fsS http://127.0.0.1:3000/api/health      # 8. confirm
journalctl -u pcc -n 30                         # 9. read the startup lines
```

Migrations apply on start. Repeat deployment is safe and is tested
(`scripts/eval-idempotence.sh`).

## 11. Rollback

The database is the thing that matters; the application directory is disposable.

1. `sudo systemctl stop pcc`
2. Restore the previous application files (previous `git` tag, or a kept copy of `/opt/pcc`).
3. **Only if the new version changed the schema**, restore the database backup taken in
   step 1 of the update: `node scripts/pcc-restore.mjs --from <backup> --db <path>`
4. `sudo systemctl start pcc`, then check health.

Migrations move forward only. Rolling the *application* back over a database that a
newer version has already migrated is not supported — restore the database with it.

---

## 12. Backup and restore

**What is backed up:** everything. One SQLite file holds the records, the history and
the attachments.

```bash
# Back up — safe while PCC is running, and verifies what it wrote
node scripts/pcc-backup.mjs --db /var/lib/pcc/pcc.sqlite --out /var/lib/pcc/backups

# Restore
node scripts/pcc-restore.mjs --from /var/lib/pcc/backups/pcc-<stamp>.sqlite \
                             --db /var/lib/pcc/pcc.sqlite
```

`pcc-backup.mjs` uses SQLite's online backup, so it does not need the application
stopped, and it re-opens what it wrote to confirm the file is readable and counts what is
in it. A backup that cannot be read is not a backup.

**Where:** `/var/lib/pcc/backups` on the volume, and then wherever Lippolis already sends
backups. A backup that only exists on the machine it protects is not a backup either.

**Retention:** nightly, keep 30 days. Purchasing history is small; the constraint is disk
from attachments, not records.

**Restoration is tested.** In this session the live database was deleted outright,
restored from backup, and the application served the same purchase order with the same
quantities afterwards. Re-run that test on the VM once, after install, so you have done
it before you need it.

**Validate a restore:**
```bash
node scripts/pcc-verify-production.mjs --db /var/lib/pcc/pcc.sqlite
curl -fsS http://127.0.0.1:3000/api/health
```

---

## 13. Security notes

- **Secrets** live in `/etc/pcc.env`, mode `640`, `root:pcc`. Never in the repository.
- **TLS** is the reverse proxy's job. Session cookies require it.
- **Least privilege:** run as a dedicated `pcc` service account that owns nothing else.
  The unit already restricts the process to writing exactly one directory.
- **No outbound access needed.** PCC cannot send email and calls nothing.
- **The bootstrap admin password** is a first-start credential. Change it and remove it
  from the environment once the real users exist.
- **No demonstration accounts in production.** `pcc-verify-production.mjs` fails if any
  `@example.invalid` account can still sign in.

---

## 14. Developer dependencies — there are none

**Claude Code is not a runtime dependency. Neither is the developer's Mac.**

PCC is a Node process, a file, and a systemd unit. Everything needed to build, start,
back up, restore, verify and update it is in this repository and runs on the server.
Nothing phones home; nothing is fetched at runtime.

---

## 15. What only you can supply

| # | Item | Why it cannot come from the repository |
|---|---|---|
| 1 | **VM and OS**, with Node 24 | Windows or Linux changes the service mechanism, nothing else |
| 2 | **Internal hostname / DNS record** | A Lippolis naming decision |
| 3 | **TLS certificate and reverse proxy** | Lippolis PKI and existing proxy |
| 4 | **Persistent volume path**, on backed-up storage | Your storage layout |
| 5 | **`SESSION_SECRET`**, stored safely | Generated once; where it is kept is your policy |
| 6 | **Backup destination and schedule** | Your existing backup system |
| 7 | **Who restarts it**, and monitoring target | An operational owner |
| 8 | **Workstation access** — the office machines that reach the hostname, and the workshop printer they print to | Lippolis network and print estate |

Everything else is settled in the repository.
