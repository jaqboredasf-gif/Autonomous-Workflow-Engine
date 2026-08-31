# What we need to learn before AWE has a price

**There is no AWE pricing model, and inventing one now would be the expensive kind of guess.** A
price set before anybody has said what the problem costs them is a number we would then spend a year
defending.

This is a list of things to find out and how to find them out. It is short on purpose.

---

## The five things we do not know

| # | Question | How we learn it | When |
|---|---|---|---|
| 1 | **What does the problem cost them today?** | Interview question 2 — the last time it went wrong, how often, what it cost. Their figure, recorded as `STATED`. | The first five conversations |
| 2 | **Who owns the budget?** | Ask, at the end: *"If you wanted something like this, whose decision would it be?"* | Conversations 5–20 |
| 3 | **What do they already pay for?** | *"What software do you pay for now, and what does it cost?"* — an anchor they chose | Conversations 5–20 |
| 4 | **Will they pay at all?** | Ask for a figure unprompted: *"What would you expect something that fixed it to cost?"* Silence is an answer. | Every conversation, last |
| 5 | **What shape do they expect?** | *"Would you expect to pay once, or monthly?"* | Once a design partner exists |

**Question 1 is the one that matters.** A price is only defensible against a cost the customer
already believes in, and the case study is measuring exactly that at Lippolis.

---

## What we are NOT deciding yet

Implementation fee plus recurring; per organization; per capability; per seat; usage tiers. All of
these are plausible and **none of them will be chosen from an armchair.** The shape follows from who
owns the budget and what they already buy, and we do not know either.

---

## The one experiment worth running early

**With the first design partner, before any price is named:**

> "If this worked exactly as we've described, what would it be worth to you a month?"

Then say nothing. Whatever they say first is the most useful number in this whole document —
including if the answer is "nothing, but I'd use it".

**Record it as `willingnessToPay` with `statedAmount`.** `npm run discovery` counts how many
prospects named a figure unprompted, which is the only pricing evidence that exists until somebody
pays.

---

## What would make this document obsolete

Two organizations independently naming figures in the same range for the same capability. At that
point there is something to test rather than something to guess, and the plan becomes a price.
