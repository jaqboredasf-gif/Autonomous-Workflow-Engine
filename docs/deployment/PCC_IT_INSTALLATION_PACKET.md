# PCC — installation packet for Lippolis IT

**For Jose.** Everything IT needs to provision and connect the Purchasing Control Center, on one
page, plus the ten answers we need before installation can start.

This is the front door. The full operations runbook — start, stop, logs, update, backup, restore —
is `PCC_IT_DEPLOYMENT_HANDOFF.md`, and nothing here contradicts it.

> **The branch to clone is `pcc-production`.** The repository's default branch does not contain
> PCC. See `SOURCE_OF_TRUTH.md` at the repository root.


**What PCC is:** an internal web application replacing the paper purchase-request workflow. One
Linux container, one port, one data directory. No outbound network, no email sending, no
background jobs, no external services.

---

## 1. What we are asking for

| | Recommended | Why this and not more |
|---|---|---|
| **vCPU** | **2** | One Node process against a single-writer database. The second core covers PDF rendering and the build; more cores do not make PCC faster, because the store serializes writes. |
| **RAM** | **4 GB** | The process idles in the hundreds of MB. Headroom is for attachment downloads, which are read into memory whole (6 files × 5 MB each, per concurrent download). |
| **Disk** | **50 GB SSD, expandable** | The database itself is small. **The backup directory is what grows** — each backup is a full copy, so retention multiplies the database size rather than adding to it. Expandable matters more than the starting figure. |

We are aware the VM can offer far more. **PCC should not be given it.** Two purchasers and a few
hundred purchase orders a year do not need it, and an application sized far beyond its workload
hides the point at which it genuinely needs to change.

---

## 2. Persistent storage — the part that matters

**Everything in the container is disposable except one directory.**

| | |
|---|---|
| **Must survive restart, redeploy and image rebuild** | the directory mounted at **`/data`** |
| What is in it | `pcc.sqlite` (the company's purchasing records), its `-wal` and `-shm` journal files, and `backups/` |
| Owner | uid **1000**, gid **1000** — `chown -R 1000:1000 <path>` if you bind-mount a host directory |
| Size | Megabytes of records; attachments are stored inside the database, so allow headroom |

A Docker named volume or a bind mount to a backed-up disk both work. **Nothing else needs to
persist** — the image contains no data and is rebuilt from source.

If the volume is missing or misconfigured, PCC **refuses to start** and says why, rather than
quietly creating an empty purchasing system beside the real one.

---

## 3. Port and health

| | |
|---|---|
| **Listening port** | `3000` inside the container, set by the `PORT` environment variable |
| **Publish it to** | `127.0.0.1` only — PCC serves plain HTTP and must sit behind your proxy |
| **Readiness** | `GET /api/health` → `200` with `{"status":"ok", ...}`. `503` means *do not send traffic and do not restart* — it stays 503 until configuration is fixed. Point **monitoring** here. |
| **Liveness** | `GET /api/health/live` → `200` `{"status":"alive"}`. A failure means the process is wedged and restarting is correct. Point a **supervisor's restart policy** here. |

Both are unauthenticated by design (a load balancer cannot sign in) and report state only — no
paths, no configuration values, no credentials, no user data.

**Do not point a restart policy at readiness.** A typo in a configuration variable would become a
restart loop that fills the log and fixes nothing.

---

## 4. Environment configuration

Supplied at runtime; **nothing is baked into the image**, and the build fails if a secret or a
database file ends up inside it. Full explanations are in `.env.example`.

**Variable names only — no values appear in this document or in the repository.**

*Required:* `NODE_ENV`, `SESSION_SECRET`, `PCC_DATABASE_PATH`, `APP_BASE_URL`

*Optional:* `PORT`, `HOSTNAME`, `SESSION_TTL_SECONDS`, `PCC_ORG_NAME`, `PCC_ORG_PHONE`,
`PCC_ORG_ADDRESS`

*First install only, then removed:* `PCC_DATABASE_ALLOW_CREATE`, `PCC_BOOTSTRAP_ADMIN_EMAIL`,
`PCC_BOOTSTRAP_ADMIN_PASSWORD`

`SESSION_SECRET` signs the session cookie and belongs in whatever secret store you already use; a
root-owned `.env` file with mode `600` is acceptable for this pilot if that is what exists. The
bootstrap password must be removed from the environment after the first start.

**There are no default accounts.** A PCC installation with no bootstrap administrator configured
comes up with nobody able to sign in, and says so in the log.

---

## 5. Startup and supervision

**PCC must not depend on somebody leaving a terminal open.** Which mechanism does that depends on
the VM's operating system, which is question 1 below. Both supported paths are ready:

| Situation | Use | Ships as |
|---|---|---|
| Linux **with** Docker/Podman | Compose `restart: unless-stopped` for crashes, plus a systemd unit so it starts at boot | `deploy/pcc-docker.service` |
| Linux **without** a container runtime | systemd running the Node process directly (Node 24 required on the host) | `deploy/pcc-node.service` |
| Windows Server | **Open — tell us.** Either containers with the compose file, or the Node process wrapped as a service with NSSM or `sc.exe`. Nothing in the application assumes Linux. |

**After a reboot PCC must come back on its own.** Both units are installed with
`systemctl enable`, and both are written to **restart on a crash but not on a deliberate
configuration refusal** — a supervisor that loops on a bad configuration buries the one log line
explaining it.

**Test this once by actually rebooting the VM.**

---

## 6. Backups — what IT must protect

| What | Why |
|---|---|
| **`/data/pcc.sqlite`** — via the supplied backup command, **not** a file copy | The database runs in WAL mode: at any moment recent transactions live in the `-wal` file. A naive copy can capture an almost-empty database and look like it worked. |
| **`/data/backups/`** — the output directory | This is what your backup system should collect and take offsite |

`scripts/pcc-backup.mjs` produces **one timestamped, already-checkpointed file** and verifies what
it wrote (integrity check plus row counts), exiting non-zero if it is not usable. Run it from cron
or your scheduler — nightly is sensible at this volume.

**PCC does not implement scheduling, retention, encryption or offsite copies.** Those are yours.
Ours is producing one good file and documenting restore.

**The restore procedure has been rehearsed end to end** — backup taken from a running instance,
restored into a clean environment, application started against it, and every record, user,
permission and attachment verified through the web interface. See `PCC_IT_DEPLOYMENT_HANDOFF.md`
§8, and `scripts/restore-rehearsal.sh` for the automated version.

---

## 7. Network, HTTPS and remote access

```
Browser  ──HTTPS──▶  your reverse proxy  ──HTTP──▶  PCC container :3000
                     (TLS terminated here)
```

**What PCC needs from the proxy:**

* **TLS terminated in front.** PCC does not serve HTTPS and does not redirect HTTP to HTTPS.
* Forward **`Host`** and **`X-Forwarded-Proto`** as usual.
* PCC marks its session cookies `Secure`, `HttpOnly`, `SameSite=Lax` — **it must be reached over
  HTTPS in production or sign-in will not stick.**
* Allow request bodies of about **25 MB** (photographs of packing slips).
* **No WebSockets, no server-sent events, no long polling.** Default proxy timeouts are fine.

**How authorized users reach it off-network is IT's decision, not PCC's.** VPN, reverse proxy,
Zero Trust gateway — the application works correctly behind any HTTPS endpoint that reaches it and
has no opinion about which. What we will say is that the workflow being replaced is people
standing in a yard with a phone, so **field reachability is not optional**: if foremen cannot reach
PCC from a job site, they cannot sign for deliveries.

---

## 8. Identity — today and later

**Today:** PCC verifies its own email-and-password credentials (salted and hashed with scrypt).
Sign-in is rate limited to 5 failures per address per 15 minutes. **There is no MFA and no SSO
today.**

**Later, if you want it:** Microsoft 365 / Entra ID sign-in is an adapter behind an interface that
already exists — one file, one binding line, and a `users.auth_user_id` column that is already in
the schema for exactly this. Authorization would **not** move: PCC's roles and permissions stay
PCC's, because who may approve a purchase order is a purchasing decision, not an identity-provider
one.

**This is not configured and is not being presented as if it were.** Scoping it needs your tenant
details: a tenant ID, an app registration, a client ID and secret, and a redirect URL of the form
`https://<the PCC address>/api/auth/callback`.

---

# INFORMATION REQUIRED FROM LIPPOLIS IT BEFORE INSTALLATION

## BLOCKS INSTALLATION — we cannot start without these

| # | Question | Why it blocks | Answer |
|---|---|---|---|
| 1 | **VM operating system and version?** | Decides the supervision path and whether containers are even an option. We will not guess. | |
| 2 | **Is Docker or Podman available and permitted?** If not, what is the supported way to run a long-lived service? | Chooses between the two deployment paths in §5 | |
| 3 | **CPU / RAM / disk allocated?** (we asked for 2 / 4 GB / 50 GB expandable) | Confirms what we are installing onto | |
| 4 | **VM hostname or IP** | Needed to reach it at all | |
| 5 | **Will PCC have a DNS hostname?** If so, what, and who controls the record? | `APP_BASE_URL` must be the address people actually type — password-reset links use it | |
| 6 | **LAN/VPN-only, or securely reachable externally?** | Decides whether foremen can sign for deliveries from a job site. See §7. | |
| 7 | **What terminates HTTPS, and who issues/renews the certificate?** | PCC does not do TLS, and sign-in will not work over plain HTTP in production | |

## CAN BE RESOLVED AFTER THE INITIAL PILOT

| # | Question | Why it can wait | Answer |
|---|---|---|---|
| 8 | **Backup platform and retention** — can it collect a directory on this server? How often, kept how long, stored where? | We can run the backup command manually during Phase A; it must be automated before real data accumulates | |
| 9 | **Who owns production restarts and first-line support?** | Someone reachable will do for the smoke test; it needs a name before real users depend on it | |
| 10 | **Identity plan** — PCC's own passwords initially, or Microsoft/Entra sign-in? | PCC's own credentials work today. Entra is an adapter that can be added later without a rewrite. | |

**Also useful, not blocking:** what monitoring exists that can poll an HTTP endpoint and alert
somebody (`/api/health` is ready for it), and whether there is a company database server PCC should
eventually use instead of SQLite — we would rather know early than migrate twice.

**Nothing else is required.** Anything not on this page is either the application's problem or a
decision that can wait.
