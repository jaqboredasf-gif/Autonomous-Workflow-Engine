# Session Handoff

Read CONTEXT.md first, then this, then all docs/planning/*.md. One approved task per session.
Vocabulary authority: docs/architecture/UBIQUITOUS_LANGUAGE.md (2026-07-17; harness
terms appended 2026-07-27 marked PROPOSED; governed-agent terms appended
2026-07-28 and IMPLEMENTED).

## Current state (2026-07-28, G1 — the Governed Agent Execution Plane, UNCOMMITTED on `feat/kernelized-mcp-context`)

Code-only session on top of D1's uncommitted tree. **No live database call, no
migration, no credential read, no network request, no model call, no push, no
PR, no commit.** Nothing from D1 was discarded, reverted or rewritten.

### The decision this session exists to implement
**ADR-0011 — an agent proposes an action; the governed runtime authorizes and
executes it.** Everything AWE could execute safely before now was declared in
advance. An agent's next action is chosen at runtime, increasingly by a model, so
the authorization decision has to move to the moment of action and out of the
model's reach.

### Shipped
- **`packages/awe-agent`** — a new pure package, eleven modules, importing the
  kernel and the control plane through one seam. No network, no filesystem, no
  clock, no randomness, no ambient env, no model client and **no vendor name**,
  all asserted by a purity lint.
- **The capability model**: a business permission with its own versions, tool
  bindings, ceilings, risk, approval threshold, tenant and actor restrictions,
  data classification, idempotency and audit obligations. **Tool access never
  implies business authorization.**
- **The Agent Definition and its registry**: versioned, digest-pinned,
  immutable, with an accountable activation and a `disabled` state no argument
  can override. New behaviour requires a new version; there is no mutate path.
- **The Execution Surface**: a definition COMPILES to a real workflow manifest,
  so `policy.mjs`, `dispatch.mjs` and the manifest rules are reused rather than
  reimplemented. A tool no capability binds refuses compilation.
- **The Action Proposal grammar**: unknown keys, unversioned dependencies and
  arguments beginning with `_` refused by the constructor; the planner's
  self-report recorded as belief and never as authority.
- **Five independent narrowings in one function**, producing an immutable,
  digest-pinned **Policy Decision Record** naming every version it was decided
  against.
- **Approval bound to the exact action** — tenant, agent version, resolved
  capability and tool versions, operation and arguments — and expiring. A resume
  re-authorizes from scratch and fails closed on definition OR surface drift.
- **Seven `agent.*` event types added to the existing journal**, all `to: null`,
  and the **agent phase as a second projection** over the same entries. No second
  journal, no stored phase.
- **Four budgets**, each with its own reason, projected from the run's own
  history. An unbounded agent cannot be configured. A refusal is never retried.
- **The evaluation and promotion boundary**: measurement activates nothing;
  a candidate needs evidence, a human review and a human promotion; promotion
  yields a DRAFT that still cannot execute.
- **`createGovernedAgentService`** — the third service, inheriting leases,
  compare-and-set, idempotent submit and two-stores-two-jobs, adding *actor
  identity is also an argument*, with `replayAgentRun` (cannot act) and
  `simulateProposal` (no path to the dispatcher).
- **The vertical slice**: a synthetic invoice operations agent whose intake
  fixture carries a REAL, unfiltered prompt-injection payload.

### Evidence (offline, this tree)
`regression.sh --kinds=unit,offline,static`: **ALL GREEN, 12 ran, 11 skipped** —
3611 assertions, 0 failures. Runner G **379/0** over 51 fixtures, byte-identical
across two consecutive runs. Runner P **570/0** (was 568). All 35 adversarial
cases from the brief are covered and named in their assertion messages.

### Five defects found while building it, each real
1. identity checked after context assembly, so a tenant-less run was refused as
   `context_requirements_unmet`;
2. the approval binding read from the projection, which knows nothing about
   proposals, so a resume could not recover what a human approved;
3. a resume re-checking evidence against a bundle it no longer had;
4. the resume segment starting at the `workflow.resumed` marker, so time spent
   waiting for an operator expired the run's budget;
5. tool input carrying the whole observation history, which made an explicit
   idempotency key meaningless.

### The single largest unproven surface
**No model has ever driven this plane.** The model boundary is exercised with an
injected port returning a fixed string, which proves the CONTRACT and nothing
about how a real model behaves inside the view. The plane is built so that this
is a risk to usefulness, not to safety.

## Scope lock (2026-07-28, G1 — the Governed Agent Execution Plane)


Written **before** any implementation, as the session's own contract, and kept
unedited so the plan and the outcome can be compared.

### The tree this starts from
Branch `feat/kernelized-mcp-context` at `7a1c0fb`, with the **uncommitted D1
work present** (migration 0017, `packages/awe-runtime/src/postgres/`,
`store-selection.mjs`, Runner D, ADR-0010, four modified planning docs). Nothing
from D1 is discarded, reverted or rewritten; this session builds strictly on top
of it and the D1 files are treated as intentional.

### What already exists (do not rebuild)
- **A validated, versioned, digest-pinned manifest** with a closed key set,
  tenant scope, tool requirements with version ranges, context requirements,
  approval policy, limits, risk, promotion and steps —
  `awe-control-plane/src/manifest.mjs`. The Agent Definition must be its sibling,
  not its replacement.
- **A registry that is the only source of something executable** —
  `workflow-registry.mjs`: resolve by id + version requirement + tenant, refuse
  with a registered reason, no parameter anywhere accepting a definition.
- **A deny-by-default policy engine over tenant grants** — `policy.mjs`: LIVE
  refused outright, tenant binding required, three-way side-effect ceiling
  intersection, approval threshold as the MINIMUM of manifest and grant, and G4
  (`actor: 'service'` may never approve) checked first.
- **The controlled tool-invocation boundary** — `dispatch.mjs`: nine refusals
  before an adapter is called, effect-identity idempotency with cross-process
  rehydration, injected clock, adapter throw contained as a failed step.
- **An append-only, hash-chained run journal whose state is PROJECTED** —
  `journal.mjs`: an explicit transition table, no stored state anywhere.
- **A durable execution repository behind three ports** with `memory`,
  `local_file` and `postgres` implementations and a shared conformance suite
  (D1), plus run leases with fencing and a compare-and-set on the chain head.
- **Context primitives**: tenant-bound items with declared trust and
  sensitivity, deterministic assembly with complete exclusion accounting,
  compaction that can never launder trust or sensitivity.
- **A synthetic reference vertical slice** — `reference/invoice-intake.mjs`:
  six tools, a ledger that is a `Map`, `@example.invalid` addresses, failure
  injection on the adapter.

### The exact gap this session closes
Everything above executes a **statically declared** step list. Nothing in the
repository can safely execute an action that was **proposed at runtime** — by a
model or by anything else — because there is no contract for a proposed action,
no capability layer between an agent and a tool, no agent definition to bind an
actor to a bounded action space, no approval that binds to the *arguments* of a
specific proposal, and no evaluation record with a promotion boundary. That is
the Governed Agent Execution Plane, and it is what this session builds.

The load-bearing decision, recorded as ADR-0011: **an agent proposes; the
governed runtime authorizes and executes.** A model never reaches a tool.

### Files expected to change
- new package `packages/awe-agent/` — `capability.mjs`, `agent-definition.mjs`,
  `agent-registry.mjs`, `surface.mjs`, `proposal.mjs`, `authorization.mjs`,
  `planner.mjs`, `budget.mjs`, `harness.mjs`, `evaluation.mjs`, `kernel.mjs`
  (the single import seam), `index.mjs`
- new `packages/awe-runtime/src/agent-service.mjs`
- new `packages/awe-runtime/src/reference/invoice-operations-agent.mjs`
- new `scripts/eval-governed-agent.{mjs,sh}`, registered in
  `packages/awe-kernel/src/registry.mjs` as Runner G
- new `docs/architecture/GOVERNED_AGENT_EXECUTION_PLANE.md`,
  `docs/architecture/decisions/0011-agents-propose-runtime-authorizes.md`
- edited `packages/awe-control-plane/src/journal.mjs` (agent event types added to
  the transition table — additive only, no existing transition changed)
- edited `packages/awe-control-plane/src/index.mjs`,
  `packages/awe-runtime/src/index.mjs` (exports)
- edited `scripts/lib/awe-reasons.mjs` (an `agent` reason namespace)
- edited `docs/architecture/UBIQUITOUS_LANGUAGE.md`,
  `docs/architecture/decisions/README.md`, and the planning docs

### Invariants that must survive
- **State is projected, never stored.** The agent phase is a SECOND projection
  over the same journal entries, not a column and not a field.
- **One journal, one writer, append-only.** The agent harness appends through
  the same journal object under the same lease and the same compare-and-set.
- **Deny by default at every layer**, and no layer may widen another: a tool
  needs the agent to declare the capability, the capability to bind the tool,
  the tenant grant to exist, the policy to allow, and the approval to be in
  force and bound to *these* arguments.
- **The model decides nothing.** It receives a redacted planning view, returns a
  proposal, and the runtime re-derives every authorization fact itself.
- **Untrusted content stays untrusted.** Text inside a document is data; it
  cannot grant a capability, and a tool result is an observation, not an
  instruction.
- The kernel and the control plane stay free of drivers, clocks, network and
  ambient environment; the agent package sits above the control plane and below
  the runtime and imports through one seam.
- No live credential, no live database, no network, no send path, no n8n.

### Explicit non-goals
- No model provider client of any kind. The provider boundary is a PORT with a
  deterministic implementation; no vendor SDK, no key, no HTTP call.
- No new database migration. The agent plane persists through the D1 stores that
  already exist; an `agent_*` schema is a separate, later decision.
- No prompt-injection string filter. Injection is defeated architecturally (the
  model cannot reach a tool) and the tests assert the boundary, not a blocklist.
- No agent-authored memory writes. `memory.propose_write` is a proposal that
  produces a candidate, never a write.
- No self-modification path: promotion produces a DRAFT definition and requires a
  named human, and nothing in the harness can call it.
- No fan-out, no scheduling, no work-queue scanning, no compensation for agent
  runs (the reference agent's tools are internal-write and reversible by policy,
  and a compensating agent is a later slice).
- No commit, no push, no PR.

### Conflicts and overlaps discovered
1. `docs/architecture/AGENT_HARNESS_*.md` (H0/H1, 2026-07-27) describe an
   `agent_sessions` / `agent_steps` / `agent_session_types` **table-first**
   harness whose ADR-0001 is not Accepted, and whose vocabulary is marked
   PROPOSED in UBIQUITOUS_LANGUAGE. This session implements the same doctrine
   (G4 "automation approves nothing", the effect ladder, untrusted context)
   **in code, above the control plane, with no new tables** — so the H0 design
   is neither contradicted nor implemented. Recorded in the new architecture doc
   rather than by editing the H0 documents, which are a historical record.
2. `dispatch.mjs` needs a *manifest* to evaluate policy against. Rather than
   introduce a second authorization implementation for agents, an agent
   definition **compiles** to a real, validated workflow manifest — its
   Execution Surface — whose steps are the enumerated (capability, tool)
   bindings. The agent's action space is finite and declared, so this is a
   faithful projection and not a fabricated graph.
3. `journal.mjs`'s transition table is a closed vocabulary. Agent events are
   ADDED to it rather than given a second journal, because two hash-chained
   histories for one run is exactly the disagreement the projection rule exists
   to prevent.

## Current state (2026-07-28, D1 — the durable execution repository, UNCOMMITTED on `feat/kernelized-mcp-context`)

Code-and-migration session. **No live database call, no migration applied, no
credential read, no network request, no push, no PR, no commit.** Every database
interaction was against a throwaway `postgres:17` container created and destroyed
by the test runner.

### Shipped
- **Migration 0017** — `awe_run_journals`, `awe_run_journal_entries`,
  `awe_run_leases`, `awe_run_results`; eleven `SECURITY DEFINER` functions with
  `search_path = ''`; RLS on with **zero** client policies; append-only enforced
  by trigger *against a superuser*. Written, validated against a real PostgreSQL
  17 on top of the real 0001–0016 history, **not applied**.
- **A Postgres adapter one method wide** (`call(fn, payload)`), so
  `@exattime/awe-runtime` still depends on no database driver and holds no
  credential.
- **ADR-0002's Path C demonstrated**: a role holding only `EXECUTE` on the eleven
  functions — no table privilege at all — passes the entire store contract.
- **A reusable conformance suite** answered identically by `memory`, `local_file`
  and `postgres`, which found **two defects in the existing stores**: the result
  stores' unchecked cross-tenant WRITE, and a journal write that would accept a
  rewritten prefix at the current head.
- **Real concurrency found a third**: `awe_journal_write`'s create path was not
  serialized, because `SELECT … FOR UPDATE` locks nothing when the row does not
  exist. Eight parallel creators all passed the compare-and-set.
- **The store port is now `T | Promise<T>`** (ADR-0010 D6). Seven service reads
  became async; eleven call sites gained `await`. The port change immediately
  exposed a fourth defect — an unawaited `claim()` in `cancelRun`.
- **`selectStores`**: one place a backend is chosen, default `memory`, and asking
  for `postgres` without an executor throws rather than downgrading.
- **A vertical slice across four services that share no memory**, connected only
  by Postgres, with replay reproducing the timeline exactly.
- **`scripts/rollback-migration-0017.sql`**, verified by round trip.

### Evidence (offline, this tree)
`regression.sh --kinds=unit,offline,static`: **ALL GREEN, 11 ran, 11 skipped** —
3225 assertions, 0 failures. Runner D **321/0** with Docker, **169/0** without
(gates reported as SKIP, loudly). Runner P **568/0** (was 564). Two consecutive
Runner D runs are byte-identical.

### The single largest untested surface
`createSupabaseRpcExecutor` — the PostgREST binding — is covered by no test,
because testing it needs a live project. The `psql` transport proves the SQL and
the adapter; it does not prove that binding. See AGENT_HANDOFF `## risks` item 2.

## Scope lock (2026-07-28, D1 — durable execution repository)

Written **before** any implementation, as the session's own contract. Kept here
unedited so the plan and the outcome can be compared.

### Correction to the brief
The session brief described the tree as branch `chore/agent-handoff-integration`
with four modified planning docs. The actual tree is branch
`feat/kernelized-mcp-context` at `7a1c0fb`, **working tree clean**. Nothing was
discarded to reach that state; the brief was simply describing an older tree.
All work below starts from `7a1c0fb`.

### What already exists (do not rebuild)
- **The port is already there, three times over.** `packages/awe-runtime/src/`
  holds `journal-store.mjs` (`read`/`write(document,{expected_head})`/`list`),
  `lease-store.mjs` (`read`/`acquire`/`verify`/`release`/`expire`/`list`) and
  `result-store.mjs` (`read`/`write`/`list`), each with a `memory` and a
  `local_file` implementation. Every one of their headers already names a table
  as the successor and cites ADR-0002.
- **The rules are already pure and already elsewhere.** State transitions,
  the hash chain and the projection live in `awe-control-plane/src/journal.mjs`;
  claim/renew/steal/expire/fence live in `awe-control-plane/src/lease.mjs`.
  Neither reads a clock or touches I/O. A database adapter must not restate
  those rules — it supplies **atomicity**, not policy.
- Idempotent submit, run leases with fencing, journal head compare-and-set,
  approval quorum, conditional steps, compensation, cancellation and timeout are
  all implemented and covered by Runner P (`scripts/eval-control-plane.sh`).
- Migrations run `0001`–`0016`. `0016` is promoted but **unapplied**.

### What is missing
1. No durable store crosses a process boundary with real atomicity. The file
   journal store's compare-and-set is read-compare-rename and its own header
   says so; taking over an expired file lease is likewise not atomic.
2. No schema exists for runs, journal entries, leases or results.
3. There is no **conformance suite**: each store implementation is tested only
   incidentally, through the service, so a new implementation has no shared
   behavioural contract to be held to.
4. The store ports are synchronous, which no real database client can be.

### Files expected to change
- new `supabase/migrations/0017_awe_durable_execution.sql`
- new `packages/awe-runtime/src/postgres/{executor,journal-store,lease-store,result-store}.mjs`
- new `scripts/lib/store-conformance.mjs`, `scripts/lib/pg-harness.mjs`
- new `scripts/eval-durable-store.{mjs,sh}`, registered in
  `packages/awe-kernel/src/registry.mjs`
- new `docs/architecture/decisions/0010-durable-execution-repository.md`
- edited `packages/awe-runtime/src/{index,control-plane-service}.mjs` (await the
  stores), `packages/mcp-server/src/control-plane-tools.mjs` and
  `scripts/awe-control-plane.mjs` (await the now-async reads)
- edited `docs/architecture/EXECUTION_CONTROL_PLANE.md` and the planning docs

### Invariants that must survive
- **State is projected, never stored.** No `state` column anywhere. A durable
  row that carried a state could disagree with its own history.
- **Two stores, two jobs.** Journal holds digests; step outputs live in the
  result store. The schema must not let a workflow's data into the journal.
- Tenant binding is an argument, never an inference; a refusal must not reveal
  another tenant's ownership.
- The fence never goes backwards; an expired lease record is never deleted.
- Terminal runs accept no further events; a journal is append-only.
- The control plane and kernel stay free of drivers, clocks and ambient env.

### Explicit non-goals
- No live Supabase call, no migration apply, no push, no PR, no commit.
- No work-queue scanning (`claim the next runnable run`). Nothing in the runtime
  pulls work that way today; a `state` column to index would break the
  projection invariant. Deliberately deferred.
- No heartbeat/lease-renew API beyond the existing `acquire`-renews semantics.
- No FK from the execution tables to `orgs`: the control plane's tenant id is an
  opaque string (`org_synthetic_alpha`), not `orgs.id uuid`. Mapping the two is
  a separate concern and is not invented here.
- No change to the ExatTime domain tables, and no new client RLS policy.

## Current state (2026-07-27, K4/C1 — kernelized MCP + context primitives, COMMITTED on `feat/kernelized-mcp-context`)

Code-only session. **No database call, no migration, no credential, no network,
no push.** Nine local commits on a new branch; nothing else was touched.

### The branch question the previous session flagged, answered
`chore/agent-handoff-integration` is **not** superseded by
`chore/agent-handoff-clean`. The two carry equivalent handoff docs, but the
integration branch uniquely carries the C1/S1 security work (SECURITY_FINDINGS,
`acceptance-s1-security.sh`, the S1 rehearsal/rollback SQL, migration 0016),
none of which reached `clean` or `main`. Acting on "superseded" would have
discarded it. The previous session's uncommitted tree is now preserved in five
reviewable commits.

### Shipped
- **MCP on the kernel.** All ten tools run through `runWorkflow`: explicit
  execution context, standardized outcome envelope, sanitized audit events,
  durable run report, explicit final state. `packages/mcp-server/src/index.js`
  is wiring only — 409 offline assertions cover the rest without a credential.
- **The `orgs limit 1` tenant defect is gone.** A tenant is stated (`org_id`
  argument or `AWE_ORG_ID`), never discovered. Refused before any data access
  when absent; refused when the call and the process disagree. Reads were also
  previously unscoped against a service role that bypasses RLS — every read now
  filters `org_id`, every write sets it, and the written row's tenant is
  asserted afterwards.
- **Context primitives** (`context-item.mjs`, `assembly.mjs`): tenant binding,
  declared trust, sensitivity, provenance, priority, deterministic token
  estimate; deterministic assembly with **complete exclusion accounting** —
  nothing is dropped without a recorded reason.
- **Deterministic compaction** (`compaction.mjs`): six model-independent
  mechanisms, a full ledger, no declassification, no trust promotion, no growth,
  byte-identical reproducibility. A `summarizer` hook admits a model-assisted
  compactor later without making one mandatory.
- **Context checkpoints**: `awe.context_checkpoint/v1`, tenant- and
  workflow-bound, refusing a cross-tenant restore.
- **Neutral Tool Registry boundary** (`tools.mjs`): descriptor, catalog,
  side-effect classification, lifecycle. No authorization field exists, and
  Runner M asserts their absence.
- **`@exattime/awe-runtime`**: the app-server-ready service layer — submit,
  inspect, artifact, audit, assemble, compact, checkpoint, resume. No HTTP.

### Evidence (offline, this tree)
`regression.sh --exclude-kinds=db`: **ALL GREEN, 12 ran, 8 skipped.**
Runner K **553/0**, Runner C **138/0** (new), Runner M **410/0** (new), Runner 3
**121/0**, Runner 4 **327/0**, Runner 5 **349/0**, Runner E **376/0**, web build
OK, mobile typecheck OK.

**`mcp-smoke` now passes — `OK (10 tools)`, credential-free.** It was the one
failing suite in the previous session's tree. It is fixed by making the server
startable in TEST mode rather than by relabelling the suite.

Seven non-vacuity perturbations each fired and were reverted. One of them
(cross-tenant checkpoint restore) initially passed with the guard deleted,
because the assembler's own per-item check masked it; the test was strengthened
to pin the specific guard.

### Two real defects found by the new tests, not by review
1. An MCP failure message could carry a provider's raw error — connection
   string, bearer token, `password=` value — into the tool response. Now
   redacted and bounded, and the kernel's redaction was extended to scrub
   assigned secrets inside free text.
2. A fixture row id built by interpolating the caller's text carried a customer
   name into audit events and gate decisions. Ids are now content-addressed.

### Deliberately NOT done
Capability model, tool permissions, tenant authorization policy, approval
thresholds, production enablement (**ADR-0002, unratified** — no assumption was
made, and the absence is asserted mechanically). Non-filesystem artifact
persistence. Any live-path proof of the Supabase data port. Any frontend.

### Highest-leverage next task
**Prove the LIVE data port.** Runner M proves the tenant, outcome, audit,
artifact and context behaviour offline against the fixture port; nothing yet
proves the Supabase implementation. A credential-gated `db`-kind suite that runs
each read tool against a live project bound to one tenant, asserts every
returned row carries that `org_id`, and includes one cross-tenant negative case,
is the last gap between "tenant safety is code-enforced and tested" and "tenant
safety is code-enforced and tested against the code that actually runs".

## Current state (2026-07-27, K2 — execution-kernel adoption + durable run artifacts, CODE COMPLETE, uncommitted)

Code-only session on `chore/agent-handoff-integration`. **No database call, no
migration, no credential, no network, no commit, no push.** Everything below is
offline and in the working tree.

The reusable execution foundation is now real code, not a design. A workflow can
be handed a request and will: build an execution context, pass its own
fail-closed gates, execute deterministic logic, return a standardized outcome
envelope, emit sanitized audit events, persist a durable run report, and
terminate with an explicit final state — through one call (`runWorkflow`) that
cannot leak an exception.

### Shipped
- **Runner 5 on the kernel.** ~51 lines of duplicated harness machinery deleted
  (counters, `ok`/`bad`/`check`, manual corpus loading, three hand-rolled
  `JSON.stringify` determinism comparisons, the coverage loop, a local `sameSet`,
  a regex `stripComments`, the purity loop, the summary/exit block). Assertions
  **325 → 349**; strictly stronger — canonical-byte determinism instead of
  `JSON.stringify`, orphan-label detection it did not have, the kernel's
  state-scanner comment stripper, and cross-engine reason-union checks.
- **Standardized outcomes for `prepareOutbound` and `classify`**
  (`scripts/lib/awe-execution.mjs`). Success / refusal / blocked routing /
  validation failure / internal error all return an outcome envelope with a
  machine-readable code. Both engines keep their existing signatures: Runner 4 and
  Runner 2A are untouched.
- **Durable run-report artifacts.** Stable schema `awe.run_report/v1`
  (`packages/awe-kernel/src/report.mjs`), atomic deterministic local writer
  (`scripts/lib/artifact-store.mjs`), path `<workflow>/<date>/<run_id>.json` under
  a gitignored `artifacts/`. Wired into Runners 4, 5 and E.
- **Extension boundaries** (`context.mjs`, `sinks.mjs`, `execute.mjs`): execution
  context, run-metadata contract, ArtifactSink, AuditSink, ContextProvider. All
  authorization-free by construction — see DECISION_LOG.
- **Runner E** (`scripts/eval-execution.{sh,mjs}`), offline, in regression.

### Evidence (offline suites, this tree)
Runner K **503/0** (was 344), Runner 3 **121/0**, Runner 4 **327/0**, Runner 5
**349/0** (was 325), Runner E **376/0** (new). `regression.sh --exclude-kinds=db`:
9 of 10 green. Six non-vacuity perturbations each fired and were reverted
(report redaction, artifact path containment, refusal-as-success, classification
fail-closed, reason-registry membership, Runner 5 corpus parity).

Two real defects were found by that discipline rather than by review, both in
`redact()`: credentials embedded in longer strings were not scrubbed, and the key
`pass` (every runner's pass counter) was being redacted out of run reports. Both
fixed and pinned by tests.

### The one failing suite, and why it is not this work
`mcp-smoke` reports `FAIL (tools=0)`. The MCP server refuses to start without
`SUPABASE_URL` **and** `SUPABASE_SERVICE_ROLE_KEY`, and this environment has
neither. Verified by running the server directly:
`SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set`. Its suite descriptor now
declares both, so the plan says "missing env" instead of implying the tool surface
shrank. **It still runs and still fails loudly** — this is a label fix, not a skip.

### Deliberately NOT done
Tool Registry, capability model, tool permissions, tenant policy (all
**ADR-0002**, unratified — no assumption was made). MCP integration. Any
database/object-storage artifact adapter. Runner 2A live regression. Nothing was
committed.

### Highest-leverage next task
**K4 — put the MCP server on the kernel.** It is the only remaining component that
still hand-rolls its own result shapes, it carries the known `orgs limit 1` tenant
defect, and wrapping its tools in `runWorkflow` + an execution context would force
that binding to become explicit while giving every MCP call a standardized
outcome, sanitized audit events and a durable report. It needs
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to smoke-test.

**Before that, ask Jack whether this tree should be committed.** The kernel, the
H0 doc set and this work are all untracked or uncommitted on a branch already
superseded by `chore/agent-handoff-clean`. That hazard is unchanged from the
section below and is now larger.

## Current state (2026-07-27, H0 re-verification — H0 INCOMPLETE, H1 NOT started, nothing written but docs)

A fresh session was asked to verify H0 and, if complete, implement H1 (harness pure
core). **H1 was not started.** Two stop conditions fired.

1. **H0 is INCOMPLETE — criterion 10 (ratification) is still open.** All eight ADRs
   read `Proposed`; `DECISION_LOG.md` has no ratification entry. This cannot be
   self-granted (ADR README: `Proposed` "carries no authority"; doctrine D2:
   automation never approves its own work). H1 entry criteria 1 and 2 therefore fail.
2. **The repository carries unrelated uncommitted work and an active stop condition.**
   `docs/planning/AGENT_HANDOFF.md` in the working tree is a *different* agent's
   read-only Phase 1 deployment review (Codex, 18:30Z), not part of H0. It reports
   that the live database has **no `supabase_migrations` schema** while `0001`–`0015`
   are materially present — repository, migration history, and live state disagree,
   which is `AGENTS.md`'s standing stop condition.

Also newly found: **two competing C1 migrations** for the same 16-policy drop, on two
branches, under two naming conventions, with `main` carrying neither — recorded as
**ADR-0009** (`Proposed`; raises no decision, makes the conflict explicit). It blocks
H2's `0017`/`0018` numbering, not H1.

**Branch hazard:** the entire H0 harness doc set is *untracked* on
`chore/agent-handoff-integration`, a branch already superseded by
`chore/agent-handoff-clean` (merged to `main` as `dbf8f17`). H0's output is on no
branch and in no commit.

Verification that H0's own claims hold against code (all confirmed):
`packages/mcp-server/src/index.js:396` really does use `orgs … limit 1`;
`scripts/lib/db.mjs` really does hard-code `PROJECT_REF`/`ORG_ID`; Runners 1–5 really
are taken; `packages/harness/` does not exist. H0 criteria 1–9 are genuinely done and
the doc set is internally consistent.

Written this session (documentation only — no code, no SQL, no DB call, no commit):
`docs/architecture/decisions/0009-competing-c1-migration-artifacts.md` (new),
`docs/architecture/decisions/README.md` (index row), `AGENT_HARNESS_H0_EXIT.md`
(blockers B-5/B-6 + §8 re-verification), this file.

**Next action is Jack's, and it is not code.** In order: (a) decide whether the H0
doc set should be committed somewhere durable before anything else; (b) review the
8 short ADRs and ratify or amend, with a DECISION_LOG entry; (c) resolve ADR-0009's
C1-artifact choice. Only (b) unblocks H1. The H1 prompt below stays valid verbatim
once ADR-0001 is `Accepted`.

**Scope note for whoever runs H1:** the H1 request that arrived this session was
broader than `AGENT_HARNESS_H1_BRIEF.md` — it additionally asked for the tool
registry core, the execution-request envelope, a structured guardrail-result type,
and trust/provenance labels. All four are specified in `AGENT_HARNESS_CONTRACTS.md`
(§1.3/§1.4, §2.1, §2.4, §4.1), so the wider scope is coherent with H0 — but it is a
deliberate expansion of the brief and should be agreed, and the brief amended, rather
than absorbed silently.

## Current state (2026-07-27 late, Task H0 — Agent Harness doctrine: DOCS COMPLETE, ratification pending)

**Two independent things are open. Do not conflate them.**

1. **S1 / migration 0016 — unchanged, still not applied.** No S1 artefact was
   touched this session. Full status in the S1 section below; it is still accurate.
2. **H0 (Agent Harness doctrine) — documentation complete, awaiting Jack's
   ratification.** Documentation only: no code, no migration, no seed, no workflow,
   no commit, no push, no live change of any kind.

### What the H0 session produced (all new files, all `Proposed`)

```
docs/architecture/AGENT_HARNESS_DECISIONS.md     O1–O5 resolved + 2 design defects (D-A, D-B)
docs/architecture/AGENT_HARNESS_DOCTRINE.md      D1–D20, each with enforcement + 2nd layer + failure + test + G-number
docs/architecture/AGENT_HARNESS_GUARDRAILS.md    G1–G20 enforcement matrix
docs/architecture/AGENT_HARNESS_CONTRACTS.md     registry / dispatcher / verification / context+compaction / session / retry
docs/architecture/AGENT_HARNESS_H0_EXIT.md       exit + entry criteria, dependency map H0–H17, blockers
docs/architecture/AGENT_HARNESS_H1_BRIEF.md      the next session, in full
docs/architecture/decisions/README.md            ADR location + naming convention + index
docs/architecture/decisions/0001-…0008-*.md      8 records, all Proposed
```
Updated: `AGENT_HARNESS_DESIGN.md` (two corrections + H0 amendment header),
`UBIQUITOUS_LANGUAGE.md` (proposed harness terms), `TASK_BACKLOG.md` (H-series),
this file.

### The five open questions and the recommendations (all PROPOSED)

| # | Question | Recommendation | ADR |
|---|---|---|---|
| O1 | Harness DB access path | **Service-role `supabase-js`** with explicit `org_id` binding; harness runtime never imports `scripts/lib/db.mjs` and never holds the `sbp_` management token; direct-Postgres least-privilege is the documented successor behind a narrow `DbClient` | ADR-0002 |
| O2 | Where the loop runs | **Library only** — CLI, web route, MCP, later n8n. No daemon in v1; the lease design permits one later | ADR-0003 |
| O3 | Structured output | **Keep strict JSON-in-text**; native tool-calling deferred behind an adapter capability flag (changing it would invalidate the Runner 2A replay corpus that is the parity gate) | ADR-0004 |
| O4 | Fixture row lifecycle | **Accumulate** with idempotent per-fixture session keys; no reaper (deletion is forbidden); revisit at 100k rows; dedicated fixture org is the named successor | ADR-0005 |
| O5 | Human-gate surface | **Split**: approvals reuse the B5 queue unchanged; operational blocks get a read-only admin list | ADR-0006 |

Plus two defects found in the design doc during inspection and corrected:
**D-A** kill switch is `agent_harness_settings` (default `enabled=false`,
`fixture_mode_only=true`), *not* `org_settings.harness_enabled` — that column does
not exist and `org_settings` is the payroll config table (ADR-0007).
**D-B** the harness eval is **Runner 6** (6A deterministic/in-regression, 6B
live/key-gated) — Runners 1–5 are already allocated (ADR-0008).

### H0 status and the single blocker

**H0 status: INCOMPLETE.** Nine of ten exit criteria are done; the tenth —
**Jack ratifies ADR-0001…0008 and a DECISION_LOG entry records the date** — cannot
be self-granted. Until then every decision above carries zero authority.

**H1 is NOT ready to begin.** It needs ADR-0001 (`Accepted`) only; ADR-0002…0008 may
stay `Proposed` through H1 because H1 touches no database and no provider.

### Exact next prompt (after ratification)

> Execute H1 per `docs/architecture/AGENT_HARNESS_H1_BRIEF.md`. Confirm ADR-0001 is
> Accepted and a DECISION_LOG entry exists; capture a green `scripts/regression.sh`
> baseline first; branch `feat/h1-harness-core`. Build only the pure core
> (`packages/harness`: descriptor validation, digest, token estimator, error
> taxonomy, blocked-reason union, redaction) plus `scripts/eval-harness-unit.sh` and
> `scripts/lib/lint-harness-layering.mjs`, wired into regression. Zero runtime
> dependencies, no DB, no network, no clock, no randomness. Prove the layering lint
> and the descriptor/taxonomy/redact suites non-vacuous by perturbation, then revert.
> Do not touch S1, migrations, or any existing runtime path. Do not commit or push.

If ratification is not yet given, the next action is a **review pass over
`docs/architecture/decisions/`** (8 short records) — not code.

### Recommended sequencing note

Applying S1/0016 **before** apply checkpoint AC-1 (harness migration 0017) is
recommended: 0017 creates more service-role-only tables on a database that still
carries undeclared client policies on `integration_events`. Not a hard dependency —
H1–H3 write no live state — but creating new service-role-only tables next to
unresolved policy drift on the shared events table is avoidable risk.

## S1 state (2026-07-27, unchanged by the H0 session — 0016 promoted, nothing applied)

**S1 is still not applied. The live database is unchanged** (55 policies, 16 on
the four target tables, 24 base tables). Two sessions have now touched it:
2026-07-26 rehearsed the removal, 2026-07-27 re-derived every piece of evidence
from scratch and prepared the apply artefacts. A third execution session confirmed
the exact live 16-policy inventory, ran the full regression baseline ALL GREEN,
re-ran the rehearsal (`[]`), dry-ran migration 0016 under `BEGIN/ROLLBACK` (`[]`),
and promoted it on branch `security/c1-policy-cleanup`. Authority for all of it:
`docs/SECURITY_FINDINGS.md` § S1.

### What the 2026-07-27 session added
- **Independent re-verification** — all 10 checks in SECURITY_FINDINGS § S1
  "Independent re-verification (2026-07-27)" re-run rather than read off the
  07-26 record: 16 policies confirmed live, the repo↔live drift sweep over all
  55 policies found exactly the S1 set and no other drift, the exploit and the
  audit-owner exposure both reproduced inside aborted transactions, the
  rehearsal re-ran clean (`[]`), both non-vacuity perturbations still fail as
  expected, the rollback round-trip restored all 16 byte-identically, and full
  regression was ALL GREEN before and after.
- **`supabase/migrations/0016_drop_undeclared_client_policies.sql`** — the
  promoted migration: the exact 16 drops plus self-guarding post-conditions,
  **no probes, no row writes**. It is committed for review but remains unapplied
  until explicit approval.
- **`scripts/acceptance-s1-security.sh`** — wired into `regression.sh` after
  slice 5. State-aware: green while S1 is PENDING (asserting the exposure is
  exactly as documented), green once APPLIED (asserting worker/audited-user reads
  are 0 and every forge is refused), red on anything else. It closes the three
  gaps the finding had (slice 1 tested only `anon`; slice 5 only *printed* the
  policy count; `time_entry_audits` had no test at all) and needs no edit at
  apply time.

### Apply path — read this before any S1 apply session
The **only** supported production apply path is
`supabase/migrations/0016_drop_undeclared_client_policies.sql`, applied with the
CONTEXT.md management-API recipe only after explicit approval and an immediate
inventory recheck. Its `begin; … rollback;` dry-run passed on 2026-07-27.

**`scripts/s1-policy-cleanup-rehearsal.sql` must never be applied, and changing
its trailing `rollback;` to `commit;` is not an apply procedure.** Beyond the 16
drops it deliberately writes live data to prove the surviving paths still work —
an `S1.DEFINER_PROBE` event, ` s1-probe` appended to the `notes` of every
`approved` time entry plus the audit row that triggers, and probe
delete/insert statements against `integration_events`, `crews` and
`time_entry_audits`. Committing it would put all of that permanently into the
production audit log. Full statement of the path: SECURITY_FINDINGS § S1 "The
only supported apply path".

### Blocker
Explicit live-apply approval. Nothing else is outstanding — evidence, migration,
rollback script and regression pin are all in place.

## Prior state (2026-07-26, Task S1 REHEARSED — nothing applied, waiting on Jack)

**S1 is rehearsed, not executed. The live database is unchanged.** Read
`docs/SECURITY_FINDINGS.md` § S1 first — it holds the full inventory, the exact
SQL, the risk table, the rollback procedure and every piece of evidence.

### Correction to the premise this session started from
The session prompt said the previous session "dry-ran S1 policy removals."
**It did not.** The working tree was clean, the last commit is B5
(`75c43c6`), and no S1 dry-run artefact, log or doc entry existed anywhere in
the repo. What existed was the S1 *discovery* evidence from slice 5. The
rehearsal described below was therefore performed from scratch this session.

### What this session did
- Re-verified the finding against the live DB. **The 16 policies are still
  present and the count is exact**: 55 policies in `public`, 39 declared by
  `supabase/migrations/`, 16 undeclared — the same 16, no more, no fewer.
- Established *why* they are foreign: all 16 are `TO authenticated`; **every**
  repo-declared policy is `TO public`. 0009 states in a comment that
  `integration_events` is "Service-role only: RLS on, no client policies"; 0002
  enables RLS on `crews`/`crew_members`/`time_entry_audits` and declares no
  policy for them. The orphan `ensure_rls` event trigger that would re-create
  them is confirmed gone (0012).
- Re-ran the exploit live inside aborted transactions: worker reads **377**
  events, **deletes 16 `message.approved` events**, forges an event, creates a
  crew. And a new one — **`time_entry_audits` is not vacuous**: probing as the
  owner of the single audited entry gave `read=1 deleted=1 forged_inserted=1`.
  The person whose approved entry was edited can destroy its own audit trail.
- Proved nothing legitimate depends on the 16: no client code touches any of the
  four tables, `crews`/`crew_members` are empty, and the only dependent
  functions (`emit_event`, `audit_time_entry_edit`) are `security definer` owned
  by `postgres` on non-`FORCE` RLS tables — they bypass RLS and were exercised
  *after* the drops inside the rehearsal.
- **Rehearsed the removal** (`scripts/s1-policy-cleanup-rehearsal.sql`):
  `begin;` → 7 pre-assertions → 16 drops → 5 structural + 8 behavioural
  post-assertions + a live audit-trigger test → `rollback;`. All pass; the
  management API returned `[]`; the drift check after equals the drift check
  before; zero probe rows left behind.
- **Proved the rehearsal is non-vacuous** two ways and **proved the rollback**
  (`scripts/s1-policy-cleanup-rollback.sql`) restores all 16 byte-identically.
- Full regression **ALL GREEN** as the pre-change baseline.

### What this session deliberately did NOT do
No live DDL. No migration file authored (that happens at apply time, to keep
repo↔live in sync — **superseded 2026-07-27**: the migration is now authored as
`scripts/s1-migration-0016-PENDING.sql`, parked outside `supabase/migrations/`,
so the sync invariant still holds). No B4 / B5b / Entra / Graph work. No external
sends, no workflow activation, no RLS weakening, no audit rows deleted, no
credential exposed.

### Next session (corrected 2026-07-27 — the original instruction here was unsafe)
**Ask Jack for the go-ahead, then apply S1 in one session** — via the prepared
migration only. **Do NOT run the rehearsal file with `commit;`.** Correct
sequence (authority: `docs/SECURITY_FINDINGS.md` § S1 "The only supported apply
path"): move `scripts/s1-migration-0016-PENDING.sql` verbatim to
`supabase/migrations/0016_drop_undeclared_client_policies.sql`, dry-run it inside
`begin; … rollback;` and then apply it with the CONTEXT.md management-API recipe,
re-run regression (`acceptance-s1-security.sh` must flip its banner to
`S1 state: APPLIED` by itself), commit the migration and these docs in the same
session. The drift pin and worker-JWT denial check are already built —
`scripts/acceptance-s1-security.sh`, added 2026-07-27 — so no new test work is
needed at apply time. If Jack declines, S1 stays open and the next task is
**B5b** (requests inbox) or **B4**. Entra (I1) still blocks all Graph work.

## Prior state (2026-07-26, Task B5 COMPLETE — approval queue shipped, slice 5 green)

**B5 is done.** `/approvals` ships, backed by a pure logic module, 19 labelled
fixtures, a new offline Runner 5 and a new live acceptance slice 5. **Zero
database changes** — repo and live stay in sync at migrations 0001–0015 and the
drift check is clean (24 base tables).

### What B5 shipped
- **`apps/web/src/lib/approval-queue.ts`** — every decidable rule, pure and
  framework-free (no React, no Supabase client, no fetch, no clock). It IMPORTS
  the B3 engine's `enforceTestMode`/`resolveMode` from `scripts/lib/approval-matrix.mjs`
  instead of restating them, so there is exactly one definition of fixture-safety
  in the repo. `QUEUE_SELECT` (the queue's PostgREST projection) lives here and
  slice 5 reads it from the module — the acceptance test cannot drift from the UI.
- **`apps/web/src/app/approvals/page.tsx`** — the shell: five view states
  (loading / signed-out / error / empty / ready), pending-blocked-decided tabs,
  a detail panel with the full draft, the work request, the matrix row that
  routed it, the audit history, and Approve / Reject. Nothing is called that
  `planDecision()` did not return, so a refused decision never leaves the browser.
- **`fixtures/queue/`** — `base-row.json` + **19** labelled cases (each states
  only the fields it tests) covering authorized approve/reject, unauthorized,
  unresolved capability, signed-out, three duplicate-decision shapes, two
  fail-closed blocked rows, a draft with no approver, both TEST-mode directions,
  both LIVE-mode directions, escalation, and an unknown decision verb.
- **Runner 5** (`scripts/eval-approval-queue.{sh,mjs}`) — pure offline, in
  regression. Node 24 strips TS types on import, so it tests **the module the
  page ships**, not a copy. Beyond the labels it hard-gates determinism, the
  duplicate-decision invariant across *every* status enum value, the five view
  states, the refresh verdict, audit ordering, `QUEUE_SELECT` column/FK-hint
  resolution against the migrations, enum parity with 0015, and source purity
  (no send call, no service-role credential, no direct write, only two RPCs).
- **`scripts/acceptance-slice5.sh`** — 27 live checks over the browser's real
  credentials (anon key + the signed-in user's JWT), in regression. Proves what
  Runner 5 cannot: the three `users!` FK hints and the two-level
  `work_requests → email_messages` embed actually resolve; admin reads the queue
  while anon and the fixture `worker` read zero; `record_approval()` enforces the
  reason, the role and one-decision-per-message against those credentials; a
  blocked message is visible but undecidable; a direct PATCH writes nothing.
- **`docs/testing/APPROVAL_QUEUE.md`** — contract, guard vocabulary, data
  contract, TEST-mode rules, evidence, limits.

### B5 evidence (2026-07-26)
Runner 5 `passed=325 failed=0`, 19 fixtures, guard-reason coverage 7/7.
Slice 5 `passed=27 failed=0`. Full regression **ALL GREEN on two consecutive
runs**: mobile tsc, web build (**15 routes**), MCP 10 tools, slices 1–5
(9 + 10 + 20 + 49 + 27), Runner 1 24/24, Runner 2A 20/20 accuracy 12/12,
Runner 3 120/0, Runner 4 314/0, Runner 5 325/0, both migration lints PASS.
Non-vacuity by perturbation: adding `'approved'` to `DECIDABLE_STATUSES` → 6
failures; removing the rejection-reason `.trim()` → 4 failures; both restored,
`git diff` clean. Detail: docs/testing/APPROVAL_QUEUE.md.

### SECURITY finding — S1, open and human-gated
Slice 5 asked whether a browser session could read the event log. It can. The
live DB carries **16 undeclared policies** (`*_org_{select,insert,update,delete}`
on `integration_events`, `time_entry_audits`, `crews`, `crew_members`) that no
migration in this repo creates — orphan-schema residue 0012 did not clean up.
They gate on `current_org_id()` with **no role check**. Verified live inside
rolled-back transactions as the fixture `worker`: 310 events readable, **11
`message.approved` events deletable**, a forged event insertable. That breaks
"audit everything" and "no hard deletes" and makes the approval audit trail
destructible by the people it audits.

Not fixed this session on purpose: dropping objects on live is a destructive,
human-gated action, and authoring an unapplied migration would break the
repo↔live sync invariant. Remediation SQL + acceptance criteria: **TASK_BACKLOG
S1**. The approval queue is unaffected — it never reads that table, and
`outbound_messages`/`message_policies` carry no such policies.

### Two things worth carrying forward
- **The web app can import the offline engines directly**, and a Node runner can
  import the app's TypeScript module (type stripping). Verified both directions
  build and run. That is the escape from B3's dual-implementation problem: where
  logic is shared, keep ONE copy instead of a mirror plus a parity lint.
- **`npm run lint` in apps/web is broken repo-wide** (`eslint-config-next` wants
  a parser Next 16 does not ship). Confirmed pre-existing by stashing B5 and
  re-running. Not in regression; the build's TypeScript strict pass is green.
  Filed under TASK_BACKLOG AR — fix it, don't route around it.

### Still open (unchanged from B3, all deliberately fail-closed)
- Approval limits (boss §3) unknown → every live `approval_limit_cents` NULL, so
  amount-bearing messages block with `missing_approval_limit`.
- `estimate_proposal` approver unknown → blocks with `missing_approver_role`.
  Both are now VISIBLE to a human: the queue shows blocked rows with their reason.
- **I1 (Entra app registration) still blocks all real-mail work.** No Graph work
  started; slice 5 re-asserts `graph_message_id` stays NULL.
- Live fixture user `f1000000-0000-4000-8000-000000000001` "FIXTURE Non-Approver
  (slice4)" is used by slices 4 AND 5. Do not delete it.

### Next session — S1 (safest) then B5b or B4
**S1** is the safest next task and the only one with a security finding behind
it: it is a scoped, reversible-by-recreation policy cleanup, human-gated, with
acceptance criteria already written. After that, **B5b** (requests inbox, split
out of B5) or **B4** (emergency escalation config) — both independent and ready.
Do not start ADR Graph work; Entra (I1) is still blocked.

## Prior state (2026-07-26, Task B3 COMPLETE — live-verified, slice 4 green)

**B3 is done.** 0014 + 0015 are applied to the live project and every B3 acceptance
criterion now has executed live evidence. Migrations 0001–0015 and the repo are in sync.

### What B3-live shipped
- **0014 + 0015 applied live** (in that order, with Jack's explicit authorization). Both
  were dry-run first as one `begin; 0014; 0015; rollback;` against the live schema — zero
  errors, zero residue — then applied for real. Live now: `approval_drafts`,
  `approval_outcomes`, `category_authority`, `message_policies`, `outbound_messages`;
  4 enums; 5 RPCs; 10 seed policy rows, **all `mode='draft'`**, all limits NULL,
  `estimate_proposal.approver_role` NULL. Drift check clean: 24 base tables = 19 + 5.
- **`scripts/acceptance-slice4.sh`** — 49 live DB checks, in regression. Proves what the
  offline lint could not: RLS denial for a non-approver, approve → `message.approved`,
  `sent` unreachable without an approval row (three independent paths + a global
  invariant), `final_invoice` refusing `mode='auto'`, duplicate `draft_key` → **23505**,
  draft→auto flipping by data alone, automation having zero approval authority,
  content freeze after draft, terminal states, no hard deletes, and the fail-closed
  routing blocks executing live.
- **`scripts/parity-route-live.mjs`** — routes every (type × amount × unavailable-roles)
  case through both the live `route_outbound()` and the offline JS `route()` over the
  same live policy rows. **B3's dual-implementation risk is retired.**
- Harness reliability fix: 429 backoff in `scripts/lib/db.mjs` + slice 4, and a 45s
  mgmt-API cooldown in regression.sh.

### B3 evidence (2026-07-26, live)
Acceptance slice 4 **passed=49 failed=0**, green on two consecutive runs (re-runnable).
Parity: pass 1 = 160 cases / 642 field comparisons / 0 mismatches; pass 2 (configured
matrix, rolled back) = 300 cases / 2304 comparisons / 0 mismatches, with escalation (78)
and backup (32) branches asserted exercised. Full regression **ALL GREEN**: mobile tsc,
web build (14 routes), MCP 10 tools, slices 1–4 (9 + 10 + 20 + 49), Runner 1 24/24,
Runner 2A 20/20 accuracy 12/12, Runner 3 120/0, Runner 4 314/0, both migration lints PASS.
Non-vacuity re-verified by perturbation (see DECISION_LOG 2026-07-26 B3-live).
Detail: docs/testing/APPROVAL_MATRIX.md "Live evidence".

### Two things worth carrying forward
- **Live apply is authorization-gated, not tooling-gated.** No psql/supabase CLI/docker
  here, but the management query API executes DDL with the `.env.acceptance` token. Still
  ask Jack per migration; always dry-run in a rolled-back transaction first (recipe in
  CONTEXT.md).
- **A negative test must assert it targeted something.** Slice 4's first run "failed" on
  the `approval_drafts` delete guard only because the table was empty and a `before
  delete` trigger cannot fire on zero rows. Same class of bug as the parity hole that
  pass 2 exists to close.

### Still open (unchanged, all deliberately fail-closed)
- **Approval limits (boss §3) unknown** → every live `approval_limit_cents` stays NULL,
  so every amount-bearing message blocks with `missing_approval_limit`. Verified live.
- **`estimate_proposal` approver unknown** ([ASSUMPTION], B2/§3) → blocks live with
  `missing_approver_role`. Verified live.
- **I1 (Entra app registration) still blocks all real-mail work.** No Graph work started;
  slice 4 asserts `graph_message_id` is NULL on every row.
- One live fixture user exists for slice 4: `f1000000-0000-4000-8000-000000000001`
  "FIXTURE Non-Approver (slice4)", role `worker`. Do not delete it.

### Next session — B5 (recommended) or B4
**B5** (requests inbox + approval queue UI) is now fully unblocked: the tables its queue
reads exist live and their RLS/RPC behavior is proven. **B4** (emergency escalation
config) is also ready and independent. Do not start ADR Graph work (blocked on I1).

## Prior state (2026-07-26, Task B3 offline slice COMPLETE — Runner 4 green)

B3 (approval matrix + outbound drafts) built and committed this session, offline-first,
advancing from ADR commit `c6bd92f`. ZERO Graph, ZERO network, ZERO send, ZERO live-DB
writes — as scoped. TEST/fixture mode throughout; every fixture recipient is
`@example.invalid`.

### What B3 shipped
- **0015_approval_matrix_outbound.sql** — additive over 0001–0014. `message_policies`
  (the REQUIREMENTS matrix as data: mode, approver_role, backup_approver_role,
  escalation_role, approval_limit_cents, confidence_threshold, escalation_after_hours,
  active) + `outbound_messages` (draft/approved/rejected/sent/failed/**blocked**,
  routing evidence, draft_key idempotency, approval + manual-send attribution).
  Enums `outbound_message_type` / `message_mode` / `outbound_message_status` /
  `business_role` (9 approver roles — the 10 STAKEHOLDERS roles minus `customer`, who has no login). `route_outbound()`,
  `create_outbound_draft()`, `record_approval()`, `mark_message_sent()`,
  `business_role_matches()` (the single interim role mapping until Phase 5
  `user_roles`). Transition guard + content-freeze-after-draft, no-delete guards on
  both tables, RLS admin-read only (no insert/update policy — RPCs are the only
  writers), 6 events on the emit_event spine (`message.draft_created` / `blocked` /
  `escalated` / `approved` / `rejected` / `sent`), and the v1 matrix seed — **every
  row `mode='draft'`**, limits NULL (boss §3 unanswered), `estimate_proposal`
  approver NULL (open [ASSUMPTION]) so it fails closed instead of guessing.
- **scripts/lib/approval-matrix.mjs** — pure/offline/deterministic routing engine, the
  JS mirror of `route_outbound()`: primary → backup (when unavailable) → escalation
  (over limit), with 6 fail-closed route reasons. `effective_mode` is ALWAYS `draft`;
  a row already flipped to `auto` is reported (`policy_mode`, `auto_downgraded`) and
  still drafted.
- **scripts/lib/outbound-draft.mjs** — 10 deterministic templates + `prepareOutbound()`,
  the gate every outbound action passes through (action registry → duplicate key →
  template build → forbidden-content scan → TEST mode → routing), with an ordered
  audit trail on every path.
- **fixtures/outbound/** — 5 policy sets + 16 labelled cases + labels.json.
- **scripts/eval-approval-matrix.{sh,mjs}** — Runner 4, pure offline, in regression.
- **scripts/lib/validate-migration-0015.mjs** — offline structural lint + engine/SQL
  parity, in regression.
- **docs/testing/APPROVAL_MATRIX.md** — contract, routing rules, gate order, status
  machine, gates, limits, deliberate exclusions.

### B3 evidence (2026-07-26)
Runner 4 `passed=314 failed=0, 16 fixtures, blocked-reason coverage 11/11, template
coverage 10/10`; determinism + no-send + fixture-recipient + source-purity + seed-parity
gates all hard. Migration 0015 lint PASS (64 checks). Both runners verified non-vacuous
by perturbation (2 label flips → exactly 2 failures; `effective_mode`→`auto` + constraint
rename → exactly 2 lint failures; both restored). No regression: Runner 3
`passed=120 failed=0`, 0014 lint PASS, mobile tsc clean, web build green (14 routes),
MCP smoke 10 tools. Live-DB steps (acceptance slices 1–3, eval-intake, Runner 2A) were
**deliberately not run** — this session was constrained to write nothing to the live
project.

### B3 open dependencies (NOT blockers)
- **0015 (and still 0014) never applied to the live DB** — no psql/supabase CLI/docker
  in-env; applying schema to live Supabase from an isolated session is a human-gated
  outward action. Apply: `source .env.acceptance` then the mgmt query API recipe in
  CONTEXT.md.
- **Backlog acceptance criteria 2 + 3 (non-approver blocked by RLS; approve emits
  `message.approved`) are lint-verified only** until acceptance slice 4 runs live.
  Tracked as **B3-live** in TASK_BACKLOG.
- **Dual-implementation risk**: routing exists in SQL and JS. The parity lint covers
  vocabularies, not branch logic — slice 4 is what retires it.

### Next session — B3-live (safest) or B5
**B3-live** (human applies 0014+0015, then `scripts/acceptance-slice4.sh` proves the
DB-side gates) is the safest next task and closes B3's open criteria. **B5** (requests
inbox + approval queue UI) is the next build task and is unblocked by B3 offline, but
its queue reads tables that do not exist live yet. Do not start ADR Graph work; Entra
(I1) is still blocked.

## Current state (2026-07-20, Task ADR offline slice COMPLETE — Runner 3 green)

ADR offline evidence slice built and committed this session. Repo advanced from
B2 commit `18ef23f`. ZERO Graph, ZERO network, ZERO send — as scoped.

### What ADR shipped
- **0014_approval_evidence.sql** — additive over 0001–0013. Tables
  `approval_drafts` / `approval_outcomes` / `category_authority`; `is_fixture` +
  `fixture:<key>` namespace, org-scoped FKs, timestamps, RLS-first (admin read;
  service-role write; no delete policy), no-hard-delete `before delete` guards +
  immutability guards (corrections = new rows), events `approval.diff_recorded` +
  `approval.material_edit` on the emit_event spine, **human-set** `authority_level`
  (default `draft_only`; no autonomous graduation).
- **scripts/lib/approval-diff.mjs** — pure/offline/deterministic. `diff(draft,sent)`
  → `{unchanged, edit_ratio, field_deltas, edit_classes, material}` (+ `ambiguous`,
  `errors`). Compares subject/body/to/cc/bcc/attachments; 10-class heuristic
  classifier; malformed input fails closed → material.
- **fixtures/approvals/*.json** (15) + labels.json — ≥1 labelled pair per edit
  class, plus unchanged / multi-class / ambiguous / malformed / missing-optional.
- **scripts/eval-approval-diff.sh** (+ .mjs) — Runner 3, pure offline (no keys/DB/
  network), in regression.
- **scripts/lib/validate-migration-0014.mjs** — offline structural lint (no DB in
  env), in regression.
- **docs/testing/APPROVAL_DIFF.md** — schema, contract, material/classification
  rules, limits, Runner 3, deliberate exclusions.

### ADR evidence (2026-07-20)
Runner 3 `passed=120 failed=0, 15 fixtures, edit-class coverage 10/10`; determinism
+ contract-shape asserted per fixture. Migration lint PASS. No B1/B2 regression:
Runner 2A `passed=20 failed=0, accuracy 12/12` (verified in isolation — a full-
regression run hit a transient Supabase mgmt-API 429 throttle on 2A only; re-run
green), intake eval 24/24, acceptance slices intact. Detail: docs/testing/APPROVAL_DIFF.md.

### ADR open dependency (NOT a blocker)
**0014 never applied to the live DB** — no psql/supabase CLI/docker in this env, and
applying schema to live Supabase from an isolated session is a human-gated outward
action (same posture as B2's Runner 2B). To apply: `source .env.acceptance` then
push 0014 via the supabase CLI or the mgmt query API. Runner 3 (the completion bar)
is fully offline and passes without it.

### Next session — ADR Graph capture, NOT started
Microsoft Graph Sent-Items subscription + draft→sent mailbox pairing feeding real
captures into 0014's schema via the offline engine. Only after 0014 is applied live.
Everything in "hard boundaries" for this slice still holds until that task is
explicitly approved.

## Current state (2026-07-20, Task B2 COMPLETE — classification harness + Runner 2A green)

B2 built and committed this session. Live DB + repo in sync at migrations
0001–0013. Classifier is a provider-agnostic domain service with an injected
model adapter; deterministic Runner 2A is GREEN and wired into regression.

### What B2 shipped
- **0013_triage_events.sql** — additive `request.triage_required` +
  `duplicate_flagged` intake events (existing emits unchanged). Applied to live DB.
- **scripts/lib/classification.mjs** — domain service: keyword∪model emergency
  union, 1-call+≤2-retry budget, fail-closed→unknown/needs_review, status
  derivation, hallucination guard, Jaccard duplicate detection.
- **scripts/lib/model-adapters.mjs** — `fixtureAdapter` (recorded, 2A) +
  `anthropicAdapter` (live raw fetch, 2B, no SDK).
- **scripts/lib/db.mjs** — persistence + deterministic Verify Step (re-read DB:
  row_updated/values_match/org_scoped/event_present/no_duplicate_side_effect)
  over the management query API; idempotent `fixture:<name>` ingest.
- **scripts/classify.mjs** — thin entrypoint (`--fixture --adapter --persist`,
  `--selftest`); success requires `verify.ok`, never the model's word.
- **scripts/eval-classification.sh** (Runner 2A, in regression) +
  **scripts/eval-classification-live.sh** (Runner 2B, key-gated, not in regression).
- **fixtures/emails/model_recorded.json** — recorded model outputs for 2A.

### B2 evidence (2026-07-20)
Runner 2A `passed=20 failed=0, accuracy 12/12`; all Verify Steps pass; emergency
union catches 02/03/05; fixture 11 fails closed; hallucinated fields 0; idempotent
rerun proven. Regression: acceptance-slice3 20/20, eval-intake (Runner 1) 24/24 —
no existing intake behavior broke. Full detail: docs/testing/EVAL_STRATEGY.md.

### B2 open dependency (NOT a blocker)
**Runner 2B never executed** — no `ANTHROPIC_API_KEY` in this environment. B2 =
*implementation complete / deterministic eval green / live eval pending
credential*. External execution dependency. To finish evaluation: set
`ANTHROPIC_API_KEY` (do NOT commit it) and run
`source .env.acceptance && ANTHROPIC_API_KEY=... bash scripts/eval-classification-live.sh`.
B2 may NOT be called "fully evaluated" until that passes with a real key.

### Next session — ADR (Approval Diff & Reasoning), NOT started
Design agreed this session (draft-not-compose ROI; diff-capture of AI-draft vs
admin-sent via Graph Sent Items; per-category graduation to auto). **Safest first
task:** the offline diff engine + evidence schema on fixtures — migration
`0014_approval_evidence.sql` (approval_drafts / approval_outcomes /
category_authority, is_fixture, no hard deletes), pure `scripts/lib/approval-diff.mjs`,
labelled `fixtures/approvals/*.json`, deterministic `scripts/eval-approval-diff.sh`
(Runner 3). ZERO Graph, ZERO network, ZERO send capability. Graph
subscription/matching is the deliberate task AFTER that. Do not start ADR until
B2's DoD is acknowledged.

## Current state (2026-07-17, Phase 4 COMPLETE — MVP defined, eval baseline built)

Phase 4 ran as one session: MVP defined in **docs/planning/MVP_SPEC.md** (the
canonical MVP authority — read it before any B-task), harness mapped in
**docs/architecture/AGENT_HARNESS.md**, evals in
**docs/testing/EVAL_STRATEGY.md**, 7 harness terms added to
UBIQUITOUS_LANGUAGE.md. Key decisions (full list DECISION_LOG 2026-07-17
Phase 4): MVP = email-triage vertical [RECOMMENDATION — boss confirmation
pending]; attendance report = fast-follow blocked on B8; Maps 1–7 + drafts/
approvals ship, scheduling + delivery post-MVP; no generic agent runtime;
Verify Step convention; B2 budgets (1 call/email, ≤2 retries, fail-closed);
Phases 5–6 collapsed into per-slice design interrogations.

Built this session (E1): fixtures/emails/labels.json (ground truth) +
scripts/eval-intake.sh (baseline deterministic eval: keyword recall 100%, FP
0, territory 100%) wired into regression.sh. Regression = 3 acceptance slices
+ baseline eval, ALL GREEN. Drift check clean at migrations 0001–0012.

### Grill questions for the boss (Phase 4, ≤5)
1. Priority + B8 together: first demo = email-triage queue (buildable now) or
   daily attendance exception report (needs your written rounding/OT policy —
   what is it)?
2. B2: who watches the requests inbox today, and who should own the triage
   queue (drives W2 approver too)?
3. B5: exact towns/counties/zips we accept work in (unlocks the only planned
   auto-send, currently drafted-only)?
4. B10: minimum info before a service call can be scheduled?
5. Interview closer 2 (still unasked): the one mistake this automation must
   never make?

### Next build session prompt — Task B2 (approved order: B2→B3→B5→B4)
> Read docs/planning/CONTEXT.md, SESSION_HANDOFF.md, MVP_SPEC.md,
> docs/architecture/AGENT_HARNESS.md, docs/architecture/UBIQUITOUS_LANGUAGE.md,
> docs/testing/EVAL_STRATEGY.md, TASK_BACKLOG.md B2. Task B2 only:
> classification harness + Runner 2 evals. Start with the compact design
> interrogation (packet fields, prompt versioning, runner location, new event
> types), record decisions in DECISION_LOG, then test-first build per the
> operating model. Budgets and gates are fixed by Phase 4 — do not relax them.
> Regression + baseline eval green before and after; drift check; update
> backlog/handoff; commit; stop after B2.

## Prior state (2026-07-17, Task B1 COMPLETE — implementation started)

B1 (intake spine) built and committed this session. Live DB and repo in sync at
migrations 0001–0012. Regression = 20 acceptance checks across 3 slices, ALL
GREEN. New operating model in force — see DECISION_LOG 2026-07-17 B1 entry
(repo source-of-truth + drift check every DB task; design interrogation before
each slice; test-first; ubiquitous language).

### What B1 shipped
- **0011_request_intake.sql**: email_messages (immutable audit ingestion,
  set-once work_request attach, partial-unique graph_message_id dedupe),
  work_requests (classification/urgency/status enums incl. awaiting_info/
  needs_review/duplicate; emergency ⇒ forced escalated+emergency; duplicate ⇒
  link mandatory), is_emergency_text() keyword net, check_territory()
  (county/zip vs service_areas; unknown ⇒ null, never out-of-territory),
  shifts.work_request_id + guard (escalated never schedulable), events
  request.received / request.classified / request.emergency_escalated.
- **0012_drop_orphan_schema.sql**: dropped 16 empty uncommitted tables + helpers
  an external session had created directly on live (it had overwritten
  current_org_id() and broken all Workstream A RLS — restored to 0002
  semantics). Details: DECISION_LOG 2026-07-17.
- **fixtures/emails/01–12*.json** + **scripts/acceptance-slice3.sh** (20 checks)
  wired into regression.sh.
- docs/architecture/UBIQUITOUS_LANGUAGE.md created.

### Next sessions (pick ONE)
- **Phase 4 planning** (MVP definition — boss-priority decision). Prompt in
  "Next planning session prompt — Phase 4" below. Still the open planning gate.
- **Build B2** (classification harness) or **B3** (approval matrix + outbound
  drafts) — both unblocked by B1; run design interrogation first per operating
  model.
- **Task A2** (corrections UI) — approved, still pending, independent.

## Prior state (2026-07-17, Phase 3B COMPLETE)

Phase 3B executed 2026-07-17 in one session. Jack's draft prompt was LLM-council
pressure-tested first; the executed version merged his 14-workflow decomposition
onto the canonical grounding scaffold (see DECISION_LOG 2026-07-17 Phase 3B —
includes the process rule born from the phantom AI_DEVELOPMENT_METHOD.md
reference: fresh-session prompts must be generated from state files, never
freehand; TASK_BACKLOG P1 tracks writing that doc). **Uncommitted** in working
tree (3A + 3B changes); suggested commit message: "Planning: Phase 3A+3B workflow
maps (intake + delivery)".

### What Phase 3B completed (delivery workflow maps)
- **WORKFLOW_MAPS.md** — retitled to cover both sides; appended Maps 8–21, each
  with Jack's 12-field template (trigger / required inputs / responsible roles /
  automated actions / human approvals / decision points / status transitions /
  notifications / audit events / failure cases / escalation path / definition of
  completion; 3A Maps 1–7 NOT retrofitted): (8) estimate preparation, (9) proposal
  approval + delivery (two gates: internal numbers approval, then message-send
  approval), (10) customer approval or rejection (automation proposes intent
  reading; human confirms — NEVER auto-set), (11) job scheduling (find_best_worker
  reuse; calendar write BLOCKED I1), (12) crew assignment, (13) crew dispatch
  (human-triggered v1, W4), (14) schedule change/cancellation, (15) job completion,
  (16) partial completion + return visit (same job, N visits; invoice waits for
  FINAL completion), (17) change order (owner-only approval, two gates), (18)
  payroll/attendance touchpoint (daily exception report = Phase 4 candidate, NOT
  decided here), (19) invoice preparation (idempotent on job.completed), (20)
  invoice approval + delivery (v1 manual QB/Outlook, never auto), (21) failed
  automation/manual correction (cross-cutting mirror of Map 7 — "one pipeline,
  two writers"). Plus shared delivery rules (every customer reply runs the intake
  spine/keyword net first) and delivery invariants 7–12 (12 = Phase 5 schema
  proposals: job status enum, ~10 events, cancellation_notice matrix row,
  discrepancy flag, aging checks).
- Key decisions logged (DECISION_LOG 2026-07-17 Phase 3B): merged-prompt scope;
  prompts-from-state-files process rule; Map 21 cross-cutting; human-confirmed
  customer-intent interpretation; invoicing waits for final completion +
  idempotent; Phase 5 design proposals.
- New open questions: **B13–B18** (proposal validity/silence, cancellation policy,
  partial billing, field COs, fixed-vs-T&M decider, payment tracking) + **W4–W6**
  (dispatch timing, cancellation matrix row, completion-notice policy) — all in
  ASSUMPTIONS_AND_OPEN_QUESTIONS.md. W1 extended to delivery queues.
- TASK_BACKLOG: D3 extended with B13–B18; build-notes added to B6 (Maps 11–13)
  and B8 (Maps 15–20); P1 (AI_DEVELOPMENT_METHOD.md) added; B15/W4 parked in
  future improvements.
- All locked decisions preserved: zero v1 auto-sends, invoice never auto,
  automation zero approval authority, no hard deletes, pricing_complete blocks
  send, emergency net on every inbound. No code, no schema, no MVP change.

### Grill questions for Jack (≤5, from Phase 3B)
1. B13 — how long is a sent proposal valid; nudge policy for silent customers;
   honor a stale acceptance after prices changed?
2. B14 — who may cancel a customer-approved job; required notice; cancellation fee?
3. B15 — invoice only after final visit, or interim/progress billing?
4. B16 — how do crews report scope growth today; may work proceed before the CO
   is approved?
5. W4 — when does the dispatch notification go out, and who triggers it in v1?

## Prior state (2026-07-17, Phase 3A COMPLETE)

Phase 3A executed per Jack's fresh-session prompt (which REDEFINED the 3A list —
see DECISION_LOG 2026-07-17 Phase 3A entry): intake-side only. **Uncommitted** in
working tree; suggested commit message: "Planning: Phase 3A intake workflow maps".

### What Phase 3A completed (intake workflow maps)
- **WORKFLOW_MAPS.md (new)** — 7 intake maps, each with trigger / required inputs /
  classification rules / decision points / human approvals / automated actions /
  status transitions / notifications / audit events / failure cases / escalation /
  definition of completion: (1) new work request, (2) emergency, (3) out-of-territory,
  (4) service call, (5) missing-info follow-up, (6) duplicate, (7) failed/low-
  confidence classification. Plus shared intake spine, classification precedence
  (emergency > not-a-work-request > out-of-territory > service/estimate > unknown),
  and cross-map invariants checklist for Phase 5 + B1.
- Key design decisions logged (DECISION_LOG 2026-07-17 Phase 3A): keyword emergency
  net runs on EVERY inbound before any short-circuit; fuzzy duplicates never
  auto-closed (only exact graph_message_id auto-attaches); dup of active emergency →
  append + re-notify; no intake auto-ack email in v1; proposed Phase 5 schema
  additions (statuses awaiting_info/needs_review/duplicate, classification
  not_a_work_request, 5 new event types, matrix row missing_info_followup).
- Estimate/proposal + customer job-approval maps MOVED to Phase 3B (were in old 3A
  list; Jack's prompt replaced them with missing-info/duplicate/low-confidence).
- New open questions: **B10** (required intake fields per type), **B11** (info-request
  nudge/close policy), **B12** (emergency ack timeout + fallback order), **W1–W3**
  (intake SLA/cadence; v1 decline-draft approver; whether confirmation approval also
  authorizes the calendar entry) — all in ASSUMPTIONS_AND_OPEN_QUESTIONS.md §A/§E.
  Standing assumption 8 added (office admin = triage owner, pending B2).
- TASK_BACKLOG: B1 note added (build to WORKFLOW_MAPS spine + invariant 6; fixtures
  for Maps 5–7); D3 extended with B10–B12; future improvements + auto-ack parked.
- Zero-auto-send lock, emergency rules, no-hard-deletes, automation-zero-authority
  all preserved — no contradictions introduced. No code, no schema, no MVP change.

### Grill questions for Jack (≤5, from Phase 3A)
1. B10 — minimum fields before a service call can be scheduled?
2. B11 — nudge count/spacing + when to close an unanswered info request?
3. B12 — emergency ack timeout; who's second-line and after how long?
4. W1 — intake SLA: how long may a request sit untouched; pings or digest?
5. W3 — does approving the service-call confirmation also authorize the calendar
   entry, or is scheduling a separate approval?

## Prior state (2026-07-17, Phases 1–2 committed)

**Commit `d80a880`** on main: "Planning: Phase 1-2 of Autonomous Workflow Engine +
boss-priority finding" (6 files in docs/planning/, 674 insertions). Working tree clean.
No code changes since aad11e3.

### What Phase 1 completed (current-state discovery)
- CURRENT_WORKFLOW.md — working model of office operations, broadly affirmed by Jack
  2026-07-17: intake channels + volumes (phone ~10–20/day > email ~3–10/day), people
  map, 16-step request→payment trace, 8 ranked delay points, emergency handling,
  territory practice. §0 = boss's #1 pain (see blockers below).
- ASSUMPTIONS_AND_OPEN_QUESTIONS.md — single source of truth for open questions
  (B1–B9 boss, I1–I2 IT, J1–J3 Jack, 7 standing assumptions).
- DECISION_LOG.md — append-only log. Phase 1 locks: auto-decline disabled entirely
  (ZERO v1 auto-sends until owner approves verified territory rules); email-first MVP
  with manual-intake-form phone bridge later; territory rules extensible day one;
  permissions per-role not per-person.

### What Phase 2 completed (users + permissions)
- STAKEHOLDERS_AND_PERMISSIONS.md — APPROVED. 10 roles × 6 verbs
  (view/create/approve/modify/send/delete), 5 universal rules (no hard deletes;
  audit everything; automation zero approval authority; RLS org-scoping; sends need
  approval row), role→DB divergence table (worker/foreman/admin → 10 roles, Phase 5
  migration).
- Decisions: `user_roles` join table for multi-role humans; customer = email-only
  actor (no portal); sysadmin (Jack) barred from business approvals in prod;
  message_policies gets amount-threshold column now (values await boss §3); v1
  invoice = system drafts record → human creates in QB, sends via Outlook → marks sent.
- BOSS_INTERVIEW.md — 12-round capture sheet; closer 1 ANSWERED, rest open.

### Blockers + open boss questions
- **Boss-priority finding:** boss's #1 pain = daily punch verification + job-number
  entry into ExakTime (~1 hr/day), wants ~1-mile geofence. Mostly Workstream A,
  mostly built; gaps = job-number sync, daily exception report, OT precision. Phase 4
  MUST weigh "daily attendance exception report" vs email triage as first demo.
  DECIDE IN PHASE 4, not before. See CURRENT_WORKFLOW §0 + DECISION_LOG 2026-07-17.
- Interview closer 2 still unasked: "one mistake this automation must never make."
- B8 (OT/rounding policy) now urgent — blocks overtime flagging boss asked for.
- B1–B9, I1–I2 all open (rounds 2–11 of BOSS_INTERVIEW.md unfilled). I1 (Entra app
  registration) blocks all real-mail work — fixtures-first until then.
- J1 (n8n URL) unknown.

### Phase 3A — next planning session (SUPERSEDED — 3A ran 2026-07-17 with Jack's revised workflow list; see Current state)
- **Objective:** map the 7 intake-side workflows SEPARATELY, one at a time, into a
  new docs/planning/WORKFLOW_MAPS.md: (1) new work request, (2) emergency request,
  (3) out-of-territory request, (4) service-call request, (5) estimate and proposal,
  (6) job approval, (7) failed automation / human correction. Each map: trigger,
  actors (STAKEHOLDERS roles), steps, decision points, approval gates (cite
  REQUIREMENTS approval matrix), data written (cite DATA_MODEL tables), failure/edge
  cases (cite RISKS_AND_EDGE_CASES fixtures), what the human sees.
- **Files to read (in order):** docs/planning/CONTEXT.md, SESSION_HANDOFF.md,
  DECISION_LOG.md, CURRENT_WORKFLOW.md, STAKEHOLDERS_AND_PERMISSIONS.md,
  USER_WORKFLOWS.md, REQUIREMENTS.md (approval matrix), DATA_MODEL.md,
  ASSUMPTIONS_AND_OPEN_QUESTIONS.md, RISKS_AND_EDGE_CASES.md.
- **Acceptance criteria:** all 7 maps present with every field above; no contradiction
  with locked decisions (zero auto-sends until territory verified; emergency halts
  auto-scheduling + never sends troubleshooting advice; automation zero approval
  authority; no hard deletes); reuses/expands USER_WORKFLOWS.md Workflow 1 instead of
  duplicating it; new unknowns appended to ASSUMPTIONS_AND_OPEN_QUESTIONS.md with
  IDs; DECISION_LOG.md appended for any new decisions; this handoff updated; exact
  Phase 3B prompt written; ≤5 grill questions to Jack; STOP after 3A (7-step
  end-of-stage protocol).
- **Out of scope for 3A:** delivery-side workflows (scheduling, crew assignment,
  dispatch, completion, change order, payroll reporting, final invoicing — that's 3B);
  MVP selection (Phase 4); schema/architecture design (Phase 5); task breakdown
  (Phase 6); any code, dependency, or schema change; deciding the boss-priority MVP
  question.
- Exact fresh-session prompt: "Next planning session prompt" section below.
- Task A2 build prompt below remains approved + pending (independent of planning).

## Prior state (2026-07-17, end of Phase 1 discovery session)

- Project name for Workstream B pipeline: **Autonomous Workflow Engine** (Jack, 2026-07-17).
- Phase 1 current-state discovery interviewed and documented. New files:
  CURRENT_WORKFLOW.md (working model — NOT boss-confirmed), ASSUMPTIONS_AND_OPEN_QUESTIONS.md
  (now the single source of truth for open questions), DECISION_LOG.md (append-only;
  decision lists below are historical snapshots — log wins on conflict).
- Key 2026-07-17 refinement: auto-decline disabled entirely (zero v1 auto-sends) until
  owner approves verified territory rules. Email-first MVP; phone intake = future +
  manual intake form. Details in DECISION_LOG.md.
- Planning phases remaining (Jack's sequence): 2 users/permissions → 3 workflow maps →
  4 MVP definition → 5 technical architecture → 6 development breakdown. One phase per session.
- No code changes this session. Task A2 (below) still approved and pending — Phase 2
  planning and A2 build are independent sessions.

## Prior state (2026-07-16, end of session A1)

- Repo: ~/exattime, git main. Commits: aad11e3 (Slice 2: immutability + corrections), 6a7ef3a (planning docs). Working tree clean except gitignored env files.
- Live Supabase: migrations 0001–0010 applied. Regression ALL GREEN (19/19 acceptance checks + typechecks + build + MCP smoke).
- Run tests: `source .env.acceptance && bash scripts/regression.sh`

## Task A1 — DONE (2026-07-16)

Slice 2 at 10/10; full regression ALL GREEN; committed. Root cause of the 6 failures: test-data bugs, no schema changes needed. (1) Setup clock-out PATCH violated `clock_out > clock_in` check constraint when insert+PATCH landed in the same second — response was discarded to /dev/null so it failed silently; (2) hardcoded corrected clock_out (21:15) predated the entry's clock_in (21:35) so the same constraint aborted apply_timecard_correction (transaction rollback correctly left the correction pending). Fixes: clock_in set 1h in the past in both acceptance scripts; NEWOUT computed as now+30m.

**Diagnosis correction:** the slice-1 "transient HTTP flake" from the baseline run was actually this same-second constraint race, not network. The `--retry` hardening stays (harmless) but the real fix is the past clock_in.

Known quirk: macOS `date -v` flags used in acceptance scripts — not portable to Linux CI. Fine on Jack's machine; revisit if CI is added.

## Planning decisions locked (2026-07-16 grill session)

- Cutover: 2 matching parallel pay periods vs ExakTime; ExakTime = fallback.
- Boss's scope = request→invoice pipeline (email pasted, formalized in USER_WORKFLOWS.md).
- v1 auto-send: out-of-territory decline ONLY (high confidence + definite rules); all else drafts; final invoice never auto.
- Emergency detection = required MVP; configurable contacts; no troubleshooting advice ever.
- Shared mailbox ≠ shared calendar; dedicated requests@ mailbox preferred; owner inbox untouchable.
- Pricing: placeholders only, source + last-updated mandatory, incomplete pricing blocks send.
- QuickBooks: Option B (integrate after core workflow) — recommended + documented in INTEGRATIONS.md.
- Fixtures-first email build; Entra app = blocking dependency for all real-mail work.

## Unresolved questions

Moved to ASSUMPTIONS_AND_OPEN_QUESTIONS.md (single source of truth; boss/IT/Jack
sections with blocking info). Do not maintain a second list here.

## Security debt

Revoke sbp_ management token after setup; rotate service-role key before real data; org-scope punch-photo read policy.

## Next planning session prompt — Phase 4: MVP definition (written by Phase 3B, 2026-07-17)

> Begin Phase 4 as one fresh-context Ralph-loop planning iteration. First read
> docs/planning/CONTEXT.md, SESSION_HANDOFF.md, TASK_BACKLOG.md, DECISION_LOG.md,
> PROJECT_SCOPE.md, CURRENT_WORKFLOW.md, WORKFLOW_MAPS.md,
> STAKEHOLDERS_AND_PERMISSIONS.md, USER_WORKFLOWS.md, REQUIREMENTS.md,
> DATA_MODEL.md, RISKS_AND_EDGE_CASES.md, and ASSUMPTIONS_AND_OPEN_QUESTIONS.md.
> Verify every file above exists before starting; report any that don't.
> Planning-only session — no production code, no dependencies, no schema changes,
> no integrations, no guessing company policy. Your only task is Phase 4: define
> the MVP. (1) DECIDE the boss-priority question (DECISION_LOG 2026-07-17
> boss-priority finding + CURRENT_WORKFLOW §0): first demo = daily attendance
> exception report (Workstream A, zero Entra blockers, boss's stated ~1 hr/day
> pain) vs email-triage pipeline (Workstream B core) — pick one, log why. (2)
> Define MVP scope as a cut through WORKFLOW_MAPS.md Maps 1–21: which maps ship
> in v1, which degrade to manual, which wait; respect blockers (I1 Entra, J1 n8n,
> B5 territory) and TASK_BACKLOG statuses. (3) Define demo-day acceptance
> criteria per shipped map. (4) Scope the phone-intake manual-entry bridge form
> (decided shortly-after-MVP). Honor every locked decision (zero v1 auto-sends;
> invoice never auto; automation zero approval authority; no hard deletes;
> pricing_complete blocks send; emergency net on every inbound). Label
> assumptions; append new unknowns to ASSUMPTIONS_AND_OPEN_QUESTIONS.md with IDs;
> DECISION_LOG.md only for actual decisions; update TASK_BACKLOG.md (reorder/
> re-scope tasks to the MVP cut); compact into SESSION_HANDOFF.md; ≤5 grill
> questions for Jack; state COMPLETED / BLOCKED / NEEDS HUMAN REVIEW / SPLIT INTO
> SMALLER TASKS; provide the exact Phase 5 prompt (technical architecture); stop
> after Phase 4.

## Next planning session prompt — Phase 3B (SUPERSEDED — 3B ran 2026-07-17 with Jack's 14-workflow merged prompt; see DECISION_LOG. Kept for history.)

> Begin Phase 3B as one fresh-context Ralph-loop iteration. First read
> docs/planning/CONTEXT.md, SESSION_HANDOFF.md, TASK_BACKLOG.md, DECISION_LOG.md,
> PROJECT_SCOPE.md, CURRENT_WORKFLOW.md, WORKFLOW_MAPS.md,
> STAKEHOLDERS_AND_PERMISSIONS.md, USER_WORKFLOWS.md, REQUIREMENTS.md,
> DATA_MODEL.md, RISKS_AND_EDGE_CASES.md, and ASSUMPTIONS_AND_OPEN_QUESTIONS.md.
> Planning-only session — no production code, no dependencies, no schema changes, no
> MVP change, no integrations, no guessing company policy. Your only task is Phase
> 3B: map the estimate and delivery-side workflows, appended to WORKFLOW_MAPS.md,
> each mapped separately: (1) estimate and proposal (incl. internal approval), (2)
> customer job approval (proposal acceptance, incl. ambiguous replies), (3)
> scheduling and crew assignment, (4) dispatch, (5) job completion, (6) change
> order, (7) final invoicing (v1 manual QB/Outlook flow), (8) payroll-reporting
> touchpoint. For each define: trigger, required inputs, decision points, human
> approvals (cite REQUIREMENTS approval matrix + STAKEHOLDERS roles), automated
> actions, status transitions, notifications, audit-log events, failure cases,
> escalation path, definition of completion. Honor every WORKFLOW_MAPS.md cross-map
> invariant and all locked decisions (zero v1 auto-sends; invoice never auto;
> automation zero approval authority; no hard deletes; pricing_complete blocks
> send). Reuse USER_WORKFLOWS.md Workflow 2 — don't duplicate it. Label assumptions;
> append new unknowns to ASSUMPTIONS_AND_OPEN_QUESTIONS.md with IDs; DECISION_LOG.md
> only for actual new decisions; update TASK_BACKLOG.md; compact into
> SESSION_HANDOFF.md; ≤5 grill questions for Jack; state COMPLETED / BLOCKED / NEEDS
> HUMAN REVIEW / SPLIT INTO SMALLER TASKS; provide the exact Phase 4 prompt (MVP
> definition — including the boss-priority attendance-report-vs-email-triage
> decision); stop after 3B.

## Next build session prompt — Task A2 APPROVED by Jack (2026-07-16)

> Read docs/planning/CONTEXT.md, then docs/planning/SESSION_HANDOFF.md and TASK_BACKLOG.md. Task A2 is approved: build the /corrections page in apps/web (list timecard_corrections with original vs corrected values and reason; Approve button calling the apply_timecard_correction RPC; Reject button setting status=rejected) plus a Nav entry. Reuse existing page patterns (see timesheets page for the approve-button pattern). Acceptance: web build green (15 routes); seeded pending correction can be approved end-to-end and the time entry updates; rejected correction cannot be applied; `source .env.acceptance && bash scripts/regression.sh` ALL GREEN before and after. Update TASK_BACKLOG.md + SESSION_HANDOFF.md, commit, report modified files. Do only this task.
