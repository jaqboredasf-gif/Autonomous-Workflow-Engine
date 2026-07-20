# Session Handoff

Read CONTEXT.md first, then this, then all docs/planning/*.md. One approved task per session.
Vocabulary authority: docs/architecture/UBIQUITOUS_LANGUAGE.md (2026-07-17).

## Current state (2026-07-20, Task ADR offline slice COMPLETE — Runner 3 green)

ADR offline evidence slice built and committed this session. Repo advanced from
B2 commit `18ef23f`. ZERO Graph, ZERO network, ZERO send — as scoped.

### What ADR shipped
- **0014_approval_evidence.sql** — additive over 0001–0013. Tables
  `approval_drafts` / `approval_outcomes` / `category_authority`; `is_fixture` +
  `fixture:<key>` namespace, org-scoped FKs, timestamps, RLS-first (admin read;
  service-role write; no delete policy), no-hard-delete `before delete` guards +
  immutability guards (corrections = new rows), events `approval.diff_recorded` +
  `approval.material_edit` on the emit_event spine, **human-set** `authority_level`
  (default `draft_only`; no autonomous graduation).
- **scripts/lib/approval-diff.mjs** — pure/offline/deterministic. `diff(draft,sent)`
  → `{unchanged, edit_ratio, field_deltas, edit_classes, material}` (+ `ambiguous`,
  `errors`). Compares subject/body/to/cc/bcc/attachments; 10-class heuristic
  classifier; malformed input fails closed → material.
- **fixtures/approvals/*.json** (15) + labels.json — ≥1 labelled pair per edit
  class, plus unchanged / multi-class / ambiguous / malformed / missing-optional.
- **scripts/eval-approval-diff.sh** (+ .mjs) — Runner 3, pure offline (no keys/DB/
  network), in regression.
- **scripts/lib/validate-migration-0014.mjs** — offline structural lint (no DB in
  env), in regression.
- **docs/testing/APPROVAL_DIFF.md** — schema, contract, material/classification
  rules, limits, Runner 3, deliberate exclusions.

### ADR evidence (2026-07-20)
Runner 3 `passed=120 failed=0, 15 fixtures, edit-class coverage 10/10`; determinism
+ contract-shape asserted per fixture. Migration lint PASS. No B1/B2 regression:
Runner 2A `passed=20 failed=0, accuracy 12/12` (verified in isolation — a full-
regression run hit a transient Supabase mgmt-API 429 throttle on 2A only; re-run
green), intake eval 24/24, acceptance slices intact. Detail: docs/testing/APPROVAL_DIFF.md.

### ADR open dependency (NOT a blocker)
**0014 never applied to the live DB** — no psql/supabase CLI/docker in this env, and
applying schema to live Supabase from an isolated session is a human-gated outward
action (same posture as B2's Runner 2B). To apply: `source .env.acceptance` then
push 0014 via the supabase CLI or the mgmt query API. Runner 3 (the completion bar)
is fully offline and passes without it.

### Next session — ADR Graph capture, NOT started
Microsoft Graph Sent-Items subscription + draft→sent mailbox pairing feeding real
captures into 0014's schema via the offline engine. Only after 0014 is applied live.
Everything in "hard boundaries" for this slice still holds until that task is
explicitly approved.

## Current state (2026-07-20, Task B2 COMPLETE — classification harness + Runner 2A green)

B2 built and committed this session. Live DB + repo in sync at migrations
0001–0013. Classifier is a provider-agnostic domain service with an injected
model adapter; deterministic Runner 2A is GREEN and wired into regression.

### What B2 shipped
- **0013_triage_events.sql** — additive `request.triage_required` +
  `duplicate_flagged` intake events (existing emits unchanged). Applied to live DB.
- **scripts/lib/classification.mjs** — domain service: keyword∪model emergency
  union, 1-call+≤2-retry budget, fail-closed→unknown/needs_review, status
  derivation, hallucination guard, Jaccard duplicate detection.
- **scripts/lib/model-adapters.mjs** — `fixtureAdapter` (recorded, 2A) +
  `anthropicAdapter` (live raw fetch, 2B, no SDK).
- **scripts/lib/db.mjs** — persistence + deterministic Verify Step (re-read DB:
  row_updated/values_match/org_scoped/event_present/no_duplicate_side_effect)
  over the management query API; idempotent `fixture:<name>` ingest.
- **scripts/classify.mjs** — thin entrypoint (`--fixture --adapter --persist`,
  `--selftest`); success requires `verify.ok`, never the model's word.
- **scripts/eval-classification.sh** (Runner 2A, in regression) +
  **scripts/eval-classification-live.sh** (Runner 2B, key-gated, not in regression).
- **fixtures/emails/model_recorded.json** — recorded model outputs for 2A.

### B2 evidence (2026-07-20)
Runner 2A `passed=20 failed=0, accuracy 12/12`; all Verify Steps pass; emergency
union catches 02/03/05; fixture 11 fails closed; hallucinated fields 0; idempotent
rerun proven. Regression: acceptance-slice3 20/20, eval-intake (Runner 1) 24/24 —
no existing intake behavior broke. Full detail: docs/testing/EVAL_STRATEGY.md.

### B2 open dependency (NOT a blocker)
**Runner 2B never executed** — no `ANTHROPIC_API_KEY` in this environment. B2 =
*implementation complete / deterministic eval green / live eval pending
credential*. External execution dependency. To finish evaluation: set
`ANTHROPIC_API_KEY` (do NOT commit it) and run
`source .env.acceptance && ANTHROPIC_API_KEY=... bash scripts/eval-classification-live.sh`.
B2 may NOT be called "fully evaluated" until that passes with a real key.

### Next session — ADR (Approval Diff & Reasoning), NOT started
Design agreed this session (draft-not-compose ROI; diff-capture of AI-draft vs
admin-sent via Graph Sent Items; per-category graduation to auto). **Safest first
task:** the offline diff engine + evidence schema on fixtures — migration
`0014_approval_evidence.sql` (approval_drafts / approval_outcomes /
category_authority, is_fixture, no hard deletes), pure `scripts/lib/approval-diff.mjs`,
labelled `fixtures/approvals/*.json`, deterministic `scripts/eval-approval-diff.sh`
(Runner 3). ZERO Graph, ZERO network, ZERO send capability. Graph
subscription/matching is the deliberate task AFTER that. Do not start ADR until
B2's DoD is acknowledged.

## Current state (2026-07-17, Phase 4 COMPLETE — MVP defined, eval baseline built)

Phase 4 ran as one session: MVP defined in **docs/planning/MVP_SPEC.md** (the
canonical MVP authority — read it before any B-task), harness mapped in
**docs/architecture/AGENT_HARNESS.md**, evals in
**docs/testing/EVAL_STRATEGY.md**, 7 harness terms added to
UBIQUITOUS_LANGUAGE.md. Key decisions (full list DECISION_LOG 2026-07-17
Phase 4): MVP = email-triage vertical [RECOMMENDATION — boss confirmation
pending]; attendance report = fast-follow blocked on B8; Maps 1–7 + drafts/
approvals ship, scheduling + delivery post-MVP; no generic agent runtime;
Verify Step convention; B2 budgets (1 call/email, ≤2 retries, fail-closed);
Phases 5–6 collapsed into per-slice design interrogations.

Built this session (E1): fixtures/emails/labels.json (ground truth) +
scripts/eval-intake.sh (baseline deterministic eval: keyword recall 100%, FP
0, territory 100%) wired into regression.sh. Regression = 3 acceptance slices
+ baseline eval, ALL GREEN. Drift check clean at migrations 0001–0012.

### Grill questions for the boss (Phase 4, ≤5)
1. Priority + B8 together: first demo = email-triage queue (buildable now) or
   daily attendance exception report (needs your written rounding/OT policy —
   what is it)?
2. B2: who watches the requests inbox today, and who should own the triage
   queue (drives W2 approver too)?
3. B5: exact towns/counties/zips we accept work in (unlocks the only planned
   auto-send, currently drafted-only)?
4. B10: minimum info before a service call can be scheduled?
5. Interview closer 2 (still unasked): the one mistake this automation must
   never make?

### Next build session prompt — Task B2 (approved order: B2→B3→B5→B4)
> Read docs/planning/CONTEXT.md, SESSION_HANDOFF.md, MVP_SPEC.md,
> docs/architecture/AGENT_HARNESS.md, docs/architecture/UBIQUITOUS_LANGUAGE.md,
> docs/testing/EVAL_STRATEGY.md, TASK_BACKLOG.md B2. Task B2 only:
> classification harness + Runner 2 evals. Start with the compact design
> interrogation (packet fields, prompt versioning, runner location, new event
> types), record decisions in DECISION_LOG, then test-first build per the
> operating model. Budgets and gates are fixed by Phase 4 — do not relax them.
> Regression + baseline eval green before and after; drift check; update
> backlog/handoff; commit; stop after B2.

## Prior state (2026-07-17, Task B1 COMPLETE — implementation started)

B1 (intake spine) built and committed this session. Live DB and repo in sync at
migrations 0001–0012. Regression = 20 acceptance checks across 3 slices, ALL
GREEN. New operating model in force — see DECISION_LOG 2026-07-17 B1 entry
(repo source-of-truth + drift check every DB task; design interrogation before
each slice; test-first; ubiquitous language).

### What B1 shipped
- **0011_request_intake.sql**: email_messages (immutable audit ingestion,
  set-once work_request attach, partial-unique graph_message_id dedupe),
  work_requests (classification/urgency/status enums incl. awaiting_info/
  needs_review/duplicate; emergency ⇒ forced escalated+emergency; duplicate ⇒
  link mandatory), is_emergency_text() keyword net, check_territory()
  (county/zip vs service_areas; unknown ⇒ null, never out-of-territory),
  shifts.work_request_id + guard (escalated never schedulable), events
  request.received / request.classified / request.emergency_escalated.
- **0012_drop_orphan_schema.sql**: dropped 16 empty uncommitted tables + helpers
  an external session had created directly on live (it had overwritten
  current_org_id() and broken all Workstream A RLS — restored to 0002
  semantics). Details: DECISION_LOG 2026-07-17.
- **fixtures/emails/01–12*.json** + **scripts/acceptance-slice3.sh** (20 checks)
  wired into regression.sh.
- docs/architecture/UBIQUITOUS_LANGUAGE.md created.

### Next sessions (pick ONE)
- **Phase 4 planning** (MVP definition — boss-priority decision). Prompt in
  "Next planning session prompt — Phase 4" below. Still the open planning gate.
- **Build B2** (classification harness) or **B3** (approval matrix + outbound
  drafts) — both unblocked by B1; run design interrogation first per operating
  model.
- **Task A2** (corrections UI) — approved, still pending, independent.

## Prior state (2026-07-17, Phase 3B COMPLETE)

Phase 3B executed 2026-07-17 in one session. Jack's draft prompt was LLM-council
pressure-tested first; the executed version merged his 14-workflow decomposition
onto the canonical grounding scaffold (see DECISION_LOG 2026-07-17 Phase 3B —
includes the process rule born from the phantom AI_DEVELOPMENT_METHOD.md
reference: fresh-session prompts must be generated from state files, never
freehand; TASK_BACKLOG P1 tracks writing that doc). **Uncommitted** in working
tree (3A + 3B changes); suggested commit message: "Planning: Phase 3A+3B workflow
maps (intake + delivery)".

### What Phase 3B completed (delivery workflow maps)
- **WORKFLOW_MAPS.md** — retitled to cover both sides; appended Maps 8–21, each
  with Jack's 12-field template (trigger / required inputs / responsible roles /
  automated actions / human approvals / decision points / status transitions /
  notifications / audit events / failure cases / escalation path / definition of
  completion; 3A Maps 1–7 NOT retrofitted): (8) estimate preparation, (9) proposal
  approval + delivery (two gates: internal numbers approval, then message-send
  approval), (10) customer approval or rejection (automation proposes intent
  reading; human confirms — NEVER auto-set), (11) job scheduling (find_best_worker
  reuse; calendar write BLOCKED I1), (12) crew assignment, (13) crew dispatch
  (human-triggered v1, W4), (14) schedule change/cancellation, (15) job completion,
  (16) partial completion + return visit (same job, N visits; invoice waits for
  FINAL completion), (17) change order (owner-only approval, two gates), (18)
  payroll/attendance touchpoint (daily exception report = Phase 4 candidate, NOT
  decided here), (19) invoice preparation (idempotent on job.completed), (20)
  invoice approval + delivery (v1 manual QB/Outlook, never auto), (21) failed
  automation/manual correction (cross-cutting mirror of Map 7 — "one pipeline,
  two writers"). Plus shared delivery rules (every customer reply runs the intake
  spine/keyword net first) and delivery invariants 7–12 (12 = Phase 5 schema
  proposals: job status enum, ~10 events, cancellation_notice matrix row,
  discrepancy flag, aging checks).
- Key decisions logged (DECISION_LOG 2026-07-17 Phase 3B): merged-prompt scope;
  prompts-from-state-files process rule; Map 21 cross-cutting; human-confirmed
  customer-intent interpretation; invoicing waits for final completion +
  idempotent; Phase 5 design proposals.
- New open questions: **B13–B18** (proposal validity/silence, cancellation policy,
  partial billing, field COs, fixed-vs-T&M decider, payment tracking) + **W4–W6**
  (dispatch timing, cancellation matrix row, completion-notice policy) — all in
  ASSUMPTIONS_AND_OPEN_QUESTIONS.md. W1 extended to delivery queues.
- TASK_BACKLOG: D3 extended with B13–B18; build-notes added to B6 (Maps 11–13)
  and B8 (Maps 15–20); P1 (AI_DEVELOPMENT_METHOD.md) added; B15/W4 parked in
  future improvements.
- All locked decisions preserved: zero v1 auto-sends, invoice never auto,
  automation zero approval authority, no hard deletes, pricing_complete blocks
  send, emergency net on every inbound. No code, no schema, no MVP change.

### Grill questions for Jack (≤5, from Phase 3B)
1. B13 — how long is a sent proposal valid; nudge policy for silent customers;
   honor a stale acceptance after prices changed?
2. B14 — who may cancel a customer-approved job; required notice; cancellation fee?
3. B15 — invoice only after final visit, or interim/progress billing?
4. B16 — how do crews report scope growth today; may work proceed before the CO
   is approved?
5. W4 — when does the dispatch notification go out, and who triggers it in v1?

## Prior state (2026-07-17, Phase 3A COMPLETE)

Phase 3A executed per Jack's fresh-session prompt (which REDEFINED the 3A list —
see DECISION_LOG 2026-07-17 Phase 3A entry): intake-side only. **Uncommitted** in
working tree; suggested commit message: "Planning: Phase 3A intake workflow maps".

### What Phase 3A completed (intake workflow maps)
- **WORKFLOW_MAPS.md (new)** — 7 intake maps, each with trigger / required inputs /
  classification rules / decision points / human approvals / automated actions /
  status transitions / notifications / audit events / failure cases / escalation /
  definition of completion: (1) new work request, (2) emergency, (3) out-of-territory,
  (4) service call, (5) missing-info follow-up, (6) duplicate, (7) failed/low-
  confidence classification. Plus shared intake spine, classification precedence
  (emergency > not-a-work-request > out-of-territory > service/estimate > unknown),
  and cross-map invariants checklist for Phase 5 + B1.
- Key design decisions logged (DECISION_LOG 2026-07-17 Phase 3A): keyword emergency
  net runs on EVERY inbound before any short-circuit; fuzzy duplicates never
  auto-closed (only exact graph_message_id auto-attaches); dup of active emergency →
  append + re-notify; no intake auto-ack email in v1; proposed Phase 5 schema
  additions (statuses awaiting_info/needs_review/duplicate, classification
  not_a_work_request, 5 new event types, matrix row missing_info_followup).
- Estimate/proposal + customer job-approval maps MOVED to Phase 3B (were in old 3A
  list; Jack's prompt replaced them with missing-info/duplicate/low-confidence).
- New open questions: **B10** (required intake fields per type), **B11** (info-request
  nudge/close policy), **B12** (emergency ack timeout + fallback order), **W1–W3**
  (intake SLA/cadence; v1 decline-draft approver; whether confirmation approval also
  authorizes the calendar entry) — all in ASSUMPTIONS_AND_OPEN_QUESTIONS.md §A/§E.
  Standing assumption 8 added (office admin = triage owner, pending B2).
- TASK_BACKLOG: B1 note added (build to WORKFLOW_MAPS spine + invariant 6; fixtures
  for Maps 5–7); D3 extended with B10–B12; future improvements + auto-ack parked.
- Zero-auto-send lock, emergency rules, no-hard-deletes, automation-zero-authority
  all preserved — no contradictions introduced. No code, no schema, no MVP change.

### Grill questions for Jack (≤5, from Phase 3A)
1. B10 — minimum fields before a service call can be scheduled?
2. B11 — nudge count/spacing + when to close an unanswered info request?
3. B12 — emergency ack timeout; who's second-line and after how long?
4. W1 — intake SLA: how long may a request sit untouched; pings or digest?
5. W3 — does approving the service-call confirmation also authorize the calendar
   entry, or is scheduling a separate approval?

## Prior state (2026-07-17, Phases 1–2 committed)

**Commit `d80a880`** on main: "Planning: Phase 1-2 of Autonomous Workflow Engine +
boss-priority finding" (6 files in docs/planning/, 674 insertions). Working tree clean.
No code changes since aad11e3.

### What Phase 1 completed (current-state discovery)
- CURRENT_WORKFLOW.md — working model of office operations, broadly affirmed by Jack
  2026-07-17: intake channels + volumes (phone ~10–20/day > email ~3–10/day), people
  map, 16-step request→payment trace, 8 ranked delay points, emergency handling,
  territory practice. §0 = boss's #1 pain (see blockers below).
- ASSUMPTIONS_AND_OPEN_QUESTIONS.md — single source of truth for open questions
  (B1–B9 boss, I1–I2 IT, J1–J3 Jack, 7 standing assumptions).
- DECISION_LOG.md — append-only log. Phase 1 locks: auto-decline disabled entirely
  (ZERO v1 auto-sends until owner approves verified territory rules); email-first MVP
  with manual-intake-form phone bridge later; territory rules extensible day one;
  permissions per-role not per-person.

### What Phase 2 completed (users + permissions)
- STAKEHOLDERS_AND_PERMISSIONS.md — APPROVED. 10 roles × 6 verbs
  (view/create/approve/modify/send/delete), 5 universal rules (no hard deletes;
  audit everything; automation zero approval authority; RLS org-scoping; sends need
  approval row), role→DB divergence table (worker/foreman/admin → 10 roles, Phase 5
  migration).
- Decisions: `user_roles` join table for multi-role humans; customer = email-only
  actor (no portal); sysadmin (Jack) barred from business approvals in prod;
  message_policies gets amount-threshold column now (values await boss §3); v1
  invoice = system drafts record → human creates in QB, sends via Outlook → marks sent.
- BOSS_INTERVIEW.md — 12-round capture sheet; closer 1 ANSWERED, rest open.

### Blockers + open boss questions
- **Boss-priority finding:** boss's #1 pain = daily punch verification + job-number
  entry into ExakTime (~1 hr/day), wants ~1-mile geofence. Mostly Workstream A,
  mostly built; gaps = job-number sync, daily exception report, OT precision. Phase 4
  MUST weigh "daily attendance exception report" vs email triage as first demo.
  DECIDE IN PHASE 4, not before. See CURRENT_WORKFLOW §0 + DECISION_LOG 2026-07-17.
- Interview closer 2 still unasked: "one mistake this automation must never make."
- B8 (OT/rounding policy) now urgent — blocks overtime flagging boss asked for.
- B1–B9, I1–I2 all open (rounds 2–11 of BOSS_INTERVIEW.md unfilled). I1 (Entra app
  registration) blocks all real-mail work — fixtures-first until then.
- J1 (n8n URL) unknown.

### Phase 3A — next planning session (SUPERSEDED — 3A ran 2026-07-17 with Jack's revised workflow list; see Current state)
- **Objective:** map the 7 intake-side workflows SEPARATELY, one at a time, into a
  new docs/planning/WORKFLOW_MAPS.md: (1) new work request, (2) emergency request,
  (3) out-of-territory request, (4) service-call request, (5) estimate and proposal,
  (6) job approval, (7) failed automation / human correction. Each map: trigger,
  actors (STAKEHOLDERS roles), steps, decision points, approval gates (cite
  REQUIREMENTS approval matrix), data written (cite DATA_MODEL tables), failure/edge
  cases (cite RISKS_AND_EDGE_CASES fixtures), what the human sees.
- **Files to read (in order):** docs/planning/CONTEXT.md, SESSION_HANDOFF.md,
  DECISION_LOG.md, CURRENT_WORKFLOW.md, STAKEHOLDERS_AND_PERMISSIONS.md,
  USER_WORKFLOWS.md, REQUIREMENTS.md (approval matrix), DATA_MODEL.md,
  ASSUMPTIONS_AND_OPEN_QUESTIONS.md, RISKS_AND_EDGE_CASES.md.
- **Acceptance criteria:** all 7 maps present with every field above; no contradiction
  with locked decisions (zero auto-sends until territory verified; emergency halts
  auto-scheduling + never sends troubleshooting advice; automation zero approval
  authority; no hard deletes); reuses/expands USER_WORKFLOWS.md Workflow 1 instead of
  duplicating it; new unknowns appended to ASSUMPTIONS_AND_OPEN_QUESTIONS.md with
  IDs; DECISION_LOG.md appended for any new decisions; this handoff updated; exact
  Phase 3B prompt written; ≤5 grill questions to Jack; STOP after 3A (7-step
  end-of-stage protocol).
- **Out of scope for 3A:** delivery-side workflows (scheduling, crew assignment,
  dispatch, completion, change order, payroll reporting, final invoicing — that's 3B);
  MVP selection (Phase 4); schema/architecture design (Phase 5); task breakdown
  (Phase 6); any code, dependency, or schema change; deciding the boss-priority MVP
  question.
- Exact fresh-session prompt: "Next planning session prompt" section below.
- Task A2 build prompt below remains approved + pending (independent of planning).

## Prior state (2026-07-17, end of Phase 1 discovery session)

- Project name for Workstream B pipeline: **Autonomous Workflow Engine** (Jack, 2026-07-17).
- Phase 1 current-state discovery interviewed and documented. New files:
  CURRENT_WORKFLOW.md (working model — NOT boss-confirmed), ASSUMPTIONS_AND_OPEN_QUESTIONS.md
  (now the single source of truth for open questions), DECISION_LOG.md (append-only;
  decision lists below are historical snapshots — log wins on conflict).
- Key 2026-07-17 refinement: auto-decline disabled entirely (zero v1 auto-sends) until
  owner approves verified territory rules. Email-first MVP; phone intake = future +
  manual intake form. Details in DECISION_LOG.md.
- Planning phases remaining (Jack's sequence): 2 users/permissions → 3 workflow maps →
  4 MVP definition → 5 technical architecture → 6 development breakdown. One phase per session.
- No code changes this session. Task A2 (below) still approved and pending — Phase 2
  planning and A2 build are independent sessions.

## Prior state (2026-07-16, end of session A1)

- Repo: ~/exattime, git main. Commits: aad11e3 (Slice 2: immutability + corrections), 6a7ef3a (planning docs). Working tree clean except gitignored env files.
- Live Supabase: migrations 0001–0010 applied. Regression ALL GREEN (19/19 acceptance checks + typechecks + build + MCP smoke).
- Run tests: `source .env.acceptance && bash scripts/regression.sh`

## Task A1 — DONE (2026-07-16)

Slice 2 at 10/10; full regression ALL GREEN; committed. Root cause of the 6 failures: test-data bugs, no schema changes needed. (1) Setup clock-out PATCH violated `clock_out > clock_in` check constraint when insert+PATCH landed in the same second — response was discarded to /dev/null so it failed silently; (2) hardcoded corrected clock_out (21:15) predated the entry's clock_in (21:35) so the same constraint aborted apply_timecard_correction (transaction rollback correctly left the correction pending). Fixes: clock_in set 1h in the past in both acceptance scripts; NEWOUT computed as now+30m.

**Diagnosis correction:** the slice-1 "transient HTTP flake" from the baseline run was actually this same-second constraint race, not network. The `--retry` hardening stays (harmless) but the real fix is the past clock_in.

Known quirk: macOS `date -v` flags used in acceptance scripts — not portable to Linux CI. Fine on Jack's machine; revisit if CI is added.

## Planning decisions locked (2026-07-16 grill session)

- Cutover: 2 matching parallel pay periods vs ExakTime; ExakTime = fallback.
- Boss's scope = request→invoice pipeline (email pasted, formalized in USER_WORKFLOWS.md).
- v1 auto-send: out-of-territory decline ONLY (high confidence + definite rules); all else drafts; final invoice never auto.
- Emergency detection = required MVP; configurable contacts; no troubleshooting advice ever.
- Shared mailbox ≠ shared calendar; dedicated requests@ mailbox preferred; owner inbox untouchable.
- Pricing: placeholders only, source + last-updated mandatory, incomplete pricing blocks send.
- QuickBooks: Option B (integrate after core workflow) — recommended + documented in INTEGRATIONS.md.
- Fixtures-first email build; Entra app = blocking dependency for all real-mail work.

## Unresolved questions

Moved to ASSUMPTIONS_AND_OPEN_QUESTIONS.md (single source of truth; boss/IT/Jack
sections with blocking info). Do not maintain a second list here.

## Security debt

Revoke sbp_ management token after setup; rotate service-role key before real data; org-scope punch-photo read policy.

## Next planning session prompt — Phase 4: MVP definition (written by Phase 3B, 2026-07-17)

> Begin Phase 4 as one fresh-context Ralph-loop planning iteration. First read
> docs/planning/CONTEXT.md, SESSION_HANDOFF.md, TASK_BACKLOG.md, DECISION_LOG.md,
> PROJECT_SCOPE.md, CURRENT_WORKFLOW.md, WORKFLOW_MAPS.md,
> STAKEHOLDERS_AND_PERMISSIONS.md, USER_WORKFLOWS.md, REQUIREMENTS.md,
> DATA_MODEL.md, RISKS_AND_EDGE_CASES.md, and ASSUMPTIONS_AND_OPEN_QUESTIONS.md.
> Verify every file above exists before starting; report any that don't.
> Planning-only session — no production code, no dependencies, no schema changes,
> no integrations, no guessing company policy. Your only task is Phase 4: define
> the MVP. (1) DECIDE the boss-priority question (DECISION_LOG 2026-07-17
> boss-priority finding + CURRENT_WORKFLOW §0): first demo = daily attendance
> exception report (Workstream A, zero Entra blockers, boss's stated ~1 hr/day
> pain) vs email-triage pipeline (Workstream B core) — pick one, log why. (2)
> Define MVP scope as a cut through WORKFLOW_MAPS.md Maps 1–21: which maps ship
> in v1, which degrade to manual, which wait; respect blockers (I1 Entra, J1 n8n,
> B5 territory) and TASK_BACKLOG statuses. (3) Define demo-day acceptance
> criteria per shipped map. (4) Scope the phone-intake manual-entry bridge form
> (decided shortly-after-MVP). Honor every locked decision (zero v1 auto-sends;
> invoice never auto; automation zero approval authority; no hard deletes;
> pricing_complete blocks send; emergency net on every inbound). Label
> assumptions; append new unknowns to ASSUMPTIONS_AND_OPEN_QUESTIONS.md with IDs;
> DECISION_LOG.md only for actual decisions; update TASK_BACKLOG.md (reorder/
> re-scope tasks to the MVP cut); compact into SESSION_HANDOFF.md; ≤5 grill
> questions for Jack; state COMPLETED / BLOCKED / NEEDS HUMAN REVIEW / SPLIT INTO
> SMALLER TASKS; provide the exact Phase 5 prompt (technical architecture); stop
> after Phase 4.

## Next planning session prompt — Phase 3B (SUPERSEDED — 3B ran 2026-07-17 with Jack's 14-workflow merged prompt; see DECISION_LOG. Kept for history.)

> Begin Phase 3B as one fresh-context Ralph-loop iteration. First read
> docs/planning/CONTEXT.md, SESSION_HANDOFF.md, TASK_BACKLOG.md, DECISION_LOG.md,
> PROJECT_SCOPE.md, CURRENT_WORKFLOW.md, WORKFLOW_MAPS.md,
> STAKEHOLDERS_AND_PERMISSIONS.md, USER_WORKFLOWS.md, REQUIREMENTS.md,
> DATA_MODEL.md, RISKS_AND_EDGE_CASES.md, and ASSUMPTIONS_AND_OPEN_QUESTIONS.md.
> Planning-only session — no production code, no dependencies, no schema changes, no
> MVP change, no integrations, no guessing company policy. Your only task is Phase
> 3B: map the estimate and delivery-side workflows, appended to WORKFLOW_MAPS.md,
> each mapped separately: (1) estimate and proposal (incl. internal approval), (2)
> customer job approval (proposal acceptance, incl. ambiguous replies), (3)
> scheduling and crew assignment, (4) dispatch, (5) job completion, (6) change
> order, (7) final invoicing (v1 manual QB/Outlook flow), (8) payroll-reporting
> touchpoint. For each define: trigger, required inputs, decision points, human
> approvals (cite REQUIREMENTS approval matrix + STAKEHOLDERS roles), automated
> actions, status transitions, notifications, audit-log events, failure cases,
> escalation path, definition of completion. Honor every WORKFLOW_MAPS.md cross-map
> invariant and all locked decisions (zero v1 auto-sends; invoice never auto;
> automation zero approval authority; no hard deletes; pricing_complete blocks
> send). Reuse USER_WORKFLOWS.md Workflow 2 — don't duplicate it. Label assumptions;
> append new unknowns to ASSUMPTIONS_AND_OPEN_QUESTIONS.md with IDs; DECISION_LOG.md
> only for actual new decisions; update TASK_BACKLOG.md; compact into
> SESSION_HANDOFF.md; ≤5 grill questions for Jack; state COMPLETED / BLOCKED / NEEDS
> HUMAN REVIEW / SPLIT INTO SMALLER TASKS; provide the exact Phase 4 prompt (MVP
> definition — including the boss-priority attendance-report-vs-email-triage
> decision); stop after 3B.

## Next build session prompt — Task A2 APPROVED by Jack (2026-07-16)

> Read docs/planning/CONTEXT.md, then docs/planning/SESSION_HANDOFF.md and TASK_BACKLOG.md. Task A2 is approved: build the /corrections page in apps/web (list timecard_corrections with original vs corrected values and reason; Approve button calling the apply_timecard_correction RPC; Reject button setting status=rejected) plus a Nav entry. Reuse existing page patterns (see timesheets page for the approve-button pattern). Acceptance: web build green (15 routes); seeded pending correction can be approved end-to-end and the time entry updates; rejected correction cannot be applied; `source .env.acceptance && bash scripts/regression.sh` ALL GREEN before and after. Update TASK_BACKLOG.md + SESSION_HANDOFF.md, commit, report modified files. Do only this task.
