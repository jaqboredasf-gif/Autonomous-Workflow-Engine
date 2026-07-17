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
| B10 | Minimum info required before a service call can be scheduled (name + address + phone + problem description? anything else — access instructions, billing info?) — per request type if it differs | WORKFLOW_MAPS Map 5 required-field sets; missing-info detection |
| B11 | Unanswered info-request policy: how many nudges, spacing, when to close a request as abandoned | Map 5 expiry/close rules (until answered: closing = manual human action w/ reason) |
| B12 | Emergency ack timeout + fallback order: if primary emergency contact doesn't acknowledge, after how long does it go to whom? | Map 2 escalation chain; emergency_contacts priority + timeout config (extends B6) |
| B13 | Proposal validity + silent-customer policy: how long is a sent proposal good; follow-up nudges (count/spacing); honor a stale acceptance after prices changed? | Map 10 expiry/nudges; until answered, follow-up = manual human action w/ reason |
| B14 | Schedule change/cancellation policy: who may cancel a customer-approved job; required customer notice; any cancellation-fee practice? | Map 14 approvals + cancellation_notice matrix row |
| B15 | Partial-completion billing: invoice only after final visit, or interim/progress billing (fixed-price AND T&M)? | Maps 16/19 invoice gating (invariant 7 assumes final-completion-only until answered) |
| B16 | Field-initiated change orders: how does a crew report scope growth today, and may work proceed before the CO is approved? | Map 17 D3; unapproved-extras billing rule |
| B17 | Who decides fixed-price vs T&M for a job, and on what basis? | Map 8 D2; jobs.billing_type source |
| B18 | Should v1 track payment status / disputes at all, or is that purely QB-side until integration? Credit/re-issue practice on disputed invoices? | Map 20 job close-out; invoice void/reissue flow |

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
8. Office admin is the intake triage-queue owner (Maps 1/5/6/7 in WORKFLOW_MAPS.md) —
   until B2 answers who actually watches the inbox, could be the owner today.

## E. Phase 3 workflow-design questions (Jack decides or asks boss; from WORKFLOW_MAPS.md 2026-07-17)

| # | Question | Blocks |
|---|---|---|
| W1 | Intake SLA + notification cadence: how long may a request sit untouched in `new`/`needs_review`/`awaiting_info` before escalating, and does triage owner get immediate pings or a digest? (Only existing SLA: service-call confirmation unanswered 4h → owner.) Now also covers delivery queues: aging unscheduled jobs, undispatched jobs, unreported completions, blocked invoice drafts. | Maps 1/5/7 + 11/13/15/19/20 escalation paths; B5 queue UI design |
| W2 | v1 approver for the drafted out-of-territory decline — matrix row was written for auto mode; who approves the draft while auto is disabled? Office admin assumed. | Map 3 human approvals; message_policies seed (B3) |
| W3 | Does approving the service-call confirmation also authorize the shift/calendar entry (one approval covers both), or is scheduling-confirmation a separate matrix approval? One-approval assumed. | Map 4 approvals; B3/B6 build |
| W4 | Dispatch timing: when does the dispatch notification go out (on approval? day before?) and who triggers it in v1? Human-triggered assumed, no auto-cadence. | Map 13 trigger; queue design |
| W5 | Does a reschedule notice reuse the scheduling-confirmation matrix row, and does cancellation need its own `cancellation_notice` row (proposed)? | Map 14 approvals; message_policies seed |
| W6 | Is a completion notice sent for EVERY job or only some? Matrix defines approver, not trigger policy. v1: always drafted, human decides send. | Map 15 human approvals |
