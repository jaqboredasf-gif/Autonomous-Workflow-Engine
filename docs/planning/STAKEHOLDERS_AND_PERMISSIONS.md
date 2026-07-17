# Stakeholders and Permissions

Status: Phase 2 APPROVED structure (Jack, 2026-07-17). Names/headcount still
unconfirmed (B2) — remaining [ASSUMPTION] tags are B2/boss-dependent, not design
gaps. Grounded in: approval matrix (REQUIREMENTS.md), actors table
(USER_WORKFLOWS.md), live DB roles, DECISION_LOG.md.

Phase 2 decisions (details in DECISION_LOG.md): multi-role via `user_roles` join
table; customer = email-only actor (M365/Outlook carries customer comms incl. most
of the invoicing pipeline); sysadmin barred from business approvals in production
(test-mode exception, fixture data only); message_policies gets amount-threshold
column now (values await boss §3); v1 invoice = system drafts record → human creates
invoice in QB, sends via Outlook → marks sent in system.

## Universal rules (apply to every role)

1. **No hard deletes of business records.** Void/soft-delete with reason + audit row.
   Only sysadmin may purge, and only fixture/test data.
2. Every approve/send/modify action writes an audit record (who, what, when, prior value).
3. **Automation (n8n + AI) is an actor with ZERO approval authority.** It creates
   drafts and records, never approves, never sends except where message_policies mode
   = auto (currently: nothing — auto-decline disabled per DECISION_LOG 2026-07-17).
4. All data org-scoped by RLS (existing pattern, migrations 0002/0004).
5. Customer-facing sends require an approval row from an authorized role first.

## Role → DB divergence (migration decision, flagged for Phase 5)

Live `users.role`: **worker / foreman / admin** (3 values). Phase 2 defines 10 roles.
Mapping:

| Phase 2 role | DB today | Gap |
|---|---|---|
| Field employee | worker | none |
| Crew leader | foreman | none |
| Office admin | admin | today's `admin` is really "office admin + sysadmin" mixed — needs split |
| Owner | admin (undistinguished) | needs own value — approval matrix names "boss" as approver |
| Dispatcher | — | new; likely admin-subset or same human as office admin |
| Estimator | — | new; approval matrix references "authorized estimator" |
| Project manager | — | new [ASSUMPTION role exists at all] |
| Accountant | — | new [ASSUMPTION distinct person] |
| Customer | not a user | stays non-user in v1 (email-only actor) [ASSUMPTION — see Q2] |
| System administrator | admin (Jack) | needs separation from business approvals |

**Decided (2026-07-17): `user_roles` join table** — one user holds many roles;
existing `users.role` kept during migration for Workstream A compatibility, RLS
policies read the join table for Workstream B capabilities. Migration design = Phase 5.

## Permission matrix

Verbs: **View / Create / Approve / Modify / Send / Delete**. "—" = not permitted.

### Owner (boss)

| Verb | Scope |
|---|---|
| View | Everything: requests, classifications + reasoning, schedule, crews, timesheets, payroll, pricing, estimates, invoices, audit logs, declined/escalated items |
| Create | Anything an office admin can; territory-exception acceptances |
| Approve | **Sole approver [ASSUMPTION until B2]:** estimates/proposals, change orders, territory exceptions, graduating any message type draft→auto. **Also can approve:** everything lower roles can. Emergency response decisions. Value thresholds: column designed in (decided 2026-07-17), values await boss §3 |
| Modify | Approval matrix (message_policies) jointly with sysadmin; any business record (audited) |
| Send | Any approved outbound message |
| Delete | — (void only) |

### Office admin

| Verb | Scope |
|---|---|
| View | Requests, customers, jobs, schedule, crew availability, timesheets, completion reports, invoice drafts, outbound drafts. NOT: payroll exports [ASSUMPTION], price_book cost internals [ASSUMPTION] |
| Create | Manual-intake work requests (phone bridge), customers, jobs, schedule entries, outbound drafts, invoice drafts |
| Approve | Service-call confirmations, scheduling confirmations, completion notices, invoice drafts (per REQUIREMENTS matrix "supervisor/office"); timecard corrections [ASSUMPTION — today admin does] |
| Modify | Customer/job records, unsent drafts, schedule entries (all audited) |
| Send | Messages they may approve, after approval recorded |
| Delete | — (void only) |

### Dispatcher (may be same human as office admin)

| Verb | Scope |
|---|---|
| View | Schedule, shifts, crew availability + skills, job details, dispatch drafts. NOT pricing |
| Create | Shifts, crew assignments, dispatch drafts |
| Approve | Dispatch messages (REQUIREMENTS: "dispatcher/admin") |
| Modify | Shifts/assignments until job completion (audited) |
| Send | Approved dispatch notifications |
| Delete | — (unassign/cancel with reason) |

### Estimator

| Verb | Scope |
|---|---|
| View | Requests routed to them, attachments/drawings, price_book, own estimates, customer job history |
| Create | Estimates, line items, proposal drafts |
| Approve | Internal estimate approval ONLY if boss authorizes that person [ASSUMPTION — B2/§3]; never their own send |
| Modify | Own draft estimates until internal_review |
| Send | — (proposal sends require boss-or-authorized approval path) |
| Delete | — |

### Project manager [ASSUMPTION role exists — may collapse into estimator/office admin]

| Verb | Scope |
|---|---|
| View | Jobs, schedule, completions, change orders; estimates for own jobs |
| Create | Change-order drafts, return-visit requests |
| Approve | — (change orders = boss per REQUIREMENTS) |
| Modify | Job status/notes (audited) |
| Send | — |
| Delete | — |

### Crew leader (foreman — exists in DB)

| Verb | Scope |
|---|---|
| View | Own crew schedule + assigned job details (address, scope, notes — NOT pricing), crew timesheets |
| Create | Crew punches (existing), completion reports, photos, material-usage notes |
| Approve | First-level crew timesheet approval (existing) |
| Modify | — (corrections only via timecard_corrections request) |
| Send | — nothing customer-facing |
| Delete | — |

### Field employee (worker — exists in DB)

| Verb | Scope |
|---|---|
| View | Own schedule, own punches, own assigned job details (no pricing) |
| Create | Own punches, photos, completion notes |
| Approve | — |
| Modify | — (correction requests only) |
| Send | — |
| Delete | — |

### Accountant / payroll [ASSUMPTION distinct person; may be office admin or external]

| Verb | Scope |
|---|---|
| View | Locked timesheets, payroll drafts/exports, invoices, payments, rates needed for T&M |
| Create | Payroll exports, invoice records/drafts |
| Approve | Payroll finalization [ASSUMPTION]; invoice drafts (shared w/ office admin per matrix) |
| Modify | Invoice drafts pre-approval (audited) |
| Send | Approved invoices — v1 mechanism CONFIRMED: create in QB manually, send via Outlook, mark sent in system (status tracking only) |
| Delete | — (void invoice with reason) |

### Customer (non-user actor, email-only in v1 — CONFIRMED 2026-07-17; no portal in MVP)

- Views: only what is sent to them.
- Creates: work requests by email; proposal approval/rejection by reply (ambiguous
  reply = human interprets, per RISKS edge case).
- No login, no portal, no system permissions in MVP.

### System administrator (Jack)

| Verb | Scope |
|---|---|
| View | Everything incl. audit logs, integration_events, message_policies, errors |
| Create | Config, message_policies rows, territory rules, migrations, fixtures |
| Approve | **— no business approvals** (no estimates/invoices/messages) in production — separation keeps audit trail meaningful. ACCEPTED 2026-07-17. Test-phase exception: fixture data only |
| Modify | System config, secrets, escalation_rules (changes audited) |
| Send | — (test fixtures only, never to real customers) |
| Delete | Fixture/test data only |

## Approval-matrix linkage

message_policies.approver_role must reference these roles. Current v1 rows
(REQUIREMENTS.md) map: confirmations/scheduling/completion → office_admin; dispatch →
dispatcher; estimate/proposal + change order → owner (+ authorized estimator flag);
invoice → office_admin/accountant; decline → auto-disabled. Boss's §11 interview
answers may revise — capture sheet BOSS_INTERVIEW.md.

## Remaining unknowns (boss-dependent only)

- B2: names→roles, who approves/sends today, backup decision-maker when owner unavailable
- Approval $ threshold VALUES (column exists by design; interview §3)
- Whether estimator internal-approval authorization exists and for whom (§3/§6)
- Boss's §11 answers may revise the message_policies defaults
