# First Lippolis deployment — the checklist

**One page to carry. It adds no new procedure.** Every step below points at the document that owns
it. Where this page and that document disagree, the document wins: tell whoever maintains this page.

- **Installation procedure:** `docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md` (§1 live checklist, §8 proof register)
- **Measurement sequence:** `docs/proof/FIRST_REAL_PROOF_ACTIVATION.md` and `docs/proof/BASELINE_DAY.md`
- **What to write down on the day:** `docs/deployment/PCC_PRODUCTION_EVIDENCE.md`
- **What the machines have already proven, and what they have not:** `npm run readiness` (`.awe-deploy/deployment-readiness.json`)

Target: **LIPELE-RDS02 · 192.168.10.152 · Windows Server 2019 Standard**. The approved commit is
whatever `deployment/APPROVED_RELEASE.md` says on the day. Do not install anything else.

---

## 0. BEFORE FIRST PURCHASE — the step that cannot be redone

> ### BASELINE REQUIRED BEFORE FIRST REAL PCC TRANSACTION
>
> A baseline cannot govern work that predates it. Every real purchase that goes through PCC before
> the baseline exists is **permanently unvaluable**, not "hard to value" (`proof/baseline.mjs`,
> `effectiveFrom`). Everything else on this page can slip a week. This cannot.

| # | Do | Where it is written | Done when |
|---|---|---|---|
| 0.1 | `npm run baseline` says READY TO COLLECT BASELINE | BASELINE_DAY.md "Before I go" | it says READY |
| 0.2 | Fix, *before opening the drawer*, which paper POs you will read ("every PO for June–August") | BASELINE_DAY.md | the rule is written down |
| 0.3 | Filing cabinet: at least **15** paper POs, raised date vs packing-slip date, into `cycle.csv` (25 if available; skip rows with no slip, never guess) | BASELINE_DAY.md §1 | 15+ rows |
| 0.4 | One watched morning beside the purchaser: occupied minutes only, **5** of each step, into `handling.csv` | BASELINE_DAY.md §2 | 5 per step, or a stated reason |
| 0.5 | Loaded labour rate: one figure, and what it includes | FIRST_REAL_PROOF_ACTIVATION.md "Before deployment" | one figure with its grade |
| 0.6 | Import and freeze: `npm run baseline:import`, then `npm run baseline:freeze` | BASELINE_DAY.md | a file under `proof/baselines/frozen/` |
| 0.7 | **Attest it yourself:** `npm run attest` → `baseline_captured_before_first_transaction` | `autonomy/human-facts.json` | `npm run attest -- --list` shows HUMAN_VERIFIED |

Until 0.7 is done, `npm run plan`, `npm run engineering-state` and `npm run readiness` all print the
banner above. Nothing in the repository can make it go away except you, at a terminal.

**Also before the first live PO:** collect the last paper PO number for every job + vendor pair that
already has paper orders (RDS02 package §2). There is **no single starting PO number**: do not ask
the office for "the next PO number".

---

## 1. INSTALLATION — exactly the RDS02 package §1, in order

Stop at the first failure. Every step there is idempotent.

| RDS02 step | What | Expected |
|---|---|---|
| 1 | Copy `PCC-<commit>.zip` (built by `node scripts/package-release.mjs` on a clean tree); `Get-FileHash -Algorithm SHA256` against its `.sha256` | hash matches |
| 2 | Unblock → extract to `C:\pcc-artifact` | `MANIFEST.txt` and `dist\pcc\` present |
| 3 | Create `C:\ProgramData\pcc\data` yourself (the installer will not) | created |
| 4–5 | `pcc.env` from `config\production.env.template`; generate `SESSION_SECRET` **on the server** | every value filled |
| — | **Check twice:** `PCC_ENVIRONMENT=production` and `PCC_ORG_ID=lippolis`. Both are stamped at first start and can never be corrected (RDS02 §3) | exactly these values |
| 6 | `.\scripts\preflight-windows.ps1` | **0 blockers**, then `npm run attest` → `rds02_preflight_clean` |
| 7 | `.\scripts\Deploy-PCCProduction.ps1 -FirstInstall -Artifact .\dist\pcc` | ends INSTALLED |
| 8 | Release line | the approved commit, **no `-dirty`** |
| 9 | `Invoke-RestMethod http://127.0.0.1:3000/api/health` | `status: ok` |
| 10–12 | `.\scripts\Configure-PCCIIS.ps1 -Phase Http`; browse from another machine; port 3000 **must not** answer from another machine | sign-in page styled; 3000 refused |
| 13–15 | Sign in as bootstrap admin → forced password change → remove `PCC_DATABASE_ALLOW_CREATE` and `PCC_BOOTSTRAP_ADMIN_PASSWORD` → `nssm restart pcc` | log says *opening the existing purchasing database* |

---

## 2. VALIDATION — immediately after installation

| # | Check | Expected | Then |
|---|---|---|---|
| 2.1 | `node scripts\pcc-verify-deployment.mjs --service pcc` (RDS02 step 16) | **READY FOR ACCEPTANCE TESTING**, release matches the signed record, stamped `production` | `npm run attest` → `pcc_installed_at_lippolis` |
| 2.2 | `node scripts\pcc-verify-production.mjs` (FIRST_REAL_PROOF_ACTIVATION.md) | lists every job + vendor pair about to issue its first PO | initialize sequences for pairs with paper history (RDS02 §2), then attest `po_sequence_initialized` |
| 2.3 | **Reboot** (RDS02 steps 18–21): `Restart-Computer`, sign in to nothing, `(Get-Service pcc).Status` | `Running`; health ok; backup task still enabled | attest `rds02_reboot_survival` |
| 2.4 | Mike/Rick acceptance script | RDS02 §5 | completed |

---

## 3. FIRST REAL TRANSACTION — what to watch and capture

Only after section 0 is attested, and section 2 passes.

- **Raise it for a pair with paper history,** and confirm the PO number PCC issues is exactly the
  office's expected next number **before it goes to the supplier**. A PO number cannot be withdrawn
  once a supplier has it (RDS02 §2).
- **Watch, do not help.** Note every point where someone hesitates, asks, or works around PCC: that
  is the "fortnight nobody had to work around" evidence (DECISION_LOG 2026-08-12).
- **Time the AWE-era screens** the same way as the baseline: occupied minutes only, 5 per screen to
  state a figure, 10 to defend it (FIRST_REAL_PROOF_ACTIVATION.md "After deployment").
- Record request id, PO number, date, people, and anything worked around. Then
  `npm run attest` → `first_real_purchase_completed`.

---

## 4. BACKUP / RECOVERY — establish that recovery exists before relying on PCC

| # | Do | Expected | Attest |
|---|---|---|---|
| 4.1 | `.\scripts\install-backup-task.ps1 -Verify` (RDS02 step 17) | task exists, enabled, last result 0 | |
| 4.2 | `node scripts\pcc-backup.mjs --db C:\ProgramData\pcc\data\pcc.sqlite --check` | `verified — integrity ok` with counts | `rds02_backup_task_verified` |
| 4.3 | **Restore drill:** stop the service; `node scripts\pcc-restore.mjs --from <backup> --db <scratch path> --force` (proof register step 17) | `restored … N request(s) readable`. Restore **refuses while the app is answering**, and that refusal is correct | `rds02_restore_drill` |
| 4.4 | Confirm with Lippolis IT that `C:\ProgramData\pcc\data` is in the RDS02 backup rotation (RDS02 §7) | IT confirms in writing | deployment gate: `storage.backed_up_by_customer` |

The container suites already prove that the backup and restore *tools* work: a backup taken while
PCC is running restores into a working PCC, attachments byte for byte (`restore-rehearsal`,
`clean-machine`). They do not prove the task, the account, or the storage on RDS02. Only 4.1–4.4 do.

---

## 5. ROLLBACK / ABORT — stop instead of improvising

**Stop the deployment, and do not let anyone raise a real purchase, if:**

- the zip's hash does not match its `.sha256`, or the release line says `-dirty`, or is not the signed commit;
- `preflight-windows.ps1` reports any blocker;
- the first start logs anything other than creating a NEW database **once**, or any later start says
  *creating* (the data path is wrong);
- you realize `PCC_ENVIRONMENT` or `PCC_ORG_ID` was wrong at first start. That database's records
  can never be evidence; the only remedy is a new database, before any real purchase;
- port 3000 answers from another machine;
- the service is not `Running` after a reboot without anyone signing in;
- backup `--check` fails, or the restore drill does not report readable requests;
- the baseline (section 0) has not been attested. Install if you like; **do not process a real purchase**;
- the first PO number PCC issues is not the office's expected next number.

How to go back is RDS02 §6: reinstall the previous artifact (the data directory is never touched by
an install), restore from the pre-update backup if data was affected, or restore the previous
`pcc.env`. If none applies: copy the newest verified backup off the server and escalate.

---

## 6. EVIDENCE TO CAPTURE — for the case study and the IIC

| What | Where it goes |
|---|---|
| Artifact commit, sha256, install date, who installed | `PCC_PRODUCTION_EVIDENCE.md` §1–3 |
| Preflight, verifier, backup `--check`, restore drill, reboot outputs | `PCC_PRODUCTION_EVIDENCE.md` §3–6, and the matching attestation's evidence reference |
| PO sequence pairs initialized | `PCC_PRODUCTION_EVIDENCE.md` §7 |
| Baseline sheets, labour rate, freeze record | `proof/baselines/observations/`, `proof/baselines/frozen/` |
| First real purchase: ids, dates, people, workarounds | attestation `first_real_purchase_completed` |
| AWE-era screen timings | as in FIRST_REAL_PROOF_ACTIVATION.md |
| Every person who stumbled, and on what | notes, then `docs/planning/DECISION_LOG.md` if it changes anything |

After about two to three weeks of ordinary purchasing (roughly 10 valued units),
`node scripts/proof-case-study.mjs --org lippolis --from <install-date> --to <today>` can state an
hours-returned figure. Below 10 it reports LOW confidence by construction (`proof/ledger.mjs`).

---

## UNKNOWN on the day this page was written (2026-10-11)

These are not in the repository. Find out; do not assume.

- Whether Lippolis IT has installed Node 24, IIS, URL Rewrite, ARR and NSSM on RDS02 (RDS02 §7 lists them as outstanding).
- Whether a TLS certificate exists yet (HTTPS steps 23–25 wait for it; HTTP on the IP is the planned first phase).
- The DNS name, if any (deployment gate: `network.hostname`).
- Whether RDS02 starts the service at boot as configured (deployment gate: `service.enabled_at_boot`).
- Whether `C:\ProgramData\pcc\data` is in IT's backup rotation (deployment gate: `storage.backed_up_by_customer`).
- The loaded labour rate, and which purchaser will be timed.
- The install date. Nothing in the repository schedules it.
