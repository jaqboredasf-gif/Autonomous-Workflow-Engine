# Agent Handoff

## updated_at

2026-07-28T18:40:00Z

## agent

Claude (Claude Code, Opus 5)

## repository

jaqboredasf-gif/Autonomous-Workflow-Engine

## branch

`feat/kernelized-mcp-context`, continuing from `b038598`. Nothing was pushed.
No branch was moved, reset, merged, rebased or deleted. No PR was opened.

Branch relationships established last session still hold: this branch uniquely
carries the C1/S1 security work and is **not** superseded by
`chore/agent-handoff-clean`.

## commit

Four new commits, none pushed:

| commit | scope |
|---|---|
| `5dd8a2d` | `@exattime/awe-control-plane` — manifest, workflow registry, policy, journal, dispatch, engine |
| `2a2ba23` | `@exattime/awe-runtime` — control-plane service, journal/result stores, injected clocks, reference workflow, operator CLI |
| `81fede2` | Runner P — 372 offline gates, registered in the suite registry and the reason union |
| `13a81a0` | `docs/architecture/EXECUTION_CONTROL_PLANE.md` |

## current objective

Completed **AWE Execution Control Plane Integration**. A registered workflow is
now validated, authorized, executed through a controlled tool boundary, paused
for human approval, resumed by a different process, audited from an append-only
hash-chained journal, and evaluated — with no n8n, no Supabase and no external
model anywhere in the path.

## completed work

- **`@exattime/awe-control-plane`** (new package, pure, zero dependencies).
  - **Workflow Manifest** `awe.workflow_manifest/v1` — versioned and
    runtime-validated with a **closed key set**, so a typo'd `aproval_policy` is
    refused rather than ignored. `high`/`critical` risk *requires* an approval
    threshold and a named approver role; `promoted` requires `promoted_at` and
    `promoted_by`; a step may not name a tool outside `required_tools`; a
    compensation must name an *earlier* step; an empty allow-list is refused
    rather than read as "any tenant".
  - **Workflow Registry** — the only source of something executable. Five gates:
    registered → version satisfiable → promoted → tenant in scope → dependencies
    resolved. Refusals are data, not exceptions. Named `workflow-registry.mjs`
    because `awe-kernel/src/registry.mjs` is the **suite** registry (see
    `## risks`).
  - **Policy engine** — deny by default. The effective ceiling is the *minimum*
    of the manifest's and the tenant grant's, so no single document can widen
    what another allows. `mode: 'LIVE'` is refused outright.
  - **Run Journal** `awe.run_journal/v1` — append-only and hash-chained, with
    run state **projected on every read, never stored**. There is no state
    setter and a source lint asserts there is none. Seventeen event types with an
    explicit transition table; no event lists a terminal state as a legal
    predecessor, so post-terminal appends are impossible by construction.
  - **Controlled tool invocation** — nine refusals before an adapter is reached.
    Effect identities make a duplicate a *replay of the recorded result* rather
    than a second side effect, and make a conflicting re-use a refusal.
  - **Run engine** — retry, step timeout, run timeout, cancellation at step
    boundaries, pause on approval, resume, and compensation. The only writer to
    a journal.
- **`@exattime/awe-runtime` additions**: the control-plane application service
  (tenant binding is an argument on every run operation, never an inference),
  separate journal and result stores, injected clocks including a virtual
  stepping clock, the synthetic invoice reference workflow, and the operator CLI.
- **Runner P** — 372 offline gates covering all seventeen required verification
  cases plus a layering lint and a source-purity lint over the reference
  adapters. Registered in the suite registry and in the platform reason union as
  the `control_plane` namespace (no vocabulary conflicts; 52 reasons total).
- **Four real defects found by the new tests and fixed** — see `## risks`.

## files changed

Created:

```
packages/awe-control-plane/package.json
packages/awe-control-plane/src/kernel.mjs             single seam onto the kernel
packages/awe-control-plane/src/manifest.mjs           awe.workflow_manifest/v1
packages/awe-control-plane/src/workflow-registry.mjs  registry-backed resolution
packages/awe-control-plane/src/policy.mjs             policy + approval rules
packages/awe-control-plane/src/journal.mjs            awe.run_journal/v1 + projection
packages/awe-control-plane/src/dispatch.mjs           controlled tool boundary
packages/awe-control-plane/src/engine.mjs             the step state machine
packages/awe-control-plane/src/index.mjs
packages/awe-runtime/src/control-plane-service.mjs    the application service
packages/awe-runtime/src/journal-store.mjs            control record (digests)
packages/awe-runtime/src/result-store.mjs             data record (bodies)
packages/awe-runtime/src/clock.mjs                    injected + virtual clocks
packages/awe-runtime/src/reference/invoice-intake.mjs synthetic reference slice
scripts/awe-control-plane.mjs                         operator CLI
scripts/eval-control-plane.mjs, scripts/eval-control-plane.sh   Runner P
docs/architecture/EXECUTION_CONTROL_PLANE.md
```

Modified: `packages/awe-kernel/src/registry.mjs` (one suite descriptor);
`packages/awe-runtime/src/index.mjs` and `package.json` (exports);
`scripts/lib/awe-reasons.mjs` (registers the `control_plane` namespace);
`scripts/eval-kernel.mjs` (the exact-set namespace assertion now expects it).

**No kernel behaviour was changed.** `packages/awe-kernel/src/*.mjs` is untouched
apart from adding one suite descriptor to the registry.

## migrations

None. No SQL file was created, edited or applied. `supabase/` is untouched.

## commands run

```
git status / branch -a / log --oneline
bash scripts/regression.sh --kinds=unit,offline,static   (baseline, before any edit)
node scripts/eval-control-plane.mjs                      (many times, during development)
bash scripts/regression.sh --exclude-kinds=db            (final)
node scripts/awe-control-plane.mjs demo
node scripts/awe-control-plane.mjs start | approve | resume   (three separate processes)
14 deliberate guard-removal perturbations, each reverted
```

## tests passed

`bash scripts/regression.sh --exclude-kinds=db` — **ALL GREEN, 13 ran, 8 skipped.**

| suite | result |
|---|---|
| Runner K (kernel unit) | 557 / 0 |
| Runner C (context primitives) | 138 / 0 |
| mobile typecheck | OK |
| web production build | OK |
| MCP smoke (initialize + tools/list) | OK |
| migration 0014 structural validation | OK |
| Runner 3 (approval diff) | 121 / 0 |
| migration 0015 structural validation | OK |
| Runner 4 (approval matrix + outbound) | 327 / 0 |
| Runner 5 (approval queue) | 349 / 0 |
| Runner M (kernelized MCP surface) | 410 / 0 |
| **Runner P (execution control plane)** | **372 / 0 — new** |
| Runner E (execution outcomes + artifacts) | 376 / 0 |

**Non-vacuity: fourteen guards were removed one at a time, each confirmed to
fail the suite, then restored** — the LIVE-mode refusal; the deny-by-default
grant check; the G4 automation-may-not-approve rule; the approval gate before a
consequential tool; the journal chain link; the per-entry digest; the kernel
event-key check; the projection's transition table; the idempotency-conflict
check; the step-timeout check; the registry's promotion, dependency and
tenant-scope gates; and the cross-tenant run-ownership guard.

Three of those were **initially vacuous** and the tests were strengthened until
they were not — see `## risks`.

## tests failed

None.

**Not run, deliberately:** every `db`-kind suite (acceptance slices 1-5, S1
security, intake eval, classification eval) requires `SUPABASE_ACCESS_TOKEN` and
live project access. No live-credential, n8n, Outlook, OneDrive, service-role or
production-workflow test was executed. No test was skipped, weakened or deleted
to make the build pass.

## live changes

None. No database call, no migration, no n8n change, no workflow publication, no
external API call, no credential used, no push, no PR.

## approvals required

- **ADR-0002 ratification** remains open. The control plane was built to *not*
  depend on it: it grants nothing, touches no database, and refuses `LIVE` mode
  outright (`live_mode_unratified`). Flipping `allow_live` is the single named
  switch that would change that, and it must not be flipped before ratification.
- **Push and PR** for `feat/kernelized-mcp-context` (now nine + four commits).
- The Phase 1 deployment gates in the archived sections below remain open and
  are unaffected by this session.

## risks

- **One architectural conflict, resolved and documented.**
  `awe-kernel/src/registry.mjs` is the **suite** registry. A workflow registry
  under the same name in a sibling package would leave every future reader
  guessing which one an import means, so the new module is
  `workflow-registry.mjs`. Do not create a second `registry.mjs`.
- **Four real defects found by the new tests and fixed:**
  1. **Input and output schemas were conflated**, so a step's precondition was
     validated against the wrong side of the call. They are now separate
     vocabularies; an input schema states which *prior results* a step needs.
  2. **Step results did not survive a pause.** Fixed by splitting the data
     record from the control record — *not* by putting bodies in the journal,
     which would have retired the rule that a control-plane record carries no
     customer data. The suite now asserts the serialized journal contains
     neither the invoice number nor the supplier name.
  3. **`run_timeout_ms` measured elapsed wall time**, so a run paused overnight
     expired. It now bounds *active execution* only. A gate that punished an
     operator for taking the afternoon to decide would train people to approve
     quickly — the opposite of what an approval gate is for.
  4. **Tampered journal documents were caught by the outer digest before the
     per-entry checks ever ran**, which made three of four integrity checks
     vacuous. Documents are now resealed before each tamper test, and each check
     has a case only it catches: a transplanted entry (chain), a backdated
     `occurred_at` (per-entry digest), and a fully re-chained forgery (kernel
     event key). The fourth — sequence density — is genuinely redundant given
     genesis + chain, and the suite says so explicitly rather than counting it
     as coverage.
- **Known limitations, all documented in
  `docs/architecture/EXECUTION_CONTROL_PLANE.md`:** nothing is durable beyond
  the local filesystem; steps are a sequential list, not a graph (no branching,
  fan-out or loops); `approval_policy.quorum` is validated and reported but the
  engine proceeds on the first valid approval, so a quorum above 1 is currently
  a statement rather than a gate; ADR-0003's lease/claim is not wired in, so two
  processes resuming the same run concurrently would both proceed;
  `compensation_failed`, `journal_corrupted` and `manifest_invalid` have no
  end-to-end fixture; there is no HTTP surface.
- **The reference ledger is process-local by design.** What survives a process
  boundary is the journal and the result store, which is the honest model.

## blockers

None for continued local development.

Unchanged from previous sessions: ADR-0002 is unratified; the repository and
live Supabase migration histories still disagree; the C2 allow-list
contradiction is unresolved. None of these blocks the control plane, because it
reaches no database.

## exact next prompt

Continue AWE on branch `feat/kernelized-mcp-context`. Read
`docs/architecture/EXECUTION_CONTROL_PLANE.md` and
`docs/planning/AGENT_HANDOFF.md` first, then verify the baseline with
`bash scripts/regression.sh --exclude-kinds=db` (expect ALL GREEN, 13 ran, 8
skipped) before editing anything.

Deliver one vertical slice: **make the execution control plane durable and
concurrency-safe, and put a real surface on it.**

1. **Lease and claim (ADR-0003).** Add `claimed_by` / `lease_expires_at` /
   `expire_leases()` semantics to the run journal and the control-plane service,
   so two processes cannot advance the same run concurrently. Today they both
   would. Cover: claim, contended claim, expiry, resume-after-crash, and a
   double-resume race — all deterministic, using the injected clock.
2. **Enforce `approval_policy.quorum`.** It is validated and reported but not
   enforced; the engine proceeds on the first valid approval. Add multi-approver
   accumulation, distinct-principal enforcement (one person may not satisfy a
   quorum of two), and a denial that overrides accumulated approvals.
3. **Put the control plane on the MCP surface.** `packages/mcp-server` already
   runs on the kernel via `packages/awe-runtime`. Add tools for
   `list_workflows`, `start_workflow_run`, `get_run`, and `decide_approval`,
   reusing the existing tenant resolution and the neutral tool descriptors.
   Extend Runner M rather than creating a parallel suite.
4. Keep every guarantee: deny by default, LIVE refused, G4 (automation approves
   nothing), tenant binding as an argument, append-only history, and the
   two-store split (the journal carries digests, never bodies).

Constraints: do not ratify or act on ADR-0002; do not enable `allow_live`; do
not touch `supabase/`, n8n, or any external service; use synthetic data only; do
not push or open a PR. Run `bash scripts/regression.sh --exclude-kinds=db` and
`bash scripts/eval-control-plane.sh` and report exact results. For every new
guard, delete it once, confirm the suite fails, and restore it — a guard that
can be removed with the suite still green is not covered.

## archived — kernelized MCP surface and context primitives (2026-07-27, Claude)

### updated_at

2026-07-27T19:10:00Z

### agent

Claude (Claude Code, Opus 5)

### repository

jaqboredasf-gif/Autonomous-Workflow-Engine

### branch

`feat/kernelized-mcp-context`, created from `chore/agent-handoff-integration` at
`e12eac2`. Nothing was pushed. No existing branch was moved, reset, merged,
rebased or deleted.

**Branch relationship, established before any write:**

- `chore/agent-handoff-integration` = `security/c1-policy-cleanup` (`3e617f2`)
  plus five agent-handoff docs commits.
- `chore/agent-handoff-clean` carries equivalent handoff docs (different hashes)
  plus two more, and is merged into `main`.
- The two are **not** duplicates. The integration branch uniquely carries the
  C1/S1 security work — `docs/SECURITY_FINDINGS.md`,
  `scripts/acceptance-s1-security.sh`, the S1 rehearsal/rollback SQL, and
  migration `0016_drop_undeclared_client_policies.sql` — none of which exist on
  `clean` or on `main`. The previous session's note that this branch was
  "superseded" is incorrect, and acting on it would have discarded that work.

### commit

Nine commits on `feat/kernelized-mcp-context`, none pushed:

| commit | scope |
|---|---|
| `6270ee3` | preservation: `@exattime/awe-kernel` + registry-driven regression |
| `45345be` | preservation: standardized outcomes + durable run-report artifacts |
| `240e745` | preservation: Runners 3/4/5 migrated onto the kernel gate run |
| `f896808` | preservation: H0 doctrine/contracts/guardrails + ADRs 0001-0009 |
| `6c72acb` | preservation: planning docs |
| `a95825b` | new: context assembly, compaction, checkpoints, tool descriptors |
| `f4b7835` | new: `@exattime/awe-runtime` platform service layer |
| `33cc32c` | new: MCP server on the shared execution kernel |
| _(this one)_ | new: planning and architecture docs for the above |

Commits 1-5 preserve the previous session's uncommitted tree, which was at real
risk: the kernel, the H0 doc set and the runner migrations were entirely
untracked.

### current objective

Completed **Kernelized MCP Execution and Context Primitive Foundation**. MCP is
now the first external execution surface fully powered by the AWE kernel, and
the provider-neutral context assembly and compaction subsystem exists as working
code with an offline suite.

### completed work

- **Preserved** the previous session's uncommitted execution-kernel milestone in
  five reviewable commits on a new branch, after establishing that the branch it
  sat on is not superseded.
- **MCP on the kernel.** All ten tools execute through `runWorkflow`: explicit
  execution context, shared gates, standardized outcome envelope, sanitized
  audit events, durable run report, explicit final state. Tool bodies contain
  business logic only.
- **Removed implicit tenant selection.** `from('orgs').select('id').limit(1)` is
  gone. A tenant is stated (call argument or `AWE_ORG_ID`), never discovered.
  Every data-port method requires `org_id` and refuses without it; every read
  filters it, every write sets it, and the written row's tenant is asserted
  afterwards.
- **Context primitives.** Context Item, Execution Context Bundle, provider
  interface, and deterministic assembly with complete exclusion accounting.
- **Deterministic compaction.** Six model-independent mechanisms with a full
  ledger, no sensitivity declassification, no trust promotion, no growth, and
  byte-identical reproducibility. A `summarizer` hook admits a future
  model-assisted compactor without making one mandatory.
- **Context checkpoints.** `awe.context_checkpoint/v1`, tenant- and
  workflow-bound, refusing a cross-tenant restore.
- **Neutral Tool Registry boundary.** Descriptor, catalog, side-effect
  classification, lifecycle. No authorization field exists, and Runner M asserts
  their absence mechanically.
- **App-server-ready service layer** (`@exattime/awe-runtime`): submit, inspect,
  artifact, audit, assemble, compact, checkpoint, resume. No HTTP, no framework.
- **Two real leaks found by the new tests and fixed** (see `risks`).

### files changed

Created:

```
packages/awe-kernel/src/context-item.mjs   Context Item, token estimate, ordering
packages/awe-kernel/src/assembly.mjs       bundle assembly, exclusions, providers, rendering
packages/awe-kernel/src/compaction.mjs     deterministic compaction + checkpoints
packages/awe-kernel/src/tools.mjs          neutral tool descriptor + catalog
packages/awe-runtime/package.json          new workspace package
packages/awe-runtime/src/index.mjs
packages/awe-runtime/src/service.mjs       the platform service
packages/awe-runtime/src/file-sinks.mjs    moved from scripts/lib/artifact-store.mjs
packages/mcp-server/src/data-port.mjs      org-scoped data boundary (supabase + fixture)
packages/mcp-server/src/tenant.mjs         explicit tenant + mode resolution
packages/mcp-server/src/tools.mjs          ten descriptors + kernel-outcome bodies
packages/mcp-server/src/runtime.mjs        executeTool, context provider, response mapping
packages/mcp-server/src/fixtures.mjs       deterministic two-tenant corpus
scripts/eval-context.mjs, scripts/eval-context.sh   Runner C
scripts/eval-mcp.mjs, scripts/eval-mcp.sh           Runner M
```

Modified: `packages/awe-kernel/src/execute.mjs`, `events.mjs`, `sinks.mjs`,
`index.mjs`, `registry.mjs`; `packages/awe-kernel/package.json`;
`packages/mcp-server/src/index.js` (wiring only);
`scripts/lib/artifact-store.mjs` (now a re-export);
`scripts/lib/awe-reasons.mjs`; `scripts/eval-kernel.mjs`; `scripts/smoke-mcp.sh`.

### migrations

None. No SQL file was created, edited or applied. `supabase/` is untouched.

### commands run

```
git status / branch -vv / log --graph --all / merge-base / diff --stat
bash scripts/regression.sh --kinds=unit,offline,static   (baseline, before any edit)
bash scripts/eval-context.sh
bash scripts/eval-mcp.sh
bash scripts/eval-kernel.sh
bash scripts/smoke-mcp.sh
bash scripts/regression.sh --exclude-kinds=db
seven non-vacuity perturbations, each reverted
```

### tests passed

`bash scripts/regression.sh --exclude-kinds=db` — **ALL GREEN, 12 ran, 8 skipped.**

| suite | result |
|---|---|
| Runner K (kernel unit) | 553 / 0 |
| Runner C (context primitives) | 138 / 0 — new |
| mobile typecheck | OK |
| web production build | OK |
| MCP smoke (initialize + tools/list) | OK (10 tools) — **was FAIL (tools=0)** |
| migration 0014 structural validation | OK |
| Runner 3 (approval diff) | 121 / 0 |
| migration 0015 structural validation | OK |
| Runner 4 (approval matrix + outbound) | 327 / 0 |
| Runner 5 (approval queue) | 349 / 0 |
| Runner M (kernelized MCP surface) | 410 / 0 — new |
| Runner E (execution outcomes + artifacts) | 376 / 0 |

Non-vacuity: seven deliberate perturbations were each confirmed to fail the
suite and then reverted — implicit tenant fallback restored; data port stops
filtering by tenant; response stops redacting provider error text; compaction
declassifies a summary; assembly drops over-budget items silently; cross-tenant
context filtered instead of refused; checkpoint restores into any tenant. The
seventh initially passed with the guard deleted — the assembler's own per-item
check was masking it — so the test was strengthened to pin that specific guard
before the perturbation fired.

### tests failed

None.

**Not run, deliberately:** every `db`-kind suite (acceptance slices 1-5, S1
security, intake eval, classification eval) requires `SUPABASE_ACCESS_TOKEN` and
live project access. No live-credential, n8n, Outlook, OneDrive, service-role or
production-workflow test was executed. No test was skipped, weakened or deleted
to make the build pass.

### live changes

None. No database call, no migration, no n8n change, no workflow publication, no
external API call, no credential used, no push.

### approvals required

- **ADR-0002 ratification** (harness database access path). Until it is
  `Accepted`, no capability model, tool permission, tenant authorization policy,
  approval threshold or production-enablement policy may be implemented. Neutral
  boundaries exist and are asserted to be empty of those decisions.
- **Push and PR** for `feat/kernelized-mcp-context`.
- The Phase 1 deployment gates in the archived section below remain open and are
  unaffected by this session.

### risks

- **Two real leaks were found by the new tests and fixed in this session.**
  (1) An MCP failure message could carry a provider's raw error — including a
  connection string, a bearer token or a `password=` value — into the tool
  response. Now redacted and bounded. (2) A fixture row id built by
  interpolating the caller's text carried a customer name into audit events and
  gate decisions; ids are now content-addressed. The kernel's redaction was also
  extended to scrub assigned secrets inside free text, not only
  credential-shaped object keys.
- **MCP TEST mode now serves fixture data instead of exiting at startup.**
  Strictly safer — the process holds no credential in TEST — but it is a
  behaviour change: an operator who relied on the server dying without
  credentials now gets a server that runs. Mitigated by a loud stderr banner and
  by `mode` and `is_fixture` on every response.
- The service role still bypasses RLS, so MCP tenant safety is **code-enforced**
  (ADR-0002, knowing acceptance, guardrail G1). It is now enforced at four
  layers — entry gate, data port, query filter, post-write assertion — and every
  one has a refusal test.
- Run artifacts are written to a gitignored local directory. That is the first
  backend, not the permanent one.

### blockers

1. **ADR-0002 is unratified.** Blocks the Tool Registry's authorization model,
   the capability system, tenant authorization policy and approval thresholds.
   Nothing in this session assumed an outcome.
2. **Phase 1 deployment remains blocked**, carried forward unchanged and
   untouched by this session: repository migration history and live migration
   history disagree; the C2 allow-list/documentation contradiction, unproven RPC
   compatibility, incomplete Auth/control-plane inventory, and unverified C4
   coordinated rollout are all still open. Do not deploy Phase 1. Full detail is
   preserved in the archived section below.
3. `feat/kernelized-mcp-context` is based on `chore/agent-handoff-integration`,
   which is **not** in `main`. Landing this work also lands the C1/S1 security
   commit. That is a sequencing decision for the operator, not a defect.

### exact next prompt

Implement the LIVE-path proof for the kernelized MCP surface. Runner M covers
the tenant, outcome, audit, artifact and context behaviour offline against the
fixture data port; nothing yet proves the Supabase data port itself. Add a
credential-gated smoke suite (registry kind `db`, declaring `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` and `AWE_ORG_ID`) that runs each read tool against a
live project bound to one tenant and asserts every returned row carries that
`org_id`, plus one cross-tenant negative case proving a second tenant's rows are
unreachable. Do not run it without explicit approval, do not add it to the
default regression path, and do not use the `sbp_` management token. Do not
implement any capability, permission or approval behaviour — ADR-0002 is still
unratified.

## archived — Phase 1 deployment readiness review (2026-07-27, Codex)

Preserved verbatim, headings demoted one level. **Its blockers are still
active**; this session neither addressed nor invalidated them. It was a
read-only review of `chore/agent-handoff-integration` and PR #3, and it made no
change to the repository.


### updated_at

2026-07-27T18:30:00Z

### agent

Codex

### repository

jaqboredasf-gif/Autonomous-Workflow-Engine

### branch

`chore/agent-handoff-integration` (read-only deployment review performed from
the existing worktree; PR #3 was inspected at immutable head
`30d222d00b1ac48121bd52a1ff67dcdf07aa5cde`).

### commit

No commit created. The user explicitly prohibited commits, pushes, merges, and
code changes.

### current objective

Completed a read-only Phase 1 deployment-readiness review. Do not deploy Phase
1. Repository declarations, migration history, and live state disagree, so the
mandatory repository stop condition is active.

### completed work

- Read every requested repository planning/security source, all four Phase 1
  migrations, the migration chain, and the validation harnesses.
- Reviewed draft PR #3 at its immutable head as a deployment artifact.
- Inventoried live RLS, policies, roles, grants, RPCs, triggers, indexes,
  constraints, extensions, schemas, migration history, and aggregate tenant
  integrity using read-only queries.
- Compared repository assumptions to documented and freshly queried live state.
- Produced the migration-by-migration deployment matrix, verification SQL,
  rollback checkpoints, risks, confidence scores, approval gates, and next
  prompt in this handoff.

### pull request

- Draft PR #3: https://github.com/jaqboredasf-gif/Autonomous-Workflow-Engine/pull/3
- Base: `main` at `dbf8f1755f1afefa8f7e44caa6c59bdf7e2863b1`
- Head: `security/phase-1-remediation` at
  `30d222d00b1ac48121bd52a1ff67dcdf07aa5cde`
- State: open draft, mergeable, two validation checks passed.
- Deployment review result: not deployable; passing checks are repository-only
  and do not prove live compatibility.

### deployment readiness review

Deployment readiness score: **38/100**.

The linked live project is `qgoiacwdntaqeghcyjlw`; the repository project ref,
hard-coded validation targets, and documented integration target all agree.
There is also a second active project named `AWE`
(`mzlzbnnikwblqirjyqap`), so the target must be restated at approval time.

Live evidence that matches repository assumptions:

- PostgreSQL is 17 and the required `public`, `auth`, `storage`, `extensions`,
  and `graphql_public` schemas exist.
- Required roles exist; `service_role` has `BYPASSRLS`; `anon` and
  `authenticated` do not.
- All 24 live `public` tables have RLS enabled.
- The exact 16 C1 live-only policies still exist on `integration_events`,
  `time_entry_audits`, `crews`, and `crew_members`.
- The five C3 predecessor time-entry policies exist with the expected names.
- All C3 prerequisite tables, types, functions, foreign keys, and primary keys
  exist.
- Tenant aggregate checks found 1 org, 2 users, 0 crews, 0 crew members, and 42
  time entries, with zero cross-tenant user, creator, job-site, or cost-code
  references and zero invalid crew assignments.
- None of the three C3 validation triggers or the C4 assertion RPC exists yet,
  as expected before Phase 1.

Blocking disagreements and unknowns:

- Supabase's migration-list API returns zero migrations and the live database
  has no `supabase_migrations` schema, although repository migrations 0001-0015
  are materially present in the schema. This is migration drift/manual-SQL
  evidence and activates the mandatory stop condition.
- PR #3 documentation says C2 restores only two browser RPCs, but the migration
  directly grants four mutation/helper RPCs to `authenticated`:
  `business_role_matches`, `record_approval`,
  `apply_timecard_correction`, and `mark_message_sent`. The intended contract
  is internally inconsistent.
- C2 revokes execution from every public function. Live inventory shows broad
  `PUBLIC` execution plus direct `anon`/`authenticated` grants on many helper
  and trigger functions. No authenticated client-call inventory proves that
  removing `check_territory`, `route_outbound`, or other direct RPC access is
  compatible.
- C2's `ALTER DEFAULT PRIVILEGES` is owner-specific. The effective migration
  execution role and existing `pg_default_acl` must be proven before relying on
  the future-function fail-closed claim.
- Several live security-definer RPCs do not pin a safe `search_path`, including
  `business_role_matches`, `record_approval`, `mark_message_sent`, and
  `create_outbound_draft`. Phase 1 does not repair that existing risk.
- The C3 crew policy joins need indexes on `crews(foreman_id)` and
  `crew_members(user_id)` for predictable RLS performance; neither exists.
- C3 triggers validate only new/changed rows. Current aggregate data is clean,
  but a final pre-apply check must be performed in the same maintenance window.
- Empty crew tables mean foreman crew operations will be denied until legitimate
  assignments are provisioned. This is fail-closed but operationally breaking.
- C4 requires a coordinated database/server release and a verified
  deployment-secret `MCP_ORG_ID`; neither runtime configuration nor rollout
  mechanism was verified.
- Live Auth server configuration (site URL, redirect allow-list, JWT lifetime,
  anonymous sign-in, enabled providers, SMTP, CAPTCHA, MFA) is control-plane
  state and cannot be completely proven with PostgreSQL `SELECT` statements.
- Table/sequence grants, storage bucket configuration, PostgREST exposed-schema
  configuration, database advisors, backups/PITR, and rollback scripts require
  explicit review before approval.

### migration deployment matrix

### C1 — remove undeclared policies

- Prerequisites: four tables exist, RLS is enabled, and exactly the named 16
  policies are the only policies on those tables.
- Expected before-state: verified live; 16 named authenticated policies exist.
- Expected after-state: zero policies on the four tables and RLS enabled on all
  four.
- Rollback: recreating policies restores the vulnerability; emergency-only.
- Failure conditions: table missing, unexpected extra policy, RLS disabled, or
  insufficient policy ownership.
- Data-loss risk: no row writes; policy metadata only.
- Tenant-isolation risk: low on successful apply; high if rolled back.
- Confidence: 85/100, conditional on same-window recheck.

### C2 — restrict privileged RPCs

- Prerequisites: every referenced function signature/type exists; complete
  client RPC dependency inventory; migration role/default ACL identified.
- Expected before-state: verified broad `PUBLIC` and direct client execution.
- Expected after-state: only the explicit allow-list is client executable and
  service-role execution remains.
- Rollback: restore only proven required function grants, never blanket
  `PUBLIC`.
- Failure conditions: missing/modified signature, undocumented client caller,
  overloaded routine, owner mismatch, default-ACL mismatch, or a grant not
  visible through the migration's whitelist query.
- Data-loss risk: none directly; application outage/blocked workflows possible.
- Tenant-isolation risk: improves on success; remains high through unpinned
  security-definer search paths.
- Confidence: 35/100.

### C3 — bind time and crew authorization

- Prerequisites: predecessor policies/functions/types/tables exist; all existing
  tenant-reference aggregate checks return zero; legitimate crew data and
  client behavior are understood.
- Expected before-state: verified five broad predecessor policies, no three
  validation triggers, clean aggregate data, and empty crews.
- Expected after-state: three enabled tenant-validation triggers; three
  time-entry policies; two crew policies; two crew-member policies; client
  execution revoked on trigger functions.
- Rollback: dropping guards and restoring broad policies reopens cross-crew and
  cross-tenant authorization risks; emergency-only.
- Failure conditions: invalid existing workflow, modified enum/signature,
  policy-name drift, missing table/function privilege, trigger interaction, or
  RLS query-plan regression.
- Data-loss risk: no direct row changes; legitimate writes may be rejected.
- Tenant-isolation risk: materially improves, but performance and runtime
  behavior remain unproven.
- Confidence: 60/100.

### C4 — MCP tenant contract

- Prerequisites: `public.orgs` exists; C2 applied first; service-role grant
  works; database and MCP server deploy atomically; valid `MCP_ORG_ID` is
  provisioned outside Git.
- Expected before-state: verified assertion RPC absent; one live org exists.
- Expected after-state: assertion RPC exists, is security-definer with fixed
  search path, and is executable only by service role; MCP startup fails closed
  for missing/unknown tenant.
- Rollback: database RPC and server must roll back together; mixed versions
  intentionally fail startup.
- Failure conditions: missing/wrong tenant ID, grant drift, stale API schema
  cache, database/server version skew, or unscoped code path outside wrapper.
- Data-loss risk: no direct database row change; service outage possible.
- Tenant-isolation risk: high until runtime integration is proven, low after
  complete coordinated verification.
- Confidence: 45/100.

Recommended deployment order remains C1 → C2 → C3 → C4, but only after migration
history reconciliation. Checkpoints: capture catalogs before C1; verify zero C1
policies; verify exact C2 ACL allow-list and browser workflows; verify C3
triggers/policies and tenant scenarios; deploy C4 database/server together and
verify startup binding. Stop and restore the last known-safe application
version at any failed checkpoint; do not use vulnerable policy recreation as a
routine rollback.

### exact verification commands

Run against the explicitly confirmed production ref
`qgoiacwdntaqeghcyjlw`. Every statement below is read-only.

```sql
SELECT current_database(), current_user, session_user, version();

SELECT n.nspname AS schema_name, pg_get_userbyid(n.nspowner) AS owner
FROM pg_namespace n
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
ORDER BY n.nspname;

SELECT e.extname, e.extversion, n.nspname AS schema_name
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY e.extname;

SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
       rolreplication, rolbypassrls
FROM pg_roles
WHERE rolname IN ('postgres','anon','authenticated','service_role',
                  'authenticator','supabase_auth_admin',
                  'supabase_storage_admin')
ORDER BY rolname;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','storage')
ORDER BY n.nspname, c.relname;

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual,
       with_check
FROM pg_policies
WHERE schemaname IN ('public','storage')
ORDER BY schemaname, tablename, policyname;

SELECT table_schema, table_name, grantee, privilege_type, is_grantable
FROM information_schema.table_privileges
WHERE table_schema IN ('public','storage')
  AND grantee IN ('PUBLIC','anon','authenticated','service_role')
ORDER BY table_schema, table_name, grantee, privilege_type;

SELECT object_schema, object_name, column_name, grantee, privilege_type,
       is_grantable
FROM information_schema.column_privileges
WHERE object_schema IN ('public','storage')
  AND grantee IN ('PUBLIC','anon','authenticated','service_role')
ORDER BY object_schema, object_name, column_name, grantee, privilege_type;

SELECT sequence_schema, sequence_name, grantee, privilege_type
FROM information_schema.usage_privileges
WHERE object_type = 'SEQUENCE'
  AND sequence_schema = 'public'
  AND grantee IN ('PUBLIC','anon','authenticated','service_role')
ORDER BY sequence_name, grantee, privilege_type;

SELECT n.nspname AS schema_name, p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       p.prosecdef AS security_definer, p.provolatile AS volatility,
       pg_get_userbyid(p.proowner) AS owner, p.proconfig,
       pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.proname, identity_arguments;

SELECT routine_name, specific_name, grantee, privilege_type, is_grantable
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND grantee IN ('PUBLIC','anon','authenticated','service_role')
ORDER BY routine_name, specific_name, grantee;

SELECT defaclrole::regrole AS owner, n.nspname AS schema_name,
       defaclobjtype, defaclacl
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
ORDER BY owner::text, schema_name, defaclobjtype;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       t.tgname AS trigger_name, t.tgenabled,
       pg_get_triggerdef(t.oid, true) AS definition,
       pn.nspname AS function_schema, p.proname AS function_name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
JOIN pg_namespace pn ON pn.oid = p.pronamespace
WHERE NOT t.tgisinternal AND n.nspname = 'public'
ORDER BY c.relname, t.tgname;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       i.relname AS index_name, ix.indisunique, ix.indisprimary,
       ix.indisvalid, ix.indisready, pg_get_indexdef(i.oid) AS definition
FROM pg_index ix
JOIN pg_class c ON c.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
ORDER BY c.relname, i.relname;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       con.conname AS constraint_name, con.contype AS constraint_type,
       con.convalidated, pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
ORDER BY c.relname, con.conname;

SELECT to_regnamespace('supabase_migrations') AS migration_schema,
       to_regclass('supabase_migrations.schema_migrations')
         AS migration_table;

SELECT version, name
FROM supabase_migrations.schema_migrations
ORDER BY version;

SELECT
  (SELECT count(*) FROM public.orgs) AS org_count,
  (SELECT count(*) FROM public.users) AS user_count,
  (SELECT count(*) FROM public.crews) AS crew_count,
  (SELECT count(*) FROM public.crew_members) AS crew_member_count,
  (SELECT count(*) FROM public.time_entries) AS time_entry_count,
  (SELECT count(*) FROM public.time_entries te
     JOIN public.users u ON u.id=te.user_id
    WHERE u.org_id IS DISTINCT FROM te.org_id) AS bad_entry_user_tenant,
  (SELECT count(*) FROM public.time_entries te
     JOIN public.users u ON u.id=te.created_by
    WHERE u.org_id IS DISTINCT FROM te.org_id) AS bad_entry_creator_tenant,
  (SELECT count(*) FROM public.time_entries te
     JOIN public.job_sites j ON j.id=te.job_site_id
    WHERE j.org_id IS DISTINCT FROM te.org_id) AS bad_entry_site_tenant,
  (SELECT count(*) FROM public.time_entries te
     JOIN public.cost_codes cc ON cc.id=te.cost_code_id
    WHERE cc.org_id IS DISTINCT FROM te.org_id) AS bad_entry_cost_tenant,
  (SELECT count(*) FROM public.crews c
     JOIN public.users u ON u.id=c.foreman_id
    WHERE u.org_id IS DISTINCT FROM c.org_id
       OR u.role::text <> 'foreman' OR NOT u.is_active) AS bad_foremen,
  (SELECT count(*) FROM public.crew_members cm
     JOIN public.crews c ON c.id=cm.crew_id
     JOIN public.users u ON u.id=cm.user_id
    WHERE u.org_id IS DISTINCT FROM c.org_id
       OR NOT u.is_active) AS bad_crew_members;

SELECT i.provider, count(*) AS identity_count
FROM auth.identities i
GROUP BY i.provider
ORDER BY i.provider;

SELECT count(*) AS auth_users,
       count(*) FILTER (WHERE is_anonymous) AS anonymous_users,
       count(*) FILTER (WHERE banned_until > now()) AS currently_banned_users
FROM auth.users;
```

The `SELECT version, name ...` statement is expected to fail while the
`supabase_migrations` schema/table remains absent; that failure is itself the
blocking evidence. Auth control-plane settings must additionally be exported
read-only from the Supabase dashboard/API because SQL cannot fully inventory
them.

### approval gates

1. Confirm the exact production project ref is `qgoiacwdntaqeghcyjlw`, not the
   second project named `AWE`.
2. Reconcile how repository migrations 0001-0015 reached live while
   `supabase_migrations` is absent. Do not fabricate or backfill history without
   a separately reviewed recovery plan and explicit approval.
3. Resolve the C2 allow-list contradiction and produce a proven client RPC
   call-site inventory.
4. Prove the migration execution role and default ACL behavior.
5. Review/fix or explicitly accept unsafe search paths on security-definer RPCs.
6. Verify all SQL above again in the deployment window; every tenant mismatch
   count must be zero and every catalog diff must be explained.
7. Export and review Auth/Data API control-plane configuration read-only.
8. Add a reviewed rollback artifact per migration and verify backup/PITR
   availability; do not use vulnerable policy recreation as normal rollback.
9. Run pre-deployment application regression and authenticated role scenarios
   in an isolated non-production clone/branch under separate authorization.
10. Obtain explicit approval for PR merge, migration execution, and coordinated
    C4 server rollout. These are three distinct approvals.

### files changed

- `docs/planning/AGENT_HANDOFF.md` only.

All pre-existing modified and untracked user files were preserved.

### migrations

No migration was created, modified, applied, rehearsed, or rolled back.

### commands run

- Read-only local file and Git status inspection.
- Read-only GitHub PR #3 metadata, immutable file-content, and diff inspection.
- Supabase project listing.
- Supabase migration listing.
- Live `SELECT` catalog and aggregate tenant-integrity queries only.
- Official Supabase documentation/changelog lookup.

### tests passed

- Live target correlation to repository project ref.
- C1 exact policy-name and RLS prerequisite verification.
- C3 schema prerequisite and aggregate tenant-integrity verification.
- PR #3 remains draft and its existing GitHub validation checks pass.

### tests failed

- Migration-history reconciliation: live history is empty/absent while the
  schema materially reflects repository migrations.
- Deployment-readiness review: failed closed.

### live changes

None. Supabase was queried read-only. GitHub was queried read-only. No code,
migration, Git ref, PR state, or external service was modified.

### approvals required

All gates in `approval gates` above. No deployment approval should be issued
until migration history is reconciled and C2's contract is made internally
consistent.

### risks

See `deployment readiness review` and `migration deployment matrix`.

### blockers

Primary blocker: repository migration history and live migration history
disagree. Secondary blockers: C2 allow-list/documentation contradiction,
unproven RPC compatibility, incomplete Auth/control-plane inventory, and
unverified C4 coordinated rollout.

### exact next prompt

Perform a read-only migration-history forensics task for Supabase project
`qgoiacwdntaqeghcyjlw`. Determine exactly how repository migrations 0001-0015
reached the live schema despite the absent `supabase_migrations` history.
Compare immutable repository SQL to live object definitions and produce a
non-mutating reconciliation plan. Also resolve the PR #3 C2 RPC allow-list
contradiction with a complete application call-site inventory. Do not modify
code or documentation, do not commit/push/merge, do not apply or repair
migration history, and do not modify Supabase.
