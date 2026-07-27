# ADR-0003 — Harness is a library; no daemon in v1 (open question O2)

**Status:** Proposed (2026-07-27) — awaiting Jack's ratification.

## Context

Where does the step loop actually run? Today AWE has no long-running process of
its own: `scripts/*` are batch invocations, `apps/web` is a Next.js request/response
app, `packages/mcp-server` is a stdio process owned by its client, and n8n (B12) is
blocked on an instance URL. Choosing wrong here creates infrastructure the project
cannot yet operate, monitor, or shut off.

## Decision

**The harness ships as a library with no process of its own.** Callers own the
process:

| Caller | Ships in | Bound |
|---|---|---|
| CLI `scripts/agent.mjs` | H12 | budget only (may run to session budget) |
| Web route `POST /api/agent/sessions/:id/run` | H15 | **`max_wall_seconds` ≤ 50** for web-invoked types, under the platform request timeout |
| MCP tool `run_fixture_triage_session` | H16 | fixture-only |
| n8n (B12, blocked) | later | one step or one session per webhook |

The lease/claim design (`claimed_by`, `lease_expires_at`, `expire_agent_leases()`)
already permits a worker process later; **no worker is built now.** A session that
exceeds a caller's wall clock ends in `expired` and is resumable — it is never
lost, and it never keeps running unattended.

## Alternatives considered

- **Dedicated worker/daemon** (Node process polling `created` sessions). Rejected
  for v1: nothing in this project is currently deployed as a long-running service;
  it needs hosting, restart policy, log shipping, and an on-call story that does
  not exist. The lease design keeps this available later at low cost.
- **n8n as the orchestrator** (n8n drives each step). Rejected: B12 is blocked on
  an instance URL, and it would put loop control — budgets, retries, guards —
  outside the code that regression tests. n8n stays an event *consumer*.
- **Supabase Edge Functions.** Rejected: another runtime, another deploy path,
  another secret store, and a hard execution-time cap, for no gain over the web
  route.

## Consequences

- **No unattended runs.** Every session starts from a human, a CLI invocation, a
  web request, or (later) an event. If a scheduled trigger is ever wanted, that is
  a new, separately approved task — not a config flag.
- Long sessions belong to the CLI. Web-invoked session types must declare a small
  `max_wall_seconds` and are expected to reach a terminal or `awaiting_human` state
  quickly.
- Crash semantics are the lease's job: a killed CLI leaves a `claimed` session whose
  lease expires; `resume()` continues it (H11 acceptance proves same terminal state).
- No new hosting, no new deploy, no new monitoring surface in v1.

## Security impact

Neutral-positive: no always-on process means no always-on credential in memory and
no unattended action surface. Every run is attributable to a caller.

## Operational impact

Ops surface stays: CLI, web routes, kill switch, and DB views. Nothing to restart,
nothing to page on.

## Reversal strategy

Adding a worker later requires no schema change and no interface change — it is a
new caller of `claim()`/`advance()`. Reversal is deleting that caller.

## Related tasks and guardrails

O2 · Tasks H11, H12, H15, H16 · Guardrails G9 (wall clock), G16 (kill switch).
