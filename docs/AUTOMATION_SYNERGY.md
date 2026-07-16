# Exattime × n8n — Automation Synergy Design

The division of labor that makes this work:

| Layer | Owner | Job |
|---|---|---|
| **System of record** | Exattime (Supabase) | Who works here, what they specialize in, where they are right now (GPS punches), when they're available (shifts), what it costs (hours/rates), where we're licensed (service areas) |
| **Router / orchestrator** | n8n | Watches inboxes and webhooks, moves data between systems, fires notifications, runs on schedules |
| **Decision layer** | AI (Claude via n8n AI Agent node + the Exattime MCP server) | Reads an email, classifies intent/urgency/trade, picks the best worker, drafts the reply |
| **Human** | Boss/office | One-click approvals on anything customer-facing or costly. Everything else runs alone. |

Rule of thumb: **n8n decides *when*, Exattime knows *who/where/what*, AI decides *which*, humans approve *risky*.**

---

## Workflow 1 — Inbound email triage (kills the reply-email time sink)

**Trigger:** n8n Outlook trigger on the office inbox (same Entra app registration
we're requesting for calendar sync also unblocks n8n's Microsoft nodes — one
credential, two systems).

**Flow:**
1. AI Agent node classifies the email: `service_request | quote | invoice question | spam`,
   extracts address, trade (electrical/panel/lighting/…), urgency signals.
2. **Territory gate** — geocode the address, check against Exattime's
   `service_areas` table (licensed counties/zips — to be added).
   - *Fairfield County example:* not in table → n8n auto-sends the polite
     "outside our licensed service area" template (optionally with a referral),
     logs the lead, done. **Zero human minutes.**
3. **Urgency gate** — "burning and rubbery smell" → classified electrical
   hazard, priority P1. Flow jumps to Workflow 2 for dispatch and
   simultaneously sends the customer a "call 911 if flames / we're dispatching"
   acknowledgment.
4. Routine requests → draft reply + proposed schedule slot land in an approval
   queue (Teams/Outlook actionable message). Boss taps approve → sent.

## Workflow 2 — Best-available-worker dispatch (the master schedule brain)

The question "who should take this job?" is only answerable because Exattime
holds the data:

| Signal | Source (already built ✅ / planned) |
|---|---|
| Who is on the clock, and where | ✅ time_entries + GPS punch coords |
| Who is scheduled where, when free | ✅ shifts table |
| Who specializes in the problem | planned: skills on users (e.g. `troubleshooting`, `panel`, `service-call`) |
| Distance to the customer | last punch GPS / current site vs. geocoded address |
| Cost | ✅ hourly_rate |

n8n calls an Exattime MCP/REST tool `find_best_worker(trade, location, when)`
→ ranked candidates → AI picks + justifies → approval → then automatically:
create shift (✅ `create_shift` tool exists), push to M365 calendar (pending
Azure), text the worker, reply to the customer with ETA. One approval tap
replaces the whole email-phone-whiteboard loop.

## Workflow 3 — Daily ops autopilot (agent jobs)

All powered by existing MCP tools, scheduled in n8n:

- **7am flags digest** — `get_flags` → missing clock-outs, outside-geofence
  punches → Teams message to foremen; auto-SMS "forgot to clock out?" nudges.
- **OT watch** — Thursday check `get_hours_report`: who's approaching 40h →
  boss sees it *before* overtime happens, can rebalance Friday crews.
- **Payroll pre-run** — day before pay period close: reconcile, surface only
  exceptions; boss approves; export lands in QuickBooks format.
- **Schedule pre-build** — agent drafts next week's schedule from job pipeline
  + past patterns; boss approves a diff instead of building from scratch.

## Workflow 4 — Job lifecycle automation

Quote accepted (email/QuickBooks) → n8n creates the job site in Exattime
(geocoded, geofence set) + cost codes → crews can punch in at the new site
day one → actual hours vs. estimate feed back into future quoting.

---

## Integration mechanics (how n8n talks to Exattime)

1. **Direct Postgres/Supabase node** — n8n has a native Supabase node; reads
   and writes tables directly with the service key.
2. **MCP server** — n8n's AI Agent node supports MCP client tools; point it at
   `packages/mcp-server` and Claude-in-n8n gets `get_timesheets`, `get_flags`,
   `get_hours_report`, `get_schedule`, `create_shift`, `list_*` natively.
3. **Event-driven** — Supabase database webhooks → n8n Webhook trigger (fire a
   flow the moment a flagged punch lands, no polling).
4. **M365** — one Entra app registration serves both the calendar sync and
   n8n's Outlook/Teams nodes.

## What Exattime needs added to enable this (build queue)

- [ ] `service_areas` table (licensed counties/zips) + `check_territory` tool
- [ ] `skills` on users (text[] of trades/specialties) + skills editor on Employees page
- [ ] `find_best_worker` MCP tool (skills ∩ availability ∩ proximity ∩ rate)
- [ ] `leads` table (log every inbound request + disposition — data for quoting later)
- [ ] Supabase → n8n webhook on flagged punches
- [ ] M365 Graph sync (blocked on Azure — IT request out)

## Inputs needed from Lippolis

1. Licensed territory list (counties or zip codes where work is permitted)
2. Skills/specialties per employee (even rough: service calls vs. rough-in vs. panels)
3. Emergency triage rules (what words/situations = drop-everything dispatch)
4. Approved reply templates (out-of-territory, emergency ack, routine scheduling)
5. Where approvals should land: Teams, SMS, or email
