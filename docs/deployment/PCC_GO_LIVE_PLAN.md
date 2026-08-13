# PCC — go-live plan

How PCC gets from a proven image to Lippolis purchasing on it, without a day where nobody can buy
anything.

**To install PCC, follow `PCC_VM_INSTALLATION_RUNBOOK.md` in the repository root** — that is the
authoritative, step-by-step procedure. This document is the surrounding plan: what happens before
and after the install.

Companion documents: `PCC_PRODUCTION_ARCHITECTURE.md` (what it is),
`PCC_IT_DEPLOYMENT_HANDOFF.md` (how to run it), `PCC_IT_INSTALLATION_PACKET.md` (what IT must
provide), `PCC_PRODUCTION_PILOT_CHECKLIST.md` (the boxes on the day).

---

## 1. Purchase order numbers — the rule, and what is left of the gate

**The rule, from Mike and Paul on 2026-08-12:** a purchase order number is the job number, the
vendor, and a number that counts from 1 — and it counts **separately for each job and each
vendor**.

```
   1234-COOPER-1     1234-COOPER-2     1234-GRAYBAR-1     5678-COOPER-1
```

Everything else on this page can be corrected afterwards. Numbering cannot: a number issued twice —
once on paper, once by PCC — is a conversation with a supplier about which invoice matches which
order, and a number cannot be un-issued. That is still true. What has changed is that there is no
longer a single number for anybody to supply, so the gate is now much narrower.

**What the application already guarantees** (tested, not asserted):

| Requirement | How it is met | Evidence |
|---|---|---|
| The number follows the rule the office uses | `job-vendor-sequence`, counting from 1 for each (job, vendor) pair, built in one domain function | `eval-purchasing-domain.mjs`: *purchase order numbers: job + vendor + sequence* |
| Pairs do not interfere | Job A/vendor X counts 1,2,3 while job A/vendor Y and job B/vendor X each start again at 1 | `eval-purchasing.mjs`: *the sequence belongs to the job AND the vendor* |
| Two people cannot get the same number | One atomic upsert per pair inside the transaction that writes the order; eight concurrent workers issue 1..40 with no duplicate **and no gap** | `eval-purchasing.mjs`: *PO numbering under real concurrency* |
| An issued number never changes | Permanent by trigger; the job number and vendor code are snapshotted onto the order, so renaming either changes nothing | `eval-purchasing.mjs`: *a vendor rename does not renumber anything* |
| Nothing is burned by a page refresh | Allocated at issuance only, and asking twice returns the same number without advancing the counter | `eval-purchasing.mjs`: *the number is allocated at issuance, and only once* |
| A pair's count can be lined up with the paper book | Administration → PO numbering, behind `admin.po_config`, forward-only, refused at or below anything PCC has issued, audited | `eval-purchasing.mjs`: *a pair whose paper sequence already ran* |
| A restart or a restore does not rewind it | The counters are rows; verified on a reopened database and on a restored instance | `eval-purchasing.mjs`: *survives a restart*; `eval-restore-rehearsal.mjs` |
| An existing installation upgrades safely | The old global uniqueness is rebuilt away with every order, line item and foreign key intact, and re-running changes nothing | `eval-purchasing.mjs`: *upgrading a database numbered the old way* |
| An issued number cannot be edited or deleted, on the pilot store too | Triggers on `purchase_orders` in **both** providers; carried across the upgrade rebuild rather than dropped with the table | `eval-purchasing.mjs`: *the purchase order number is still permanent after the rebuild* |
| A pair already in use is not moved by accident | Refused (`sequence_already_issued`) unless the administrator acknowledges the count PCC has already issued; backwards stays refused either way | `eval-purchasing.mjs`: *a pair already in use cannot be moved by accident* |
| "No paper history" is a recorded answer, not an absence | *Confirm as new* writes the decision; the verifier separates settled pairs from unasked ones | `pcc-verify-production.mjs`; `eval-purchasing.mjs` |
| The two providers cannot drift on the format | Postgres must build the number inside its allocator to stay atomic, so the SQL expression is asserted against the domain's own separator and `formatPoNumber` output | `validate-migration-0016.mjs`, via *migration parity* |
| The whole purchase carries one identifier | Four complete purchases — request → review → approve → number → print → email → ordered → received → completed — checked into the PDF, the draft, the receipt, the queue row and the immutable history | `eval-purchasing.mjs`: *the whole purchase, four times, watching the number* |

**The rule came from Mike and Paul on 12 August 2026 and is implemented as given.** The previous
requirement on this row — "the next number in the paper book" — was asking for something that does
not exist: there is no single Lippolis sequence to continue, so there is no one number to supply.

> **STATUS: GREEN, with one narrow external question.** Nothing is blocked. The mechanism is done
> and proven, and a fresh installation issues correct numbers on its first day without anybody
> configuring anything.
>
> **What still needs the office:** two answers, neither of which PCC can derive.
> 1. **Per job and vendor:** has a purchase order ever been written by hand for it? *Yes* → set the
>    pair to where it had reached. *No* → *Confirm as new*. Both are recorded; leaving it unanswered
>    is the only unsafe option, and is what the verifier reports.
> 2. **Vendor codes:** `GRAYBAR` or `GRAYBARELECTRIC`? Changeable until that vendor's first order,
>    fixed afterwards.
>
> See §1 of `PCC_PURCHASING_GO_LIVE.md`, and *Phase B setup* in `PCC_VM_INSTALLATION_RUNBOOK.md`
> for the exact click order.

`scripts/pcc-verify-production.mjs` sorts every pair into four states — **in use**, **continued
from paper**, **confirmed new**, **unresolved** — and lists every active job nobody has been asked
about, with the exact operator action for each. The question is asked by the go/no-go check rather
than remembered.

---

## 2. The controlled pilot

PCC does not go from a laptop to company-wide use. Three phases, each with a condition for moving
on. **Do not start a phase until the previous one has held.**

### Phase A — production smoke test *(controlled data, no real purchasing)*

Deploy onto the Lippolis VM and prove the installation, using test data that nobody depends on.

- [ ] Application starts; `[pcc] creating a NEW purchasing database` appears **exactly once**
- [ ] `GET /api/health` returns `"status":"ok"`; `GET /api/health/live` returns `"alive"`
- [ ] Bootstrap administrator signs in; the temporary password is changed
- [ ] `PCC_DATABASE_ALLOW_CREATE` and `PCC_BOOTSTRAP_ADMIN_PASSWORD` removed from the environment
- [ ] Restart: the log says `opening the existing purchasing database`
- [ ] A test user is invited, signs in, and is refused what their role forbids
- [ ] Test request → workshop review → approval → **PO generated and printed on the office
      printer**, checked against a paper PO
- [ ] Vendor email draft composed, reviewed, approved, and marked sent by a person
- [ ] Marked ordered; a delivery received **with a photograph attached**; the photograph opens
      again from the receipt screen
- [ ] The activity history reads correctly to somebody who was not involved
- [ ] Backup taken and verified; **restore rehearsed on a throwaway copy**, not on the VM's data
- [ ] **VM rebooted**, and PCC comes back with nobody logging in
- [ ] Test data removed, or the database recreated clean before Phase B

**Move on when:** every box is ticked and the printed PO is one the office would accept.

### Phase B — limited real workflow *(real purchasing, few people)*

The purchasing stakeholders already associated with PCC — Mike and Rick, plus one or two foremen
on live jobs. **No new users, no new policy.**

- [ ] Every job-and-vendor pair with existing paper POs has been set (§1) — **before the first
      request on that job**
- [ ] Real vendors and real active jobs entered
- [ ] Real purchase requests raised and run end to end, alongside the paper process
- [ ] The paper book and PCC are reconciled at the end of each week, per job and vendor — no number
      issued twice
- [ ] Failure points recorded as they happen, not remembered afterwards
- [ ] A nightly backup has actually run, and one has been restored at least once

**Move on when:** two weeks of real purchasing have run without an incident that made somebody
reach for paper mid-order, and the reconciliation shows no PO number collisions.

### Phase C — operational adoption

Widen to the rest of the purchasing workflow. Retire the paper fallback only when Phase B has been
uneventful and IT is comfortable with restart, backup and restore.

Not planned here in detail on purpose: what Phase C looks like depends on what Phase B teaches,
and writing it now would be inventing business policy that is Lippolis's to set.

---

## 3. Rollback — PCC failure must not stop purchasing

**The paper process remains the fallback for the whole pilot.** Nobody stops buying material
because a web application is down; they do what they did before. The only thing that needs care is
the purchase order numbers, because that is the one place the two systems share state.

### If PCC is unavailable

1. **Raise the order on paper**, exactly as before PCC.
2. **Take the next number for that job and vendor from the paper book**, not from PCC.
3. **Write down every paper PO number issued during the outage** — this list is what reconciles the
   two systems afterwards.
4. Tell whoever owns the application (§4) that PCC is down and roughly when it happened.

### When PCC comes back

**The sequence is the whole problem.** PCC's counter did not advance while it was down; the paper
book did. If PCC is simply switched back on it will issue numbers the vendors already have.

1. **Before anybody raises a request in PCC**, look at the paper list from step 3.
2. Set PCC's next number in Administration → Organization to **one above the highest number issued
   on paper.** The sequence only moves forward, so this is always allowed and never destructive —
   it leaves a gap, and *a gap is not a problem; a duplicate is.*
3. Enter the paper orders into PCC afterwards **only if the office wants them in the record** —
   and if so, with their real paper numbers, so the history matches the invoices.
4. Confirm with a test: the next PO PCC generates must be higher than every paper one.

### If the data is lost, not just the application

Restore from backup (`PCC_IT_DEPLOYMENT_HANDOFF.md` §8), then run the same sequence reconciliation
— a restored database's counter reflects the backup, so it may be **behind** the numbers already
issued. This is exactly the case step 2 covers.

> **The rule, in one line:** *PCC's number must never be lower than the highest number any vendor
> has already seen.*

---

## 4. Who owns what

Three parties, one page. Roles, not names — assigning a person is Lippolis's call and this document
should not pretend that conversation has happened.

| | Lippolis IT | PCC application owner | Purchasing operations |
|---|---|---|---|
| | VM availability and capacity | Application releases | The real PO sequence |
| | Network, firewall, remote access | Database migrations | Purchasing policy |
| | HTTPS, certificates, reverse proxy | Application configuration | Vendor and job directories |
| | Host-level backup platform, schedule, retention, offsite | Application logs and defects | Workflow correctness |
| | Host restart and first-line "is it up?" | Workflow behaviour and changes | User acceptance |
| | OS patching | The backup/restore *tooling* | Deciding when a phase has held |

**The seam that matters:** IT owns *whether the machine and the network are working*; the
application owner owns *whether PCC is working*; purchasing owns *whether PCC is doing the right
thing*. A purchase order with a wrong number is a purchasing problem, not an IT one — and a
container that will not start is not something to ask Mike about.

**Unassigned and needed:** who restarts it at 7am (IT question #9). Until somebody's name is
against that, the operational owner is whoever happens to be reachable, which is not an answer.

---

## 5. The go-live gate

**GREEN** = tested and operable, with evidence. **YELLOW** = a known limitation or external
dependency that does not block the next step. **RED** = cannot safely begin the controlled pilot.

No status here is GREEN because a document describes it.

| # | Requirement | Status | Evidence | Owner | Action required |
|---|---|---|---|---|---|
| 1 | Application boot | 🟢 | Container starts; preflight refuses a misconfigured production start and exits non-zero | App owner | — |
| 2 | Production configuration | 🟢 | One validated module; `/api/health` reports which variable is wrong without printing its value | App owner | — |
| 3 | Persistent storage | 🟢 | Data survives container destroy/recreate; refuses to create a second database on an unmounted volume | App owner | — |
| 4 | Database | 🟢 | Idempotent migrations on start; version stamped after migrating; 354 integration checks | App owner | — |
| 5 | Authentication | 🟢 | Bootstrap admin + invited user both sign in; demo accounts refused in production; survives restore | App owner | — |
| 6 | Authorization | 🟢 | Foreman refused administration on the restored instance; per-screen checks with the real user | App owner | — |
| 7 | Purchasing workflow | 🟢 | Request → review → approval → PO → vendor email → ordered, end to end through the web interface | App owner | — |
| 8 | Receiving | 🟢 | Delivery signed for with a packing slip attached; receipt opens with its number | App owner | — |
| 9 | **PO numbering** | 🟢 | Numbered `job-vendor-sequence` per the rule Mike and Paul gave on 2026-08-12. Counts per (job, vendor), concurrency-safe with no gaps, permanent under rename, survives restart and restore, upgrades an existing database without touching an issued number | App owner | Office names any job/vendor pair that already has paper POs (§1) — a narrow data question, not a blocker |
| 10 | Audit / history | 🟢 | Append-only, enforced by delete triggers; history survives restore | App owner | — |
| 11 | Health check | 🟢 | Readiness and liveness both answered by the running container | App owner | — |
| 12 | Logging | 🟢 | JSON to stdout, redacted by field name, emails masked; startup lines prefixed `[pcc]` | App owner | — |
| 13 | Backup | 🟢 | Online backup while serving; verifies what it wrote | App owner | Schedule it on the VM |
| 14 | **Restore** | 🟢 | **Rehearsed end to end: 23 checks against a restored instance, attachments byte-for-byte, source untouched** (`scripts/restore-rehearsal.sh`) | App owner + IT | Re-run on the VM once, after install |
| 15 | Restart supervision | 🟡 | Both systemd units written and reviewed; **not installed anywhere, and the VM OS is unknown** | IT | Confirm OS; install a unit; reboot once |
| 16 | **VM provisioned** | 🔴 | **Does not exist yet** | IT | Provision it |
| 17 | Network access | 🟡 | PCC needs only a port behind a proxy; the model is undecided | IT | Decide LAN/VPN vs external |
| 18 | HTTPS | 🟡 | PCC expects TLS terminated in front and marks cookies `Secure` in production | IT | Terminate TLS; forward `Host` and `X-Forwarded-Proto` |
| 19 | Field access | 🟡 | Works behind any HTTPS endpoint; foremen must reach it from a job site | IT | Follows from #17 |
| 20 | Pilot plan | 🟢 | §2 above, with conditions for each phase | App owner + Purchasing | Agree the Phase A date |
| 21 | Rollback procedure | 🟢 | §3 above, including PO sequence reconciliation | Purchasing + App owner | Mike reads §3 before Phase B |
| 22 | Attachment storage growth | 🟡 | Inline by design; triggers and monitoring commands documented | IT | Watch `/data/backups` |
| 23 | Identity provider | 🟡 | PCC's own credentials today; Entra is an adapter behind an existing interface | IT | Decide now or after the pilot |

**One RED: the VM.** Everything the application controls is either green or is an external
decision. Nothing on this page is waiting on more code.

---

## 6. What each party does next

### Jack — application owner

1. Hand `PCC_IT_INSTALLATION_PACKET.md` to Jose and get the ten answers.
2. On the VM, once it exists: install, run Phase A, install a supervision unit, reboot it.
3. Re-run `bash scripts/restore-rehearsal.sh` against the real deployment's backup once.
4. Do **not** set the PO sequence yourself.

### Jose / Lippolis IT

1. Provision the VM: **2 vCPU, 4 GB RAM, 50 GB expandable** (rationale in
   `PCC_PRODUCTION_ARCHITECTURE.md` §8).
2. Answer the ten questions in the installation packet — items 1–7 block installation.
3. Terminate HTTPS in front of PCC and decide the access model.
4. Point the existing backup system at the backup directory, and the existing monitoring at
   `/api/health`.
5. Name who restarts it at 7am.

### Mike / purchasing

1. **Name any job-and-vendor pair that already has purchase orders written on paper**, and where
   the count had reached for each. Pairs with no paper behind them need nothing — they start at 1.
2. Confirm the vendor codes PCC derived from the vendor names, or supply shorter ones.
3. Supply the real vendor list with ordering contacts, and the real active jobs.
4. Read §3 (rollback) before Phase B, so the paper fallback is understood before it is needed.
5. Decide the three open questions in the pilot checklist: taxable handling, unit price on the
   vendor's copy, ship-via.
