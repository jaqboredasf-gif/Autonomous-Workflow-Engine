# PCC — production pilot checklist

For the **installer + Lippolis IT**, worked top to bottom on the day. Nothing here is optional in the sense
of "probably fine": every unchecked box in §1–§4 is a way the pilot fails in front of Mike.

Two commands do most of the verification for you:

```bash
node scripts/check-deployable.mjs                 # is the IMAGE safe to ship?
node scripts/pcc-verify-production.mjs --db /data/pcc.sqlite --strict
                                                  # is the DATABASE fit for real work?
```

The second one is the important one on the day. It reports demonstration accounts, seeded vendors
and jobs, an unset PO sequence, a missing workshop, and anything else that would make the first
morning confusing. **Run it, and read what it says, before anybody signs in.**

Technical detail on the deployment itself lives in `PCC_IT_DEPLOYMENT_HANDOFF.md`. This is the
go/no-go list.

---

## 1. Infrastructure — IT

- [ ] Server or VM exists, named, and the installer knows its hostname/IP
- [ ] OS and version recorded: ______________________
- [ ] Docker (or Podman) installed and a non-root user can run containers
- [ ] Persistent storage mounted for the database, path recorded: ______________________
- [ ] That path is writable by uid 1000 (`chown -R 1000:1000 <path>`)
- [ ] Subdomain chosen and created (example target: `pcc.lippoliselectric.com`)
- [ ] DNS record points at the server
- [ ] TLS certificate issued, and renewal is automatic
- [ ] Reverse proxy configured, terminating HTTPS, forwarding to the container port
- [ ] Container published to `127.0.0.1` only — never to `0.0.0.0`
- [ ] Access model decided and implemented: ☐ VPN only ☐ public + TLS ☐ IP allow-list
- [ ] Firewall reviewed for that decision
- [ ] Restart policy set (`restart: unless-stopped`) and survives a server reboot
- [ ] Process supervision installed from `deploy/` — `pcc-docker.service` (Docker) or
      `pcc-node.service` (no container runtime); Windows Server is still an open question
- [ ] **Server reboot tested once, with PCC coming back on its own** — nobody logged in to start it
- [ ] Monitoring polls **`GET /api/health`** (readiness) and alerts a named person
- [ ] Any supervisor restart policy points at **`GET /api/health/live`** (liveness), never at
      readiness — a config error must not become a restart loop
- [ ] Log retention configured (the compose file caps at 5 × 10 MB)

## 2. Application — the installer

- [ ] `.env` created from `.env.example`, never committed
- [ ] `NODE_ENV=production`
- [ ] `SESSION_SECRET` set from `openssl rand -base64 48`, stored in IT's secret store
- [ ] `PCC_DATABASE_PATH` points inside the mounted volume
- [ ] `APP_BASE_URL` is the real HTTPS address people will type
- [ ] `PCC_ORG_NAME`, `PCC_ORG_PHONE`, `PCC_ORG_ADDRESS` set — **these print on every PO**
- [ ] First start only: `PCC_DATABASE_ALLOW_CREATE=1` + `PCC_BOOTSTRAP_ADMIN_EMAIL` +
      `PCC_BOOTSTRAP_ADMIN_PASSWORD` (12+ characters)
- [ ] Image built and `node scripts/check-deployable.mjs` passed during the build
- [ ] Container started; `docker compose logs pcc | grep '\[pcc\]'` shows
      `creating a NEW purchasing database` **exactly once**
- [ ] `curl -fsS https://<host>/api/health` returns `"status":"ok"`
- [ ] **`PCC_DATABASE_ALLOW_CREATE` and `PCC_BOOTSTRAP_ADMIN_PASSWORD` removed from the
      environment, and the container restarted**
- [ ] After that restart the log says `opening the existing purchasing database` — if it ever says
      *creating* again, **stop**: the volume is not mounted where PCC is looking

## 3. Company configuration — Mike / the office, entered by the installer

Everything in this section is real company information. **None of it may be guessed.** Where a
value is not yet known, leave the box unchecked and record it as a blocker rather than inventing a
plausible one.

### People
- [ ] Bootstrap administrator signed in once and changed the temporary password
- [ ] Mike invited — role `WORKSHOP_APPROVER`, approval authority granted
- [ ] Rick invited — role `WORKSHOP_APPROVER`, approval authority granted (the backup matters:
      one purchaser is a single point of failure on a Tuesday)
- [ ] Office staff invited as needed
- [ ] Foremen invited as `FOREMAN` **and assigned to their job numbers** — a foreman with no
      assignment cannot sign for anything
- [ ] Whoever receives at the shop counter assigned to `WORKSHOP`
- [ ] Everybody has signed in once and changed their temporary password
- [ ] No account remains with a password anybody else has seen

### Directories
- [ ] Real vendors entered, each with the ordering contact's real email address
- [ ] Real active jobs entered, with job name and site address (both print on the PO)
- [ ] Workshop delivery location present and named the way the shop refers to it
- [ ] Office and vendor-pickup locations reviewed

### Purchase order numbering — **the part that cannot be undone**
A number is `job-vendor-sequence`, counting from 1 for each job-and-vendor pair. Nothing needs
setting for a pair with no paper history — it starts at 1, which is correct.
For **each active job**, the office answers one question per vendor it will use: *has a purchase
order ever been written by hand for this job and this vendor?*
- [ ] Pairs that DO have paper history: set in Administration → PO numbering → *Set this pair*
      ______________________________________________________________
- [ ] Pairs that do NOT: recorded with *Confirm as new* (the count is 1 either way; recording it is
      what proves somebody was asked)
- [ ] Vendor PO codes confirmed with the office — `GRAYBAR` or `GRAYBARELECTRIC`? Changeable only
      until that vendor's first order
- [ ] `node scripts/pcc-verify-production.mjs --db <path> --strict` reports **no unresolved pairs
      and no unasked jobs**
- [ ] A test PO generated and its number checked against the paper file for that job and vendor
- [ ] Everyone who issues paper POs knows PCC now counts alongside them, per job and vendor

> The sequence can only move forward. A number issued twice — once on paper, once by PCC — is a
> problem the office has to untangle with a supplier. A gap is not.

### Still to be decided by Mike
- [ ] **Taxable** — PCC prints two empty boxes because it holds no tax status. Decide whether that
      stays a hand-tick or becomes a recorded field: ______________________
- [ ] **Unit price and total on the vendor's copy** — currently printed when costs are recorded.
      Confirm this is wanted: ______________________
- [ ] **Ship via** — printed only for a pick-up; otherwise a blank line. Confirm: ______________________

### Email
- [ ] Everyone understands PCC **drafts** vendor emails and never sends them
- [ ] Mike has copied a draft into his own mail client once and sent it successfully
- [ ] Decision recorded on whether sending should ever be automated: ______________________

## 4. Data — the installer

- [ ] `node scripts/pcc-verify-production.mjs --db /data/pcc.sqlite --strict` **exits 0**
- [ ] No `@example.invalid` accounts
- [ ] No seeded vendors (Graybar, Rexel, City Electric) or jobs (24-118, 24-203, 25-007)
- [ ] No demonstration requests or purchase orders
- [ ] PO sequence is the office's number, not the built-in placeholder
- [ ] Backup taken and **verified**: `node scripts/pcc-backup.mjs --db /data/pcc.sqlite --out /data/backups`
- [ ] Backup copied off the server by IT's own system
- [ ] **Restore rehearsed on a copy** — not on production. `bash scripts/restore-rehearsal.sh`
      does the whole drill unattended and must print `RESTORE REHEARSAL: PASS`. Run it **on the
      VM**, so the result describes that machine rather than a laptop.
- [ ] Date of that rehearsal recorded, and who did it: ______________________
- [ ] Backup schedule agreed and running (nightly is sensible at this volume)
- [ ] Disk headroom checked against **`/data/backups`**, not `pcc.sqlite` — each backup is a full
      copy, so retention multiplies the database size

## 5. Pilot walkthrough — do this together, in one sitting

Stop at the first step that surprises anybody.

- [ ] Mike signs in on his own machine
- [ ] Rick signs in
- [ ] A foreman signs in **on his own phone, on mobile data** (not office wifi)
- [ ] The foreman raises a real request against a real job, from the phone
- [ ] It appears on Mike's dashboard within seconds, in "Needs your attention"
- [ ] Mike opens it, records shelf stock, picks a real vendor, approves
- [ ] The PO number matches what the office expects
- [ ] **The PO prints correctly on the office printer** — check the header, the ship-to tick, the
      quantity columns and the signature block against a paper PO
- [ ] Mike creates the vendor email draft and sends it from his own mailbox
- [ ] Mike marks it ordered
- [ ] The foreman confirms the delivery from his phone when it arrives, **photographing the
      packing slip**
- [ ] Somebody else opens that photograph from the receipt screen — the evidence is retrievable,
      not merely stored
- [ ] Mike completes the request
- [ ] The activity trail reads correctly to somebody who was not involved
- [ ] A Workshop-destination request run end to end as well
- [ ] `docker compose restart pcc`, then everything above is still there

## 6. After the walkthrough

- [ ] Backup taken again, now that there is real data
- [ ] Mike knows who to call when something is wrong
- [ ] IT knows how to restart, read logs, and restore
- [ ] A date set to review how the first fortnight went

---

## Blockers — fill in and do not invent

Anything unresolved here is why the pilot is not live. Record the answer and who owes it.

| # | Needed | From | Answer |
|---|---|---|---|
| 1 | Job-and-vendor pairs that already have paper POs, and where each had reached | office | |
| 2 | Real vendor list with ordering contacts | Mike | |
| 3 | Real active job list with addresses | office | |
| 4 | Taxable — hand-ticked or recorded? | Mike | |
| 5 | Unit price on the vendor's copy — yes or no? | Mike | |
| 6 | Who owns the shop counter for receiving | Mike | |
| 7 | Server hostname / OS / Docker availability | IT | |
| 8 | DNS control and subdomain | IT | |
| 9 | TLS and reverse proxy | IT | |
| 10 | Public or VPN-only access | IT | |
| 11 | Backup system and retention | IT | |
| 12 | Monitoring and who is alerted | IT | |
| 13 | Outbound email policy | IT | |
| 14 | Microsoft/Entra tenant, if SSO is ever wanted | IT | |

**PCC is not production pilot ready while rows 1–3 and 7–9 are blank.** The software is; the
installation is not, and the difference is company information and infrastructure, not code.
