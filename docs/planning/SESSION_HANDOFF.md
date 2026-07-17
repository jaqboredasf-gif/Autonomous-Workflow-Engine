# Session Handoff

Read CONTEXT.md first, then this, then all docs/planning/*.md. One approved task per session.

## Current state (2026-07-17, end of Phase 2 permissions session)

- Phase 2 DONE. STAKEHOLDERS_AND_PERMISSIONS.md approved (per-role
  view/create/approve/modify/send/delete matrix, 10 roles). Key decisions:
  user_roles join table; customer email-only (no portal); sysadmin no business
  approvals in prod; threshold column in message_policies; v1 invoice = draft record
  → human QB+Outlook → mark sent. Full entries in DECISION_LOG.md.
- BOSS_INTERVIEW.md created: 12-round fillable capture sheet for boss discovery;
  answers flow back into planning docs + clear ASSUMPTIONS_AND_OPEN_QUESTIONS rows.
- Next planning phase: 3 (workflow mapping). Recommend splitting: 3A = intake-side
  workflows (new request, emergency, out-of-territory, service call, estimate/
  proposal, job approval, failed-automation), 3B = delivery-side (scheduling, crew
  assignment, dispatch, completion, change order, payroll reporting, final invoice).
- Still no code changes. Task A2 build prompt below remains approved + pending.
- **Boss-priority finding (2026-07-17, post-Phase-2):** boss's #1 pain = daily punch
  verification + job-number entry into ExakTime, ~1 hr/day; wants ~1-mile geofence.
  Mostly Workstream A, mostly built. Phase 4 must weigh "daily attendance exception
  report" as first demo vs email triage. See DECISION_LOG + CURRENT_WORKFLOW §0.
  Interview closer 2 (never-make mistake) still unasked.

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

## Next planning session prompt — Phase 3A: intake-side workflow maps (recommended 2026-07-17)

> Read docs/planning/CONTEXT.md, SESSION_HANDOFF.md, DECISION_LOG.md,
> CURRENT_WORKFLOW.md, STAKEHOLDERS_AND_PERMISSIONS.md, USER_WORKFLOWS.md,
> ASSUMPTIONS_AND_OPEN_QUESTIONS.md, and RISKS_AND_EDGE_CASES.md. Planning-only
> session for the Autonomous Workflow Engine — no code, no dependencies, no schema
> changes. Execute Phase 3A (intake-side workflow maps): map SEPARATELY, one at a
> time — (1) new work request, (2) emergency request, (3) out-of-territory request,
> (4) service-call request, (5) estimate and proposal, (6) job approval, (7) failed
> automation / human correction. For each: trigger, actors (use
> STAKEHOLDERS_AND_PERMISSIONS roles), steps, decision points, approval gates (cite
> approval matrix), data written (cite DATA_MODEL tables), failure/edge cases (pull
> from RISKS_AND_EDGE_CASES fixture list), and what the human sees. Reuse and expand
> USER_WORKFLOWS.md Workflow 1 — do not contradict locked decisions (zero auto-sends
> until territory verified; emergency halts auto-scheduling). Deliverable: new
> WORKFLOW_MAPS.md with the 7 intake-side maps, updates to
> ASSUMPTIONS_AND_OPEN_QUESTIONS.md, DECISION_LOG.md, and this handoff, plus the
> exact Phase 3B prompt (delivery-side: scheduling, crew assignment, dispatch, job
> completion, change order, payroll reporting, final invoicing). Use the Grill Me
> skill; ask Jack at most 5 focused questions. Stop after Phase 3A.

## Next build session prompt — Task A2 APPROVED by Jack (2026-07-16)

> Read docs/planning/CONTEXT.md, then docs/planning/SESSION_HANDOFF.md and TASK_BACKLOG.md. Task A2 is approved: build the /corrections page in apps/web (list timecard_corrections with original vs corrected values and reason; Approve button calling the apply_timecard_correction RPC; Reject button setting status=rejected) plus a Nav entry. Reuse existing page patterns (see timesheets page for the approve-button pattern). Acceptance: web build green (15 routes); seeded pending correction can be approved end-to-end and the time entry updates; rejected correction cannot be applied; `source .env.acceptance && bash scripts/regression.sh` ALL GREEN before and after. Update TASK_BACKLOG.md + SESSION_HANDOFF.md, commit, report modified files. Do only this task.
