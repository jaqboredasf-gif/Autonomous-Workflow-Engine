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

## 5. Phase 4B — what closed

- **The email draft machine runs on the engine.** `EMAIL_DRAFT_TRANSITIONS`,
  `canTransitionDraft()` and `draftGuard()` are gone; `domain/email-workflow.mjs`
  is one table. The engine needed **no change** to express it, which is the
  evidence 4A could not produce: an engine one machine fits is a refactor, an
  engine two unrelated machines fit is a capability.
- **`availableActions()` derives from the workflow.** The hand-written switch
  over statuses is gone. It was a second copy of the graph and it had already
  drifted — it offered `approve` on any queued request whether or not a workshop
  review existed, so the button was there and the server refused it. The menu
  now uses the same definition, permissions and evidence the executor does, and
  a test walks every state asserting that anything offered would be accepted.
  UI names stay in a presentation map; the engine never learns them.
- **Database parity: the duplication is KEPT, and checked.** The plpgsql guard
  is the last fence for a client that is not this application, and
  `record_purchase_decision()` is security-definer. Removing either would leave
  TypeScript nobody is obliged to run as the only protection. What makes the
  duplication safe is a test: the workflow definition's edges are now checked
  **directly** against the SQL guard, closing the last transitive link, and the
  RPC is asserted to gate on `review.decide` while never refusing on identity.

### Still open

- `guard_purchase_request_transition()` restates the content preconditions
  (`hasReview`, `hasReceipt`, outstanding lines) as well as the edges. Only the
  edges have parity tests; the preconditions are checked in prose. A generator
  that emitted the SQL guard from the definition would remove the class
  entirely, and is the honest next step.
