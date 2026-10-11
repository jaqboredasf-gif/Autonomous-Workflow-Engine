# PCC production deployment — evidence record

**This is the record that PCC crossed from engineering into production operation.**

Fill it in **during** the installation, not afterwards from memory. Every row is
either something observed on LIPELE-RDS02 or it is blank. There is no third
state.

> **Nothing is marked PASS unless it was demonstrated on this server, by
> somebody watching it happen.** A configuration that should work is not a pass.
> "Auto-start is enabled" is not reboot survival; the reboot is.

---

## 1. What was installed

| | |
|---|---|
| Commit SHA | `` |
| Release identifier (`RELEASE` file) | `` |
| Artifact checksum (sha256) | `` |
| Artifact built on | `` |
| Built from a clean tree? | ☐ yes ☐ no — **`-dirty` is not the installation of record** |
| Release reported by `/api/health` | `` |

The last row is the one that matters: it is the version the **running process**
claims, not the version somebody copied.

## 2. Where

| | |
|---|---|
| Server hostname | `LIPELE-RDS02` |
| Internal IP | `192.168.10.152` |
| OS / build | `` |
| Install path | `C:\Program Files\pcc` |
| Data path | `C:\ProgramData\pcc\data` |
| Config path | `C:\ProgramData\pcc\pcc.env` |
| Service name | `pcc` |
| Installation date/time | `` |
| Installed by | `` |
| Observed by | `` |

## 3. Installation

| Step | Result | Evidence | Notes |
|---|---|---|---|
| `preflight-windows.ps1` | ☐ PASS ☐ FAIL | blockers: ___ warnings: ___ | |
| `install-production.ps1` | ☐ PASS ☐ FAIL | exit code ___ | |
| Database created or opened | ☐ created (first install) ☐ opened | log line: | |
| Service registered | ☐ PASS ☐ FAIL | `sc qc pcc` | |
| Service start type | ☐ AUTO_START | | |
| Service running | ☐ PASS ☐ FAIL | `sc query pcc` | |
| Refusal policy (`AppExit 1 Exit`) | ☐ PASS ☐ FAIL | | the one that stops a misconfiguration looping |
| `/api/health` on loopback | ☐ PASS ☐ FAIL | status: | |

## 4. IIS / network

| Step | Result | Evidence |
|---|---|---|
| ARR proxying enabled | ☐ PASS ☐ FAIL | |
| Site created and started | ☐ PASS ☐ FAIL | |
| HTTP phase reachable on `192.168.10.152` | ☐ PASS ☐ FAIL ☐ skipped | |
| Certificate installed | ☐ yes ☐ not yet | thumbprint: |
| HTTPS phase reachable | ☐ PASS ☐ FAIL ☐ not yet | |
| `APP_BASE_URL` matches the scheme in use | ☐ PASS ☐ FAIL | |
| Backend port **not** reachable from another machine | ☐ PASS ☐ FAIL | tested from: |
| Inbound 443 open from LAN | ☐ PASS ☐ FAIL | |

The second-to-last row is a security check, not a formality: if port 3000
answers from another machine, a plain-HTTP sign-in form is on the network.

## 5. Persistence and recovery

| Step | Result | Evidence |
|---|---|---|
| Bootstrap admin signed in | ☐ PASS ☐ FAIL | |
| Temporary password changed | ☐ PASS ☐ FAIL | forced by schema 0039 |
| `PCC_DATABASE_ALLOW_CREATE` removed, restarted | ☐ PASS ☐ FAIL | log says "opening the existing purchasing database" |
| Backup task registered | ☐ PASS ☐ FAIL | `install-backup-task.ps1 -Verify` |
| Backup ran once, exit 0 | ☐ PASS ☐ FAIL | newest file: |
| Backup verified (not just written) | ☐ PASS ☐ FAIL | org/request/PO counts: |
| **Restore rehearsal on this server** | ☐ PASS ☐ FAIL ☐ not performed | |

Restore was demonstrated end-to-end on the build machine before deployment
(destroy → restore → application starts on the restored database). Repeating it
on RDS02 is stronger evidence and is worth the twenty minutes.

## 6. Reboot survival — **the one that cannot be inferred**

| | |
|---|---|
| Reboot performed at | `` |
| Nobody signed in afterwards | ☐ confirmed |
| `(Get-Service pcc).Status` after reboot | `` |
| `/api/health` after reboot | ☐ PASS ☐ FAIL |
| Backup task survived | ☐ PASS ☐ FAIL |
| IIS site came back | ☐ PASS ☐ FAIL |

**Until this section is filled in, `deployment/adapters/windows-service.mjs`
stays `proven: false`.** Flip it in the same commit that records this result,
and reference this document in the message.

## 7. PO sequence initialization

PCC numbers **per job+vendor pair**, counting from 1 within each pair. There is
no single starting number.

| | |
|---|---|
| Pairs with existing paper orders identified by | `` (Mike / Rick) |
| Number of pairs initialized | `` |
| Initialized by (must be an administrator) | `` |
| Source of the numbers | ☐ office paper records ☐ **never guessed** |
| Verified: next PO for an initialized pair | `` |

| Job | Vendor | Last issued (paper) | Next in PCC | Confirmed by |
|---|---|---|---|---|
| | | | | |

## 8. Acceptance

| Step | Mike | Rick | Notes |
|---|---|---|---|
| Signed in unaided | ☐ | ☐ | |
| Created a request | ☐ | ☐ | |
| Selected job and vendor | ☐ | ☐ | |
| Quantity / stock behaviour understood | ☐ | ☐ | |
| Approval | ☐ | ☐ | |
| PO number correct against paper | ☐ | ☐ | |
| PO document generated | ☐ | ☐ | |
| **Printed on the real printer** | ☐ | ☐ | |
| Marked ordered | ☐ | ☐ | |
| Received | ☐ | ☐ | |
| Found it again by search | ☐ | ☐ | |
| Survived refresh / reopen | ☐ | ☐ | |
| **Ran a full transaction with nobody driving** | ☐ | ☐ | the acceptance that matters |

**First real purchase order issued to a supplier**

| | |
|---|---|
| PO number | `` |
| Job / vendor | `` |
| Raised by | `` |
| Approved by | `` |
| Date | `` |
| Matches the office's expected next number | ☐ confirmed |

## 9. Administrator handoff

| | |
|---|---|
| Jose walked through the Day-1 checklist | ☐ |
| Jose located the logs unaided | ☐ |
| Jose restarted the service unaided | ☐ |
| Jose verified a backup unaided | ☐ |
| Jose can state the running version | ☐ |

## 10. Known limitations at go-live

Carried forward from the readiness work; add anything found on the day.

- PCC **does not send email**. It prepares drafts; a person sends from Outlook. Deliberate, enforced by tests. Microsoft 365 SMTP is future capability, not a gap.
- The rate card is a placeholder — every figure that depends on it says so.
- No batch operations; one transaction at a time.
- `PURCHASING_PERSISTENCE=local` — embedded SQLite, single server, no clustering. Correct for this deployment; a constraint to know.
- Restore requires a person; there is no automatic failover.
- ______________________________________________

## 11. Sign-off

| Role | Name | Date | Statement |
|---|---|---|---|
| Deployed by | | | The installation matches this record. |
| IT (Jose) | | | I can restart, inspect, back up and restore this system. |
| Business (Mike) | | | I can do my job in it. |
| Business (Rick) | | | I can do my job in it. |

---

**Result:** ☐ IN PRODUCTION USE ☐ CONDITIONAL — see limitations ☐ ROLLED BACK

If rolled back, what happened, and what would have to be true to try again:

```


```
