# Requirements

Legend: [MUST] must-have for MVP, [NICE] nice-to-have, [ASSUMPTION] unconfirmed — labeled per project rule, [BLOCKED] cannot verify/build until dependency clears.

## Workstream A — time tracking (existing, regression-protected)

- [MUST] All items in docs/REGRESSION_CHECKLIST.md keep passing.
- [MUST] Punch originals immutable; corrections stored separately with original value, corrected value, reason, requester, approver, timestamps (slice 2 — in final debugging).
- [MUST] 2-pay-period parallel run vs ExakTime before cutover.
- [BLOCKED→boss] Written rounding + overtime policy (exact minutes vs 7/15-min rounding; weekly-40 vs daily OT). Payroll math unverifiable without it.

## Workstream B — request-to-invoice pipeline

### Email ingestion
- [MUST] Ingestion layer separated from classification/routing; test fixtures now, Microsoft Graph trigger swap-in later with no logic changes.
- [MUST] Store original raw email (headers, body, attachments ref) immutably for audit.
- [MUST] Dedicated shared M365 mailbox for automation (e.g. requests@…). Never the owner's personal inbox. [ASSUMPTION: shared mailbox can be created — company has shared calendar, which is NOT a mailbox; tracked as separate systems.]
- [BLOCKED→IT] Entra ID app registration + Graph permissions = blocking dependency for all real-email work. Every real-email test marked BLOCKED.

### Classification
- [MUST] Classify: emergency | service_call | estimate_job | out_of_territory | unknown. Confidence score stored with reasoning.
- [MUST] Emergency detection triggers on immediate electrical hazards: burning smell, smoke, sparking, electrical fire, exposed live wiring, electric shock, loss of power affecting safety equipment, flooding near electrical equipment, similar.
- [MUST] Emergency path: flag urgent, create high-priority record, notify configured emergency contact, STOP normal auto-scheduling, require human response, preserve original email + classification reasoning in audit log.
- [MUST] System never sends electrical troubleshooting instructions to customers.
- [MUST] Capture Commercial vs Residential + urgency + relevant details for in-territory requests.
- [MUST] Deterministic keyword safety net for emergencies in addition to AI classification (AI miss must not be the only line of defense).

### Approval system (v1 conservative)
- [MUST] Approval matrix drives behavior; per-type draft/auto flag changeable via data, not rebuild.

| Message type | v1 mode | Approver | Confidence threshold | Escalation | Audit log |
|---|---|---|---|---|---|
| Out-of-territory decline | AUTO (only one) | none (post-hoc visible) | high + definite territory rule | low confidence → draft | required |
| Service-call confirmation | draft | office/admin | n/a | unanswered 4h → owner | required |
| Estimate / proposal | draft | boss or authorized estimator [ASSUMPTION until confirmed] | n/a | — | required |
| Scheduling confirmation | draft | office/admin | n/a | — | required |
| Crew dispatch message | draft | dispatcher/admin | n/a | — | required |
| Change-order message | draft | boss | n/a | — | required |
| Completion notice | draft | office/admin | n/a | — | required |
| Final invoice | draft — NEVER auto in v1 | supervisor/office | n/a | — | required |
| Uncertain / high-value / unusual / sensitive | always draft + flag | owner | any | immediate | required |

### Pricing & estimates
- [MUST] Placeholder pricing structure: labor rates, material costs, markup, overhead, taxes, contingency. Every price row records source + last-updated. **No invented real prices.**
- [MUST] Estimates lacking complete pricing are flagged and cannot be sent.
- [MUST] Internal approval before any estimate sent. [ASSUMPTION: approver = boss or authorized estimator.]
- [NICE→later] Drawing-based automated estimating.

### Invoicing
- [MUST] Data model supports both billing types:
  - Fixed-price: amount from approved proposal + approved change orders; completion confirmed before invoicing.
  - T&M: labor from approved crew time records; materials from approved records/receipts; additional approved charges; human review before send.
- [MUST] QuickBooks assumed to remain accounting/AR system of record. [ASSUMPTION — exact integration unconfirmed, Desktop vs Online unknown.] No standalone final-invoice PDFs as permanent system unless QuickBooks integration is rejected.

### Cross-cutting
- [MUST] Every automated action logged (integration_events + audit records) so staff can see what happened and correct mistakes.
- [MUST] All automations idempotent; human-approval gates for sensitive actions per approval matrix.
- [MUST] Service-role keys never in browser code; RLS on all new tables.
