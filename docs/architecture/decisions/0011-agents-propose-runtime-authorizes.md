# ADR-0011 — Agents propose actions; the governed runtime authorizes and executes them

**Status:** Accepted (2026-07-28) for the design and the implementation in
`packages/awe-agent`. No live credential, no migration, no network call and no
model provider is involved in the implementation, so nothing here is gated on a
human deployment step.

## Context

Everything AWE could execute safely before this decision was **declared in
advance**: a Workflow Manifest lists its steps, its tools, its tenants and its
approval policy at authoring time, and a registry refuses anything that is not
one of those. The authorization question — *may this action happen?* — is
therefore answered once, by a human, when the workflow is written.

A specialized agent breaks that. The whole reason to build one is that the next
action depends on what the last one found: an invoice that turns out to be a
duplicate is routed for review, not paid; a crew that is unavailable is
reassigned, not scheduled. The action is chosen at runtime, and increasingly the
thing choosing it is a model.

Three ways to build that, and the choice between them is the decision:

**Option A — the ordinary agent framework.** Register tools with a model, run
what the model asks for, add guardrails around the edges (a system prompt, an
allow-list, a confirmation dialog for "dangerous" tools). This is what almost
every agent library does. Its security model is: *the model is expected to
behave, and the guardrails catch the obvious cases.* A prompt injection inside a
supplier's invoice is then a genuine escalation path, because the model's
decision **is** the authorization decision.

**Option B — refuse dynamic action entirely.** Keep every path declared. Safe,
and it forecloses the business capability this platform exists to build.

**Option C — invert the relationship.** The model produces a *proposal*; a
runtime the model cannot reach decides whether the proposal becomes an action,
using facts the model never supplies.

Two further pressures made C the only workable option here:

1. **The control plane's authorization machinery already exists and is good.**
   Deny-by-default tenant grants, the three-way side-effect ceiling, the
   controlled tool boundary with nine refusals and idempotency, the append-only
   journal, run leases with fencing. A second, agent-shaped authorization
   implementation would drift from it, and the day the two disagree one of them
   is wrong in production.
2. **`AGENT_HARNESS_DOCTRINE.md` G4 — "automation approves nothing" — has to
   survive contact with an agent that can propose consequential work.** Under
   Option A, G4 is a convention the model is asked to respect. Under Option C it
   is a code path the model cannot reach.

## Decision

**An agent proposes an action. The governed runtime authorizes and executes it.**

Concretely, and each clause is load-bearing:

### D1 — A planner receives a closed, redacted Planning View and returns an Action Proposal

The view carries the agent's identity, its capability surface as names and
constraints, the assembled context *with trust and sensitivity labels intact*,
this run's observations, the remaining budget and the refusals already recorded.
It carries no grant, no policy engine, no approval state, no credential, no
environment and no handle to anything executable. The key set is closed and
asserted.

### D2 — A proposal is untrusted input with a grammar

Unknown keys, unversioned capability or tool references, arguments whose keys
begin with `_` (the runtime's reserved envelope), unknown evidence kinds and
malformed argument bags are refused by the constructor. A planner's *self-report*
— its claimed risk, claimed side effect and claimed approval requirement — is
recorded as evidence of what it believed and **is not an input to any
authorization decision**.

### D3 — Authorization is five independent narrowings, in one function

The agent definition, the capability, the tenant grant, the approval and the
budget must all permit the action. No layer may widen another. The tenant-grant
layer is the control plane's existing policy engine, **reused verbatim**.

### D4 — An agent definition compiles to a workflow manifest

Its Execution Surface: one step per permitted `(capability, operation, tool)`
binding. This is how the control plane's machinery is reused rather than
reimplemented, and it makes an agent's complete action space one readable
document. The surface is the coarse ceiling; the per-capability rules narrow it
further.

### D5 — A capability is a business permission, not a tool handle

Tool access never implies business authorization. A capability declares
operations, tool bindings with their own version requirements and ceilings, risk,
approval threshold, tenant scope, actor roles, data classification, idempotency
and audit obligations — and is reusable across agents.

### D6 — An approval binds to the exact action

The binding digest covers the tenant, the agent version, the **resolved**
capability and tool versions, the operation and the arguments. Commentary is
excluded on purpose. A material change is `approval_binding_mismatch`; an
approval also expires. On resume the run **re-authorizes from scratch** — the
approval is one input to a decision that is made again, not a token that skips
the gate.

### D7 — Agent events extend the existing journal; the phase is a second projection

`agent.*` event types were added to the control plane's transition table, all
with `to: null`. There is no second journal and no stored phase.

### D8 — Improvement is measured; change is promoted by a human to a draft

An evaluation record activates nothing. A candidate requires evidence, a human
review and a human promotion, and promotion produces a **draft** version that
still cannot execute until a separate human activation and a redeploy.

### D9 — The model provider is a port, and there is no vendor name in the plane

Asserted by a source-purity lint. A deterministic planner is a first-class
production implementation, which is also what makes the whole plane testable
without a key or a network.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **A: model-selected tools with guardrails** | Makes the model's decision the authorization decision. Prompt injection becomes privilege escalation, and G4 becomes a convention. Rejected. |
| **B: no dynamic action** | Forecloses the capability the platform exists to build. Rejected. |
| **A second authorization engine for agents** | Two implementations of "may this run?" drift. Rejected in favour of compiling to a manifest (D4). |
| **A separate agent journal** | Two hash-chained histories for one run is exactly the disagreement "state is projected, never stored" prevents. Rejected. |
| **A stored agent phase column** | Same reason the control plane has no `state` column. Rejected; the phase is projected. |
| **Approval as a boolean or a token** | Cannot express "approved *this* payment". Rejected in favour of the binding digest (D6). |
| **Prompt-injection detection** | We would be claiming a property we cannot hold. Rejected; injection is defeated architecturally and the fixture's payload is deliberately unfiltered. |
| **An `agent_*` table set now (the H0 design)** | ADR-0001 is unratified, and the plane needs no new schema — it persists through the ADR-0010 stores. Deferred, not rejected. |
| **A model client in the package** | Ties the domain to a vendor and makes the plane untestable without a key. Rejected in favour of a port (D9). |

## Consequences

**Good.**
- A model cannot cause an unauthorized action, whatever it is told to do, because
  it never reaches the thing that acts.
- The authorization decision is *evidence*: an immutable, digest-pinned Policy
  Decision Record naming every version it was made against.
- Future agents — dispatch, scheduling, reporting, crew coordination, document
  handling, estimating, customer operations — inherit all of it by writing a
  definition and a planner. No new authorization code.
- The whole plane is testable with no provider, no key and no network.

**Costs, accepted and named.**
- **Latency and turns.** Every action costs a planning turn plus an
  authorization pass. A rules planner mitigates it; a model planner will not.
- **A planner cannot improvise.** Anything outside the declared capability
  surface is refused, so a genuinely novel situation ends as a refusal rather
  than as an improvisation. That is the intended trade.
- **A refusal terminates the run.** No automatic retry, by doctrine. Recovery is
  a new run.
- **Two documents to maintain per agent** (definition + capabilities), and a
  compile step that can refuse them.
- **The composition is trusted.** Whoever builds the service picks the
  registries, grants, planners and adapters. The plane makes that choice
  explicit, versioned and auditable; it does not make it for you.

## Security impact

Net **positive and structural**, not incremental:

- prompt injection in a document or a tool result cannot grant a capability,
  remove an approval requirement or redirect a payment — asserted with planners
  that obey the injection completely;
- an agent cannot grant itself a capability, a tool, a policy, memory access or
  approval authority: governance argument keys are refused at any depth, and
  there is no self-activation path at any privilege level;
- tenancy is an argument at every boundary, and cross-tenant arguments, context
  and evidence are refused rather than filtered;
- `actor: 'human'` is checked first and unconditionally on both the approval path
  and the improvement path;
- every budget is NOT NULL and > 0 — an unbounded agent cannot be configured;
- LIVE mode remains refused outright by the control plane's policy engine, so
  nothing in this plane can reach a live credential or a live side effect.

Two claims deliberately **not** made: we do not detect prompt injection, and we
do not defend against a malicious composition.

## Operational impact

- No new table, no migration, no schema decision. The plane persists through the
  ADR-0010 stores (`memory`, `local_file`, `postgres`).
- One new package (`packages/awe-agent`), one new service
  (`createGovernedAgentService`), one new suite (**Runner G**,
  `scripts/eval-governed-agent.sh`), one new reason namespace (`agent`).
- Runner P's event-type coverage gate was split into `WORKFLOW_EVENT_TYPES` and
  `AGENT_EVENT_TYPES` so each suite is still held to *everything it owns*.
- Deploying a new agent version is a code change plus a registry composition —
  the same review path as any other code, which is the point.

## Reversal strategy

The plane is additive and isolated:

1. `packages/awe-agent` and `agent-service.mjs` are new files with no importers
   outside themselves, the reference agent and Runner G. Removing them removes
   the plane.
2. The only edit to an existing behavioural file is the additive block of
   `agent.*` entries in `journal.mjs`'s transition table, every one with
   `to: null`. Removing that block restores the previous vocabulary exactly; no
   existing transition was changed.
3. `scripts/lib/awe-reasons.mjs` gains one `reasons.register('agent', …)` line.
4. No data migration to reverse, because no schema was added.

## Related tasks and guardrails

- Doctrine G4 ("automation approves nothing") — enforced first on both the
  approval and the improvement paths.
- G10/G11 (untrusted content stays untrusted; nothing ungrounded is consumed) —
  enforced by the context labels the planning view preserves and by the evidence
  check.
- ADR-0002 (harness database access path) — untouched and still unratified. This
  plane grants no data-plane access and holds no credential.
- ADR-0010 (durable execution repository) — reused as-is for persistence.
- ADR-0001 / the H0 Agent Harness documents — neither contradicted nor
  implemented; see `GOVERNED_AGENT_EXECUTION_PLANE.md` §11.
