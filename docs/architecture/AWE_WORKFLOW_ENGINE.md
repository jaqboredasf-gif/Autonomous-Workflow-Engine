# AWE Workflow Engine — extraction analysis (Phase 4A)

Gate document: complexity map and interface comparison first, implementation after.

## 1. Complexity map — where workflow knowledge lives today

| Knowledge | Where | Reusable? |
|---|---|---|
| Valid states (14) | `domain/status.mjs` `REQUEST_STATUSES` | shape yes, values no |
| Legal edges | `domain/status.mjs` `TRANSITIONS` | shape yes |
| Terminal states | `domain/status.mjs` `TERMINAL_STATUSES` | shape yes |
| Content preconditions | `transitionGuard()` — a chain of `to === 'X' && !ctx.hasY` | **mechanism yes, conditions no** |
| Refusal vocabulary | `GUARD_REASONS` | mechanism yes |
| Fact gathering | `context.ts` `transitionFacts()` — five repository reads | no (PCC repositories) |
| Permission per transition | **scattered**: `must(ctx, actor, 'review.decide')` at each call site | mechanism yes |
| Event per transition | **scattered**: `emit(...events.approved(...))` at each call site | mechanism yes |
| The write itself | `context.ts` `transitionTo()` | mechanism yes |
| Second opinion | `record_purchase_decision()` RPC, migration 0028 | no |

**15 transition call sites**, across `requests.ts`, `decisions.ts`, `fulfilment.ts`.

### The actual duplication

`transitionGuard` has **exactly one production consumer** — `context.ts:164`. Everything
else referencing it is a test. So the graph is not the problem; it is already
centralised and already good.

The problem is that **an action is not a first-class thing**. "Approve" exists as
three unrelated fragments in three places:

- the permission: `must(ctx, actor, 'review.decide')` in `decisions.ts`
- the precondition: `to === 'APPROVED' && !ctx.hasReview` inside `transitionGuard`
- the event: `events.approved(...)` passed to `emit()` by the caller

Nothing binds them. A new action can be added with a permission and no event, or a
precondition and no permission, and nothing notices. **That** is the reusable gap,
and it is what an engine should close.

## 2. Two interfaces

### Design A — guard as a service

`evaluate(definition, {from, to, facts})` → `{ok}|{ok:false, reason}`. The engine
becomes a home for the graph and the precondition chain; callers keep doing the
write, the permission check and the event themselves.

- Public surface: 1 function, trivially simple
- Depth: **shallow** — it is `transitionGuard` with the conditions injected, and
  `transitionGuard` already exists and already works
- Duplication removed: the precondition chain only
- Enforced event output: **no** — the caller still invents its own events
- Risk: near zero
- Verdict: it moves a file. It does not remove system-wide knowledge.

### Design B — action-centric execution

One definition binds each action to its permission, its preconditions, its target
state and its event. One entry point executes it:

```
executeTransition({ workflow, action, from, actor, facts, policy, effects })
```

- Public surface: `defineWorkflow` + `executeTransition` + refusal reasons
- Depth: **deep** — legality, preconditions, authorization ordering, event
  emission and the state write all happen behind one call
- Duplication removed: permission, precondition and event stop being three
  separate decisions made in three files and become one row of a table
- Enforced event output: **yes, structurally** — the definition cannot declare an
  action without an event, and the engine writes the event as part of the
  transition. A caller cannot obtain the new state without it.
- Invalid states hard to represent: an action with no target state, no event, or
  an unknown permission fails at definition time, not at run time
- Risk: 15 call sites change. All 15 already funnel through `transitionTo()`.

### Chosen: **B**

A is a file move. B removes the thing that actually costs: the need to know, at
every call site, which three fragments a transition requires. The Ousterhout test
is whether the caller has less to know afterwards, and only B passes it.

## 3. Boundary

The engine knows: state, action, transition, guard, permission requirement,
evidence, event, execution result.

It does not know: purchase orders, vendors, workshop stock, job numbers,
Supabase, Next.js, or any PCC identifier. Preconditions arrive as **named fact
predicates evaluated against a facts object the caller supplies**; the engine
never reads a repository. Authorization arrives as an **injected policy
function**; the engine never imports `roles.mjs`.

Machine-checked, not documented: an architecture test asserts the package
imports nothing from `apps/`, nothing named supabase/next/react, and that no
PCC vocabulary appears in its source.

## 4. Location

`packages/workflow` (`@awe/workflow`), beside the existing `packages/shared` and
`packages/mcp-server`. The monorepo already has a packages workspace; nothing is
reorganised.

## 5. Out of scope, recorded for later

- `EMAIL_DRAFT_TRANSITIONS` in `domain/email.mjs` is a **second state machine**
  with its own `canTransitionDraft` and `draftGuard`. It is a genuine candidate
  for the same engine and is deliberately left alone in 4A: migrating the
  purchasing machine first proves the interface on the harder case.
- `record_purchase_decision()` duplicates transition legality in plpgsql. That is
  defence in depth by design (two providers, one of them RLS-enforced) and stays.
- `availableActions()` in `roles.mjs` answers "what may be offered" and overlaps
  the definition's action list. Unifying it is a candidate for 4B.
