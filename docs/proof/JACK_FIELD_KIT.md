# Jack — what to do next

**Everything on this page needs a person. Nothing on it can be built.**

The software side of Case Study #001 is finished: the baseline model, the ingestion, the
production observation, the denominator, the hours-returned arithmetic, the evidence grading, the
audit trace and the acceptance gate all exist and are tested. What is missing is that nobody has
watched how Lippolis bought material before PCC, and PCC has not run a real purchase.

## → On the day, carry `docs/proof/BASELINE_DAY.md`, not this page.

That is the two-page checklist: what to bring, what to ask for, exactly when to start and stop the
stopwatch, and what to run afterwards. **This page is the why; that one is the how.**

```bash
npm run baseline           # where it stands, and the next hour of work
npm run baseline:import    # turn the field sheets into evidence
npm run plan               # the single highest-leverage action
```

**One thing changed since this page was first written, and it matters on the day.** It used to say
"time each of the seven steps five times, in one morning". That is not physically executable:
filing happens in fragments over days and the approver is a different person, so an installer
following it literally would have got to 11am and improvised. `BASELINE_DAY.md` says which steps
are watched, which are timed as a batch and divided, and which are asked for — and that coming back
short on the hard ones is a normal first pass rather than a failure.

**Total interruption to Lippolis staff across everything below: about ninety minutes, once.**

---

## Step 1 — The paper purchase orders *(you, alone, ~2 hours)*

| | |
|---|---|
| **Who** | You. Nobody at Lippolis is involved. |
| **What** | Pull **25** paper purchase orders from the office file, spread across at least three months and at least three vendors. Do not choose the tidy ones. |
| **Record** | For each: PO number, job, vendor, **date raised**, **date material received** (from the packing slip), number of line items, and whether it was written by hand or typed. |
| **How long** | An afternoon. |
| **Unlocks** | Pre-AWE cycle time, PO-preparation timing evidence, and the sample sizing for everything below. |

**Why 25 and not 10.** Vendor lead time varies more than any other quantity here, so the median
needs more observations than a handling time does. Fifteen is the floor; twenty-five is where it
stops moving when you add another.

**Do not choose which POs to pull after seeing them.** Decide the rule first — "every PO in these
three months for these three vendors" — and take all of them. That rule is the same discipline the
software applies to production workflows, and a judge will ask about both.

---

## Step 2 — The loaded labour rate *(one email, ~5 minutes)*

| | |
|---|---|
| **Who** | Paul, or whoever runs payroll. |
| **What** | The **fully loaded** hourly cost of the person who does purchasing — wage plus payroll tax, insurance and overhead. Not the wage. |
| **Record** | The figure, who supplied it, the date, and what it includes. In writing. |
| **How long** | One email. Five minutes of somebody's day. |
| **Unlocks** | **Every money figure.** Until this arrives, hours returned is the strongest thing that can honestly be said. |

Put it in `proof/baselines/observations/lippolis-purchasing.json` under `labourRate`, with
`"method": "HISTORICAL_RECORD"` if it came from payroll records, `"EMPLOYEE_ESTIMATE"` if somebody
told you from memory.

---

## Step 3 — Watch the old process *(Mike and Karen, one morning)*

**This is the only step that costs Lippolis real time, and it must happen before PCC handles a
real purchase.**

| | |
|---|---|
| **Who** | You, watching. Mike and Karen, working normally. |
| **What** | Time each of the seven steps, **five times each**, with a stopwatch. |
| **How long** | One morning. Ask to sit beside them on a normal day, not a quiet one. |
| **Unlocks** | The baseline. Without it there is no "before", and no hours-returned figure can exist at all. |

The seven steps, and what to time:

| Step | Time from → to | Watch for |
|---|---|---|
| `request_intake` | the call connecting → the note being complete | foremen text as well as phone |
| `clarification` | going back for missing detail | **also record how OFTEN this happens** — see below |
| `stock_check` | starting to look → knowing the answer | walking the shelves, or asking somebody |
| `approval_handling` | approver picks it up → approver puts it down | **handling only** — not how long it sat |
| `po_preparation` | starting the form → form complete | finding the next number for that job and vendor |
| `vendor_communication` | starting to compose → sent | excludes waiting for a reply |
| `tracking_and_filing` | across the life of one order | chases, packing slip, filing — happens in fragments |

**The two mistakes that would cost the case study.**

1. **Handling time is not elapsed time.** If the approver picks up a request at 9am and signs it at
   2pm, the approval step is the two minutes they were occupied, not five hours. The waiting is real
   and belongs in the cycle-time figure, which is measured separately from Step 1's paper POs. Timing
   the wait would inflate the baseline enormously and invisibly.

2. **A step that happens sometimes is not a full step.** Clarification might take eight minutes but
   happen on one request in four. Record the share — count how many of, say, twenty requests need it —
   and put it in `appliesToShare`. The software multiplies; eight minutes on a quarter of requests
   contributes two. Getting this wrong is the single easiest way to over-state the baseline.

**Record each observation like this:**

```json
{ "minutes": 6, "method": "DIRECT_OBSERVATION", "observedBy": "Jack",
  "at": "2026-09-03", "subject": "Karen", "ref": "PO 1234-COOPER-7" }
```

`ref` is what makes it evidence rather than a memory: the thing a skeptical reader goes and looks
at. The file refuses an observation without one.

**If you cannot watch a step**, use `"method": "HISTORICAL_RECORD"` when you derived it from the
paper POs, or `"EMPLOYEE_ESTIMATE"` when Mike told you. Both are legitimate and both are weaker, and
the software will grade the whole baseline at its weakest part. That is correct — do not upgrade a
method to make a number look better.

**Check as you go:** `node scripts/baseline-observations.mjs` tells you which steps still need
observations and what each one is currently graded.

---

## Step 4 — Somebody reviews it *(30 minutes, anybody but you)*

| | |
|---|---|
| **Who** | Mike, Paul, or anybody who knows the work and did not do the timing. |
| **What** | Read the seven figures back to them: "does nineteen minutes per purchase sound right?" Record disagreements rather than arguing them. |
| **Record** | `reviewedBy` and `reviewedAt` in the observation file. |
| **Unlocks** | The difference between DEFENSIBLE and STRONG. An unreviewed baseline is one person's afternoon, and the acceptance gate says so. |

---

## Step 5 — Install PCC, and start the clock *(deployment day)*

Follow `docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md`. The two things that decide whether any of
the above was worth doing:

- `PCC_ENVIRONMENT=production`
- `PCC_ORG_ID=lippolis`

Both are written into the database when it is created and never again. The application refuses to
start without them, so they cannot be forgotten — but they can be got wrong, and wrong is not
recoverable. Read them off the environment template, do not type them from memory.

**Note the date.** It is the start of the observation period, and every figure will be stated
against it.

---

## Step 6 — Let it run *(Mike, normally, 2–4 weeks)*

| | |
|---|---|
| **Who** | Mike and the people who raise requests. Working normally. |
| **What** | Nothing extra. **Do not coach anybody, and do not intervene in a purchase to make it go well.** |
| **How long** | Until **30 completed purchases**. At Lippolis's volume, two to four weeks. |
| **Unlocks** | Everything. |

**You record nothing during this step.** PCC's audit log captures every human interaction with an
actor and a timestamp, which is what makes the AWE-era side of the comparison a measurement rather
than an estimate. That is the half you do not have to work for.

**Ten is the floor, thirty is the target**, and both are enforced in code rather than advised. Below
ten valued purchases the system caps confidence at LOW; below thirty, at MODERATE. Quoting a figure
from six purchases is not conservative — it is a number the system itself will not stand behind.

**Failures stay in.** If a purchase goes wrong, leave it. The acceptance gate refuses to grade a
case study whose population does not reconcile, so removing a bad one makes the result *worse*, not
better. This is the question a judge asks first.

---

## Step 7 — Read the case study *(you, 10 minutes)*

```bash
node scripts/proof-case-study.mjs --org lippolis \
  --from <install-date> --to <today> \
  --db C:\ProgramData\pcc\data\pcc.sqlite
```

It prints the figures, then the grade — NOT_READY, PARTIAL, DEFENSIBLE or STRONG — and, when it is
not STRONG, exactly which rule stopped it and what was found instead.

To answer "how do you know?", add `--explain`: one row per purchase, showing the baseline minutes,
the observed minutes, what it contributed, and why. The rows sum to the headline.

---

## What the answer might be, and what to do about it

| Result | What it means | What to do |
|---|---|---|
| **A large saving** | Good, and it needs no decoration. | Report it with the denominator and the grade beside it. |
| **A small saving** | Also fine. Three hours is three hours. | Report three. A small honest figure grades exactly as well as a large one. |
| **Zero** | PCC did the work and returned no time. | Report zero. It is a measured result and the system grades it STRONG. |
| **Negative** | PCC costs more human time than the old way. | **Report it.** Then find out which step got worse — `--explain` will show you — and fix the product. This is the most valuable thing the system could tell you, and the fastest way to lose the argument at IIC is to have hidden it. |

---

## The one thing to protect

Do not decide any of the rules after seeing the numbers. The sample sizes, the denominator policy,
the exclusion policy and the grading are all fixed in `proof/case-study-standard.mjs`, dated before
any production execution exists, and a test asserts none of them is computed from an observation.

If a rule turns out to be wrong, change it — bump the version and leave the old one visible, so the
change is something somebody did rather than something that was always true.
