# PCC — LIPELE-RDS02 execution package

Operational. Read it with the server in front of you.

Companion documents: `PCC_PRODUCTION_EVIDENCE.md` (fill in as you go),
`config/production.env.template` (every setting, and who supplies it).

| | |
|---|---|
| Commit | whatever `apps/purchasing/RELEASE` in the artifact says — it is stamped at build time |
| Artifact | `PCC-<commit>.zip`, with `PCC-<commit>.zip.sha256` beside it |
| Server | LIPELE-RDS02 · 192.168.10.152 · Windows Server 2019 Standard |
| Backend | `127.0.0.1:3000` — loopback only |
| Front door | IIS, HTTPS 443, LAN only |

> The commit and checksum are deliberately **not** written into this document.
> They change with every build, and a runbook carrying a stale hash is worse
> than one carrying none — somebody verifies against it, it does not match, and
> the deployment stops for the wrong reason. The artifact carries its own
> identity in `RELEASE`; record both in `PCC_PRODUCTION_EVIDENCE.md` §1 on the
> day.

---

## 1. Live deployment checklist

Stop at the first failure. Every step is idempotent; re-running after a fix is safe.

### PRE-INSTALL

| # | Action | Expected | If it fails |
|---|---|---|---|
| 1 |  Copy `PCC-<commit>.zip` to the server; verify against its `.sha256` file | hash matches | re-copy; a bad transfer is not a deployment |
| 2 | Right-click → Properties → **Unblock** → extract to `C:\pcc-artifact` | files present | |
| 3 | `New-Item -ItemType Directory -Force -Path C:\ProgramData\pcc\data` | created | **the installer will not create this** — deliberate |
| 4 | Copy `config\production.env.template` → `C:\ProgramData\pcc\pcc.env`, fill in | every value | see §3 |
| 5 | Generate the secret into it: `[Convert]::ToBase64String((1..48\|%{Get-Random -Max 256}))` | 64+ chars | never let a script invent it |
| 6 | `.\scripts\preflight-windows.ps1` | **0 blockers** | **STOP.** Fix infrastructure before installing |

### INSTALL

| # | Action | Expected | If it fails |
|---|---|---|---|
| 7 | `.\scripts\Deploy-PCCProduction.ps1 -FirstInstall -Artifact C:\pcc-artifact` | runs steps 1–4, ends INSTALLED | it stops at the failing step and names it |
| 8 | Read the release line | the expected commit, **no `-dirty`** | a dirty artifact is not the installation of record |
| 9 | `Invoke-RestMethod http://127.0.0.1:3000/api/health` | `status: ok` | `Get-Content C:\ProgramData\pcc\logs\pcc.err.log -Tail 50` |

### CONFIGURE

| # | Action | Expected | If it fails |
|---|---|---|---|
| 10 | `.\scripts\Configure-PCCIIS.ps1 -Phase Http` | reachable on `http://192.168.10.152` | backend checked first — if that is healthy, it is the proxy |
| 11 | From **another** machine: browse to it | sign-in page, styled, logo | unstyled ⇒ `.next/static` missing |
| 12 | From another machine: `Test-NetConnection 192.168.10.152 -Port 3000` | **must FAIL** | if it succeeds the backend is exposed — fix before going further |
| 13 | Sign in as bootstrap admin | forced password change | |
| 14 | Change the password | accepted | |
| 15 | Remove `PCC_DATABASE_ALLOW_CREATE` and `PCC_BOOTSTRAP_ADMIN_PASSWORD`; `nssm restart pcc` | log: *opening the existing purchasing database* | if it says *creating*, the data path is wrong — **stop** |

### VERIFY

| # | Action | Expected |
|---|---|---|
| 16 | `node scripts\pcc-verify-deployment.mjs --service pcc` | **READY FOR ACCEPTANCE TESTING** |
| 17 | `.\scripts\install-backup-task.ps1 -Verify` | task exists, enabled, last result 0 |

### REBOOT — the one that cannot be inferred

| # | Action | Expected | If it fails |
|---|---|---|---|
| 18 | `Restart-Computer` | server returns | |
| 19 | **Sign in to nothing.** `(Get-Service pcc).Status` | `Running` | `sc qc pcc` → START_TYPE must be AUTO_START |
| 20 | `Invoke-RestMethod https://192.168.10.152/api/health` | `status: ok` | |
| 21 | `.\scripts\install-backup-task.ps1 -Verify` | still enabled | |
| 22 | Record it in `PCC_PRODUCTION_EVIDENCE.md` §6, then flip the adapter to `proven: true` | committed | **only now** |

### HTTPS (when the certificate arrives)

| # | Action | Expected |
|---|---|---|
| 23 | `Get-ChildItem Cert:\LocalMachine\My` → note thumbprint | present, unexpired |
| 24 | `.\scripts\Configure-PCCIIS.ps1 -Phase Https -CertThumbprint <tp>` | reachable on https |
| 25 | Set `APP_BASE_URL=https://…`, **delete** `PCC_ALLOW_INSECURE_HTTP`, `nssm restart pcc` | sign-in works |

> If you skip step 25 every sign-in bounces back to the sign-in page while
> health stays green: the cookie becomes `Secure` and the browser stops
> returning it over plain HTTP. This is the single most confusing failure in
> the whole deployment.

### BACKUP / RESTORE

| # | Action | Expected |
|---|---|---|
| 26 | `node scripts\pcc-backup.mjs --db C:\ProgramData\pcc\data\pcc.sqlite --check` | verified, with org/request/PO counts |
| 27 | *(optional, recommended)* restore rehearsal into a scratch path | app starts on the restored copy |

Restore was already demonstrated end-to-end on the build machine — destroy →
restore → application starts on the restored database, identical row counts.
Repeating it here is stronger evidence.

---

## 2. PO sequence initialization — read before the first live PO

**PCC numbers per job + vendor PAIR, counting from 1 within that pair.**
`1234-COOPER-1`, `1234-COOPER-2`, then `1234-GRAYBAR-1` starts again at 1.

There is **no single starting PO number**, and asking the office for "the next
PO number" will produce a wrong answer to a question PCC does not ask.

**What to collect from Mike/Rick before go-live:** for every job+vendor pair
that **already has paper purchase orders**, the last number issued on paper.
Pairs with no paper history need nothing — they start at 1 correctly.

**Procedure**

1. Administrator signs in → **Admin → PO numbering**.
2. For each pair with paper history, enter job number, vendor, and the **last issued** sequence.
3. PCC computes the next. The screen says *"Only for pairs that already have paper orders. **Do not guess a number.**"*
4. Record every pair in `PCC_PRODUCTION_EVIDENCE.md` §7.

**Guards that already exist**
- Only an administrator can call it (`initializePoSequence`, authorization-tested).
- A pair for which PCC has **already issued** POs requires `acknowledgeIssued` — moving it is legitimate (an office correcting a gap) but never accidental.
- `PCC_PO_NUMBERING` is refused at startup if unset, so no installation can reach a PO with no rule.
- A malformed or below-first sequence is rejected (`invalid PO sequence value`).

**First-live-PO validation:** raise one real PO for a pair with paper history,
and confirm the number PCC issues is exactly the office's expected next number
**before** it goes to the supplier. A PO number cannot be withdrawn once a
supplier has it.

---

## 3. Configuration — who supplies what

Full detail in `config/production.env.template`. Summary:

| Setting | Who | Secret | Refuses to start |
|---|---|---|---|
| `NODE_ENV`, `PORT`, `HOSTNAME` | deployment | no | `NODE_ENV` yes |
| `PCC_ORG_NAME` | business | no | no |
| `PCC_ORG_ADDRESS`, `PCC_ORG_PHONE` | business | no | **yes** |
| `PCC_PO_NUMBERING` | business | no | **yes** |
| `PCC_DATABASE_PATH` | IT | no | **yes** |
| `PCC_DATABASE_ALLOW_CREATE` | deployment, first start only | no | guards creation |
| `APP_BASE_URL` | IT | no | **yes** |
| `PCC_ALLOW_INSECURE_HTTP` | deployment, temporary | no | gates plain HTTP |
| `SESSION_SECRET` | **generated on the server** | **yes** | **yes** |
| `PCC_BOOTSTRAP_ADMIN_*` | Jack/deployment | password: **yes** | first start only |
| `PCC_RELEASE` | **set by the installer** | no | no |

---

## 4. Jose — Day-1 administrator checklist

Run these yourself, once, with nobody helping. If any line is unclear, say so
before Jack stops being around every day.

| Question | Command | Expected |
|---|---|---|
| Is the service there? | `Get-Service pcc` | Running |
| Will it survive a reboot? | `sc qc pcc` | `START_TYPE : 2 AUTO_START` |
| Is the app healthy? | `Invoke-RestMethod http://127.0.0.1:3000/api/health` | `status: ok` |
| **Which version is running?** | same command, read `release` | the commit from `RELEASE` |
| Is IIS up? | `Get-Service W3SVC` | Running |
| Where are the app logs? | `Get-Content C:\ProgramData\pcc\logs\pcc.err.log -Tail 50` | |
| Where are IIS logs? | `C:\inetpub\logs\LogFiles` | |
| Where is the data? | `C:\ProgramData\pcc\data\pcc.sqlite` | back this up |
| Is the backup scheduled? | `.\scripts\install-backup-task.ps1 -Verify` | enabled, last result 0 |
| Is the newest backup usable? | `node scripts\pcc-backup.mjs --db C:\ProgramData\pcc\data\pcc.sqlite --check` | verified + counts |
| How do I restart it? | `nssm restart pcc` | |
| How do I check everything? | `node scripts\pcc-verify-deployment.mjs` | READY FOR ACCEPTANCE TESTING |
| How do I restore? | `node scripts\pcc-restore.mjs --from <backup> --db <live> --force` | then restart, then health |

**Troubleshooting order** — stop at the first failure:

1. Server alive? → RDP in
2. IIS alive? → `Get-Service W3SVC`
3. PCC service alive? → `Get-Service pcc`
4. Health answers on loopback? → if yes and the site does not, it is IIS
5. Can it open the database? → `pcc.err.log`
6. Disk full? → `Get-PSDrive C`
7. Last backup? → `-Verify`

**Do not casually change:** `SESSION_SECRET` (signs everyone out) ·
`PCC_DATABASE_PATH` (points at a different or empty company) ·
`PCC_PO_NUMBERING` (changes how POs are numbered mid-life) ·
`PCC_ORG_ADDRESS`/`PHONE` (no longer read after first start — editing them
changes nothing and misleads) · the service's `AppExit` policy (a
misconfiguration would then restart forever instead of stopping with a
readable reason).

**If PCC will not start:** it usually *refused* rather than crashed. The last
lines of `pcc.err.log` name the variable. A refusal exits 1 and stays stopped
by design.

---

## 5. Mike / Rick acceptance script

Two rounds. Round 1 guided; **Round 2 unaided — that is the acceptance that
counts.** Record PASS/FAIL per step in `PCC_PRODUCTION_EVIDENCE.md` §8.

| # | Step | Expected | Who |
|---|---|---|---|
| 1 | Open `https://192.168.10.152` (or the hostname) | sign-in page, styled, logo | Mike, Rick |
| 2 | Sign in with own account | own dashboard | Mike, Rick |
| 3 | Change password at first prompt | accepted | Mike, Rick |
| 4 | Create a purchase request | request created, listed | Mike |
| 5 | Select a real job | job appears and attaches | Mike |
| 6 | Select a real vendor | vendor attaches | Mike |
| 7 | Enter quantity; observe stock behaviour | stock-aware quantity as expected | Mike |
| 8 | Submit for approval | status → awaiting approval | Mike |
| 9 | Approve (authorized approver) | status → approved | Rick |
| 10 | Confirm a non-approver **cannot** approve | refused | Rick |
| 11 | Generate the PO | PO created with a number | Rick |
| 12 | **Check the PO number against paper** | matches expected next | Mike + Rick |
| 13 | Open the PO document | job, vendor, quantities, company address and phone all correct | Mike |
| 14 | **Print to the real office printer** | usable paper copy | Mike |
| 15 | Mark ordered | status → ordered | Rick |
| 16 | Receive (full or partial) | status reflects receipt | Mike |
| 17 | Attach delivery evidence if used | stored, reopens | Mike |
| 18 | Find it by search | found | Rick |
| 19 | Refresh and reopen | identical | Mike, Rick |
| 20 | Sign out, sign in, reopen | identical | Rick |
| **21** | **Full transaction, start to finish, with nobody driving the screen** | completed unaided | **Mike, then Rick** |

Feature requests raised during acceptance go in a list, **not into this
deployment**. Log them; do not build them.

---

## 6. Rollback

| Situation | Action |
|---|---|
| New version misbehaves, data untouched | Reinstall the previous artifact: `Deploy-PCCProduction.ps1 -Artifact <old>` (no `-FirstInstall`). The data directory is never touched by an install. |
| Data affected | Stop service → `pcc-restore.mjs --from <pre-update backup> --force` → start → health |
| Configuration change broke it | The env file is a plain file — restore the previous copy and `nssm restart pcc` |
| Cannot recover | The database file is self-contained: copy the newest verified backup off the server and escalate |

**Before every future update:** take a backup (`pcc-backup.mjs`), note the
current `release` from `/api/health`, and keep the previous artifact directory
until the new one has run for a week. That is the whole update procedure —
versioned artifact, pre-update backup, controlled restart, verification,
documented rollback. No CI/CD platform required.

---

## 7. What Jose still needs to provide

> **PCC on LIPELE-RDS02 (192.168.10.152) — outstanding IT items**
>
> **Install:**
> 1. **Node.js 24 LTS (x64 MSI)** — PCC will not start on 20 or 22.
> 2. **IIS**: `Install-WindowsFeature Web-Server -IncludeManagementTools`
> 3. **URL Rewrite 2.1** — https://www.iis.net/downloads/microsoft/url-rewrite
> 4. **Application Request Routing 3.0** — https://www.iis.net/downloads/microsoft/application-request-routing
> 5. **NSSM** — one signed exe in `C:\Program Files\nssm`, added to PATH. Supervises the PCC process.
>
> **Certificate:** one LAN-usable TLS certificate in `LocalMachine\My`. Internal CA preferred over self-signed so nobody sees a browser warning. *Not needed to begin — we validate over HTTP on the IP first.*
>
> **Firewall:**
> - **Inbound TCP 443 from the LAN.** The only port users touch.
> - Inbound TCP 80 — optional, redirect only.
> - **Do not open TCP 3000.** It binds to loopback; IIS reaches it there.
> - **No database port** — PCC uses an embedded SQLite file; there is no database server.
> - No outbound rules needed at runtime. Internet only to download items 1–4.
>
> **Backup:** include `C:\ProgramData\pcc\data` in the RDS02 rotation. That directory is the entire purchasing record. PCC also takes its own verified nightly copy at 01:30 into `...\data\backups` (keeps 30); offsite retention and encryption remain yours.
>
> **Accounts/permissions:** none to create. The service runs as the virtual account `NT SERVICE\pcc` — no password to issue or rotate, no interactive logon. Our installer applies the file permissions.
>
> **SSH:** not required, not used. RDP + PowerShell only.
>
> **DNS:** nothing yet. When ready, an internal A record `pcc.lippoliselectric.com → 192.168.10.152`. One line of config on our side; no rebuild.
>
> **Internet exposure:** none.

---

## 8. RDS02 proof register

The twenty things that can only be proven on the server. Each row is a command,
what a pass looks like, what a failure looks like, and what to do about it.
Written so somebody who is not Jack can execute it.

Record every result in `PCC_PRODUCTION_EVIDENCE.md`. Nothing here is a pass
because it "should" work.

| # | Proof | Command | PASS | FAIL | Remediation |
|---|---|---|---|---|---|
| 1 | PowerShell preflight | `.\scripts\preflight-windows.ps1` | `READY TO INSTALL`, 0 blockers | any BLOCKER line | each blocker names its own fix; clear and re-run |
| 2 | Node version | `node --version` | `v24.x` or higher | v20/v22, or not found | install Node 24 LTS x64 MSI |
| 3 | NSSM present | `nssm version` | prints a version | not recognised | place `nssm.exe` in `C:\Program Files\nssm`, add to PATH |
| 4 | Service registration | `.\scripts\Deploy-PCCProduction.ps1 -FirstInstall` | ends `INSTALLED` | stops at a named step | the step names the fix; re-run (idempotent) |
| 5 | Service startup | `Get-Service pcc` | `Status: Running` | `Stopped` | `Get-Content C:\ProgramData\pcc\logs\pcc.err.log -Tail 50` — a refusal exits 1 and stays stopped by design |
| 6 | Service restart | `nssm restart pcc` then `Get-Service pcc` | `Running` within 30s | stays `Stopped` | read err.log; a configuration refusal names the variable |
| 7 | Automatic startup | `sc qc pcc` | `START_TYPE : 2 AUTO_START` | `DEMAND_START` | `sc config pcc start= auto` |
| 8 | Refusal policy | `nssm get pcc AppExit 1` | `Exit` | `Restart` | `nssm set pcc AppExit 1 Exit` — otherwise a misconfiguration loops forever |
| 9 | **Reboot survival** | `Restart-Computer`; sign in to nothing; `(Get-Service pcc).Status` | `Running` | `Stopped` | check 7, then err.log |
| 10 | IIS site | `.\scripts\Configure-PCCIIS.ps1 -Phase Http` | ends `PCC is reachable at http://192.168.10.152/` | proxy error | it checks the backend first — if that is healthy, the fault is IIS |
| 11 | ARR proxying | `Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name enabled` | `True` | `False` | re-run Configure-PCCIIS.ps1 |
| 12 | HTTPS binding | `.\scripts\Configure-PCCIIS.ps1 -Phase Https -CertThumbprint <tp>` | reachable on `https://` | binding error | check the thumbprint exists in `LocalMachine\My` and is unexpired |
| 13 | Firewall 443 open | from another machine: `Test-NetConnection <host> -Port 443` | `TcpTestSucceeded: True` | False | Jose opens 443 inbound from the LAN |
| 14 | **Backend 3000 restricted** | from another machine: `Test-NetConnection 192.168.10.152 -Port 3000` | **`TcpTestSucceeded: False`** | True | **stop — a plain-HTTP sign-in form is on the network.** Confirm PCC binds `127.0.0.1` and no firewall rule opens 3000 |
| 15 | Backup task | `.\scripts\install-backup-task.ps1 -DataDir C:\ProgramData\pcc\data -Repo "C:\Program Files\pcc" -EnvFile C:\ProgramData\pcc\pcc.env -RunNow` | task created, exits 0 | non-zero LastTaskResult | `Get-Content C:\ProgramData\pcc\logs\pcc-backup.log -Tail 40` |
| 16 | Backup verified | `node scripts\pcc-backup.mjs --db C:\ProgramData\pcc\data\pcc.sqlite --check` | `verified — integrity ok` with org/request/PO counts | `FAILED verification` | take a new backup; treat the old one as unusable |
| 17 | **Restore proof** | stop service; `node scripts\pcc-restore.mjs --from <backup> --db <scratch path> --force` | `restored … N request(s) readable` | refusal | **restore refuses while the app is answering** — stop the service first. That refusal is correct. |
| 18 | Production login | browse to the site, sign in as each real user | dashboard; first sign-in forces a password change | sign-in loops back to the sign-in page | `APP_BASE_URL` scheme does not match how you reached it — the cookie is `Secure` and is not being returned |
| 19 | Printer | open a generated PO, print | legible on the office printer | no printer / wrong tray | Windows printer configuration; not PCC |
| 20 | Production transaction | request → review → approve → PO → draft read → ordered → receive → complete | status `COMPLETED`, PO number matches the paper book | any refusal | the refusal names the reason; do not work around it |

**Rollback**

| Situation | Action |
|---|---|
| New version misbehaves, data untouched | reinstall the previous artifact: `Deploy-PCCProduction.ps1 -Artifact <old>` (no `-FirstInstall`). The data directory is never touched by an install. |
| Data affected | stop service → `pcc-restore.mjs --from <pre-update backup> --force` → start → health |
| Configuration broke it | restore the previous `pcc.env` and `nssm restart pcc` |
| Cannot recover | the database file is self-contained: copy the newest verified backup off the server and escalate |

**Proven locally before RDS02, so a failure here is environmental rather than logical:**
backup creation and verification, restore into a clean instance, application start
on a restored database, byte-identical state across a backup→destroy→restore
round trip, database initialization and refusal to re-initialize, import
convergence, every authorization path, the full purchase-order lifecycle, and
every refusal listed in §9 of the readiness audit.
