"""Write the Windows operator guide and troubleshooting sheet.

The same reason as the macOS generator next door: the exit-code table is the
one part of an operator guide that goes quietly wrong, because it is
transcribed once and then the code changes. Generating it means the guide can
only ever be right.

Two files, because they are read at different moments and by different moods.
OPERATOR_GUIDE.md is read once, calmly, to understand what the thing does.
TROUBLESHOOTING.txt is read at the moment something has failed, on a PC that
may have no Markdown reader, so it is plain text that Notepad opens correctly.

    python packaging/operator/windows/make_guide_windows.py
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "src"))

from awe_runtime.exits import exit_table  # noqa: E402

GUIDE = """# Operator guide - TEGG Report Tool (Windows)

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

A run writes one folder inside `work\\operations\\`, named after the date and
time it ran. `Run Report.bat` opens it for you when it finishes.

| in that folder | what it is |
|---|---|
| `review\\review.md` | **the thing to read.** The repair items, worst first. |
| `review\\review.json` | the same information as data, if anyone needs to import it |
| `documents\\` | the two TEGG reports, exactly as TEGG produced them |
| `state.json` | a record of every step, for troubleshooting |
| `evidence\\` | screenshots taken along the way |

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

1. make a copy of `config\\ratecard.example.yaml` called
   `config\\ratecard.yaml`;
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
%LOCALAPPDATA%\\TEGG Report Tool\\credentials.dat
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

{exit_table}

The one worth knowing is **4**: nothing was attempted, nothing was contacted,
and running it again without changing something will do exactly the same.

---

## Housekeeping

Every run keeps the two PDFs it downloaded. They name a real customer and a
real site, they stay on this PC, and they add up.

Open a Command Prompt in this folder and run:

```
.venv\\Scripts\\awe-tegg.exe runs              (what is there)
.venv\\Scripts\\awe-tegg.exe runs --prune      (remove what is old enough)
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
* the report says something that does not match the PDFs in `documents\\`;
* `Check Setup.bat` reports a PROBLEM that TROUBLESHOOTING.txt does not cover.

Double-click **`Diagnostic.bat`** and send them the file it puts on your
Desktop. It contains no password and no secret, and it saves a round of
questions.

Also tell them the **name of the run folder** - for example
`visit-findings-20260803T132708+0000`.

Do not email the run folder itself: it contains customer documents.
"""


TROUBLESHOOTING = """TEGG REPORT TOOL - TROUBLESHOOTING (WINDOWS)
============================================

Find the message you saw. Nothing below leaves TEGG changed: the tool only
ever reads from it.

If your problem is not here, double-click  Diagnostic.bat  and send the file
it puts on your Desktop to whoever gave you this tool.


-------------------------------------------------------------------------
WINDOWS ITSELF GETS IN THE WAY
-------------------------------------------------------------------------

"Windows protected your PC" with a "Don't run" button
    This is SmartScreen. It says this about anything downloaded that it has
    not seen many times before. Click "More info", then "Run anyway".

    If your company has removed that button, you cannot get past it yourself.
    Ask IT to allow this folder, or ask for it on a USB stick or a network
    share instead of a download.

Double-clicking a .bat file opens Notepad instead of running it
    Somebody has changed what .bat files open with. Right-click the file ->
    Open with -> choose "Windows Command Processor", and tick "Always use".

"...is not digitally signed" / "running scripts is disabled on this system"
    You started a .ps1 file directly. Do not. Always double-click the .bat
    file of the same name - it is there precisely to get past this, for that
    one run, without changing anything about your PC.

Nothing happens, or a black window flashes and vanishes
    Open a Command Prompt in this folder (click the address bar in File
    Explorer, type cmd, press Enter) and run:   Diagnostic.bat
    The window will stay open and the error will be visible.

The files came out of a zip and behave strangely
    Windows marks everything from a downloaded zip as untrusted. Setup.bat
    clears that mark for this folder on its first run. If you extracted the
    zip somewhere unusual, extract it again to C:\\TEGG and run Setup.bat.


-------------------------------------------------------------------------
SETUP
-------------------------------------------------------------------------

"No Python 3.10 or newer was found on this PC"
    Windows does not come with Python.
      1. Go to  https://www.python.org/downloads/windows/
      2. Download the latest "Windows installer (64-bit)".
      3. Run it. On the FIRST screen tick  [x] Add python.exe to PATH.
         Then click "Install Now".
      4. Double-click Setup.bat again.

    If your company blocks installs, send IT this line:
      "Please install Python 3.12 for Windows from python.org, with the
       Add to PATH option ticked."

A Microsoft Store page opens when you type "python"
    That is the Windows placeholder, not Python. Install the real one from
    python.org as above. This tool ignores the placeholder on purpose.

"Could not create the installation folder"
    The folder is read-only, or OneDrive is holding it. Move the whole
    TEGG-Report-Tool folder to  C:\\TEGG  and run Setup.bat again.

"Could not install the components"
    Almost always no internet, or a company proxy blocking pypi.org.
    The details are in  .setup-install.log  in this folder. That log has no
    password in it and is safe to send on.

"The browser could not be downloaded"
    A firewall is blocking playwright.azureedge.net. The details are in
    .setup-browser.log in this folder.
    If Google Chrome is already installed on this PC, the tool can use that
    instead - say so when you report this.


-------------------------------------------------------------------------
RUNNING A REPORT
-------------------------------------------------------------------------

"This tool has not been set up on this PC yet"
    Double-click Setup.bat. Once only.

"Your TEGG sign-in is not saved on this PC"
    Double-click Setup.bat and enter it when asked.

"The saved sign-in could not be read back"
    The sign-in was saved by a different Windows user, or this folder was
    restored from a backup of another PC. Windows protects it per-account on
    purpose. Run Setup.bat again and re-enter it.

"the portal rejected the credentials"
    Sign in to TEGG in your browser first. If that works and this does not,
    the account may have picked up a two-factor prompt, which this tool
    cannot answer. Escalate.

"signed in, but the page never named the 'Lippolis' workspace"
    The sign-in landed in a different contractor's area. The tool refuses to
    read anything at that point, on purpose. Run Setup.bat to replace the
    saved sign-in.

"the report form offers no agreements for this site"
    That site's agreements are not published to TEGG's reporting section, or
    the search matched a customer rather than a site. Nothing was requested.
    Try a different visit.

"the report viewer did not open"
    TEGG builds these reports on its own server and a large one can time out.
    Run it again. If the same visit fails twice, that report needs exporting
    by hand - escalate.

"this site visit recorded no equipment problems"
    Not an error. The inspection found nothing to repair, so there is nothing
    to quote. Both PDFs are in the run folder if you want to check.

"another run is already going"
    You started it twice. Wait for the first - it takes about a minute and a
    half.

It stopped halfway, or you closed the window
    Nothing is lost. Every step is written down as it completes. Run it
    again: it picks up where it left off, and does NOT ask TEGG for the
    reports a second time if it already has them.

The report opened but every money figure says NOT PRICED
    That is correct and deliberate until somebody puts your real labour rates
    into config\\ratecard.yaml. See OPERATOR_GUIDE.md, "About the money".


-------------------------------------------------------------------------
WHAT TO SEND WHEN YOU ESCALATE
-------------------------------------------------------------------------

1. Double-click  Diagnostic.bat  and send the file it writes to your Desktop.
   It contains no password, token or cookie. Read it first if you like.
2. Say what you double-clicked and what the window said.
3. Say the name of the run folder, if there was one - for example
   visit-findings-20260803T132708+0000

Do NOT email the run folder itself. It contains customer documents.
"""


def main() -> int:
    guide = GUIDE.replace("{exit_table}", exit_table())
    (HERE / "OPERATOR_GUIDE.md").write_text(guide, encoding="utf-8")
    print(f"wrote {HERE / 'OPERATOR_GUIDE.md'} ({len(guide.splitlines())} lines)")

    # CRLF, because this one is opened in Notepad on a PC that has just gone
    # wrong, and Notepad on older Windows shows LF-only text as one long line.
    trouble = TROUBLESHOOTING.replace("\n", "\r\n")
    (HERE / "TROUBLESHOOTING.txt").write_bytes(trouble.encode("ascii"))
    print(f"wrote {HERE / 'TROUBLESHOOTING.txt'} "
          f"({len(TROUBLESHOOTING.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
