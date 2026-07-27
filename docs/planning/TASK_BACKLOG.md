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

## B2 — Classification harness + model evals — `done (impl + 2A green; 2B pending ANTHROPIC_API_KEY)` (2026-07-20)
- **Goal**: runner script classifying all fixtures via Claude API: context packet per AGENT_HARNESS.md §2 (untrusted-content flagging), budgets 1 call/email + ≤2 retries then unknown→needs_review (code-enforced), strict JSON parsing, Verify Step on every write-back, tokens/cost/latency logged. Plus scripts/eval-classification.sh (Runner 2, EVAL_STRATEGY.md) vs fixtures/emails/labels.json.
- **Deps**: B1 (done). Design interrogation first (operating model rule 3): packet fields, prompt versioning, where runner lives (script vs MCP tool), events request.triage_required/duplicate_flagged addition.
- **Acceptance**: Runner 2 gates — emergency union recall 100%, detection 12/12, hallucinated fields 0, verify-step pass 100%, classification ≥10/12 soft; regression + baseline eval stay green.
- **SHIPPED (2026-07-20)**: standalone domain service + injected adapter (classify.mjs / lib/classification.mjs / lib/model-adapters.mjs / lib/db.mjs); migration 0013 (triage_required + duplicate_flagged); Runner 2A (deterministic, in regression) `passed=20 failed=0, accuracy 12/12`; Runner 2B (live, key-gated, not in regression). Regression intact (slice3 20/20, eval-intake 24/24). Decisions in DECISION_LOG 2026-07-20; contract/rules/evidence/limits in EVAL_STRATEGY.md.
- **REMAINING**: Runner 2B never run (no ANTHROPIC_API_KEY) — external execution dependency; B2 not "fully evaluated" until 2B passes with a real key. Known limits: duplicate detection scoped to fixture corpus (production scoping = MCP/n8n); fixture-08 status deviation (needs_review vs label duplicate — intentional, never auto-close content dupes).

## ADR — Approval Diff & Reasoning (offline evidence slice) — `done (offline slice; live 0014 apply + Graph capture pending)` (2026-07-20)
- **Goal**: offline substrate for draft-not-compose ROI — capture AI-draft vs human-sent diff as evidence; per-category graduation is human-decided. ZERO Graph/network/send this slice.
- **Deps**: B1 (done). Design agreed 2026-07-20 (SESSION_HANDOFF).
- **Acceptance**: Runner 3 deterministic + green; migration additive/validated; ≥1 labelled pair per edit class + unchanged/multi/ambiguous/malformed/missing-optional; no B1/B2 regression.
- **SHIPPED (2026-07-20)**: migration `0014_approval_evidence.sql` (approval_drafts / approval_outcomes / category_authority; is_fixture, fixture namespace, RLS, no-hard-delete + immutability guards, `approval.diff_recorded`/`approval.material_edit` events, human-set authority_level); `scripts/lib/approval-diff.mjs` (pure, deterministic, contract `{unchanged,edit_ratio,field_deltas,edit_classes,material}` + `ambiguous`/`errors`); `fixtures/approvals/*.json` (15) + labels.json; Runner 3 `scripts/eval-approval-diff.sh`+`.mjs` **passed=120 failed=0, coverage 10/10**, in regression; offline `scripts/lib/validate-migration-0014.mjs` **PASS**, in regression; docs/testing/APPROVAL_DIFF.md. Decisions in DECISION_LOG 2026-07-20 ADR.
- **0014 APPLIED LIVE 2026-07-26** (with 0015, under B3-live). Slice 4 checks 13/13b confirm the three tables are present and that no category has graduated past `draft_only`; check 12c confirms the `approval_drafts` no-hard-delete guard fires against a real row. Known limits (APPROVAL_DIFF.md §7) unchanged: heuristic English-only classifier; factual-vs-tone fuzzy; attachment compare by name only; engine takes an already-paired draft/sent — it does not find the pair.
- **NEXT (separate session)**: Microsoft Graph Sent-Items subscription + draft→sent mailbox pairing that feeds real captures into this schema/engine. Unblocked on the schema side now that 0014 is live; still blocked on **I1 (Entra app registration)**.

## B3 — Approval matrix + outbound drafts — `DONE` (offline 2026-07-26; live-verified 2026-07-26)
- **Goal**: migration: message_policies seeded from REQUIREMENTS matrix + outbound_messages + approve/reject RPCs + events; acceptance script.
- **Deps**: B1.
- **Acceptance**: policy row flips draft→auto without code change; non-approver blocked by RLS; approve emits message.approved; invoice type refuses auto mode (constraint) in v1.
- **Handoff**: matrix seed values, RPC names.
- **Shipped (2026-07-26)**: `0015_approval_matrix_outbound.sql` (message_policies +
  outbound_messages + `route_outbound()` / `create_outbound_draft()` /
  `record_approval()` / `mark_message_sent()` + transition guard + no-delete guards +
  6 events + v1 matrix seed, every row `draft`); pure engines
  `scripts/lib/approval-matrix.mjs` (routing) and `scripts/lib/outbound-draft.mjs`
  (10 templates + the `prepareOutbound` gate); `fixtures/outbound/` (5 policy sets,
  16 labelled cases); **Runner 4** `scripts/eval-approval-matrix.{sh,mjs}` and
  `scripts/lib/validate-migration-0015.mjs`, both in regression.
  Evidence: Runner 4 `passed=314 failed=0`, blocked-reason coverage 11/11, template
  coverage 10/10; 0015 lint PASS (64 checks incl. engine/SQL parity). Detail:
  docs/testing/APPROVAL_MATRIX.md.
- **Closed live (2026-07-26, B3-live)**: 0014 + 0015 applied to the live database and
  `scripts/acceptance-slice4.sh` (**49 checks, all green**) proves every DB-side gate.
  All four acceptance criteria now have executed evidence — see B3-live below.

## B3-live — Apply 0014+0015 + acceptance slice 4 — `DONE` (2026-07-26)
- **Goal**: apply `0014_approval_evidence.sql` + `0015_approval_matrix_outbound.sql` to
  the live project, then add `scripts/acceptance-slice4.sh` proving the DB-side gates
  offline lint cannot.
- **Shipped (2026-07-26)**: both migrations applied live (dry-run first: both files in one
  `begin; … rollback;` against the live schema — zero errors, zero residue; then applied
  with Jack's explicit authorization). `scripts/acceptance-slice4.sh` (49 checks) and
  `scripts/parity-route-live.mjs`, both wired into regression.
- **Acceptance criteria — all four now have executed live evidence**:
  1. *policy row flips draft→auto without a code change* — slice 4 checks 11/11b: the
     flip succeeds by data alone and the flipped row still routes
     `effective_mode=draft` (zero v1 auto-sends holds). Done in a rolled-back
     transaction; check 11c re-asserts the live matrix still has zero `auto` rows.
  2. *non-approver blocked by RLS* — checks 4–4g: the fixture `worker` sees 0
     `outbound_messages` and 0 `message_policies`; `record_approval` and
     `mark_message_sent` both refuse it; a direct table update writes nothing (no
     insert/update policy exists); anon is blocked from both tables.
  3. *approve emits `message.approved`* — checks 7/7b: status→approved with approver +
     timestamp recorded, event emitted exactly once carrying `approved_by`.
  4. *invoice type refuses auto mode (constraint)* — checks 10/10b/10c:
     `message_policies_invoice_never_auto` raises, the row stays `draft`, and
     `mode='auto'` without an approval limit is refused too.
- **Also proven live**: duplicate `draft_key` → RPC idempotent (same id, no 2nd row) and
  direct insert → **23505** (checks 2/2b); `sent` unreachable three independent ways —
  RPC approval gate, transition guard, and check constraint — plus a global invariant
  that zero `sent` rows lack a full approval record (6–6d); automation has zero approval
  authority (service role, no JWT → refused, check 5); content frozen after leaving
  draft (7c); rejection needs a reason and is terminal (9–9d); hard deletes refused on
  `outbound_messages`, `message_policies`, `approval_drafts` (12–12c); fail-closed paths
  execute live — `estimate_proposal` → `blocked/missing_approver_role`, amount-bearing
  message with NULL limit → `blocked/missing_approval_limit` (3–3c).
- **Dual-implementation risk RETIRED** (checks 14–14d): `scripts/parity-route-live.mjs`
  routes every (message_type × amount × unavailable-roles) case through **both** the live
  `route_outbound()` and the offline JS `route()` over the same live policy rows.
  Pass 1: 160 cases / 642 field comparisons / 0 mismatches. Pass 2 (14b): the same matrix
  with limits + backup + escalation roles configured inside a rolled-back transaction —
  300 cases / 2304 comparisons / 0 mismatches — because the live matrix has every
  `approval_limit_cents` NULL, so pass 1 alone never reaches the limit/escalation
  branches. Check 14c asserts those branches were actually exercised (esc=78, backup=32)
  so the parity claim can't pass vacuously; 14d re-asserts the live matrix stays
  fail-closed.
- **Non-vacuity verified by perturbation**: `path='backup'` → `'secondary'` in the JS
  engine produced exactly 7 mismatches in pass 1; `amountCents >` → `>=` produced
  **0** mismatches in pass 1 (invisible — the reason 14b exists) and 39 in pass 2. Engine
  restored, `git diff` clean.
- **Deps**: B3. Human gate satisfied 2026-07-26 (Jack authorized the live apply).
- **Acceptance**: 0014+0015 applied ✅; slice 4 green (49/49) ✅; regression ALL GREEN ✅
  (twice consecutively — slice 4 is re-runnable/idempotent); drift check clean ✅
  (24 live base tables = 19 + 5).

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
