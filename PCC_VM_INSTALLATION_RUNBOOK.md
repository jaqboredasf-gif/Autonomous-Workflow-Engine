# PCC — VM installation runbook

**This is the authoritative installation document.** It starts where a VM has been provisioned and
access granted, and ends with a verified running PCC and a signed installation record.

> **Clone `--branch pcc-production`.** The repository's default branch does not contain PCC. See
> `SOURCE_OF_TRUTH.md` at the repository root — it is one page and it is the first thing to read.

Everything else is reference, and none of it is required to install:

| Document | What it is for | Audience |
|---|---|---|
| `docs/deployment/PCC_IT_INSTALLATION_PACKET.md` | What to provision and connect | **Jose / IT** |
| `docs/deployment/PCC_PURCHASING_GO_LIVE.md` | The PO number, pilot users, jobs, vendors | **Mike / purchasing** |
| `docs/deployment/PCC_SECRETS_CHECKLIST.md` | The two secrets, who makes them, what rotation costs | **Lippolis IT** |
| `docs/deployment/PCC_IT_DEPLOYMENT_HANDOFF.md` | Day-to-day operations: start, stop, logs, update, backup, restore | **Lippolis IT / operational owner** |
| `docs/deployment/PCC_PRODUCTION_ARCHITECTURE.md` | What PCC is and why it is shaped this way | Installer + IT |
| `docs/deployment/PCC_GO_LIVE_PLAN.md` | Pilot phases, rollback, the go-live gate | Installer + purchasing |
| `docs/deployment/PCC_PRODUCTION_PILOT_CHECKLIST.md` | The boxes on pilot day | Installer + IT |
| `docs/deployment/PCC_PRODUCTION_ACCEPTANCE.md` | **What to run after installing**: verify, provision, one real PO, reboot, verify again, accept | **Installer + IT + purchasing** |

**Scripts this runbook uses** — all read-only unless stated:

| Script | What it does |
|---|---|
| `scripts/pcc-preflight.mjs` | Is this machine ready? PASS / WARNING / FAIL. Changes nothing. |
| `scripts/install-production.sh` | Executes the deterministic Docker-path steps. Refuses unsafe layouts; creates no secrets, no directories, no PO sequence. `--dry-run` supported. |
| `scripts/pcc-storage-status.mjs` | Database size, backup count and size, free space, room for more backups. |
| `scripts/pcc-backup.mjs` | Takes a verified backup while PCC keeps serving. |
| `scripts/pcc-restore.mjs` | Restores a backup. Destructive by nature, and built to be hard to run by accident. |
| `scripts/restore-rehearsal.sh` | Full backup→restore→verify drill in throwaway containers. |
| `scripts/pcc-verify-production.mjs` | Is this DATABASE fit for real work? Finds demo data, vendors without a purchase order code, and every job-and-vendor pair about to issue its first number. |
| `scripts/pcc-verify-deployment.mjs` | **Is this INSTALLATION safe and operational?** The one command to run after installing and after every reboot. Read-only; prints no secret; exits non-zero on a real blocker. |

---

> # ⚠ BEFORE LIVE PURCHASING: NAME ANY JOB AND VENDOR THAT ALREADY HAS PAPER POs
>
> A PCC purchase order number is **job number + vendor + a count that starts at 1 for that pair** —
> `1234-COOPER-1`, `1234-COOPER-2`, `1234-GRAYBAR-1`, `5678-COOPER-1`. The rule came from Mike and
> Paul on 2026-08-12.
>
> There is **no company-wide starting number to supply**, and nothing to configure on a fresh
> install: a job and vendor PCC has issued nothing for starts at 1, which is the truth.
>
> **The narrow risk that remains.** If the office has already written purchase orders on paper for
> a job and a vendor, PCC starting that pair at 1 issues a number the supplier already holds — and
> **a purchase order number cannot be un-issued.** For those pairs, an administrator sets where the
> count had reached, in **Administration → PO numbering**, before the first order on that job.
> PCC refuses to move a count backwards or to start at or below a number it has already issued.
>
> `scripts/pcc-verify-production.mjs` lists every pair about to issue its first number, so this is
> asked by the go/no-go check rather than remembered.
>
> **Do not invent a number.** It comes from the paper file for that job and that vendor.

---

# INFORMATION NEEDED FROM LIPPOLIS IT

Hand this section to Jose. Nothing here is already answered by the repository.

## REQUIRED BEFORE INSTALLATION

| # | Question | Why we cannot start without it | Answer |
|---|---|---|---|
| 1 | **VM operating system and version?** | Chooses the install branch below. We will not guess. | |
| 2 | **VM hostname or IP?** | Needed to reach the machine | |
| 3 | **Is Docker or Podman available and permitted?** If not, what is the supported way to run a long-lived service? | Branch A vs Branch B | |
| 4 | **Which port may PCC listen on?** (default 3000, bound to localhost) | The proxy has to point somewhere | |
| 5 | **What terminates HTTPS, and who issues/renews the certificate?** | Session cookies are marked `Secure`; sign-in will not work over plain HTTP in production | |

## CONFIRM AT INSTALL TIME (not blocking, but recorded)

| # | Question | Answer |
|---|---|---|
| 6 | **CPU allocated?** (asked for 2 vCPU) | |
| 7 | **RAM allocated?** (asked for 4 GB) | |
| 8 | **Disk allocated?** (asked for 50 GB, expandable) | |
| 9 | **Intended hostname / DNS name for PCC**, and who controls the record | |

## CAN BE DECIDED DURING PILOT

| # | Question | Why it can wait | Answer |
|---|---|---|---|
| 10 | **LAN/VPN-only, or securely reachable externally?** | Phase A runs on the office network. Decide before foremen need it from a job site. | |
| 11 | **Host backup platform and retention** | We can run the backup command manually during Phase A | |
| 12 | **Monitoring that can poll an HTTP endpoint** | `/api/health` is ready whenever monitoring is | |
| 13 | **Who owns host and application restart at infrastructure level?** | Someone reachable will do for Phase A; needs a name before Phase B | |

---

# The installation

Work top to bottom. **Record every answer in the installation record (§ Evidence) as you go** —
filling it in afterwards from memory is how a deployment becomes undocumented.

## Step 1 — Identify the VM

```bash
uname -a                                   # Linux: kernel and architecture
cat /etc/os-release                        # Linux: distribution and version
# Windows Server: systeminfo | findstr /B /C:"OS Name" /C:"OS Version"
```

**Record the OS and version.** Everything after Step 4 branches on it.

## Step 2 — Confirm CPU, RAM and disk

```bash
nproc                                      # vCPU count        (expect 2)
free -h                                    # RAM               (expect ~4 GB)
df -h /                                    # disk              (expect ~50 GB)
lsblk                                      # is the data disk separate?
```

If the allocation differs from what was asked for, record what it actually is and carry on —
PCC will run on less. Note it as a warning in the record rather than stopping.

## Step 3 — Confirm the available runtime

```bash
docker --version && docker compose version   # Branch A
podman --version                             # Branch A (podman-compose equivalent)
node --version                               # Branch B — must be v24 or later
systemctl --version                          # is systemd the supervisor?
```

**Choose the branch now:**

| What you found | Branch |
|---|---|
| Linux, Docker or Podman available | **Branch A — Linux + container runtime** *(preferred: this is what the image and compose file were written for)* |
| Linux, no container runtime permitted | **Branch B — Linux, Node directly** |
| Windows Server | **Branch C — stop and read §Branch C before doing anything** |

## Step 4 — Install dependencies

**Branch A:** nothing. The image carries Node 24 and every dependency. Docker is the only
requirement, and Step 3 confirmed it.

**Branch B:** Node 24 on the host — **required, not preferred**: the purchasing store is
`node:sqlite`, part of the runtime rather than a dependency.

```bash
# Debian/Ubuntu, via NodeSource — use whatever your platform's supported method is
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version                              # must print v24.x or later
```

## Step 5 — Obtain the approved PCC version

> **THE BRANCH IS `pcc-production`, AND IT IS NOT THE DEFAULT.** A plain `git clone` gives you
> `main`, which does not contain the purchasing application at all — no `apps/purchasing`, no
> Dockerfile, no deployment units. There is also a branch named
> `claude/purchasing-control-center`, which sounds right, is eight days older, and has none of the
> packaging. `--branch pcc-production` is not optional. See `SOURCE_OF_TRUTH.md`.

```bash
sudo mkdir -p /srv/pcc && sudo chown "$USER" /srv/pcc
git clone --branch pcc-production <repository-url> /srv/pcc
cd /srv/pcc
ls Dockerfile deploy/pcc-backup.timer       # both must exist — if not, wrong branch
git checkout <approved-commit-or-tag>
git rev-parse HEAD                          # RECORD THIS — it is the deployed version
```

Deploy a specific commit or tag, never a moving branch. The commit hash is what makes the
installation record meaningful and a rollback possible. Put it in `PCC_RELEASE` in the environment
file too, so `/api/health` reports which build is running.

## Step 6–8 — Create the production directories

**The application and its data must be separable.** Updating PCC must never touch its records.

```bash
sudo install -d -o 1000 -g 1000 -m 750 /var/lib/pcc              # 6, 7: persistent data
sudo install -d -o 1000 -g 1000 -m 750 /var/lib/pcc/backups      # 8: backups
```

`1000:1000` is the `node` user the container runs as. On Branch B use the service account you
create in Step 11 instead.

| Path | What lives there | Survives a redeploy? |
|---|---|---|
| `/srv/pcc` | the application — code, build output, git checkout | **No — replaced on every release** |
| `/var/lib/pcc` | `pcc.sqlite` + `-wal` + `-shm`, and attachments (stored inside the database) | **YES — never delete** |
| `/var/lib/pcc/backups` | timestamped backup files | **YES** |
| `/etc/pcc.env` | configuration, including the session secret | **YES — and never in git** |
| journald / `docker logs` | application logs | rotated by the platform |

> ### ⚠ THE DATA MUST NOT LIVE INSIDE THE CHECKOUT
>
> An earlier draft of this runbook said to clone to `/srv/pcc` and put the data in
> `/srv/pcc/data`. Each half is reasonable; together they put the company's purchasing records
> inside a git working tree, where the ordinary vocabulary of deploying software destroys them:
>
> ```
> git clean -xfd        removes untracked files — that is the database
> rm -rf /srv/pcc       the obvious way to "reinstall from scratch"
> re-clone over the top  what you do when a checkout goes wrong
> ```
>
> None of those look destructive, and the backups sit beside the database, so the same command
> takes the recovery path with it.
>
> **PCC now refuses to start in production if its database is inside a git working tree**, naming
> the checkout it found. Development is unaffected — a laptop keeps its database in the checkout on
> purpose. You do not have to remember this rule; you just have to not fight it.

**Nothing under `/srv/pcc` is precious.** That separation is the point: a release replaces the
application directory entirely and cannot reach the records.

## Step 9 — Configure the environment

```bash
sudo install -o root -g 1000 -m 640 /dev/null /etc/pcc.env
sudo cp .env.example /tmp/pcc.env.draft     # explanations for every variable
sudo -e /etc/pcc.env                        # fill it in
```

Required: `NODE_ENV=production`, `SESSION_SECRET`, `PCC_DATABASE_PATH`, `APP_BASE_URL`.

```bash
openssl rand -base64 48                     # SESSION_SECRET — store it in IT's secret store
```

Set `PCC_DATABASE_PATH=/data/pcc.sqlite` on Branch A (the container's view of the volume), or
`/var/lib/pcc/pcc.sqlite` on Branch B. Set `APP_BASE_URL` to the HTTPS address people will type.

Also set for the first start only, and **removed immediately afterwards**:
`PCC_DATABASE_ALLOW_CREATE=1`, `PCC_BOOTSTRAP_ADMIN_EMAIL`, `PCC_BOOTSTRAP_ADMIN_PASSWORD` (12+
characters). Optional but wanted: `PCC_ORG_NAME`, `PCC_ORG_PHONE`, `PCC_ORG_ADDRESS` — **these
print on every purchase order.**

**Then run the preflight.** It is read-only, changes nothing, and prints no secret values:

```bash
sudo -u \#1000 env $(sudo cat /etc/pcc.env | grep -v '^#' | xargs) \
  node scripts/pcc-preflight.mjs --data /var/lib/pcc --port 3000
```

Every **FAIL** must be fixed before continuing. Read the **WARNING**s.

## Step 10 — Build

**Branch A:**

```bash
cd /srv/pcc
docker compose build            # runs check-deployable.mjs; the build FAILS if a
                                # database, key or .env would be shipped inside the image
```

**Branch B:**

```bash
cd /srv/pcc
npm ci --workspaces --include-workspace-root
npm run build --workspace purchasing
node scripts/check-deployable.mjs
sudo rsync -a apps/purchasing/.next/standalone/ /opt/pcc/
sudo rsync -a apps/purchasing/.next/static/     /opt/pcc/apps/purchasing/.next/static/
sudo rsync -a apps/purchasing/public/           /opt/pcc/apps/purchasing/public/
sudo chown -R pcc:pcc /opt/pcc
```

## Step 11 — Initialize and start

**PCC creates its database on the first start and only when told to.** There is no separate
migration or seed step; migrations run on every start and are idempotent.

**Branch A:**

```bash
cd /srv/pcc
# edit docker-compose.yml so the volume is the host path: /var/lib/pcc:/data
docker compose up -d
docker compose logs pcc | grep '\[pcc\]'
```

**Branch B:**

```bash
sudo useradd --system --home /opt/pcc --shell /usr/sbin/nologin pcc   # if not done
sudo cp deploy/pcc-node.service /etc/systemd/system/pcc.service
sudo systemctl daemon-reload && sudo systemctl start pcc
journalctl -u pcc | grep '\[pcc\]'
```

**Expect exactly these lines, once:**

```
[pcc] creating a NEW purchasing database — this should happen exactly once, on first install
[pcc] Purchase orders are numbered job-vendor-sequence, e.g. 1234-COOPER-1, counting from 1…
[pcc] created the bootstrap administrator <email>…
[pcc] ready — auth: local, persistence: local, attachments: inline, mode: production
```

If PCC refuses to start, it will say why and name the variable. That is deliberate: a production
start with a wrong data path exits rather than quietly creating an empty purchasing system.

**Now remove the first-install variables from `/etc/pcc.env`** — `PCC_DATABASE_ALLOW_CREATE` and
`PCC_BOOTSTRAP_ADMIN_PASSWORD` — and restart. (Leaving `ALLOW_CREATE` set is tested and
non-destructive, but it should not be a permanent part of the configuration.)

## Step 12–14 — Verify

```bash
curl -fsS http://127.0.0.1:3000/api/health        # {"status":"ok", ... }  — readiness
curl -fsS http://127.0.0.1:3000/api/health/live   # {"status":"alive"}     — liveness
```

Then in a browser, through the proxy at the real HTTPS address: sign in as the bootstrap
administrator, **change the temporary password**, and confirm the shell loads.

If sign-in does not stick, the session cookie is `Secure` and you are not on HTTPS. That is the
proxy, not PCC.

## Step 15 — Verify persistence across restart

```bash
docker compose restart pcc            # or: sudo systemctl restart pcc
docker compose logs pcc | grep '\[pcc\]' | tail -2
```

**The log must now say `opening the existing purchasing database`.** If it ever says *creating* a
new one again, **stop** — the volume is not mounted where PCC is looking, and you are about to run
a second, empty purchasing system beside the real one.

Sign in again. Your password change survived.

## Step 16 — Configure process supervision

**PCC must not depend on somebody leaving a terminal open.**

**Branch A:** compose already sets `restart: unless-stopped` for crashes. Add the boot unit:

```bash
sudo cp deploy/pcc-docker.service /etc/systemd/system/pcc.service
sudo sed -i 's#/srv/pcc#'"$(pwd)"'#' /etc/systemd/system/pcc.service   # if the path differs
sudo systemctl daemon-reload && sudo systemctl enable --now pcc
systemctl status pcc
```

**Branch B:** `sudo systemctl enable pcc` (the unit is already installed from Step 11).

Both units restart on a **crash** but not on a deliberate configuration **refusal** — a supervisor
that loops on a bad configuration buries the one log line explaining it.

## Step 17–18 — Reboot the VM and confirm PCC returns

**Do this. It is the only way to know.**

```bash
sudo reboot
# wait, then reconnect:
systemctl status pcc
curl -fsS http://127.0.0.1:3000/api/health
```

**Nobody logs in to start it.** If PCC is not up after the reboot, supervision is not configured
and Step 16 needs redoing.

## Step 19 — Create the first backup

```bash
# Branch A
docker run --rm -v /var/lib/pcc:/data -v /srv/pcc/scripts:/scripts:ro --user 1000:1000 \
  node:24-bookworm-slim \
  node /scripts/pcc-backup.mjs --db /data/pcc.sqlite --out /data/backups --keep 30

# Branch B
sudo -u pcc node /srv/pcc/scripts/pcc-backup.mjs \
  --db /var/lib/pcc/pcc.sqlite --out /var/lib/pcc/backups --keep 30
```

It runs while PCC keeps serving, and **verifies what it wrote** — integrity check plus row counts —
exiting non-zero if the file is not usable. **Do not simply copy `pcc.sqlite`**: the database runs
in WAL mode and a naive copy can capture an almost-empty database and look like it worked.

Then hand `/var/lib/pcc/backups` to IT's backup system and agree a schedule.

## Step 20 — VM-local restore rehearsal

**A backup nobody has restored is a hypothesis.** Run the drill on this machine, so the result
describes this machine:

```bash
cd /srv/pcc
bash scripts/restore-rehearsal.sh
```

It builds the image, stands up a source instance on its own throwaway volume, fills it with a
complete purchasing system, backs it up, restores into a second throwaway volume, starts a second
instance against the restored data, and verifies 23 facts through the web interface — including
downloading attachments and comparing them byte for byte. It touches nothing you installed above
and removes everything it made.

**Must print `RESTORE REHEARSAL: PASS`.**

*(Branch B: the rehearsal uses Docker. If no container runtime exists, perform the manual restore
test in `PCC_IT_DEPLOYMENT_HANDOFF.md` §8 against a copied database instead, and record that.)*

## Step 21 — Verify logs

```bash
docker compose logs -f pcc          # Branch A
journalctl -u pcc -f                # Branch B
docker compose logs pcc | grep '\[pcc\]'   # startup diagnostics
```

Confirm you can see: startup lines, a sign-in, and an application error if you provoke one (visit a
URL that does not exist). Logs are JSON to stdout; passwords, tokens and secrets are redacted by
field name and email addresses are masked. **Record where the logs live** — it is the first thing
anybody will ask for.

## Step 22 — Record the evidence

Fill in the installation record below, completely, and keep it with the project.

---

## Branch C — Windows Server

**Stop.** Nothing in PCC assumes Linux, but no Windows installation has been performed or tested,
and this runbook will not pretend otherwise.

If the VM is Windows Server, the realistic options are Docker Desktop / Windows containers using
the same image and compose file (in which case Branch A applies almost unchanged), or running the
Node 24 process directly and wrapping it as a service with NSSM or `sc.exe` (Branch B's shape,
with a Windows service in place of the systemd unit). Data paths become Windows paths;
`PCC_DATABASE_PATH` must still be absolute and on a disk that is backed up.

**Tell the installer the OS before installation day**, and this branch will be written properly and tested
first. Do not improvise it on the day.

---

# Installation record

Copy this, fill it in during the install, and keep it. **No secrets in this record** — not the
session secret, not the bootstrap password, not any credential. Names and results only.

```
PCC INSTALLATION RECORD
=======================

Deployed version (git commit) ....... ________________________________
Version tag / release name .......... ________________________________
Deployment date/time ................ ________________________________
Installed by ........................ ________________________________

VM
  Hostname .......................... ________________________________
  Operating system + version ........ ________________________________
  vCPU / RAM / disk ................. ______ / ______ / ______
  Runtime (Docker | Podman | Node) .. ________________________________
  Install branch used (A | B | C) ... ______

Application
  Application URL (HTTPS) ........... ________________________________
  Listening port .................... ______
  Data directory .................... ________________________________
  Backup directory .................. ________________________________
  Config file location .............. ________________________________
  Log location ...................... ________________________________

Verification                                   RESULT      NOTE
  Preflight (pcc-preflight.mjs) ....... PASS / FAIL  ______________
  First start, DB created once ........ PASS / FAIL  ______________
  Readiness  /api/health .............. PASS / FAIL  ______________
  Liveness   /api/health/live ......... PASS / FAIL  ______________
  Sign-in through the proxy ........... PASS / FAIL  ______________
  Bootstrap password changed .......... PASS / FAIL  ______________
  First-install variables removed ..... PASS / FAIL  ______________
  Restart: "opening the existing DB" .. PASS / FAIL  ______________
  Data persisted across restart ....... PASS / FAIL  ______________
  Supervision installed + enabled ..... PASS / FAIL  ______________
  VM REBOOT: PCC returned unattended .. PASS / FAIL  ______________
  First backup taken and verified ..... PASS / FAIL  ______________
  Restore rehearsal on this VM ........ PASS / FAIL  ______________
  Logs located and readable ........... PASS / FAIL  ______________

PO sequence
  Initialized? ........................ YES / NO (NO is expected at install)
  Number supplied by .................. ________________________________
  Date initialized .................... ________________________________

Known warnings / deviations
  ______________________________________________________________
  ______________________________________________________________

Outstanding IT items
  ______________________________________________________________

Signed (installer) .................. ________________________________
```

---

# Phase A — production smoke test

Run on the VM, **with non-live PO numbering**, on a database that is discarded or reset before real
purchasing begins. Record PASS/FAIL for every line.

> **Do not create a real vendor-facing purchase order** unless purchasing has explicitly authorized
> it. There is no longer a prefix to make a test order obviously fake — the number is built from the
> job — so use an obviously non-real **job number** for the smoke test, e.g. a job called
> `TEST-SMOKE`, which produces `TEST-SMOKE-GRAYBAR-1`. Nothing carrying that could be mistaken for a
> real order. **Recreate the database clean** before Phase B regardless.

| # | Check | Result |
|---|---|---|
| 1 | Administrator signs in through the HTTPS address | |
| 2 | A second user is invited, signs in, and changes their password | |
| 3 | That user is **refused** a screen their role forbids (`/admin`) | |
| 4 | A request is created from a phone-sized browser | |
| 5 | The request is edited where the role permits, and refused where it does not | |
| 6 | Workshop review records stock, picks a vendor, approves | |
| 7 | PO is generated on the `TEST-SMOKE` job, and reads `TEST-SMOKE-<VENDORCODE>-1` | |
| 8 | **The PO prints correctly on the office printer** — header, ship-to, quantity columns, signature block, checked against a paper PO | |
| 9 | Vendor email draft composes; reviewed → approved → marked sent by a person | |
| 10 | PCC **cannot** send the email itself (confirm no send button exists) | |
| 11 | Marked ordered | |
| 12 | Delivery received with a photograph attached | |
| 13 | **The photograph opens again** from the receipt screen | |
| 14 | Partial receipt keeps the order open; final receipt completes it | |
| 15 | Activity history reads correctly to somebody who was not involved | |
| 16 | `docker compose restart` / `systemctl restart` — everything above still there | |
| 17 | Backup taken and verified | |
| 18 | `/api/health` and `/api/health/live` both healthy afterwards | |
| 19 | Logs show the sign-ins and the workflow steps | |
| 20 | A second PO on the same job and vendor reads `…-2`, and one on a different vendor reads `…-1` | |
| 21 | Test data removed, or database recreated clean | |

**Phase A is GREEN only when every line is PASS.**

---

# Phase B — limited real purchasing *(DO NOT START YET)*

**Prerequisites — all six must be true. None of them is true today.**

- [ ] VM installation record complete, every verification PASS
- [ ] Phase A smoke test GREEN
- [ ] **Every job-and-vendor pair with existing paper POs named by Mike / purchasing, and set** —
      or confirmed that none of the pilot's jobs has paper POs against a vendor
- [ ] Vendor purchase order codes reviewed against how the office writes them
- [ ] Purchasing stakeholders have approved starting
- [ ] Rollback procedure below read and understood by whoever raises orders

## Phase B setup — the exact order, once

Do these in this order on the clean production database. Steps 3 and 4 are the only ones that need
an answer from Mike or Paul, and neither can be guessed.

```bash
# 0. Confirm what the database thinks. Run this before and after; it names every
#    remaining action in the same words used below.
node scripts/pcc-verify-production.mjs --db /var/lib/pcc/pcc.sqlite --strict
```

1. **Real vendors** — Administration → Vendors. Enter the suppliers the office actually buys from,
   each with its ordering contact and address.
2. **Vendor PO codes** — Administration → Vendors → Edit → *PO code*. PCC derives one from the name
   (`Graybar Electric` → `GRAYBARELECTRIC`); the office may write `GRAYBAR`. Set the office's
   version now. **After a vendor receives its first purchase order its code is frozen**, because it
   is part of every number that vendor holds. `pcc-verify-production.mjs` lists every code still
   exactly as derived, so nothing is missed.
3. **Real jobs** — Administration → Jobs. Job name and site address both print on the PO.
4. **Purchase order history, per job and vendor** — Administration → PO numbering. For each job the
   pilot will use, ask the office one question: *has a purchase order ever been written by hand for
   this job and this vendor?*
   - **Yes** → *Set this pair*, giving the last paper number (or the next one). PCC continues from
     there.
   - **No** → *Confirm as new*. The count starts at 1 either way; recording the answer is what stops
     the go-live check asking again, and what distinguishes "checked, it is new" from "nobody has
     looked".
   The verifier lists every active job with no answer recorded either way, and says exactly this.
5. **People** — Administration → Users. Mike and Rick with approval authority; foremen assigned to
   their jobs; whoever signs at the shop counter assigned to WORKSHOP.
6. Re-run step 0. It should report no unresolved pairs and no unasked jobs.

Then real purchasing runs **alongside the paper process** with weekly reconciliation. Full detail in
`docs/deployment/PCC_GO_LIVE_PLAN.md` §2.

---

# Rollback — PCC failure must not stop purchasing

The paper process remains the fallback for the whole pilot. **Nobody stops buying material because
a web application is down.**

**If PCC becomes unavailable:**

1. Purchasing returns to paper, exactly as before PCC.
2. **Every paper PO number issued during the outage is written down.** This list is the only thing
   that reconciles the two systems afterwards.
3. Before PCC returns to live use, determine the **highest PO number already issued** — on paper or
   by PCC, whichever is greater.
4. Set PCC's next number **above that number**, in Administration → Organization.
5. **PCC must never issue a number lower than one a vendor has already seen.**

The sequence only moves forward, so step 4 is always permitted and never destructive. It leaves a
gap. **A gap is not a problem; a duplicate is.**

**This reconciliation is deliberately manual.** Automating it would mean a program guessing which
numbers a vendor has seen, and a wrong guess issues a duplicate — the exact failure the whole rule
exists to prevent.
