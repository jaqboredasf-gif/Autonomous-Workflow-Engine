# PCC — what purchasing needs to decide before we go live

**For Mike, and whoever else in the office issues purchase orders.**

This page has no server or network content on it. Everything here is a purchasing decision that
only the office can make, and PCC cannot start doing real work until these are answered.

The purchase order numbering rule — which used to be the item blocking everything — is settled and
built. What remains of it is one narrow question, and it is first.

---

## 1. PURCHASE ORDER NUMBERS — the rule is now settled

**Mike and Paul gave us the rule on 12 August 2026, and PCC now follows it exactly:**

> A purchase order number is the **job number**, the **vendor**, and a **number that counts from 1**
> — and it counts separately for each job and each vendor.

```
   Job 1234, first order to Cooper     1234-COOPER-1
   Job 1234, second order to Cooper    1234-COOPER-2
   Job 1234, first order to Graybar    1234-GRAYBAR-1
   Job 5678, first order to Cooper     5678-COOPER-1
```

**What this changes for you.** Nothing has to be set up for a new job or a new vendor: the count
starts at 1 because nothing has been ordered against that pair yet. There is no company-wide
number to supply, and **we no longer need "the next number in the paper book"** — the question we
were asking before was the wrong question, because there is no single sequence to continue.

### The one thing we still need from you

**Which jobs and vendors already have purchase orders written on paper?**

If the office has already written, say, three orders for job 1234 to Cooper, PCC starting that pair
at `1234-COOPER-1` would put a number Cooper already holds on a different order. So for those pairs
— **and only those** — we need to be told where the count had reached.

```
   Job number      Vendor                    Last paper PO number for that pair
   ____________    ______________________    ______________________
   ____________    ______________________    ______________________
   ____________    ______________________    ______________________

   ☐ None of the jobs we will use PCC for has paper purchase orders against a vendor yet
   Confirmed by: ______________________   Date: ____________
```

**"None" is an answer, and PCC records it.** There is a *Confirm as new* action for a job and
vendor with no paper behind it. The count starts at 1 either way — but recording the answer is the
difference between "the office checked, and it is new" and "nobody has been asked yet", and those
two look identical from inside the system. The go-live check lists every job still in the second
state, so nothing depends on remembering.

An administrator enters these in **Administration → PO numbering**, one pair at a time, before the
first real order on that job. PCC refuses to move a count backwards, and refuses any starting point
at or below a number it has already issued itself — **a purchase order number cannot be un-issued.**

**Please do not estimate.** A gap is harmless; a collision is a phone call with a vendor about
which order they actually shipped. If the exact number for a pair is genuinely unknown, tell us —
we would rather start deliberately high than guess low.

### Confirm the vendor codes

The middle part of the number is the vendor, and PCC builds it from the vendor's name with the
spaces and punctuation taken out — `Cooper Electric Supply Co.` becomes `COOPERELECTRICSUPPLYCO`.
That is deliberate: we did not want to invent an abbreviation nobody at Lippolis had chosen and
print it on a supplier's paperwork.

**If the office already uses shorter codes, tell us and we will set them.** They can be changed
right up until the first purchase order goes to that vendor, and are fixed after that — the code is
part of every number that supplier holds.

```
   Vendor                              Code it should use
   ______________________________      ______________     (e.g. GRAYBAR)
   ______________________________      ______________     (e.g. COOPER)
   ______________________________      ______________     (e.g. CED)

   ☐ The codes PCC derived are fine as they are
   Confirmed by: ______________________   Date: ____________
```

Letters and digits only, and no two vendors may share one — otherwise a number would not say who it
went to.

---

## 2. Who is in the pilot

A small number of real people doing real purchasing. **Not the whole company.**

```
   Purchasing / approvers        ______________________________________
   (expected: Mike, Rick)

   Foremen in the pilot          ______________________________________
   (one or two, on live jobs)

   Office staff, if any          ______________________________________

   Who signs for deliveries      ______________________________________
   at the workshop counter
```

Each person needs a name and an email address. Everyone signs in with their own account and
changes their password the first time — **nobody shares a login**, because the audit trail records
who approved what and a shared account makes that meaningless.

---

## 3. Real jobs for the pilot

PCC prints the job **name and site address** on the purchase order, so a supplier knows where the
material is going. We need the live jobs the pilot will actually buy against.

```
   Job number        Job name                    Site address
   _______________   _________________________   _____________________________
   _______________   _________________________   _____________________________
   _______________   _________________________   _____________________________
```

Only the jobs the pilot needs. The rest can be added as they come up.

---

## 4. Real vendors for the pilot

PCC composes the vendor email, so the **ordering contact's real email address** matters — the
draft goes nowhere useful without it.

```
   Vendor name       Account #      Ordering contact     Contact email
   _______________   ____________   __________________   __________________
   _______________   ____________   __________________   __________________
   _______________   ____________   __________________   __________________
```

**PCC never sends these emails itself.** It writes the draft; a person reads it and sends it from
their own mailbox. That is deliberate, and it is not going to change without the office asking for
it.

---

## 5. Three things about the printed PO we need decided

These came up while building the form and are genuinely the office's call:

```
   1. TAXABLE — PCC prints two empty boxes because it holds no tax status.
      ☐ leave it as a hand-tick     ☐ make it a recorded field
      Notes: _______________________________________________

   2. UNIT PRICE AND TOTAL on the vendor's copy — currently printed when costs
      have been recorded.
      ☐ keep printing them          ☐ leave them off the vendor's copy
      Notes: _______________________________________________

   3. SHIP VIA — currently printed only for a counter pick-up, blank otherwise.
      ☐ that is right               ☐ something else: ____________________
```

---

## 6. Paper stays the fallback — please confirm you are happy with this

During the pilot, **the paper process does not go away.** If PCC is unavailable for any reason,
purchasing carries on exactly as it does today.

**If PCC is down:**

1. Write the order on paper, as before.
2. Take the next number for that job and that vendor from the paper book.
3. **Write down every paper PO number issued while PCC was down, with its job and vendor.** This is
   the important one.
4. Tell the operational owner that PCC is down — the role named on the installation record, not
   a particular person. They restart it and escalate to Lippolis IT if it does not come back.

**When PCC comes back**, before anybody uses it again, we set each affected job-and-vendor pair
*above* the highest number issued on paper for that pair. That leaves a gap, which is harmless. A
duplicate is not.

```
   ☐ Understood — paper remains available and the outage list will be kept
   Confirmed by: ______________________   Date: ____________
```

---

## 7. Approval to begin

Sign this only when 1–6 above are answered and the office is ready for real orders to go through
PCC alongside paper.

```
   ☐ Any job-and-vendor pair with existing paper purchase orders has been named, or confirmed as none
   ☐ The vendor codes have been confirmed
   ☐ The pilot users are named and have signed in
   ☐ Real jobs and vendors are entered
   ☐ The three printed-PO questions are decided
   ☐ Paper remains the fallback, and the outage rule is understood
   ☐ Purchasing approves beginning limited real purchasing

   Approved by: ______________________   Date: ____________
```

**Until this is signed, PCC is being tested, not used.** Anything raised in it before then is
practice, and the database it was practised on is thrown away before real work starts.
