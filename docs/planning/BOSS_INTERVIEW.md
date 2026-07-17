# Boss Discovery Interview — Capture Sheet

Purpose: fill during/after boss conversation(s). Bite-sized rounds — one section per
sitting is fine. Every answered field: copy the fact into the owning planning doc,
tag [CONFIRMED <date>], and clear the matching row in ASSUMPTIONS_AND_OPEN_QUESTIONS.md.
Cross-refs: B# = boss questions in ASSUMPTIONS_AND_OPEN_QUESTIONS.md.

Opening line: "I am mapping the current workflow before I build anything so I do not
automate the wrong process. ~15–20 minutes."

⚠️ Do not paste sensitive pricing into any AI tool until boss approves its use in the system.

## Round plan

| Round | Section | Feeds |
|---|---|---|
| 1 | §3 Roles + §11 send rules | Phase 2 permissions (B2) — IN PROGRESS with Jack now |
| 2 | §1 Intake + mailbox | B1 |
| 3 | §2 One real job trace | B3 — highest value, do early |
| 4 | §4 Territory | B5 |
| 5 | §5 Emergencies | B6 |
| 6 | §6 Estimates + pricing | B7 |
| 7 | §7 Scheduling + crews | Phase 3 workflow maps |
| 8 | §8 Completion reporting | Phase 3 |
| 9 | §9 Payroll + ExakTime | B8, B9, cutover |
| 10 | §10 QuickBooks | B4 |
| 11 | §12 IT blockers | I1, I2 |
| 12 | Closers | MVP priority + hard "never" rule |

## §1 Incoming requests and email (B1)

Ask: mailbox receiving most requests? personal vs shared? channels (phone/text/web/referral)? volume/day? first reviewer? commonly missing info? what triggers a forward, to whom?

| Field | Answer |
|---|---|
| Exact mailbox name | |
| Personal or shared | |
| Daily request volume (calls / emails) | |
| Other intake channels | |
| First reviewer | |
| Common missing info | |
| Routing rules (forward triggers → recipients) | |

## §2 One real completed job (B3)

Ask boss to walk one recent job request→payment: arrival, first reviewer, where customer info recorded, accept decision, estimate needed?, who scheduled, calendar location, crew selection, how crew got details, hours recorded, materials recorded, how office learned completion, invoice creator/tool/approver/send method, payment tracking.

| Field | Answer |
|---|---|
| Humans involved | |
| Systems involved | |
| Data retyped where | |
| Approval points | |
| Delays (where it waited) | |
| Handoffs | |
| Missing-data problems | |

## §3 Roles and approval authority (B2) — Round 1

Ask: who schedules? assigns crews? prepares estimates? approves estimates? creates invoices? approves invoices? payroll? allowed to send customer email? decides when owner unavailable? approval limits by job value?

Per person:

| Name | Role | Views | Edits | Approves | Sends | Owner-only items |
|---|---|---|---|---|---|---|
| | | | | | | |

## §4 Service territory (B5)

Ask: towns/zips/counties served? never-serve areas? big-job/existing-customer-only areas? territory vary by job size or crew availability? licensing boundaries? written list anywhere? should system ever auto-decline?

| Field | Answer |
|---|---|
| Verified towns + zips | |
| Counties | |
| No-service areas | |
| Exception rules | |
| Licensing restrictions | |
| Auto-decline permitted? | |
| Exception approver | |

## §5 Emergencies (B6)

Ask: what counts as emergency? business-hours receiver? after-hours receiver? emergency number? who picks responding crew? alert channel (call/text/email/all)? nobody available → ? escalate-only vs auto-acknowledgment allowed?

| Field | Answer |
|---|---|
| Emergency situations/keywords | |
| Primary contact | |
| Backup contact | |
| After-hours process | |
| Alert channels | |
| Escalation order | |
| Auto-reply allowed? | |
| Emergency pricing different? | |

## §6 Estimates and pricing (B7)

Ask: labor rates live where? material prices from? standard markup? per-customer/job-type rates? estimate preparer/approver? fixed vs T&M usual? estimate from drawings w/o visit? pricing in Excel/QB/portals/heads? change frequency?

| Field | Answer |
|---|---|
| Labor rates + source | ⚠️ approval before entering system |
| Material source | |
| Markup formula | |
| Customer-specific rates | |
| Estimate preparer / approver | |
| Fixed vs T&M mix | |
| Pricing source of truth | |

## §7 Scheduling and crew assignment

Ask: which calendar? who updates? fields per job? how availability known? crews fixed vs per-job? qualification rules? location/overtime affect assignment? change communication? early finish? return visits?

| Field | Answer |
|---|---|
| Calendar platform | |
| Required job fields | |
| Crew structure | |
| Availability rules | |
| Qualification rules | |
| Assignment logic | |
| Change process | |
| Return-visit process | |

## §8 Job completion and field reporting

Ask: how reported today? required info? photos required? signatures? hours submission? materials submission? reviewer? commonly missing? partial completion allowed? who decides return visit?

| Field | Answer |
|---|---|
| Completion fields | |
| Required evidence | |
| Review process | |
| Partial-completion rules | |
| Missing-info patterns | |
| Return-visit approver | |

## §9 Payroll and ExakTime (B8, B9)

Ask: hours in ExakTime? per-job clock-in? who fixes missed punches? OT calc? travel hours? breaks? payroll approver? export process? ExakTime cost? replace vs integrate?

| Field | Answer |
|---|---|
| Job-code usage | |
| Missed-punch fixer | |
| OT + rounding rules | |
| Travel hours | |
| Breaks (lunch 12:00–12:30 unpaid CONFIRMED) | confirmed |
| Payroll approver | |
| Export process | |
| ExakTime cost | |

## §10 QuickBooks (B4)

Ask: Online or Desktop? admin access who? customers/estimates/invoices/payments all in QB? invoice types? change orders? invoice creator/approver/sender? QB stays system of record? allow automation to draft in QB? ever auto-send?

| Field | Answer |
|---|---|
| QB product + version | |
| QB admin | |
| What lives in QB | |
| Invoice types | |
| Change-order process | |
| Draft-in-QB permitted? | |
| Auto-send stance | |

## §11 Automatic sending rules (per-message matrix)

For each: auto-send / draft-for-approval / notify-only + required approver + exceptions?

| Message type | Mode | Approver | Exceptions | Confidence req |
|---|---|---|---|---|
| Out-of-territory decline | | | | |
| Request acknowledgment | | | | |
| Missing-info request | | | | |
| Service-call confirmation | | | | |
| Estimate | | | | |
| Proposal | | | | |
| Schedule confirmation | | | | |
| Crew dispatch | | | | |
| Change order | | | | |
| Completion notice | | | | |
| Final invoice | | | | |
| Payment reminder | | | | |

(Current v1 defaults in REQUIREMENTS.md approval matrix — boss answers may revise.)

## §12 IT and access blockers (I1, I2)

Ask: M365 manager? Entra app creator? shared mailbox creatable? calendar access for automation? QB access manager? ExakTime admin? internal IT provider? restrictions on customer data in Supabase? approval needed before n8n connects to company accounts?

| Field | Answer |
|---|---|
| M365 admin | |
| Entra app approver | |
| Shared mailbox decision | |
| IT contact / provider | |
| QB admin | |
| ExakTime admin | |
| Data-storage restrictions | |
| n8n connection approval | |
| Expected access timeline | |

## Closers

1. "What is the ONE office task you most want removed from your workload first?" →
   **ANSWERED 2026-07-17 (via Jack):** daily time-punch verification + job-number
   entry. When a job gets a number it must be manually entered into ExakTime; then
   someone checks every employee clocked in at the RIGHT place and did not run over
   time. Wants geofence validation, ~1-mile radius. **~1 hour lost per day** on work
   he considers automatable. → This is Workstream A territory and mostly already
   built (server geofence flags, per-site radius, flags page). See DECISION_LOG
   2026-07-17 MVP-challenge note.
2. "What is the ONE mistake this automation must never make?" → ___ (STILL OPEN — ask)
