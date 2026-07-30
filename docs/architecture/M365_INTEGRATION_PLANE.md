# Microsoft 365 Integration Plane (Task I1)

The durable platform capability that lets AWE observe and act inside Microsoft
365 — Outlook, Teams, SharePoint — without any AWE contract learning that
Microsoft exists. Provider-bound, workflow-neutral: it knows Graph, and it knows
nothing about electrical work requests, invoices or scheduling.

Package: `packages/m365` (zero dependencies). Schema: migration `0016` (**not
applied** — human-gated, AGENTS.md). Tests: `scripts/eval-m365.sh` (Runner 6).

## Why this is a plane and not a workflow

The locked decision (DECISION_LOG 2026-07-17) is "no generic agent runtime, no
engine tables". This does not contradict it. There are no workflow tables here;
an objective is a pointer at `work_requests`, and a work package and task are
columns on an execution row. What the plane *does* add is a single door for
Microsoft side effects, because the alternative — Graph calls sprinkled through
n8n workflows and runners — makes tenant isolation, approval enforcement and
audit unprovable.

## Layering

```
┌─────────────────────────────────────────────────────────────────────────┐
│ AWE (provider-agnostic)                                                 │
│   work_requests · message_policies · outbound_messages · approvals       │
│   integration_events · email_messages                                    │
└───────────────▲──────────────────────────────────────┬──────────────────┘
                │ ContextItem, PolicyDecisionRef,      │ persistence plan
                │ ApprovalRef, EvidenceRecord          │ (rows, not writes)
┌───────────────┴──────────────────────────────────────▼──────────────────┐
│ THE SEAM — packages/m365/src/contracts.ts                               │
│   nothing above this line names Microsoft; nothing below it names        │
│   electrical work                                                        │
└───────────────▲─────────────────────────────────────────────────────────┘
                │
┌───────────────┴─────────────────────────────────────────────────────────┐
│ pipeline.ts        the proof slice: notification -> evidence            │
│ executor.ts        MicrosoftCapabilityExecutor — every gate, every retry │
│ handlers.ts        capability -> adapter binding                         │
│ adapters/          mail · teams · document · identity                    │
│ gateway.ts         MicrosoftGraphGateway (transport seam)                │
│   ├── fake-graph.ts   deterministic, offline, fidelity: 'synthetic'      │
│   └── http-gateway.ts real Graph, disabled by default, fidelity: 'live'  │
│ subscriptions.ts   lifecycle state machine                               │
│ notifications.ts   validation + at-least-once deduplication              │
│ allowlist.ts       explicit resources + tenant binding                   │
│ scopes.ts          permission/scope policy mapping                       │
│ credentials.ts     MicrosoftCredentialProvider (env only, never logged)  │
│ evidence.ts        hash-chained audit trail                              │
│ normalize.ts       Graph message -> ContextItem -> email_messages row    │
│ persistence.ts     the rows this slice would write (migration 0016)      │
└─────────────────────────────────────────────────────────────────────────┘
```

## The proof slice, end to end

```
Graph change notification (at-least-once, possibly hostile)
        │
        ▼
[1] validate ──► refused ──► m365_notifications row (rejection_reason), STOP
        │                    zero Graph calls, zero evidence, zero objective
        ▼
[2] claim delivery ──► already claimed ──► return the original execution id, STOP
        │                                  no execution, no draft, no email row
        ▼
[3] m365.mail.message.read          ┐
[4] m365.mail.attachment.read (×n)  │ each one a CapabilityRequest through the
[5] m365.teams.notification.create  │ executor: tenant → allowlist → TEST mode →
[6] m365.teams.approval.request     │ scopes → policy → approval → idempotency →
[7] m365.mail.draft.create          │ bounded retry → evidence
[8] m365.document.store (optional)  ┘
        │
        ▼
ContextItem (untrusted_external)  ──►  email_messages row (migration 0011)
objective ──► work package ──► task ──► execution (migration 0016)
evidence: one hash-chained row per attempt, refusals included
```

Steps 7 and 8 require a granted human approval. Step 7 creates a **draft**. No
step sends anything, at any mode, at any version.

## The gate order (executor.ts)

Deliberate: identity and authorization refusals come before anything that could
reach the provider, and the most specific refusal wins so the evidence row names
the actual rule.

| # | Gate | Refusal |
|---|---|---|
| 1 | request shape / bounds | `invalid_request` |
| 2 | capability registry | `unknown_capability`, `external_send_forbidden` |
| 3 | capability version | `unsupported_capability_version` |
| 4 | tenant binding | `cross_tenant_denied`, `tenant_binding_missing` |
| 5 | resource allowlist | `resource_not_allowlisted` |
| 6 | TEST-mode safety | `test_mode_violation` |
| 7 | scopes (spec ⊆ declared ⊆ granted) | `scope_not_declared`, `insufficient_scope` |
| 8 | policy decision | `policy_decision_missing/_mismatch/_expired`, `policy_denied` |
| 9 | approval (when required) | `approval_missing/_not_granted/_mismatch/_expired/_by_service_principal` |
| 10 | idempotency | replay — no second side effect |
| 11 | provider call | bounded retries, `provider_*` / `resource_not_found` / `live_access_blocked` |
| 12 | evidence | **no early return** — every path writes a record |

## Capability catalog

Every request carries: AWE tenant, Microsoft tenant, objective, work package,
task, execution, capability + version, acting principal, target resource,
required scopes, policy decision reference, approval reference (when required),
idempotency key, correlation id, timeout and retry bounds.

| Capability | v | Side effect | Scopes | Approval | Target |
|---|---|---|---|---|---|
| `m365.identity.resolve` | 1 | read | `User.ReadBasic.All` | no | directory user |
| `m365.mail.message.read` | 1 | read | `Mail.Read` | no | message in an allowlisted mailbox |
| `m365.mail.attachment.read` | 1 | read | `Mail.Read` | no | attachment of that message |
| `m365.mail.draft.create` | 1 | internal write | `Mail.ReadWrite` | **yes** | allowlisted mailbox (Drafts) |
| `m365.teams.notification.create` | 1 | internal write | `ChannelMessage.Send` | no | allowlisted dev channel |
| `m365.teams.approval.request` | 1 | internal write | `ChannelMessage.Send` | no | allowlisted dev channel |
| `m365.document.store` | 1 | internal write | `Sites.Selected` | **yes** | allowlisted dev library |

Explicitly forbidden (refused by name, not merely absent): `m365.mail.message.send`,
`.reply`, `.forward`, `.delete`, `.move`, `m365.calendar.event.create`,
`m365.document.delete`, `m365.teams.meeting.create`.

## Mapping to existing AWE contracts

| Task vocabulary | Actual AWE contract | Where |
|---|---|---|
| ContextItem | normalized inbound artifact; persisted as an `email_messages` row | `normalize.ts`, migration 0011 |
| Objective | `work_requests` row (the distinct customer ask) | UBIQUITOUS_LANGUAGE |
| Work package / task | names on an execution row, not tables | migration 0016 |
| Execution record | `m365_executions` | migration 0016 |
| Policy | approval matrix (`message_policies`, `route_outbound()`) via `scripts/lib/m365-policy-bridge.mjs` | 0015 |
| Approval | recorded human decision; `record_approval()` in deployment | 0015 |
| Audit / evidence | `m365_capability_invocations` + `integration_events` | 0016, 0009 |
| Responsibility | `message_policies.approver_role` | 0015 |

There is exactly one routing engine in this repo and this slice did not add a
second: the policy bridge calls `route()` from `scripts/lib/approval-matrix.mjs`.
A matrix that cannot route the draft type denies the Microsoft draft.

## Idempotency: three independent layers

1. **Delivery ledger** — `deliveryKey = sha256(subscriptionId, resource, changeType, resourceId)`,
   deliberately independent of anything that varies between redeliveries. Second
   delivery returns the original execution id and does nothing.
2. **Invocation ledger** — one completed invocation per `(tenant, idempotencyKey)`.
   A replay returns the original Microsoft resource ids and writes its own
   evidence row (outcome `replayed`).
3. **The database** — unique indexes on `(org_id, delivery_key)`,
   `(org_id, execution_id)` and `(org_id, idempotency_key) where outcome='succeeded'`,
   plus the existing `(org_id, graph_message_id)` on `email_messages`.

## Subscription lifecycle

```
pending ──created──▶ active ──renewed──▶ active
   │                   │ │ │
   │                   │ │ └─expired/renew_failed─▶ expired ─recreated─▶ pending
   │                   │ └───revoked──────────────▶ revoked ─recreated─▶ pending
   │                   └─────reauth_required──────▶ reauthorization_required
   └──create_failed──▶ failed ─recreated─▶ pending
```

Only `active` accepts notifications, and only until `expiresAt`. A dead
subscription is never resurrected in place — recreation mints a new Graph
subscription id and a new `clientState` secret.

## Safety properties, and how each is enforced

| Property | Mechanism (not a prompt, not a convention) |
|---|---|
| No external email | no send capability at any version; no send path in the package (asserted by source scan); the fake has no send route; the live gateway refuses transmit paths; migration 0016 has no sent state |
| Development only | TEST mode requires `isDevelopmentResource`; recipients must be in the reserved `.invalid` TLD |
| Tenant isolation | tenant binding checked on every capability AND on every notification, both directions |
| Least privilege | spec ⊆ declared ⊆ granted; over-declaration refused; forbidden scopes named with reasons |
| Approval | side-effecting capabilities need a granted approval bound to this capability, resource and execution, by a named human — a service principal is refused |
| At-least-once delivery | delivery ledger + unique index; duplicates create nothing |
| No fabrication | `fidelity` is a literal in both gateways; the live gateway throws `BlockedLiveProofError` without credentials + opt-in; the executor records `blocked_live_proof` rather than inventing a result |
| No secrets in the repo | credentials only from env; only `sha256(clientState)` is ever persisted; source scanned for secret shapes |
| Auditability | one evidence row per attempted side effect, refusals included; hash-chained; append-only in SQL |

## Replacing Microsoft later

Rewrite `adapters/*`, `fake-graph.ts`, `http-gateway.ts` and `normalize.ts`.
Nothing else moves: `contracts.ts`, the executor's gates, the capability catalog
shape, the evidence record and every AWE-side contract are provider-agnostic.
Runner 6 asserts the seam holds by testing the plane exclusively through
`CapabilityRequest`/`CapabilityResult`.

## Tests (Runner 6 — `bash scripts/eval-m365.sh`)

Offline, deterministic, no keys, no DB, no network. 22 labelled notification
fixtures plus direct gate tests: success, denial (all 19 reasons), duplicate
delivery, expired and revoked subscriptions, cross-tenant in both directions,
missing/pending/rejected/expired/robot approvals, unauthorized resources,
unauthorized capability on an authorized resource, under- and over-declared
scopes, ungranted scopes, retry-then-success, retry exhaustion, throttling,
timeouts, partial attachment failure, 404, blocked live proof, evidence chain
tamper detection, determinism over two full runs, and vocabulary parity with
migration 0016.

Structural lint: `node scripts/lib/validate-migration-0016.mjs`.
