# Agent Handoff

## Current session — Memory Layer

### updated_at

2026-07-28T14:11:06Z

### agent / branch

Codex on `codex/memory-layer`, based on the completed Agent Runtime tip
`bfcb679` (`codex/agent-runtime`). This is one isolated major task. The original
checkout at `/Users/jackdaly/Autonomous-Workflow-Engine` was left on
`feat/kernelized-mcp-context`; its unrelated uncommitted control-plane work was
not touched.

### objective and outcome

Completed the **AWE Memory Layer**, the recommended subsystem after the Agent
Runtime. The new `@exattime/awe-memory` package supplies:

- versioned, closed, self-authenticating memory manifests;
- exact tenant scope, lifecycle, Context Item labels, write policy, retention
  policy, and provider-neutral retrieval profiles;
- immutable versioned records with content digests, provenance, sensitivity,
  expiry, predecessor binding, and optimistic compare-and-swap;
- proposal-first writes with no automatic mode and human authorizations bound
  to proposal digest, tenant, principal, role, and approval instant;
- a storage-neutral record-store contract plus an in-memory reference store;
- storage-neutral lexical/vector retrieval adapters with validated hit refs,
  scores, uniqueness, deterministic ordering, limits, and score floors;
- self-contained tenant-bound retrieval snapshots that replay exact Context
  Items without querying a retrieval adapter or record store;
- explicit expiry including legal-hold semantics;
- a transport-free `createMemoryService()` composition in `@exattime/awe-runtime`.

Memory reads become ordinary kernel Context Items. Memory writes were exercised
through the existing controlled tool dispatcher: the write adapter is
unreachable before the existing approval engine validates a human decision.

Full design: `docs/architecture/MEMORY_LAYER.md`.

### files created

```
packages/awe-memory/package.json
packages/awe-memory/src/kernel.mjs
packages/awe-memory/src/manifest.mjs
packages/awe-memory/src/memory-registry.mjs
packages/awe-memory/src/record.mjs
packages/awe-memory/src/store.mjs
packages/awe-memory/src/retrieval.mjs
packages/awe-memory/src/layer.mjs
packages/awe-memory/src/index.mjs
packages/awe-runtime/src/memory-service.mjs
scripts/eval-memory.mjs
scripts/eval-memory.sh
docs/architecture/MEMORY_LAYER.md
```

### files modified

```
README.md
packages/awe-kernel/src/registry.mjs
packages/awe-runtime/package.json
packages/awe-runtime/src/index.mjs
scripts/eval-kernel.mjs
scripts/lib/awe-reasons.mjs
docs/planning/AGENT_HANDOFF.md
```

### verification

- Runner Y: **91 passed, 0 failed**, 9 fixture compositions.
- Runner K: **577 passed, 0 failed**.
- Runner A: **127 passed, 0 failed**, 16 fixtures, 15/15 agent events.
- Credential-free registered regression:
  `bash scripts/regression.sh --kinds=unit,offline,static` —
  **ALL GREEN, 12 ran, 12 skipped**.
- Web production build: compiler, TypeScript, prerender, and all 15 routes
  passed when run separately with the existing local build environment.
- Every new/modified JavaScript module passes `node --check`.
- `git diff --check` passes.

Seven non-vacuity perturbations were each confirmed to fail Runner Y and then
restored: tenant-scope resolution, missing authorization, approver-role
enforcement, collection-scoped expiry, unknown retrieval references, snapshot
digest verification, and the retention TTL ceiling. The unknown-reference
test was initially masked by a downstream record-contract check; it was
strengthened to pin the adapter boundary, then the perturbation failed.

The first `--exclude-kinds=db` attempt failed four environment-only checks
because this isolated worktree had no dependency tree. Reusing the already
installed dependency versions reduced that to the web build, whose first
attempt could not fetch public Google Fonts and whose second lacked the
original checkout's local build environment. The web build then passed
separately. A request to propagate that real app environment across the entire
regression was rejected as broader than this synthetic task, so it was not
retried; the credential-free registered plan above is the authoritative
combined result.

No DB suite or LIVE MCP suite was run.

### defects found and fixed

1. Collection expiry initially filtered by tenant but not by `memory_id`, so
   expiring one collection could retire another collection for the same tenant.
   Expiry is now tenant- and collection-bound, with a dedicated regression.
2. A storage adapter could return a valid record for the wrong tenant or memory
   unless each result was revalidated. The adapter wrapper now checks every
   read, latest, list, and successful write result against the request identity
   and rejects expired list output.
3. Secret-shaped retrieval query text would have been stored verbatim in a
   replay snapshot. Queries are now redacted before digesting and persistence.
4. An evidence metadata field named `write_authorization_digest` triggered the
   kernel's secret-key redactor and collapsed to `[redacted]`. It is now the
   accurately named, non-secret `approval_evidence_digest`.

### migrations and live state

None. No SQL file was created, edited, or applied. `supabase/` is untouched.
No model provider, vector provider, application API, database query, production
configuration, workflow publication, or deployment occurred. The web build
fetched its configured public Google Fonts; no application data was read or
written.

The previously documented repository/live migration disagreement remains
unresolved. A durable RLS-backed memory adapter must not be implemented or
deployed until repository history, live history, and the applicable ADRs agree.

### publication status

Implementation commit `535e246` (`feat: add tenant-bound memory layer`) is
pushed on `codex/memory-layer`. Draft PR
[#6](https://github.com/jaqboredasf-gif/Autonomous-Workflow-Engine/pull/6)
targets `codex/agent-runtime`; GitHub reports it open, draft, and mergeable.
The review diff therefore contains only the Memory Layer milestone. One handoff
validation check was green and the second was queued when this status was
recorded.

### remaining technical debt

- Durable encrypted/RLS-backed record and retrieval-snapshot storage.
- Distributed transactions/leases around optimistic record commits.
- A scheduler for expiry and retention evidence.
- Production lexical/vector index adapters, embedding generation, hybrid
  search, reranking, and provider failover.
- Memory consolidation, contradiction detection, compaction, and
  cross-collection query planning.
- A surface-specific authenticated approval-to-authorization mapper; the core
  consumes validated evidence but does not authenticate identities.

### compact next-session handoff

Start from `codex/memory-layer`. Read
`docs/architecture/MEMORY_LAYER.md`, then run `bash scripts/eval-memory.sh`.
Keep database/vector SDKs outside `packages/awe-memory`; implement them only as
injected store/retrieval adapters. Do not add an automatic memory-write mode.
The next useful vertical slice is a memory-enabled agent reference composition
that retrieves a snapshot before the bounded loop and maps an authenticated
approval handoff into a write authorization without allowing model-supplied
approval evidence.

---

## Current session — Agent Runtime

### updated_at

2026-07-28T13:24:16Z

### agent / branch

Codex (Platform Architect) on `codex/agent-runtime`, based on the completed
`codex/live-mcp-data-boundary` tip `cf37090`. This is one isolated major task.

### objective and outcome

Selected and completed the **Agent Runtime**, the largest missing reusable
subsystem after analyzing the dependency graph of the kernel, context engine,
tool registry, control plane, policy/approval engine, audit/report framework,
and deterministic replay infrastructure.

The new `@exattime/awe-agent-runtime` package supplies:

- versioned, closed, runtime-validated agent manifests and registry resolution;
- provider-neutral model request/response contracts and adapter registry;
- typed `tool`, `finish`, and `request_human` actions with no reasoning field;
- a bounded turn/model/tool/token loop;
- workflow/tool/agent contract intersection;
- controlled tool dispatch through existing tenant grants, policy, approvals,
  schema validation, idempotency, and timeout enforcement;
- tenant-bound context evolution after every tool result;
- canonical audit events on every execution path;
- append-only hash-chained transcripts and state projection;
- deterministic response replay and full simulation replay;
- a tenant-checked run store contract plus working memory implementation.

`@exattime/awe-runtime` now exposes `createAgentService()` and a fully synthetic
operations investigator example. The example performs two tenant-bound reads,
feeds their results back through the Context Engine, and returns a recommendation.

### architecture

```
awe-kernel
  outcomes/events/context/tools/reports/runWorkflow
        ▲
awe-control-plane
  workflow registry/policy/approval/controlled dispatch
        ▲
awe-agent-runtime
  manifests/model contracts/bounded loop/transcript/replay
        ▲
awe-runtime Agent Service
        ▲
CLI / MCP / web / workers / scheduler / n8n
```

Full design: `docs/architecture/AGENT_RUNTIME.md`.

### files created

```
packages/awe-agent-runtime/package.json
packages/awe-agent-runtime/src/action.mjs
packages/awe-agent-runtime/src/agent-registry.mjs
packages/awe-agent-runtime/src/index.mjs
packages/awe-agent-runtime/src/manifest.mjs
packages/awe-agent-runtime/src/model.mjs
packages/awe-agent-runtime/src/run-store.mjs
packages/awe-agent-runtime/src/runtime.mjs
packages/awe-agent-runtime/src/transcript.mjs
packages/awe-runtime/src/agent-service.mjs
packages/awe-runtime/src/reference/operations-agent.mjs
scripts/awe-agent-runtime.mjs
scripts/eval-agent-runtime.mjs
scripts/eval-agent-runtime.sh
docs/architecture/AGENT_RUNTIME.md
```

### files modified

```
README.md
packages/awe-kernel/src/registry.mjs
packages/awe-runtime/package.json
packages/awe-runtime/src/index.mjs
scripts/eval-kernel.mjs
scripts/lib/awe-reasons.mjs
docs/planning/AGENT_HANDOFF.md
```

### verification

- Runner A: **127 passed, 0 failed**, 16 fixtures, 15/15 event types covered.
- Runner K: **572 passed, 0 failed**.
- Combined non-database/non-build regression: **ALL GREEN**, 11 suites run,
  12 skipped.
- Exact replay reproduced the same outcome, model records, and transcript digest.
- Demo CLI completed two controlled tenant-bound tool calls and replayed its
  transcript.
- All new JavaScript modules pass `node --check`; `git diff --check` passes.

No DB suites, production deployment, production configuration, migration,
live data access, secrets, provider calls, n8n publication, or workflow
publication occurred.

### migrations

None created, edited, or applied. `supabase/` is untouched.

### publication status

Published commit `f5e5c6e` (`feat: add bounded agent runtime`) on
`codex/agent-runtime`. The branch is pushed and draft PR
[#5](https://github.com/jaqboredasf-gif/Autonomous-Workflow-Engine/pull/5)
targets `codex/live-mcp-data-boundary`, whose tip `cf37090` is the merge base,
so the review diff contains only the Agent Runtime subsystem. The connected
GitHub app returned a repository 404 during PR creation; the authenticated
`gh pr create` fallback succeeded.

### remaining technical debt

- Durable RLS-backed agent run/transcript storage.
- Distributed pause/resume delivery and execution leases.
- Cost/latency/quality model routing and failover.
- Cross-run memory with explicit write/retention policy.
- Optional transcript signing (v1 hash chains detect mutation but do not attest
  producer identity).

### recommended next subsystem

Build the **Memory Layer** next: tenant-bound, versioned memory with provenance,
retention, explicit write policy, replayable retrieval snapshots, and adapters
for lexical/vector stores. Integrate reads as Context Items and write proposals
as approval-controlled actions; do not put storage-specific retrieval inside
the agent loop.

### compact next-session handoff

Start from `codex/agent-runtime`. Read
`docs/architecture/AGENT_RUNTIME.md`, then run
`bash scripts/eval-agent-runtime.sh`. Treat the model profile and run store as
injected adapter seams. Do not add provider SDKs to
`packages/awe-agent-runtime`. The next high-leverage task is the Memory Layer,
not a workflow-specific agent. No migration or deployment is pending.

---

## Previous handoff history

## updated_at

2026-07-28T12:46:28Z

## agent

Codex (Platform Architect)

## repository

jaqboredasf-gif/Autonomous-Workflow-Engine

## branch

`codex/live-mcp-data-boundary`, created from `b038598` and now merged forward
with `feat/kernelized-mcp-context` at `19f5e1c` after Claude Code completed the
control-plane milestone concurrently. Both branches are pushed. Draft PR #4
targets `feat/kernelized-mcp-context`, so its review diff contains the LIVE
data-boundary infrastructure without presenting Claude's work as a deletion.
No existing branch was moved, reset, rebased or deleted.

Branch relationships established last session still hold: this branch uniquely
carries the C1/S1 security work and is **not** superseded by
`chore/agent-handoff-clean`.

## commit

Relevant published commits:

| commit | scope |
|---|---|
| `5dd8a2d` | `@exattime/awe-control-plane` — manifest, workflow registry, policy, journal, dispatch, engine |
| `2a2ba23` | `@exattime/awe-runtime` — control-plane service, journal/result stores, injected clocks, reference workflow, operator CLI |
| `81fede2` | Runner P — 372 offline gates, registered in the suite registry and the reason union |
| `13a81a0` | `docs/architecture/EXECUTION_CONTROL_PLANE.md` |
| `19f5e1c` | control-plane milestone handoff |
| `8675b6b` | opt-in LIVE MCP tenant-boundary proof |
| `8155987` | LIVE-boundary handoff before the concurrent-base merge |
| `b1bcd4d` | verified merge of the completed control-plane base |

## current objective

Completed **Credential-Gated LIVE MCP Data-Boundary Proof**, integrated over the
completed **AWE Execution Control Plane** base. The shared suite registry now
has a reusable explicit opt-in gate; the MCP data port exposes a mechanically
testable read/write taxonomy and tenant-labelled row contract; and Runner
M-LIVE covers all eight read tools without permitting any write method to reach
Supabase.

## completed work

- **Reusable opt-in suite gate.** `defineSuite` accepts `optInEnv`; the planner
  skips unless the named variable equals `1`. Runner K proves opt-in and
  credential gates independently.
- **Read/write data-port taxonomy.** `READ_DATA_PORT_METHODS` and
  `WRITE_DATA_PORT_METHODS` partition the complete MCP port. Live and fixture
  intermediate rows retain `org_id`, including punches, shift conflicts and
  service areas.
- **Runner M-LIVE.** All eight read tools run through
  `executeTool`/`runWorkflow`. Its injected port observes every source row and
  hard-refuses both write methods. A SELECT-only oracle requires a real
  second-tenant job-site sentinel, verifies the bound result excludes it, and
  proves a cross-tenant request is refused before port access.
- **Safe concurrent integration.** The work was isolated before Claude's
  control-plane commits appeared, then merged forward once the base advanced.
  Both `eval-mcp-live` and `eval-control-plane` remain registered.
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

Created by the LIVE-boundary task:

```
scripts/eval-mcp-live.mjs
scripts/eval-mcp-live.sh
```

Modified by the LIVE-boundary task:
`packages/awe-kernel/src/suite.mjs`,
`packages/awe-kernel/src/registry.mjs`,
`packages/mcp-server/src/data-port.mjs`, `scripts/eval-kernel.mjs`,
`scripts/eval-mcp.mjs`, and this handoff.

Created by the control-plane base:

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

Control-plane base modifications: `packages/awe-kernel/src/registry.mjs`;
`packages/awe-runtime/src/index.mjs` and `package.json` (exports);
`scripts/lib/awe-reasons.mjs` (registers the `control_plane` namespace);
`scripts/eval-kernel.mjs` (the exact-set namespace assertion now expects it).

The control-plane base changed no kernel behaviour. This task changes only the
generic suite-planning contract in `suite.mjs` by adding the explicit opt-in
gate, plus descriptors in the suite registry.

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
bash scripts/eval-kernel.sh
bash scripts/eval-mcp.sh
bash scripts/regression.sh --only=eval-mcp-live --dry-run
AWE_RUN_LIVE_MCP=1 bash scripts/regression.sh --only=eval-mcp-live --dry-run
bash scripts/eval-mcp-live.sh  # refused as designed; exit 2, no network
bash scripts/regression.sh --exclude-kinds=db,build
npm run build  # apps/web, network-approved font fetch
git merge --no-edit feat/kernelized-mcp-context
```

## tests passed

Combined non-database result — **ALL GREEN, 13 runnable suites, 9 db suites
skipped**. The isolated worktree ran the 10 non-build suites together plus the
mobile and MCP build gates. Turbopack rejects the worktree's out-of-root
dependency symlink, so the unchanged web source was built separately in the
primary checkout and passed.

| suite | result |
|---|---|
| Runner K (kernel unit) | 567 / 0 |
| Runner C (context primitives) | 138 / 0 |
| mobile typecheck | OK |
| web production build | OK |
| MCP smoke (initialize + tools/list) | OK |
| migration 0014 structural validation | OK |
| Runner 3 (approval diff) | 121 / 0 |
| migration 0015 structural validation | OK |
| Runner 4 (approval matrix + outbound) | 327 / 0 |
| Runner 5 (approval queue) | 349 / 0 |
| Runner M (kernelized MCP surface) | 420 / 0 |
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

No product or platform suite failed. One worktree-only web attempt failed
because Turbopack rejects an out-of-root `node_modules` symlink; an initial
sandboxed primary build could not fetch Google Fonts. The network-approved
primary build passed.

**Not run, deliberately:** Runner M-LIVE and every other `db`-kind suite. No
live credential was read and no live project was contacted.

## live changes

No database call, migration, n8n change, workflow publication, MCP live tool
call or live credential use. Git changes: pushed
`feat/kernelized-mcp-context` and `codex/live-mcp-data-boundary`; opened draft
PR #4. The web build fetched its declared Google Font assets.

## approvals required

- **ADR-0002 ratification** remains open. The control plane was built to *not*
  depend on it: it grants nothing, touches no database, and refuses `LIVE` mode
  outright (`live_mode_unratified`). Flipping `allow_live` is the single named
  switch that would change that, and it must not be flipped before ratification.
- **Explicit live-test approval** before setting `AWE_RUN_LIVE_MCP=1` with
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `AWE_ORG_ID`.
- The Phase 1 deployment gates in the archived sections below remain open and
  are unaffected by this session.

## risks

- Supabase's 2026 Data API default no longer auto-grants access to new public
  tables. Runner M-LIVE reports provider code `42501` as grant/setup drift; this
  branch does not add or apply a grant.
- The second-tenant negative intentionally requires at least one foreign
  `job_sites` row. Absence fails the non-vacuity precondition instead of
  producing a misleading green result.
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

After explicit operator approval, run only:

```
source .env.acceptance
AWE_RUN_LIVE_MCP=1 bash scripts/regression.sh --only=eval-mcp-live
```

Review provider codes without logging provider messages (`42501` means a
missing explicit Data API grant). Do not add or apply a grant without separate
migration approval. If green, record the exact tool/row coverage here and
update draft PR #4. Do not implement capabilities, permissions or approval
thresholds; ADR-0002 remains unratified. Claude Code retains ownership of the
feature roadmap in `docs/architecture/EXECUTION_CONTROL_PLANE.md`.

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

`8675b6b` — `test(mcp): add opt-in live tenant-boundary proof`

Its parent is `b038598`, the ninth and final commit of
`feat/kernelized-mcp-context`. The branch therefore carries the complete
kernel/MCP foundation plus only the LIVE data-boundary proof described below.
This handoff correction is a documentation-only follow-up commit.

### current objective

Completed **Credential-Gated LIVE MCP Data-Boundary Proof**. The shared
regression framework can now represent suites that require an explicit
per-invocation opt-in, and the MCP data port has a mechanically testable
read/write classification plus a tenant-labelled row contract. Runner M-LIVE
exercises all eight read tools through the real kernel/Supabase path without
writing.

### completed work

- **Reusable opt-in suite gate.** `defineSuite` now accepts `optInEnv`; the
  planner refuses the suite unless that environment variable equals `1`.
  Runner K proves opt-in and credential gates independently. This is reusable
  for future live probes, not special-case shell branching.
- **Read/write data-port taxonomy.** `READ_DATA_PORT_METHODS` and
  `WRITE_DATA_PORT_METHODS` partition the complete MCP data surface. Runner M
  asserts the partition and probes the row contract across every read method.
- **Tenant-labelled intermediate rows.** Live and fixture implementations of
  recent punches, shift conflicts and service areas now retain `org_id`, so
  downstream transformations cannot erase the evidence needed to verify
  confinement.
- **Runner M-LIVE.** All eight read-classified tools execute through
  `executeTool`/`runWorkflow` with memory sinks. An observing port asserts every
  source row carries the bound tenant and replaces every write method with a
  hard refusal. A SELECT-only oracle finds a real second-tenant job-site
  sentinel; the bound tool must exclude it, and a call naming that tenant must
  be refused before any port access.
- **No default or accidental live path.** The registry requires
  `AWE_RUN_LIVE_MCP=1`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
  `AWE_ORG_ID`; the shell runner independently enforces the same gate.
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

Created this session:

```
scripts/eval-mcp-live.mjs
scripts/eval-mcp-live.sh
```

Modified this session: `packages/awe-kernel/src/suite.mjs`,
`packages/awe-kernel/src/registry.mjs`,
`packages/mcp-server/src/data-port.mjs`, `scripts/eval-kernel.mjs`,
`scripts/eval-mcp.mjs`, and this handoff.

### migrations

None. No SQL file was created, edited or applied. `supabase/` is untouched.

### commands run

```
bash scripts/eval-kernel.sh
bash scripts/eval-mcp.sh
bash scripts/regression.sh --only=eval-mcp-live --dry-run
AWE_RUN_LIVE_MCP=1 bash scripts/regression.sh --only=eval-mcp-live --dry-run
bash scripts/eval-mcp-live.sh  # refused as designed; exit 2, no network
bash scripts/regression.sh --exclude-kinds=db,build
npm run build  # apps/web, network-approved font fetch
git diff --check
bash -n scripts/eval-mcp-live.sh
node --check scripts/eval-mcp-live.mjs
```

### tests passed

All runnable non-database platform suites are green. The worktree cannot run
Turbopack through out-of-root dependency symlinks, so the unchanged web build
was run in the primary checkout and passed.

| suite | result |
|---|---|
| Runner K (kernel unit) | 562 / 0 |
| Runner C (context primitives) | 138 / 0 |
| mobile typecheck | OK |
| web production build | OK |
| MCP smoke (initialize + tools/list) | OK (10 tools) |
| migration 0014 structural validation | OK |
| Runner 3 (approval diff) | 121 / 0 |
| migration 0015 structural validation | OK |
| Runner 4 (approval matrix + outbound) | 327 / 0 |
| Runner 5 (approval queue) | 349 / 0 |
| Runner M (kernelized MCP surface) | 420 / 0 |
| Runner E (execution outcomes + artifacts) | 376 / 0 |

Runner M-LIVE was not run. Its direct invocation without opt-in refused with
exit 2, and both planner states were checked: no opt-in skips with an exact
instruction; opt-in without credentials still skips and reports all missing
credentials.

### tests failed

No product or platform suite failed. One worktree-only web build attempt failed
because Turbopack rejects a dependency symlink that points outside its filesystem
root; the same committed web source passed in the primary checkout. An initial
sandboxed primary build could not fetch Google Fonts; the approved network run
passed.

**Not run, deliberately:** Runner M-LIVE and every other `db`-kind suite. No
live credential was read and no live project was contacted.

### live changes

No database call, migration, n8n change, workflow publication, MCP live tool
call or live credential use. Git changes: pushed
`feat/kernelized-mcp-context` and `codex/live-mcp-data-boundary`; opened draft
PR #4. The web build fetched its declared Google Font assets.

### approvals required

- **ADR-0002 ratification** (harness database access path). Until it is
  `Accepted`, no capability model, tool permission, tenant authorization policy,
  approval threshold or production-enablement policy may be implemented. Neutral
  boundaries exist and are asserted to be empty of those decisions.
- **Explicit live-test approval** before setting `AWE_RUN_LIVE_MCP=1` with the
  three required credentials.
- The Phase 1 deployment gates in the archived section below remain open and are
  unaffected by this session.

### risks

- Supabase announced that new public tables no longer receive automatic Data
  API grants by default. Runner M-LIVE reports provider code `42501` explicitly
  as grant/setup drift rather than misclassifying it as a tenant-boundary
  failure. No grant is added by this branch.
- The second-tenant negative intentionally requires at least one `job_sites`
  row for another tenant. Absence is a failed non-vacuity precondition, not a
  green isolation result.
- **Two real leaks were found and fixed in the prior kernel session.**
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

After explicit operator approval, run only:

```
source .env.acceptance
AWE_RUN_LIVE_MCP=1 bash scripts/regression.sh --only=eval-mcp-live
```

Review the provider code if it fails (`42501` means missing explicit Data API
grant), but do not add or apply a grant without separate migration approval.
If green, record row/tool coverage in this handoff and update draft PR #4. Do
not implement capability, permission or approval behaviour; ADR-0002 remains
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
