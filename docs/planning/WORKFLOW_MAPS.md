# Workflow Maps

Status: Phase 3A (Maps 1–7, intake side, 2026-07-17) + Phase 3B (Maps 8–21, delivery
side, 2026-07-17). 3B scope = Jack's 14-workflow decomposition merged onto the
canonical grounding list (LLM-council verdict, DECISION_LOG 2026-07-17 Phase 3B
entry). Template note: Maps 8–21 use Jack's 12-field template (roles field replaces
3A's classification-rules field); 3A maps NOT retrofitted — formats differ, content
is compatible.

Phase 3A scope per Jack's 2026-07-17 session prompt: seven intake-side workflows,
mapped separately. Estimate/proposal and customer job approval moved to Phase 3B
(see DECISION_LOG 2026-07-17 Phase 3A entry).

Grounding: PROJECT_SCOPE.md pipeline, REQUIREMENTS.md approval matrix,
STAKEHOLDERS_AND_PERMISSIONS.md roles, DATA_MODEL.md tables, RISKS_AND_EDGE_CASES.md
fixtures, USER_WORKFLOWS.md Workflow 1 (this file expands it; Workflow 1 stays as the
one-page summary — on conflict THIS file wins for intake detail).

Locked constraints honored throughout (DECISION_LOG):
- **ZERO auto-sends in v1** — auto-decline designed but feature-flagged off until owner
  approves verified territory rules. Every customer-facing send requires approval row.
- **Automation has zero approval authority** (STAKEHOLDERS universal rule 3).
- **Emergency halts auto-scheduling; system never sends troubleshooting advice.**
- **No hard deletes** — void/close with reason + audit row.
- Email-first: trigger = fixture insert now, Graph swap-in later [BLOCKED I1].

Legend: [ASSUMPTION] = unconfirmed, labeled per project rule. [OPEN B#/W#] = tracked
in ASSUMPTIONS_AND_OPEN_QUESTIONS.md. [P5] = schema/design detail finalized Phase 5.

---

## Shared intake spine (referenced by every map as "Spine steps 1–6")

1. Inbound email lands in dedicated mailbox (fixture insert in MVP; Graph later).
2. Stored as `email_messages` row — raw, immutable, `is_fixture` flag (DATA_MODEL).
3. **Emergency keyword safety net runs first, on every inbound, before anything can
   short-circuit** — including suspected duplicates and spam (REQUIREMENTS: AI miss
   must not be the only line of defense).
4. Dedupe check (Map 6) on `graph_message_id` / body hash.
5. `work_requests` row created, `status=new`; event `request.received`.
6. AI classification + confidence + reasoning stored; event `request.classified`.

**Classification precedence** (first match wins):
1. `emergency` — keyword net OR AI; beats everything, incl. out-of-territory
   (RISKS fixture: "out-of-territory + emergency → emergency wins, never auto-decline").
2. `not_a_work_request` (spam / vendor invoice) — proposed enum addition [P5], human
   confirms before close (Map 7 handles as triage).
3. `out_of_territory` (Map 3).
4. `service_call` vs `estimate_job` (Map 1/4; estimate-side continues in Phase 3B).
5. `unknown` or confidence below threshold → Map 7.

Missing-info (Map 5) is orthogonal: applies to any in-territory classification whose
required inputs are incomplete.

Triage queue owner = **office admin** [ASSUMPTION until B2 — could be owner today].

---

## Map 1 — New work request (baseline: in-territory, classifiable, complete)

**Trigger.** Spine steps 1–6; classification = `service_call` or `estimate_job`,
confidence ≥ threshold, territory check passes, no dedupe hit.

**Required inputs.** From email (parsed, human-correctable): customer name, reply-to
email, service address (geocodable — for territory + job_site), problem description,
property type Commercial/Residential, urgency (REQUIREMENTS "capture C/R + urgency").
Phone number wanted but minimum required-field set is [OPEN B10]. Fixture emails
supply these in MVP.

**Classification rules.** Precedence above. `service_call` = 1 electrician, <1 day,
basic material (boss's definition, PROJECT_SCOPE). `estimate_job` = larger. Boundary
ambiguity → lower confidence → Map 7. Territory check = SQL function vs
`service_areas`/territory rules (SAMPLE data until B5).

**Decision points.**
- D1 territory: in / out (→ Map 3) / ungeocodable (→ Map 7, RISKS: "never auto-decline
  on failed geocoding").
- D2 type: service_call (→ Map 4) vs estimate_job (→ routed to estimator; estimate
  workflow itself = Phase 3B).
- D3 completeness: required inputs present? No → Map 5.
- D4 sensitivity: high-value / unusual / sensitive → always-draft + flag to owner
  (approval matrix last row), regardless of confidence.

**Human approvals.** None to *record* the request (automation may create records
freely). Every outbound consequence needs its own approval per matrix. Human may
reclassify at any time (audited); reclassification re-routes to the matching map.

**Automated actions.** Spine storage/classification/geocoding/territory result;
create/match `customers` row [P5 matching rule]; draft nothing customer-facing at
this stage. No scheduling without approval (Map 4).

**Status transitions.** `new` → (`awaiting_info` Map 5 | `escalated` Map 2 |
`declined` Map 3 | `awaiting_approval` Map 4 | `needs_review` Map 7). Terminal states
only via those maps. New statuses `awaiting_info`, `needs_review`, `duplicate` are
proposed additions to the DATA_MODEL enum [P5] — logged DECISION_LOG 2026-07-17.

**Notifications.** In-app queue for triage owner. No customer-facing notification at
intake (acknowledgement auto-reply is NOT in scope — would be an auto-send; parked in
TASK_BACKLOG future improvements). Digest-vs-immediate cadence [OPEN W1].

**Audit-log events.** `request.received`, `request.classified` (with confidence +
reasoning), plus `integration_events` row per DB convention. Human reclassification →
audit row (who/what/prior value — universal rule 2).

**Failure cases.** Geocoding fails (→ Map 7 path, never decline); parser extracts
wrong fields (human corrects, audited); attachment-only email (RISKS fixture) →
classification likely `unknown` → Map 7; non-English email → Map 7 unless emergency
keywords hit.

**Escalation path.** Anything uncertain/sensitive → owner (approval matrix). Requests
sitting untriaged: service-call confirmations already carry "unanswered 4h → owner"
(matrix); a general intake-SLA for untouched `new` rows is [OPEN W1].

**Definition of completion.** Request has left `new` into exactly one downstream
state via one of Maps 2–7 (or estimator routing), with classification, territory
result, and all events recorded, and any human override audited.

---

## Map 2 — Emergency request

**Trigger.** Spine step 3 keyword hit (burning smell, smoke, sparking, electrical
fire, exposed live wiring, shock, safety-equipment power loss, flooding near
electrical — REQUIREMENTS list) OR AI classification = `emergency`. Union of the two
nets (either alone suffices). Fires even on suspected duplicates and mid-thread
replies (RISKS: "emergency buried in a long thread").

**Required inputs.** Callback contact + address if present. **Nothing is required to
escalate** — an emergency with missing fields still escalates immediately; Map 5
follow-up never delays Map 2.

**Classification rules.** Precedence rule 1 — beats out-of-territory (never
auto-decline an emergency), beats dedupe short-circuit, beats spam suspicion.
Vague danger language ("outlet feels hot", RISKS edge case) → if AI flags possible
emergency at ANY confidence → treat as emergency (fail-safe direction).

**Decision points.** Automation has exactly one: emergency-or-not, biased toward
yes. All real decisions (respond now? dispatch whom? advise what?) are human-only.

**Human approvals.** Human response is REQUIRED (REQUIREMENTS must). Emergency
response decisions = owner per STAKEHOLDERS matrix; any qualified human may
acknowledge [ASSUMPTION — ack authority pending B2/B6]. No outbound message of any
kind without approval; emergency outbound templates contain ONLY "call 911 if
immediate danger / we are contacting you now" content — never generated electrical
instructions (RISKS #2 hard rule).

**Automated actions.** Force `status=escalated`; DB trigger forbids shift creation
for the request (DATA_MODEL); emit escalation event with contact payload; deliver via
configured `emergency_contacts` channel (n8n; channel unconfirmed [OPEN B6] — must
not be email-only after hours, RISKS fixture). Optionally draft the safety-template
reply for human approval. Nothing else.

**Status transitions.** any → `escalated` (forced, immediate). `escalated` →
(`scheduled` | `converted` | `closed`) only after human ack clears the halt
(TASK_BACKLOG B4 acceptance). Re-classification OUT of emergency = human-only,
audited, with reason.

**Notifications.** Emergency contact per priority order in `emergency_contacts`.
Ack timeout + second-line contact and timing = [OPEN B12]. Duplicate email on an
active emergency → append to original AND re-notify (design decision, DECISION_LOG
2026-07-17) — never silently swallowed.

**Audit-log events.** `request.received`, `request.classified`,
`request.emergency_escalated` (with keyword/AI source + reasoning preserved —
REQUIREMENTS), human ack event, any reclassification audit row.

**Failure cases.** AI misses + keywords miss (RISKS #1 — residual risk, mitigated by
Map 7 catching low-confidence and by fixture coverage: vague wording, non-English,
photo-only, buried-in-thread); escalation channel delivery fails → n8n retry +
[OPEN B12] fallback; nobody acks → timeout escalation [OPEN B12]; false positive →
human downgrades with reason (acceptable cost, fail-safe bias).

**Escalation path.** IS the escalation path. Contact priority 1 → timeout → priority
2 → … [values OPEN B6/B12]. Owner is default contact (USER_WORKFLOWS actors).

**Definition of completion.** A human has acknowledged, decided the response, and the
request has moved out of `escalated` with the full chain (original email, keyword/AI
trigger, notification delivery, ack, decision) in the audit log. No troubleshooting
advice was ever sent.

---

## Map 3 — Out-of-territory request

**Trigger.** Spine 1–6; NOT emergency; geocoding succeeded; territory check returns
out-of-territory with matched rule + distance in `territory_result` jsonb.

**Required inputs.** Geocodable service address (else Map 7 — ungeocodable is NEVER
treated as out-of-territory); customer reply-to for the decline draft.

**Classification rules.** Territory = SQL function vs territory rules supporting
zips, towns, counties, mileage radius, per-customer + per-job-type exceptions, with
recorded reason (DECISION_LOG lock). Data is SAMPLE (Westchester/Bronx) until B5 —
one more reason nothing auto-sends.

**Decision points.**
- D1 definite rule + high confidence vs uncertain → both paths currently produce a
  DRAFT (auto path exists in design, feature-flagged off — DECISION_LOG 2026-07-17).
- D2 exception candidate? (big job, existing customer, borderline distance) → owner
  may accept as territory exception (STAKEHOLDERS: owner creates
  "territory-exception acceptances").

**Human approvals.** Decline send: approver per matrix row (post-hoc-visible auto is
the *future* mode; v1 = human approves every decline before send). Approver role for
the drafted decline in v1 = office admin [ASSUMPTION — matrix row was written for
auto mode; explicit v1 approver = OPEN W2]. Territory exception = owner only.

**Automated actions.** Territory evaluation + `territory_result` write; polite-decline
draft in `outbound_messages` (`status=draft`); `message.draft_created` event. NO send.
When (future) owner approves verified rules + flips `message_policies` mode to auto:
`request.auto_declined` event path activates — owner + sysadmin jointly modify the
matrix (STAKEHOLDERS).

**Status transitions.** `new` → `awaiting_approval` (decline draft pending) →
`declined` (approved + sent, human marks/sends) | → back to in-territory flow if
owner grants exception (audited reclassification → Map 1 D2).

**Notifications.** Draft appears in approval queue (B5 web page). Declines visible
for correction after the fact (RISKS #3 mitigation).

**Audit-log events.** `request.received`, `request.classified`, `territory_result`
stored with matched rule + reason, `message.draft_created`, `message.approved`,
`message.sent`, or exception-acceptance audit row.

**Failure cases.** Wrong decline = lost revenue (RISKS #3, money-critical) —
mitigated by v1 human gate on every decline; geocoding wrong (address matched wrong
town) — human sees address + map before approving [ASSUMPTION UI shows this — B5
task]; customer replies disputing territory → reply lands as new inbound, threads to
same request (Map 6 thread handling), human handles.

**Escalation path.** Borderline/exception candidates → owner. Low-confidence
territory result → Map 7 instead of decline draft.

**Definition of completion.** Request in `declined` with sent decline + full audit
chain, OR converted to in-territory via owner exception with recorded reason.

---

## Map 4 — Service-call request

**Trigger.** Map 1 D2 = `service_call` (1 electrician, <1 day, basic material),
in-territory, required inputs complete.

**Required inputs.** Map 1 set + urgency + Commercial/Residential (drives electrician
matching: skills[] on users). Standard service pricing for the confirmation email
requires `price_book` rows with source + last_updated — placeholders block send if
incomplete (REQUIREMENTS: incomplete pricing flags + blocks).

**Classification rules.** As Map 1; C/R + urgency captured per boss's pipeline step 3
(PROJECT_SCOPE).

**Decision points.**
- D1 proposed electrician + slot: automation PROPOSES next available matching Service
  electrician (reuses shifts + find_best_worker — TASK_BACKLOG B6); human may
  override assignment.
- D2 confirmation draft OK? (correct pricing, date, address).
- D3 dispatch draft OK?

**Human approvals.** Two matrix rows, two approvals: service-call confirmation →
office admin (escalation: unanswered 4h → owner); crew dispatch message →
dispatcher/admin. Schedule entry itself: created on confirmation approval
[ASSUMPTION: approving the confirmation authorizes the calendar entry — one approval
covers both; alternative is separate scheduling-confirmation row; W3].

**Automated actions.** Propose electrician + slot; draft confirmation email w/
standard service pricing; on approval: create `shifts` row + calendar entry [calendar
write BLOCKED I1 — DB-side only in MVP], draft dispatch notification; emit events.
Emergency-classified requests are REFUSED by the scheduling trigger (B6 acceptance).

**Status transitions.** `new` → `awaiting_approval` (confirmation draft) →
`scheduled` (confirmation approved + sent, shift created) → `converted` (job created)
per DATA_MODEL statuses. Rejection of draft → back to `awaiting_approval` with
revised draft or human takes over manually (audited).

**Notifications.** Approval queue: confirmation to office admin, dispatch to
dispatcher. Customer receives confirmation only after approval + send. Crew receives
dispatch only after its approval + send (channel: email draft in MVP; text/print
paths stay manual — CURRENT_WORKFLOW step 8 inconsistency not solved in MVP).

**Audit-log events.** Spine events + `message.draft_created` ×2, `message.approved`
×2, `message.sent` ×2, shift-creation audit, any assignment override audit row.

**Failure cases.** No matching electrician available → draft cannot propose slot →
human schedules manually or holds [OPEN W1 SLA]; pricing incomplete → confirmation
draft blocked from send, flagged (RISKS #4); double-booking → shifts conflict check
[P5]; customer no-reply to confirmation → job proceeds per matrix design? — matrix
only covers approver escalation, customer-silence policy is a 3B/scheduling concern.

**Escalation path.** Confirmation unanswered 4h → owner (matrix). Uncertain scope
(is this really <1 day?) → classification confidence should reflect it → Map 7 or
estimator route instead.

**Definition of completion.** Confirmation approved + sent, shift + calendar entry
exist, dispatch approved + sent, request `scheduled`/`converted`, all events logged.
(Job execution → completion → invoice = Workflow 2 / Phase 3B.)

---

## Map 5 — Missing-information follow-up

**Trigger.** Any in-territory, non-emergency request (Maps 1/4/estimate-route) whose
required-input set [OPEN B10] is incomplete after parsing + human glance. NEVER
triggers for emergencies (Map 2 escalates regardless of gaps).

**Required inputs.** A reply-to address (without it there is nothing to follow up
through → Map 7 / manual phone contact by office staff — phone is out of MVP scope).
List of specific missing fields, stored on the request [P5: `missing_fields` jsonb or
similar — Phase 5 detail].

**Classification rules.** None new — classification already assigned; this map only
gates progression. Completeness check is deterministic against the required-field
set per classification type [values OPEN B10].

**Decision points.**
- D1 automation: which fields are missing (deterministic).
- D2 human: is the info-request draft appropriate, or better to call? (office admin
  judgment — phone path exits the system, recorded as manual note).
- D3 on reply: does the reply actually complete the fields? (parser proposes, human
  confirms).

**Human approvals.** Info-request email = customer-facing send → needs approval row.
**New message type `missing_info_followup` proposed for the approval matrix**, mode
draft, approver office admin [ASSUMPTION approver — mirrors service-call
confirmation row; logged DECISION_LOG 2026-07-17, boss may revise via §11].

**Automated actions.** Detect gaps; draft info-request email listing exactly what's
needed (no troubleshooting content — universal hard rule applies to every template);
on inbound reply: thread-match to request (Map 6 logic), parse, propose field
updates; emit events. No auto-nudges in v1 (would be auto-sends); nudge cadence
[OPEN B11].

**Status transitions.** current → `awaiting_info` (proposed status [P5]) → back to
prior flow when fields complete (→ Map 1 D2 routing) | → `closed` with reason
"no response" after policy expiry [values OPEN B11 — do not invent; until answered,
closing is a manual human action with reason].

**Notifications.** Approval queue for the draft; triage queue shows `awaiting_info`
age; reply arrival re-surfaces the request to office admin.

**Audit-log events.** `request.info_requested` (proposed event [P5]),
`message.draft_created/approved/sent`, `request.info_received` on reply, field-update
audit rows (prior values kept), close-with-reason audit if abandoned.

**Failure cases.** Customer replies in same thread with partial info (loop back to
D1, second follow-up needs its own approval); reply creates new thread instead
(dedupe/thread-match, Map 6); reply is ambiguous (human interprets — RISKS "yes
approve" ambiguity pattern); reply reveals emergency ("actually it's sparking now")
→ keyword net runs on EVERY inbound incl. replies → Map 2 immediately; customer
never replies → manual close w/ reason until B11 policy exists.

**Escalation path.** Aged `awaiting_info` items surface in triage queue [SLA OPEN
W1/B11]. Anything sensitive → owner per matrix catch-all row.

**Definition of completion.** Either required fields complete and the request
re-entered its normal flow, or request `closed` with recorded reason and audit
trail. Follow-up itself: draft approved, sent, reply (if any) linked to the same
request.

---

## Map 6 — Duplicate request

**Trigger.** Spine step 4: inbound matches an existing `email_messages` /
`work_requests` row. Match tiers:
- T1 exact: same `graph_message_id` (Graph redelivery) — technical duplicate.
- T2 thread: In-Reply-To/References headers or Graph conversation id → same thread.
- T3 fuzzy: same sender + similar subject/body hash within a time window — forwarded
  copies, double-sends (RISKS fixture: "duplicate/forwarded copies of same request").
Window + similarity threshold [P5; no business policy involved].

**Required inputs.** The candidate match pair; nothing from the customer.

**Classification rules.** Emergency keyword net runs BEFORE dedupe short-circuit
(Spine rule): a "duplicate" containing new emergency language escalates via Map 2.
T1 = auto-handled. T2 = not a duplicate at all — it's thread activity: attach to the
existing request (this is how Map 5 replies and proposal replies arrive). T3 = human
confirms; automation never auto-closes a fuzzy match (design decision, DECISION_LOG
2026-07-17 — wrong auto-close = silently dropped customer request, mirror image of
RISKS #3).

**Decision points.** D1 tier (automation); D2 fuzzy confirm: duplicate / not
duplicate / same customer new issue (human, one click each [B5 UI]); D3 duplicate of
an ACTIVE emergency → append + re-notify (Map 2).

**Human approvals.** T3 confirmation = office admin (triage owner). No customer-facing
send involved (no "we got your email twice" message in v1 — would be an auto-send or
pointless draft).

**Automated actions.** T1: attach message to existing request, no new work_request.
T2: attach to thread's request, re-surface it in queue, run keyword net, emit event.
T3: create work_request in `needs_review`? — NO: create normally but flag
`duplicate_candidate` with link [P5 mechanics]; suppress downstream drafts until
resolved (prevents two confirmation drafts for one job).

**Status transitions.** Confirmed duplicate → `duplicate` (proposed status [P5]) with
mandatory `duplicate_of_work_request_id`; not-duplicate → continues normal flow
(Map 1). No hard delete ever (universal rule 1).

**Notifications.** Triage queue badge for fuzzy candidates; re-surfaced original on
thread activity.

**Audit-log events.** `request.duplicate_flagged`, resolution audit row (who
confirmed, linked ids), `request.closed`-as-duplicate event (proposed events [P5]).

**Failure cases.** False duplicate (two genuinely separate jobs, same customer, same
day) → human picks "same customer new issue", both proceed; missed duplicate → two
drafts for one job → caught at approval step (human sees both in queue — approval
gate is the backstop); duplicate arrives via phone later (out of MVP scope —
manual-intake-form bridge notes it, Phase 4).

**Escalation path.** None beyond triage; ambiguous cases are just D2 human calls.

**Definition of completion.** Every inbound attached to exactly one work_request;
confirmed duplicates in `duplicate` status linked to their original; no downstream
draft ever sent twice for one underlying job.

---

## Map 7 — Failed classification / low-confidence request

**Trigger.** Any of: classification = `unknown`; confidence < threshold (value per
`message_policies.confidence_threshold` — real values await boss §3/§11); geocoding
failed (territory unknowable); attachment-only or non-English content the classifier
can't read; suspected `not_a_work_request` (spam/vendor — proposed enum value [P5]);
classifier/pipeline ERROR (exception, timeout).

**Required inputs.** None — this is the catch-basin; it must accept anything.

**Classification rules.** This map is the mandated fallback of every other map's
uncertainty branch: uncertain territory → here, not auto-decline; uncertain
emergency → Map 2 (fail-safe wins over this map); uncertain service-vs-estimate →
here. RISKS #1 mitigation "anything uncertain escalates" lands here when the
uncertainty is not safety-shaped.

**Decision points.** All human: real request? → classify manually (route to Maps
1–6); spam/vendor → confirm `not_a_work_request`, close; unreadable → contact
customer (via Map 5 draft) or handle offline. Automation's only decision is "I am
not confident," which is not a decision about the customer.

**Human approvals.** Manual classification = office admin; sensitive/high-value/
unusual → owner (matrix catch-all: "always draft + flag, approver owner, immediate
escalation"). Spam close needs no owner involvement [ASSUMPTION].

**Automated actions.** Set `status=needs_review` (proposed status [P5]); preserve
full reasoning + confidence for the human; emit `request.triage_required` (proposed
event [P5]); on pipeline ERROR: store the failure, never drop the email — the
immutable `email_messages` row exists regardless of downstream failures (ingestion
isolated from classification, REQUIREMENTS must).

**Status transitions.** `new` → `needs_review` → (any Map 1–6 flow after manual
classification, audited) | `closed` (reason: spam/not-a-request). Human
classification writes the same fields automation would (classification, C/R,
urgency) so downstream flows are identical — one pipeline, two writers.

**Notifications.** Triage queue, flagged distinct from routine items; classifier
ERRORS additionally visible to sysadmin (system health, not business approval —
respects sysadmin business-approval bar). Owner notified only for the
sensitive/high-value flag or per cadence [OPEN W1].

**Audit-log events.** `request.received`, `request.classified` (with
unknown/low-confidence result + reasoning), `request.triage_required`, manual
classification audit row (who, prior value), close-with-reason audit.

**Failure cases.** Triage queue neglected → requests rot in `needs_review` (same
[OPEN W1] SLA gap as Map 1 — the queue's aging display is the v1 mitigation);
human misclassifies → correctable later, audited, and approval gates on all sends
bound the damage; spam misjudged as request → wasted draft, human catches; request
misjudged as spam → the money-critical version of this map; close-as-spam requires
positive human confirmation and stays visible/voidable, never deleted.

**Escalation path.** Sensitive/unusual/high-value → owner immediately (matrix).
Classifier systematically failing (accuracy regression vs B2 harness baseline) →
sysadmin investigates — operational, not per-request.

**Definition of completion.** Human has assigned a real classification (request
proceeds through its proper map) or closed with reason; zero emails unaccounted for:
every `email_messages` row maps to a work_request or a recorded close, with the
automation's uncertainty and the human's resolution both in the audit trail.

---

## Cross-map invariants (checklist for Phase 5 schema + B1 build)

1. Keyword emergency net runs on EVERY inbound — replies, duplicates, spam included.
2. Nothing customer-facing sends without an approval row; v1 total auto-sends = 0.
3. Every uncertainty branch lands in a HUMAN queue, never in an auto-negative
   (decline/close/ignore).
4. Every email row ends up attached to exactly one request or one recorded close.
5. All state changes evented (integration_events) + audited with prior values.
6. Proposed additions needing Phase 5 design + DECISION_LOG 2026-07-17 ratification:
   statuses `awaiting_info`/`needs_review`/`duplicate`; classification
   `not_a_work_request`; events `request.info_requested`/`request.info_received`/
   `request.duplicate_flagged`/`request.triage_required`/`request.closed`; matrix
   row `missing_info_followup`; `duplicate_of_work_request_id` link.

---

# Phase 3B — Delivery Side (Maps 8–21)

Scope: estimate → proposal → customer decision → scheduling → dispatch → completion
→ change orders → payroll touchpoint → invoicing → failure handling. Expands
USER_WORKFLOWS.md Workflow 2 (that file stays the one-page summary; on conflict THIS
file wins for delivery detail) and the estimate branch of Workflow 1.

Locked constraints honored throughout (DECISION_LOG — same set as 3A):
- **ZERO auto-sends in v1**; every customer-facing send requires an approval row.
- **Final invoice NEVER auto — in any version** (REQUIREMENTS matrix).
- **Automation has zero approval authority** (STAKEHOLDERS universal rule 3).
- **No hard deletes** — cancel/void with reason + audit row.
- **`pricing_complete=false` blocks estimate/proposal send** (DATA_MODEL computed).
- **v1 invoice mechanics CONFIRMED:** system drafts record → human creates invoice
  in QuickBooks manually, sends via Outlook → marks sent in system.
- Calendar writes + real mail [BLOCKED I1] — MVP is DB records + drafts.

## Shared delivery-side rules (referenced by every map as "Delivery rules")

1. **Every inbound customer reply** (proposal responses, reschedule requests,
   completion disputes) enters through the intake Spine: emergency keyword net runs
   FIRST (Spine step 3), then thread-match (Map 6 T2) attaches it to the existing
   request/job. "It's sparking now" in a proposal reply → Map 2 immediately.
2. **Human takeover is always legal** ("one pipeline, two writers", Map 7): any
   transition automation can propose, a permitted human can perform manually —
   same fields, same events, audited with prior values.
3. All state changes evented (`integration_events`) + audited (universal rule 2).
4. Automation proposes; humans decide. Applies to slot proposals, crew matching,
   AND interpretation of customer replies (see Map 10 design decision).
5. Roles cited from STAKEHOLDERS_AND_PERMISSIONS.md; approval rows cite the
   REQUIREMENTS matrix. Proposed NEW matrix rows are labeled [P5] and collected in
   invariant 11.

---

## Map 8 — Estimate preparation

**Trigger.** Map 1 D2 routes `estimate_job` to next available qualified estimator
(in-territory, non-emergency, required inputs complete per [OPEN B10]); OR a
service call reclassified as larger-than-service-call (Map 4 escalation); OR a
change order requiring re-estimate (Map 17 loop-back).

**Required inputs.** work_request (C/R, urgency, address, description); attachments/
drawings if any; `price_book` rows for needed labor/material/markup/overhead/tax/
contingency kinds — every row source + last_updated (REQUIREMENTS: no invented
prices); customer + job-site record; site-visit findings when drawings insufficient.

**Responsible roles.** Estimator: creates estimate + line items, modifies own drafts
until internal_review. Owner: sees everything, resolves routing conflicts.
Automation: routing to estimator, `pricing_complete` computation, staleness/
incompleteness flagging — creates NOTHING customer-facing here.

**Automated actions.** Route to next available qualified estimator [ASSUMPTION:
availability source = shifts/absence data; matching rule detail P5]; create
`estimates` row (`status=draft`, work_request link, estimator_id); compute
`pricing_complete`; flag line items whose price_item is unverified/stale; emit
`estimate.internal_review` when submitted.

**Human approvals.** None inside preparation itself (internal approval = Map 9).
Site-visit scheduling, if needed, follows Map 11 mechanics (it's a schedulable
visit) [ASSUMPTION site visits go on the same calendar — practice unconfirmed].

**Decision points.**
- D1 estimator: drawings/info sufficient to estimate without site visit? (boss's
  pipeline explicitly allows no-visit estimates when sufficient). Insufficient →
  site visit OR info request via Map 5 draft.
- D2 estimator/owner: billing type fixed_price vs T&M — decision practice
  [OPEN B17: who chooses billing type and on what basis? do not invent].
- D3 system: `pricing_complete`? false → estimate cannot leave internal_review
  toward send (hard gate).

**Status transitions.** `estimates`: `draft` → `internal_review` (estimator
submits). Back-edge: `internal_review` → `draft` (revision). work_request stays
`awaiting_approval` [ASSUMPTION — reuses existing status; estimate-specific request
status is a P5 call].

**Notifications.** Estimator queue (routed requests); owner visibility per
permissions. No customer contact in this map (info requests go via Map 5's approved
draft).

**Audit events.** `estimate.internal_review` (exists in DATA_MODEL event list);
line-item edits audited with prior values; routing + any manual re-route audited.

**Failure cases.** No qualified estimator available → request sits in estimator
queue, ages per [OPEN W1] SLA gap; pricing rows missing/unverified →
pricing_complete=false, flagged, send-blocked (RISKS #4); drawings unreadable →
Map 5 info request or site visit; estimator starts then goes unavailable → owner
re-routes (audited).

**Escalation path.** High-value / unusual / sensitive → owner immediately (matrix
catch-all; amount-threshold column exists, values await boss §3). Stuck-in-draft
aging → [OPEN W1].

**Definition of completion.** Estimate in `internal_review` with pricing_complete
true (or explicitly flagged incomplete and NOT sendable), line items sourced, and
the estimator's sufficiency decision recorded.

---

## Map 9 — Proposal approval and delivery

**Trigger.** Estimate reaches `internal_review`.

**Required inputs.** Complete estimate (pricing_complete=true — hard gate);
customer reply-to; proposal formatting template [P5].

**Responsible roles.** Internal approver: owner, or estimator IF boss authorizes
that person [ASSUMPTION until B2/§3 — matrix row "boss or authorized estimator"];
never the estimator approving their own send (STAKEHOLDERS: estimator "never their
own send"). Office admin: may handle the mechanical Outlook send after approval
[ASSUMPTION]. Automation: drafts the proposal message only.

**Automated actions.** On internal approval: `estimate.approved` event; generate
proposal draft in `outbound_messages` (`message_type=estimate_proposal`,
`status=draft`); `message.draft_created`. NO send — ever — without approval row.

**Human approvals.** Two gates: (1) internal estimate approval (owner/authorized
estimator) — approves the NUMBERS; (2) proposal message approval per matrix row
(same approver role) — approves the SEND. May be one action in UI [P5] but two
audit rows. Send mechanics v1: human copies approved draft into Outlook, sends,
marks sent [ASSUMPTION — mirrors the CONFIRMED v1 invoice flow; Graph send later].

**Decision points.**
- D1 approver: approve / reject-with-reason (→ estimate back to `draft`, estimator
  revises) / reject-and-close (request closed with reason).
- D2 amount ≥ threshold → owner only regardless of estimator authorization
  (threshold values await boss §3; column exists).

**Status transitions.** `internal_review` → `approved` → `sent` (human marked).
Rejection: `internal_review` → `draft` (revise) or `rejected` (with reason).
work_request: `awaiting_approval` → stays until customer decision (Map 10).

**Notifications.** Approval queue for approver; office admin sees approved-awaiting-
send items; customer receives proposal only via the human send.

**Audit events.** `estimate.approved`, `message.draft_created`,
`message.approved`, `message.sent` (marked), `proposal.sent`; rejections audited
with reason.

**Failure cases.** pricing_complete flips false after approval (price row edited) →
send re-blocked, re-approval required [P5 mechanics]; proposal sent but never marked
sent → status drift, reconciled via Map 21; approver unavailable → owner is always
a legal approver; ambiguous authorization (is this estimator "authorized"?) →
treat as NOT authorized until B2 answers.

**Escalation path.** Unanswered internal approvals age in queue [OPEN W1].
High-value → owner (matrix).

**Definition of completion.** Proposal approved (both gates), sent, marked sent,
`proposal.sent` logged, estimate in `sent` — awaiting customer response (Map 10).

---

## Map 10 — Customer approval or rejection

**Trigger.** Inbound email on the proposal thread (Delivery rule 1: keyword net
first, then Map 6 T2 thread-match). Phone acceptance = office enters manual note +
records decision [phone bridge is post-MVP; manual entry audited].

**Required inputs.** The reply; the sent proposal + estimate it answers.

**Responsible roles.** Automation: parses reply, PROPOSES interpretation. Office
admin: confirms interpretation (routine). Owner/estimator: handles counters/
negotiation. Customer: email-only actor (STAKEHOLDERS — no portal).

**Automated actions.** Thread-match to request; parse reply; propose one of:
clear-accept / clear-reject / ambiguous / counter-offer / unrelated; surface to
queue with proposed interpretation + confidence. **Design decision (2026-07-17):
automation NEVER sets customer_approved/customer_rejected on its own — human
confirms the interpretation** (extends zero-approval-authority to reading customer
intent; the "yes approve" ambiguity fixture is exactly this trap).

**Human approvals.** Interpretation confirm = office admin (one click). Counter/
negotiation → owner or estimator per Map 9 approval roles (revised estimate →
Map 8/9 loop). Any reply to the customer (e.g. "confirming go-ahead") = draft +
matrix approval [reuses scheduling-confirmation row when it doubles as the
scheduling step; else P5 row].

**Decision points.**
- D1 human: accept / reject / ambiguous (ask customer to clarify — via approved
  draft) / counter (→ revision loop) / unrelated (→ Map 6/7 routing).
- D2 on accept: proceed to scheduling (Map 11) — create `jobs` row (billing_type
  from estimate, origin work_request, customer, job_site).
- D3 on reject: capture reason if stated; close request (no hard delete).

**Status transitions.** `estimates`: `sent` → `customer_approved` |
`customer_rejected`. work_request → `converted` (job created) on accept; → `closed`
(reason: customer declined) on reject. Silence: stays `sent` — expiry/nudge policy
[OPEN B13 — until answered, follow-up is a manual human action with reason].

**Notifications.** Reply re-surfaces request in triage queue with proposed
interpretation; owner notified on counters [per matrix sensitivity row].

**Audit events.** `proposal.customer_approved` (exists); proposed
`proposal.customer_rejected` event [P5]; interpretation-confirm audit row (human,
proposed vs confirmed reading); job-creation audit.

**Failure cases.** Ambiguous "yes approve" (RISKS fixture) → human interprets,
never automation; acceptance of a STALE proposal (prices changed since send) →
human decides honor-or-revise [no policy — OPEN B13 validity window]; reply
contains emergency language → Map 2 wins immediately; customer replies from a
different address → fuzzy match (Map 6 T3) human-confirmed; verbal acceptance
never recorded → job proceeds without audit trail — mitigation: manual-entry note
REQUIRED before scheduling [design rule].

**Escalation path.** Counters, price disputes, stale acceptances → owner.
Aged `sent` proposals surface in queue [OPEN B13/W1].

**Definition of completion.** Customer decision recorded with human-confirmed
interpretation and full audit chain; accept → `jobs` row exists and Map 11 begins;
reject → request closed with reason, estimate `customer_rejected`.

---

## Map 11 — Job scheduling

**Trigger.** Job created from customer approval (Map 10 D2); OR service-call
confirmation approved (Map 4 — whether that approval also authorizes the calendar
entry is [OPEN W3]; one-approval assumed); OR return visit needs a slot (Map 16);
OR site visit for estimating (Map 8 D1).

**Required inputs.** Job (billing_type, scope, site); duration expectation
[estimate hours or service-call default — default value P5]; skill requirements
(C/R, qualifications); crew/electrician availability (shifts); customer
availability from the thread if stated.

**Responsible roles.** Dispatcher (may be same human as office admin): creates
shifts + assignments. Office admin: approves scheduling confirmation (matrix row).
Automation: proposes slot + crew. Customer: receives confirmation after approval.

**Automated actions.** Propose next available slot + matching crew (reuse
`find_best_worker` + shifts — TASK_BACKLOG B6); conflict check against existing
shifts [P5 mechanics]; draft scheduling-confirmation email; on approval: create
`shifts` row(s); calendar entry [BLOCKED I1 — DB-side only in MVP]; emit events.
Emergency-classified requests are REFUSED by the scheduling trigger (existing DB
lock — B4 acceptance).

**Human approvals.** Scheduling confirmation → office admin (matrix row, draft
mode). Human may override proposed slot/crew before approving (audited).

**Decision points.**
- D1 automation proposes; human accepts/overrides slot + crew.
- D2 no viable slot (no qualified crew in acceptable window) → human negotiates
  with customer via approved draft or holds [no SLA policy — OPEN W1].
- D3 multi-day/multi-crew job → multiple shifts under one job [P5 modeling].

**Status transitions.** job: → `scheduled` [P5 — job status enum proposed:
`scheduled|dispatched|in_progress|completed|return_needed|invoiced|closed|
cancelled`]. work_request: → `scheduled` (existing status) where still tracked.

**Notifications.** Approval queue (confirmation draft); customer gets confirmation
after approval + send; dispatcher sees new shifts.

**Audit events.** `message.draft_created/approved/sent` (confirmation); shift
creation audit; proposed `job.scheduled` event [P5]; slot/crew override audit.

**Failure cases.** Double-booking → conflict check blocks, human resolves;
customer never confirms proposed date → no shift until confirmation approved+sent
per W3 model [customer-silence policy OPEN B13-adjacent]; crew availability data
wrong (absence not recorded) → day-of failure → Map 14; geographically absurd
routing (two far sites, one day) — v1 human catches, no route optimization.

**Escalation path.** Unschedulable jobs age in dispatcher queue [OPEN W1];
customer disputes/date conflicts → office admin → owner if sensitive.

**Definition of completion.** Confirmation approved + sent, shift(s) exist and
conflict-free, job `scheduled`, all events logged. (Dispatch = Map 13.)

---

## Map 12 — Crew assignment

**Trigger.** Scheduling (Map 11) needs a crew; OR pre-dispatch change (swap,
absence); OR skills mismatch discovered after scheduling.

**Required inputs.** Shift(s); required skills (C/R, qualifications from job
scope); `users.skills[]`; crew composition (crews table); absence/availability.

**Responsible roles.** Dispatcher: creates/modifies assignments until job
completion (STAKEHOLDERS — audited). Automation: proposes via `find_best_worker`.
Crew leader (foreman): informed via dispatch (Map 13); does NOT self-assign.

**Automated actions.** Propose best-match electrician(s)/crew for shift; flag
skills mismatch on manual assignments; emit assignment events [P5 event naming].
No customer-facing output — this map is internal.

**Human approvals.** None in the matrix (no customer send). Dispatcher decision IS
the approval; every assignment/override audited (universal rule 2).

**Decision points.**
- D1 accept proposed crew vs override (dispatcher judgment: skills, customer
  history, geography).
- D2 no qualified worker available → back to Map 11 D2 (re-slot) or split job.
- D3 assignment change after dispatch already sent → forces re-dispatch (Map 13)
  and possibly customer re-confirmation (Map 14) if timing shifts.

**Status transitions.** Shift assignment fields updated; job stays `scheduled`.
No request-level transitions.

**Notifications.** Dispatcher queue; affected crew notified only via approved
dispatch messages (Map 13) — assignment alone notifies nobody externally.

**Audit events.** Assignment create/change audit rows (who, prior value); skills-
mismatch flag events [P5].

**Failure cases.** Stale skills[] data → mismatch flagged late; worker sick day-of
→ dispatcher reassigns (audited) → re-dispatch; assignment to worker already
punched in elsewhere → conflict flag [P5 check]; nobody qualified → owner decides
(subcontract/decline path is business judgment, not system).

**Escalation path.** Unfillable assignments → owner. Repeated mismatch flags →
sysadmin reviews skills data quality (operational).

**Definition of completion.** Every shift for the job has an assigned, qualified,
non-conflicting crew; changes audited; dispatch (Map 13) unblocked.

---

## Map 13 — Crew dispatch

**Trigger.** Assignment complete + scheduled date approaching. WHEN dispatch goes
out (day before? on approval?) is [OPEN W4 — v1: human-triggered from the queue,
no auto-cadence].

**Required inputs.** Shift + assignment; job details package: address, scope,
notes, access instructions, photos — NOT pricing (STAKEHOLDERS: crew roles never
see pricing).

**Responsible roles.** Automation: drafts dispatch notification. Dispatcher (or
office admin per matrix "dispatcher/admin"): approves + sends. Crew leader / field
electrician: recipients.

**Automated actions.** Generate dispatch draft per assigned crew (email in MVP;
text/print stay manual — CURRENT_WORKFLOW step 8 inconsistency explicitly NOT
solved in MVP); emit `message.draft_created`; proposed `job.dispatched` event on
send [P5].

**Human approvals.** Dispatch message → dispatcher/admin (matrix row, draft mode).

**Decision points.**
- D1 approver: details correct/complete? (wrong address in a dispatch = wasted
  truck roll).
- D2 channel: email sufficient for this crew, or manual text/print supplement?
  (human judgment, recorded as note — v1 does not model non-email channels).

**Status transitions.** job: `scheduled` → `dispatched` [P5 enum]. Shift unchanged.

**Notifications.** Approval queue → crew email on send. No customer notification
in this map (customer already has the confirmation from Map 11).

**Audit events.** `message.draft_created/approved/sent`; `job.dispatched` [P5];
any post-send correction (re-dispatch) audited.

**Failure cases.** Crew never reads email (channel inconsistency — known gap) →
no in-system acknowledgment exists in v1 [crew-ack feature → future improvements];
details change after send → re-dispatch draft required (Map 14 trigger); dispatch
sent to wrong/reassigned crew → correct + re-send, both audited; job day arrives
with NO dispatch sent → punches still work (Workstream A independent), gap caught
in attendance verification (Map 18).

**Escalation path.** Undispatched jobs nearing their date surface in dispatcher
queue [OPEN W1/W4]; repeated channel failures → owner decides process change.

**Definition of completion.** Approved dispatch sent to every assigned crew member/
leader for the shift, job `dispatched`, events logged.

---

## Map 14 — Schedule change or cancellation

**Trigger.** Customer requests change/cancel (inbound reply — Delivery rule 1:
keyword net first); OR company-side change (crew unavailable, weather, prerequisite
not met); OR emergency preemption (Map 2 halt + owner rearranges normal work,
CURRENT_WORKFLOW §6); OR scope change (Map 17) alters duration.

**Required inputs.** Existing shift(s)/job; reason for change (MANDATORY — no
silent moves); new proposed slot if rescheduling.

**Responsible roles.** Dispatcher: modifies shifts (until completion — audited).
Office admin: approves customer-facing reschedule/cancel notice. Owner: emergency
preemption decisions; cancellation of approved jobs [ASSUMPTION owner authority
required to cancel a customer-approved job — OPEN B14]. Customer: initiates or
receives notice.

**Automated actions.** Re-run Map 11 proposal machinery for new slot; draft
re-confirmation (reschedule) or cancellation notice; flag downstream artifacts
needing rework (dispatch re-send, calendar update [BLOCKED I1]); emit proposed
`schedule.changed` / `schedule.cancelled` events [P5]. Never auto-notify.

**Human approvals.** Reschedule notice: reuses scheduling-confirmation matrix row
[ASSUMPTION]; cancellation notice: NO matrix row exists — proposed new row
`cancellation_notice` (mode draft, approver office admin) [P5 + OPEN W5]. Company-
initiated cancellation of an approved job → owner [ASSUMPTION — B14].

**Decision points.**
- D1 change vs cancel.
- D2 who initiated (customer/company/emergency) — drives tone + approver.
- D3 after dispatch already sent? → re-dispatch required (Map 13).
- D4 cancellation after work partially done → NOT this map: that's completion
  accounting (Map 15/16) + invoicing question [OPEN B15].

**Status transitions.** Reschedule: shifts moved (audited), job stays
`scheduled`/`dispatched`. Cancel: shift `cancelled` with reason (no hard delete);
job → `cancelled` [P5 enum] with reason; work_request → `closed` (reason).

**Notifications.** Customer notice only after approval + send; affected crew via
re-dispatch or internal note; owner on cancellations [ASSUMPTION].

**Audit events.** `schedule.changed`/`schedule.cancelled` [P5]; reason captured on
every change; message events for notices.

**Failure cases.** Customer cancels day-of / crew already en route → phone-speed
problem, system records after the fact (manual note, audited); reschedule email
crosses with dispatched crew → known race, human coordinates, system records;
cancellation fee practice unknown [OPEN B14 — do not invent]; serial reschedules →
visible history via audit rows.

**Escalation path.** Emergency preemption = owner (Map 2). Disputes → owner.
Cancellation of high-value jobs → owner [B14].

**Definition of completion.** New schedule confirmed (approved + sent + shifts
moved) OR job cleanly cancelled (reason recorded, notice approved + sent if
customer-facing, downstream artifacts voided, nothing hard-deleted).

---

## Map 15 — Job completion

**Trigger.** Crew leader / field electrician submits completion report in mobile
app (EXISTS: `completion_reports`) — `work_complete` or `return_trip_needed`, with
photos, notes, hours, materials.

**Required inputs.** Completion report; for T&M billing readiness: who worked +
hours (punches, Map 18) + materials used.

**Responsible roles.** Crew leader/electrician: submits report. Office admin/
owner: reviews completion info (CURRENT_WORKFLOW step 11); approves completion
notice. Automation: events + invoice-prep trigger + completion-notice draft.

**Automated actions.** Emit `job.completed` event (exists in Workflow 2); IF
`work_complete`: trigger invoice preparation (Map 19 — idempotent on this event,
RISKS #6); draft completion notice (matrix row: draft, office admin); IF
`return_trip_needed`: route to Map 16 instead — job NOT completed. Flag
completion-vs-punch discrepancies for Map 18 review [P5 check].

**Human approvals.** Completion notice → office admin (matrix). Whether a
completion notice is sent for EVERY job or only some [OPEN W6 — matrix defines
the approver, not the trigger policy; v1: drafted always, human decides send].

**Decision points.**
- D1 crew: work_complete vs return_trip_needed (field judgment).
- D2 office review: completion info sufficient + credible? (photos, hours vs
  punches, materials complete) — insufficient → internal follow-up with crew (no
  customer involvement).
- D3 billing readiness: T&M requires approved time records (Map 18) before the
  invoice can finalize — completion review does not bypass payroll approval.

**Status transitions.** job: `dispatched`/`in_progress` → `completed` [P5 enum]
only on work_complete + office review; shifts closed. `return_trip_needed` →
`return_needed` [P5] (Map 16).

**Notifications.** Office review queue; customer notice only after approval +
send; accountant sees invoice-prep trigger (Map 19).

**Audit events.** `job.completed`; completion-report immutable original +
office-review audit row; message events for notice; discrepancy flags.

**Failure cases.** Completion report never submitted (job done, nobody reported)
→ job stuck `dispatched`, ages in queue [OPEN W1]; hours on report contradict
punches → Map 18 reconciliation, corrections via `timecard_corrections` only;
customer disputes completion (reply "it's not fixed") → inbound via Spine →
human decides return visit (Map 16) vs new request; photos missing → office
judgment whether to chase (no policy inventing).

**Escalation path.** Disputed completions → owner. Credibility issues (hours
inflated) → owner. Aging unreported jobs → dispatcher queue [W1].

**Definition of completion.** Office-reviewed completion on record, job
`completed`, invoice preparation triggered exactly once, completion notice
approved+sent (or consciously not sent, recorded), all events logged.

---

## Map 16 — Partial completion and return visit

**Trigger.** Completion report `return_trip_needed` (Map 15 D1); OR customer
reports problem post-completion (inbound → human judges warranty-return vs new
work); OR day-of access failure / job interrupted (via Map 14 D4).

**Required inputs.** Original job + what remains (from report notes); parts on
order? (common return reason — captured as note); scope boundary: remaining work
IN original scope vs additional (→ Map 17).

**Responsible roles.** Crew leader: flags return + describes remainder. Project
manager / office admin: creates return-visit request (STAKEHOLDERS PM row).
Dispatcher: schedules it (Map 11 reuse). Owner: scope-boundary disputes.

**Automated actions.** On `return_trip_needed`: job → `return_needed` [P5]; emit
proposed `job.return_needed` event [P5]; create return-visit work item linked to
SAME job (NOT a new work_request — one customer problem, one job, N visits);
surface in scheduling queue. Invoice preparation NOT triggered (fixed-price:
REQUIREMENTS requires completion confirmed before invoicing — return pending =
not complete. T&M interim billing = [OPEN B15]).

**Human approvals.** Return-visit scheduling confirmation → office admin (Map 11
reuse [ASSUMPTION same matrix row]). Scope call (in-scope return vs chargeable
extra) → PM proposes, owner decides if contested [ASSUMPTION].

**Decision points.**
- D1 remaining work in original scope → free return visit; additional scope →
  change order FIRST (Map 17), then schedule.
- D2 parts lead time → schedule now vs when parts arrive (human judgment).
- D3 how many return visits before escalation? [no policy — owner judgment,
  visible via audit trail].

**Status transitions.** job: `completed`-candidate → `return_needed` → (Map 11 →
13 → 15 loop) → `completed` only when a completion report says work_complete with
no return flag.

**Notifications.** Scheduling queue (return visit); customer gets return-visit
confirmation via approved draft; owner on scope disputes.

**Audit events.** `job.return_needed` [P5]; visit linkage audit (job → visits);
scope-decision audit row.

**Failure cases.** Return visit forgotten (flag set, never scheduled) → ages in
queue [OPEN W1]; second visit also partial → loop continues, each visit recorded;
customer refuses return visit ("just refund me") → owner, out-of-system
resolution recorded as note; return reveals bigger problem → Map 17 change order
or new estimate (Map 8).

**Escalation path.** Scope disputes → owner. Serial returns on one job → owner
(quality signal, visible in audit).

**Definition of completion.** All visits for the job concluded with a final
work_complete report; job `completed`; invoicing (Map 19) triggered exactly once,
only after the FINAL completion.

---

## Map 17 — Change order

**Trigger.** Scope grows mid-job: crew discovers extra work (field), customer
requests addition (inbound/verbal), return visit reveals more (Map 16 D1), or
estimate assumptions prove wrong on site.

**Required inputs.** Job link; description of change; amount (priced from
price_book — source + last_updated rules apply; no invented prices); who
requested it.

**Responsible roles.** PM / office admin: draft change orders (STAKEHOLDERS PM
"create change-order drafts"). Crew leader: reports field-discovered scope (via
completion notes/photos in v1 [OPEN B16 — how is this actually captured today,
and may work proceed before approval?]). **Owner: approves — matrix row
"change-order message → boss", no delegation modeled.** Customer: accepts by
reply (Map 10 interpretation machinery reused).

**Automated actions.** Create `change_orders` row (draft, job-linked, amount,
requester); draft change-order message; pricing-completeness check on CO line
items; emit proposed `change_order.approved` / `change_order.customer_accepted`
events [P5]. Fixed-price invoice math picks up ONLY approved COs (DATA_MODEL).

**Human approvals.** Two gates mirroring Map 9: (1) internal CO approval = owner
(REQUIREMENTS "approved change orders"); (2) change-order message send = owner
(matrix row). Customer acceptance interpreted per Map 10 rules (automation
proposes, human confirms).

**Decision points.**
- D1 owner: approve / reject / needs re-estimate (large change → Map 8 loop).
- D2 customer: accept / reject / negotiate (reject → work proceeds on original
  scope only, or job renegotiated — owner call).
- D3 urgency: field crew standing on site waiting for CO decision → phone-speed
  reality; system records after the fact [B16 governs whether work may proceed
  pre-approval — DO NOT INVENT; until answered, maps assume no billing for
  unapproved extras].

**Status transitions.** change_orders: `draft` → `approved`/`rejected` →
customer-accepted [P5 status detail]. Job billing basis updated only on full
approval chain.

**Notifications.** Owner approval queue (internal + send); customer message after
approval; accountant visibility (invoice impact).

**Audit events.** CO create/approve/reject with prior values; message events;
customer-acceptance interpretation audit (Map 10 pattern).

**Failure cases.** Work done before CO approved → unbillable-extras risk [B16];
CO priced with unverified rows → flagged, blocked from send (RISKS #4); customer
accepts verbally on site to the crew → manual note + confirmation draft
[ASSUMPTION practice]; invoice drafted while CO pending → Map 19 must wait or
exclude pending COs [design rule: invoice includes only approved+accepted COs —
pending CO blocks fixed-price invoice finalization].

**Escalation path.** All COs already terminate at owner. Field-urgent COs →
owner by phone, recorded after.

**Definition of completion.** CO approved (or rejected) internally, customer
decision recorded with human-confirmed interpretation, invoice basis correct, and
work scope on record matches what crews were told to do.

---

## Map 18 — Payroll and attendance reporting (touchpoint)

**This is Workstream A's live Workflow 3, mapped here ONLY where the delivery
pipeline touches it.** Punch mechanics, geofence flags, foreman approval, admin
lock, corrections, lunch 12:00–12:30 unpaid — all EXIST and are
regression-protected. Nothing in 3B changes them.

**Trigger.** Continuous: punches during dispatched jobs; daily verification
(boss's #1 pain: ~1 hr/day punch verification + job-number entry —
CURRENT_WORKFLOW §0); pay-period close.

**Required inputs (delivery-side).** Shift↔job linkage so punches map to jobs
(**gap: job-number propagation to time system** — CURRENT_WORKFLOW §0); geofence
site match; completion-report hours (Map 15) for cross-check.

**Responsible roles.** Field employee/crew leader: punch (existing). Foreman:
first-level timesheet approval (existing). Office admin: lock + verification
(existing). Accountant: payroll finalization [ASSUMPTION]. Automation: geofence
flags (existing), discrepancy flags (proposed).

**Automated actions.** Existing: server-side geofence flagging, payroll draft
math. Proposed for the delivery link [P5 / Phase 4 candidates — NOT decided
here]: job-number auto-propagation from shifts to time entries; daily attendance
exception report (wrong-site + overtime + missing punches); completion-hours vs
punch-hours discrepancy flag. **The daily exception report is the Phase 4
boss-priority MVP candidate — DECIDE IN PHASE 4 (DECISION_LOG lock), this map
only records the touchpoint.**

**Human approvals.** Existing chain: foreman approve → admin lock → payroll
[B8-blocked OT/rounding policy for final math]. No customer-facing sends.

**Decision points.** D1 flags real vs benign (human, existing flags page);
D2 correction needed → `timecard_corrections` ONLY (immutable originals);
D3 T&M invoice readiness: time records approved? (gates Map 19 for T&M).

**Status transitions.** Existing time-entry/pay-period lifecycle. Delivery-side:
T&M invoice `draft` cannot finalize until referenced time entries are approved
(DATA_MODEL: "T&M invoice references approved time_entries only" — B8 backlog
acceptance).

**Notifications.** Existing flags page; proposed daily exception report [Phase 4].

**Audit events.** Existing: time_entry_audits, correction records. Proposed
discrepancy-flag events [P5].

**Failure cases.** Punch at wrong site → geofence flag (existing); missing punch
→ correction flow; completion says 6h, punches say 8h → discrepancy flag [P5],
human resolves before T&M invoice; job number never linked → T&M invoice
unbuildable for that work [the §0 gap — Phase 4 priority material]; OT math
unverifiable until B8 answered.

**Escalation path.** Payroll disputes → owner/accountant (existing practice).
Systematic geofence false-positives → sysadmin (radius config).

**Definition of completion (per period).** All punches for delivered jobs
verified/flagged-and-resolved, timesheets approved + locked, T&M-relevant time
records approved and linked to jobs, payroll draft consistent with B8 policy
(once known).

---

## Map 19 — Invoice preparation

**Trigger.** `job.completed` event with completion confirmed (Map 15; for
return-visit jobs, only after FINAL completion — Map 16). **Idempotent on the
event** (RISKS #6: duplicate/missed invoice is money-critical; exactly-once
pattern already proven for punch.flagged).

**Required inputs.** Fixed-price: approved proposal amount + approved + customer-
accepted change orders (DATA_MODEL source jsonb refs). T&M: approved time records
(Map 18 gate) + approved materials + approved extras. Customer billing address;
job reference.

**Responsible roles.** Automation: drafts the invoice RECORD (never sends
anything). Accountant / office admin: review + modify pre-approval (audited).
Owner: visibility; disputes.

**Automated actions.** Generate `invoices` row (`status=draft`) with line items
from source refs; compute totals per billing type (SQL-checkable: fixed = proposal
+ approved COs — B8 backlog acceptance); flag blockers: pending CO (Map 17),
unapproved time (T&M), missing billing data; emit `invoice.drafted`.

**Human approvals.** None to CREATE the draft (record-only). All approval/send =
Map 20.

**Decision points.**
- D1 system: billing type → source computation path.
- D2 blockers present? → draft flagged incomplete, cannot advance to review
  until resolved.
- D3 accountant: adjustments needed (audited, pre-approval only)?

**Status transitions.** invoices: `draft` → `review` (accountant/office picks it
up). Job: stays `completed` until Map 20 marks invoiced.

**Notifications.** Accountant/office queue: new drafts + blocked drafts (with
reason). No customer contact.

**Audit events.** `invoice.drafted`; line-item source refs recorded (which
proposal/COs/time entries); every pre-approval modification audited with prior
values.

**Failure cases.** Completion event fires twice → idempotency guard, one invoice;
completion never fires (Map 15 failure) → NO invoice — aging `completed`-without-
invoice check needed [P5 queue design; RISKS #6 "missed invoice"]; pending CO at
draft time → excluded + flagged, invoice can't finalize until CO resolves (Map 17
rule); T&M with unapproved time → blocked with reason; wrong amounts from stale
proposal refs → human catches in review (that's what review is for).

**Escalation path.** Billing-basis disputes (which COs count?) → owner. Aged
blocked drafts → accountant queue [OPEN W1].

**Definition of completion.** Invoice record in `review`, totals computed from
approved sources only, zero blockers or explicitly flagged, `invoice.drafted`
logged exactly once per job.

---

## Map 20 — Invoice approval and delivery

**Trigger.** Invoice in `review` (Map 19).

**Required inputs.** Reviewed invoice record; QuickBooks access (human);
Outlook (human).

**Responsible roles.** Approver: office admin / accountant (matrix
"supervisor/office"). Sender: same human path — **v1 mechanics CONFIRMED
(DECISION_LOG 2026-07-17 Phase 2): human creates the real invoice in QuickBooks
manually, sends via Outlook, marks sent in system. System = status tracker.**
Owner: visibility, disputes. **Automation: NOTHING beyond status/events — final
invoice NEVER auto, locked in every version of the matrix.**

**Automated actions.** Emit `invoice.approved` on approval; proposed
`invoice.marked_sent` event [P5]; that is all.

**Human approvals.** Invoice approval → office admin/accountant (matrix row:
"draft — NEVER auto in v1"). The QB-create + Outlook-send + mark-sent sequence is
one human workflow; each step recorded (approval row, sent mark).

**Decision points.**
- D1 approve / adjust (back to Map 19 modification, audited) / void with reason.
- D2 amounts match QB entry? — human transcribes into QB; the system total is
  the reference [drift risk — see failure cases].

**Status transitions.** invoices: `review` → `approved` → `sent` (human mark).
`void` only with reason (no deletes). Job: `completed` → `invoiced` [P5 enum] →
`closed` when payment recorded [payment tracking = QB-side in v1; system close =
manual mark, OPEN B18 whether to track payment status at all in v1].

**Notifications.** Approval queue; owner sees sent invoices (permission matrix);
customer receives the Outlook email (outside system).

**Audit events.** `invoice.approved`, `invoice.marked_sent` [P5], void-with-
reason audit; approver + sender identity on record.

**Failure cases.** Invoice approved but never actually sent via Outlook → status
drift (`approved`, aging) → queue surfaces it [Map 21 reconciliation]; sent via
Outlook but never marked → same drift, opposite direction — reconciliation is
human (Map 21); QB entry typo ≠ system total → no v1 detection (QB integration
deferred, Option B) — noted residual risk; customer disputes invoice → inbound
reply via Spine → human handles, adjustments = void + re-issue or QB-side credit
[practice OPEN B18]; duplicate send (human sends twice) → outside-system action,
audit shows one mark — residual risk until QB integration.

**Escalation path.** Disputes → owner. Aged `approved`-not-sent → accountant
queue [OPEN W1].

**Definition of completion.** Invoice `sent` (marked), QB invoice exists (human
attestation via the mark), customer emailed, full audit chain
(drafted→reviewed→approved→sent) intact, job `invoiced`.

---

## Map 21 — Failed automation or manual correction (delivery side, cross-cutting)

**Mirrors Map 7's role for intake. This is NOT one more linear workflow — it is
the failure/repair spine every Map 8–20 failure row lands in** (council-reviewed
design call: cross-cutting map referencing per-map failure cases, not a
standalone workflow that would contradict them).

**Trigger.** Any of: event consumer failure (n8n down/unreachable — J1 URL still
unknown; DB-side events emit regardless); draft-generation error (proposal/
dispatch/invoice draft fails); idempotency guard trips (duplicate completion
event); status drift (human acted outside system — sent unmarked, QB-only
invoice); stale artifact (proposal outliving price changes); any map's "failure
cases" row; human needs to correct a wrong record anywhere.

**Required inputs.** The failed/incorrect artifact + its audit history (prior
values always available — universal rule 2).

**Responsible roles.** Sysadmin (Jack): system errors, retries, consumer health —
**NO business approvals in production** (STAKEHOLDERS bar). Role-appropriate
business human per the affected map: office admin (messages/schedule), dispatcher
(shifts), owner (estimates/COs), accountant (invoices). Automation: retry +
surface, never repair business state on its own.

**Automated actions.** Retry transient failures (n8n retry semantics [P5]);
surface permanent failures to the right queue with error detail; never drop —
every failure leaves the record in a VISIBLE state (mirror of Map 7's "zero
emails unaccounted for"); emit failure events [P5 naming, e.g.
`automation.failed` with source ref].

**Human approvals.** Corrections follow the SAME approval rules as the original
action (Delivery rule 2: one pipeline, two writers). A corrected outbound message
is a NEW draft needing a NEW approval row. Time corrections →
`timecard_corrections` only. Voids need reason. Nothing is approved by automation
or sysadmin.

**Decision points.**
- D1 transient (retry) vs permanent (human queue) — automation may classify,
  conservatively.
- D2 repair in place (status fix + audit) vs void-and-redo (new draft/record) —
  human judgment per artifact type.
- D3 drift reconciliation: does reality (QB, Outlook, site) match system? Human
  attests, marks, audited.

**Status transitions.** Failed artifacts → visible error/flag state, never
deleted, never silently retried into success without an event trail. Corrections
transition through normal statuses with audit rows.

**Notifications.** Sysadmin: system-health failures (consumer down, repeated
errors). Business queues: actionable failures routed by artifact type. Owner:
only per matrix sensitivity (money-touching corrections).

**Audit events.** Failure event + resolution audit row (who fixed, how, prior
value) for every incident; retry history [P5].

**Failure cases (of the failure handler).** n8n down for days → DB events queue
up, consumers replay (idempotency required — existing convention); correction
war (human A fixes, human B re-fixes) → audit trail shows both, owner arbitrates;
failure queue itself neglected → same [OPEN W1] SLA gap as every queue — aging
display is the v1 mitigation; sysadmin tempted to fix business state directly →
barred by role (audit meaningfulness).

**Escalation path.** Systematic failures (classifier accuracy, repeated draft
errors) → sysadmin investigates (operational); business impact → owner informed
per sensitivity. Anything money-touching that was auto-generated wrong →
owner + accountant review before re-issue.

**Definition of completion (per incident).** The failed/wrong artifact is either
corrected through normal approval-gated flow or voided with reason; system state
matches reality (human-attested where reality is outside the system); the full
failure→resolution chain is in the audit log.

---

## Cross-map invariants — delivery additions (extends the Phase 3A checklist)

7. **Completion precedes invoicing.** Fixed-price: invoice only after FINAL
   completion (return visits pending = not complete). T&M: invoice references
   ONLY approved time records + approved materials + approved extras. Interim/
   progress billing = [OPEN B15], not designed.
8. **Invoice generation is idempotent** on job.completed; exactly one invoice
   per job absent explicit void-and-reissue (RISKS #6).
9. **Schedule records are never hard-deleted** — cancel/void with mandatory
   reason (universal rule 1 applied to shifts/jobs).
10. **Every customer reply runs the Spine** (keyword net + thread-match) —
    proposal replies, reschedule requests, completion disputes included.
11. **Customer-intent interpretation is human-confirmed** — automation proposes
    accept/reject/ambiguous readings, never records them alone (Map 10 decision).
12. Proposed additions needing Phase 5 design + DECISION_LOG ratification:
    job status enum (`scheduled|dispatched|in_progress|completed|return_needed|
    invoiced|closed|cancelled`); events `proposal.customer_rejected`,
    `job.scheduled`, `job.dispatched`, `job.return_needed`, `schedule.changed`,
    `schedule.cancelled`, `change_order.approved`,
    `change_order.customer_accepted`, `invoice.marked_sent`, `automation.failed`;
    matrix row `cancellation_notice` (draft, office admin [ASSUMPTION]);
    completion-vs-punch discrepancy flag; aging checks for `completed`-without-
    invoice and `approved`-not-sent invoices.
