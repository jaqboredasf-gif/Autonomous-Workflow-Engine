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

### Presets

/admin → **Roles** lists seven starting points. A preset expands to roles and a grant that
already exist; the system neither remembers nor cares which one you picked, and you can adjust
roles individually afterwards.

| Preset | Role | Approval grant |
| --- | --- | --- |
| `ORGANIZATION_ADMIN` | ADMIN | yes |
| `PURCHASING_MANAGER` | WORKSHOP_APPROVER | yes |
| `OFFICE_COORDINATOR` | OFFICE | **no** |
| `APPROVER` | OFFICE | yes |
| `REQUESTER` | REQUESTOR | no |
| `FIELD_FOREMAN` | FOREMAN | no |
| `ACCOUNTING_READ_ONLY` | ACCOUNTING | no |

Pick `OFFICE_COORDINATOR` for office staff who should **not** approve, and `APPROVER` for those
who should. Both are the OFFICE role; the grant is the only difference, and picking the right
preset means you cannot forget to remove it.

The full capability vocabulary — the twenty-three coarse names each role holds, and the
permissions each resolves to — is in `PCC_PERMISSION_MATRIX.md` §1a and on /admin →
**Permissions**.

## Inviting someone

/admin → **Invite someone**. Name, company email, at least one role, and a temporary password
of 10+ characters. Job sites are needed only for a foreman who signs for deliveries.

The system does not email the password — hand it over in person. There is no invitation
lifecycle yet (no pending list, no resend); an invited user can sign in immediately.

## Managing access

Per person, under **Manage**:

- **Roles** — tick and save. You cannot remove your own ADMIN role.
- **Delivery receiver** — designates them as someone who signs for material.
- **Receiving locations** — assign and unassign, as many as the person covers. A job number
  scopes them to that site; `WORKSHOP` lets them sign at the shop counter. A foreman sees
  deliveries for their locations and no others.

  The job must already exist in the job directory — a typo is refused rather than accepted
  into an assignment that quietly shows the person nothing. Unassigning always works, so a
  bad row from before this check can still be removed.

  **The workshop is a location, not a role.** Previously the only way to let a foreman sign
  at the counter was to give them an OFFICE or WORKSHOP_APPROVER role, which also lets them
  approve purchases and read every request in the company. Assign `WORKSHOP` instead: it
  grants shop receiving and nothing else.
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

**Whoever holds approval authority may approve any request in the organization, including one
they raised themselves** (BR-011). Who raised it is *recorded* — the approval row is stamped
`self_approved` — and never *consulted*. A purchasing manager who needs a part and orders it is
doing their job, and refusing them would stop a one-approver shop working.

The `allow_self_approval` setting is **deprecated and gates nothing** (migration 0028). The
column remains only so organizations that set it keep their history; no authorization path in
the application or the database reads it.

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
