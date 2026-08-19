# Purchasing data review — for Mike

**This should take about ten minutes.** You do not need to understand the tool.
You are checking four things against how the office actually works, because
those four are the ones that are expensive or impossible to correct afterwards.

Jack will run a validation pass and hand you its output. Nothing has been
written to PCC at that point — the run is a rehearsal.

---

## 1. Job numbers

The list of jobs PCC will know about at launch.

- Is each **job number** written exactly as the office writes it?
- Is each one a real, current job?

*Getting this wrong:* a request can be raised against the wrong job, and the job
number appears in the purchase order number.

## 2. Vendor names

- Is each vendor one you actually order from?
- Is the name the one the office uses for them?

*Getting this wrong:* recoverable. A name can be corrected later.

## 3. Vendor codes ⚠

Each vendor has a short code. **It appears in every purchase order number ever
issued to that vendor** — for example `24-118-GRAYBAR-8`.

- Is each code the way the office identifies that supplier?
- Would you recognise it on a piece of paper a year from now?

*Getting this wrong:* **not correctable in a useful sense.** Changing a code
later does not renumber the purchase orders already issued, so the paper trail
splits into two names for one supplier.

## 4. Purchase order sequence seeds ⚠⚠

**This is the one that cannot be undone.**

PCC numbers purchase orders **per job and vendor pair**, counting from 1 within
that pair. `1234-COOPER-1`, `1234-COOPER-2`, and then `1234-GRAYBAR-1` starts
again at 1. There is no single company-wide next number.

For every pair that **already has paper purchase orders**, the list shows the
last number issued and what PCC will issue next.

- Is the **last issued** number correct for that job and vendor?
- Is the **next** number the one you would have written on paper?
- Are there pairs on the list that have **never** had a paper order? Those should
  not be on the list at all — they start at 1 by themselves.
- Are there pairs with paper history **missing** from the list? Those must be
  added, or PCC will start them at 1 and duplicate a number a supplier already
  has.

*Getting this wrong:* a supplier receives a purchase order number they have
already seen. It cannot be withdrawn.

---

## Sign-off

```
PCC purchasing data review

Jobs                    [ ] APPROVED / CORRECT     [ ] CHANGE REQUIRED
Vendor names            [ ] APPROVED / CORRECT     [ ] CHANGE REQUIRED
Vendor codes            [ ] APPROVED / CORRECT     [ ] CHANGE REQUIRED
PO sequence seeds       [ ] APPROVED / CORRECT     [ ] CHANGE REQUIRED

Changes required (job / vendor / what is wrong / what it should be):

  ______________________________________________________________

  ______________________________________________________________

Reviewed by: ______________________    Date: ______________

I confirm the purchase order numbers above match the office's paper records.
```

**Nothing is loaded into PCC until this is signed.** If anything is marked
CHANGE REQUIRED, the files are corrected and you get a fresh list — the
rehearsal can be run as many times as needed.
