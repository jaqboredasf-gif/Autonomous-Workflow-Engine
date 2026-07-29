# TEGG ESA Report Automation

Automates the manual build of a customer ESA report — the process documented in
[`docs/SOP.md`](docs/SOP.md): pull seven documents out of the TEGG Pro portal,
edit the certificate, split the IR report, and merge ten PDFs into one
deliverable in a dated job folder.

## Status — honest version

| Stage | State |
|-------|-------|
| Job folder creation | **Working** |
| SOP encoded as config | **Working** |
| Matching real download filenames to sections | **Working, tested** |
| Split IR report into cover + body | **Working, tested** |
| Merge 10 PDFs in SOP order | **Working, tested** |
| Final filename + output naming | **Working** (separator needs confirming) |
| Incomplete-report guard | **Working, tested** |
| Build manifest / audit log | **Working** |
| Portal login + 7 downloads | **Scaffolded, cannot run** — see GAPS #1, #2 |
| Certificate checkbox edits | **Scaffolded, blocked** — see GAPS #3, #4 |
| Save to the shared drive | **Path-agnostic**, drive not yet identified |

**What that means in practice:** everything that happens once the documents are
on disk works today and is covered by tests — `tegg build` is usable for real
reports right now, with the documents downloaded by hand. The front half,
pulling from the portal, is blocked on network access to `tegg2.teggpro.com`
rather than on code.

To use it today, follow [`docs/QUICKSTART.md`](docs/QUICKSTART.md). Full
blocker detail in [`docs/GAPS.md`](docs/GAPS.md).

## Try it

Nothing below touches the portal, the shared drive, or any real customer data.

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"

# What is ready and what is blocked
.venv/bin/tegg doctor

# Generate stand-in PDFs that mimic a real job
.venv/bin/python scripts/make_fixtures.py /tmp/demo
cp "/tmp/demo/ESA Table of Contents.pdf" \
   "/tmp/demo/TEGGPro View Customer Instructions.pdf" assets/static/

# Show everything a run would do, without doing any of it
.venv/bin/tegg plan --job config/job.example.yaml --drive-root /tmp/drive

# Build the report
.venv/bin/tegg build --job config/job.example.yaml \
    --source /tmp/demo --drive-root /tmp/drive
```

The last command produces
`Acme Manufacturing Plant 3 - Toledo 2026 ESA Report.pdf` — 44 pages, correct
order — in about a third of a second, plus a `build-manifest.json` recording
every source file and page count.

```bash
.venv/bin/python -m pytest tests/ -q      # 58 tests
```

## How it is put together

The SOP lives in **`config/workflow.yaml`**, not in code. Report parameters,
merge order, certificate answers, and the output filename are all data. Adding
a report or reordering the merge is a config edit, not a code change.

```
config/workflow.yaml     the SOP as data
config/job.example.yaml  the five inputs an operator supplies
src/tegg/assemble.py     PDF split + merge            (working)
src/tegg/resolve.py      real filenames -> sections   (working)
src/tegg/paths.py        Company/Site/Year folders    (working)
src/tegg/manifest.py     per-run audit log            (working)
src/tegg/certificate.py  docx edits + PDF convert     (blocked, see GAPS)
src/tegg/portal.py       Playwright scaffold          (blocked, see GAPS)
src/tegg/cli.py          doctor / plan / build / fetch
```

An operator supplies only five values per job — company, site, year, agreement,
site visit. Everything else is fixed.

## Design notes

**Real filenames don't have to match.** Documents exported by hand arrive as
`ProblemCountSummary (1).pdf` or `Equipment Inventory Short Form.pdf`. Matching
runs in tiers — exact, case-insensitive, punctuation-insensitive, then prefix —
and every build prints how each section was matched so a wrong pick is visible
before the report goes out. Exact matches are claimed before fuzzy matching
runs, so a loose rule can never steal another section's file.

**It refuses to build an incomplete report.** If any of the ten documents is
missing, the merge stops and names every missing file rather than producing a
report that is quietly short a section. A partial report reaching a customer is
worse than no report.

**Every build leaves a record.** `build-manifest.json` lands next to the report
with the job details, each source file, how it was matched, and page counts.

**Credentials are never read from a file.** `TEGG_USERNAME` / `TEGG_PASSWORD`
come from the environment; there is no code path that loads a credential from
config, so none can be committed by accident.

**Blocked steps fail loudly.** Where the correct behaviour is genuinely unknown
— such as how many checkboxes are in the certificate's "first group" — the code
raises an error naming what it needs, instead of guessing at a customer-facing
document.

## Suggested phasing

1. **Now** — use `tegg build` on manually downloaded files. Removes the Acrobat
   splitting and merging entirely; no portal access required. See
   [`docs/QUICKSTART.md`](docs/QUICKSTART.md).
2. **Next** — unblock GAPS #1 and #2 (network access, then selectors) to
   automate the seven downloads. This is the largest remaining time saving.
3. **Then** — certificate edits, once a sample document settles GAPS #3 and #4.
4. **Later** — scheduling, but only if there is a reliable signal for when a
   site visit is ready to report on (GAPS #10).
