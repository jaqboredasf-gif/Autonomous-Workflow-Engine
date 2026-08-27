# Customer discovery

One question, and the structure exists to answer it:

> **Is this one customer's custom request, or a repeated market problem?**

A pile of transcripts cannot answer it. A CRM cannot either — a CRM tracks a deal, and at this
stage tracking deals optimises for closing rather than for learning.

---

## The record

`interview.mjs`. Small, and one field does the work: **`patternTags`**, a snake_case controlled
vocabulary. An interview without tags is refused, because an untagged interview cannot contribute
to finding a pattern, which is the only reason the record exists.

```js
import { interview } from '../interview.mjs';

export const i014 = interview({
  id: 'i014',
  at: '2026-10-02',
  organization: 'north-shore-electric',       // REQUIRED — what makes counting honest
  organizationType: 'electrical contractor, ~30 staff',
  role: 'office manager',
  internal: false,                            // inside the deploying org? then it is not external
  workflow: 'buying material for a job',
  pain: 'the same job and vendor details get typed into three systems',
  frequency: '10-15 times a day',
  currentTools: ['Outlook', 'Excel', 'QuickBooks'],
  humanTimeStated: 'about twenty minutes a purchase',
  failureModes: ['wrong quantity ordered', 'nobody knows if it shipped'],
  economicConsequence: 'a crew stood down for a morning, maybe monthly',
  existingWorkaround: 'a shared spreadsheet one person maintains',
  willingnessToChange: 'OPEN_IF_PROVEN',
  willingnessToPay: 'WOULD_PAY_STATED_AMOUNT',
  statedAmount: '$200-300/month',
  capabilityFit: 'purchasing — close fit; no stock location, so the stock-check step does not apply',
  patternTags: ['duplicate_data_entry', 'no_visibility_of_orders'],
  followUp: 'send the one-pager; offered to try it',
  designPartnerInterest: true,
});
```

Drop the file in `programs/discovery/interviews/`. `scripts/iic-readiness.mjs` picks it up and the
readiness bands move on their own.

---

## The rule that makes it worth doing

**Independence is by organization, not by interview.**

Three people at one company describing the same frustration is **one organization's** frustration,
however strongly they agree with each other. `repeatedPatterns()` counts organizations, and it will
return nothing at all for three interviews inside one company. Treating that as three data points
is how a bespoke build becomes a "product" in a founder's head.

Conversations inside the deploying organization are marked `internal: true`. They are valuable and
they are **not** external validation, and they are counted separately everywhere.

---

## The protocol

`PROTOCOL` in `interview.mjs`. Twelve questions, and the order matters more than the wording:

1. **Open on their process, not on AWE.** "Walk me through what happens when…" Asking about AWE
   first produces politeness; asking about their Tuesday produces a workflow.
2. **Steps before durations.** "How long does purchasing take you?" produces a feeling. Six named
   steps produce six numbers they will defend.
3. **What the problem costs them, before what a solution might.** The money question changes every
   answer that comes after it, so it comes last.
4. **Close on design-partner interest.** Time is a cheaper ask than money and a better signal than
   enthusiasm.

---

## What "enough" looks like

| Milestone | Threshold | Why |
|---|---|---|
| Not anecdote | 5 external interviews | below this, everything is noise |
| A pattern may be visible | 20 external interviews | the December 2026 target |
| A pattern is real | 3 tags named independently by 2+ outside organizations | this is what moves `problem_evidence` past band 2 |
| Somebody wants it | 2 design-partner candidates | time committed, not money |

---

## What this is not

No pipeline. No stages. No owner. No next-action date. No lead scoring.

If it starts needing those, the company has moved from research to selling, and that is a different
tool and a different file.
