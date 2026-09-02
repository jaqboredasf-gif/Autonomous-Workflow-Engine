# Decision Log

Append-only. Newest first. Format: date — decision — why — supersedes (if any).

## 2026-07-26 (Task B5 — approval queue UI)

- **B5 ships the approval queue only; the requests inbox is split out as B5b.**
  The backlog entry named two pages. The queue is the half that gates every
  outbound message, and one small production-shaped page with real guards beats
  two thin lists. Narrows TASK_BACKLOG B5 (2026-07-17); B5b is filed `ready`.
- **The UI is a mirror, never an authority.** Every guard in
  `apps/web/src/lib/approval-queue.ts` is already enforced by `record_approval()`
  and RLS; the module decides only what to *offer* a human. Where the two
  disagree the database wins and the page shows its raised error verbatim.
  Hiding a button is not a security control — so slice 5 re-proves every guard
  over the browser's own credentials rather than trusting the client code.
- **Zero database changes in B5.** No migration, no new policy, no new RPC. The
  queue reads through the existing admin SELECT policies and writes only through
  0015's `record_approval()`. Repo↔live stay in sync at 0001–0015; drift check
  after the slice: 24 base tables, unchanged.
- **Audit history is reconstructed from the message row, not from
  `integration_events`.** That table is service-role-only by design (0009), so
  reading it from a browser would mean weakening its RLS or shipping a
  service-role key to the client. The row's write-once attribution columns carry
  the same facts (who / when / why) and 0015's transition guard makes them
  set-once, so this is evidence rather than a retelling. Cost: the queue cannot
  show events that have no column (none today). Rejected alternatives: a
  security-definer audit RPC (needs a live migration — human-gated, and B5 did
  not need one) and a client policy on `integration_events` (weakens RLS).
- **The queue calls `business_role_matches()` instead of re-implementing the role
  mapping.** One call per distinct approver role in view. An unresolved
  capability counts as NOT held (fail closed). This keeps the Phase 5
  `user_roles` migration a one-place change, as 0015 intended.
- **TEST mode is symmetric.** In TEST only fixture rows addressed to
  `@example.invalid` are decidable; in LIVE a fixture is not decidable at all.
  A test deployment must not be able to approve real customer mail, and a
  production deployment must not approve a fixture as though it were real. The
  TEST half is the B3 engine's `enforceTestMode()`, imported rather than
  restated, so there is one definition of fixture-safety in the repo.
- **A decision is believed only after a re-read.** `verifyDecisionApplied()`
  checks the row actually moved to the expected status after the refresh; an RPC
  that returns success while the row stays in `draft` is reported as a failure.
  Same posture as B2's Verify Step (2026-07-20).
- **The web app imports the offline engine directly** (`apps/web/src/lib` →
  `scripts/lib/approval-matrix.mjs`), and Runner 5 imports the TypeScript module
  the page ships (Node 24 strips types). Verified both directions build and run.
  This is the alternative to B3's dual-implementation problem: no mirror, no
  parity lint needed for the shared parts — there is only one copy.
- **SECURITY, found while checking whether the browser could read the event
  log**: the live DB carries 16 undeclared `*_org_{select,insert,update,delete}`
  policies on `integration_events`, `time_entry_audits`, `crews` and
  `crew_members` — orphan-schema residue that 0012 (2026-07-17) did not clean
  up. They check `current_org_id()` with **no role gate**, so any authenticated
  org member qualifies. Verified live in rolled-back transactions as the fixture
  `worker`: 310 events readable, 11 `message.approved` events deletable, a
  forged event insertable. Filed as **S1**, NOT fixed this session: dropping
  objects on live is a destructive, human-gated action (CONTEXT standing rule),
  and authoring an unapplied migration would break the repo↔live sync invariant.
  Remediation SQL is in the backlog entry.
- **`npm run lint` (apps/web) is broken repo-wide and was not "fixed" by
  weakening it.** `eslint-config-next` requires a parser Next 16 does not ship.
  Confirmed pre-existing by stashing B5 and re-running. Filed under AR; the
  production build still runs TypeScript strict checking, which is green.

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

## 2026-07-20 (Task B2 — classification harness + Runner 2 evals)

- **Standalone classification module, not MCP-first.** `scripts/classify.mjs`
  (thin entrypoint) → `scripts/lib/classification.mjs` (domain service) with an
  injected model adapter (`scripts/lib/model-adapters.mjs`). MCP/n8n reuse the
  same `classify()` later; wrapping is out of B2 scope. Why: logic must be
  provider-agnostic and unit-evaluable without n8n or a live model.
- **Runner 2 split 2A/2B.** 2A (`eval-classification.sh`) = deterministic, fixture
  adapter replays recorded outputs, real DB persistence + Verify Step, **in
  regression** (regression-safe via idempotent `fixture:<name>` ingest). 2B
  (`eval-classification-live.sh`) = live paid inference, key-gated, **not in
  regression**. Why: measure harness correctness deterministically every run;
  measure model quality only on demand. **2A's accuracy line is a smoke check,
  NOT a quality gate — real accuracy comes only from 2B.**
- **New intake events (migration 0013):** `request.triage_required` (status →
  needs_review) and `duplicate_flagged` (duplicate_of set, not auto-closed).
  Additive CREATE OR REPLACE of `emit_work_request_events`; existing emits
  unchanged (acceptance-slice3 still 20/20).
- **Duplicate detection scoped to the fixture corpus** (`graph_message_id LIKE
  'fixture:%'`) so 2A is deterministic and isolated from accumulated slice/
  production rows. Production scoping (all real inbound per sender) is wired at
  the MCP/n8n boundary. Known limitation, documented in EVAL_STRATEGY.md.
- **Fixture 08 status deviation (label vs pipeline).** Label
  `expected_status=duplicate`; pipeline yields `needs_review` + linked
  `duplicate_of`. Intentional — honors the locked rule that fuzzy/content
  duplicates are NEVER auto-closed (a human sets `duplicate`). Classification
  (the gated field) matches the label. Label left unchanged (changing a label is
  a reviewed decision, not a test fix).
- **B2 DoD = implementation complete / deterministic eval green / live eval
  pending credential.** No `ANTHROPIC_API_KEY` in-env → 2B unrun. Missing key is
  an **external execution dependency, not an architecture blocker**. B2 is NOT
  "fully evaluated" until 2B runs with a real key. No env file modified; the var
  is documented, not committed.

## 2026-07-20 (Task ADR — Approval Diff & Reasoning, offline evidence slice)

- **Offline evidence slice first, Graph capture second.** This session built ONLY
  the offline substrate: migration `0014_approval_evidence.sql`, a pure engine
  `scripts/lib/approval-diff.mjs`, labelled `fixtures/approvals/*.json`, and
  deterministic Runner 3 (`eval-approval-diff.sh`). ZERO Graph, ZERO network, ZERO
  send. Draft→sent mailbox pairing + Sent-Items subscription are the deliberate
  NEXT isolated task. Why: the diff logic and schema are evaluable and safe with
  no mailbox access; capture adds real-world risk and belongs in its own session.
- **`material` is class-driven, not a ratio threshold.** material = any edit class
  other than `formatting_only`/`tone`. Those two are cosmetic; a big reword trips
  `major_rewrite` (material) via `edit_ratio ≥ 0.60`. Malformed input fails closed
  → material=true (never silently "unchanged"). Rationale: material must mean "the
  AI got something a human had to fix," the exact signal that gates graduation.
- **Deterministic heuristic classifier, evidence-grade not judgment-grade.** 10
  fixed edit classes via regex/keyword over the content-token symmetric diff;
  multiple may fire (`ambiguous` flags it). Sentence-initial capitals excluded from
  entity detection (no real NER). Limits documented in APPROVAL_DIFF.md — this is
  offline evidence, not a semantic judge.
- **`category_authority` stores graduation, never performs it.** authority_level is
  human-set (default `draft_only`); NO trigger/update writes it. Counters are a
  cache a future *reviewed* job may fill. Honors the lock: no autonomous sending or
  graduation logic beyond the offline evidence schema.
- **No hard deletes, enforced twice.** RLS default-deny (no delete policy) PLUS a
  `before delete` guard on both evidence tables (blocks even service role).
  Evidence tables immutable after insert (corrections = new rows), same rule as
  `email_messages` (0011).
- **Migration validated offline; live apply is human-gated.** No psql/supabase/
  docker in-env, and applying schema to live Supabase from an isolated session is
  an irreversible outward action. `scripts/lib/validate-migration-0014.mjs` does a
  deterministic structural lint (PASS, in regression); live apply left to a human,
  same posture as B2's Runner 2B credential gate. Runner 3 (the slice's completion
  bar) is fully offline and passes independently.

## 2026-07-26 (Task B3-live — 0014+0015 applied live, acceptance slice 4)

- **Live schema apply is gated on authorization, not on tooling.** Earlier sessions
  recorded live apply as impossible in-session ("no psql/supabase CLI/docker"). Half
  true: there is no CLI, but the Supabase **management query API executes DDL** with the
  token already in `.env.acceptance`. Verified by probe (`begin; create table …;
  rollback;` → executed, no residue). So the standing rule is restated: applying schema
  to the live project is a **human-gated outward action requiring Jack's explicit
  go-ahead per migration**, not a capability limit. Jack authorized 0014 + 0015 on
  2026-07-26 and they were applied in that order.
- **Dry-run every live migration inside a rolled-back transaction first.** Both files
  (1005 lines) were piped as one `begin; 0014; 0015; rollback;` against the live schema
  before the real apply: zero errors, and a follow-up query confirmed zero tables and
  zero enum types left behind. This is now the documented pre-apply step in CONTEXT.md.
  Why: it converts "the lint says the SQL is well-formed" into "the live database has
  actually executed this SQL", at no risk.
- **RLS is testable without provisioning a second real login.** Inside an uncommitted
  transaction, `set local role authenticated` + `set local request.jwt.claims` makes
  RLS evaluate as any chosen user (`auth.uid()` reads the claim; `current_role_is()` /
  `business_role_matches()` read `public.users`, which has no FK to `auth.users`). Slice
  4's `as_user()` helper uses this, so proving "non-approver blocked" needed no new auth
  user, no password, and no permanent grant. One fixture `users` row (role `worker`) is
  the only live footprint.
- **A guard that fires on zero rows proves nothing.** The first slice-4 run failed on
  "approval_drafts hard delete refused" — not a schema defect: the table was empty, so
  the `before delete` trigger never fired and the delete trivially succeeded. Fixed by
  seeding a row and asserting the row exists before attempting the delete. Standing
  lesson: every negative test must assert it actually targeted something.
- **Parity over vocabularies is not parity over logic — and coverage must be asserted.**
  `route_outbound()` (SQL) and `route()` (JS) are now compared branch-by-branch on live
  data by `scripts/parity-route-live.mjs`. Perturbation exposed a hole: because every
  live `approval_limit_cents` is NULL, changing the JS engine's `amountCents >` to `>=`
  caused **zero** mismatches — the limit/escalation branches were unreachable. So a
  second pass routes a fully-configured matrix inside a rolled-back transaction (39
  mismatches under the same perturbation), and check 14c asserts the escalation and
  backup branches were actually exercised. B3's dual-implementation risk is retired.
- **A 429 from the management API is a throttle, not a test result.** Adding slice 4
  (~60 mgmt queries) pushed Runner 2A over the per-minute limit and it reported a fake
  0/12. Fixed at the source: `scripts/lib/db.mjs` retries 429/5xx with capped
  exponential backoff, slice 4 backs off on throttle, and regression.sh pauses 45s after
  slice 4. This also explains the "transient 429 on 2A" the ADR session saw and worked
  around by re-running.
- **The open questions stay open and stay fail-closed.** Real approval limits (boss §3)
  and the `estimate_proposal` approver remain unknown; the live matrix keeps every
  `approval_limit_cents` NULL and that approver NULL, and slice 4 checks 3/3c/14d assert
  the resulting blocks are real. The draft→auto graduation test runs in a rolled-back
  transaction precisely so the live matrix stays all-draft. Entra (I1) remains blocked —
  no Graph work was started.

## 2026-07-26 (Task B3 — approval matrix + outbound drafts, offline slice)

- **B3 built offline-first, same posture as ADR.** Migration `0015_approval_matrix_
  outbound.sql` + two pure engines (`scripts/lib/approval-matrix.mjs`,
  `scripts/lib/outbound-draft.mjs`) + labelled `fixtures/outbound/` + deterministic
  Runner 4, with ZERO Graph, ZERO network, ZERO send, ZERO live-DB writes. Why: the
  routing rules, the draft templates and the gate are fully evaluable with no mailbox,
  no model key and no database, and the environment has no psql/supabase CLI/docker.
  Applying schema to live Supabase from an isolated session stays a human-gated
  outward action (B3-live in TASK_BACKLOG).
- **An unconfigured responsibility is a first-class blocked state, never a default.**
  `approver_role` and `approval_limit_cents` are nullable and the v1 seed leaves the
  limits NULL everywhere and `estimate_proposal.approver_role` NULL (its approver is
  still an open [ASSUMPTION], B2/§3). Routing then fails closed with
  `missing_approver_role` / `missing_approval_limit` rather than guessing a ceiling or
  falling back to "any admin". A guessed spend limit is worse than a blocked draft.
- **Blocked ≠ dropped.** Gate-level refusals (unauthorized action, duplicate key,
  draft build failure, forbidden content, TEST-mode violation) refuse BEFORE any write.
  Routing-level refusals deliberately WRITE a `blocked` row with `blocked_reason` +
  `message.blocked`, so an unroutable message surfaces in the human queue instead of
  vanishing. The distinction is asserted per fixture (`persist: none|blocked_row`).
- **`effective_mode` is always `draft`, even when the policy row says `auto`.** The
  graduation flip is stored and REPORTED (`policy_mode`, `auto_downgraded`) — that is
  the backlog's "flips draft→auto without a code change" criterion — but zero v1
  auto-sends is enforced in code, in both the engine and `route_outbound()`. Storing a
  future decision and acting on it are separate things. `final_invoice` can never hold
  `auto` at all (CHECK), and `auto` anywhere requires both a named approver and a
  configured limit.
- **`mark_message_sent()` is a ledger entry, not a transmission.** It records that a
  human copied an approved draft into Outlook and sent it — identical to the v1
  invoice flow. It refuses any message not in `approved`, so the send ledger can never
  contain a message nobody approved. No send machinery exists in this slice, and
  Runner 4 asserts that structurally (source-purity gate over both engine modules).
- **Automation cannot approve, enforced by the auth boundary.** `record_approval()`
  requires `auth.uid()` to resolve to a `users` row holding the assigned approver role;
  a service-role runner has no JWT and raises. There is deliberately NO insert/update
  RLS policy on `outbound_messages` — every state change goes through the
  security-definer RPCs so the transition guard, authorization check and audit event
  cannot be bypassed.
- **Content safety is enforced, not prompted.** Every rendered draft is scanned for
  electrical troubleshooting instructions (REQUIREMENTS: never sent) and blocked with
  `forbidden_content`. The scan covers interpolated customer text, because inbound
  email content is untrusted data, never instructions.
- **TEST mode is a hard gate, not a convention.** Recipients must be `@example.invalid`
  (RFC 6761, permanently unresolvable) and rows must be `is_fixture`; violations refuse
  before any write. Fixture-safe synthetic identities only — no real customer or
  employee data was used.
- **Business roles get a vocabulary now, a join table later.** `business_role` enum (9
  roles — the 10 STAKEHOLDERS roles minus `customer`, an email-only actor with no login
  who can never be an approver) is what `message_policies.approver_role` references, and
  `business_role_matches()` is the SINGLE interim mapping onto today's
  worker/foreman/admin. The Phase 5 `user_roles` migration replaces that one function
  and nothing else.
- **Dual implementation accepted, with a parity lint.** Routing exists in SQL
  (`route_outbound()`) and JS (Runner 4 needs zero DB access). `validate-migration-0015.mjs`
  asserts identical message-type, business-role and blocked-reason vocabularies (missing
  OR extra both fail). Branch-logic divergence is still possible and is exactly what
  acceptance slice 4 (B3-live) must retire.

## 2026-09-02 — Manual intake bridge (temporary production bootstrap)

- **Email-first remains the target MVP intake architecture.** This decision does
  NOT reverse the 2026-07-16 lock ("MVP intake is email-first; phone intake is a
  future workflow"). That same locked decision already named this bridge:
  "manual intake form for office staff to enter phone requests into the same
  work_request pipeline — scope it in Phase 4 as shortly-after-MVP." Migration
  0016 is that bridge being built, not a change of direction.
- **Why now**: Graph inbound (B9) is blocked on an Entra app registration owned
  by IT. Verified 2026-09-02 that until it lands NOTHING can enter AWE in
  production — no UI created an `email_messages` or `work_requests` row, and
  every insert path was an acceptance script running as service-role. Every
  downstream capability (classification, approval queue, B5c send recording) was
  therefore unreachable in real use.
- **Scope**: one authorized, audited, operator-attributed door —
  `create_manual_work_request()` behind `/requests/new`. It reuses the existing
  work_request pipeline and its insert triggers rather than duplicating any
  downstream logic.
- **A manual record can never masquerade as email.** `email_messages.source` is
  an explicit enum (`graph` | `manual` | `fixture`) and 0016's shape constraint
  forces a manual row to carry a NULL `graph_message_id`, `is_fixture = false`,
  a named author and a real-world `source_reference`. Real customer data is
  never labelled synthetic, and a forged email row is structurally impossible.
- **The real-world origin gets its own field.** It does NOT go in `from_addr`,
  because `apps/web/src/lib/approval-queue.ts` falls back to `from_addr` as a
  reply RECIPIENT and `scripts/lib/db.mjs` matches on it for duplicate
  detection. A phone number in that column could address a reply to a phone
  number.
- **This must not become the default long-term intake path merely because it
  exists.** When Graph inbound ships, stop calling the RPC; rows already created
  stay valid and stay labelled `source = 'manual'`, so history remains honest.
  Do not build features that assume manual entry is the normal way in.
- **Not authorized by this decision**: auto-classification on manual intake,
  automatic outbound draft creation, or any send. Manual intake records what a
  human was told and stops there; `classification` stays `unknown` exactly as it
  would for an unprocessed email.
