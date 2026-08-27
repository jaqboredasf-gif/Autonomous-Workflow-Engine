# Exattime

Workforce time tracking, job site GPS verification, and payroll pipeline.
Recreation of ExakTime's core feature set, built API-first so every operation
is callable by AI agents in the larger calendar-automation project.

## Repo layout

```
apps/mobile/        React Native (Expo) field app — clock in/out, GPS, offline queue
apps/web/           Next.js admin dashboard — timesheets, map, payroll, reports
apps/purchasing/    Next.js purchasing-control DEMO — material requests, approvals,
                    printable POs, supplier email drafts. Standalone prototype:
                    no database, no credentials, nothing is sent. See its README.
packages/shared/    Shared TypeScript types + domain constants
capability/         What a capability DOES, and how one organization differs from
                    another. Contract + per-organization profiles.
deployment/         What a deployment must be able to DEMONSTRATE before handover.
                    Readiness is derived from evidence; nothing sets ready = true.
proof/              What a capability was WORTH. Baseline, objective success,
                    hours returned, economic value — every figure graded and
                    sourced, and unknown left unknown. See proof/README.md.
programs/           Time-boxed programs that read the above and store no truth of
                    their own: the readiness scorecard, customer discovery.
supabase/           Postgres migrations, RLS policies
docs/               Roadmap, API contract
```

> **Which branch is PCC?** Read `SOURCE_OF_TRUTH.md` before cloning anything. The
> description of `apps/purchasing/` above predates the production line and is stale.

## Getting started

1. Create a Supabase project (or `supabase init && supabase start` for local).
2. Apply migrations: `supabase db push` (or run `supabase/migrations/*.sql` in order).
3. Scaffold the apps (network required, run once):
   - `npx create-expo-app@latest apps/mobile --template blank-typescript`
   - `npx create-next-app@latest apps/web --typescript --app`
4. `npm install` at the root (npm workspaces).

## Key design decisions

- **Offline-first punches.** Field devices queue punches locally and sync later;
  the server trusts device timestamps and flags conflicts rather than rejecting.
- **Flag, never block.** A punch outside a geofence is recorded and flagged for
  review — blocking causes field workarounds that destroy data quality.
- **Payroll rules live in config, not code.** Overtime thresholds, rounding, and
  the standard lunch break (12:00–12:30, unpaid) are org settings.
- **Agent-ready API.** Every admin action has a REST endpoint (see
  `docs/API_CONTRACT.md`) so the MCP/agent layer in Phase 4 wraps it directly.
