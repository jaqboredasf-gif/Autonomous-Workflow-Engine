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

## 2026-08-12 (go-live pass — decisions rescued from stale session handoffs)

`PCC_NEXT_SESSION_HANDOFF.md`, `PCC_NEXT_SESSION_PROMPT.md` and
`SESSION_TRANSITION_COMMANDS.md` were untracked working notes from an earlier session,
pinned to commit `b5e1a60` and to test counts and a lint problem that no longer describe
the repository. Everything in them was either implemented (BR-011, Lippolis branding, the
dashboard hierarchy, the provider seams), documented elsewhere (`PCC_PERMISSION_MATRIX.md`,
`PCC_UI_HANDOFF/`, `docs/deployment/`), or obsolete. They have been removed so the
repository has one obvious source of truth for installation.

Two product decisions from those notes were NOT recorded anywhere else and are still true
of the code, so they are preserved here rather than lost:

- **Priority is derived from the need-by date, not entered by the requester.** There is no
  priority field for somebody to set. `domain/dashboard.mjs` computes urgency and overdue
  state from `needByDate`/`needByTime`. This is deliberate — a self-declared priority field
  becomes "everything is urgent" within a fortnight — and it should not be changed casually.
- **A requester's preferred vendor is stored as an attributed note, not written to
  `vendor_id`.** `withVendorSuggestion()` in `app/actions.ts` appends the suggestion to the
  request notes. The vendor on a purchase order is the workshop's decision, recorded during
  review; letting the field firewall be crossed by a requester's suggestion would make the
  request's vendor and the order's vendor the same field, and the audit trail could no
  longer show that purchasing chose differently.

Also settled in this pass, and recorded because it changes application behaviour:

- **A purchase order cannot be generated while the PO sequence is the built-in
  placeholder.** `po_number_sequences.initialized_at` is null until an administrator saves
  the office's own number; `application/fulfilment.ts` refuses allocation with
  `po_sequence_uninitialized` while it is. The demonstration seed sets it (so development
  and the eval suites work); the production bootstrap does not. The difference is data, not
  an environment check.
  **SUPERSEDED 2026-08-13** — see *The Lippolis PO numbering rule* below. The guard was
  protecting a real risk against the wrong model, and went with the model.

## 2026-08-13 (second pass) — making the numbering rule safe for real Lippolis data

The rule itself was already implemented and is unchanged. This pass closed the gaps between
"correct" and "safe to hand to an office", and all of them were about what happens when a person
is involved.

- **The pilot store had no fence on the identifier.** Postgres has made `po_number` permanent by
  trigger since 0016; SQLite — the thing that actually runs at Lippolis — had a comment claiming a
  service-layer guard that was never written. Nothing in the application updates those columns, which
  is exactly why the absence was invisible. `purchase_orders` now carries the same two triggers in
  both providers: the number, its three components and its request cannot be changed, and the row
  cannot be deleted. A purchase order that can be deleted is a number that can be issued twice.

- **The upgrade rebuild silently dropped those triggers.** `drop table` takes a table's triggers
  with it, and the rebuild that retires the old global uniqueness recreates the table — so the
  databases *most* recently migrated would have been the ones running unguarded, until the next
  restart re-ran SCHEMA. Triggers are now carried across with the indexes, and asserted after the
  rebuild rather than after a restart.

- **"No paper history" was unrecordable.** A pair with no declaration and a pair the office had
  checked and found new were the same row — absent. `initializePoSequence` with a next number of 1
  now records the decision (`declarePoPairNewAction`), which changes no count and is the entire
  point: it converts an open question into an answered one. Without it the go-live check can only
  ever say "this might be a problem", which is the kind of warning operators learn to skip.

- **A pair already in use could be moved forward silently.** Moving one is legitimate — an office
  reconciling a gap after an outage — and a bad accident, and the two are told apart only by whether
  the person had seen the orders already out there. Refused with `sequence_already_issued` naming
  the count and the most recent number, unless acknowledged. Backwards stays refused regardless.

- **The format is duplicated in exactly one other place, and now it is fenced.** Postgres has to
  build the number inside `next_po_number_for()` for the allocation to remain a single statement, so
  `formatPoNumber` is not literally the only implementation. The migration validator asserts the SQL
  expression against the domain's own `PO_NUMBER_SEPARATOR` and against `formatPoNumber`'s output,
  so changing one without the other fails the suite. A future change of separator or casing from a
  real Lippolis PO is a two-line edit in known places, not a hunt.

- **Vendor codes derived but never chosen are now surfaced.** A code identical to what PCC derives
  from the name has never been looked at by the office. The verifier re-derives and reports them —
  detecting the fact rather than recording that somebody opened a screen — because after a vendor's
  first purchase order its code is frozen.

**The verifier now sorts every pair into four states** — in use, continued from paper, confirmed
new, unresolved — and separately lists active jobs nobody has been asked about, each with the exact
operator action. Reported per job rather than per possible pair: the vendors a job will use are not
knowable in advance, and a screenful of job × vendor combinations is noise that trains people to
skip the section. Pairs and jobs appearing after go-live are ordinary business and are not flagged.

## 2026-08-13 — the Lippolis PO numbering rule, from Mike and Paul

**A purchase order number is `job number + vendor + a sequence that counts from 1 for that
pair`.** `1234-COOPER-1`, `1234-COOPER-2`, `1234-GRAYBAR-1`, `5678-COOPER-1`. Given directly by
the purchasing stakeholders on 2026-08-12; implemented as given.

**What it replaced.** A single per-organization counter formatted `LE-52901` — a placeholder
standing in for an answer nobody had, guarded by a refusal (`po_sequence_uninitialized`) until an
administrator supplied "the next number from the paper book". The guard was right about the
danger and wrong about the shape: there is no one Lippolis sequence, so there was never a single
number to supply.

**Decisions taken in implementing it, and why:**

- **The vendor's code is a stored field, not a derivation.** `vendors.code` / 
  `purchase_vendors.code`, derived from the display name once and then frozen. A code recomputed
  from the name would renumber a supplier's paperwork the day somebody corrects a spelling. It is
  unique per organization, and changeable only until the vendor's first purchase order.
- **The derivation does not abbreviate.** `Cooper Electric Supply Co.` becomes
  `COOPERELECTRICSUPPLYCO`, not `CESC`. An abbreviation invented here would be a name nobody at
  Lippolis chose, printed on a supplier's paperwork. Where the office wants a short code, an
  administrator sets it — a decision with a person behind it.
- **The job segment keeps its hyphens** (`24-118`), because that is what is on the drawing. The
  identifier is still unambiguous: a vendor code can never contain a hyphen, so `parsePoNumber`
  splits from the right.
- **No zero-padding**, and no configurable prefix or suffix. The stakeholder examples are
  unpadded; padding would have been an invented format.
- **Allocation is one statement.** An upsert with `RETURNING` per (org, job, vendor), inside the
  transaction that writes the order — SQLite under `begin immediate`, Postgres in
  `next_po_number_for()`. The compare-and-set it replaced was safe against a lost update but could
  fail spuriously under contention; this cannot, and the concurrency gate now asserts *no gap* as
  well as *no duplicate*.
- **`unique (org_id, sequence_value)` on `purchase_orders` had to go**, replaced by
  `(org_id, job_number, vendor_id, sequence_value)`. Under the real rule `1234-COOPER-1` and
  `1234-GRAYBAR-1` both carry sequence 1 and neither is a duplicate. SQLite cannot ALTER a
  constraint away, so `database.ts` rebuilds the table from its own `sqlite_master` definition —
  keeping the foreign keys and checks that reconstructing from `pragma table_info` would silently
  drop — and runs `pragma foreign_key_check` afterwards.
- **The components are snapshotted onto the order** (`job_number`, `vendor_code`,
  `sequence_value`) beside the permanent `po_number`. A number stays explainable years later
  without depending on the directory still saying the same thing.
- **Allocation happens at issuance only.** Viewing a request, refreshing the page or abandoning a
  draft burns nothing; asking twice returns the same number without advancing the counter; a
  failed transaction rolls the counter back with it. An issued number is never reused.

**What remains a business question, and is now the only one:** whether any job-and-vendor pair
PCC will be used for already has purchase orders written on paper. For those pairs an
administrator sets where the count had reached (Administration → PO numbering) — forward-only,
refused at or below anything PCC has issued, audited. `pcc-verify-production.mjs` lists every pair
about to issue its first number, so the question is asked by the go/no-go check rather than
remembered.

## 2026-08-12 (build mode → deploy/observe/refine mode)

**PCC feature development stops being speculative from this point.**

The application-controlled work is finished: the production-readiness pass, the restore
rehearsal, deployment idempotence, the placeholder-PO guard, the data-outside-checkout
guard, the installation runbook, the preflight and the storage tooling all exist and are
tested. What PCC does not have is a single hour of real use by the people it was built
for.

Until it does, further feature work is guessing — and the repository has enough evidence
now to make that guessing unnecessary rather than merely unwise.

**From now, product changes should be driven by:**

- Phase A smoke-test failures — things that do not work on the real VM
- Phase B user friction — what Mike, Rick or a foreman actually stumbles over
- production defects — anything that misbehaves with real data
- purchasing stakeholder feedback — the office asking for something concrete
- operational evidence — logs, storage growth, backup timings, health history

**Explicitly NOT a reason to change PCC:** an architectural preference, a pattern that
would be tidier, a capability another system has, or a feature nobody has asked for. That
includes the two standing invitations in this repository — migrating to PostgreSQL and
extracting attachments to object storage. Both have documented, measurable triggers
(`PCC_PRODUCTION_ARCHITECTURE.md` §3 and §4). Neither trigger has fired. Doing either now
would trade a working simple thing for a speculative complicated one, days before real
users first touch it.

**This does not freeze bug fixes.** A defect is a defect and gets fixed. The distinction is
between *making PCC do what it already claims to do* — always in scope — and *making PCC do
something new* — which now needs evidence from an actual user.

The success condition for the next phase is not a feature. It is a fortnight of purchasing
that nobody had to work around.

## 2026-09-01 (AGENT_HANDOFF is retired; the canonical artifacts are the handoff)

**`AGENTS.md` required `docs/planning/AGENT_HANDOFF.md` to be updated before ending every
meaningful task. It has not been updated since 2026-08-05, it names a repository and a branch that
are not the ones being worked on, and a GitHub workflow fails any pull request that does not touch
it. The rule and the reality have disagreed for four weeks and the reality kept being right.**

Both designs were written out before choosing.

**A — restore the handoff as canonical.** Update it now, and update it every task. It is a single
file a person can read in two minutes, it carries the one thing no command reports — what the last
session was *trying* to do — and the CI check already exists.

Rejected, for one reason that is not effort: **it would be a second source of project truth.**
Every field the handoff carries except "current objective" is now derived by something that cannot
go stale. `npm run readiness` reports where the company stands. `npm run plan` reports what to do
next and why. `npm run deployment-gate` reports whether it can be installed. `npm run evidence`
reports what real evidence is missing. `git log` reports what changed. A hand-written file
restating those is a file that is *wrong between updates*, and the failure mode is the expensive
one: a person reads the stale version and believes it, because it looks like a status report and
status reports do not usually lie.

The 2026-08-05 file is the proof. It says the branch is `claude/lippolis-purchasing-dashboard-3ixte2`
and the objective is a management walkthrough of a prototype. Both were true. Neither has been true
since.

**B — retire the rule in favour of the canonical artifacts.** Chosen.

- `AGENTS.md` now names the commands an agent runs at the start and end of a task, and requires the
  one thing they cannot produce: a `DECISION_LOG.md` entry when a decision is made that the code
  does not explain by itself.
- `docs/planning/AGENT_HANDOFF.md` is stamped RETIRED at the top and kept. It is an accurate record
  of 5 August and deleting it would lose that; what it is not is a description of today.
- `.github/workflows/agent-handoff.yml` and `scripts/validate-agent-handoff.sh` are deleted. A CI
  check that requires every pull request to touch a retired file is a ritual that teaches people to
  edit a document without reading it, which is worse than no check.

**What was actually lost by choosing B:** the sentence "what the last session was trying to do".
That is real, and it is why the commit message convention in this repository is a full paragraph
rather than a subject line — the intent lives with the change that carried it, where it cannot go
stale, and `git log` is the reader.

## 2026-09-01 (evidence collection becomes a command, not a code edit)

**Four facts the readiness scorecard reads had no way in except hand-editing
`programs/iic-2027/facts.mjs`, and all four had sat at zero since the day that file was written.**

`narrative.plainLanguageTests`, `narrative.mockPitches`, `differentiation.alternativesAnalysed` and
`businessModel.unitDefined`. Each is cheap — five people and ten minutes each, four extra questions
in a conversation already happening — and each requires a person to open a JavaScript module
afterwards and type a number with a note. That never happened, and it was not laziness. **The
friction was the reason.**

**Three decisions, in the order they were made.**

**1. Alternatives and unit-of-sale go on the interview record, not in a new store.** They come out of
the same twenty minutes as the pain does. A second form asking again for the company name and the
date is a second form that stops being filled in, and the brief for this work said as much: do not
make Jack re-enter the same facts. So `interview()` gained two optional blocks, `alternatives[]` and
`commercial{}`, and `programs/discovery/` gained two analyses over them.

**2. The capture format is a field sheet, not JSON and not a UI.** `key: value` lines with the
allowed words written in a comment next to each key, fillable on a phone in a car park, converted by
`npm run evidence -- --import`. This is the pattern `scripts/baseline-import.mjs` already
established for stopwatch readings and it exists for the same reason: asking one person to produce
structured data *while* collecting evidence guarantees either bad evidence or none. **The importer
refuses rather than guesses** — an unknown key, a missing attribution, a value outside the enum,
each with its line number, and nothing is written until every one is fixed.

**3. The founder queue is a command, not a document.** The obvious deliverable was a file called
`JACK_EVIDENCE_QUEUE.md`. It was rejected for the reason the whole session exists: a written queue
is correct on the day it is written and quietly wrong afterwards, and the failure mode is that
somebody reads a stale list and does the wrong errand. `npm run evidence -- --queue` is regenerated
from the same facts as `npm run plan`, so it cannot disagree with it. Same argument for
`--snapshot`, which answers "if the pitch were tomorrow, what could we truthfully say" and derives
its list of prohibited sentences **from what is absent**, each one carrying the fact that would
retire it. A typed list of prohibitions goes stale in the flattering direction — the sentence stays
forbidden long after it became true — so people stop reading it.

**What was deliberately not built:** a CRM, a dashboard, a survey app, a second planner, a pricing
model, or anything that would let a well-received rehearsal look like market evidence.
`scripts/eval-evidence.mjs` asserts the last one directly: five glowing mock pitches move customer
discovery, problem evidence and external validation by exactly zero.

**One threshold was raised rather than lowered.** The `plain_language_test` evidence slot used to
fill on a single successful restatement. It now requires the first sample of five and empties
entirely on a CONFUSING sample, because a beat that goes green on one friendly result is a beat
everybody learns to ignore — and because evidence that the explanation does *not* work must never
look like partial evidence that it does.

## 2026-09-03 (a vendor email draft addressed to nobody)

**A purchase order could be recorded as emailed to a vendor who has no email address.**

`composeDraft()` builds a draft's recipients from the purchase order's primary vendor contact, and
a vendor is allowed to have none — `administration.ts` says so deliberately: *"a counter account at
a local supply house may have neither."* When there is none, `fulfilment.ts` passes
`[undefined].filter(Boolean)`, the draft is stored with `to_addrs = '{}'`, and nothing downstream
looked. `purchase_email_drafts.to_addrs` is `not null default '{}'` with no cardinality constraint;
the transition trigger checks the status graph and the freeze, not the recipients.

So the draft walked the whole path. `GENERATED → REVIEWED → APPROVED_TO_SEND`, then the email
screen offered *"Open in my mail client"* as `mailto:?subject=…` — **an empty To field, with no
warning** — followed by *"I sent it — mark sent."* The result was a `SENT` draft, a real
`sent_marked_by`, a request advanced to `ORDERED`, and an audit trail stating a vendor had been
contacted. No vendor had been. The first symptom would have been materials not arriving on a job,
and the first conclusion would have been that PCC lies.

**The refusal is on the authorisation, not on the draft — and that was the whole decision.**

Refusing to compose a draft with no recipient was the obvious fix and is wrong. `status.mjs` will
not let a request reach `ORDERED` without `hasReviewedEmailDraft`, so refusing composition would
strand every counter-account order at `PO_GENERATED` permanently — trading a false record for a
dead end, on exactly the vendors the product went out of its way to support. Reviewing the wording
of a purchase order you are about to hand across a counter is a real act. Claiming you emailed it
is not. `GENERATED → REVIEWED` therefore stays open and only `approveToSend` refuses.

**Written as a `guard`, not a `requires` entry.** `requires: ['hasRecipient']` would have matched
`markSent` and cost one line, but the engine renders it as `missing_evidence: approveToSend
requires hasRecipient`, and `actions.ts` puts `err.message` straight on the screen. A guard returns
`{reason: 'no_recipient', message: …}` — the same shape as `nothingOutstanding` in
`purchasing-workflow.mjs` — so the purchaser is told to add a contact email to the vendor and
generate a new draft. The draft froze at review, so the recipient list cannot be patched in place;
a corrected draft is a new draft, which is what the terminal-state comment already said.

**The button is hidden as well as the transition refused.** Not defence in depth for its own sake:
`advanceEmailDraftAction` returns `void` and the email page renders no error, so a refusal alone
would have been a press that silently does nothing — the same failure class being fixed. The
workflow is the gate; the hidden button is what makes the gate legible.

**No migration.** A `check (cardinality(to_addrs) > 0)` was considered and rejected. It would ban
the row rather than the claim, and `0026` already settled this: which transitions a draft may make
is the application's rule, and a policy that also encodes it is a second copy that will disagree.
The SQLite provider — the one Lippolis actually runs — would have needed the same rule written a
second way.

**Evidence.** `eval-workflow-engine` 238/0, `eval-purchasing-domain` 502/0, `eval-purchasing` 550/0,
`eval-proof` 282/0, `eval-second-customer` 235/0, `eval-purchasing-isolation` 174/0,
`eval-purchasing-web` 116/0, `eval-purchasing-authorization` 386/0, `tsc --noEmit` clean,
`npm run rehearse` COMPLETE, `npm run deployment-gate` unchanged at 4 blockers. Non-vacuity by
perturbation: deleting the guard line fails 2 checks in the workflow suite and 1 in the domain
suite; restored, both green.

## 2026-09-03 (the release candidate moves to the tip, and the branch documentation stops lying)

**`e69827a` was refreshed to `585b749` rather than signed.** The approval record's own instruction
is to *"either refresh the commit below to the tip or state deliberately that an older one is being
installed"*, and this was not a case for the second option: thirty commits separate them, and one
of them fixes a defect that would have recorded a purchase order as emailed to a vendor with no
email address. Installing the older candidate would have installed that. The rest of the thirty are
the Windows deployment line, second-organization provisioning, the evidence and discovery programs
and per-job-vendor PO numbering; none touches the schema, which stays at `0001`–`0038` with the
SQLite version unchanged at `0040-audit-interaction-id`.

**The signature block was left blank, and the reference hash was deliberately kept out of it.** The
gate reads `Approved by` and nothing else grants approval, so filling it in is the one thing this
session could not do. A build of `585b749` was performed and its sha256 recorded — but in the
*Before installing* section, labelled as something to compare a second independent build against,
not in the approval block. Writing it into the block would have let somebody sign without building,
which is the check the two-party hash exists to provide.

**`pcc-production` was fast-forwarded 56 commits onto the local tip.** It had sat at `58068f3`
(2026-08-18) while the branch it is cut from moved to 2026-09-01. Nothing was overwritten: the old
tip is an ancestor of the new one and the push was a fast-forward. `SOURCE_OF_TRUTH.md` was
corrected in the same pass, because it told operators that
`claude/purchasing-control-center` was "the earlier codex line, last updated 10 Aug 2026" and
superseded — while that branch was, in fact, where every commit since was landing. Load-bearing
documentation that is wrong about which branch is current is worse than none, and
`eval-source-of-truth.mjs` exists precisely because this document is the only thing between an
operator and installing the wrong code.

**Two preservation branches were pushed before anything else happened**:
`backup/purchasing-control-center-2026-09-03` (the 56 PCC commits) and
`backup/tegg-mock-sprint-2026-09-03` (6 commits whose remote branch had been deleted). Both are
untouched by the reconciliation above and exist so that no reading of this decision depends on
`pcc-production` having been moved correctly.
