# Task Backlog

Status: `ready` (unblocked, awaiting approval) | `approved` | `in_progress` | `done` | `BLOCKED(<on what>)`.
Template per task: goal / why / files / deps / acceptance / testing / done / handoff-record.

---

## A1 — Fix slice-2 acceptance failures — `done` (2026-07-16)
Root cause: test-data bugs, not schema. (1) insert + same-second clock-out PATCH violated `clock_out > clock_in` check constraint → setup silently failed; (2) hardcoded corrected clock_out predated clock_in → constraint aborted apply RPC. Fixed scripts (clock_in −1h, NEWOUT now+30m). Schema unchanged. Also corrects the earlier "transient network flake" diagnosis in slice 1 — same constraint race. Regression ALL GREEN.
- **Goal**: scripts/acceptance-slice2.sh passes 10/10 (corrections apply path).
- **Why**: correction flow is a payroll-trust cornerstone; 6 checks failing (apply RPC, status update, event, idempotency, clock_out-overwrite guard).
- **Files**: supabase/migrations/ (additive fix migration if needed), scripts/acceptance-slice2.sh.
- **Deps**: none.
- **Acceptance**: slice2 10/10 AND scripts/regression.sh ALL GREEN.
- **Testing**: `bash scripts/regression.sh` before + after.
- **Done**: green regression, committed, modified-files/migrations report delivered.
- **Handoff**: root cause of failures; any new migration number; regression output.

## A2 — Web corrections UI — `ready`
- **Goal**: /corrections page: list pending, view original vs corrected, approve (RPC) / reject; Nav entry.
- **Why**: admins need a screen; RPC-only is unusable for office staff.
- **Files**: apps/web/src/app/corrections/page.tsx, components/Nav.tsx.
- **Deps**: A1.
- **Acceptance**: pending correction visible; approve updates entry + status; reject blocks apply; build passes (15 routes).
- **Testing**: web build + manual flow with seeded correction + regression.sh.
- **Done**: green build, manual pass, committed.
- **Handoff**: route added; any UI decisions.

## A3 — Payroll parallel-run comparator — `BLOCKED(rounding/OT policy + ExakTime export sample)`
- **Goal**: script comparing Exattime payroll draft vs ExakTime export per employee/period.
- **Why**: cutover criterion = 2 matching pay periods.
- **Files**: scripts/payroll-compare.ts (new), apps/web payroll math.
- **Acceptance**: given both exports, per-employee delta report; zero-delta = pass.
- **Handoff**: policy values used; sample-file format.

---

## D1 — Discovery: mailbox + M365 admin — `ready` (human task, Jack)
- **Goal**: answers: which mailbox receives requests today; who administers M365; who approves Entra app; can requests@ shared mailbox be created.
- **Why**: unblocks Phase B5; mailbox ≠ calendar (decided).
- **Done**: answers recorded in SESSION_HANDOFF.md + INTEGRATIONS.md updated.

## D2 — Discovery: pricing + estimating — `ready` (human task)
- **Goal**: where pricing lives (Excel/QB/supplier/heads); estimate approvers; per-customer rates?; material price-change handling; fixed vs T&M mix.
- **Done**: answers in DATA_MODEL.md price_book section; assumptions removed.

## D3 — Discovery: ops facts — `ready` (human task)
- **Goal**: emergency contact + channel; real licensed territory; rounding/OT policy; n8n URL; QB Desktop vs Online; headcount + phone types (unanswered from interview). Phase 3A additions: required intake fields per request type (B10); unanswered info-request nudge/close policy (B11); emergency ack timeout + fallback contact order (B12). Phase 3B additions: proposal validity + silent-customer policy (B13); schedule change/cancellation policy + fees (B14); partial-completion billing (B15); field-initiated change orders + work-before-approval (B16); who decides fixed vs T&M (B17); v1 payment/dispute tracking (B18).
- **Done**: answers recorded; SAMPLE territory replaced.

---

## B1 — Intake spine + fixtures + safety nets — `done` (2026-07-17)
Migrations 0011 (intake spine) + 0012 (orphan-schema cleanup — see DECISION_LOG
2026-07-17 B1 session) applied; 12 fixtures in fixtures/emails/; slice 3 = 20/20
wired into regression.sh; full regression ALL GREEN. Territory check is
county/zip string matching (service_areas has no geo radius); lat/lng geocoding
deferred until a geocoder exists. Original goal text below.
- **Goal**: migration 0011: email_messages (immutable, is_fixture) + work_requests (classification fields, emergency status lock) + RLS + request.received / request.classified / request.emergency_escalated events + deterministic emergency-keyword + territory checks (SQL functions) + ~12 fixture emails (edge cases from RISKS §"fixtures") + scripts/acceptance-slice3.sh.
- **NOTE (Phase 3A, 2026-07-17)**: build to WORKFLOW_MAPS.md — spine ordering (keyword net before dedupe short-circuit), proposed statuses/enum/events (invariant 6: awaiting_info/needs_review/duplicate, not_a_work_request, dedupe via graph_message_id + duplicate_of link), fixtures should cover Maps 5–7 (missing-info, fuzzy duplicate, low-confidence/spam).
- **Why**: foundation of entire Workstream B; fully buildable + testable without Graph.
- **Files**: supabase/migrations/0011_request_intake.sql, scripts/acceptance-slice3.sh, fixtures/emails/*.json (new dir).
- **Deps**: none (SAMPLE territory acceptable for tests; auto-send stays off).
- **Acceptance**: fixture insert → work_request created with territory_result; "burning smell" fixture → classification=emergency, status=escalated, event emitted, auto-schedule trigger blocks shift creation; out-of-territory fixture → flagged (NO send — sending is B10); email body update attempt → rejected; anon read → blocked; regression stays green.
- **Testing**: `bash scripts/acceptance-slice3.sh` + `bash scripts/regression.sh`.
- **Done**: 100% slice-3 checks, regression green, committed, report (files/migrations/manual-config).
- **Handoff**: migration number, event types added, fixture list, safety-net keyword list.

## B2 — Classification harness + model evals — `ready` ← NEXT BUILD TASK (MVP order: B2→B3→B5→B4)
- **Goal**: runner script classifying all fixtures via Claude API: context packet per AGENT_HARNESS.md §2 (untrusted-content flagging), budgets 1 call/email + ≤2 retries then unknown→needs_review (code-enforced), strict JSON parsing, Verify Step on every write-back, tokens/cost/latency logged. Plus scripts/eval-classification.sh (Runner 2, EVAL_STRATEGY.md) vs fixtures/emails/labels.json.
- **Deps**: B1 (done). Design interrogation first (operating model rule 3): packet fields, prompt versioning, where runner lives (script vs MCP tool), events request.triage_required/duplicate_flagged addition.
- **Acceptance**: Runner 2 gates — emergency union recall 100%, detection 12/12, hallucinated fields 0, verify-step pass 100%, classification ≥10/12 soft; regression + baseline eval stay green.
- **Handoff**: accuracy numbers, misclassifications, prompt version, cost per email.

## B3 — Approval matrix + outbound drafts — `ready`
- **Goal**: migration: message_policies seeded from REQUIREMENTS matrix + outbound_messages + approve/reject RPCs + events; acceptance script.
- **Deps**: B1.
- **Acceptance**: policy row flips draft→auto without code change; non-approver blocked by RLS; approve emits message.approved; invoice type refuses auto mode (constraint) in v1.
- **Handoff**: matrix seed values, RPC names.

## B4 — Emergency escalation config — `ready`
- **Goal**: emergency_contacts + escalation rules + halt-auto-scheduling enforcement + events.
- **Deps**: B1. Channel delivery itself waits on n8n (B12) — DB side testable now.
- **Acceptance**: emergency work_request → escalation event w/ contact payload; shift insert for escalated request rejected; human ack clears halt.
- **Handoff**: contact config shape; unconfirmed channel noted.

## B5 — Web: Requests inbox + Approval queue — `ready`
- **Goal**: two pages reusing existing auth/Nav/patterns: request list w/ classification + status; drafts queue w/ approve/reject buttons.
- **Deps**: B1, B3.
- **Acceptance**: build green; fixture flows visible end-to-end; approve button drives RPC.
- **Handoff**: routes added.

## E1 — Fixture labels + baseline deterministic eval — `done` (2026-07-17, Phase 4 session)
fixtures/emails/labels.json (ground truth, 12 fixtures) + scripts/eval-intake.sh
(keyword recall 100% / FP 0 / territory 100% gates) wired into regression.sh.
Runner verified to fail on perturbed labels. 24/24 green.

## B6 — Service call → schedule + dispatch draft — `post-MVP` (Phase 4 cut — scheduling prerequisites incomplete)
- **Goal**: approved service-call request → shift (reuse shifts + find_best_worker) → dispatch outbound_message draft.
- **NOTE (Phase 3B, 2026-07-17)**: build to WORKFLOW_MAPS.md Maps 11–13 (scheduling, crew assignment, dispatch): human-triggered dispatch in v1 (W4 open), no hard-deleted schedule records (invariant 9), proposed events job.scheduled/dispatched (invariant 12).
- **Deps**: B3, B5.
- **Acceptance**: acceptance script: approve fixture service call → shift row + dispatch draft exist; emergency request → refused.
- **Handoff**: matching rules used.

## B7 — price_book + estimates — `post-MVP` (Phase 4 cut)
- **Goal**: placeholder pricing structure (source + last_updated mandatory, amounts nullable) + estimates/line items + pricing_complete send-gate.
- **Deps**: B1. Real prices wait on D2.
- **Acceptance**: estimate w/ incomplete pricing cannot reach status=sent (constraint/RPC); complete one can reach internal_review.
- **Handoff**: structure; which fields await D2.

## B8 — Proposals/change-orders/jobs/invoices model — `post-MVP` (Phase 4 cut)
- **Goal**: remaining Workstream B tables (both billing types), no integrations.
- **NOTE (Phase 3B, 2026-07-17)**: build to WORKFLOW_MAPS.md Maps 15–20: invoicing waits for FINAL completion (invariant 7, return-visit-pending ≠ complete); invoice generation idempotent on job.completed (invariant 8); customer-intent on proposal/CO replies human-confirmed, never auto-set (Map 10); v1 invoice delivery = manual QB/Outlook flow, mark-sent only (Map 20); proposed job-status enum + events in invariant 12.
- **Deps**: B7.
- **Acceptance**: fixed-price invoice total = proposal + approved change orders (SQL check); T&M invoice references approved time_entries only; unreviewed invoice cannot reach status=sent.
- **Handoff**: model decisions.

---

## B9 — Graph inbound mail — `BLOCKED(Entra app registration — IT)`
## B10 — Graph outbound send incl. auto-decline — `BLOCKED(Entra + real territory data + boss matrix sign-off)`
## B11 — Shared-calendar write — `BLOCKED(Entra)`
## B12 — n8n event consumers — `BLOCKED(n8n instance URL)`
## B13 — QuickBooks sync — `BLOCKED(QB variant + billing-process confirmation; deferred by decision — Option B)`
## C1/C2 — Parallel-run pay periods 1+2 — `BLOCKED(A3 + real employees onboarded)`

---

## Future improvements (not scoped)
Drawing-based auto-estimating; draft→auto graduation per type; vendor-invoice email processing; Excel live sync; Dispatch Pilot; customer portal; intake auto-acknowledgement email (blocked by zero-auto-send lock — Phase 3A); "received twice" duplicate courtesy reply; interim/progress billing (open B15 — not designed); auto-cadence dispatch notifications (W4).

## AR — Architecture-review backlog (observed during builds; fix opportunistically, never inline)
- Acceptance scripts share copy-pasted sql()/check() helpers (4 files now) — one sourced scripts/lib.sh candidate.
- Emergency keyword list lives in fn body — config-table graduation when boss provides additions.
- macOS-only `date -v` in acceptance scripts — Linux CI portability.
- 0011 events emitted by triggers vs B3 RPC-emitted events — keep one convention per table family.

## P1 — Write AI_DEVELOPMENT_METHOD.md — `ready` (process doc, Jack or planning session)
- **Goal**: short doc codifying the Ralph-loop planning method actually in use: fresh-context sessions, one phase per session, state lives in docs/planning/*.md, fresh-session prompts generated FROM state files (never freehand), 8-step end-of-session protocol.
- **Why**: Phase 3B draft prompt referenced this file from memory — it doesn't exist. Phantom reference proved prompts are being written freehand (see DECISION_LOG 2026-07-17 Phase 3B process rule). Also: start each planning session by verifying every file the prompt names actually exists.
- **Done**: file exists in docs/planning/; SESSION_HANDOFF read-order updated to include it.
