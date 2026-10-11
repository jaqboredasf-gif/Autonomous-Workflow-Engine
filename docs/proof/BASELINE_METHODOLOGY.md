# How to measure the process AWE replaced

`proof/` will not produce an hours-returned figure until somebody measures what the work cost
before. This document is how that measurement is taken, and what makes it defensible when a
customer's finance director, or a competition judge, asks where the number came from.

**Nothing in it is optional except which method you use.** Every method below produces a
`provenance` grade and a `source`, and `quantity()` refuses a figure that lacks either.

---

## 1. What is being measured, exactly

**Human handling time per unit of work.** The minutes a person is *occupied*.

Not elapsed time. A purchase that took four days from request to delivery may have occupied
nineteen minutes of anybody's attention; the other three days and twenty-three hours were waiting
for a vendor, and nobody was paid to wait.

This distinction is the single largest source of fraudulent ROI in this category of software.
Elapsed time is recorded separately, on the baseline's `cycle` field, and is never converted into
labour or into money anywhere in `proof/`.

**Per unit of work**, and the unit must be named. `unitOfWork: 'purchase request'` means every
figure derived from this baseline is "per purchase request". A baseline with no unit is refused at
construction.

---

## 2. The five methods, strongest first

| Method | Grade it produces | What it costs | When to use it |
|---|---|---|---|
| **Observed timing** | `MEASURED` | 1–2 days of somebody's attention | The gold standard. Sit with the person, stopwatch each step across 10–20 real occurrences. |
| **Sampled measurement** | `MEASURED` (with `sampleSize`) | Half a day | Time a subset, state the sample size, apply to the population. `source({ sampleSize })` is required. |
| **Historical records** | `ESTIMATED` | A few hours | Dated paper purchase orders, packing slips, email timestamps. Excellent for **elapsed** time; poor for handling time, which paper does not record. |
| **Structured operator observation** | `SELF_REPORTED` | An hour | Interview, using the protocol in §4. Legitimate evidence — the operator knows their job — but it is testimony. |
| **Workflow logs** | `MEASURED` or `ESTIMATED` | Varies | Only if the prior system recorded durations. Outlook and Excel do not. |

**A baseline may mix methods.** Step by step. `baselineHandlingMinutes()` grades the total at its
weakest step, so one interviewed step makes the whole total `SELF_REPORTED` — which is correct, and
which is the incentive to measure the steps that matter most.

---

## 3. The observation protocol

Do this once per step, across enough occurrences that the variation is visible.

1. **Name the step in the operator's words**, not the software's. "Writing the PO", not
   `po_preparation`. The id is for code; the label is what the person recognises.
2. **Define the start and stop signals out loud before timing.** "Starts when they open the form.
   Stops when the form is in the out-tray." Ambiguity here is where most of the error lives.
3. **Time real work, not a demonstration.** A demonstrated process is 30–50% faster than the real
   one and contains none of the interruptions.
4. **Record every occurrence, including the bad ones.** The request that needed three phone calls
   is part of the process. Excluding it is selection bias, and it is the most natural thing in the
   world to do.
5. **Record the sample size.** Ten occurrences and two occurrences produce different confidence,
   and `confidenceOf()` reads sample size directly.
6. **Use the median, not the mean**, and say which. One catastrophic occurrence moves a mean and
   not a median.

Write it up as:

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

---

## 4. The interview protocol, when timing is not possible

Produces `SELF_REPORTED`. Better than nothing, and honest about being testimony.

Ask, in this order, and **do not ask for a total**:

1. "Walk me through what happens from the moment somebody tells you they need something."
2. For each step they name: "How long does that take, when it goes normally?"
3. "And when it doesn't go normally — what happens, and how often is that?"
4. "What do you do that you'd say is a waste of your time?"
5. Read the steps and durations back. Ask what is missing.

**Ask for steps first and durations second.** Asking "how long does purchasing take you?" produces
a number that is a feeling. Asking about six named steps produces six numbers that add up to
something the person will defend.

Record who said it and when:

```js
sources: [source({
  kind: 'OPERATOR_STATEMENT',
  ref: 'office administrator, interviewed 2026-09-14',
  at: '2026-09-14',
})]
```

---

## 5. Three things that will quietly inflate the baseline

Every one of these makes AWE look better and the number indefensible.

**Counting waiting as work.** Covered above; it is worth stating twice because it is the mistake
that survives review.

**Counting the worst case as the case.** The request that took forty minutes is real, and so are
the nineteen that took four. Use the median across observed occurrences.

**Counting a step that happens sometimes as a step that happens always.** A clarification round
occurs on perhaps one request in four. Either record the step's minutes *and* its frequency and
multiply, or record it at its expected value and say so in the step's `note`. Recording the full
duration of an occasional step as if it happened every time inflates the baseline enormously and
invisibly.

---

## 6. The labour rate

Fully loaded — wage, payroll tax, benefits, overhead — for the people who actually do the work,
not an average across the company. Payroll knows. It is one question.

```js
labourRateCentsPerHour: 6000,
labourRateProvenance: 'MEASURED',
labourRateSources: [source({ kind: 'HISTORICAL_RECORD', ref: 'payroll, 2026 rates, office + workshop blended' })],
```

Without it, hours returned can be reported and money cannot. That is a legitimate state and the
case study renders it as `NOT MEASURABLE`.

---

## 7. Versioning, and the one rule about editing

A baseline is `effectiveFrom` a date. Executions bind to the version in force **when they started**.
Consequences, all deliberate:

- Work done before the baseline existed cannot be valued against it. There is no retroactive
  justification.
- Re-measuring the old process creates a **new version** with a new `effectiveFrom`, and closes the
  old one with `effectiveTo`. It never edits the old one — figures already published stay
  reproducible.
- A total spanning two versions reports both in `baselinesUsed`, and the case study says so.

**Never edit a number into a baseline file without also changing its `provenance` and adding a
`source`.** `quantity()` throws on a valued figure with no source, so the attempt fails at import
rather than shipping a fiction — but the rule is stated here because the thrown error is the second
line of defence, not the first.

---

## 8. What to do first, at Lippolis

`proof/baselines/lippolis-purchasing.mjs` names seven steps, each with a `note` describing exactly
what to observe. In order of value:

1. **`stock_check`** — the step PCC most directly replaced, and therefore where a real difference is
   most likely to show.
2. **`po_preparation`** — paper purchase orders exist. They can be sampled without watching anybody.
3. **`tracking_and_filing`** — almost certainly under-estimated, because it happens in fragments.
4. The labour rate — one question to payroll, and it unlocks every money figure.
5. **`cycleHours`** — dated paper POs against dated packing slips. `ESTIMATED`, no observation
   needed, and it is the only route to a cycle-time *improvement* figure.

Steps 2, 4 and 5 need nobody's morning. Do those first.
