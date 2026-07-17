# Decision Log

Append-only. Newest first. Format: date — decision — why — supersedes (if any).

## 2026-07-17 (Phase 4 — MVP definition + harness/eval integration)

- **MVP = email-triage vertical slice** (docs/planning/MVP_SPEC.md) —
  [RECOMMENDATION, boss confirmation pending]. Rationale: fully buildable on
  fixtures today (B1 done, no Entra dependency); attendance exception report
  is blocked on B8 (OT/rounding policy) so its correctness is unverifiable
  now; building triage does not preempt the boss's choice — the attendance
  report needs no AWE harness work and stays a fast-follow the week B8 is
  answered. Grill question 1 puts the priority question + B8 to the boss
  together. Resolves the Phase-4 gate from DECISION_LOG 2026-07-17
  boss-priority finding (as a recommendation, not a boss decision).
- **MVP cut**: Maps 1–3, 5–7 ship; Map 4 ships through confirmation-draft
  approval (calendar/shift step manual); Maps 8–21, scheduling linkage (B6),
  pricing/estimate/invoice models (B7/B8) post-MVP. Narrows PROJECT_SCOPE
  §MVP (scheduling + estimate/invoice models were listed there) — none of
  them block the triage demo, and auto-scheduling prerequisites (jobs,
  availability, conflict checks) don't exist yet.
- **Harness doctrine**: harness = schema constraints + triggers +
  integration_events + deterministic scripts + per-slice runner code. No
  generic agent runtime, no engine tables, no tool-dispatch layer until a
  second consumer exists. Verify Step convention adopted: model claims never
  count as evidence; DB-trigger events count by construction; unverified
  outcome = failure. Docs: AGENT_HARNESS.md maps all five components to
  built/partial/task.
- **B2 budgets fixed by design**: 1 model call per email, ≤2 retries, then
  classification=unknown → needs_review (fail-closed). Enforced in runner
  code, not prompts.
- **Eval system**: fixtures + fixtures/emails/labels.json (ground truth;
  label changes are reviewed decisions) + two runners. Runner 1 (baseline,
  deterministic — keyword recall 100%, keyword FP 0, territory 100%) BUILT
  and wired into regression. Runner 2 (model evals, hard gates: emergency
  union recall 100%, detection 12/12, hallucinated fields 0, verify-step pass
  100%) = B2, on-demand, never in regression. EVAL_STRATEGY.md.
- **Phases 5–6 collapsed into per-slice design interrogations** (operating
  model rule 3). MVP_SPEC.md + AGENT_HARNESS.md carry the architecture; each
  build task (B2/B3/B5/B4) starts with its own compact interrogation instead
  of a standalone architecture session. Supersedes the phase-5/6 planning
  sequence from 2026-07-17 Phase 1 entry.
- **Phone-intake bridge scoped**: synthetic email_messages row
  (mailbox='manual-intake'), identical pipeline; needs one check-constraint
  amendment; shortly-after-MVP, not in demo.

- **Orphan foreign schema dropped (migration 0012).** Live DB was found carrying
  16 uncommitted tables (organizations/people/roles/organization_members/
  organization_member_roles + 11 workflow_* engine tables) plus helper functions,
  created by an external session with no repo migrations. It had overwritten
  current_org_id() to read organization_members, silently breaking ALL
  Workstream A RLS (every user saw zero rows). All tables verified empty (roles:
  9 foreign-seeded rows only); no repo migration/policy/code referenced any of
  it. Helper restored to 0002 semantics; both restore and drops committed as
  0012. Why: repo migrations are the declared source of truth; empty scaffolding
  + broken RLS + naming-collision risk.
- **Operating model adopted (Jack, 2026-07-17):** (1) repo = source of truth —
  no live-only schema changes, drift check at start+end of every DB task;
  (2) docs/architecture/UBIQUITOUS_LANGUAGE.md is the vocabulary authority;
  (3) compact design interrogation before each slice; (4) small verified
  feedback loops, test-first for new behavior, no mocks where the real DB/
  fixtures can be exercised; (5) deep modules over wrappers; architecture
  concerns found mid-slice go to a backlog, not fixed inline.
- **No generic workflow-engine tables in AWE.** Workflow definitions live in
  WORKFLOW_MAPS.md; runs are reconstructable from integration_events over
  concrete domain tables. (Confirms map-driven design; the dropped workflow_*
  scaffolding is not the direction.)
- **Keyword net widened by test:** "outlet … feels hot" fixture exposed a
  too-narrow regex window ({0,20}→{0,40} between noun and symptom). Net stays
  false-positive-biased.
- **B1 shipped (migrations 0011+0012):** email_messages (immutable, set-once
  attach), work_requests (emergency status lock, duplicate-link constraint),
  is_emergency_text(), check_territory() (county/zip strings; unknown → null,
  never out-of-territory), shifts.work_request_id + escalated-scheduling guard,
  events request.received/classified/emergency_escalated, 12 fixtures,
  acceptance slice 3 (20 checks) in regression.

## 2026-07-17 (Phase 3B delivery workflow-mapping session)

- **Phase 3B scope = Jack's 14-workflow decomposition merged onto the canonical
  grounding scaffold** (LLM-council pressure-test verdict before execution). Jack's
  draft prompt was corrected before running: phantom AI_DEVELOPMENT_METHOD.md
  reference dropped; the 6 omitted grounding files (REQUIREMENTS, DATA_MODEL,
  STAKEHOLDERS, USER_WORKFLOWS, RISKS, CONTEXT) restored; locked-decision list,
  Workflow-2 reuse rule, grill questions, and boss-priority Phase 4 requirement
  restored. Why: Jack's granularity (rejection, schedule change, partial
  completion, invoice prep/delivery seam) covers real states the 8-map plan
  buried; the canonical scaffold prevents re-litigating locked decisions.
  Supersedes the 8-workflow Phase 3B prompt in SESSION_HANDOFF (2026-07-17 3A).
- **Process rule: fresh-session prompts must be generated from the state files,
  never freehand.** The phantom file reference proved the draft was written from
  memory — the exact failure mode the planning-docs system exists to prevent.
- **Maps 8–21 use Jack's 12-field template; 3A Maps 1–7 NOT retrofitted.** Formats
  differ (roles field replaces classification-rules field), content compatible;
  retrofit would churn approved material for no information gain.
- **Delivery-side failed automation = cross-cutting Map 21** (mirror of intake
  Map 7), not a 14th linear workflow. Every Map 8–20 failure row lands there;
  corrections follow the same approval gates as the original action ("one
  pipeline, two writers").
- **Customer-intent interpretation is human-confirmed** (Map 10): automation
  proposes clear-accept/clear-reject/ambiguous/counter readings of proposal and
  change-order replies, but NEVER sets customer_approved/customer_rejected alone.
  Extends automation-zero-approval-authority to reading customer intent; the
  "yes approve" ambiguity fixture is exactly this trap.
- **Invoicing waits for FINAL completion** (invariant 7): return-visit-pending
  jobs are not complete; fixed-price invoices only after the last visit; T&M
  invoices reference only approved time/materials/extras. Interim billing is NOT
  designed (open B15 — no policy invented). Invoice generation idempotent on
  job.completed (invariant 8).
- **Design additions proposed for Phase 5 schema (not built now):** job status
  enum; events proposal.customer_rejected, job.scheduled/dispatched/return_needed,
  schedule.changed/cancelled, change_order.approved/customer_accepted,
  invoice.marked_sent, automation.failed; matrix row cancellation_notice;
  completion-vs-punch discrepancy flag; aging checks (completed-without-invoice,
  approved-not-sent). Full list: WORKFLOW_MAPS.md invariant 12.
- New open questions: B13–B18 (proposal validity, cancellation policy, partial
  billing, field COs, billing-type decision, payment tracking), W4–W6 (dispatch
  timing, cancellation-notice row, completion-notice policy).

## 2026-07-17 (Phase 3A intake workflow-mapping session)

- **Phase 3A scope redefined per Jack's session prompt:** intake side = new work
  request, emergency, out-of-territory, service call, missing-info follow-up,
  duplicate, failed/low-confidence classification (WORKFLOW_MAPS.md). Estimate &
  proposal and customer job-approval maps MOVE to Phase 3B (added to its prompt).
  Supersedes the 7-workflow list in the prior SESSION_HANDOFF Phase 3A objective.
- **Emergency keyword net runs on EVERY inbound** — including replies, suspected
  duplicates, and suspected spam — BEFORE dedupe or any short-circuit. Why: reply
  saying "it's sparking now" must escalate; safety net can't be skippable.
- **Fuzzy duplicates are never auto-closed.** Only exact `graph_message_id` matches
  auto-attach; thread replies attach to their request; sender/body-hash candidates
  require human confirmation. Why: wrong auto-close silently drops a customer
  request — mirror image of the wrong-auto-decline risk (RISKS #3).
- **Duplicate of an active emergency → append to original AND re-notify the
  emergency contact.** Never silently swallowed.
- **Design additions proposed for Phase 5 schema (not built now):** work_requests
  statuses `awaiting_info` / `needs_review` / `duplicate` (+ mandatory
  `duplicate_of_work_request_id` on `duplicate`); classification value
  `not_a_work_request`; events `request.info_requested`, `request.info_received`,
  `request.duplicate_flagged`, `request.triage_required`, `request.closed`;
  approval-matrix row `missing_info_followup` (mode draft, approver office admin
  [ASSUMPTION — boss §11 may revise]). Full list: WORKFLOW_MAPS.md invariant 6.
- **No intake auto-acknowledgement email in v1** — it would be an auto-send; parked
  in TASK_BACKLOG future improvements.
- New open questions: B10 (required fields per request type), B11 (follow-up nudge/
  close policy), B12 (emergency ack timeout + fallback order), W1–W3 (design-level).

## 2026-07-17 (boss-priority finding — challenges Phase 4 MVP)

- **Finding (not yet a decision):** boss's #1 removable task = daily punch
  verification + job-number entry into ExakTime (~1 hr/day). Wants ~1-mile geofence
  validation. This is Workstream A, mostly built. **MVP-priority challenge for Phase
  4:** candidate first demo = daily attendance exception report (wrong-site +
  overtime flags + job-number sync) — zero Entra/Graph blockers, direct hit on
  boss's stated pain — with email-triage pipeline second. DECIDE IN PHASE 4, not
  before. Interview closer 2 ("mistake automation must never make") still unasked.
- Working model in CURRENT_WORKFLOW.md affirmed broadly correct (values still open).

## 2026-07-17 (Phase 2 permissions session)

- **Multi-role via `user_roles` join table.** One human, many hats (office admin +
  dispatcher likely same person). Existing `users.role` kept for Workstream A during
  migration; Workstream B RLS reads join table. Migration design in Phase 5.
- **Customer = email-only actor in MVP.** No login, no portal. M365/Outlook carries
  customer communications including most of the invoicing pipeline. Portal = future.
- **Sysadmin (Jack) barred from business approvals in production.** Keeps audit
  trail meaningful. Test-phase exception: fixture data only.
- **message_policies gets amount-threshold column now.** Cheap to design in; values
  stay empty until boss answers interview §3 (approval limits by job value).
- **v1 invoice flow confirmed:** system drafts invoice record → human creates real
  invoice in QuickBooks manually, sends via Outlook → marks sent in system. System is
  status-tracker only until QB/Graph integration (Option B).
- STAKEHOLDERS_AND_PERMISSIONS.md structure approved; only B2-dependent facts open.
- BOSS_INTERVIEW.md capture sheet created (12 rounds, maps to B#/I# question IDs).

## 2026-07-17 (Phase 1 discovery session)

- **Auto-decline disabled entirely until owner approves verified territory rule set.**
  Out-of-territory → drafted decline for human review, even for seemingly definite
  rules. v1 ships with zero auto-sends until that approval. Why: territory data is
  SAMPLE; real rules live in owner's head; wrong auto-decline = lost revenue.
  *Refines 2026-07-16 "v1 auto-send = out-of-territory decline only" — the auto mode
  remains the design target but is feature-flagged off pending owner sign-off.*
- **MVP intake is email-first; phone intake is a future workflow.** Phone is the
  larger channel (~10–20 calls vs ~3–10 emails/day, unconfirmed) but email is written,
  classifiable, auditable. MVP explicitly does not claim to solve intake. Bridge:
  manual intake form for office staff to enter phone requests into the same
  work_request pipeline — scope it in Phase 4 as shortly-after-MVP.
- **Territory rules must be extensible from day one**: zips, towns, counties, mileage
  radius, per-customer + per-job-type exceptions, recorded reason for every
  accept/decline/escalate.
- **Permissions designed per-role, not per-person.** Several roles are likely the same
  human; org chart unconfirmed. Phase 2 defines role capabilities that survive any
  headcount answer.
- **Current-state workflow documented as WORKING MODEL** (CURRENT_WORKFLOW.md), not
  fact. Confirmation checklist = ASSUMPTIONS_AND_OPEN_QUESTIONS.md sections A–C.

## 2026-07-16 (grill session — previously in SESSION_HANDOFF.md)

- Cutover: 2 matching parallel pay periods vs ExakTime; ExakTime = fallback.
- Boss's scope = request→invoice pipeline (email formalized in USER_WORKFLOWS.md).
- v1 auto-send: out-of-territory decline ONLY; all else drafts; final invoice never auto. *(Refined 2026-07-17 — see above.)*
- Emergency detection = required MVP; configurable contacts; no troubleshooting advice ever.
- Shared mailbox ≠ shared calendar; dedicated requests@ mailbox preferred; owner inbox untouchable.
- Pricing: placeholders only; source + last-updated mandatory; incomplete pricing blocks send.
- QuickBooks: Option B (integrate after core workflow) — see INTEGRATIONS.md.
- Fixtures-first email build; Entra app registration = blocking dependency for all real-mail work.
