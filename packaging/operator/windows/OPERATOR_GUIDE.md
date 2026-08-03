# Operator guide - TEGG Report Tool (Windows)

Everything this tool does, what it gives you, and what to do when it does not.

If you have not set it up yet, read **START HERE.txt** first.
If something has already gone wrong, open **TROUBLESHOOTING.txt** instead.

---

## The four things you can double-click

| file | what it does | changes anything? |
|---|---|---|
| `Setup.bat` | installs the tool into this folder and saves your TEGG sign-in | this folder only |
| `Run Report.bat` | reads one completed site visit and writes you a report | reads TEGG, writes here |
| `Check Setup.bat` | tells you whether this PC is ready | nothing |
| `Diagnostic.bat` | writes a report about this PC to your Desktop, to send on | nothing |

`Setup.bat` is run once. After that it is `Run Report.bat` every time.

---

## What you get, and how to read it

A run writes one folder inside `work\operations\`, named after the date and
time it ran. `Run Report.bat` opens it for you when it finishes.

| in that folder | what it is |
|---|---|
| `review\review.md` | **the thing to read.** The repair items, worst first. |
| `review\review.json` | the same information as data, if anyone needs to import it |
| `documents\` | the two TEGG reports, exactly as TEGG produced them |
| `state.json` | a record of every step, for troubleshooting |
| `evidence\` | screenshots taken along the way |

`review.md` is a text file. Double-click it; if Windows asks what to open it
with, choose **Notepad**. Any Markdown reader shows it more nicely, but Notepad
loses nothing.

### The five things in the report

1. **What this comes to** - how many items are still outstanding, how many are
   urgent, and a rough total.
2. **Items** - one row per problem, worst first. The last column either has a
   number or says *why it has no number*.
3. **Each item in full** - for every problem: what the technician wrote, word
   for word, why the tool graded it the way it did, and which page of which PDF
   each fact came from.
4. **Assumptions** - read this before repeating any figure to anybody.
5. **Anything the tool was not sure about** - your job list.

### About the money

**Out of the box the money is not real.** The tool ships with example rates,
and while those are in use every total is stamped `NOT PRICED` and the report
says so on its first screen.

To make the figures mean something, someone who owns the numbers needs to:

1. make a copy of `config\ratecard.example.yaml` called
   `config\ratecard.yaml`;
2. put your real labour rate, hours and material allowances into it;
3. change the line `placeholder: true` to `placeholder: false`.

The tool picks it up automatically from then on, and your rates stay on this
PC.

Even with real rates, **the result is a draft for an estimator.** It includes
no site conditions, no access or permit costs, no lead times, no out-of-hours
premium, and no priced materials.

### About the recommendations

The repair recommendation is **the technician's own words, quoted**. The tool
does not write repair advice. What it adds is structure - repair or replace,
how urgent, whether an outage is needed - and for each of those it says which
rule produced the answer.

---

## Where your TEGG sign-in is kept

Not in this folder, and not in any file you could accidentally send to anyone.

It is encrypted with the Windows Data Protection API - the same mechanism
Windows uses for saved network passwords - and written to:

```
%LOCALAPPDATA%\TEGG Report Tool\credentials.dat
```

That file can only be decrypted by **your Windows account, on this PC**. Copied
to another machine, or opened by another user, it is meaningless. The password
only ever becomes readable text inside the one running window that needs it,
and it is gone when that window closes.

Nothing writes it to a log. `Diagnostic.bat` deliberately checks that it can be
read back and then reports only *that it could*, never what it is.

To change it: run `Setup.bat` again and answer `y` when it offers to replace it.

---

## Choosing which site visit

By default the tool reads **the most recently completed visit** that has an
agreement, a site and an identifier. It prints which one it chose and why.

To choose one yourself, open a Command Prompt in this folder (click the address
bar in File Explorer, type `cmd`, press Enter) and run:

```
"Run Report.bat" T25-204
```

If the number matches nothing, or matches more than one visit, the tool stops
and lists the alternatives. It never guesses.

---

## Exit codes

Only relevant if somebody runs this automatically.

| code | meaning |
|-----:|---------|
| `0` | finished; whatever it promised to do, it did |
| `1` | started and could not finish; may be worth retrying |
| `2` | the command line was wrong; nothing was attempted |
| `3` | stopped on purpose and needs a person; usually resumable |
| `4` | never started -- this machine or this configuration is not ready. Nothing was contacted and nothing was changed |

The one worth knowing is **4**: nothing was attempted, nothing was contacted,
and running it again without changing something will do exactly the same.

---

## Housekeeping

Every run keeps the two PDFs it downloaded. They name a real customer and a
real site, they stay on this PC, and they add up.

Open a Command Prompt in this folder and run:

```
.venv\Scripts\awe-tegg.exe runs              (what is there)
.venv\Scripts\awe-tegg.exe runs --prune      (remove what is old enough)
```

`runs` on its own deletes nothing. The rule: a finished run may be removed once
it is more than 30 days old, unless it is the most recent one. Anything that
did not finish is never removed, because that is the one worth resuming.

---

## What this tool will never do

| | |
|---|---|
| sign in, read pages, download the two reports | yes |
| submit, approve, send, email, upload, delete, mark complete | **no - refused in the code itself** |
| store your password anywhere except Windows protected storage | **no** |
| contact the customer | **no** |
| price materials from a supplier | **no** |

---

## When to escalate, and what to send

Tell whoever maintains this tool if:

* the same visit fails twice;
* the report says something that does not match the PDFs in `documents\`;
* `Check Setup.bat` reports a PROBLEM that TROUBLESHOOTING.txt does not cover.

Double-click **`Diagnostic.bat`** and send them the file it puts on your
Desktop. It contains no password and no secret, and it saves a round of
questions.

Also tell them the **name of the run folder** - for example
`visit-findings-20260803T132708+0000`.

Do not email the run folder itself: it contains customer documents.
