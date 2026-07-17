# CONTEXT.md — fresh-session bootstrap

Read this FIRST in every new Claude Code session, then SESSION_HANDOFF.md, then the
task you were given. Everything here is stable background; SESSION_HANDOFF.md carries
what changed last session.

## What this project is

In-house replacement for ExakTime (time tracking + GPS job-site validation + payroll
prep) for Lippolis Electric, plus an automated work-request → invoice pipeline
(boss's scope) built on the same database. Two workstreams — see PROJECT_SCOPE.md.

## Repo map

```
apps/mobile          Expo 57 (blank-typescript). Punch app: solo/crew clock in-out,
                     GPS accuracy, offline queue, punch photo, completion form.
                     Key files: App.tsx, lib/queue.ts, lib/supabase.ts
apps/web             Next.js 16 app router + Tailwind. Admin dashboard, 14 routes:
                     home/login, timesheets, schedule, completions, map, flags,
                     sites, employees, payroll, settings, api/employees.
                     Key files: src/app/*/page.tsx, src/components/Nav.tsx
packages/shared      shared types
packages/mcp-server  stdio MCP server (ESM JS), 12 tools, service-role key via env
supabase/migrations  0001–0010, applied to live project (source of truth for schema)
scripts/             regression.sh, acceptance-slice1.sh, acceptance-slice2.sh
docs/                ROADMAP.md, API_CONTRACT.md, AUTOMATION_SYNERGY.md,
                     GAP_ANALYSIS.md, REGRESSION_CHECKLIST.md
docs/planning/       THIS folder — scope/requirements/roadmap/backlog/handoff
```

## Live infrastructure

- Supabase project `qgoiacwdntaqeghcyjlw` — https://qgoiacwdntaqeghcyjlw.supabase.co
- Publishable (anon) key: `sb_publishable_EDVoHYrGox6sA1CVE3hIBg_vlIRzvHT`
- Secrets: `apps/web/.env.local` (service-role key) and `.env.acceptance` at repo
  root (management token, service key, test login). Both gitignored. NEVER put
  secrets in committed files or client bundles.
- Test admin login: Jack (j.daly1109@gmail.com), org 2b219aa5-1148-4e3e-a1a0-1725d62b935c,
  Demo Jobsite c223ce79-18dd-4a86-8f70-b1137b673fe6 (40.7128,-74.006, r=150m).

## How to apply a migration (no DB password available — do NOT use supabase db push)

```bash
jq -Rs '{query: .}' < supabase/migrations/00XX_name.sql | \
curl -s -X POST "https://api.supabase.com/v1/projects/qgoiacwdntaqeghcyjlw/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @-
```

Run from repo root. Migrations: additive only; destructive changes require stopping
and asking Jack first (standing rule).

## How to test

```bash
source .env.acceptance && bash scripts/regression.sh
```

Runs: mobile tsc, web build, MCP smoke (expects ≥10 tools), acceptance slice 1
(9 checks) + slice 2 (10 checks) against the LIVE project. Must be ALL GREEN before
and after every change. Gotcha already fixed — keep it fixed: time_entries has a
`clock_out > clock_in` check constraint; acceptance scripts back-date clock_in 1h.
Scripts use macOS `date -v` (not Linux-portable).

## Schema conventions (standing rules)

- UUID PKs, created_at/updated_at, org_id + RLS on every table
- Helper fns: current_org_id(), current_role_is(role)
- Punches immutable (guard trigger); changes only via timecard_corrections +
  apply_timecard_correction() RPC
- integration_events = n8n contract; emit via emit_event(); events exactly-once
  per boundary; automations idempotent
- Offline punches idempotent on unique (device_id, client_uuid); 23505 = synced

## Session operating system (mandatory)

1. Read docs/planning/*.md, this file first
2. ONE approved task from TASK_BACKLOG.md only
3. Restate goal + acceptance criteria; inspect existing files before editing
4. Smallest change; test; fix before expanding
5. Regression before + after; report modified files / migrations / manual config
6. Update TASK_BACKLOG.md + SESSION_HANDOFF.md; stop; output next-session prompt
7. New ideas → Future Improvements in TASK_BACKLOG.md, never silent scope growth

## Standing security debt (do not forget)

Revoke sbp_ management token when setup phase ends; rotate service-role key before
real employee data; org-scope punch-photo storage read policy; `.env.acceptance`
must never be committed.
