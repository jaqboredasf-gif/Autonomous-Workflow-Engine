# Critical Decisions

**Last verified:** 2026-08-01 at `codex/durable-execution-plane` @ `55c0ba5`

Decisions are recorded in `docs/architecture/decisions/`. This file is an index with status and
consequences — **it does not restate ADR text**. Read the ADR itself before acting on it.

> ⚠ **All nine ADRs are still `Proposed`, dated 2026-07-27, "awaiting Jack's ratification."**
> Not one is Accepted. The platform is built on nine unratified decisions. Ratifying or revising
> them is a genuine, cheap, high-value task for a human.

---

| ADR | Decision | Status | Still active? | Consequence if wrong |
|---|---|---|---|---|
| [0001](../docs/architecture/decisions/0001-agent-harness-doctrine-supersede.md) | Agent Harness supersedes the "no generic runtime" clause | Proposed 2026-07-27 | Yes — `awe-agent-runtime` exists because of it | The whole agent-runtime package loses its justification |
| [0002](../docs/architecture/decisions/0002-harness-database-access-path.md) | Harness runtime uses the service-role Supabase client (open question O1) | Proposed | Yes | Service-role access is the widest possible DB privilege; asserted by Runner M as *"platform service decides no authorization"* |
| [0003](../docs/architecture/decisions/0003-harness-execution-locus.md) | Harness is a library; no daemon in v1 (O2) | Proposed | Yes | No long-running process; durability must come from the DB, which is why `awe-execution` exists |
| [0004](../docs/architecture/decisions/0004-structured-output-contract.md) | Strict JSON-in-text output; native tool-calling deferred (O3) | Proposed | Yes | Model portability preserved; parsing brittleness accepted |
| [0005](../docs/architecture/decisions/0005-fixture-session-lifecycle.md) | Fixture harness rows accumulate; no reaper in v1 (O4) | Proposed | Yes | Fixture tables grow unbounded |
| [0006](../docs/architecture/decisions/0006-human-gate-surface.md) | Human gates reuse the B5 approval queue (O5) | Proposed | Yes | One approval surface; proven by Runner 5 (349 assertions) |
| [0007](../docs/architecture/decisions/0007-kill-switch-home.md) | Kill switch lives in `agent_harness_settings`, not `org_settings` | Proposed | Yes | Emergency stop is per-harness, not per-org |
| [0008](../docs/architecture/decisions/0008-harness-eval-runner-number.md) | Harness eval is Runner 6 | Proposed | Yes | Runner numbering is a registry contract (`packages/awe-kernel/src/registry.mjs`) |
| [0009](../docs/architecture/decisions/0009-competing-c1-migration-artifacts.md) | Two competing artifacts implement the same C1 fix under two incompatible migration-identity schemes | Proposed | **Yes — unresolved and now three-way** | See below |

---

## The migration-identity collision — the single most consequential open decision

ADR-0009 documented **two** competing C1 artifacts. Verified on 2026-08-01, it is **three**:

| Branch | File claiming slot `0016` |
|---|---|
| codex stack (`feat/kernelized-mcp-context` → `codex/durable-execution-plane`), `security/c1-policy-cleanup`, `chore/agent-handoff-integration` | `0016_drop_undeclared_client_policies.sql` (80 lines) |
| `claude/microsoft-365-integration-plane-fcsm1e` | `0016_m365_integration_plane.sql` (~406 lines) |
| `security/phase-1-remediation` | timestamp scheme: `20260727142118_phase1_c1_remove_undeclared_policies.sql` + `…142120_c2`, `…142121_c3`, `…142123_c4` |

Two files claim the same ordinal; a third branch re-solves the same C1 problem under an
**incompatible naming convention**. These cannot all merge as written.

**Not decided, and must not be guessed:** whether the project uses sequential ordinals or Supabase
timestamp identities. That choice determines the fix for all three.

**Consequence:** every migration-touching integration is blocked until this is ratified. See
`docs/integration/AWE_CONFLICT_REGISTER.md` C-101.

---

## Context Compiler placement — decided 2026-08-01

**Decision:** the Context Compiler lives in `scripts/lib/context-compiler/` with CLI entry points at
`scripts/context-compile.mjs` and `scripts/context-check.mjs`. **No new package was created.**

**Status:** Active. Test-backed — Runner CC, 114 deterministic assertions.

**Reasoning, in the order it decided the outcome:**

1. It reads repository-local Markdown (`context/`, `docs/integration/`, ADRs). A deployable package
   must never depend on paths outside itself, so `packages/*` was ruled out immediately.
2. `awe-kernel` is pure — no clock, no I/O — and the compiler must read Git and the filesystem.
   Putting it there would either break that property or split the capability across two homes.
3. `scripts/lib/` is where this repository already keeps tooling libraries with exactly this shape:
   `suite-plan.mjs`, `validate-migration-0014.mjs`, `approval-matrix.mjs`.
4. The smallest design that can move later: the pure core (`contract`, `records`, `adapters`,
   `select`, `compile`) has no I/O at all; `fs-sources.mjs` isolates every filesystem and Git call.
   Moving behind a service means replacing one module.

**Precedent:** `scripts/lib/artifact-store.mjs` made this exact journey — the implementation moved
into `packages/awe-runtime/src/file-sinks.mjs` when the MCP server needed it, and the entry point
stayed so the runners were untouched. The compiler is arranged to repeat that move.

**Consequence if wrong:** if the compiler must be consumed by a deployable package (the Agent
Runtime integration is the obvious candidate), the pure core moves to
`packages/awe-runtime/src/context-compiler/` and `scripts/lib/context-compiler/` becomes a
re-export. That is a file move, not a redesign — which is the point of the split.

**Secondary decisions made with it:**

- **Deterministic selection, no embeddings.** Same objective at the same commit must produce the
  same packet, or a packet cannot be used as evidence. Rule-based scoring is auditable — every
  selected record carries an `included_because` list.
- **`.awe/` is gitignored.** A committed packet would be read as current context while silently
  describing an old commit — the precise failure the compiler exists to prevent.
- **`context:check` reports, never rewrites.** A document that updates itself cannot testify to what
  was verified, by whom, and when.

## ADR-0010 — platform integration strategy · **PROPOSED, NOT APPROVED**

[`docs/architecture/decisions/0010-awe-platform-integration-strategy.md`](../docs/architecture/decisions/0010-awe-platform-integration-strategy.md)
— status `Proposed` (2026-08-02). **Nothing in it has been executed, and it is not approved.**

It proposes: preserve the stacked PR chain and open the missing root PR; land cognition/dispatch as
a separate PR afterwards; land M365 last and then reduce its parallel modules to adapters; renumber
the M365 migration to `0017` while deferring the C1 duplication; renumber the M365 eval to Runner 7
because ADR-0008 holds Runner 6.

**The finding that reframes the problem:** every branch in the chain merges into `main` with exactly
one conflict — `docs/planning/AGENT_HANDOFF.md`, add/add. The stack was never blocked by anything
structural; it is blocked by an unopened pull request. Verified by `git merge-tree` across all nine
branches.

**The hazard it closes:** merging M365 into the stack produces a tree containing **two** migrations
claiming ordinal `0016`, while Git reports conflicts only in three unrelated documents. Confirmed —
merged tree `14079e5`. Git will never warn, because the filenames differ.

**Six human approvals are required** before any of it runs — see ADR-0010 §"Required human
approvals". Four block the landing plan's first stage.

## Control-plane decisions — 2026-08-02

**Status:** Active, test-backed. All four are enforced in code, not by convention.

| Decision | Why | Enforced by |
|---|---|---|
| **A worker cannot assert its way to VERIFIED.** `complete` reaches only `AWAITING_VERIFICATION`; only `dispatch:verify` promotes. | Claims are cheap; the diff is not. Of 81 state pairs, 47 are refused. | `scripts/lib/dispatch/state.mjs` — no edge exists from `CLAIMED`/`IN_PROGRESS` to `VERIFIED`, so the transition cannot be expressed |
| **Agent output is a proposal, never an edit.** Ingestion classifies every claim and appends to one operational section. | An agent writing its own conclusions into organizational memory is the failure this control plane exists to prevent. | `scripts/lib/cognition/ingest.mjs` — four protected documents; one CONTRADICTED claim blocks the entire patch |
| **Provenance cannot be defaulted.** Every evidence record declares `DIRECT_INSPECTION` or `NARRATIVE_CLAIM`. | Without it, a document's assertion launders itself into a measured fact at machine speed. | `scripts/lib/evidence/schema.mjs` — `record()` throws without an explicit origin |
| **Obsidian is projected by manifest, not symlink.** | Symlinks need Developer Mode or elevation on Windows, so init would fail for some users and silently succeed for others; a junction at `context/` would put a live git tree inside a directory Obsidian writes to freely. | `scripts/lib/cognition/obsidian.mjs` — hash-tracked copies, no reverse-copy action at all |

**Consequence if any is relaxed:** the loop stops being trustworthy in exactly the way that makes a
cognition layer worse than none — it keeps producing confident statements that nobody checked.

## Decisions carried in from the local Windows TEGG work — do not relitigate

Recorded in `C:\AWE\backups\LIPPOLIS-2026-08-01\tegg-report-agent\HANDOFF.md`. They govern TEGG,
which lives in a **different repository** and is out of scope here, but they are decided:

site-visit dropdown = most recent · contact = first available · certificate Yes/No answers vary per
job and are never hardcoded · exactly three human pauses (login, cert pattern, final review) · the
operator types credentials, the agent never does.

---

## Corrections to the AWE Unified Integration Handoff

Recorded as decisions because future sessions will otherwise re-import the errors.

| Handoff claim | Repository reality | Status |
|---|---|---|
| Package manager is pnpm; run `corepack enable` + `pnpm install --frozen-lockfile` | **npm workspaces** + `package-lock.json`; no `pnpm-workspace.yaml`, no `packageManager` field. Correct command: **`npm ci`** | **SUPERSEDED** |
| "Migration 004" = Execution Control; "migration 005" = Orchestration, generated not applied | `0004_admin_policies.sql`, `0005_storage_photos.sql`. Neither relates. The real chain is `0001`–`0016` | **SUPERSEDED** |
| Runner K: 577 passing | **582** passing, 0 failing, reproduced 2026-08-01 | Superseded by re-run |
| Runner A: 127 · Runner Y: 91 | **Exactly reproduced** — 127/0 and 91/0 | **CONFIRMED** |
| 145 database checks (23/57/30/17/18) | No reproducible source anywhere in the repository | `REPORTED_NOT_VERIFIED` |
| 61/61 orchestration tests | No orchestration package, branch, or suite exists | `REPORTED_NOT_VERIFIED` |
| `AI_EGRESS`, `plan_valid`, `already_done`, `externalSendingEnabled` | **0 hits repo-wide.** These are n8n/TEGG terms | Not applicable to this repo |
