# Session Handoff

Read CONTEXT.md first, then this, then all docs/planning/*.md. One approved task per session.

## Current state (2026-07-16, end of session A1)

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

## Unresolved questions (owner = Jack, mostly boss/IT)

1. Mailbox receiving requests today; M365 admin; Entra approver; shared-mailbox creation (D1)
2. Pricing source + estimate approvers + per-customer rates (D2)
3. Emergency contact person + channel (D3)
4. Real licensed service territory (SAMPLE rows in DB now)
5. Rounding/OT policy (blocks payroll verification)
6. QuickBooks Desktop vs Online
7. n8n instance URL
8. Headcount + phone types (interview Q2 unanswered)
9. ExakTime monthly cost (nice-to-know)

## Security debt

Revoke sbp_ management token after setup; rotate service-role key before real data; org-scope punch-photo read policy.

## Next session prompt — Task A2 APPROVED by Jack (2026-07-16)

> Read docs/planning/CONTEXT.md, then docs/planning/SESSION_HANDOFF.md and TASK_BACKLOG.md. Task A2 is approved: build the /corrections page in apps/web (list timecard_corrections with original vs corrected values and reason; Approve button calling the apply_timecard_correction RPC; Reject button setting status=rejected) plus a Nav entry. Reuse existing page patterns (see timesheets page for the approve-button pattern). Acceptance: web build green (15 routes); seeded pending correction can be approved end-to-end and the time entry updates; rejected correction cannot be applied; `source .env.acceptance && bash scripts/regression.sh` ALL GREEN before and after. Update TASK_BACKLOG.md + SESSION_HANDOFF.md, commit, report modified files. Do only this task.
