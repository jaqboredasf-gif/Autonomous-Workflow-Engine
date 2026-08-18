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

## A. Infrastructure acceptance

| # | Step | Command / where | Accept when |
|---|---|---|---|
| A1 | Install PCC | `PCC_VM_INSTALLATION_RUNBOOK.md`, Steps 1–12. **Clone `--branch pcc-production`** | The runbook's own checks pass |
| A2 | Configure environment and secrets | `/etc/pcc.env`, from `.env.example`. `SESSION_SECRET` generated **on the server** by IT | `PCC_DATABASE_PATH`, `APP_BASE_URL`, `PCC_PO_NUMBERING`, `SESSION_SECRET`, `PCC_RELEASE` all set |
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
| C9 | Check the printed contents | Job, vendor, item, all three quantities, PO number, company details — everything Mike needs on the workshop copy |
| C10 | Print it on the workshop printer | A usable physical copy, from the browser, on the PC Mike actually uses |
| C11 | Generate the vendor email draft | Draft exists and names the PO |
| C12 | Check recipient and content | Correct vendor address and body. **PCC cannot send** — it is sent from a person's own mailbox |
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
