# Regression Checklist — functioning features as of slice 1 (2026-07-16)

Run before and after every change. Automated column = covered by
`scripts/acceptance-slice1.sh` (A1) / `scripts/acceptance-slice2.sh` (A2) /
typecheck+build (T). Manual items need a device or browser.

## Automated (run: `bash scripts/regression.sh`)

| # | Feature | Check | Auto |
|---|---|---|---|
| 1 | Web typecheck + production build (14 routes) | `npm run build` in apps/web | T |
| 2 | Mobile typecheck | `npx tsc` in apps/mobile | T |
| 3 | Password auth + RLS-scoped profile fetch | login → users select returns caller only | A1 |
| 4 | Punch insert w/ GPS accuracy + computed distance | REST insert → distance/flag stored | A1 |
| 5 | Geofence benefit-of-doubt (accuracy widens fence) | 210m out / 80m acc → inside | A1 |
| 6 | Geofence outside flag + evidence | 2km out / 10m acc → outside + distance | A1 |
| 7 | punch.created / punch.flagged events, exactly-once | integration_events rows | A1 |
| 8 | Completion report insert (worker RLS) + events | job.completed, return_trip_required | A1 |
| 9 | integration_events / completion_reports hidden from anon | anon selects return empty | A1 |
| 10 | MCP server boots, lists 10 tools, live tool call works | JSON-RPC smoke in regression.sh | ✔ |
| 11 | Punch idempotency (device_id, client_uuid) | duplicate insert → 23505 handled | A1 (implicit) |
| 12 | Punch-time immutability + correction flow | added this slice | A2 |

## Manual (spot-check when touched area changes)

| # | Feature | How to verify |
|---|---|---|
| M1 | Mobile solo clock in/out + wrap-up form | Expo Go: punch in, out → completion form appears |
| M2 | Mobile crew punch | foreman: Crew tab, select 2, CREW IN |
| M3 | Offline queue | airplane mode punch → badge shows queued → sync on reconnect |
| M4 | Punch photo (when setting on) | Settings: require photo → clock-in opens camera |
| M5 | Web pages render signed-in | Home, Timesheets (approve btn), Schedule, Completions, Map, Flags, Sites, Employees (skills edit), Payroll (lock), Settings |
| M6 | Payroll lunch deduction 12:00–12:30 | entry spanning lunch → 0.5h deducted |
| M7 | Employee creation via admin route | Employees page add → new login works |
| M8 | Timesheet approve → audit on later edit | approve entry, edit notes → time_entry_audits row |

## Invariants (never break silently)

- Service-role key only in `apps/web/.env.local` + MCP env — never client bundles.
- RLS: worker sees own entries; events table service-only.
- Geofence flags computed server-side (trigger), never trusted from client.
- `.env*` gitignored except `.env.example`.
- Offline punches idempotent on (device_id, client_uuid).
