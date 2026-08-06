# Purchasing — administrator guide

For whoever holds the ADMIN role. Everything here is at **/admin**.

## Who can do what

| Role | Can |
| --- | --- |
| `REQUESTOR` | raise requests, follow their own |
| `FOREMAN` | the above, plus confirm deliveries **on assigned job sites only** |
| `OFFICE` | see everything, track orders, record receiving, add notes — **no purchasing authority** |
| `ACCOUNTING` | read receipt evidence and packets — **no write permission at all** |
| `WORKSHOP_APPROVER` | record stock, choose vendor and cost, approve, generate POs, order, receive |
| `ADMIN` | all of the above plus user, role, assignment and numbering administration |

Two authorities are deliberately separate: **approving a purchase** and **confirming a
delivery**. A foreman who signs for material has not been given permission to approve spending.
Granting approval to an office user is a separate switch from their role.

## Inviting someone

/admin → **Invite someone**. Name, company email, at least one role, and a temporary password
of 10+ characters. Job sites are needed only for a foreman who signs for deliveries.

The system does not email the password — hand it over in person. There is no invitation
lifecycle yet (no pending list, no resend); an invited user can sign in immediately.

## Managing access

Per person, under **Manage**:

- **Roles** — tick and save. You cannot remove your own ADMIN role.
- **Delivery receiver** — designates them as someone who signs for material.
- **Job sites** — assign and unassign. A foreman sees deliveries for these jobs and no others.
- **Reset access** — sets a new temporary password through the credential provider.
- **Disable / re-enable** — a disabled account cannot sign in, and existing sessions stop
  working on their next request, because every request re-reads the person from the database.
  You cannot disable yourself.

Not yet available: pending invitations, resend, last sign-in, forced session revocation,
user search and filtering. See the gap register, Phase 4.

## Approval authority

Approval is a **grant**, not a role. An OFFICE user with the grant can approve; the same user
without it cannot. Mike and Rick hold WORKSHOP_APPROVER, which carries it. The primary/backup
distinction decides who the queue nags first, not who is allowed to act.

Self-approval is refused: nobody decides on a request they raised. A one-approver shop can
enable `allow_self_approval` in settings, and the refusal disappears — that is a real loosening
of control, and it is recorded.

## PO numbering

/admin → **PO numbering**. Prefix, digit count, suffix, next number. The sequence **only moves
forward**: winding it back would re-issue numbers vendors and invoices already reference, and
the server refuses it.

## Audit

/admin shows the last 100 recorded actions for the organization. Every refusal is recorded too
(`authz.denied`) — someone probing a URL leaves a trace, not just a redirect.

## What administrators cannot do

- read another organization's data (the tenant check runs before the role check)
- send an email — the system has no transport; drafts are copied into a mail client by a human
- delete a purchase record — business records are append-only
- mark an invoice paid — no payment execution exists
