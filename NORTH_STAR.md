# AWE — North Star

## Mission

AWE (Autonomous Workflow Engine) exists to **do a company's routine operational work itself, under
the company's own rules, so its people don't have to.** That means the requests, approvals, records
and follow-ups that are really just information moving between people, paper, email and software.

The long-term aim is an operating system for autonomous business execution. It studies how an
organization actually works, finds work that can be executed or improved, executes bounded work,
measures the result against a baseline, keeps every action auditable, and escalates consequential
decisions to the humans who own them.

## Current proving ground

**Lippolis Electric**, through the **Purchasing Control Center (PCC)**, on the `pcc-production` branch.
PCC is the first capability that is deployable, signed for installation and instrumented for
measurement. Workstream A (time tracking / ExakTime replacement) and Workstream B (work-request
triage) are the next capabilities on the same organization.

The second objective is to make AWE a **demonstrable company** that can win the **Iona Innovation
Challenge 2027**. That challenge is a deadline, not a product. The evidence deadline is
**31 January 2027** (`programs/iic-2027/MASTER_SPEC.md`), and anything built for it must be worth
building if the challenge were cancelled.

## Product principles

1. **Governance first.** Authority is explicit, per role and per action type. Automation holds zero
   approval authority unless a human has granted it, scoped and revocably.
2. **Humans approve consequential actions.** Sends, money, schema, auth, deployments and anything
   customer-facing go through a recorded human decision.
3. **Auditability.** Every state change has an attributable, append-only record. No hard deletes.
4. **Tenant isolation.** Every row, query and total is scoped to one organization. Cross-tenant
   leakage is a refusal, not a warning.
5. **Deterministic where possible.** Rules, routing, gates and verification are code. A model is used
   only where judgment is unavoidable, with budgets and fail-closed defaults.
6. **Measured, not declared.** A result counts only if it is derived from something that happened:
   a production execution, a measured baseline, a recorded conversation. Rehearsal data never counts
   as evidence.
7. **Reusable capabilities, not one-off hacks.** A second organization should be configuration, not a
   fork.
8. **Reliability over impressive demos.** A fortnight of purchasing nobody had to work around beats
   any feature.

## Success metrics

These are **not new metrics**. They are the ones the repository already derives, so the autonomy
system can read them instead of re-measuring. Source of truth: `npm run plan`, `npm run readiness`
and `npm run evidence` on `pcc-production`.

**Stage gates** (`programs/venture/gates.mjs`), in order:
1. Production ready → 2. First real proof → 3. Repeatable solution → 4. Commercial validation → 5. IIC ready

**The twelve claims** (`programs/venture/claims.mjs`), each graded UNAVAILABLE / INFERRED / MEASURED:
`problem_real`, `problem_economic`, `awe_solves`, `works_in_production`, `measurable_value`,
`multi_capability`, `not_hardcoded`, `external_pain`, `external_want`, `will_pay`,
`repeatable_deployment`, `path_beyond_wedge`.

**Outcome metrics** (`proof/` value and ledger):
- hours returned to users, measured against a frozen baseline and net of AWE's own overhead
- workflow cycle time (raised → received) versus baseline
- production executions, active days, and organizations in production
- objective-achieved rate (an unachieved objective counts as negative value)

**Operating metrics for the autonomous development loop itself** (new; defined in
`docs/autonomy/ARCHITECTURE.md`):
- verified-progress rate: cycles whose change passed the independent evaluator *and* was approved
  by Jack
- intervention rate: cycles needing human correction beyond approve/reject
- false-green rate: approved changes later reverted or found broken (target 0)
- time-to-understand: the Captain Brief is readable in about 2 minutes

**Deliberately not a metric:** probability of winning, feature count, lines of code, or any readiness
number moved by declaration.

## The question every cycle answers

> What is the highest-leverage action available right now that increases AWE's ability to achieve
> this North Star, and what evidence says so?

If the honest answer is "a human act at Lippolis", the system says so and does not invent
engineering work to fill the gap.
