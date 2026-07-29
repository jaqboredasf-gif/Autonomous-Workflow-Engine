# Quickstart — building a report today

This is the workflow that works right now. You still download the seven
documents from TEGG Pro by hand; the tool does everything after that — the
folder, the cover split, the ten-document merge, the filename, and a log of
what went in.

Manual Acrobat time per report drops to roughly zero.

## One-time setup

**Get the code.** It lives in GitHub, not on your machine:

```bash
git clone https://github.com/jaqboredasf-gif/TRANSCEND.git
cd TRANSCEND
```

The work is on the `claude/tegg-agent-gaps-af4ziv` branch, which is currently
the repository default, so a plain clone lands on it.

**Install.** Python 3.10 or newer:

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev,portal]"        # macOS / Linux
.venv\Scripts\pip install -e ".[dev,portal]"    # Windows
```

**Install a browser for the portal stage** (skipped if Chrome is already on the
machine -- `src/tegg/browser.py` finds it):

```bash
.venv/bin/python -m playwright install chromium
```

**Install LibreOffice** for the certificate conversion, unless you would rather
export that one file to PDF by hand:

```bash
brew install --cask libreoffice        # macOS
```

It does not need to be on PATH -- the usual install locations are checked, and
`TEGG_SOFFICE` overrides if yours is somewhere unusual.

**Set the portal credentials** as environment variables. They are never read
from a file:

```bash
export TEGG_USERNAME='PLippolis1'
export TEGG_PASSWORD='...'
```

Put the two fixed documents into `assets/static/`, named exactly:

- `ESA Table of Contents.pdf`
- `TEGGPro View Customer Instructions.pdf`

Check the setup:

```
tegg doctor
```

Everything under "Stages that run without portal access" and "Static assets"
should say OK. The Certificate and Portal sections will say BLOCKED — that is
expected today, and the workaround is below.

## Per report

**1. Make a job file.** Copy `config/job.example.yaml`, change the five values:

```yaml
company: "Acme Manufacturing"
site: "Plant 3 - Toledo"
year: 2026
agreement: "AG-118422"
site_visit: "2026-05-14"
```

**2. Download the documents from TEGG Pro** into any empty folder — the SOP
steps are in `docs/SOP.md` stages 3 and 4. Don't worry about filenames. The
tool handles `ProblemCountSummary (1).pdf`, `Equipment Inventory Short
Form.pdf`, timestamped exports and so on.

**3. Do the certificate by hand** (this stage is not automated yet — see
GAPS #3, #4). Open the downloaded `Certificates.docx`, make the edits from SOP
stage 5, and save it as **`Certificates good.pdf`** into the same folder.

**4. Build it:**

```
tegg build --job jobs/acme.yaml --source "C:\Users\Paul\Downloads\acme" --drive-root "T:\"
```

That will:

- create `z. TEGG Job Folders (Reports Only)\Acme Manufacturing\Plant 3 - Toledo\2026`
- split page 1 of the IR report into `Cover.pdf`, the rest into
  `StandardIRReport no cover.pdf`
- find all ten documents and print how each was matched
- merge them in SOP order into
  `Acme Manufacturing Plant 3 - Toledo 2026 ESA Report.pdf`
- write `build-manifest.json` recording every source file and page count

Add `--dry-run` to see what it found without building anything.

## If something is missing

The build **stops** and names every document it could not find, and writes
nothing. That is deliberate: a report quietly missing a section is worse than
no report. Add the missing file and run it again.

Read the `resolved sections` list before sending anything to a customer. If a
line shows `<- SomeOtherName.pdf`, confirm it picked the file you intended.
