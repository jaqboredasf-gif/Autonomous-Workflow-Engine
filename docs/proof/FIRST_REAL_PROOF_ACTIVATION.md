# From an installed PCC to one defensible number

**This is a sequence, not a manual.** Everything it points at is written elsewhere and in more
detail; what this adds is the ORDER, because one step in it cannot be repeated and doing it late
costs the first month of evidence permanently.

**Read `docs/proof/LIPPOLIS_BASELINE_FIELD_PROTOCOL.md` for how to measure anything below.**
This page says only *when*, and *what is enough*.

---

## The one ordering rule

> **The baseline must be measured BEFORE the first real purchase runs through PCC.**

A baseline records what the work cost *before* AWE. Measured afterwards, it is measuring a process
that has already changed — Mike has learned the new screens, the paper file has stopped growing,
and nobody can separate the two. `proof/baseline.mjs` enforces the consequence: a baseline is bound
to an `effectiveFrom`, and it cannot govern work that predates it. So purchases raised before a
baseline exists are **permanently unvaluable**. Not "hard to value" — unvaluable, by construction.

Everything else on this page can slip a week. This cannot.

---

## BEFORE DEPLOYMENT — what Jack collects

Four items, in this order. Total interruption to the business: **one email and one morning.**

| # | Item | From | Minimum | Interrupts |
|---|---|---|---|---|
| 1 | Loaded labour rate | payroll / Paul | one figure, with what it includes | one email |
| 2 | Paper POs, dated — raised vs. received | office filing | **15** POs | nobody |
| 3 | Paper POs, counted and shaped | office filing | the same 15 | nobody |
| 4 | The seven baseline steps, timed or asked | Mike, Karen | **5** occurrences each | one watched morning, or a 45-minute interview |

Items 2 and 3 need nobody's morning: they are a filing cabinet and an afternoon. **Start there** —
they are the only part of this that can be done today, with the VM still not existing.

**Record each figure with its grade.** `proof/provenance.mjs` has five, and the distinction is the
whole point:

| Grade | Means | Example here |
|---|---|---|
| `MEASURED` | somebody observed it happening | Mike timed with a stopwatch |
| `ESTIMATED` | derived from records, not observed | median lead time from 15 paper POs |
| `SELF_REPORTED` | somebody's account of their own work | "that takes me about ten minutes" |
| `INFERRED` | computed from other quantities | a rate derived from a count over a period |
| `UNAVAILABLE` | **not known** — and it stays null | anything nobody has done yet |

A figure with no grade is not a figure. Writing `SELF_REPORTED` where it belongs is what makes the
`MEASURED` rows worth anything.

---

## DURING DEPLOYMENT — what must be true at the first start

Three of these are permanent. They are checked at every start, and a start that disagrees with
what the database already says refuses and writes nothing.

| Setting | Value | Why it cannot be corrected later |
|---|---|---|
| `PCC_ENVIRONMENT` | `production` | Stamped into the database at creation. Anything else — or nothing — and every figure ever produced from it reads NOT EVIDENCE |
| `PCC_ORG_ID` | `lippolis` | The tenant's permanent name. Undeclared, the id is a random UUID, and the baseline keyed on `lippolis` matches nothing |
| `PCC_ORG_ADDRESS`, `PCC_ORG_PHONE` | the real ones | They print on every purchase order a supplier receives, and no screen edits them afterwards |

The application refuses a first production start without the first two, so this cannot be forgotten
— but it can be got *wrong*, and wrong is not recoverable. Read them off `deployment/APPROVED_RELEASE.md`
and the manifest before typing them.

**Then, before anybody raises a real purchase:**

```bash
node scripts/pcc-verify-deployment.mjs --service pcc     # is this INSTALLATION operational?
node scripts/pcc-verify-production.mjs                   # is this DATABASE fit for real work?
```

The second one lists every job-and-vendor pair about to issue its first purchase order number. If
the office has already written paper POs for that pair, set where the count reached **before the
first order on that job** — a purchase order number cannot be un-issued.

---

## AFTER DEPLOYMENT — what is measured during the first real work

Nothing here needs new engineering. PCC records all of it already; these are the thresholds at
which the recording becomes a claim.

| Figure | Comes from | Enough to state it | Enough to defend it |
|---|---|---|---|
| Executions, reliability, interventions | the audit log, automatically | **1** | any |
| Objective success | the objective test, automatically | 1 | 10 |
| AWE-era handling time | the eleven screens, timed once | 5 per screen | 10 per screen |
| **Hours returned** | baseline − AWE-era, per valued unit | **10 valued units of work** | **30** |
| Cycle-time change | PCC timestamps vs. the 15 paper POs | 10 | 25–30 |

**Ten and thirty are enforced in code, not advice.** `confidenceOf()` in `proof/ledger.mjs` caps
confidence at LOW below ten valued units and at MODERATE below thirty. Quoting a figure from six
purchases is not conservative reporting; it is a number the system itself will not stand behind.

At Lippolis's volume, ten valued units is roughly **two to three weeks** of ordinary purchasing.

**Read it with:**

```bash
node scripts/proof-case-study.mjs --org lippolis --from <install-date> --to <today>
```

It refuses a database that did not declare itself production, and prints NOT MEASURABLE against
every figure it cannot support. That output is the correct output until the baseline exists.

---

## What this does NOT produce, and should not be made to

- **A number before ten valued units.** The floor is in the code for a reason.
- **A money figure without the loaded rate.** Item 1 is one email; until it is answered, hours
  returned is the strongest thing that can honestly be said.
- **An objective outcome PCC cannot see.** "The material arrived" is testable from the receipt.
  "The crew was not idle" is not, and inventing it is where a proof layer becomes a marketing one.
- **Anything from the rehearsal database.** It carries the real company name and the real
  organization id and describes work nobody did. Every reader in this repository refuses it.

---

## Where this sits

| Stage | Command |
|---|---|
| Is the deployment ready? | `npm run deployment-gate` |
| What should we do next? | `npm run plan` |
| What can we prove today? | `npm run proof:case-study -- --org lippolis --from … --to …` |
