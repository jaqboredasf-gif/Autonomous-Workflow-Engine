# AWE Ubiquitous Language

**Last verified:** 2026-08-01 at `codex/durable-execution-plane` @ `55c0ba5`
**Rule:** the repository's word wins. Where a handoff uses a different word, map it here — never
rename code, a table, or an API to match a document.

See also the repository's own `docs/architecture/UBIQUITOUS_LANGUAGE.md`, which predates this file
and covers the business domain in more depth.

Hit counts are from a local recursive grep of the working tree at `55c0ba5`.

---

## Code-backed terms — these exist

| Term | Meaning in this repo | Where | Hits |
|---|---|---|---|
| **Tenant** | The isolation boundary. `orgs` is the tenant table; every worker claim and data read is tenant-bounded. | `0001_core.sql`, `0002_rls.sql`, `packages/mcp-server/src/tenant.mjs` | 773 / 89 files |
| **Approval** | A human decision gate recorded before an irreversible effect. Three artifacts: matrix, evidence, queue. | `0014`, `0015`, `apps/web/src/lib/approval-queue.ts` | 1,502 / 143 files |
| **Policy** | A machine-evaluated rule that permits or blocks, producing a named reason. | `packages/awe-control-plane/src/policy.mjs`, `packages/awe-kernel/src/gates.mjs`, `message_policies` | 841 / 137 files |
| **Audit** | The append-only journal of decisions, effects and outcomes. | `packages/awe-control-plane/src/journal.mjs`, `time_entry_audits` | 703 / 99 files |
| **Worker** | The unit that claims and executes a durable task under a lease. | `packages/awe-execution/src/worker.mjs`, `docs/guides/EXECUTION_WORKERS.md` | 531 / 80 files |
| **Outcome** | The standardized result envelope — success, blocked-with-reason, or failure. | `packages/awe-kernel/src/outcome.mjs`, `reasons.mjs`, `approval_outcomes` | 536 / 70 files |
| **Idempotency** | The key that makes a repeated effect safe. | `packages/awe-execution/src/effects.mjs`, `docs/guides/EXECUTION_IDEMPOTENCY.md` | 241 / 59 files |
| **Snapshot** | A point-in-time capture in the memory layer. | `packages/awe-memory/src/{record,store}.mjs` | 169 / 32 files |
| **Resume** | Continuing a paused or interrupted durable run. | `packages/awe-execution/src/recovery.mjs`, `docs/guides/EXECUTION_PAUSE_RESUME.md` | 167 / 42 files |
| **Context Item / ContextItem** | The atomic unit of assembled context. | `packages/awe-kernel/src/context-item.mjs`, `assembly.mjs`, `compaction.mjs` | 77 + 64 / ~22 files |
| **Capability** | A registered ability a runtime may invoke. | `packages/awe-kernel/src/registry.mjs`, `packages/m365/src/capabilities.ts` (M365 branch) | 82 / 45 files |
| **Evidence** | The durable artifact proving what a run did. | `scripts/lib/artifact-store.mjs`, `0014_approval_evidence.sql` | — |
| **Adapter** | A provider-specific boundary the core must not import. | `packages/awe-runtime/src/*-service.mjs`, `packages/m365/src/adapters/*` | — |
| **Handoff** | The durable session record. | `docs/planning/{AGENT,CODEX,EXECUTION,SESSION}_HANDOFF.md`, `scripts/validate-agent-handoff.sh` | — |
| **Run** | One execution of a suite or a durable workflow; produces a run report. | `packages/awe-agent-runtime/src/run-store.mjs`, `scripts/lib/runner-report.mjs` | — |
| **Runner** | A named evaluation suite (K, C, A, Y, D, P, E, M, 2A, 3, 4, 5, M-LIVE). | `packages/awe-kernel/src/registry.mjs`, `scripts/lib/suite-plan.mjs` | — |
| **Work request** | The intake record — an inbound request needing triage. **The repo's word for a unit of demanded work.** | `create table work_requests` in `0011_request_intake.sql` | 77 / 23 files |
| **Email message** | A stored inbound/outbound message record. | `create table email_messages` in `0011_request_intake.sql` | 68 / 25 files |
| **Execution Packet** | The versioned, bounded context handed to an agent instead of a conversation. Schema `1.0.0`. Written as Markdown + JSON + a source manifest + warnings. | `scripts/lib/context-compiler/contract.mjs`, `context/AGENT_EXECUTION_PACKET.md` | added 2026-08-01 |
| **Context Compiler** | The capability that turns an objective into a packet by reading repository evidence. Deterministic, file-backed, no embeddings. | `scripts/lib/context-compiler/`, `npm run context:compile` | added 2026-08-01 |
| **Normalized context record** | One fact from one source, wearing a common shape: type, source path, section, summary, evidence status, support, tags, last verified, ref. | `scripts/lib/context-compiler/records.mjs` | added 2026-08-01 |
| **Support** | How much weight a record may carry — `verified`, `conditional`, `reported`, `rejected` — derived from its evidence status, never from tone. | `supportFor()` in `records.mjs` | added 2026-08-01 |
| **Mandatory record** | Context included in every packet regardless of the objective: operating policies, repository identity, known blockers. | `isMandatory()` in `scripts/lib/context-compiler/select.mjs` | added 2026-08-01 |
| **Absent topic** | A subject the objective names that has no code-backed implementation. Reported explicitly; never returned as an empty section. | `detectAbsentTopics()` in `select.mjs` | added 2026-08-01 |

## Terms with a different name in the repo — map, do not rename

| Handoff term | Repository equivalent | Note |
|---|---|---|
| Objective | **`work_requests`** (intake) or a durable run in `awe-execution` | `objective` = 8 hits, all handoff prose + `validate-agent-handoff.sh`. There is **no objective table**. |
| Task | `work_requests` row, or a durable task in the execution state machine | `packages/awe-execution/src/state-machine.mjs` |
| Step | A stage in the durable state machine, or a checkpoint | `docs/guides/EXECUTION_CHECKPOINTS.md` |
| Execution | A durable run under `awe-execution` | — |
| Agent | A registered agent in `awe-agent-runtime` | `agent-registry.mjs`. Distinct from **Worker**, which executes durable tasks. |
| Memory | The versioned tenant-bound layer | `packages/awe-memory` |
| Context | Assembled `ContextItem`s | `packages/awe-kernel/src/context.mjs` |

## Terms that DO NOT EXIST in code — do not build them speculatively

| Term | Hits | Verdict |
|---|---|---|
| **`work_package`** | **0** | Does not exist. Use `work_requests`. |
| **`replan`** | **0** | No replanning mechanism exists. |
| **Objective Plane** | — | No package, no table. Aspirational. |
| **Orchestration Plane** | 10 prose hits in 6 files (`AGENT_RUNTIME.md`, `DECISION_LOG.md`, `packages/awe-runtime/src/index.mjs`, `eval-execution.*`, `classification.mjs`) | Used as an adjective, never as a component. **No plane exists.** |
| **Responsibility Plane** | 15 prose hits in 10 files — incl. `0015_approval_matrix_outbound.sql` and `fixtures/outbound/cases/06_backup_owner_routing.json` | The nearest real mechanism is **approval-matrix routing / backup owner**, not a plane. Separation of duties is **not** implemented. |
| **`AI_EGRESS`** | **0** | n8n hardening concern. Not in this repo. |
| **`plan_valid`** | **0** | n8n planner output. Not in this repo. |
| **`already_done`** | **0** | TEGG `--resume` return value. Different repository. |
| **`externalSendingEnabled`** | **0** | n8n workflow property. Not in this repo. |

## Naming conventions

- npm scope **`@exattime/`** — not `@awe/`. Root package is `exattime`.
- Platform packages are `awe-<plane>`; the app packages are unprefixed (`mcp-server`, `shared`).
- Migrations are **four-digit sequential** `NNNN_snake_case.sql`. One branch
  (`security/phase-1-remediation`) uses a Supabase **timestamp** scheme instead — an unresolved
  conflict, see `CRITICAL_DECISIONS.md`.
- Platform modules are `.mjs`; app and M365 code is `.ts`/`.tsx`; `packages/mcp-server/src/index.js` is `.js`.
- Runners are identified by letter (planes) or number (business slices); the registry is the
  contract (ADR-0008).
