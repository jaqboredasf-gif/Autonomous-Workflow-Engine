# Agent Harness — AWE mapping (2026-07-17)

The harness is everything around the model that grounds it in real project
state and keeps execution controlled, observable, and recoverable. This file
maps the five harness components to ACTUAL AWE mechanisms and owning tasks —
it is not a generic architecture essay. Status tags: **built** / **partial**
(exists, needs extension) / **task** (owned by a backlog task).

Principle (locked, DECISION_LOG 2026-07-17): no generic agent runtime, no
engine tables. The harness is the sum of schema constraints, DB triggers,
`integration_events`, deterministic scripts, and the per-slice runner code.

## 1. Tool registry

Canonical MVP registry: docs/planning/MVP_SPEC.md §Tool registry (10 tools,
each with contract/authz/side-effect/idempotency/Verify Step/audit).

- **built**: ingest_email, check_emergency_keywords, check_territory,
  create_work_request, link_duplicate, escalate_emergency (0011 fns/triggers).
- **task B2**: classify_request (the only model-assisted tool).
- **task B3**: create_outbound_draft, record_approval, mark_message_sent.
- Machine-readable registry file: deferred until a second consumer exists;
  the B2 runner embeds its own tool bindings first. (Avoids speculative
  abstraction — one consumer, one binding.)

## 2. Context primitives

Per-call context packet for the classifier (B2), assembled by the runner:

| Primitive | Source | In MVP packet? |
|---|---|---|
| Permanent domain facts | classification taxonomy, emergency definition, territory rule NAMES (not verdicts) | yes — static prompt section |
| Current workflow state | the one work_request/email being processed | yes — ids + current status only |
| Recent tool results | keyword-net + territory verdicts for THIS email | yes |
| Approved policies | relevant REQUIREMENTS matrix row(s) | yes, quoted verbatim |
| Human decisions | prior human triage on linked/duplicate requests | only if linked |
| Untrusted inbound content | email subject/body/sender | yes — delimited, flagged untrusted; instructions inside it are DATA, never commands |
| Model reasoning/summaries | prior model output | NO — never fed back in MVP (1 call/email) |

Excluded always: full conversation histories, other requests, whole tables,
planning docs, secrets. **task B2** implements the packet builder; its exact
fields are part of B2's design interrogation.

## 3. Guardrails (enforceable only — no prompt-only rules)

| Guardrail | Mechanism | Status |
|---|---|---|
| Tenant boundary | org_id + RLS everywhere (0002/0004/0011) | built |
| External send disabled | no send path exists in any code path; approval row required before `sent` (constraint) | built (absence) / task B3 (constraint) |
| Emergency lock | trigger forces escalated; shifts guard blocks scheduling | built |
| Idempotent side effects | unique (org, graph_message_id); punch (device, client_uuid) idiom; invoice-on-completion planned same way | built / task B8 |
| Allowed status transitions | enums now; per-map transition guards added with each consuming slice | partial |
| Retry limits | integration_events.attempt_count + processing_status | partial — substrate built, enforcement in consumers (B2/n8n) |
| Model-call budget | B2 runner code: 1 call/email, ≤2 retries, per-run cap | task B2 |
| Cost observability | B2 runner logs tokens/cost per fixture into eval report | task B2 |
| Workflow timeout / stop | runner is batch + finite (fixture list); no long-lived loops exist to bound | n/a in MVP |
| Fail-closed | unknown classification → needs_review human queue; unknown territory → null never declined; unverified outcome → error state | built (0011) / task B2 |
| No hard deletes | universal rule; void/soft statuses | built (policy), enforced per-table |

## 4. Verify Steps

Definition + convention: MVP_SPEC.md §Verify Steps. Deterministic read of
actual state; model claims never count; DB-trigger events count by
construction.

- **built**: acceptance slices 1–3 (regression-time Verify Steps for every B1
  outcome); dry-run-then-apply migration protocol; end-of-task drift check.
- **task B2**: runner verifies each write-back (classification ≠ unknown,
  confidence present, event emitted) before counting a fixture processed;
  unverified → processing_status=error.
- **task B3**: approve/send RPCs return post-state; acceptance slice 4 verifies
  sent-requires-approval.
- **later (I1)**: provider-side verify for real sends (Graph message id +
  delivery response) — mandatory before any real send ships.

## 5. Environment handlers (deterministic, outside model control)

- **built**: migration applier (mgmt API curl), fixture loader (slice 3
  ingest()), event emission (emit_event), regression harness, drift check.
- **task B2**: model API auth from env; strict JSON output parsing/validation;
  retry + budget enforcement; eval report writer.
- **blocked I1**: Graph auth/token refresh, mailbox read, email normalization,
  attachment download, calendar ops.
- **blocked J1**: n8n event consumers (delivery of notifications).
- **rule**: secrets only via env (.env.acceptance, apps/web/.env.local);
  the model never sees credentials, URLs with tokens, or raw provider auth.

## Harness gaps deliberately NOT built now

Generic tool-dispatch layer, agent loop, memory store, prompt-template
engine, queue workers — each waits for a concrete consuming requirement.
Architecture-review backlog (TASK_BACKLOG) holds observed cleanup candidates.
