# First production transaction — acceptance script

One real purchase, start to finish, on the production server. Jack does not
operate PCC during this. He watches, and answers questions.

Everything below has been proven end to end on a throwaway production-mode
install; what is being tested here is the real server, the real people and the
real paper process.

**Before starting:** the deployment is installed and verified, the company data
is loaded, Mike has signed the data review, and everyone has signed in once and
changed their password.

---

## STOP CONDITIONS — halt and get Jack if any of these happen

- The purchase order number does **not** match what the office expected.
- PCC lets somebody do something you believe they should not be able to do.
- PCC refuses something and the message does not say why in plain words.
- Two purchase orders appear for one request.
- A quantity or price on the printed PO is not what was entered.
- Anything is sent to a vendor without a person pressing Send.

Stopping is cheap. A wrong purchase order number reaching a supplier is not.

---

## Part 1 — the request · **Foreman**

| # | Action | Expected |
|---|---|---|
| 1 | Sign in | your own dashboard |
| 2 | Raise a request against a **real current job** | job attaches |
| 3 | Enter **real materials** you actually need, with quantities and units | lines listed |
| 4 | Choose where it should be delivered | shop counter or the job site |
| 5 | Submit | status shows it is waiting for the workshop |

Use something genuinely needed and modest. This purchase is real.

## Part 2 — review and approval · **Mike**

| # | Action | Expected |
|---|---|---|
| 6 | Open the workshop queue | the foreman's request is there |
| 7 | Enter usable shop stock for anything already on the shelf | order quantity drops by that amount |
| 8 | Choose the vendor | vendor attaches |
| 9 | Enter unit costs | line totals calculate |
| 10 | Approve | status becomes approved |
| 11 | Generate the purchase order | a PO number appears |
| 12 | **CHECK THE PO NUMBER AGAINST THE PAPER BOOK** | it is the number the office would have written next for this job and vendor |

> **Step 12 is the whole point of this exercise.** If it does not match, stop
> here. Nothing has gone to the vendor yet.

## Part 3 — ordering · **Mike**

| # | Action | Expected |
|---|---|---|
| 13 | Open the printable purchase order | job, vendor, quantities, prices, and the company address and phone are all correct |
| 14 | **Print it on the office printer** | usable paper copy |
| 15 | Open the vendor email draft | it opens in Outlook, unsent, addressed to the vendor |
| 16 | Read it. Send it **yourself**, or place the order the way you normally would | the order is placed by you, not by PCC |
| 17 | Mark it ordered in PCC | status becomes ordered |

PCC never sends anything. If an email leaves without you pressing Send, stop.

## Part 4 — receiving · **Rick** (or whoever signs for it)

Do this when the material actually arrives.

| # | Action | Expected |
|---|---|---|
| 18 | Open the order in PCC | it is waiting for delivery |
| 19 | Record what actually arrived — if part of it, record only that part | status shows partly received |
| 20 | Attach a photo of the packing slip | photo saves and reopens |
| 21 | When the rest arrives, record it | status becomes fully received |
| 22 | Complete the request | status becomes completed |

If more arrived than was ordered, PCC will refuse and ask for a reason. That is
correct — say what happened rather than working around it.

## Part 5 — proving it stuck · **Mike and Rick**

| # | Action | Expected |
|---|---|---|
| 23 | Sign out, sign back in, find the order by searching | it is there, complete |
| 24 | Open the history for that job | the whole sequence is visible with names and times |
| 25 | Confirm the paper book and PCC agree on the number | they match |

## Part 6 — unaided run

Repeat Parts 1–4 with a second real purchase, **with Jack out of the room**.

This is the acceptance test. If it needs Jack, it has not passed.

---

## Evidence to keep

- The PO number issued, and the number the office expected
- The printed purchase order
- A note of anything PCC refused, and whether the reason was clear
- Anything either of you had to ask about
- Whether the second run needed help

Record the result in `PCC_PRODUCTION_EVIDENCE.md` §8.

## Requests raised during acceptance

Write them down. Do not build them. Anything that is not stopping the purchase
from being completed correctly is a later conversation.

```
Wanted / awkward / confusing:

  ______________________________________________________________

  ______________________________________________________________
```
