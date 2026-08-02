# AWE Identity

**Audience:** AI agents starting a session in this repository. Read this first.
**Last verified:** 2026-08-01
**Verified at:** `codex/durable-execution-plane` @ `55c0ba5c2b4bdc807ee07f8c1f9b3a15f4f28e83`

---

## What AWE is — verified present architecture

AWE (Autonomous Workflow Engine) is a **Node.js npm-workspaces monorepo** that automates
operational back-office work for **Lippolis Electric**, an electrical contractor, on a
**Supabase/PostgreSQL** foundation, with an emerging provider-neutral platform layer underneath.

Two layers coexist in this repository today, and confusing them is the most common orientation error:

| Layer | What it is | Where it lives | Evidence |
|---|---|---|---|
| **Business application** | Employee/timecard/approval/payroll operations for one electrical contractor | `apps/web` (Next.js), `apps/mobile` (Expo), `supabase/migrations/0001–0016`, `packages/mcp-server` | 23 tables incl. `work_requests`, `email_messages`, `approval_drafts`, `time_entries`, `shifts` |
| **Platform (`@exattime/awe-*`)** | Provider-neutral kernel, control plane, agent runtime, memory, durable execution | `packages/awe-*` — **only on the `codex/*` stack, not on `main`** | 6 packages, 3,212 passing assertions across 11 offline runners |

The npm package scope is **`@exattime`**, not `@awe`. Root `package.json` declares
`"name": "exattime"`.

## What problem it solves

A human defines the objective, the policy, and the approval; the system determines and executes the
work through governed, inspectable capabilities. The economic product is **returned time**. The
first operating environment is Lippolis Electric — the proving ground, not the permanent boundary.

## Long-term vision — NOT yet built

The following are **aspirational** and have **no code in this repository**. Do not treat them as
present architecture, and do not create them speculatively:

- An "Operating System for Autonomous Business Execution" spanning other industries
- An **Objective Plane** — `objective` appears in 4 files, all handoff prose, zero code
- An **Orchestration & Responsibility Plane** — no package, no branch, no table (see [AWE_CURRENT_STATE.md](AWE_CURRENT_STATE.md))
- **Work packages** and **replanning** — `work_package` and `replan`: **0 hits repo-wide**
- **n8n as an execution adapter** — n8n appears in 61 design-doc references and **zero workflow exports**

## Constitutional principles — which are enforced in code

Enforced and test-backed:

- **Tenant isolation** — 773 hits across 89 files; `packages/mcp-server/src/tenant.mjs`; RLS in `0002_rls.sql`; Runner M asserts the data boundary
- **Approval enforcement at the point of side effect** — 1,502 hits; `0014_approval_evidence.sql`, `0015_approval_matrix_outbound.sql`; Runners 3/4/5
- **Policy** — `packages/awe-control-plane/src/policy.mjs`; 841 hits
- **Audit** — `packages/awe-control-plane/src/journal.mjs`; 703 hits
- **Idempotency** — `packages/awe-execution/src/effects.mjs`; `docs/guides/EXECUTION_IDEMPOTENCY.md`; 241 hits
- **Durable execution and recovery** — `packages/awe-execution/src/{recovery,replay,retry,state-machine}.mjs`
- **Provider neutrality** — Runner D asserts "core has no provider, network or ambient runtime"
- **Evidence-backed completion** — `scripts/lib/artifact-store.mjs` writes durable run reports

Stated but **not** enforced by code in this repo:

- Versioned artifacts beyond package `0.1.0` stamps
- Non-bypassable policy across *every* adapter (only the control plane enforces)
- Separation of duties (`responsibility` = 15 prose hits, no mechanism)

## What AWE is not

- **Not an n8n workflow collection.** No n8n export is tracked in Git anywhere.
- **Not TEGG.** TEGG is a separate operational agent in the private repo
  `jaqboredasf-gif/TRANSCEND`. It is out of scope here and must not influence this architecture.
- **Not a generic framework.** Do not add planes, layers, or abstractions because a handoff
  document mentioned them. Add them when a capability needs them and a test proves them.
- **Not production-live.** No live Microsoft Graph proof, no applied remote migration verified from
  this machine, no activated workflow.

## Working rules

1. The repository is the source of truth. Conversation history is a clue, never proof.
2. Preserve repository terminology; add a mapping instead of renaming (see [AWE_UBIQUITOUS_LANGUAGE.md](AWE_UBIQUITOUS_LANGUAGE.md)).
3. Every material claim carries a file path and an evidence status — see [VERIFIED_EVIDENCE.md](VERIFIED_EVIDENCE.md).
4. Session rules are enforceable: [AGENT_OPERATING_POLICIES.md](AGENT_OPERATING_POLICIES.md).
