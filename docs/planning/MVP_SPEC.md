# MVP Specification — AWE v1 vertical slice (Phase 4, 2026-07-17)

Refines PROJECT_SCOPE.md §MVP into one buildable vertical slice. Vocabulary:
docs/architecture/UBIQUITOUS_LANGUAGE.md. Harness mapping:
docs/architecture/AGENT_HARNESS.md. Evals: docs/testing/EVAL_STRATEGY.md.

## Boss-priority resolution [RECOMMENDATION — boss confirmation pending]

**MVP = email-triage pipeline** (this spec). The attendance exception report
(boss's stated ~1 hr/day pain) stays a fast-follow demo candidate but is
**blocked on B8** (written rounding/OT policy — flags would be unverifiable),
while the triage pipeline is fully buildable on fixtures today with B1 done.
Building triage does NOT preempt the boss's choice: the attendance report needs
no AWE harness work and can be built the week B8 is answered. Ask the boss the
priority question with B8 in the same conversation (grill question 1).

## The MVP workflow

Fixture email (Graph later, I1) → ingest immutably → keyword emergency net →
classify (model-assisted) → territory check → create/link work request →
route to responsible role → prepare outbound draft → human approval →
mark-sent (manual Outlook copy) → every persisted outcome verified.

- **Human served:** office admin (triage owner, standing assumption 8; W2 open
  for decline-draft approver).
- **Trigger:** MVP demo = fixture ingestion (scripts). Production trigger =
  Graph webhook/poll — BLOCKED I1, ingestion layer already isolated for swap-in.
- **Inputs:** email (from, subject, body, attachments meta), `service_areas`
  rules, `message_policies` rows (B3).
- **Output:** triaged work-request queue + approved outbound drafts, each with
  full audit trail. NOTHING is sent by the system (locked: zero v1 auto-sends;
  Entra blocked anyway). "Send" = human copies approved draft into Outlook,
  marks sent (same pattern as v1 invoices).

## Cut through WORKFLOW_MAPS.md

| Ships in MVP | Degrades to manual | Waits (post-MVP) |
|---|---|---|
| Maps 1–3, 5–7 (intake, emergency, out-of-territory draft, missing-info, duplicate, failed-classification) | Map 4 service-call confirmation ships as draft+approval; the calendar/shift step is manual | Maps 8–21 (estimate → invoice), B6 scheduling linkage, B7/B8 models |
| Emergency: escalation event + queue surfacing | Contact-channel delivery (needs n8n J1 + B6 contacts): human watches queue | Auto-decline mode (needs B5 real territory + boss sign-off; stays draft) |

Narrowing vs PROJECT_SCOPE §MVP (logged in DECISION_LOG): scheduling linkage,
pricing/estimate/invoice models move post-MVP — none block the triage demo.

## Domain records

`email_messages`, `work_requests` (built, 0011); `outbound_messages`,
`message_policies` (B3); `emergency_contacts` (B4, config only in MVP).

## Tool registry (MVP tools — contracts implemented by B2/B3/B5)

| Tool | Input → output | Authz | Side-effect | Idempotency | Verify Step | Audit |
|---|---|---|---|---|---|---|
| ingest_email | fixture/Graph payload → email_messages row | service role | write | unique (org, graph_message_id); 23505 = already ingested | row exists w/ expected graph id | request.received |
| check_emergency_keywords | text → bool | any internal | none (pure fn) | n/a | deterministic fn, eval-covered | — |
| check_territory | org, county, zip → jsonb verdict | any internal | none (pure fn) | n/a | deterministic fn, eval-covered | — |
| classify_request | email content packet → classification, confidence, reasoning | B2 runner (service role) | write to work_requests | one classification per request; re-run overwrites w/ event | row updated: classification ≠ unknown, confidence + reasoning present | request.classified |
| create_work_request | org, email id, extracted fields → work_requests row | service role | write | one per originating email (Verify Step checks) | row exists w/ email_message_id; emergency ⇒ status escalated (trigger-enforced) | request.classified / emergency_escalated |
| link_duplicate | request id, original id → status=duplicate | office admin (human only) | write | constraint: link mandatory | status+link both set | request.duplicate_flagged (B2 event add) |
| escalate_emergency | work_request → escalation event | DB trigger (automatic) | event write | once per transition into emergency | event row exists for entity | request.emergency_escalated |
| create_outbound_draft | request, message_type, body → outbound_messages draft | B3 runner / office admin | write | one active draft per (request, type) | draft row exists, status=draft, NOT sent | message.draft_created |
| record_approval | draft id, decision → approved/rejected | role per message_policies (human only) | write | RPC rejects non-pending | status transition recorded w/ approver | message.approved / rejected |
| mark_message_sent | draft id → status=sent | approver role (human only) | write | RPC rejects non-approved | sent requires prior approval row | message.sent |

No generic agent platform. Tools = DB functions/RPCs + the B2 runner script.
Machine-readable registry deferred until a consumer exists (B2 runner is first).

## Model-assisted vs deterministic

- **Model (B2, only one MVP model decision):** classification + field extraction
  (type, urgency, property_type, customer fields, county/zip) with confidence +
  reasoning. Budget: 1 model call per email, ≤2 retries, then
  classification=unknown → needs_review (fail-closed to human).
- **Deterministic:** keyword net (runs first, every inbound), territory check,
  dedupe, status transitions, emergency lock, approval gates, all writes,
  routing (classification → responsible role per matrix).
- **Human:** every approval, duplicate confirmation, emergency response,
  ambiguous-intent reading, all sends.

## Approval boundaries

REQUIREMENTS.md matrix, with auto-decline feature-flagged OFF (locked).
MVP approvals: service-call confirmation, out-of-territory decline draft,
missing-info request → office admin (W2 assumption). Automation approves
nothing. `outbound_messages` cannot reach `sent` without an approval row
(B3 constraint).

## Verify Steps (convention)

A Verify Step is a deterministic read of actual DB state after a claimed
action. Model/runner claims are never evidence; DB-trigger-emitted events are
evidence by construction (they only fire on real writes). Unverified outcome =
failure state, never success. Per-tool verifications in the registry table;
B2 runner must verify its own writes before reporting a fixture processed;
acceptance slices 1–3 are the regression-time Verify Steps.

## Failure states

| Failure | Behavior |
|---|---|
| Model call fails ×3 / low confidence / nonsense output | classification=unknown, status=needs_review, request.triage_required (B2 event) — Map 7 |
| Geocode/territory unknown | in_territory=null → human triage, NEVER out_of_territory (built) |
| Duplicate suspected (fuzzy) | needs_review, human confirms (built) |
| Emergency detected by either net | forced escalated, scheduling blocked (built) |
| Verify Step fails | integration_events.processing_status=error + attempt_count; retry ≤2 then human queue |

## Guardrails (enforced, not prompted)

Schema-enforced today: RLS org scoping; emergency lock + schedule guard;
immutability; duplicate-link and confidence checks; no send path exists.
B2 adds (code-enforced): 1 model call/email, ≤2 retries, per-run fixture
budget, runner refuses to touch rows outside its org. B3 adds: sent-requires-
approval constraint, invoice-type refuses auto mode. Status-transition matrix
= per-map enforcement, added with each consuming slice (not speculative).

## Environment handlers (deterministic, outside model control)

Built: migration applier (mgmt API), fixture loader (slice 3), event emission,
regression harness. B2: model API auth from env, JSON-schema output parsing,
retry/budget logic. Blocked/later: Graph auth + email normalization (I1),
n8n delivery (J1), calendar writes (I1).

## Test fixtures & evals

12 fixtures (fixtures/emails/) + ground-truth labels (labels.json).
Baseline deterministic eval in regression (keyword recall/FP, territory).
B2 model evals with hard gates — details + thresholds in
docs/testing/EVAL_STRATEGY.md.

## Observable definition of done (demo acceptance)

1. All 12 fixtures ingested → every one reaches a terminal triage state
   (queue-visible status or escalated) with zero manual DB surgery.
2. Emergency fixtures (02/03/05): escalated + event, schedule attempt blocked —
   detection via keyword ∪ model = 3/3 (hard gate).
3. Out-of-territory fixture: decline DRAFT exists, nothing sent, approval
   pending.
4. Missing-info fixture: needs_review/awaiting_info with drafted info request.
5. Duplicate fixtures: exact auto-attached; fuzzy waiting on human, never
   auto-closed.
6. Office admin can approve + reject a draft in the web UI (B5); rejected
   draft cannot be marked sent.
7. Every state change has its integration_event; acceptance slices 1–3 +
   baseline eval ALL GREEN.
8. Zero rows in any sent state without an approval row. Zero external sends.

## Phone-intake bridge (scoped, shortly-after-MVP)

Office admin form → synthetic `email_messages` row (mailbox='manual-intake',
direction inbound, raw = form payload, is_fixture=false, graph_message_id
null — requires relaxing the fixture-only check to allow manual source) →
identical pipeline afterward. No schema fork; one check-constraint amendment +
one B5 form page. Not in MVP demo.

## Build order

B2 (classification harness + model evals) → B3 (approval matrix + outbound
drafts) → B5 (requests inbox + approval queue UI) → B4 (emergency contacts
config) → demo. B6+ post-MVP.
