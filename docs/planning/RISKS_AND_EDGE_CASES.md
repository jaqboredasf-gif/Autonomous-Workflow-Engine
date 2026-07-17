# Risks and Edge Cases

Ranked by damage potential.

## Safety-critical

1. **Emergency misclassified as routine** (e.g. "weird smell from panel" → scheduled next-week). Mitigations: deterministic keyword safety net alongside AI classifier; anything uncertain escalates; human must respond to every emergency; classifier never the only line of defense. Edge cases: emergency described vaguely ("outlet feels hot"), non-English email, emergency buried in a long thread, photo-only description.
2. **System sends troubleshooting advice to a customer in danger.** Hard rule: outbound templates for emergencies contain only "call 911 if immediate danger / we are contacting you now" style content; no generated electrical instructions ever.

## Money-critical

3. **Wrong auto-decline** (in-territory request rejected → lost revenue, only auto-send in v1). Mitigations: definite territory rules only, confidence threshold, low-confidence → draft; territory data currently SAMPLE (Westchester/Bronx) — real licensed territory REQUIRED before enabling auto-send; every decline logged and visible for correction.
4. **Invented pricing reaches a customer.** Mitigations: price rows require source + last_updated; `pricing_complete=false` blocks estimate send; internal approval mandatory.
5. **Wrong paycheck** (Workstream A). Mitigations: parallel run 2 pay periods vs ExakTime; immutable punches + correction records; rounding/OT policy still unconfirmed — payroll math unverifiable until boss provides it (open).
6. **Duplicate or missed invoice.** Mitigations: invoice generation idempotent on job completion event (integration_events exactly-once pattern already proven for punch.flagged); human review before send.

## Dependency / schedule risks

7. **Entra app registration delayed indefinitely** — all real-email + calendar work blocked. Mitigation: fixtures-first build; explicit BLOCKED labels; IT request already drafted.
8. **Shared mailbox may not exist / may not be creatable** (only shared calendar confirmed). Discovery task before any Graph design hardens.
9. **QuickBooks variant unknown** (Desktop vs Online = different integrations). Deferred by decision (Option B).
10. **n8n instance URL unknown** — event consumers unbuildable end-to-end; DB-side event emission testable regardless.

## Technical / security debt (existing, must clear before real data)

11. Supabase management token (sbp_…) shared in chat — revoke after setup.
12. Service-role key rotation before real employee/customer data.
13. Punch-photo storage read policy not org-scoped yet.
14. Slice-2 acceptance: 6/10 checks failing (apply-correction RPC path) — must reach 10/10 before corrections feature trusted.

## Edge cases to encode in fixtures

- Out-of-territory + emergency in same email (emergency wins — never auto-decline)
- Reply to an existing thread vs new request; duplicate/forwarded copies of same request (dedupe on Graph message id / hash)
- Vendor invoice or spam arriving in requests mailbox (classification: not-a-work-request)
- Customer replies "yes approve" to proposal ambiguously
- Request with address that fails geocoding (territory unknown → draft, never auto-decline)
- Attachment-only request (photos of panel, no text)
- After-hours emergency (escalation channel must not be email-only) [contact/channel unconfirmed — configurable]
