# TEGG ESA Report Automation

Automates the manual build of a customer ESA report — the process documented in
[`docs/SOP.md`](docs/SOP.md): pull seven documents out of the TEGG Pro portal,
edit the certificate, split the IR report, and merge ten PDFs into one
deliverable in a dated job folder.

## Status — honest version

"Verified (mock)" below means: exercised by a passing test driving a real
browser against a stand-in portal in `tests/`. **The live site at
`tegg2.teggpro.com` has not yet been driven end to end**, so every mock result
rests on the assumption that the real page labels match what the SOP words.
That assumption is the main thing still to be tested.

| Stage | State |
|-------|-------|
| Job workspace + resumable manifest | **Working, verified** |
| Report classification (labels → canonical types) | **Working, verified** |
| Completed-site-visit listing | **Implemented, verified (mock)** — live site unverified |
| Site-visit context + Document Library | **Implemented, verified (mock)** — live site unverified |
| Certificate download (legacy `.doc`) | **Implemented, verified (mock)** — live site unverified |
| Legacy `.doc` → `.docx`/PDF conversion | **Working, verified on the real certificate** |
| Certificate checkbox classification | **Working, verified on the real certificate** |
| Certificate checkbox *editing* | **Deliberately not done** — see below |
| Report discovery + download | **Implemented, verified (mock)** — live site unverified |
| Split IR report into cover + body | **Working, verified** |
| Merge 10 PDFs in business order | **Working, verified** |
| Final page-count + readability validation | **Working, verified** |
| DRAFT watermark + review flagging | **Working, verified** |
| Resume / retry after a partial run | **Working, verified** |
| Evidence capture + outcome taxonomy | **Working, verified** |
| Save to the shared drive | **Path-agnostic**, drive not yet identified |

**What that means in practice:** the whole pipeline runs end to end against a
mock portal, producing a 43-page draft from a real legacy `.doc` certificate.
What has not happened is a live run — see [`docs/OPERATOR.md`](docs/OPERATOR.md)
for the two commands that do it.

The portal itself is reachable from this machine (`tegg2.teggpro.com` resolves
and answers), so GAPS #1 no longer applies here; what remains is confirming the
real page labels, which the evidence folder is designed to reveal in one run.

### The certificate is never edited automatically

The TEGG certificate's checkboxes are not form fields. They are Wingdings
private-use glyphs (`U+F06F`) in ordinary text runs — **two per item** (Yes and
No) across **eleven** items, where the SOP answers only ten. `tegg
certificate-inspect` reports exactly that on the real document:

```
encodings found       : shape_or_drawing, wingdings_glyph
numbered items under B: 11
checkboxes per item   : 2
safe to edit          : NO
```

Rather than guess at a customer-facing legal attestation, the tool converts the
certificate, includes it unchanged, and marks the report **DRAFT — HUMAN REVIEW
REQUIRED**. Ticking section B stays a human step. GAPS #3 and #4 remain open by
choice, not by omission.

### Two defects found and fixed

* The full-pipeline test gated on `shutil.which("soffice")` rather than the
  project's own `certificate.find_soffice()`, so on macOS it **silently
  skipped** while the suite looked green.
* `config/workflow.yaml` sets `delete_first_checkbox_group` but `cli.py` read
  `delete_first_group` — a dead config key. Both spellings are now honoured.

**Operators start here: [`docs/OPERATOR.md`](docs/OPERATOR.md).** The whole job
is two commands:

```bash
.venv/bin/tegg portal list-completed      # which site visits are ready
.venv/bin/tegg run --site-visit 71999     # build the draft report
```

For the manual, no-portal path see [`docs/QUICKSTART.md`](docs/QUICKSTART.md).
Blocker detail in [`docs/GAPS.md`](docs/GAPS.md) — note GAPS #3 there still says
no sample certificate exists; one has since arrived in `test-data/`, and what it
revealed is summarised above.

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

### The whole route, end to end, against a mock portal

```bash
# What has to be true before a run is worth starting
.venv/bin/python -m tegg.mock_runner --preflight

# Sign in, walk the report route in a real browser, export every section,
# convert the certificate, assemble and validate a ten-section DRAFT
.venv/bin/python -m tegg.mock_runner
```

This is **full browser/UI execution** — Playwright drives Chromium through
Print Report, the ReportViewer popup, the format dropdown and Export, capturing
the PDF from the inline response, exactly as the live route does. The only
difference is that the portal is a local mock bound to `127.0.0.1`. It exits
non-zero if any acceptance criterion fails. See **`docs/MOCK_RUN.md`**.

```bash
.venv/bin/python -m pytest tests/ -q      # 463 tests, 1 skip
```

Several of those drive a real Chromium against a mock portal and convert a real
legacy `.doc` through LibreOffice, so the suite takes about three minutes.

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
src/tegg/certificate.py  docx edits + PDF convert     (does not work on a real certificate)
src/tegg/portal.py       Playwright driver            (works against the mock; live site unverified)
src/tegg/browser.py      Chrome/Chromium discovery
tests/mock_portal.py     stand-in portal for tests
src/tegg/cli.py          doctor / plan / build / fetch / certificate / run / inspect-docx

The controlled mock run:
config/mock_cases.yaml   the scenario matrix as data
src/tegg/mock_runner.py  the one documented command
src/tegg/preflight.py    prerequisites, including the loopback-only safety check
src/tegg/mockrun.py      execution orchestration and the bounded repair loop
src/tegg/mockportal.py   a faithful mock of the live portal's awkward behaviour
src/tegg/mockassets.py   marked stand-ins for the two gitignored fixed sections
src/tegg/esaroute.py     site selection, accordion navigation, parameter apply
src/tegg/ssrs.py         ReportViewer: popup, format dropdown, inline PDF capture
src/tegg/fieldmap.py     which dropdown means what, as pure planning
src/tegg/validate.py     structural, text and honesty checks per artifact
src/tegg/diagnose.py     failure text -> the narrowest place to look
src/tegg/results.py      the three-status result and its consistency rules
src/tegg/naming.py       the deliverable filename, generated and checked
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
2. **Next** — run the existing driver against the live site with `--headed` and
   read the diagnostic dumps. The driver is written; what is unknown is whether
   the real labels match the SOP's wording (GAPS #1, #2).
3. **Then** — certificate edits. A sample document now exists in `test-data/`
   and shows the current approach does not fit it: glyph-based checkboxes,
   two boxes per item, and an eleventh item. GAPS #3 and #4 are open.
4. **Then** — legacy `.doc` handling, since that is the format the portal
   actually serves.
5. **Later** — resume/retry, then scheduling, but scheduling only if there is a
   reliable signal for when a site visit is ready to report on (GAPS #10).
