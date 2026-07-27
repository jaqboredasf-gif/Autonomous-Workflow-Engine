# ADR-0007 — Kill switch lives in `agent_harness_settings`, not `org_settings`

**Status:** Proposed (2026-07-27) — awaiting Jack's ratification.
**Corrects:** `docs/architecture/AGENT_HARNESS_DESIGN.md` §11 G16, which named
`org_settings.harness_enabled`.

## Context

The design named `org_settings.harness_enabled` as the org-level kill switch.
Inspection of `supabase/migrations/0001_core.sql:18-29` shows `org_settings` is a
**payroll/timekeeping config table** — timezone, rounding minutes, OT thresholds,
lunch window, punch-photo requirement — with no such column. Adding one would mean
altering a Workstream A table that payroll math reads, inside a Workstream B
migration.

## Decision

Migration 0017 creates a self-contained harness settings table:

```
agent_harness_settings
  org_id uuid primary key references orgs(id) on delete cascade,
  enabled bool not null default false,        -- opt-IN, not opt-out
  max_concurrent_sessions int not null default 1,
  default_lease_seconds int not null default 300,
  fixture_mode_only bool not null default true,   -- flips only by explicit approval
  disabled_reason text,
  updated_at timestamptz not null default now()
```

Three-level switch, each checked at session start **and** before every dispatch (G16):
`agent_harness_settings.enabled` → `agent_session_types.enabled` →
`agent_tools.enabled`.

`enabled` defaults to **false** and `fixture_mode_only` defaults to **true**: the
harness is inert on arrival at the live database. Turning it on is a data change
that is visible, auditable, and reversible in one statement.

## Alternatives considered

- **`org_settings.harness_enabled`** (the design's original). Rejected: couples a
  Workstream B kill switch to the payroll config table, widening the blast radius
  of harness migrations into Workstream A.
- **Environment variable only.** Rejected: a kill switch that needs a deploy or a
  shell to flip is not an operational control, and it leaves no audit record of who
  disabled what, when.
- **Per-tool switch only.** Rejected: no single lever to stop everything.

## Consequences

- Migration 0017 gains one small table and its RLS/no-delete guards.
- No Workstream A table is touched by any harness migration — a rule worth keeping
  for the whole H-series.
- Because `enabled` defaults false, the apply checkpoints (AC-1/AC-2) cannot
  accidentally activate anything; the harness stays dormant until a separate,
  explicit data change.
- Disabling mid-session stops the *next* dispatch; the session terminates cleanly
  as `cancelled` with `terminal_reason='kill_switch'` (H16 acceptance).

## Security impact

Positive: opt-in by default, three independent levels, all auditable rows rather
than process state.

## Operational impact

Flipping the switch is one `update` through the management API or the settings
surface. Documented in the H17 runbook.

## Reversal strategy

Table is additive and unreferenced by existing code; abandoning the harness leaves
it empty.

## Related tasks and guardrails

Tasks H2, H11, H16 · Guardrails G16 (kill switch), G19 (TEST mode).
