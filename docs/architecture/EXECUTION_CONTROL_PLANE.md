# AWE Execution Control Plane

**Status:** implemented and verified offline (Runner P, 372 gates, 0 failures).
**Scope:** local, synthetic, TEST-only. No database, no n8n, no model provider,
no external service, no credential.

## What this is

The layer between the deterministic kernel (`@exattime/awe-kernel`, which
*executes*) and the platform runtime (`@exattime/awe-runtime`, which *persists
and exposes*). It answers the questions the kernel deliberately refuses to
answer:

| Question | Module |
|---|---|
| Which workflow, at which version? | `manifest.mjs`, `workflow-registry.mjs` |
| May this tenant run it? | `workflow-registry.mjs`, `policy.mjs` |
| May this tool run, and must a human say yes first? | `policy.mjs`, `dispatch.mjs` |
| What actually happened, provably? | `journal.mjs` |
| What happens on failure, timeout, cancellation or denial? | `engine.mjs` |

Before this milestone AWE could execute *a body function under a workflow id*.
It could not state which tools that workflow was allowed to touch, which tenants
could run it, what context it needed, when a human had to approve, or whether it
had been promoted out of draft. Every one of those facts lived in a runner or in
someone's head.

## Dependency direction

```
                 packages/awe-kernel          pure; no clock, no I/O, no deps
                          ^
                          |  (single seam: awe-control-plane/src/kernel.mjs)
                          |
             packages/awe-control-plane        pure; injected clock/dispatcher
                          ^
                          |
               packages/awe-runtime            composition + injected I/O
                          ^
                          |
   scripts/awe-control-plane.mjs   |   packages/mcp-server   |   apps/web (future)
```

Enforced mechanically by the layering lint in `scripts/eval-control-plane.mjs`:

* every control-plane module's only outside import is `./kernel.mjs`;
* `kernel.mjs`'s only outside import is `../../awe-kernel/src/index.mjs`;
* the package declares zero runtime dependencies;
* no `fetch`, no sockets, no `Date.now()`, no `new Date()`, no randomness, no
  `process.env`, no `node:fs`, no `child_process`, no `process.exit`.

The lint is proven non-vacuous against a synthetic offender in the same test.

## The pieces

### 1. Workflow Manifest — `awe.workflow_manifest/v1`

A versioned, runtime-validated declaration:

```
{ schema, workflow_id, version, title, description, tenant_scope,
  required_tools, required_context, approval_policy, limits,
  dependencies, risk, promotion, steps, metadata, manifest_digest }
```

Fail-closed rules, each with its own regression case:

* **an unknown key is refused**, so a typo'd `aproval_policy` cannot silently
  turn a gated workflow into an ungated one;
* `tenant_scope` has **no default**; `allow_list` with zero orgs is refused as a
  workflow that can never run, never read as "any tenant";
* a **step naming a tool outside `required_tools` is refused** — the declared
  list is the complete tool surface, not a hint;
* **`high` and `critical` risk require an approval threshold and at least one
  approver role**. A manifest cannot declare itself dangerous and ungated;
* **`promoted` requires `promoted_at` and `promoted_by`** — promotion is an
  accountable act;
* a **compensation step must name an earlier step**;
* a step budget larger than the run budget is refused.

Version requirements are `1.4.2` (pinned) or `^1.4.2` (same major, at least that
minor.patch). Nothing else. A control plane whose authorization surface requires
evaluating `>=1.2 <2.0.0-beta || ~1.1` is a control plane nobody can read.

### 2. Workflow Registry

**Naming:** `packages/awe-kernel/src/registry.mjs` already exists and is the
**suite** registry. The name was taken, so this module is named for what it
holds. Do not create a second `registry.mjs`.

`resolve({ workflow_id, version, org_id })` returns **data**, not an exception —
a refusal is a normal fail-closed outcome the engine turns into a `blocked`
envelope. Five gates in order: registered → version satisfiable → promoted →
tenant in scope → every dependency resolves to a promoted, in-scope manifest.

**No bypass exists.** There is no parameter anywhere in the control plane or the
runtime service that accepts a workflow *definition*. A caller may only *name*
one. Asserted structurally, plus a source lint.

### 3. Policy engine — deny by default

Grants are tenant-scoped data (`{ org_id, workflow_id, tool, version,
max_side_effect, requires_approval_at_or_above, approver_roles }`), the same
"policy as data" shape `message_policies` already uses, so graduating a tenant is
a row rather than a rebuild.

Evaluation order:

1. `mode: 'LIVE'` → **deny `live_mode_unratified`** (see ADR-0002 boundary below)
2. tenant-scoped tool with no `org_id` → deny `tenant_binding_required`
3. tenant outside the manifest scope → deny `tenant_out_of_scope`
4. tool not in `required_tools`, or version incompatible → deny
5. **no tenant grant → deny `tool_not_authorized`**
6. `side_effect` above the effective ceiling → deny. The ceiling is the
   **minimum** of the manifest's `max_side_effect` and the grant's, so no single
   document can widen what another allows
7. `side_effect` at or above the stricter of the two approval thresholds →
   `require_approval`
8. otherwise `allow`

**Doctrine G4 is the first approval rule, unconditionally:** an approval
submitted with `actor: 'service'` is refused whatever roles it claims. That is
the rule a self-approving agent loop would have to break, so it is checked first
and has its own regression case *and* its own non-vacuity perturbation.

### 4. Run Journal — `awe.run_journal/v1`

Append-only, hash-chained, with **state projected rather than stored**. There is
no state setter anywhere in the package, and a source lint asserts there is none.

Seventeen event types, each with an explicit `{ from: [...], to }` transition.
An event type absent from the table cannot be appended at all. **No event lists a
terminal state as a legal predecessor**, so post-terminal appends are impossible
by construction rather than by a separate check.

Four independent integrity checks, each proven load-bearing by deleting it and
watching the suite fail:

| Check | The case only it catches |
|---|---|
| `prev_digest` chain | an entry **transplanted** from another valid journal of the same run |
| per-entry digest | a **backdated** `occurred_at` (excluded from `event_key` by design) |
| kernel `event_key` | a **fully re-chained forgery** — payload edited, every downstream digest recomputed |
| sequence density | *nothing uniquely* — kept as defence in depth, and the suite says so explicitly rather than counting it as coverage |

Tampered documents are **resealed** (outer `journal_digest` recomputed) before
each test, so the header digest cannot mask the per-entry checks. That masking
was a real defect found by perturbation.

A history that chains perfectly but describes an impossible sequence
(`approval.granted` on a run that never requested one) is refused by the
projection.

### 5. Controlled tool invocation

`createToolCatalog()` in the kernel deliberately has no `invoke()`. `dispatch.mjs`
is the only place in the control plane that calls a tool adapter, and it refuses
in nine ways first: registered → lifecycle executable → descriptor digest intact
→ policy allows → approved if required → input validates → effect identity not
claimed by a different input → step budget not exceeded → output validates.

**Idempotency.** Every invocation computes an effect identity (by default
`digest(run, step, tool, version, input)`; a step may declare an explicit key).

* Same identity, same input → **replayed from the record, adapter not called.**
  A resumed run cannot double-issue a payment instruction.
* Same identity, different input → **`idempotency_conflict`, refused.**
* A **timed-out** effect is *not* recorded: its outcome is unknown, so a retry
  must genuinely re-run it.

Effect memory is rebuilt from the journal on every `advanceRun`, so a resuming
process knows what an earlier one committed.

### 6. Run engine

Retry (per-manifest `max_attempts`), step timeout, run timeout, cancellation at
step boundaries, pause on approval, resume, and compensation.

Two deliberate decisions worth knowing:

* **`run_timeout_ms` bounds ACTIVE EXECUTION, not elapsed wall time.** It is
  measured from the current segment's `workflow.started` / `workflow.resumed`,
  so time spent waiting for a human never expires a run. A gate that punished an
  operator for taking the afternoon to decide would train people to approve
  quickly — the opposite of what an approval gate is for.
* **Only deterministic-refusal reasons are non-retryable.** `step_failed` and
  `step_timeout` retry; a policy refusal, an unregistered tool or an idempotency
  conflict refuses identically every time, so retrying them would only burn the
  budget and hide the reason behind an attempt count.

Cancellation and denial **compensate before recording the terminal event**,
because terminal states accept no further events — the journal enforces this.

### 7. Two stores, two jobs

| Store | Holds | Successor |
|---|---|---|
| journal store | the append-only CONTROL record. **Digests only.** | append-only control table (ADR-0002) |
| result store | the tenant-bound DATA record. **Bodies.** | RLS-protected tenant table (ADR-0002) |

Step outputs are *not* in the journal, and the suite asserts it: the serialized
journal for the reference run contains neither `INV-2291` nor `Northgate`, only
`result_digest` values. `report.mjs` and `journal.mjs` both record workflow data
as a digest because a control-plane record is read by people and shipped to logs,
while an invoice's supplier and account number belong in tables already under
RLS. Splitting the stores lets each successor be chosen independently.

Both stores are tenant-checked independently of the service.

## ADR-0002 boundary — the architectural conflict, and how it was resolved

`tools.mjs`, `context.mjs`, `sinks.mjs` and `service.mjs` each state that **no
authorization may be implemented until ADR-0002 is ratified**. ADR-0002 is
*Proposed*, not *Accepted*.

ADR-0002 is about one thing: **which database client the harness runtime uses**
(management API vs service-role client vs direct Postgres). Its unratified
status blocks *granting data-plane access*.

This module grants nothing and touches no database:

* the default decision is **deny**; adding the engine to a call path can only
  ever *stop* executions that would otherwise have happened;
* **`mode: 'LIVE'` is refused outright**, so the control plane is TEST-only by
  construction and no live credential or live side effect is reachable through
  it. The switch (`allow_live`) exists as a named, greppable flag; the suite
  asserts no shipped composition sets it;
* the kernel's own promise is intact — `tools.mjs` still holds no authorization
  field, and a descriptor is still a description. The *decision* lives one layer
  up, exactly where those headers said a future dispatcher would put it.

**Still absent:** no identity provider, no session, no role assignment, no
credential. The engine is handed a principal's roles as data; it does not
authenticate anyone. Authentication remains the surface's job (RLS + the web
session for the B5 queue).

## Security controls

| Control | Where | Proven by |
|---|---|---|
| deny by default | `policy.mjs` | perturbation: removing the grant check fails the suite |
| LIVE refused | `policy.mjs` | perturbation |
| automation never approves (G4) | `policy.mjs` | perturbation |
| approval before consequential effect | `dispatch.mjs` | perturbation; `calls === 0` after refusal |
| tenant binding on every run operation | `control-plane-service.mjs` | perturbation |
| cross-tenant context refused, not filtered | kernel `assembly.mjs` | Runner P + Runner C |
| ownership refusal discloses nothing | `control-plane-service.mjs` | assertion that the message omits the owning tenant |
| adapter errors redacted and bounded | `dispatch.mjs` | kernel redaction + 300-char cap |
| no send path in the reference adapters | source lint | `fetch`, sockets, SMTP, Graph, Supabase, n8n, credentials, fs all forbidden |
| every fixture address unresolvable | source lint | all `@` domains must be `@example.invalid` |
| append-only history | `journal.mjs` | four integrity checks, each individually load-bearing |

## Known limitations

1. **Nothing is durable beyond the local filesystem.** The journal and result
   stores are memory or file; the successors are ADR-0002.
2. **Steps are sequential.** No fan-out, no conditional branching, no loops. The
   manifest's `steps` is a list, not a graph.
3. **Quorum is declared but not enforced.** `approval_policy.quorum` is validated
   and carried into the approval request, but the engine proceeds on the first
   valid approval. A quorum above 1 is currently a statement, not a gate.
4. **No lease or claim.** ADR-0003's `claimed_by` / `lease_expires_at` design is
   not wired in, so two processes resuming the same run concurrently would both
   proceed. Single-operator use only.
5. **The reference ledger is process-local.** A `resume` in a fresh process gets
   an empty ledger; what survives is the journal and the result store. Real.
6. **`compensation_failed`, `journal_corrupted` and `manifest_invalid`** have no
   end-to-end fixture path (they are reachable only structurally); the suite
   names them explicitly rather than hiding them behind a coverage gate.
7. **No HTTP surface.** The service is transport-neutral by design; the operator
   surface is a CLI.

## Commands

```bash
# the control-plane suite alone
bash scripts/eval-control-plane.sh

# every credential-free suite
bash scripts/regression.sh --kinds=unit,offline,static

# everything that does not need a live database
bash scripts/regression.sh --exclude-kinds=db
```

## Demonstration

```bash
# the whole slice in one process
node scripts/awe-control-plane.mjs demo

# the same slice across THREE separate processes (durability, genuinely)
node scripts/awe-control-plane.mjs start
node scripts/awe-control-plane.mjs approve --run <RUN_ID> --by jack --role owner
node scripts/awe-control-plane.mjs resume  --run <RUN_ID>

# discovery, and inspection of any stored run
node scripts/awe-control-plane.mjs workflows
node scripts/awe-control-plane.mjs show --run <RUN_ID>
```

Output includes the run id, workflow and version, manifest digest, current
state, pending approval, executed tools with their side-effect class and
idempotency key, the full hash-chained event timeline, and a final verdict.
