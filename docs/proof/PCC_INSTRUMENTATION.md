# What PCC can prove today, and what it would take to prove more

The measurement question, answered against the schema rather than against intentions.

- The reader: `proof/adapters/purchasing-sqlite.mjs`
- The translation: `proof/adapters/purchasing.mjs`
- The command: `node scripts/proof-case-study.mjs --db <path> --org <id> --from <date> --to <date>`
- The tests: `scripts/eval-proof.mjs`

**Nothing was added to the purchasing schema to make this work.** Everything below is read from
columns PCC already writes.

---

## 1. Measurable today, with no change to anything

| Metric | Grade | Where it comes from |
|---|---|---|
| Executions in a period | `MEASURED` | `purchase_requests.created_at` |
| Execution outcome (completed / refused / abandoned) | `MEASURED` | `purchase_requests.status` |
| **Objective success** — material in hand, in full, by the need-by date | `MEASURED` | `received_at` vs `need_by_date`, `purchase_order_items.order_qty` vs summed `purchase_receipt_items.received_qty` |
| Human interventions, by kind | `MEASURED` | `purchase_activity_log` rows carrying an `actor_id` |
| Distinct people involved | `MEASURED` | the same |
| Clarification rounds (retries) | `MEASURED` | `clarification.requested` rows |
| **Cycle time under AWE** — request raised to material in hand | `MEASURED` | `created_at` → `received_at` |
| Administrative overhead interactions | `MEASURED` | the `admin.*` actions, collected as a period cost |

That set is not small. It supports the two claims that matter most and that most tools cannot make:

- **Task completed is not objective achieved.** PCC can issue a flawless purchase order for
  material that arrived three days late, and the case study reports that as one execution succeeded
  and one objective failed. Both figures are real.
- **The success rate is over what could be TESTED**, never over everything. A request still in
  transit is `UNKNOWN` and sits in neither the numerator nor the denominator.

---

## 2. Not measurable today, and exactly why

| Metric | Blocked by | Grade it would reach |
|---|---|---|
| Human hours returned | no baseline; no per-interaction duration | `MEASURED` |
| Labour value returned | the above, plus no loaded labour rate | `MEASURED` |
| Cycle-time improvement | no pre-AWE elapsed time | `ESTIMATED` |
| Error / rework reduction | corrections are new requests with no link to what they correct | `MEASURED` |
| Money saved / protected / created | requires an attributed business outcome; none recorded | varies |

### The one that limits everything: PCC records *when*, not *how long*

`purchase_activity_log` has `actor_id`, `action`, `at` and `seq`. It has no duration column, because
nothing that built it needed one.

So observed human handling under AWE is, today, **a count of interactions multiplied by a
per-interaction standard**. `proof/baseline.mjs` makes it impossible to record that product as
better than its inputs: a standard obtained by asking somebody is `SELF_REPORTED`, and a derived
total grades at its weakest input. An action nobody has priced is `UNAVAILABLE`, which makes the
whole execution unvaluable — because under-counting human time *over-states* hours returned, and
that is the error that flatters us.

**The fix, when it is worth building:** a `duration_ms` column on `purchase_activity_log`, written
by the server action from a client-reported interaction span. `humanTouch({ observedMinutes })`
already accepts it and `observedHumanMinutes()` already prefers it over the standard, promoting that
touch to `MEASURED`. Nothing else changes.

**The cheaper fix, available now:** one timed session with one purchaser doing a normal morning's
work produces `MEASURED` durations for the actions that occur and leaves the rest visibly unpriced.

---

## 3. The full gap list

Held as data in `proof/adapters/purchasing.mjs` (`INSTRUMENTATION_GAPS`) and asserted by the suite,
so it cannot quietly go stale:

| id | Missing | Unlocks | Where the change goes |
|---|---|---|---|
| `human_dwell_time` | how long one interaction takes | observed human handling | a duration column on `purchase_activity_log` |
| `pre_awe_baseline` | timed observation of the paper process | hours returned, labour value | `proof/baselines/lippolis-purchasing.mjs` |
| `pre_awe_cycle_time` | how long the paper process took | cycle-time improvement | the baseline's `cycle` fields |
| `loaded_labour_rate` | fully-loaded hourly cost | labour value, money saved | the baseline's `labourRate` fields |
| `rework_and_error_rate` | whether a purchase was corrected later | error and rework reduction | a supersedes reference on `purchase_requests` |

---

## 4. What the case study prints today

Verbatim shape, from a database with three requests:

```
Executions:              3
Objective achieved:      1 / 2 testable  (50%)
  not yet testable:      1
Human interventions:     4

Baseline handling time:  NOT MEASURED (per purchase request)  [UNAVAILABLE]
Human hours returned:    NOT MEASURABLE  [UNAVAILABLE]
Cycle time (median):     197.0 h over 2 sample(s)
Cycle time saved:        NOT MEASURABLE over 0 sample(s)
Labour value returned:   NOT MEASURABLE  [UNAVAILABLE]

Evidence confidence:     NONE
```

**This is the correct output.** The alternative — a plausible number typed into a baseline file by
somebody who has not watched the work — is the thing `proof/` exists to make impossible.

To change it, follow `docs/proof/BASELINE_METHODOLOGY.md` §8. Three of the five items there need
nobody's morning.

---

## 5. Production readiness of the measurement itself

| Question | Answer |
|---|---|
| Does it write anything? | No. The reader takes an open read-only handle and issues four `select`s. |
| Can it cross a tenant boundary? | No. `orgId` is required and every statement filters on it; a foreign baseline or touch standard is a throw, not a mismatch. |
| Does it need the application running? | No. It reads the database file, so it works against a backup. |
| Does it need network or an LLM? | No. Every module in `proof/` is pure — no clock, no randomness, no I/O, no provider. |
| Is it deterministic? | Yes, and asserted: the same inputs produce byte-identical output, and the suite greps the modules for `Date.now`, `Math.random` and `new Date()`. |
| What happens when evidence is missing? | It is a result, not an exception. Missing evidence returns `UNAVAILABLE` with a stated reason; only tenant violations throw. |
