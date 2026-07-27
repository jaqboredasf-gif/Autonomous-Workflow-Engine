# Decision Log

Append-only. Newest first. Format: date — decision — why — supersedes (if any).

## 2026-07-27 (K4/C1 — kernelized MCP surface + context primitives)

Code-only session on `feat/kernelized-mcp-context`. No database call, no
migration, no live change, no push. Committed locally (AGENTS.md permits it).

- **A tenant is stated, never discovered.** The MCP server's
  `from('orgs').select('id').limit(1)` is replaced by explicit resolution: an
  `org_id` argument on the call, or `AWE_ORG_ID` for the process. Both present
  and disagreeing is refused (`tenant_mismatch`); neither present is refused
  (`tenant_required`) before any data access. Rejected: keeping a single-tenant
  default "because there is only one org today" — that is precisely the
  assumption that fails silently rather than loudly on the day it stops holding.
- **The MCP server starts without credentials, in TEST mode, on fixture data.**
  It used to `process.exit(1)` on a missing key, which meant its tool surface
  could not be listed or tested anywhere the key was absent — including
  regression, where `mcp-smoke` had been failing. A server that enumerates its
  tools offline and refuses to touch live data without an explicit LIVE plus a
  stated tenant is both more testable and more fail-closed than one that dies at
  startup. Rejected: leaving the exit and permanently labelling the suite as
  credential-blocked.
- **A blocked MCP outcome is returned with `isError: true`.** A blocked run is a
  CORRECT run, so this is a deliberate slight abuse of the field: `isError` is
  how MCP tells a model "this did not give you what you asked for, read the
  body". A refusal returned as a success is a refusal a model will summarize as
  a result. The distinction is preserved where it matters, in the
  machine-readable `status` and `code`. Rejected: `isError: false` for blocked.
- **Context assembly refuses cross-tenant items by default; it does not filter
  them.** "We dropped the other tenant's row" and "we never had it" must not
  look the same afterwards. Filtering is available as an explicit opt-in
  (`on_tenant_mismatch: 'exclude'`) for an operator inspecting a mixed pool.
- **Nothing leaves assembly unaccounted for.** Every item that does not reach
  the bundle appears in `exclusions` with a reason from a closed vocabulary.
  Rejected: silent truncation to a budget, which is the standard behaviour and
  makes "the model didn't know" un-diagnosable.
- **Compaction is deterministic and model-independent, and a model-assisted
  compactor is a hook rather than a plan.** Six mechanisms, a full ledger, and
  three invariants the kernel enforces regardless of who wrote the summary text:
  a summary inherits the maximum sensitivity and the minimum trust of its
  inputs, and compaction never grows the context. Rejected: making an LLM
  summarizer the primary path, which would make replay impossible and bind the
  platform's memory to one vendor.
- **The token budget uses a pure character-based estimate, deliberately
  over-counting.** A budget that depends on a provider's tokenizer changes when
  the vendor does, which would make an assembled bundle unreplayable. Running
  out of budget early is recoverable; discovering the overflow at the provider
  is not.
- **`Date.parse` is permitted in the kernel; `Date.now()` and `new Date()` stay
  forbidden.** The ban is on READING the clock, not on parsing a timestamp the
  caller supplied. Age-based pruning needs to compare moments, and comparing ISO
  strings is wrong the moment two instants carry different UTC offsets.
- **The platform service layer is not a web server.** `@exattime/awe-runtime`
  exposes submit/inspect/artifact/audit/assemble/compact/checkpoint/resume as
  typed operations with every impure boundary injected. No HTTP, no routes, no
  framework: this repo has no server to hang them on, and speculative endpoints
  rot. Rejected: scaffolding routes now "so the app server has somewhere to go".
- **Still not decided, still ADR-0002:** who may invoke a tool, tenant
  authorization policy, capability grant semantics, approval thresholds,
  production enablement. The tool descriptor classifies a side effect and
  declares whether a tenant is structurally required; it carries no permission.
  Runner M asserts the absence of those fields mechanically rather than by
  review, so the boundary cannot erode quietly.

## 2026-07-27 (K2 — execution-kernel adoption + durable run artifacts)

Code-only session. No database call, no migration, no live change, no commit.

- **A run report is a control-plane record, not a second copy of the data.** The
  durable artifact carries the run's identity, status, machine-readable reason or
  error code, gate decisions and audit events — and the workflow's output only as
  a **digest**. Draft bodies, subjects, recipients and extracted personal data
  stay in the tables that already hold them under RLS. Rejected: embedding the
  result so artifacts are self-contained; that would publish customer content to
  a filesystem with no policy on it.
- **A durable write that did not land downgrades the run to `incomplete`.** It
  does not throw, and it does not let the run report itself `completed`. A sink
  failure is not a workflow failure, but a run whose evidence is missing is not a
  finished run either. Rejected: logging a warning and returning success.
- **The local filesystem is the FIRST artifact backend, not the chosen one.**
  `ArtifactSink`/`AuditSink` are kernel interfaces; the filesystem implementation
  lives outside the kernel (`scripts/lib/artifact-store.mjs`) because the kernel's
  layering lint forbids writes. Choosing the durable backend means choosing the
  harness DB access path = **ADR-0002, unratified**, so it was deliberately not
  chosen. See TASK_BACKLOG K3.
- **The execution context grants nothing.** `createExecutionContext` records who,
  which tenant, which run, which mode — and carries no capability list, tool
  permission, role check or tenant policy. Authorization stays where it already
  lives (approval matrix, RPCs, RLS) until the Tool Registry is unblocked. This is
  what let Phase 4's extension boundaries be built without pre-empting ADR-0002.
- **A LIVE run with no `org_id` is refused at construction.** That is the shape of
  the known MCP `orgs limit 1` defect (ADR-0002 condition 1); making it
  unconstructable is cheaper than detecting it later.
- **Classification refusals became first-class blocked reasons.** `fail_closed`
  and `hallucinated_fields` were flags a caller had to remember to read; they are
  now `classification_fail_closed` and `ungrounded_extraction` in the platform
  reason union (both already in the harness `BlockedReason` union, contracts §2.4).
  `classify()` itself is unchanged — Runner 2A still sees exactly what it saw.
- **`classify()` takes an injectable `db`.** Its keyword net and territory check
  are database functions, so the orchestration could not be exercised at all
  without credentials. A seam, not a behaviour change; every existing caller gets
  the default module.
- **`redact()` now scrubs credentials embedded in longer strings.** The value
  patterns were anchored, so `"rejected token eyJ…"` passed through untouched —
  which is exactly how tokens reach audit trails. Found by a non-vacuity
  perturbation, not by review. Whole-value behaviour is unchanged.
- **`pass` was removed from the secret-key deny-list.** `pass(word|phrase)?` matched
  the bare word `pass`, which is the name of every runner's pass counter — the
  first run report written said `"pass": "[redacted]"`. A deny-list that eats the
  evidence it exists to protect gets switched off, which is worse than a narrow
  one. `password`/`passphrase`/`passcode` still match, and an actual credential is
  still caught by value shape whatever its key is called. `token` was deliberately
  left in place: over-redacting a token count is cheap and is already pinned by a
  test.
- **Runner 4 and Runner 5 fail if their run artifact does not land.** Opting out is
  explicit (`AWE_ARTIFACTS=off`) and is reported, never silent.

## 2026-07-27 (H0 — ADR-0001…0009 review pass; RATIFICATION NOT GRANTED)

**No architectural decision was approved in this entry.** It records that the
review required by H0 exit criterion 10 was performed, and what it found. All nine
records in `docs/architecture/decisions/` remain `Status: Proposed` and carry no
authority. `AGENT_HARNESS_DOCTRINE.md` (D1–D20) and `AGENT_HARNESS_GUARDRAILS.md`
(G1–G20) therefore remain PROPOSED with them.

- **A session may not ratify its own ADRs.** The ADR README states `Proposed`
  "carries no authority", and proposed doctrine D2 states automation never approves
  its own work. An agent flipping these to `Accepted` would be the exact failure the
  harness exists to prevent. Ratification is Jack's signature plus a dated entry
  under this heading; nothing else grants it.
- **Review outcome (recommendations only, not decisions):** ADR-0001, 0002, 0004,
  0006, 0008 → Accept as written. ADR-0003, 0005, 0007 → Accept with a named
  amendment (below). ADR-0009 → Accept as a record; it decides nothing and its
  underlying choice is still open. No record is recommended for rejection.
- **Three defects found in the proposed set, all doc-level, none yet costed in
  code:**
  1. *Wall-clock semantics contradict.* Proposed D17 counts wall clock as a budget
     dimension terminating `failed` / `budget_exhausted`; G9 and ADR-0003 say a
     wall-clock lapse is `expired` and **resumable**. Terminal vs resumable for the
     same dimension. Fix by separating session `max_wall_seconds` (terminal) from
     lease expiry (resumable) before H11.
  2. *ADR-0005's growth bound does not hold.* It claims fixture row growth is
     "bounded by corpus size, not by run count", but proposed D11 makes
     `agent_steps` / `agent_tool_calls` / `agent_model_calls` insert-only, so a
     re-run appends a fresh ledger to the reused session. Step rows grow linearly
     with regression runs; the 100,000-row threshold is reached by run count.
  3. *ADR-0007 does not define the absent-row case.* `agent_harness_settings` is
     keyed per `org_id`; a new org with no row has no `enabled=false` to read. Must
     state that a missing row reads as disabled, or the opt-in default fails open.
- **Migration numbering conflict stands (ADR-0009).** `AGENT_HARNESS_H0_EXIT.md` §5
  allocates `0017`/`0018` to harness tables while Phase 1 C2–C4 may claim
  `0017`–`0019`. Documentation conflict today, cheap only while H2 is unwritten.
- **H0 documentation is untracked.** The entire H0 doc set exists only as untracked
  files on `chore/agent-handoff-integration` (superseded by
  `chore/agent-handoff-clean`, merged to `main` as `dbf8f17`). Preserving it in a
  documentation-only commit is a prerequisite to acting on it.

## 2026-07-27 (Task S1 — approval checkpoint prepared; live apply not authorized)

- **The live inventory still matches the exact expected pending state.** All 16
  named policies are present on `integration_events`, `time_entry_audits`,
  `crews`, and `crew_members`; all target `authenticated`; none are missing and
  no unexpected policy exists on the four tables.
- **The required pre-apply evidence is green.** Full regression: ALL GREEN
  (mobile typecheck, web build, MCP 10 tools, slices `9/0`, `10/0`, `20/0`,
  `49/0`, `27/0`, S1 `14/0 PENDING`, Runners `24/0`, `20/0`, `120/0`, `314/0`,
  `325/0`, both migration lints). The 20-assertion rehearsal and the promoted
  migration's own `BEGIN/ROLLBACK` dry-run each returned `[]`; post-rollback
  state remains 16 policies, RLS `4/4`, both required functions present, and
  zero S1 probe rows.
- **Migration 0016 is promoted for review, not applied.**
  `supabase/migrations/0016_drop_undeclared_client_policies.sql` contains only
  the approved 16-policy drop set plus read-only postconditions. Explicit
  approval remains required before the live management-API command is run.
- **Scope remains C1 only.** No C2 function ACL, C3 time-entry authorization,
  C4 MCP tenant binding, grant, trigger, table, row, or unrelated policy change
  was started.

## 2026-07-27 (Task S1 — documentation correction of the apply path; nothing applied)

- **The documented S1 apply procedure was unsafe and is corrected.**
  SESSION_HANDOFF and SECURITY_FINDINGS both instructed the next session to
  "run the rehearsal file with `rollback;` → `commit;`", and SECURITY_FINDINGS
  asserted the rehearsal was "identical apart from the final `rollback;` →
  `commit;`". **It is not identical.** Beyond the 16 `drop policy` statements the
  rehearsal deliberately mutates live data to prove the surviving paths still
  work: it emits an `S1.DEFINER_PROBE` event (B5), appends ` s1-probe` to the
  `notes` of every `approved` time entry and writes the resulting audit row (C1),
  and issues probe delete/insert statements against `integration_events`, `crews`
  and `time_entry_audits` (B2–B4, B7). Those are safe only because the file ends
  in `rollback;`. Following the documented instruction would have written every
  probe permanently into the production audit log — on a security task whose
  whole point is that the audit log must not be writable. Supersedes
  SESSION_HANDOFF "Next session" (2026-07-26) and SECURITY_FINDINGS § S1
  "Applied via the CONTEXT.md management-API recipe…" (2026-07-26).
- **One apply path, stated in one place, referenced everywhere else.** The only
  supported production path is now: move `scripts/s1-migration-0016-PENDING.sql`
  verbatim to `supabase/migrations/0016_drop_undeclared_client_policies.sql`,
  dry-run inside `begin; … rollback;`, apply with the CONTEXT.md management-API
  recipe, commit in the same session. That file is drops plus read-only
  post-conditions — no probes, no row writes — which is precisely what makes it,
  and not the rehearsal, committable against production. CONTEXT, SESSION_HANDOFF,
  TASK_BACKLOG and REGRESSION_CHECKLIST now point at SECURITY_FINDINGS § S1 "The
  only supported apply path" rather than restating a procedure each.
- **The prepared migration is the authority for the SQL, not the docs.** The
  backlog's abbreviated `drop policy` snippet is labelled illustrative, and
  SECURITY_FINDINGS' reproduction is labelled review-only; where a doc and
  `scripts/s1-migration-0016-PENDING.sql` disagree, the file wins. Two hand-copied
  SQL blocks in prose were a drift source on a destructive change.
- **Supersedes the 07-26 "no migration file was authored" position.** That was
  true when written; the 07-27 session authored one and parked it outside
  `supabase/migrations/` so the repo↔live sync invariant still holds and a stray
  `supabase db push` cannot reach it. TASK_BACKLOG's "Deferred deliberately"
  bullet is updated to say so.
- **Documentation-only session, by authorization.** No database write, no
  migration execution, no commit, no push, no workflow publication. The one
  known unsafe instruction left in the repo is the header comment of
  `scripts/s1-policy-cleanup-rehearsal.sql` ("the only difference between this
  and the live apply is the final statement (rollback -> commit)"), which is SQL
  and therefore outside this session's edit authority. It is logged as the sole
  remaining blocker and must be corrected before any apply session begins.

## 2026-07-26 (Task S1 — rehearsal of the undeclared-policy removal, NOT applied)

- **The session prompt's premise was wrong and was corrected rather than
  worked around.** It stated the previous session had dry-run the S1 removals.
  No such dry-run existed: clean working tree, last commit `75c43c6` (B5), no
  artefact, log or doc entry. Only the S1 *discovery* evidence existed. The
  rehearsal was performed from scratch and labelled as this session's work.
  Reporting a rehearsal that had not happened would have been the worst possible
  failure mode for a security task.
- **Confirmed the removal set is exactly 16, and that "undeclared" is provable,
  not inferred.** 55 live policies in `public`, 39 created by a
  `create policy` statement in `supabase/migrations/`, 16 not. Independent
  corroboration: all 16 are `TO authenticated` while **every** repo-declared
  policy is `TO public`; 0009 states in a comment that `integration_events` is
  service-role only; 0012 already removed the rest of that orphan schema.
- **Corrects the backlog's claim that the `time_entry_audits` exposure is
  vacuous.** Its policy's `EXISTS` subquery is itself subject to `time_entries`
  RLS, so a caller sees audits for precisely the entries they can see. Probed
  live as the owner of the only audited entry: `read=1 deleted=1
  forged_inserted=1`. Supersedes TASK_BACKLOG S1 "currently empty, so a delete
  test is vacuous" (2026-07-26).
- **`DROP POLICY` was proven safe by exercising the surviving paths inside the
  same transaction, not by reasoning about them.** `emit_event()` was called
  from an `authenticated` session after the drops and its row was confirmed
  written; a real `approved` time entry was updated and the audit trigger was
  confirmed to write exactly one row. Both are `security definer` owned by
  `postgres` on non-`FORCE` RLS tables. Catalog reasoning alone would have been
  a guess.
- **The acceptance suites cannot run inside the rehearsal transaction, and that
  limit is stated rather than papered over.** They reach the DB over separate
  HTTP connections (management API, PostgREST), so no transaction spans them.
  Substituted: (a) 8 behavioural assertions inside the transaction reproducing
  the same access patterns under the same principals — `authenticated` worker,
  the audited user, and `anon`; (b) a static proof that every `sql()` call in
  the acceptance scripts authenticates against the RLS-bypassing management API
  and no suite issues a client-JWT request against the four tables; (c) a full
  regression run as the pre-change baseline, ALL GREEN.
- **Rollback is re-creation, and it was rehearsed, not assumed.** `DROP POLICY`
  is unrecoverable after commit, so the rollback script was generated from
  `pg_policies` and round-tripped: snapshot → drop 16 → recreate → assert all 16
  identical on `(policyname, tablename, cmd, roles, permissive, qual,
  with_check)` → rollback. Recorded as break-glass only: restoring re-opens the
  vulnerability, and the right answer to a discovered consumer is a narrow
  role-gated policy in a new migration.
- **Still not applied, on purpose.** Dropping objects on live is destructive and
  human-gated (CONTEXT standing rule), and no migration file was authored
  because an unapplied migration breaks the repo↔live sync invariant. `0016`
  gets written and committed in the same session it is applied.
- **New doc: `docs/SECURITY_FINDINGS.md`** — the prompt asked for it and it did
  not exist. Live findings, per-policy inventory, evidence, exact SQL, risk
  table and rollback now live in one place instead of being spread across
  CONTEXT / backlog / handoff / regression checklist.

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
