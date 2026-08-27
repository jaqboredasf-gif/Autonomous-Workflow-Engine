# Lippolis baseline — the field protocol

**One page you can work from.** `BASELINE_METHODOLOGY.md` is the method; this is the errand list.

Everything here exists to move one file — `proof/baselines/lippolis-purchasing.mjs` — from every
figure `UNAVAILABLE` to enough figures known that the case study prints a number.

**Do the desk work first.** Three of the five items below need nobody's morning, and two of them
you may already have in a filing cabinet.

---

## The order to do it in

| # | Item | Who | Interrupts anyone? | Unlocks |
|---|---|---|---|---|
| 1 | **Loaded labour rate** | payroll / Paul | One email | every money figure |
| 2 | **Paper POs — dates** | office filing | Nobody | pre-AWE cycle time |
| 3 | **Paper POs — count and shape** | office filing | Nobody | sample sizing, PO-prep timing |
| 4 | **Eleven screens, timed** | one purchaser (Mike) | One morning, watched | AWE-era handling time |
| 5 | **Seven baseline steps, timed or asked** | Mike + office (Karen) | 45 min interview, or a watched morning | baseline handling time → **hours returned** |

---

## 1. WHAT DO I NEED?

### Item 1 — Loaded labour rate `→ baseline.labourRate`

One number: **fully-loaded cost per hour** — wage plus payroll tax, benefits and overhead — for the
people who do purchasing. Not a company average. If office and workshop differ, get both and say
which steps each performs.

> "For the people who handle purchasing — what's the fully loaded hourly cost, including tax and
> benefits, not just wage?"

Record as `MEASURED`, source kind `HISTORICAL_RECORD`, ref: *"payroll, 2026 rates, office +
workshop blended"*.

**Without it:** hours returned still works. Money does not. That is an acceptable first proof.

### Item 2 — Paper purchase orders, dated `→ baseline.cycle`

Pull **20–30 completed purchase orders from before PCC**, ideally spread across several months and
more than one vendor. For each, record two dates:

- the date on the purchase order
- the date the material was received — from the **packing slip** stapled to it, or a delivery
  signature, or the vendor invoice date if that is the only dated artifact

`received − ordered = elapsed days`. Take the **median**, not the mean.

Record as `ESTIMATED`, source kind `HISTORICAL_RECORD`, ref: *"N paper purchase orders, <date
range>, median"*, `sampleSize: N`.

> **Why `ESTIMATED` and not `MEASURED`:** a purchase order date is when somebody wrote the order,
> which is not necessarily when the job asked. The AWE-era figure measures request→received. These
> are close but not the same interval, and pretending otherwise is the exact kind of quiet
> mismatch that gets a comparison thrown out. Note the difference in the source ref.

### Item 3 — Paper purchase orders, counted `→ sizing`

While the drawer is open: **how many purchase orders per month**, roughly, and how many line items
on a typical one. This does not go into the baseline. It tells you whether the eventual sample is
big enough to mean anything, and it is what turns "we save 12 minutes a purchase" into "we save
N hours a month".

### Item 4 — The eleven screens `→ touch standard`

**This is the AWE-era half of the subtraction, and it is one morning.**

A complete purchase in PCC is **eleven human interactions** — verified by driving one through the
real code (`scripts/eval-proof.mjs`, "a whole purchase, driven through the real use cases": 31
audit rows, 11 interactions). Time each one:

| # | Screen | Who | Start the clock when | Stop when |
|---|---|---|---|---|
| 1 | `request.created` | foreman | the new-request form opens | the last line item is typed |
| 2 | `request.submitted` | foreman | — | Submit is pressed *(often the same click as 1)* |
| 3 | `review.saved` | purchaser | the review screen opens | Save is pressed |
| 4 | `decision.approved` | approver | the decision is in front of them | Approve is pressed |
| 5 | `po.generated` | purchaser | — | the PO exists |
| 6 | `email.draft_generated` | purchaser | — | the draft exists |
| 7 | `email.draft_reviewed` | reviewer | the draft opens | marked reviewed |
| 8 | `email.draft_approved_to_send` | approver | — | approved to send |
| 9 | `email.marked_sent` | purchaser | — | marked sent |
| 10 | `order.placed` | purchaser | — | marked ordered |
| 11 | `receipt.recorded` | receiver | the packing slip is in hand | receipt saved |

**Time each one across 5–10 real occurrences and take the median per screen.** Steps 5, 6, 8, 9 and
10 are single button presses and will come out at well under a minute — record that honestly rather
than rounding up to a minute because a small number feels wrong.

Record each as `MEASURED`, source kind `OBSERVED_TIMING`, ref: *"Lippolis, <date>, N observations,
median"*, `sampleSize: N`.

**If an exception path occurs** (a clarification round, a rejection, a partial receipt), time it
too. A purchase that hits an unpriced screen is unvaluable — the whole execution, not just that
step — so the eleven are the floor, not the target.

### Item 5 — The seven baseline steps `→ baseline.steps`

The pre-PCC process, from `proof/baselines/lippolis-purchasing.mjs`. Each step's `note` says what
to observe.

| Step | What to time | Prefer |
|---|---|---|
| `request_intake` | taking the request from the field: call connects → note complete | watch |
| `clarification` | going back for missing detail — **and how often it happens** | watch + ask |
| `stock_check` | walking the shelves, or asking somebody who knows | watch |
| `approval_handling` | the minutes the approver is *occupied* — not the hours it sat on a desk | watch |
| `po_preparation` | finding the next number for that job and vendor, filling the form | watch, or reconstruct from the paper |
| `vendor_communication` | composing the email or making the call | watch |
| `tracking_and_filing` | the chases, the packing slip, the filing — in fragments across the order's life | ask; hard to watch |

**The problem:** PCC replaces this process, so once it is live there is nothing left to watch. If
Lippolis is still on paper for any part of purchasing, **watch it now, before it goes.** Otherwise
this step is an interview and grades `SELF_REPORTED`.

---

## 2. WHO DO I NEED IT FROM?

| Person | Role | What only they can give you | Ask |
|---|---|---|---|
| **Paul** (or whoever holds payroll) | owner / management | loaded labour rate | one email |
| **Karen** (office) | office admin | PO preparation, vendor communication, tracking and filing — the steps she owns | 20 min, or watch a morning |
| **Mike** (workshop) | purchaser / approver | stock check, approval handling; and the eleven PCC screens | one watched morning |
| **Rick / Dave** (field) | foreman | request intake from the field side | 10 min |
| **The filing cabinet** | — | dates, counts, PO shape | nobody's time |

Roles are as named in `docs/planning/CURRENT_WORKFLOW.md` §2 and the PCC seed data. **Confirm who
actually does each step before timing it** — the working model says several roles may be one person.

---

## 3. HOW MANY SAMPLES?

| Figure | Minimum to state anything | Enough to defend | Why |
|---|---|---|---|
| Each baseline step | 5 occurrences | 10–20 | below 5 the median is one person's odd Tuesday |
| Each PCC screen | 5 occurrences | 10 | button presses are consistent; forms are not |
| Pre-AWE cycle time | 15 paper POs | 25–30 | vendor lead time varies more than anything else here |
| Clarification frequency | 20 requests | 40 | you are estimating a *rate*, which needs more than a duration |
| **The case study itself** | **10 valued units of work** | **30** | `confidenceOf()` caps confidence at LOW below 10 and MODERATE below 30 |

That last row is enforced in code, not advice. Ten completed purchases is the floor for the word
"measurement"; thirty is where confidence can reach HIGH.

---

## 4. HOW DO I RECORD IT?

**On paper, in the moment.** A phone stopwatch and a printed table. Do not try to type into the
repository while watching somebody work.

One row per observation:

```
date | step or screen | who | seconds | what made it unusual (blank if nothing)
```

Then, at a desk, take the median per step and write it into
`proof/baselines/lippolis-purchasing.mjs`:

```js
baselineStep({
  id: 'po_preparation',
  label: 'Writing the purchase order',
  minutes: 5,
  provenance: 'MEASURED',
  sources: [source({
    kind: 'OBSERVED_TIMING',
    ref: 'Lippolis office, 2026-09-14, 12 observations, median',
    at: '2026-09-14',
    sampleSize: 12,
  })],
  performedBy: 'office',
})
```

**Keep the raw sheets.** The median is the figure; the sheets are the evidence behind it, and
"how do we know?" eventually means somebody wants to see them.

Then run:

```bash
node scripts/proof-case-study.mjs --db <path> --org lippolis --from <date> --to <date> --explain
```

`quantity()` throws at import on a figure with a value and no source, so a fabricated number fails
before it can ship. That is a backstop, not the rule — the rule is that you were there.

---

## 5. WHAT COUNTS AS VALID EVIDENCE?

Four grades. The system keeps them apart, and a total degrades to its weakest input — so one
interviewed step makes the whole baseline `SELF_REPORTED`.

| Grade | What earns it | Example here |
|---|---|---|
| **MEASURED** | you or an instrument observed the thing itself | stopwatch on Mike doing a review; a timestamp PCC wrote |
| **HISTORICALLY DERIVED** → record as `ESTIMATED` | computed by a stated method from records that already existed | median days between 25 paper PO dates and their packing slips |
| **EMPLOYEE-ESTIMATED** → record as `SELF_REPORTED` | a named person's account of their own work | "filing takes me about three minutes a PO" — Karen, 2026-09-14 |
| **UNKNOWN** → `UNAVAILABLE` | nobody has looked | leave it. Do not fill it. |

Every non-unknown figure needs a **source** — kind and a ref somebody could go and check — and a
**basis**, the sentence you would say out loud. Both are required by the code.

> `proof/provenance.mjs` has no `HISTORICALLY_DERIVED` grade. Records-derived figures are
> `ESTIMATED` with source kind `HISTORICAL_RECORD`; the distinction the brief asks for lives in the
> source, where it can name the actual documents.

---

## 6. WHAT SHOULD I NOT INFER?

**Do not count waiting as work.** A purchase taking four days does not mean four days of anybody's
attention. Handling time is minutes a person is *occupied*. Waiting belongs in the cycle figure and
nowhere near the labour figure. This is the single largest source of fraudulent ROI in this
category and it is worth re-reading before every observation.

**Do not count a machine's time as anybody's.** If PCC generates a PDF in 200ms, that is not 200ms
of human work and it is not a saving either.

**Do not count an occasional step as if it always happens.** Clarification occurs on perhaps one
request in four. Either record its duration *and* its frequency and multiply, or record the
expected value and say so in the step's `note`. Booking the full duration every time inflates the
baseline enormously and invisibly.

**Do not use the worst case.** The request that took forty minutes is real; so are the nineteen
that took four. Median.

**Do not let a demonstration stand in for the work.** A demonstrated process runs 30–50% faster
than the real one and contains none of the interruptions. If Mike is showing you, you are not
measuring.

**Do not infer that PCC caused a business outcome.** Material arriving on time is the objective.
A crew not standing idle is a business outcome, and it does not follow from the first without
somebody establishing that it did. `businessOutcome()` refuses a money claim on
`CORRELATION_ONLY` attribution.

**Do not fill a step because the others are filled.** A partial baseline is refused by
`baselineHandlingMinutes()` — deliberately, because summing the known steps would produce a
*smaller* old-process cost and make AWE look worse, and a wrong number is wrong in either
direction.

**Do not measure the old process after PCC has replaced it.** Memory of a process you no longer
perform is the weakest evidence in this document.

---

## 7. WHEN IS THE BASELINE SUFFICIENT?

Three tiers. **Tier 1 is a real, defensible, publishable result** and it needs no money figure.

### Tier 1 — hours returned, stated honestly ← *aim here first*

- [ ] all **seven** baseline steps have a duration and a source (any grade)
- [ ] the **eleven** PCC screens have a duration and a source
- [ ] **10+ completed purchases** in PCC with objective ACHIEVED or NOT_ACHIEVED

Produces: baseline handling time, AWE-era handling time, **hours returned**, execution reliability,
objective success rate, AWE-era cycle time. Confidence: LOW to MODERATE depending on grade and
count. Money: `NOT MEASURABLE`, and the case study says so.

### Tier 2 — plus cycle-time change and money

- [ ] everything in Tier 1
- [ ] pre-AWE cycle time from 15+ paper POs
- [ ] loaded labour rate

Produces: cycle-time improvement, labour value returned.

### Tier 3 — defensible to a hostile reader

- [ ] everything in Tier 2
- [ ] **30+ valued units of work** (the HIGH-confidence threshold in `confidenceOf()`)
- [ ] every baseline step `MEASURED` or `ESTIMATED` — no step resting on memory alone
- [ ] clarification frequency measured, not assumed
- [ ] period overhead priced, so a **net** hours figure is possible

---

## The minimum evidence per figure — the summary table

| Figure | Needs | Have it today? |
|---|---|---|
| Execution reliability | PCC executions | **code ready; no deployment** |
| Objective success rate | PCC executions with receipts and need-by dates | **code ready; no deployment** |
| AWE-era cycle time | PCC timestamps | **code ready; no deployment** |
| **AWE-era human handling** | the 11 screens timed + PCC executions | needs Item 4 |
| **Baseline human handling** | all 7 steps timed or asked | needs Item 5 |
| **Hours returned** | both of the above | needs Items 4 + 5 |
| Cycle-time change | + pre-AWE cycle from paper | needs Item 2 |
| Labour value / money | + loaded labour rate | needs Item 1 |
| Money saved / protected / created | an attributed business outcome with evidence | not planned for the first proof |
