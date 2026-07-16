# Roadmap

Goal: recreate ExakTime's core feature set (time clock, GPS job-site
verification, payroll pipeline), API-first, as the foundation for an
AI-agent-driven calendar/scheduling automation layer.

## Phase 0 — Foundation ✅ (scaffolded)

- [x] Repo, monorepo layout, git
- [x] Core schema migrations (`supabase/migrations/0001_core.sql`)
- [x] RLS policies (`0002_rls.sql`)
- [x] Shared domain types (`packages/shared`)
- [x] API contract v0 (`docs/API_CONTRACT.md`)
- [x] Supabase project created, migrations applied
- [x] Expo + Next.js apps initialized (see README)
- [x] Auth wired (login, roles) — verified against live project

## Phase 1 — Time tracking (weeks 2–3)

- [x] Mobile clock in/out, GPS + timestamp at punch, cost code picker
- [ ] Crew clock-in (foreman punches crew)
- [x] Offline queue (AsyncStorage, ordered flush); idempotent on
  (deviceId, clientUuid) — `apps/mobile/lib/queue.ts`
- [x] Timesheet view (web, last 7 days, RLS-scoped) — worker/foreman
  scoping refinements pending
- [ ] Optional punch photo (store only, no face-match in v1)

## Phase 2 — Location (week 4)

- [x] Geofence validation server-side (DB trigger, `0003_geo_flags.sql`):
  inside = green, outside = **flagged, never blocked**
- [x] Nearest-site auto-suggest at punch (mobile sorts by distance)
- [ ] Admin map view + flags list
- No continuous background tracking in v1

## Phase 3 — Payroll (weeks 5–6)

- Rules engine from org_settings: rounding (15 min), OT (8h/day, 40h/wk,
  configurable), **lunch 12:00–12:30 unpaid, auto-deducted**
- Approval flow: submit → approve → lock; audited edits after approval
- Exports: CSV → QuickBooks → ADP
- Reports: hours by employee / site / cost code

⚠ Before building: confirm boss's actual OT/break policy in writing.
Lunch 12:00–12:30 confirmed 2026-07-16.

## Phase 4 — Calendar + agent layer (grand project)

- MCP server wrapping the API (tools listed in API_CONTRACT.md)
- Google Calendar sync for shifts/schedules
- Agent jobs: daily punch-anomaly review, weekly schedule pre-build,
  pay-period reconciliation — approval-gated, autonomy expands with trust

## Known risks

- Offline sync: build early, brutal to retrofit
- Payroll correctness: config-driven, tested against written policy
- GPS accuracy indoors: flag, never block
