# PCC — how to use it

**For Mike and Rick.** Two pages. Everything else in the system is either automatic or
something you will never need.

---

## Signing in

Go to the PCC address in a browser. Enter your email and password.

If it bounces you back to the sign-in page, tell Jack — that usually means the address is
`http://` instead of `https://`, and it is a setup problem, not something you did.

---

## The board

You land on your workspace. It shows what needs you, most urgent first:

- **Overdue** — past its date and still waiting on purchasing. Red.
- **Today** — needed today, nobody has ordered it yet. Amber.
- Everything else — ordinary next-day work. Deliberately quiet.

**There is no priority to set.** Nobody grades requests as urgent. PCC works it out from
the date the field asked for and the state the work is in. If a row is coloured, it is
because something is genuinely late — not because someone ticked a box.

---

## A request comes in

Open it. You see the job, what was asked for, how many, and when it is needed.

### 1. Check the shelf

```
Job needs        10
Workshop stock  [ 2 ]     ← you type this
To order          8       ← works itself out
```

Type how many are already in the workshop. **To order** updates as you type.

The job still needs 10 — that never changes. PCC only buys the difference. If you have 10
or more on the shelf, there is nothing to buy, and PCC will say so rather than raising an
empty order.

You can type over **To order** if you want to buy a full box anyway.

### 2. Choose the supplier

One dropdown, at the bottom. One supplier per purchase order.

### 3. Approve

**Approve and print PO.** That one button does everything: approves it, gives it a
purchase order number, prepares the vendor email, and opens the print dialog.

---

## The purchase order number

```
25-007-GRAYBAR-2
   │      │      │
   │      │      └─ the 2nd order on this job to this vendor
   │      └──────── the vendor
   └─────────────── the job
```

The count starts at 1 for **each job and each vendor separately**. A different vendor on
the same job starts at 1. The same vendor on a different job starts at 1.

Once issued, a number never changes. Renaming a vendor or a job does not touch it.

---

## Printing

The print dialog opens by itself when the PO is created. Pick the workshop printer.

If you need it again later, open the request and press **Print PO**.

The printed sheet shows:

| Job qty | Shop | Qty ord. | Qty rec. | Description |
|---|---|---|---|---|
| 10 | 2 | **8** | ______ | 1in EMT coupling |

**Job qty** is what the job needs. **Shop** is what you found on the shelf. **Qty ord.**
is what the supplier is selling us. **Qty rec.** is blank — write it in at the tailgate.

Mark it up, staple the vendor's receipt to it when it comes, and file it. That is
unchanged from how you work now.

---

## The vendor email

PCC has already written it — vendor, PO number, job, items, quantities, PDF attached. You
do not retype anything.

**PCC cannot send email.** That is on purpose. You:

1. Read it → **Mark reviewed**
2. **Approve to send**
3. Copy it into Outlook and send it yourself → **I sent it**

Only then does **Mark ordered** unlock. That is the rule that stops an order being
recorded as placed before anybody looked at what went to the supplier.

---

## Mark ordered

One press. No confirmation, no dialog. It takes you back to the board.

PCC records who pressed it and when, without asking.

---

## Receiving

**Receiving** in the menu lists everything on its way in — PO number, job, vendor, what
was ordered.

When the truck arrives: **It arrived.** One press. Done.

You do not re-type quantities. PCC produced the purchase order; it already knows what was
on it. The paperwork is the vendor's receipt stapled to your printed copy.

If only part of it turned up, use **Only part of it arrived** instead and enter what came.

---

## Finding it again

- **Purchasing** — everything, searchable by PO number, job, vendor or material.
- Open any request to see its full history: who did what, when, in order.

Nothing is ever deleted. A cancelled request stays on the record with its reason.

---

## What to do when something looks wrong

| It says | It means |
|---|---|
| *a sequence can only move forward* | You tried to set a PO number lower than one already issued. A gap is harmless; a repeat is not. |
| *this vendor has no purchase order code* | Admin → Vendors → set the code. |
| *approve with at least one line to order* | Everything is in stock. There is nothing to buy — reject it, or reduce the shelf figure. |
| *a … request cannot produce a purchase order* | It has not been approved yet. |

Anything else that looks wrong: take a screenshot and send it to Jack. Do not work around
it — if PCC is refusing something, it is usually refusing for a reason worth knowing.

---

## If PCC is down

Carry on exactly as you do today: write the order on paper, take the next number for that
job and vendor from the paper file, and **write down every paper PO number you issue
while it is down, with its job and vendor**.

When it comes back, tell Jack those numbers before anybody raises a new order, so PCC can
be set past them. A gap in the numbering is harmless. A number used twice is a phone call
with a supplier about which order they actually shipped.
