# AWE Agent Runtime

Status: implemented, offline reference complete, no production deployment.

## Executive intent

The Agent Runtime is the reusable execution substrate for autonomous work in
AWE. It turns a model response into a bounded, policy-controlled workflow
action without allowing a model adapter, feature surface, or orchestration
layer to invent its own loop.

It is not a chatbot, a prompt library, a provider SDK, or a workflow-specific
agent. It is the infrastructure that lets hundreds of future agents share the
same versioning, context, policy, approval, audit, replay, tenant, and budget
semantics.

## Why this subsystem

The repository already had almost every deterministic primitive needed by an
agent, but no component composed them into an autonomous execution:

```
COMPLETED INFRASTRUCTURE

  Execution Context ─────┐
  Context Assembly ──────┤
  Context Compaction ────┤
  Versioned Tool Catalog ┤
  Workflow Registry ─────┼──> missing bounded decision/action loop
  Policy + Approval ─────┤
  Controlled Dispatch ───┤
  Audit Events ──────────┤
  Run Reports ───────────┤
  Deterministic Replay ──┘
```

Building memory, model routing, plugins, queues, or a scheduler first would
leave each consumer to reimplement that loop. The Agent Runtime makes those
subsystems future extensions of one execution contract.

## Dependency graph

```
@exattime/awe-kernel
  canonical data, outcomes, events, execution context,
  context items/bundles, tool descriptors, reports, runWorkflow
                  ▲
                  │
@exattime/awe-control-plane
  workflow registry, tenant grants, policy, approvals,
  controlled tool dispatcher
                  ▲
                  │
@exattime/awe-agent-runtime
  agent manifests + registry
  model request/response contract + adapter registry
  bounded turn engine
  hash-chained transcript + projection
  tenant-checked run store contract
                  ▲
                  │
@exattime/awe-runtime
  Agent Service + synthetic operations reference
                  ▲
                  │
      CLI / MCP / web / workers / n8n
```

Dependency direction is one-way. The Agent Runtime imports only the kernel and
control plane. It contains no network, filesystem, provider SDK, database
client, ambient environment, or clock.

## Runtime flow

```
submit(agent_id, tenant, context)
          |
          v
  Agent Registry --------- version + lifecycle
          |
          v
  Workflow Registry ------ promotion + tenant + dependency gates
          |
          v
  Contract Intersection
  agent tools ∩ workflow tools ∩ registered tools ∩ tenant grants
          |
          v
  Assemble Context ------- tenant + sensitivity + item/token budgets
          |
          v
  +---------------- BOUNDED TURN LOOP ----------------+
  |                                                   |
  | model request (versioned instructions, context,   |
  | descriptors, remaining budgets)                   |
  |          |                                        |
  |          v                                        |
  | validated action                                  |
  |   ├─ finish ----------> completed                 |
  |   ├─ request_human ---> blocked handoff           |
  |   └─ tool                                     	   |
  |        |                                          |
  |        v                                          |
  | controlled dispatcher                             |
  | registry -> policy -> approval -> schema ->       |
  | idempotency -> timeout -> adapter -> schema       |
  |        |                                          |
  |        v                                          |
  | tenant-bound, untrusted tool_result Context Item  |
  |        |                                          |
  +--------+------------------------------------------+
          |
          v
  Kernel outcome + report + audit events
          |
          v
  Hash-chained transcript + model replay records
```

## Public contracts

All public boundaries validate at runtime and use pinned schemas:

| Contract | Schema |
|---|---|
| Agent Manifest | `awe.agent_manifest/v1` |
| Agent Action | `awe.agent_action/v1` |
| Model Request | `awe.agent_model_request/v1` |
| Model Response | `awe.agent_model_response/v1` |
| Transcript | `awe.agent_transcript/v1` |
| Transcript Entry | `awe.agent_transcript_entry/v1` |
| Agent Run Document | `awe.agent_run/v1` |
| Agent Run Result | `awe.agent_run_result/v1` |

Unknown keys are refused on manifests, actions, model envelopes, transcript
documents, approval receipts, and run requests. Digests bind each versioned
contract to its content.

### Actions

The model can return exactly three action kinds:

```
tool           { tool, input, reason_code }
finish         { result, summary, reason_code }
request_human  { prompt, reason_code }
```

`reason_code` is a short machine-readable label. Free-form chain-of-thought is
not part of the action, transcript, event, or run-record contract.

### Model adapters

An adapter implements one function:

```
invoke(validatedModelRequest) -> validatedModelResponse
```

The manifest selects a provider-neutral `model_profile`; it never names a
vendor, credential, endpoint, or SDK. A composition maps that profile to an
adapter. The included replay adapter maps request digests to previously
validated responses.

### Budgets

Every manifest pins:

- maximum turns;
- maximum model calls;
- maximum tool calls;
- maximum total reported model tokens;
- context item and deterministic estimated-token budgets;
- maximum context sensitivity.

Exhaustion is a typed `agent_budget_exhausted` blocked outcome with a structured
event, never an implicit loop exit.

## Policy and approval integration

Agent tool actions never call adapters directly. The existing Tool Dispatcher
performs registry, lifecycle, descriptor integrity, tenant policy, grant,
approval, input schema, idempotency, timeout, adapter, and output schema checks.

An approval receipt is bound to the action digest. The existing approval engine
validates its tenant, human actor, named principal, role, and decision. A model
or service actor cannot approve its own action. With no receipt, the agent
returns a human handoff; it does not wait inside the process.

## Context evolution

Each successful tool result becomes a standard Context Item:

- `kind: tool_result`;
- bound to the run tenant;
- `trusted: false`;
- `sensitivity: confidential`;
- content-addressed provenance including descriptor and idempotency identity.

The complete context is reassembled after each result. This applies the same
tenant, deduplication, sensitivity, priority, item, and token rules on every
turn. Tool output never becomes trusted merely because the platform fetched it.

## Events and observability

Every operational path emits canonical AWE events into both the transcript and
the existing audit sink:

```
agent.run.started
agent.resolution.blocked
agent.context.assembled
agent.model.requested
agent.model.responded
agent.model.failed
agent.tool.requested
agent.tool.completed
agent.tool.blocked
agent.tool.failed
agent.human.requested
agent.budget.exhausted
agent.run.completed
agent.run.failed
```

Event payloads carry digests and bounded metadata, not full context bodies or
hidden reasoning.

## Replay

There are two replay modes:

1. Transcript replay verifies every event key, entry link, entry digest,
   document digest, tenant identity, and sequence, then projects state and
   usage without invoking a model or tool.
2. Full deterministic simulation injects `createReplayModelAdapter()` with the
   captured model records. With the same request, virtual clock, context, and
   fixture tools it reproduces the exact outcome and transcript digest.

The transcript stores control evidence. Model records store request digests and
validated actions. Context bodies stay in tenant-bound run data, not in the
control chain.

## Example

The synthetic operations investigator reads a tenant-bound case and policy,
then returns a recommendation:

```bash
node scripts/awe-agent-runtime.mjs demo
node scripts/awe-agent-runtime.mjs describe
bash scripts/eval-agent-runtime.sh
```

Its adapters use in-memory fixture maps only. No database, model provider,
credential, network, production mode, workflow publication, or migration is
involved.

## Integration points

- `createAgentRuntime()` is the transport-free core composition.
- `createAgentService()` is the application-service surface for CLI, MCP, web,
  scheduler, queue worker, or n8n callers.
- `defineModelAdapter()` is the model provider seam.
- `defineAgentRunStore()` is the durable tenant-bound run-data seam.
- Existing Artifact and Audit sinks receive the kernel report and events.
- Existing Tool Registry, Workflow Registry, Policy Engine, Approval Engine,
  Context Engine, and Replay contracts are used directly rather than wrapped
  in parallel abstractions.

## Design decisions

1. Agents reference a workflow manifest. The workflow remains the durable
   authorization envelope; the agent narrows its tool surface further.
2. Agent steps are dynamic decisions, but dispatch policy still evaluates them
   against the workflow's complete `required_tools` declaration.
3. Model usage is reported by adapters and checked for arithmetic consistency.
   Context budgeting remains provider-neutral and deterministic.
4. Human approval terminates the current call with a resume-safe action digest.
   No process holds a lock while waiting for a person.
5. Transcripts are append-only control evidence. Customer/tool bodies are
   represented there by digests.
6. No default real-time clock or provider exists. Deterministic virtual time
   and explicit adapter injection remain mandatory.

## Migration notes

No migration is required for this milestone. The implementation ships an
in-memory tenant-checked run store and a validated store interface. A future
durable adapter can map `awe.agent_run/v1` to storage after its RLS and lifecycle
ADR is approved. No SQL, production configuration, or live state changed.

## Remaining technical debt

- A durable RLS-backed agent run/transcript store is not implemented.
- Approval continuation is supported by validated receipts on a new run call;
  a distributed lease/queue subsystem must own durable pause/resume delivery.
- Model profile routing is exact-match. Cost/latency/quality routing and
  provider failover belong in a future Model Routing Layer.
- Long-lived cross-run memory is intentionally absent; context currently
  evolves only within a run.
- Transcript schema v1 has no cryptographic signer. Its hash chain detects
  mutation but does not prove who produced the chain.

## Recommended next subsystem

Build the **Memory Layer** next: a tenant-bound, versioned memory registry with
explicit write policy, provenance, retention, retrieval scoring, and replayable
snapshots. The Agent Runtime now provides the correct consumer and the exact
points where memory may be read into context or proposed for approval-gated
write-back. Avoid putting provider-specific vector storage into the agent loop;
make it an adapter behind the memory contract.
