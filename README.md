# Autonomous Workflow Engine (AWE)

A provider-neutral AI operating system for deterministic, policy-controlled
business automation. The workforce applications are one business surface on
top of the reusable workflow, context, control-plane, MCP, agent-runtime,
memory, and durable-execution infrastructure.

## Repo layout

```
apps/mobile/        React Native (Expo) field app — clock in/out, GPS, offline queue
apps/web/           Next.js admin dashboard — timesheets, map, payroll, reports
packages/awe-kernel/ Deterministic outcomes, events, context, tools, reports, replay
packages/awe-control-plane/ Workflow registry, policy, approvals, dispatch, journals
packages/awe-agent-runtime/ Versioned bounded agent loop and hash-chained transcripts
packages/awe-memory/ Tenant-bound versioned memory, retrieval snapshots, retention
packages/awe-execution/ Durable jobs, leases, checkpoints, workers, recovery, replay
packages/awe-runtime/ Reusable application services and reference compositions
packages/mcp-server/ MCP execution surface
packages/shared/    Shared TypeScript types + domain constants
supabase/           Postgres migrations, RLS policies
docs/               Roadmap, API contract
```

## Getting started

1. Create a Supabase project (or `supabase init && supabase start` for local).
2. Apply migrations: `supabase db push` (or run `supabase/migrations/*.sql` in order).
3. Scaffold the apps (network required, run once):
   - `npx create-expo-app@latest apps/mobile --template blank-typescript`
   - `npx create-next-app@latest apps/web --typescript --app`
4. `npm install` at the root (npm workspaces).

The complete credential-free Durable Execution Plane reference run is:

```bash
node scripts/awe-execution.mjs demo
bash scripts/eval-durable-execution.sh
```

## Key design decisions

- **Offline-first punches.** Field devices queue punches locally and sync later;
  the server trusts device timestamps and flags conflicts rather than rejecting.
- **Flag, never block.** A punch outside a geofence is recorded and flagged for
  review — blocking causes field workarounds that destroy data quality.
- **Payroll rules live in config, not code.** Overtime thresholds, rounding, and
  the standard lunch break (12:00–12:30, unpaid) are org settings.
- **Agent-ready API.** Every admin action has a REST endpoint (see
  `docs/API_CONTRACT.md`) so the MCP/agent layer in Phase 4 wraps it directly.
