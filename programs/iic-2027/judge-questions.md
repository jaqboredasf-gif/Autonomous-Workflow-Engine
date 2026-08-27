# The questions that would hurt

Not FAQ. The questions a hostile, competent judge — or a customer's finance director, which is the
same conversation with money on it — would ask, and where the honest answer comes from.

**Every answer below is either derivable today or is an admission.** Nothing here is a talking
point. If an answer requires a number, the command that produces it is named.

---

### "You say it saved time. How do you know?"

Today: **we do not, and the system says so.** The case study prints `NOT MEASURABLE` for hours
returned, because nobody has yet timed how the work was done before. That is not modesty; the
software refuses to produce the figure — a baseline with an unmeasured step has no total, and every
figure downstream of it is unavailable.

What we do know, measured: how many executions ran, how many objectives were achieved, how many
times a human had to intervene, and how long the process now takes end to end.

`node scripts/proof-case-study.mjs --db … --org … --from … --to …`

### "So it doesn't do anything?"

It does the work. What we cannot yet do is state its value in hours, because we did not measure the
old process before switching it off. That is a mistake, it is recoverable, and
`docs/proof/BASELINE_METHODOLOGY.md` §8 lists three ways to recover most of it without watching
anybody work: sample the paper purchase orders, ask payroll for the loaded rate, and date the paper
POs against the packing slips.

### "Every workflow tool claims a success rate. What's different about yours?"

Most report that a task completed. We report whether the organization's **objective** was achieved,
which is a different question and usually a lower number.

A purchase order can be issued perfectly for material that arrived three days late. Our system
records that as one execution succeeded and one objective failed, from two different sets of
columns. `proof/adapters/purchasing.mjs` `materialObjective()` is the test, in one function, in
words.

### "Isn't that just a lower number you chose to report?"

It is a lower number the software will not let us not report. Objective success gates valuation: an
execution whose objective was not achieved returns **negative** minutes — the attempt cost real
human time and displaced nothing — and those negatives are summed into the period total rather than
excluded. `scripts/eval-proof.mjs` asserts it.

### "What stops you counting the same saving twice?"

Every execution names a `scopeKey` — the thing in the real world it worked on. The ledger banks one
unit of work once, folds earlier attempts' human cost into the attempt that finally counted, and
reports how many duplicates it collapsed. Two baselines that price the same human work for one
organization are refused outright at the point they would be used.

### "You're a student. Who else has used this?"

Nobody, yet. One organization is deploying it. That is the honest state, it is the weakest thing
about the whole project, and it is what the readiness scorecard's recommended next action has been
pointing at from the day it was written.

### "How do we know these numbers weren't tuned for this pitch?"

The proof modules are pure — no clock, no randomness, no I/O, no network, no model. The suite greps
them for `Date.now`, `Math.random` and `new Date()`. The same database and the same period
reproduce the same figure byte for byte, and the audit chain behind any figure is one flag away:
`--explain`.

### "What happens when the AI gets it wrong?"

Nothing autonomous leaves the building. Vendor email is draft-only, enforced by a database
constraint rather than by a setting. A human reviews every outbound message. That is a business
rule the customer chose, and it is why the human-intervention count is a headline figure rather
than an embarrassment.

### "What's your business model?"

Not yet established, and the readiness scorecard scores it at band 0 for that reason. Pricing
against measured value is the plan; there is no measured value yet, so a price now would be a
number with nothing behind it.

### "Why should this exist in three years?"

Because the question a customer asks in year two is not "did it run" but "what did it do for us",
and almost nothing in this category can answer that. The proof architecture is the answer, and it
is general: it knows nothing about purchasing, and the second capability plugs in through an
adapter.

---

## What to do with these

Rehearse the three that end in an admission — hours, external users, business model — until saying
them is boring. An admission delivered smoothly reads as rigour. The same admission delivered badly
reads as a gap somebody just found.
