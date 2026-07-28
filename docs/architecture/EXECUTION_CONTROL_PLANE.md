# AWE Execution Control Plane

**Status:** implemented and verified offline (Runner P, 491 gates, 0 failures;
Runner M, 462 gates, 0 failures).
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
| Who is allowed to be writing this run right now? | `lease.mjs` |

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

Eighteen event types, each with an explicit `{ from: [...], to }` transition.
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

### 7. Three stores, three jobs

| Store | Holds | Successor |
|---|---|---|
| journal store | the append-only CONTROL record. **Digests only.** | append-only control table (ADR-0002) |
| result store | the tenant-bound DATA record. **Bodies.** | RLS-protected tenant table (ADR-0002) |
| lease store | who is writing this run right now, and until when. | a row with `SELECT ... FOR UPDATE` or a conditional update (ADR-0002) |

Step outputs are *not* in the journal, and the suite asserts it: the serialized
journal for the reference run contains neither `INV-2291` nor `Northgate`, only
`result_digest` values. `report.mjs` and `journal.mjs` both record workflow data
as a digest because a control-plane record is read by people and shipped to logs,
while an invoice's supplier and account number belong in tables already under
RLS. Splitting the stores lets each successor be chosen independently.

The journal and result stores are tenant-checked independently of the service.
The lease store is not: the service resolves ownership before it ever reaches a
lease, so a tenant mismatch there is a wiring bug and is raised as one rather
than returned as a refusal that would hide it.

### 8. One run, one writer — the lease, the fence and the compare-and-set

Append-only does not imply single-writer, and until this was built it did not
provide it either: two workers resuming the same paused run each loaded the same
journal, each executed the consequential step, and each wrote a continuation
that was internally valid. One approval, two payments, two histories that both
verify.

Three mechanisms, layered because each alone has a hole:

| Mechanism | Where | The hole it closes | The hole it leaves |
|---|---|---|---|
| **lease** | `lease.mjs` + `lease-store.mjs` | two workers starting on one run | a lease can expire while its holder is still alive |
| **fence** | monotonic integer on the lease | a suspended worker waking up and committing over its successor | needs somewhere to be checked |
| **compare-and-set** | `journals.write(doc, { expected_head })` | a commit against a history that has moved on | narrow read-compare-rename window in the FILE store |

Rules worth knowing, each with its own regression case:

* a lease is **expired at its deadline**, not after it, so two holders never
  overlap on the boundary instant;
* **renewal keeps the fence; takeover always bumps it** — including takeover by
  the original holder, which cannot know what happened while it was lapsed;
* the **expiry sweep reports and does not delete**. Deleting an expired record
  looks like the obvious cleanup and resets the fence to 1, re-validating
  exactly the zombie the fence exists to catch. This was a real bug, found by
  perturbation, and a test now pins it;
* a service given a **real lease store but no `holder`** is refused at
  construction: two processes sharing a holder name would both renew the same
  lease and both proceed.

Every mutating operation — `startRun`, `decideApproval`, `resumeRun`,
`cancelRun` — claims the run before doing any work and commits under both the
hold check and the head check. The claim is taken *before* the work because
neither check can undo a side effect that has already landed; they are the
backstop that stops a lapsed worker corrupting the history on its way out.

**Idempotent submit** falls out of the same machinery. A duplicate submission is
detected immediately after the claim, before any step runs, and returns the
existing run with `duplicate_submission: true`. Detecting it at the commit
instead — which is what the compare-and-set alone did — meant every step ran a
second time and only *then* was refused.

### 9. Approval quorum — a gate several people open

`approval_policy.quorum` used to be validated, carried into the approval
request, and then ignored: the engine resumed on the first valid approval.

Votes and the gate are now separate events:

* **`approval.recorded`** — one principal's vote. It moves nothing (`to: null`).
  A state that flipped to `approved` on the first vote could not express "one of
  the two required approvals has been received"; the run would already be
  resumable.
* **`approval.granted`** — the gate, appended only once a quorum of **distinct**
  principals has approved. Its presence in a journal *is* the proof that enough
  people said yes; a reader does not have to count votes.
* **`approval.denied`** — one rejection closes the gate whatever has
  accumulated. A quorum is a floor on agreement, not a majority vote.

One person may not satisfy a quorum of two: a second submission from the same
principal is refused with `approval_duplicate_principal` rather than
deduplicated silently, because it is either a retry (harmless to refuse) or an
attempt to self-satisfy the gate (must be refused, and must be visible).

The manifest rule changed with it. It previously required one named approver
role per unit of quorum, which conflated roles with people and made "two owners
must both sign off" — the ordinary case — unexpressible, while permitting
`quorum: 1` with no role at all. A quorum counts people; what the rule must
prevent is an *unattributable* multi-party gate, so `quorum > 1` now requires at
least one approver role and nothing more.

### 10. Surfaces

Two, both calling the same transport-neutral service:

| Surface | What it is | Notes |
|---|---|---|
| `scripts/awe-control-plane.mjs` | the operator CLI | five subcommands, each a separate process; composes the FILE lease store with a per-process holder |
| `packages/mcp-server` | six MCP tools | `list_workflows`, `start_workflow_run`, `get_run`, `list_pending_approvals`, `resume_run`, `decide_approval` |

The MCP tools reuse the existing surface rather than paralleling it — the same
`resolveExecution` tenant gate, descriptors, run scaffolding, audit sinks and
response mapping. `runtime.mjs` grew a `needs` discriminator
(`'data_port' | 'control_plane'`) instead of a second execute function, because
a parallel runtime is how one copy of the tenant rule ends up subtly different
from the other.

**An agent can never approve.** `decide_approval` exists on the MCP surface and
refuses, unconditionally. Doctrine G4 is "automation approves nothing"; an MCP
call is made by a model, and the server can see no person behind it —
`resolveExecution` establishes which *tenant* a call is for and nothing about
*who* made it. A tool that accepted `actor: 'human'` as an argument would be an
argument through which an agent asserts its own humanity, and an operator flag
would only make the loophole configurable. The tool therefore submits with this
surface's real actor (`'service'`) and returns the engine's own refusal, so if
G4 were ever relaxed upstream the tool would relax with it and one test catches
that — which a hard-coded refusal could not.

`list_pending_approvals` exposes the half an agent can legitimately do: tell a
person exactly what is waiting and why. `resume_run` **is** exposed, because
resuming is not approving — it executes what a human already authorized, and if
none has, the engine refuses it with `approval_required`.

*The future path*, so this is a decision and not an omission: the human surface
mints a single-use, tenant-bound approval **token**, and a relay presents it
here for verification. That is delegated authority a server can actually check.
It needs a signing key and a token store, which means it needs the identity
decisions this repo has deliberately not made.

G4 is also now evaluated **before the run is looked up**. It previously ran
after `loadOwned`, so a service actor submitting a guessed run id was told
`approval_unknown` rather than `approval_actor_invalid` — an existence oracle
over run ids, and a doctrine rule supposed to be unconditional made conditional
on a lookup succeeding.

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
| one run, one writer | `lease.mjs` + journal CAS | perturbation on each of claim, hold, fence, expiry and head check |
| a quorum counts distinct people | `policy.mjs` + `engine.mjs` | perturbation: one person voting twice, and a partial quorum that must not resume |
| an agent may never approve | `control-plane-tools.mjs` | behavioural refusal + a source lint forbidding a caller-supplied actor |
| discovery discloses no other tenant | `control-plane-service.mjs` | perturbation on both the filter and the `tenant_scope` redaction |
| a duplicate submission executes once | `control-plane-service.mjs` | the ledger still holds exactly one payment instruction after a resubmit |

## Known limitations

1. **Nothing is durable beyond the local filesystem.** The journal, result and
   lease stores are memory or file; the successors are ADR-0002. The file lease
   store's *first* acquisition is genuinely atomic (`open(..., 'wx')`); taking
   over an EXPIRED lease is read-decide-rename and is not. What closes that gap
   is the layer above — the monotonic fence and the journal's compare-and-set —
   and the file that implements it says so rather than implying otherwise.
2. **Steps are sequential.** No fan-out, no conditional branching, no loops. The
   manifest's `steps` is a list, not a graph. This is now the single largest
   reusable gap: every future workflow that needs "if the invoice is under the
   threshold, skip the approval step" has to express it as a separate workflow.
3. **The reference ledger is process-local.** A `resume` in a fresh process gets
   an empty ledger; what survives is the journal and the result store. Real.
4. **`compensation_failed`, `journal_corrupted` and `manifest_invalid`** have no
   end-to-end fixture path (they are reachable only structurally); the suite
   names them explicitly rather than hiding them behind a coverage gate.
5. **No HTTP surface.** The service is transport-neutral by design. There are
   now two surfaces on it — the operator CLI and the MCP server — and neither is
   a web endpoint.
6. **Idempotent submit is instant-scoped, not a caller-supplied key.** A run id
   is derived from workflow + inputs + start instant, so an identical
   resubmission is recognised only when it lands at the same instant. That is
   the two-workers-one-queue-message case; a genuine caller-supplied
   idempotency key would also cover "the same invoice submitted twice an hour
   apart", and does not exist yet.
7. **Approvals cannot be made from the MCP surface, by design.** See below.

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

# somewhere other than the repo, and a reproducible (pinned-instant) demo
AWE_ARTIFACT_ROOT=/tmp/awe node scripts/awe-control-plane.mjs demo
node scripts/awe-control-plane.mjs demo --start 2026-07-28T09:00:00.000Z
```

The MCP surface, over the real stdio transport:

```bash
# lists 16 tools, starts a governed run, and shows it refuse to approve
bash scripts/smoke-mcp.sh
```

Output includes the run id, workflow and version, manifest digest, current
state, pending approval, executed tools with their side-effect class and
idempotency key, the full hash-chained event timeline, and a final verdict.
