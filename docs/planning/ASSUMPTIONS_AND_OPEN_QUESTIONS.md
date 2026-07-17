# Assumptions and Open Questions

Single source of truth for what is unconfirmed. Supersedes the "Unresolved questions"
list in SESSION_HANDOFF.md (kept there as pointer only). When answered: move the fact
into the owning doc, tag [CONFIRMED <date>], delete the row here.

## A. Questions for the boss (Jack asks; batch these)

| # | Question | Blocks |
|---|---|---|
| B1 | Actual avg call volume + email volume per day; which mailbox receives requests; does anyone besides owner receive new requests; website form / voicemail in use? | Intake design, CURRENT_WORKFLOW confirmation |
| B2 | Office employee names + roles: who schedules, who estimates, who invoices, who runs payroll, who may approve/send customer communications? | Phase 2 permissions, approval matrix approvers |
| B3 | Walk one real completed job request→payment; where did it actually wait? | CURRENT_WORKFLOW confirmation, delay-point ranking |
| B4 | QuickBooks Desktop or Online? | Invoice integration design (deferred by Option B, still need answer) |
| B5 | Territory: exact towns/counties/zips, licensing limits, max normal travel distance, exceptions for big jobs / existing customers; do service calls vs construction use different rules? | Territory table + enabling auto-decline (the only planned v1 auto-send) |
| B6 | After-hours emergencies: who receives them, formal emergency number? which employees dispatchable? emergency pricing different? preferred urgent-alert channel (sms/call/email/Teams)? | Emergency escalation config (D3) |
| B7 | Pricing source (Excel?), estimate approvers, per-customer rates? | price_book import, estimate workflow (D2) |
| B8 | Rounding/OT policy in writing (exact vs 7/15-min; weekly-40 vs daily OT) | Workstream A payroll verification |
| B9 | ExakTime monthly cost | ROI framing (nice-to-know) |

## B. Questions for IT / M365 admin

| # | Question | Blocks |
|---|---|---|
| I1 | Entra ID app registration (tenant ID, client ID, secret, Mail.Read/Mail.Send + Calendars.ReadWrite, ApplicationAccessPolicy, admin consent) | ALL real-email + calendar work. Request drafted 2026-07-16. |
| I2 | Can a shared mailbox (requests@…) be created? Company confirmed to have shared *calendar* only — not the same thing. | Real-mail ingestion design |

## C. Jack's own to-dos

| # | Item | Blocks |
|---|---|---|
| J1 | n8n instance URL + credentials | End-to-end event consumers |
| J2 | Observe/trace one real job today (feeds B3) | CURRENT_WORKFLOW confirmation |
| J3 | Headcount + phone types (interview Q2, still open) | Mobile rollout planning |

## D. Standing assumptions (labeled, in force until contradicted)

1. Phone is the larger intake channel (~10–20 calls vs ~3–10 emails/day) — MVP is
   email-first anyway, by decision, and does not claim to solve intake.
2. Owner is the routing bottleneck; goal is removing sort/forward/data-entry from him
   while preserving approval authority.
3. Dispatcher/estimator may not be distinct people — permissions designed per-role.
4. Territory knowledge lives mostly in owner's head; no verified written rule set.
5. Emergencies handled ad hoc by phone today; no confirmed formal after-hours process.
6. Same job data typed into multiple systems (Outlook/calendar/Excel/QB) today.
7. Estimator role exists in some form; estimates may need owner approval before send.
