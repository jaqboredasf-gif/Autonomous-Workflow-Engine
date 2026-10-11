# Production onboarding files

Five files. They are read by `scripts/pcc-onboard.mjs`, which runs **once, on the
production server**, against the central database. Nothing here is installed on
or run from an employee computer.

```
node scripts/pcc-onboard.mjs --dir config\onboarding --dry-run   # validates, writes nothing
node scripts/pcc-onboard.mjs --dir config\onboarding             # loads it
```

Always dry-run first, and have the person who owns the data read the output
before the real run. The dry run resolves references across all five files, so
it checks the set as a whole rather than one file at a time.

**Re-running is safe.** Anything already present is skipped. A load that stopped
half way is finished by running it again.

**Rows beginning with `#` are ignored.** Every example below is commented out and
uses `example.invalid`, which cannot be a real address. Delete the examples or
leave them; they will not be loaded either way.

---

## What you do NOT need to supply

- **Delivery locations.** A new installation already has `Workshop`, `Office`
  and `Vendor counter pickup`. Extra yards or named sites are added later in
  Admin, and none of them block launch.
- **Passwords.** The importer generates one temporary password per person,
  prints it once for an administrator to hand over, and PCC forces a change at
  first sign-in. There is no password column and there must never be one.
- **Roles for people you are not launching with.** Add them after launch.

---

## users.csv

| Column | Required | Rule |
|---|---|---|
| `full_name` | yes | as it should appear on screen |
| `email` | yes | the sign-in identity. Unique. Lower-cased on load. |
| `roles` | yes | one or more of `REQUESTOR` `FOREMAN` `OFFICE` `WORKSHOP_APPROVER` `ACCOUNTING` `ADMIN`, separated by `;` |
| `approver` | no | `yes` grants approval **and** PO generation, ordering, vendor and cost setting |
| `receiver` | no | may sign for deliveries. Implied by any assignment. |
| `workshop_assignment` | no | `yes` = signs for deliveries at the shop counter |
| `job_assignments` | no | job numbers separated by `;`. Each must exist in `jobs.csv`. |
| `login_enabled` | no | `no` creates the account disabled |

> **`approver` is not a small flag.** On `REQUESTOR`, `FOREMAN`, `OFFICE` or
> `ACCOUNTING` it grants the whole purchasing bundle — approve, generate POs,
> mark ordered, set vendor and cost. On `WORKSHOP_APPROVER` and `ADMIN` it adds
> nothing, because those roles already carry it.

> **Receiving is scoped by destination, not only by job.** Material delivered to
> the shop counter is signed for by whoever holds `workshop_assignment` — not by
> a foreman assigned only to the job the material is destined for, because he is
> not standing there.

## jobs.csv

| Column | Required | Rule |
|---|---|---|
| `job_number` | yes | unique. Appears in every PO number for that job. |
| `name` | yes | — |
| `customer`, `site_address`, `delivery_instructions` | no | — |
| `status` | no | `ACTIVE` \| `ON_HOLD` \| `COMPLETED` \| `CANCELLED`, default `ACTIVE` |

## vendors.csv

| Column | Required | Rule |
|---|---|---|
| `name` | yes | unique |
| `code` | yes | **letters and digits only, unique** |
| everything else | no | account number, phone, address, ordering contact |

> **⚠ THE VENDOR CODE IS PERMANENT.** It appears in every purchase order number
> issued to that vendor — `24-118-GRAYBAR-8`. Changing it later does not
> renumber what was already issued, so the paper trail splits in two. Confirm
> each code against how the office actually identifies that supplier **before**
> the real run. Two vendors may not share a code; the importer refuses it.

## po_sequences.csv

**Only for job+vendor pairs that already have PAPER purchase orders.** A pair
with no history starts at 1 correctly on its own and must not appear here.

| Column | Required | Rule |
|---|---|---|
| `job_number` | yes | must exist in `jobs.csv` |
| `vendor_name` | yes | must match `vendors.csv` exactly |
| `last_issued_sequence` | yes | whole number ≥ 1. **The last number ISSUED, not the next one.** |

> **⚠ THIS IS THE IRREVERSIBLE ONE.** A purchase order number cannot be withdrawn
> once a supplier has it. A wrong seed collides with paper that already exists.
> The importer refuses to MOVE a sequence that is already initialized — it names
> both numbers and stops — so a correction is a deliberate act on the Admin
> screen, not a silent overwrite.

## assignments.csv

| Column | Required | Rule |
|---|---|---|
| `email` | yes | must exist in `users.csv` or already in PCC |
| `location` | yes | a job number, or the literal `WORKSHOP` |

Kept separate from `users.csv` because assignments change after launch — a
foreman moves to another site — and re-running the user load is not how to do
that.

---

## What the importer refuses

Blank required fields · malformed email · unknown role · a job or vendor that
does not exist · the same email, job number or vendor code twice in one file ·
a vendor code that is not alphanumeric · a code already belonging to another
vendor · a sequence that is not a whole number ≥ 1 · the same job+vendor pair
twice · moving an already-initialized sequence · anyone who is not an
administrator running it at all.

Valid rows still load when other rows fail. Fix the named lines and run it
again; the run converges.
