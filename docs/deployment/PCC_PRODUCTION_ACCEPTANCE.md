# PCC — production acceptance

**What this is.** The sequence run **on the Lippolis VM**, in order, once. It starts where
`PCC_VM_INSTALLATION_RUNBOOK.md` finishes and ends with a signed decision: PCC is accepted for
real purchasing, or it is not and the reasons are written down.

```
INSTALL → CONFIGURE → VERIFY → PROVISION → REAL PO → REBOOT → VERIFY AGAIN → ACCEPT
```

**The rule that makes this worth doing:** *do not change PCC to make a step pass.* A step that
fails is a defect, recorded as one. Adjusting the product mid-acceptance produces a checklist that
proves nothing.

**One command underpins every VERIFY step:**

```bash
cd /srv/pcc
sudo systemd-run --quiet --pipe --wait --collect --uid=pcc \
  --property=WorkingDirectory=/srv/pcc --property=EnvironmentFile=/etc/pcc.env \
  /usr/bin/node scripts/pcc-verify-deployment.mjs
```

systemd reads `/etc/pcc.env` with the same parser the service uses, so the check cannot see a
different environment from the one PCC runs in. **Do not rebuild the environment with
`env $(… | xargs)`** — `PCC_ORG_NAME=Lippolis Electric, Inc.` contains spaces, and that idiom
splits it into arguments and fails with `env: 'Electric,': No such file or directory`. Without
systemd, one `export` per line:

```bash
sudo -u pcc bash -c 'set -a; while IFS= read -r l; do case "$l" in ""|\#*) continue;; esac; \
  export "$l"; done < /etc/pcc.env; exec node /srv/pcc/scripts/pcc-verify-deployment.mjs'
```

It is read-only, prints no secret value, and exits non-zero on a genuine blocker. Everything it
reports comes from the checks that already existed — `/api/health`, `pcc-verify-production.mjs`,
`pcc-backup.mjs --check`, `validateEnvironment` — plus the things only the running installation can
answer: is the service enabled, is the timer armed, is this a production build.

---

## 0. DEPLOY ONLY THIS

```
Branch:  pcc-production
Commit:  58068f374aa665f3c058f53b49e4e10f8f010c9b
```

**Check out the commit, not the branch.** A branch moves; an installation record that says "the
tip of pcc-production on Tuesday" cannot be rolled back to or reasoned about. `d4fa007` and every
earlier candidate are superseded and must not be deployed.

### The whole install, in order

Steps 1–4 and the reasoning behind each are in `PCC_VM_INSTALLATION_RUNBOOK.md`; this is the
sequence itself, for the person at the keyboard.

```bash
# 1  INSPECT THE VM — read-only
cat /etc/os-release; uname -m; nproc; free -h; df -h /
node --version; command -v node; git --version; systemctl --version | head -1
ss -ltnp | grep -E ':3000|:80|:443' || echo "3000 free"

# 2  PREREQUISITES — Node 24 must land at /usr/bin/node, or the unit fails 203/EXEC
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git rsync
command -v node                                    # expect /usr/bin/node

# 3  CLONE
sudo mkdir -p /srv/pcc && sudo chown "$USER" /srv/pcc
git clone --branch pcc-production <REPOSITORY_URL> /srv/pcc && cd /srv/pcc

# 4  CHECK OUT THE EXACT FROZEN COMMIT
git checkout 58068f374aa665f3c058f53b49e4e10f8f010c9b
git rev-parse HEAD                                 # must match, character for character
ls Dockerfile deploy/pcc-backup.timer              # both exist = right branch

# 5  PERSISTENT DIRECTORIES — service account FIRST, then what it owns
sudo useradd --system --home /opt/pcc --shell /usr/sbin/nologin pcc
sudo install -d -o pcc -g pcc -m 750 /var/lib/pcc /var/lib/pcc/backups /opt/pcc /opt/pcc/scripts

# 6  PERMISSIONS — the config file holds the session secret
sudo install -o root -g pcc -m 640 /dev/null /etc/pcc.env

# 7  PRODUCTION ENVIRONMENT — see §0a. IT generates the secret ON THIS MACHINE
openssl rand -base64 48
sudo -e /etc/pcc.env

# 8  DEPENDENCIES
npm ci --workspaces --include-workspace-root

# 9  MIGRATE — there is no separate step. Migrations run on start, idempotently.

# 10 BUILD
npm run build --workspace purchasing && node scripts/check-deployable.mjs
sudo rsync -a apps/purchasing/.next/standalone/ /opt/pcc/
sudo rsync -a apps/purchasing/.next/static/ /opt/pcc/apps/purchasing/.next/static/
sudo rsync -a apps/purchasing/public/ /opt/pcc/apps/purchasing/public/
sudo install -o pcc -g pcc -m 750 scripts/pcc-backup.mjs scripts/pcc-restore.mjs \
     scripts/pcc-reset-admin.mjs scripts/pcc-storage-status.mjs /opt/pcc/scripts/
sudo chown -R pcc:pcc /opt/pcc

# 11 INSTALL THE SERVICE
sudo cp deploy/pcc-node.service /etc/systemd/system/pcc.service
sudo cp deploy/pcc-backup.service /etc/systemd/system/pcc-backup.service
sudo cp deploy/pcc-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload

# 12 START, THEN ENABLE AT BOOT
sudo systemctl start pcc
journalctl -u pcc | grep '\[pcc\]'   # "creating a NEW purchasing database", once
sudo systemctl enable pcc

# 13 BACKUP TIMER
sudo systemctl enable --now pcc-backup.timer
systemctl list-timers pcc-backup.timer

# 14 PRODUCTION VERIFICATION — must end READY, exit 0
sudo systemd-run --quiet --pipe --wait --collect --uid=pcc \
  --property=WorkingDirectory=/srv/pcc --property=EnvironmentFile=/etc/pcc.env \
  /usr/bin/node scripts/pcc-verify-deployment.mjs

# 15 FIRST BACKUP
sudo systemctl start pcc-backup.service
systemctl show pcc-backup.service -p Result --value        # success

# 16 VERIFY THE ARTIFACT
sudo -u pcc node /opt/pcc/scripts/pcc-backup.mjs --db /var/lib/pcc/pcc.sqlite --check

# 17 ACCOUNT PROVISIONING — section B below, in the browser
```

**Then remove `PCC_DATABASE_ALLOW_CREATE` and `PCC_BOOTSTRAP_ADMIN_PASSWORD` from `/etc/pcc.env`
and restart.** The log must then say *opening the existing purchasing database*.

---

## 0a. `/etc/pcc.env` — the handoff template

Placeholders only. **No real secret belongs in this repository, in a ticket, or in a chat
message.** `<GENERATE_SECURE_VALUE>` means generated on the server by IT, at the moment it is
needed.

```ini
# ---- REQUIRED BEFORE FIRST START — PCC refuses to start without these ----
NODE_ENV=production
SESSION_SECRET=<GENERATE_SECURE_VALUE>          # openssl rand -base64 48, on this machine
PCC_DATABASE_PATH=/var/lib/pcc/pcc.sqlite
APP_BASE_URL=<CONFIRM_WITH_JOSE>                # https://pcc.<lippolis domain>
PCC_PO_NUMBERING=job-vendor-sequence

# The letterhead on every purchase order a supplier receives. Read ONLY when the
# organization is created; no screen edits them afterwards, and PCC refuses to
# start rather than create a company without them.
PCC_ORG_NAME=Lippolis Electric, Inc.
PCC_ORG_ADDRESS=Licensed Electrical Contractor · 25 Seventh Street, Pelham, NY 10803
PCC_ORG_PHONE=(914) 738-3550

# ---- FIRST START ONLY — remove both, then restart ----
PCC_DATABASE_ALLOW_CREATE=1
PCC_BOOTSTRAP_ADMIN_EMAIL=<CONFIRM_WITH_JOSE>   # the first administrator's real address
PCC_BOOTSTRAP_ADMIN_PASSWORD=<GENERATE_SECURE_VALUE>   # 12+ chars, temporary, replaced at sign-in

# ---- REQUIRED BEFORE USER ACCEPTANCE ----
PCC_RELEASE=58068f374aa665f3c058f53b49e4e10f8f010c9b

# ---- ONLY IF THERE IS NO TLS ON DAY ONE ----
# A deliberate, recorded decision. PCC refuses to start on plain HTTP without it.
# PCC_ALLOW_INSECURE_HTTP=1

# ---- OPTIONAL / INTEGRATION-DEPENDENT ----
# PORT=3000
# SESSION_TTL_SECONDS=43200
# There is NO email transport setting: PCC composes drafts and cannot send.
# There is NO printer setting: printing is the browser's, on the PC Mike uses.
```

| Value | Who prepares it |
|---|---|
| `PCC_ORG_NAME`, `PCC_ORG_ADDRESS`, `PCC_ORG_PHONE`, `PCC_PO_NUMBERING`, `PCC_RELEASE`, `NODE_ENV`, `PCC_DATABASE_PATH` | **Already known — prepared in advance** |
| `SESSION_SECRET`, `PCC_BOOTSTRAP_ADMIN_PASSWORD` | **Lippolis IT, on the server**, at install time |
| `APP_BASE_URL`, `PCC_ALLOW_INSECURE_HTTP`, `PCC_BOOTSTRAP_ADMIN_EMAIL` | **Jose** — hostname, TLS decision, first administrator |

---

## A. Infrastructure acceptance

| # | Step | Command / where | Accept when |
|---|---|---|---|
| A1 | Install PCC | `PCC_VM_INSTALLATION_RUNBOOK.md`, Steps 1–12. **Clone `--branch pcc-production`** | The runbook's own checks pass |
| A2 | Configure environment and secrets | `/etc/pcc.env`, from `.env.example`. `SESSION_SECRET` generated **on the server** by IT | `PCC_DATABASE_PATH`, `APP_BASE_URL`, `PCC_PO_NUMBERING`, `SESSION_SECRET`, `PCC_RELEASE` all set — **and `PCC_ORG_NAME` / `PCC_ORG_ADDRESS` / `PCC_ORG_PHONE`, which print on every supplier's copy and are read only on the first start** |
| A3 | Start PCC | `sudo systemctl enable --now pcc` | `systemctl is-active pcc` → `active` |
| A4 | **Run production verification** | the command above | `OVERALL: READY FOR ACCEPTANCE TESTING`, exit 0. On a fresh install `database.fit_for_production` warns that the company's data has not been entered yet — that is section B/C, not a fault |
| A5 | Confirm health from another machine | `curl -fsS https://<address>/api/health` | `"status":"ok"`, and `release` matches the deployed commit. **Do this from a workstation** — the public name often does not resolve on the server itself, and verification warns rather than blocks when only the local address answers |
| A6 | Confirm the database is where it should be | verification `Database:` section | Path is the persistent volume, **not** inside `/srv/pcc` |
| A7 | Install and arm the backup timer | `PCC_IT_DEPLOYMENT_HANDOFF.md` §8a | `systemctl list-timers pcc-backup.timer` shows a next run |
| A8 | Run one backup by hand | `sudo systemctl start pcc-backup.service` | `systemctl show pcc-backup.service -p Result --value` → `success` |
| A9 | Confirm the artifact | `node scripts/pcc-backup.mjs --db /var/lib/pcc/pcc.sqlite --check` | Verified, integrity ok, correct row counts, owned by `pcc` |

> **Record `git rev-parse HEAD` and the output of A4 in the installation record.** An installation
> nobody can identify later is one nobody can debug later.

---

## B. Account acceptance

Provision **only the approved real people**. No test accounts on the production database.

| # | Step | Accept when |
|---|---|---|
| B1 | Administrator signs in on the bootstrap password | PCC sends them to *Choose your own password* and refuses everything else |
| B2 | Administrator sets their own password | They land in Administration; the bootstrap password no longer works |
| B3 | Remove `PCC_BOOTSTRAP_ADMIN_PASSWORD` and `PCC_DATABASE_ALLOW_CREATE` from `/etc/pcc.env`, restart | Log says *opening the existing purchasing database*; verification reports both as removed |
| B4 | Provision Mike, Rick and Jose with real company email addresses and roles | Each appears in Administration → Users with the intended role |
| B5 | Each person signs in with the temporary password they were handed | Forced to *Choose your own password* first |
| B6 | Each chooses their own password | Normal access; verification reports `auth.temporary_outstanding` = 0 |
| B7 | Permission spot-check, per role | See the table below |

**Permission spot-check.** Sign in as each and confirm both halves — what they *can* do and what
they *cannot*:

| Role | Must be able to | Must be refused |
|---|---|---|
| Requestor / field | Raise a request, see their own | Administration, the review screen, other people's requests |
| Workshop approver (Mike) | Review, set stock, approve, print, email draft, mark ordered, receive | Administration |
| Office (Rick) | See all active orders, tracking, receiving | Administration |
| Administrator (Jose) | Users, vendors, jobs, PO numbering, audit | — |

---

## C. Purchasing workflow acceptance

Run **one complete purchase**, on a real job, with a real vendor. Use a genuinely needed item —
a controlled real order is a better test than an invented one, and the paperwork is real either way.

| # | Step | Accept when |
|---|---|---|
| C1 | Create a purchasing request | Saved and visible in the queue |
| C2 | Enter the job number | Required; the correct job is attached |
| C3 | Select the vendor | Chosen from the vendor list, not typed free-hand |
| C4 | Enter material and quantity needed | Description and quantity recorded |
| C5 | Enter workshop/in-stock quantity | Accepted |
| C6 | Check the quantity actually ordered | **10 needed − 2 in stock = 8 ordered**, and all three numbers are visible |
| C7 | Approve → PO generated | Lands on the purchase order with the print dialogue open |
| C8 | Check the PO number | `job + vendor + sequence`, e.g. `1234-COOPER-1`. **If the office already wrote paper POs for this job and vendor, the pair must have been set in Administration first** |
| C9 | Check the printed contents | Job, vendor, item, all three quantities (**job qty · shop · qty ord.**), the blank **qty rec.** column, PO number, and the Lippolis letterhead with address and telephone — everything Mike needs on the workshop copy |
| C10 | Print it on the workshop printer | A usable physical copy, from the browser, on the PC Mike actually uses |
| C11 | Generate the vendor email draft | Draft exists and names the PO |
| C12 | Check recipient and content | Correct vendor address and body. **No price or total appears** — Lippolis does not quote up front, and a `$0.00` line to a supplier is a defect. **PCC cannot send**; it is sent from a person's own mailbox |
| C13 | Mark the order placed | **One click.** No second confirmation |
| C14 | Check the status | Shows as ordered, in the right queue |
| C15 | Open receiving | The simplified flow — no re-entry of the order |
| C16 | Mark the material received | One click; leaves the receiving queue |
| C17 | Confirm the closed state | Status and history are correct and readable |

**Record the request id and PO number.** Section D needs them.

---

## D. Persistence and reboot acceptance

| # | Step | Command | Accept when |
|---|---|---|---|
| D1 | Record the identifiers from section C | — | Written down |
| D2 | Restart PCC | `sudo systemctl restart pcc` | Comes back; log says *opening the existing purchasing database* |
| D3 | Confirm it returns | `curl -fsS https://<address>/api/health` | `"status":"ok"` |
| D4 | Confirm the transaction survived | Open the PO in the browser | Same PO number, same quantities, same history |
| D5 | **Reboot the VM** | `sudo reboot` | — |
| D6 | Confirm PCC started by itself | `systemctl is-active pcc` **with nobody having logged in to start it** | `active` |
| D7 | Re-run production verification | the A4 command | `READY FOR ACCEPTANCE TESTING`, exit 0 |
| D8 | Confirm the data is still there | Open the same PO | Unchanged. The next PO for that job and vendor continues the sequence |

> D5–D6 is the step most often skipped and the one that decides whether Monday morning needs a
> phone call. Do not accept without it.

---

## E. Recovery acceptance — **with Jose at the keyboard**

Jose runs every command. Watching someone else do it is not the test.

| # | Step | Command |
|---|---|---|
| E1 | Find the logs | `journalctl -u pcc -n 50` |
| E2 | Check service status | `systemctl status pcc` |
| E3 | Restart it | `sudo systemctl restart pcc` |
| E4 | Check backup status | `systemctl list-timers pcc-backup.timer`, `journalctl -u pcc-backup -n 20` |
| E5 | Trigger a backup by hand | `sudo systemctl start pcc-backup.service` |
| E6 | Identify the latest backup and prove it is usable | `node scripts/pcc-backup.mjs --db /var/lib/pcc/pcc.sqlite --check` |
| E7 | Explain the restore procedure | `PCC_IT_DEPLOYMENT_HANDOFF.md` §8, in his own words |
| E8 | Recover from an admin lockout | `node scripts/pcc-reset-admin.mjs --db /var/lib/pcc/pcc.sqlite --list` |
| E9 | Explain update and rollback | Runbook: deploy a specific commit, `systemctl restart pcc`, roll back by redeploying the previous commit |

> **Do not restore over the live database to prove the command works.** That proof already exists
> and is repeatable: `bash scripts/restore-rehearsal.sh` builds its own throwaway instance,
> restores into it and verifies 23 facts through the web interface, leaving production untouched.
> Run *that* on the VM instead.

---

## F. Real-user acceptance — Mike, unaided

**Mike does a complete purchase on his own computer, with nobody else touching the keyboard.**
Observe. Do not guide unless he is genuinely stuck; the point is to find out what happens when the
developer is not in the building, which is the situation from next week onwards.

Record every finding as exactly one of:

| Class | Meaning | Blocks acceptance? |
|---|---|---|
| **BUG** | PCC does the wrong thing, or refuses something it should allow | **Yes** |
| **USABILITY FRICTION** | He can complete it, but something is confusing or slow | **Only if severe** — he cannot finish unaided, or it invites a costly mistake |
| **MISSING OPERATIONAL RULE** | The software is fine; nobody has decided how the company does this | **Yes, if it blocks a real order** |
| **TRAINING ISSUE** | Works as designed; he had not been shown | No — write it into the user guide |
| **FUTURE IMPROVEMENT** | Worth doing, not now | **No. Do not turn these into launch blockers** |

Findings table:

| # | What happened | Class | Blocks? | Action |
|---|---|---|---|---|
|  |  |  |  |  |

---

## G. Jose handoff verification

The objective is plain: **normal operation of PCC must not require Jack's laptop, Claude Code, or
Jack.** Jose demonstrates each of these unaided. Tick only what he actually did.

- [ ] Says where PCC runs — host, service name, data directory
- [ ] `systemctl status pcc`
- [ ] `sudo systemctl restart pcc`
- [ ] `journalctl -u pcc -n 50`
- [ ] Runs the production verification command and reads the result
- [ ] `systemctl list-timers pcc-backup.timer`
- [ ] `sudo systemctl start pcc-backup.service`
- [ ] Identifies the latest backup and verifies it with `--check`
- [ ] States the restore procedure and where it is written down
- [ ] Names the production configuration file (`/etc/pcc.env`) and who holds the secrets
- [ ] States the deployed revision (`git rev-parse HEAD`, or `release` in `/api/health`)
- [ ] States how an update is applied and how it is rolled back

**Anything unticked is the handoff's remaining work**, not a footnote.

---

## H. Operational responsibility model

Who owns what, once PCC is live. **A documented working arrangement, not an architectural
dependency** — nothing in PCC requires any of these people specifically, and the roles outlive
whoever currently holds them.

| Party | Owns |
|---|---|
| **Lippolis** | Production infrastructure. Production data. Production secrets. The permanent production source repository |
| **Jose / IT** | Basic infrastructure operation: server access, restart and recovery, backup oversight, TLS and DNS, applying updates |
| **Mike / Rick** | Daily operation of PCC, and the operational feedback that decides what changes next |
| **Jack (AWE)** | Authorized remote development: bug fixes, tested improvements, future automation, deployment assistance where authorized |

The boundary that matters: **Lippolis can run PCC without AWE.** AWE changes it; Lippolis operates
it. If a step in section G cannot be completed without Jack, that is the gap to close before the
handoff is finished.

---

## I. If installation fails — the rollback plan

**Agreed before installation day, so nobody is inventing a recovery under pressure.**

The governing rule: **the database is never the thing we roll back.** `/var/lib/pcc` is not touched
by any step below. Everything else — the checkout, the build, the units, the environment file — is
replaceable, and rolling any of it back costs minutes.

| Failure | What it looks like | Do this |
|---|---|---|
| **Application will not start** | `systemctl status pcc` → `failed`; the journal names a variable | Read `journalctl -u pcc -n 30`. PCC refuses with the reason. Fix `/etc/pcc.env`, `systemctl restart pcc`. **Nothing was written** — the refusal happens before the database is created |
| **`status=203/EXEC`, no explanation** | The unit fails instantly, journal says nothing | Node is not at `/usr/bin/node`. `sudo ln -sf "$(command -v node)" /usr/bin/node`, or edit `ExecStart` |
| **"the database could not be opened"** | Starts, then refuses | Ownership. `sudo chown -R pcc:pcc /var/lib/pcc`, restart. The database is fine |
| **Migration fails** | Journal names the migration; `/api/health` is 503 with `migrations: false` | **Stop.** `systemctl stop pcc`. Restore the pre-upgrade backup into a *throwaway* copy and confirm the old schema opens, then redeploy the previous revision (below). Do not re-run the migration hoping |
| **Bad environment configuration** | Health 503, or sign-in never sticks | The 503 detail names the variable, never its value. Sign-in not sticking on `http://` is TLS/`APP_BASE_URL` — see §4a of the handoff |
| **A bad revision** | It starts, but behaves wrongly | Redeploy the previous commit. This is why `PCC_RELEASE` and the installation record exist |
| **Suspected database corruption** | Health 503; `--check` fails | Do **not** restore over the live file first. Take a copy, run `node scripts/pcc-backup.mjs --db <copy> --check`. Restore only with `pcc-restore.mjs --force`, which moves the live database aside as `.replaced-<timestamp>` rather than deleting it |
| **Works locally, not through the hostname** | `curl 127.0.0.1:3000/api/health` is fine; the browser is not | Not PCC. Proxy, DNS or firewall. Verification says exactly this and warns rather than blocks |

**Redeploying the previous revision** — the application only, never the data:

```bash
cd /srv/pcc && git checkout <previous-commit>
npm ci --workspaces --include-workspace-root && npm run build --workspace purchasing
sudo rsync -a --delete apps/purchasing/.next/standalone/ /opt/pcc/
sudo rsync -a apps/purchasing/.next/static/ /opt/pcc/apps/purchasing/.next/static/
sudo rsync -a apps/purchasing/public/ /opt/pcc/apps/purchasing/public/
sudo chown -R pcc:pcc /opt/pcc && sudo systemctl restart pcc
```

Update `PCC_RELEASE` to match, and re-run the verification.

> **A schema migration is the one thing that does not roll back by redeploying.** Take a backup
> before every update — `sudo systemctl start pcc-backup.service` — so the previous schema is
> always one restore away. It takes seconds and it is the difference between a rollback and an
> incident.

**Abandoning the installation entirely** is safe and leaves nothing behind but the records:
`systemctl disable --now pcc pcc-backup.timer`, remove the units and `/srv/pcc` and `/opt/pcc`.
Leave `/var/lib/pcc` and `/etc/pcc.env` alone.

---

## J. Deployment evidence

Fill this in **as it happens**, not afterwards from memory. It is the auditable record that PCC
crossed into production, and it is deliberately short.

| # | Evidence | Value |
|---|---|---|
| 1 | Deployed commit (`git rev-parse HEAD`) | |
| 2 | Installation date and time, and who performed it | |
| 3 | Verification result (A4) — paste the OVERALL line | |
| 4 | `systemctl is-enabled pcc` / `is-active pcc` | |
| 5 | First successful backup — filename and `--check` output | |
| 6 | First real authenticated user, and that they set their own password | |
| 7 | First real PO number issued | |
| 8 | Reboot verification (D6, D7) — PCC returned unaided, verification re-run | |
| 9 | Known unresolved issues, classed as in section F | |

Keep the terminal output of items 3, 5 and 8. Everything else is one line.

---

## Acceptance decision

| | |
|---|---|
| Date | |
| Deployed revision (`git rev-parse HEAD`) | |
| Verification result (A4) | |
| Verification result after reboot (D7) | |
| Real PO number issued in section C | |
| Open BUGs | |
| Open blocking frictions / missing rules | |
| **Decision** | ACCEPTED · ACCEPTED WITH FOLLOW-UPS · NOT ACCEPTED |
| Accepted by (purchasing) | |
| Accepted by (IT) | |

**ACCEPTED WITH FOLLOW-UPS is a real outcome** and usually the right one: sections A–E pass, Mike
has completed a real purchase, and what remains is a list of future improvements with names against
them. NOT ACCEPTED means an open BUG or a blocking missing rule — write it down, fix it, run the
affected section again.
