# User Workflows

## Actors

| Actor | Role in system |
|---|---|
| Owner (boss) | Final approver: estimates, change orders, uncertain/sensitive messages. Emergency contact default. |
| Office/admin staff | Approve routine drafts (confirmations, dispatch, completion, invoices), correct records. |
| Estimator | Prepares/approves estimates for larger jobs. [ASSUMPTION: exists as role] |
| Dispatcher | May be same person as office/admin. Reviews dispatch drafts. |
| Field electrician (Service, Commercial/Residential) | Punches in/out on mobile app, receives dispatch notification, marks job complete with photos/notes. |
| Foreman | Crew punch, first-level timesheet approval. |
| Customer | Sends work request emails, receives decline/confirmation/proposal/invoice emails. |
| Automation (n8n + AI + DB triggers) | Classifies, drafts, schedules, escalates. Never final authority on sensitive actions. |

## Workflow 1 — Inbound work request (boss's decision tree + emergency branch)

```
Email arrives at shared mailbox [BLOCKED: Graph — test fixtures until then]
 └─ Stored raw + immutable → classified
     ├─ EMERGENCY (burning smell, smoke, sparking, fire, live wiring, shock,
     │  safety-equipment power loss, flooding near electrical)
     │   → urgent flag, high-priority record, halt auto-scheduling,
     │     notify emergency contact, HUMAN takes over, reasoning audited.
     │     Never send troubleshooting advice.
     ├─ OUT OF TERRITORY (definite rule, high confidence)
     │   → AUTO-SEND polite decline. Logged. Low confidence → draft for human.
     ├─ SERVICE CALL (1 electrician, <1 day, basic material)
     │   → capture Commercial/Residential + urgency
     │   → propose next available matching Service electrician
     │   → DRAFT confirmation email (w/ standard service pricing) → human approves → send
     │   → calendar entry → DRAFT dispatch notification → human approves → send
     └─ ESTIMATE JOB (larger than service call)
         → capture Commercial/Residential + urgency
         → route to next available qualified Estimator
         → if drawings/info sufficient: prepare estimate (flag if pricing incomplete)
         → internal approval (boss/estimator) → proposal DRAFT → human approves → send
         → customer approves → schedule qualified crew → confirmation/calendar/dispatch as above
```

## Workflow 2 — Job completion → invoice

```
Electrician marks complete in mobile app (exists: completion_reports)
 → work_complete / return_trip_needed captured
 → job.completed event
 → invoice record generated:
     fixed-price: proposal amount + approved change orders (completion confirmed first)
     T&M: approved time records + approved materials + approved extras
 → human review (supervisor/office) → send [NEVER autonomous in v1]
 → calendar updated
```

## Workflow 3 — Daily time tracking (exists, live)

Punch in/out (offline queue, GPS accuracy, optional photo) → server geofence flags → foreman approve → admin lock → payroll draft w/ 12:00–12:30 unpaid lunch → corrections via timecard_corrections only.

## Workflow 4 — Payroll cutover (decided)

Run Exattime parallel with ExakTime 2 consecutive pay periods → compare totals → match → boss cancels ExakTime. ExakTime is the fallback throughout.

## Current manual workflow (to be confirmed with boss — discovery task)

[ASSUMPTION] Owner reads all inbound mail, decides territory/type mentally, forwards to estimator or schedules directly, office produces invoices after completion. Exact steps, volumes/day, and who-does-what unconfirmed.
