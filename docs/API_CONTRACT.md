# API contract (v0)

Design rule: every operation an admin can do in the dashboard exists as an
endpoint here, so the Phase 4 agent/MCP layer wraps this API 1:1 with tools.
All routes org-scoped by auth token. Errors: RFC 7807 problem+json.

## Punches (mobile)

| Method | Route | Notes |
|---|---|---|
| POST | `/punches/in` | body: jobSiteId?, costCodeId?, lat?, lng?, at, clientUuid, deviceId. Idempotent on (deviceId, clientUuid). Returns entry + geoFlag. |
| POST | `/punches/out` | closes caller's open entry; same idempotency. |
| POST | `/punches/crew` | foreman only; array of userIds, punches whole crew in/out. |
| POST | `/punches/sync` | batch of QueuedPunch from offline queue; per-item result. |

## Timesheets

| Method | Route | Notes |
|---|---|---|
| GET | `/timesheets?userId&from&to` | worker: self only; foreman: crew; admin: all. |
| POST | `/timesheets/submit` | worker submits period for approval. |
| POST | `/timesheets/approve` | foreman/admin; body: entryIds[]. |
| PATCH | `/time-entries/:id` | edits create time_entry_audits row when status ≥ approved. |

## Sites, codes, people

CRUD: `/job-sites`, `/cost-codes`, `/users`, `/crews` (admin).
`GET /job-sites/nearest?lat&lng` — punch-screen auto-suggest.

## Payroll

| Method | Route | Notes |
|---|---|---|
| GET | `/pay-periods` / POST `/pay-periods/:id/close` | close locks entries. |
| POST | `/pay-periods/:id/export` | body: format (csv first). Applies rounding, OT, lunch auto-deduct (12:00–12:30 unpaid) from org_settings. |
| GET | `/reports/hours?groupBy=user\|site\|costCode&from&to` | agent-friendly aggregate. |

## Flags / anomalies (agent surface)

| Method | Route | Notes |
|---|---|---|
| GET | `/flags?from&to` | outside-geofence punches, missing clock-outs, OT-approaching, missed lunch deduction conflicts. |
| POST | `/flags/:id/resolve` | body: resolution, note. |

## Future MCP tools (Phase 4)

`get_timesheets`, `get_flags`, `resolve_flag`, `create_shift`,
`get_site_schedule`, `run_payroll_export` — thin wrappers over the above.
