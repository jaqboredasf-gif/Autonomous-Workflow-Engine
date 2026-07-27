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
apps/web             Next.js 16 app router + Tailwind. Admin dashboard, 15 routes:
                     home/login, timesheets, schedule, completions, approvals,
                     map, flags, sites, employees, payroll, settings,
                     api/employees.
                     Key files: src/app/*/page.tsx, src/components/Nav.tsx,
                     src/lib/approval-queue.ts (B5 queue logic — pure, imports
                     scripts/lib/approval-matrix.mjs; Runner 5 tests it directly)
packages/shared      shared types
packages/mcp-server  stdio MCP server (ESM JS), 10 tools, service-role key via env
supabase/migrations  0001–0015 ALL applied to the live project (0014 + 0015 applied
                     2026-07-26; see "Migration state" below)
scripts/             regression.sh, acceptance-slice1..5.sh, classify.mjs,
                     eval-intake.sh (Runner 1), eval-classification*.sh (2A/2B),
                     eval-approval-diff.sh (Runner 3), eval-approval-matrix.sh (Runner 4),
                     eval-approval-queue.sh (Runner 5), parity-route-live.mjs
                     (live SQL/JS routing parity, used by slice 4)
scripts/lib/         pure offline engines: classification.mjs, model-adapters.mjs,
                     db.mjs, approval-diff.mjs (ADR), approval-matrix.mjs +
                     outbound-draft.mjs (B3), validate-migration-0014/0015.mjs
fixtures/            emails/ (intake, 12 + labels), approvals/ (ADR diff, 15 + labels),
                     outbound/ (B3 matrix + drafts: 5 policy sets, 16 cases + labels),
                     queue/ (B5 approval queue: base-row + 19 cases + labels)
docs/                ROADMAP.md, API_CONTRACT.md, AUTOMATION_SYNERGY.md,
                     GAP_ANALYSIS.md, REGRESSION_CHECKLIST.md
docs/testing/        EVAL_STRATEGY.md, APPROVAL_DIFF.md (ADR), APPROVAL_MATRIX.md (B3),
                     APPROVAL_QUEUE.md (B5)
docs/planning/       THIS folder — scope/requirements/roadmap/backlog/handoff
```

## Migration state

**0001–0015 are all applied to the live project.** 0014 + 0015 were applied 2026-07-26
with Jack's explicit authorization, after a full dry-run (both files executed inside one
`begin; … rollback;` transaction against the live schema — zero errors, zero residue).
Drift check after apply: 24 public base tables = 19 (0001–0013) + 5 (0014 `approval_drafts`
/ `approval_outcomes` / `category_authority`, 0015 `message_policies` / `outbound_messages`).
`message_policies` holds 10 seed rows, all `mode='draft'`.

Applying schema to live Supabase remains a **human-gated outward action** — get Jack's
go-ahead per migration, and dry-run inside a rolled-back transaction first.

Correction to a claim earlier sessions carried: this environment has no psql/supabase
CLI/docker, but the **management query API does execute DDL** with the token in
`.env.acceptance`. Live apply is therefore possible in-session; the gate is
authorization, not capability. Recipe below.

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
and asking Jack first (standing rule). Before any live apply, dry-run it:

```bash
{ echo "begin;"; cat supabase/migrations/00XX_name.sql; echo "rollback;"; } | \
jq -Rs '{query: .}' | curl -s -X POST "https://api.supabase.com/v1/projects/qgoiacwdntaqeghcyjlw/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @-
```

An empty `[]` means it executes cleanly and left nothing behind.

## How to test

```bash
source .env.acceptance && bash scripts/regression.sh
```

Runs: mobile tsc, web build, MCP smoke (expects ≥10 tools), acceptance slices 1–5
(9 + 10 + 20 + 49 + 27 checks) against the LIVE project, Runners 1–5, and the
0014/0015 offline lints. Slice 4 is mgmt-API heavy, so regression pauses 45s after it to let the
per-minute rate-limit window drain — a 429 in a later runner is a throttle, not a test
result (`scripts/lib/db.mjs` and slice 4 both retry throttles with backoff).

**Offline-only subset** (no keys, no DB, no network — safe when you must not touch the
live project):

```bash
node scripts/lib/validate-migration-0014.mjs   # ADR migration lint
node scripts/lib/validate-migration-0015.mjs   # B3 migration lint + engine/SQL parity
bash scripts/eval-approval-diff.sh             # Runner 3 (ADR diff engine)
bash scripts/eval-approval-matrix.sh           # Runner 4 (B3 matrix + drafts)
bash scripts/eval-approval-queue.sh            # Runner 5 (B5 approval queue UI logic)
(cd apps/mobile && npx tsc --noEmit) && (cd apps/web && npm run build)
```

Everything else in regression (slices 1–5, Runner 1 eval-intake, Runner 2A) reads AND
WRITES the live project and needs `.env.acceptance` sourced. Must be ALL GREEN before
and after every change. Gotcha already fixed — keep it fixed: time_entries has a
`clock_out > clock_in` check constraint; acceptance scripts back-date clock_in 1h.
Scripts use macOS `date -v` (not Linux-portable).

Live-DB test fixtures you will see and should not delete: a `users` row
`f1000000-0000-4000-8000-000000000001` "FIXTURE Non-Approver (slice4)" with role
`worker` (slice 4 needs a non-approver to prove RLS denial; no `auth.users` row exists
for it, and none is needed — `auth.uid()` reads the JWT claim, and
`current_role_is()` / `business_role_matches()` read `public.users`).

**Testing RLS without a second real login:** inside an uncommitted transaction,
`set local role authenticated;` plus
`set local request.jwt.claims = '{"sub":"<user-uuid>","role":"authenticated"}';`
makes RLS apply as that user. End with `rollback` (or let a raising statement abort the
transaction) and nothing persists. Slice 4's `as_user()` helper is this pattern.

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

**S1 (open, found 2026-07-26, human-gated):** the live DB carries 16 undeclared
`*_org_{select,insert,update,delete}` policies on `integration_events`,
`time_entry_audits`, `crews` and `crew_members` — orphan-schema residue 0012 did
not clean up. No role gate, so any authenticated org member can read, insert and
**delete audit events**. Verified live in rolled-back transactions. Remediation
SQL + acceptance criteria: TASK_BACKLOG S1. Do not apply without Jack's
go-ahead — dropping objects on live is destructive.

**Security Phase 1 (prepared, never applied):** branch
`security/phase-1-remediation` addresses C1 policy drift, C2 privileged function
execution, C3 time-entry/crew authorization, and C4 MCP tenant binding in four
ordered migrations plus server code. The exact plan and compatibility boundary
are in `docs/planning/SECURITY_PHASE1_PLAN.md`. A live policy/function/grant and
migration-history comparison, rolled-back dry run, and explicit approval are
mandatory before any apply.

Live policy drift is worth re-checking after any externally-made change:

```bash
jq -Rs '{query: .}' <<<"select tablename, policyname from pg_policies where schemaname='public' order by 1,2;" | \
curl -s -X POST "https://api.supabase.com/v1/projects/qgoiacwdntaqeghcyjlw/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @- | \
jq -r '.[] | .policyname' | while read -r p; do grep -qr "create policy $p " supabase/migrations/ || echo "UNDECLARED: $p"; done
```
