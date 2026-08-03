"""Write OPERATOR_GUIDE.md, with the exit-code table generated from the code.

The table is the one part of an operator guide that goes quietly wrong: it is
transcribed once and then the code changes. Generating it means the guide can
only ever be right, and the build refuses to package a guide whose table does
not match.

    python packaging/operator/make_guide.py
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "src"))

from awe_runtime.exits import exit_table  # noqa: E402

GUIDE = """# Operator guide — TEGG Report Tool

Everything this tool does, what it gives you, and what to do when it does not.

If you have not set it up yet, read **START HERE.txt** first.

---

## What you get, and how to read it

A run writes one folder inside `work/operations/`, named after the date and
time it ran. `Run Report.command` opens it for you when it finishes.

| in that folder | what it is |
|---|---|
| `review/review.md` | **the thing to read.** The repair items, worst first. |
| `review/review.json` | the same information as data, if anyone needs to import it |
| `documents/` | the two TEGG reports, exactly as TEGG produced them |
| `state.json` | a record of every step, for troubleshooting |
| `evidence/` | screenshots taken along the way |

Open `review.md` by double-clicking it.

### The five things in the report

1. **What this comes to** — how many items are still outstanding, how many are
   urgent, and a rough total.
2. **Items** — one row per problem, worst first. The last column either has a
   number or says *why it has no number*.
3. **Each item in full** — for every problem: what the technician wrote, word
   for word, why the tool graded it the way it did, and which page of which PDF
   each fact came from.
4. **Assumptions** — read this before repeating any figure to anybody.
5. **Anything the tool was not sure about** — your job list.

### About the money

**Out of the box the money is not real.** The tool ships with example rates,
and while those are in use every total is stamped `NOT PRICED` and the report
says so on its first screen.

To make the figures mean something, someone who owns the numbers needs to:

1. make a copy of `config/estimating.example.yaml` called
   `config/estimating.yaml`;
2. put your real labour rate, hours and material allowances into it;
3. change the line `placeholder: true` to `placeholder: false`.

The tool picks it up automatically from then on, and your rates stay on this
Mac.

Even with real rates, **the result is a draft for an estimator.** It includes
no site conditions, no access or permit costs, no lead times, no out-of-hours
premium, and no priced materials.

### About the recommendations

The repair recommendation is **the technician's own words, quoted**. The tool
does not write repair advice. What it adds is structure — repair or replace,
how urgent, whether an outage is needed — and for each of those it says which
rule produced the answer.

---

## Choosing which site visit

By default the tool reads **the most recently completed visit** that has an
agreement, a site and an identifier. It prints which one it chose and why.

To choose one yourself, drag `Run Report.command` into a Terminal window, type
a space and the visit number, then press Return:

```
"/path/to/Run Report.command" T25-204
```

If the number matches nothing, or matches more than one visit, the tool stops
and lists the alternatives. It never guesses.

---

## What can go wrong

The tool always says which of these happened. Nothing below leaves TEGG
changed — it only ever reads.

### "This tool has not been set up on this Mac yet"

Double-click `Setup.command`. Once only.

### "Your TEGG sign-in is not saved on this Mac"

Double-click `Setup.command` and enter it when asked.

### "No Python 3.10 or newer was found"

Your Mac's built-in Python is too old for this tool. Install a newer one from
<https://www.python.org/downloads/> — the large download button — then run
`Setup.command` again.

### "the portal rejected the credentials"

Sign in to TEGG in Safari first. If that works and this does not, the account
may have picked up a two-factor prompt, which this tool cannot answer. Escalate.

### "signed in, but the page never named the 'Lippolis' workspace"

The sign-in landed in a different contractor's area. The tool refuses to read
anything at that point, on purpose. Run `Setup.command` to replace the saved
sign-in.

### "the report form offers no agreements for this site"

That site's agreements are not published to TEGG's reporting section, or the
search matched a customer rather than a site. Nothing was requested. Try a
different visit.

### "the report viewer did not open"

TEGG builds these reports on its own server and a large one can time out. Run
it again. If the same visit fails twice, that report needs exporting by hand —
escalate.

### "this site visit recorded no equipment problems"

Not an error. The inspection found nothing to repair, so there is nothing to
quote. Both PDFs are in the run folder if you want to check.

### "another run is already going"

You started it twice. Wait for the first — it takes about a minute and a half.

### It stopped halfway, or you closed the window

Nothing is lost. Every step is written down as it completes. Run it again: it
picks up where it left off, and does **not** ask TEGG for the reports a second
time if it already has them.

---

## Exit codes

Only relevant if somebody runs this automatically.

{exit_table}

The one worth knowing is **4**: nothing was attempted, nothing was contacted,
and running it again without changing something will do exactly the same.

---

## Housekeeping

Every run keeps the two PDFs it downloaded. They name a real customer and a
real site, they stay on this Mac, and they add up.

Open Terminal in this folder and run:

```
.venv/bin/awe-tegg runs              # what is there
.venv/bin/awe-tegg runs --prune      # remove what is old enough
```

`runs` on its own deletes nothing. The rule: a finished run may be removed once
it is more than 30 days old, unless it is the most recent one. Anything that
did not finish is never removed, because that is the one worth resuming.

---

## What this tool will never do

| | |
|---|---|
| sign in, read pages, download the two reports | yes |
| submit, approve, send, email, upload, delete, mark complete | **no — refused in the code itself** |
| store your password anywhere except the macOS Keychain | **no** |
| contact the customer | **no** |
| price materials from a supplier | **no** |

---

## When to escalate, and what to send

Tell whoever maintains this tool if:

* the same visit fails twice;
* the report says something that does not match the PDFs in `documents/`;
* `Check Setup.command` reports a PROBLEM this guide does not cover.

Send them what you double-clicked, what the window said, and the **name of the
run folder** — for example `visit-findings-20260803T132708+0000`. That folder
has what they need.

Do not email the folder itself: it contains customer documents.
"""


def main() -> int:
    text = GUIDE.replace("{exit_table}", exit_table())
    (HERE / "OPERATOR_GUIDE.md").write_text(text, encoding="utf-8")
    print(f"wrote {HERE / 'OPERATOR_GUIDE.md'} ({len(text.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
