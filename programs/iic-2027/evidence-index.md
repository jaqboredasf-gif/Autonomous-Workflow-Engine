# Evidence index

Where each claim's evidence lives. **Pointers, never copies.**

The rule: if a number appears in a pitch, a deck, a customer report or an AXIS answer, it must be
reachable from this table to a source somebody can go and check. A figure in a slide with no path
back into the repository is not evidence, whatever it says.

---

## Claims we can make today

| Claim | Derived by | Traces to |
|---|---|---|
| N executions in a period | `proof/ledger.mjs` `aggregate()` | `purchase_requests` rows |
| Objective success rate | `proof/case-study.mjs` `caseStudy()` | `received_at` vs `need_by_date`; ordered vs received quantities |
| Human interventions, by kind | `proof/execution.mjs` `touchProfile()` | `purchase_activity_log` rows carrying an `actor_id` |
| Cycle time under AWE | `proof/execution.mjs` `cycleFromTimestamps()` | `created_at` → `received_at` |
| Task completed ≠ objective achieved | the four separate fields on an `ExecutionRecord` | the same columns, read differently |
| % of the capability that is configuration | `scripts/eval-purchasing-redeployability.mjs` | `capability/purchasing/profile.mjs` |
| Deployment readiness | `deployment/evidence.mjs` `readiness()` | an evidence log — **not yet committed** |

## Claims we cannot make today, and why

| Claim | Blocked by | Named in |
|---|---|---|
| Human hours returned | no measured baseline; no per-interaction duration | `INSTRUMENTATION_GAPS`, `docs/proof/PCC_INSTRUMENTATION.md` §2 |
| Money saved | the above, plus no loaded labour rate | the same |
| Cycle-time improvement | no pre-AWE elapsed time | the same |
| Error / rework reduction | corrections are new requests with no link to what they correct | the same |
| Customer testimony | nobody outside the deploying organization has used it | `programs/discovery/` |

**Do not soften any row in the second table for a pitch.** The case study prints
`NOT MEASURABLE`, and a judge or a finance director who finds a number in a slide that the system
refuses to produce has found the only thing that matters about all of it.

---

## How to answer "how do we know?"

```bash
node scripts/proof-case-study.mjs --db /data/pcc.sqlite --org lippolis \
     --from 2026-09-01 --to 2026-10-01 --explain
```

Walks any headline figure down to the executions, the baseline steps, the recorded interactions and
the sources behind it. `explain()` in `proof/case-study.mjs` is the same derivation, as data.

---

## Freezing evidence for the pitch

When a figure is used in a submission, freeze it: export the case study **with its period, baseline
key, touch-standard key and confidence level**, and keep the export. The proof modules are pure and
deterministic — the same database and the same period reproduce the same figure byte for byte — so
a frozen export is checkable rather than merely archived.

Never re-run a frozen figure against a later database and quietly publish the new number. Publish
both, or publish the frozen one and say when it was taken.
