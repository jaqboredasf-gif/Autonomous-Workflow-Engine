# PCC UI Implementation Contract

## Objective
Turn the existing PCC codebase into a coherent, production-usable purchasing interface without redesigning the application from scratch.

## Division of Responsibility
The product/design decisions in this handoff are already made.
Claude Code should focus on implementation, integration, verification, and safe adaptation to the existing repository.

## Source of Truth Order
1. Existing working business/domain behavior that has been explicitly validated
2. BR-001 through BR-010 in this handoff
3. Screen specifications
4. Component library
5. Design system visual tokens
6. Existing visual code where it does not conflict

## Product Users
- Requester
- Foreman
- Purchasing (Mike/Rick type role)
- Office/Admin
- Administrator

## Core Experience
PCC is an operational workspace, not a static procurement form.
Requests and POs remain visible throughout their active lifecycle.
Users should be able to understand status, next action, job, requester, vendor, and item context without memorizing prior steps.

## Canonical Lifecycle
Draft
→ Requested
→ Needs Approval
→ Approved
→ Email Drafted
→ Ordered
→ Partially Received
→ Received
→ Completed

Exception/terminal states:
- Backordered
- Cancelled
- Rejected

Do not assume every transition is available to every role.

## Critical UX Invariants
1. Operational work does not disappear before completion.
2. Status is always visible in text.
3. PO detail is the durable operational source of truth.
4. Vendor email is reachable directly from PO workflow.
5. Partial receiving is first-class.
6. Receiving is usable from a phone at a job site.
7. High-risk/destructive actions require confirmation.
8. Search/filtering must support real operational volume.
9. Repeated materials/vendors should become faster to enter over time.
10. The UI should not require purchasing staff to memorize lists of incoming requests.
