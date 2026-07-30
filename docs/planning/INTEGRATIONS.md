# Integrations

## Microsoft 365 (Graph API) — BLOCKED, critical path

Two SEPARATE systems (decided — do not conflate):
- **Shared mailbox** — receives/sends work-request email. Existence unconfirmed; company confirmed to have shared *calendar* only. Preferred: dedicated `requests@<domain>` shared mailbox; never the owner's inbox.
- **Shared calendar** — jobs, appointments, crew assignments. Exists today.

Blocking dependency: Entra ID app registration (Tenant ID, Client ID, secret, Application permission `Calendars.ReadWrite` + `Mail.Read`/`Mail.Send` scoped to the shared mailbox via ApplicationAccessPolicy, admin consent). Jack cannot self-serve — personal Gmail not in company tenant; IT email drafted earlier.

Until unblocked: fixtures-based ingestion (`email_messages.is_fixture=true`); ingestion isolated behind one interface so Graph trigger swaps in with zero routing-logic changes. Every real-email test labeled BLOCKED in backlog.

**Update 2026-07-30 (Task I1 — Microsoft 365 Integration Plane).** The company now has an operational Microsoft 365 tenant and a company Microsoft account, so the app registration can finally be *requested*. The integration itself is now built and verified offline: `packages/m365` implements the Graph gateway, the mail/Teams/document/identity adapters, the subscription lifecycle, notification validation + deduplication, the capability executor with its policy/approval/allowlist/scope gates, and a hash-chained evidence trail. Schema is migration `0016` (**not applied**). Tests: `bash scripts/eval-m365.sh` (Runner 6, offline, deterministic).

- Architecture + capability catalog: `docs/architecture/M365_INTEGRATION_PLANE.md`
- Exactly what IT must provide: `docs/integrations/M365_ENTRA_CONFIGURATION.md`
- What is still blocking a live proof: `docs/integrations/BLOCKED_LIVE_PROOF.md`

Scope correction to the note above: the permission set is narrower than originally drafted. `Mail.Send` is **not** requested and never will be — this plane creates Outlook *drafts* only. The requested set is `User.ReadBasic.All`, `Mail.Read`, `Mail.ReadWrite`, `ChannelMessage.Send`, `Sites.Selected`, each scoped by an `ApplicationAccessPolicy` (mail) or a per-site grant (SharePoint). Calendar permissions are deferred to the next slice.

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
