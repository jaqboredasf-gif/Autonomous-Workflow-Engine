# Current-State Workflow — Working Model

Status: **WORKING MODEL — broadly affirmed 2026-07-17** (Jack, after reviewing with
boss context: "everything stated is correct"). Specific values (volumes, mailbox
name, names→roles) still unconfirmed — see ASSUMPTIONS_AND_OPEN_QUESTIONS.md. Items
individually confirmed get re-tagged [CONFIRMED <date>] in place.

## 0. Boss's #1 stated pain (2026-07-17 — outranks everything below)

Daily time-punch verification + job-number entry: when a job gets a number, someone
manually enters it into ExakTime; then verifies each employee clocked in at the
right site and didn't run over time. Wants geofence validation (~1-mile radius).
**~1 hour/day lost.** Note: largely Workstream A scope, and mostly built already
(server-side geofence flags, per-site radius, web flags page). Gaps: job-number
propagation to time system, daily exception report (wrong-site + overtime),
1-mile default radius config. Overtime flagging precision blocked by B8 (OT/rounding
policy). Feeds Phase 4 MVP-priority decision.

## 1. How requests enter the company

| Channel | Est. volume | Notes |
|---|---|---|
| Phone calls (mostly to owner) | ~10–20 / business day | **Larger bottleneck than email.** Not automatable in MVP. |
| Email | ~3–10 / business day | MVP target: written, classifiable, auditable. |
| Direct to specific employees | unknown | Existing customers call/email people they know. |
| Referrals / contractors / property managers / repeat customers | unknown | Path into company unclear. |
| Website form / voicemail | unknown if they exist | Confirm. |

MVP intake decision (2026-07-17): **email-first.** Explicitly does NOT claim to solve
intake — phone is the bigger channel. Phone-call intake recorded as future workflow;
bridge = manual intake form office staff use to enter phone requests into the same
work_request pipeline (shortly-after-MVP candidate, spec in Phase 4).

## 2. People map (roles, not headcount — headcount unconfirmed)

| Role | Does today (working model) | Notes |
|---|---|---|
| Owner / boss | Reviews important requests; accept/decline; final call on unusual/high-value jobs; approves estimates, scheduling, invoices | **The bottleneck by design** — too much reaches him first. Automation goal: strip sorting/forwarding/data entry from him, preserve approval authority. |
| Office admin / office staff | Reviews email, enters data into calendar/spreadsheets, helps schedule, communicates with customers/employees, may prepare invoices | Headcount + names unconfirmed. |
| Dispatcher / project coordinator | Assigns crews, checks availability, communicates job details, updates shared calendar | Probably NOT a dedicated person — likely owner or office staff wearing the hat. |
| Estimator / PM | Reviews drawings, calculates labor+material, prepares estimates | May require owner approval before send. Existence as distinct person unconfirmed. |
| Crew leader / field supervisor | Receives job info, tracks who worked, reports completion, photos/notes/hours/materials | Maps to existing foreman role in Workstream A. |
| Accounting / payroll | Reviews time records, payroll, creates/reviews invoices, AR in QuickBooks | QB variant still unconfirmed. |

Several roles may be the same person. Permissions design (Phase 2) must be per-role,
not per-person, so it survives whatever the real org chart turns out to be.

## 3. One job, request → payment (working model, 16 steps)

1. Customer calls or emails describing electrical issue.
2. Owner or office reviews: territory? emergency? service call vs larger project? info missing?
3. Request forwarded by email or verbally to another employee.
4. Customer/job details entered into one or more of: Outlook, shared calendar, Excel, notes/texts, QuickBooks customer records. **Same data typed multiple times.**
5. Someone checks calendar + crew availability.
6. Date picked, communicated to customer.
7. Job added to shared calendar.
8. Crew gets details via email, text, phone, printed paperwork, or calendar (inconsistent).
9. Crew travels, does work.
10. Crew reports: who worked, hours, work done, materials, photos, return-trip needed.
11. Office/owner reviews completion info.
12. Fixed-price: approved proposal amount used.
13. T&M: labor hours + materials calculated.
14. Invoice created (QuickBooks or current accounting process).
15. Invoice reviewed, sent.
16. Payment recorded, job closed.

**Verification task open:** trace one actual completed job against these steps to find
the real waiting points. Until then this is a plausible reconstruction.

## 4. Delay / waste points (working model, ranked by suspected cost)

1. Requests sitting unread in owner's inbox.
2. Owner manually forwarding email.
3. Missing customer/job info → back-and-forth.
4. Waiting on someone to check the shared calendar; crew availability unclear.
5. Completion info arriving in inconsistent formats.
6. Payroll hours reconstructed after the job.
7. Invoice creation waiting on job details or approval.
8. Duplicate data entry across Outlook / calendar / Excel / QuickBooks.

## 5. Systems in use today

Microsoft Outlook, shared Microsoft calendar, Excel, QuickBooks (variant unconfirmed),
phone + SMS, possibly Dispatch Pilot (unevaluated, parked). Planned: Supabase + n8n
(this project).

## 6. Emergency handling today (working model)

Weekday 2pm, "burning smell":
1. Owner/office receives call or email → treated urgent immediately, outside normal scheduling.
2. Owner or qualified employee judges whether immediate response required.
3. Available tech contacted by phone; normal work rearranged.
4. Customer given safety guidance (call 911 if smoke/fire/immediate danger).
5. Job added to schedule or communicated directly.

After-hours (9pm weekend): customer may reach owner or an emergency contact directly;
after-hours number/voicemail process unconfirmed; owner decides response; if nobody
available, customer directed to emergency services or alternative.

Hard rule carried into MVP (already in REQUIREMENTS.md): automation never decides a
dangerous situation is safe, never sends repair instructions, always states that
immediate danger/fire/smoke/injury = call emergency services, always requires a
human response.

## 7. Territory decisions today (working model)

Likely lives in the owner's head, weighing: distance from office, city/county/zip,
licensing boundaries, job type+size, existing relationship, crew availability, travel
profitability. Real source may be owner's knowledge, a towns list, license docs, past
customer records, a spreadsheet, or nothing written.

**Decision 2026-07-17 (refines 2026-07-16 lock):** auto-decline DISABLED entirely —
including "definite rule" cases — until the owner approves a verified, complete
territory rule set. Until then out-of-territory = drafted decline for human review.
v1 therefore ships with ZERO auto-sends until that approval. Territory table design
must support: zips, towns, counties, mileage radius, per-customer and per-job-type
exceptions, and a recorded reason for every accept/decline/escalate.
