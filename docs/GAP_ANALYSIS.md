# Gap Analysis & Implementation Plan (vs. field-service OS spec, 2026-07-16)

## 1. Current-state architecture

- **Supabase** (project `qgoiacwdntaqeghcyjlw`) — Postgres + Auth + Storage, 8 migrations applied.
  Tables: orgs, org_settings (payroll rules incl. 12:00–12:30 unpaid lunch), users (roles + skills),
  crews/crew_members (unused so far), job_sites (geofence), cost_codes, time_entries
  (offline-idempotent punches, server-computed geo flags, photos), time_entry_audits
  (trigger-written on edits to approved/locked), pay_periods, payroll_exports, shifts
  (with external_event_id for M365), service_areas, leads. RLS org-scoped + role-based throughout.
- **Mobile** (Expo): sign-in, solo + crew punch, GPS at punch, nearest-site sort, cost codes,
  offline queue idempotent on (device_id, client_uuid), punch photo to private bucket.
- **Web admin** (Next.js): timesheets w/ approve, schedule, map, flags, sites, employees w/ skills,
  payroll (draft math + lock), settings (payroll-rule input form). Service key only in server route.
- **MCP server** (10 tools) — the agent/n8n surface: timesheets, flags, hours report, sites,
  employees, schedule, create_shift, check_territory, find_best_worker, log_lead.
- **Blocked externally:** M365 Graph (Azure app registration pending IT), n8n webhook URL,
  QuickBooks flavor, real territory/skills/OT policy data.

## 2. Gap analysis (spec area → status)

| Spec area | Status |
|---|---|
| Employee/crew mgmt | ✅ users/roles/skills/crews; ❌ licenses_certifications, time-off |
| Job/customer mgmt | ❌ customers, jobs, job_requirements, work_requests (job_sites only) |
| Scheduling/dispatch | ✅ shifts + find_best_worker (single-worker); ❌ crew scoring, certs/equipment/fairness factors, score breakdown partial |
| Clock in/out + GPS | ✅ core; ❌ GPS accuracy, distance-from-site, network status not stored |
| Break tracking | ❌ (only org-level lunch auto-deduct rule) |
| Cost codes | ✅ |
| Job completion | ❌ entirely |
| Photos/docs/notes | ✅ punch photos; ❌ general field notes/attachments |
| Payroll pre-reconciliation | ⚠️ draft math + lock; ❌ payroll_exceptions table, correction records |
| Invoices | ❌ |
| Equipment | ❌ |
| Notifications/approvals | ❌ approval_requests (approve buttons exist in UI) |
| Reporting | ⚠️ basic pages |
| Audit logs | ⚠️ time_entry_audits only; ❌ general audit_logs |
| n8n integration events | ❌ integration_events, automation_runs |
| updated_at on every table | ❌ (created_at yes; retrofit needed) |
| Immutable punches + corrections | ⚠️ audit trigger covers approved/locked; ❌ first-class timecard_corrections |

## 3. Recommended schema changes (dependency order)

1. **integration_events** (everything downstream needs the event spine) ← slice 1
2. **completion_reports** (+ checklist JSON) + punch enrichment (accuracy, distance) ← slice 1
3. timecard_corrections (immutable-punch rule, payroll gate)
4. customers → jobs → job_requirements → work_requests (job layer; job_sites become children of jobs)
5. breaks + payroll_exceptions (pre-reconciliation)
6. approval_requests + notifications (Teams/email approval loop via n8n)
7. licenses_certifications, employee time-off (dispatch factors)
8. equipment + equipment_assignments
9. invoices + invoice_line_items
10. audit_logs (generic) + updated_at retrofit across tables

## 4. Recommended n8n workflows (priority order)

Wave 1 (unblocked once n8n URL exists — consume integration_events):
missing clock-out reminders, geofence exception alerts, daily foreman exception report,
job-completion processing + return-trip creation, failed-automation/health report.
Wave 2 (needs M365 creds): work-request email extraction → check_territory → log_lead →
auto-decline or dispatch recommendation; assignment notifications; approval packages in Teams.
Wave 3 (needs QuickBooks answer): invoice classification, payroll approval package.
All consume `integration_events` rows and must echo `event_id` back (idempotency contract, §6 of spec).

## 5. Security risks (current, honest)

1. **Service-role key exposure** — key lives in `apps/web/.env.local` (server-only ✅) but also
   in shell history and this chat. Rotate before any real employee data enters the system.
2. **Access token** `sbp_…` pasted in chat — revoke after setup (flagged earlier).
3. **Punch mutability pre-approval** — workers can edit their own open entries (times included);
   spec requires original punch immutability + corrections. Closed by slice 3 (timecard_corrections).
4. **Storage read policy** — any authenticated user can read any punch photo (org check missing).
5. **No rate limiting / abuse controls** on the employees API route.
6. **MCP server = service role** — safe only as long as it runs on trusted machines; never expose
   it as a public endpoint.

## 6. First vertical slice (chosen)

**"Punch → validated with evidence → clock-out → completion report → events emitted for n8n."**
Smallest slice that completes the spec's starting flow with what exists:

- Migration 0009: `integration_events` (n8n contract), `completion_reports`,
  time_entries gains `in/out_accuracy_m` + `in/out_distance_m`; geofence trigger v2 stores
  distance and is accuracy-aware (inside if distance ≤ radius + GPS accuracy — benefit of doubt,
  never auto-accuse); DB triggers emit `punch.created`, `punch.flagged`, `job.completed`,
  `completion.return_trip_required`.
- Mobile: capture GPS accuracy at punch; after a successful solo clock-out, completion form
  (work complete?, return trip + reason, materials, notes) → completion_reports.
- Web: Completions page (list + return-trip highlight).
- Security: RLS on both new tables (workers insert/see own completions; events service-only).
- Tests: `scripts/acceptance-slice1.sh` — scripted end-to-end acceptance run against live project.
- Docs: this file + roadmap update.

Deferred within slice (noted, not forgotten): offline-queued completion reports, checklist
templates per job type, photo attach on completion (bucket exists), foreman review UI.

## 7. Acceptance criteria (slice 1)

1. Punch-in via authenticated REST with lat/lng/accuracy → row stores accuracy, computed
   distance_m, geo flag; `punch.created` event row exists with correct entity_id + payload.
2. Punch 60 m outside fence with 80 m GPS accuracy → flag `inside` (accuracy benefit of doubt).
3. Punch 2 km outside with 10 m accuracy → flag `outside`, distance stored, `punch.flagged`
   event emitted exactly once.
4. Completion report insert by the worker (RLS) → `job.completed` event; with
   return_trip_needed=true → `completion.return_trip_required` event also emitted.
5. Worker cannot read another user's completion report; anon cannot read integration_events.
6. Mobile + web typecheck/build clean; acceptance script prints all PASS.
