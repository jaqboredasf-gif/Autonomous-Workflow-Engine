# proof — can AWE prove what it accomplished?

The chain, end to end:

```
ORGANIZATIONAL PROBLEM → BASELINE → OBJECTIVE → AWE EXECUTION → RESULT
  → OBJECTIVE SUCCESS → BUSINESS OUTCOME → VALUE → EVIDENCE → LEARNING
```

One rule every module obeys: **unknown stays unknown.** Nothing here will produce a number to fill
a hole. An organization that has not measured its old process gets no hours-returned figure at all
until it does — no default, no placeholder, no industry average.

Capability-neutral, and a sibling of `capability/` and `deployment/` rather than part of the
purchasing application. Purchasing adapts into it; it does not learn purchasing.

---

## The modules

| Module | Owns |
|---|---|
| `provenance.mjs` | How do we know, and how well. Grades, sources, and arithmetic that degrades to its weakest input. |
| `baseline.mjs` | What the work cost before AWE, and what one interaction with AWE costs a human now. |
| `execution.mjs` | What happened, in a vocabulary no capability owns. Holds the task-completed / objective-achieved distinction. |
| `value.mjs` | **The deep module.** One execution's worth, behind the tenant, baseline-version and objective gates. |
| `ledger.mjs` | Many executions into one total, with double counting, retries, selection bias, drift and overhead all accounted for. |
| `case-study.mjs` | The projection every surface reads, and `explain()`. |
| `adapters/purchasing.mjs` | PCC's records in this vocabulary. |
| `adapters/purchasing-sqlite.mjs` | The read, separated from the reader so a test can exercise the SQL. |
| `baselines/lippolis-purchasing.mjs` | Organization #1. Every duration `UNAVAILABLE`, on purpose. |

Pure throughout: no clock, no randomness, no I/O, no network, no model provider. Asserted by the
suite, which greps for `Date.now`, `Math.random` and `new Date()`.

---

## The five ideas that carry the weight

**1. Every figure carries a grade and a source.** `MEASURED · ESTIMATED · INFERRED ·
SELF_REPORTED · UNAVAILABLE`. A derivation grades at its **weakest** input and can never be
promoted. `UNAVAILABLE` means `value === null` — never `0`, which is the usual route by which an
ROI system starts lying. A known figure with no source is refused at construction.

**2. Task completed is not objective achieved.** Four fields, never merged:

```
executionOutcome   COMPLETED | REFUSED | FAILED | ABANDONED
objectiveSuccess   ACHIEVED | NOT_ACHIEVED | UNKNOWN | NOT_APPLICABLE
businessOutcome    a record with an attribution grade, or null
economicValue      computed from the above, never from execution success
```

A purchase order issued perfectly for material that arrived three days late is one execution
succeeded and one objective failed, from different columns.

**3. The objective gate decides whether a saving exists.**

| Objective | Human minutes returned |
|---|---|
| `ACHIEVED` | baseline handling − minutes spent under AWE |
| `NOT_ACHIEVED` | **negative** — a human still has to do the whole job, so the attempt is a net cost |
| `UNKNOWN` | `UNAVAILABLE` — a purchase that has not arrived has saved nobody anything yet |
| `NOT_APPLICABLE` | excluded, with its human cost still reported |

**4. Machine time is not labour.** Elapsed time lives on `record.cycle` and `value.mjs` reads it
only for the cycle-time comparison. It is never converted into labour or money, and the labour path
has no access to it.

**5. Aggregation is where an honest figure becomes a dishonest headline.** So the ledger refuses
rather than warns: one `scopeKey` banks once and folds earlier attempts' cost in; failures sum in
negatively; coverage and exclusion reasons are reported beside every total; two baselines pricing
the same human work are refused; unmeasured overhead refuses a net figure rather than being
ignored; confidence is derived from coverage and grade, never set.

---

## Run it

```bash
node scripts/eval-proof.mjs                                       # 199 checks, mostly adversarial
node scripts/proof-case-study.mjs --db /data/pcc.sqlite --org lippolis \
     --from 2026-09-01 --to 2026-10-01 [--explain] [--json]
```

`--explain` walks a headline figure down to the executions, baseline steps, recorded interactions
and sources behind it. That is the answer to "how do we know?".

---

## What it prints for Lippolis today

Executions, objective success and AWE-era cycle time are real and measured. Every figure that needs
a *before* prints `NOT MEASURABLE`, because nobody has yet timed how Lippolis bought material
before PCC.

**That is the correct output.** The alternative — a plausible number typed into a baseline file by
somebody who has not watched the work — is what this package exists to make impossible.

To change it: `docs/proof/BASELINE_METHODOLOGY.md` §8. Three of the five items there need nobody's
morning.
