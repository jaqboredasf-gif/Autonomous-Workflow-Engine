# Integrations

## Microsoft 365 (Graph API) — BLOCKED, critical path

Two SEPARATE systems (decided — do not conflate):
- **Shared mailbox** — receives/sends work-request email. Existence unconfirmed; company confirmed to have shared *calendar* only. Preferred: dedicated `requests@<domain>` shared mailbox; never the owner's inbox.
- **Shared calendar** — jobs, appointments, crew assignments. Exists today.

Blocking dependency: Entra ID app registration (Tenant ID, Client ID, secret, Application permission `Calendars.ReadWrite` + `Mail.Read`/`Mail.Send` scoped to the shared mailbox via ApplicationAccessPolicy, admin consent). Jack cannot self-serve — personal Gmail not in company tenant; IT email drafted earlier.

Until unblocked: fixtures-based ingestion (`email_messages.is_fixture=true`); ingestion isolated behind one interface so Graph trigger swaps in with zero routing-logic changes. Every real-email test labeled BLOCKED in backlog.

## n8n — workflow engine (instance URL unconfirmed)

Consumes `integration_events` (Supabase trigger/webhook → n8n). Wave order per docs/AUTOMATION_SYNERGY.md. AI Agent node connects to packages/mcp-server (12 tools live). Needed from Jack: n8n instance URL + credential setup.

## QuickBooks — accounting/AR system of record [ASSUMPTION; Desktop vs Online unconfirmed]

Two roadmap options requested:

- **Option A — integrate early**: build invoice records + QB sync in MVP. Pros: no throwaway invoice UI. Cons: blocked on unknown QB variant (Desktop = file-based/Web Connector, Online = REST API — completely different builds); billing process itself unconfirmed; delays the pipeline value (triage/scheduling) behind the least-certain dependency.
- **Option B — integrate after core request/scheduling works**: model invoices in Supabase now (both billing types), humans keep invoicing in QB manually; sync later.

**Recommendation: Option B.** Reasons: (1) QB variant unknown — can't even pick an SDK; (2) invoice correctness depends on pricing + billing-process discovery still open; (3) MVP value (owner stops hand-triaging email) needs zero QB; (4) invoice data model is designed now so nothing is rebuilt later. Decision reversal cost: low.

## Microsoft Excel

Likely current home of pricing / schedules [ASSUMPTION]. Use: one-time import into price_book with source + last-updated stamped. No live Excel sync in MVP.

## Dispatch Pilot

Mentioned as "potentially." Not evaluated. Parked in Future Improvements — no requirements known.

## Existing internal integrations (live)

- Supabase = source of truth (project qgoiacwdntaqeghcyjlw)
- MCP server (packages/mcp-server, 12 tools) for AI agents
- integration_events spine with idempotent processing contract (processing_status, attempt_count, last_error)
