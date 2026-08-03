# TEGG ESA automation — handoff, 2026-07-29

**Rotate the portal password.** It was pasted into a chat transcript during this
session. Nothing was written to disk or config; credentials are read only from
`TEGG_USERNAME` / `TEGG_PASSWORD`.

---

# Executive Summary

Today the automation went from "cannot log in" to **pulling a real, 70-page
customer report out of the live TEGG portal and assembling it into a watermarked
PDF** — unattended, in about 90 seconds of machine time.

Concretely accomplished:

* Fixed live login. It had never once succeeded before today.
* Discovered and mapped the *actual* report route. The route the code assumed
  was a dead end.
* Exported a genuine report PDF from the live portal (Equipment Inventory Short
  Form, 70 pages, 11.9 MB) and assembled it into a DRAFT deliverable.
* Established the target site visit's real status, which changes what can
  legitimately be reported.

### What works end-to-end, unattended

```
login → contractor select → site search → site select
      → Reports → Standard ESA Reports → Short Form
      → Agreement / Order By / Images
      → Print Report → SSRS viewer → Acrobat (PDF) → capture
      → assemble → watermark DRAFT → manifest
```

Proven artifacts:

| Artifact | Path | Size |
|---|---|---|
| Short Form PDF | `TEGG-DRYRUN/jobs/atlas-capital-the-factory-T25-204/source/EquipmentInventoryShortForm.pdf` | 70 p, 11,876,559 bytes |
| Assembled DRAFT | `TEGG-DRYRUN/jobs/atlas-capital-the-factory-T25-204/output/DRAFT - TEGG_Atlas_Capital_The_Factory_2025-07-08_DEMO.pdf` | 70 p, 12,696,673 bytes |
| Manifest | `TEGG-DRYRUN/jobs/atlas-capital-the-factory-T25-204/manifest.json` | — |

---

# Major Discoveries

## Login is an Angular SPA — no navigation on submit

Submitting fires no page navigation, so `wait_for_load_state()` returns
instantly and any check made straight after **always** sees the form still
there. That single mistake produced `login did not complete -- still on the
sign-in page`, which looked exactly like bad credentials. Real login takes
**~750 ms**; the code now polls for form-disappearance or route change.

Real field wording (nothing like what was assumed):

| Control | Reality |
|---|---|
| username | `<input type="email" name="email">`, accessible name `Please enter email address/username` |
| password | `name="password"`, accessible name `Enter your password` |
| submit | `<button name="btnLogin">Sign in</button>` |
| contractor | `<select name="contractorConnection" required>` — 54 options, use `TEGGPro Lippolis` |

The visible text "User Name" is a **bare `<label>` not bound to the input**; the
accessible name comes from a *wrapping* label containing tooltip text. So
`get_by_label("User Name")` fails too. The form is now located by anchoring on
`input[type=password]`.

The contractor select is **`required`** and carries a bogus
`type="contractorConnection"` attribute. Skip it and the form silently refuses
to submit — indistinguishable from a rejected password.

Auth API is on a **different host**: `tegg.teggpro.com/api/1.0/technician/auth-new`.

## The report route — the assumed one was wrong

The company-level `/reports` page reports `currently no agreements`. **Dead end.**

The working route, and a site **must** be selected first or every tab shows
`PLEASE SEARCH FOR A CUSTOMER OR SITE USING THE SEARCH BAR`:

1. `/sales/documentation`
2. Type the **site** name into the search box (`Enter customer or site name`)
3. **Reports** tab → **Standard ESA Reports**
4. Click the report → set Agreement → **Print Report**

The search box is an **ngx-bootstrap typeahead**. Results render into
`<typeahead-container>` as `.dropdown-item`, grouped *Customers* / *Sites*.
**`fill()` does not trigger it** — use real keystrokes
(`press_sequentially`). Searching "Atlas" does *not* surface "The Factory" under
Sites; search the **site** name.

## The report list is an accordion that toggles

`Short Form` and `Long Form` are `<a>` tags **with no href** inside
`tr.child-level-1`. They are **expanded by default**. Clicking the
`Equipment Inventory` parent **collapses** them — which is exactly why early
clicks timed out. Click the leaf directly; expand only if genuinely hidden.

Because they have no `href`, `get_by_role("link")` will not match them. Use
`a:text-is('Short Form')`.

## ReportViewer behaviour — SSRS

`Print Report` does **not** download. It:

* takes **~20 seconds** (server-side generation)
* opens a **new tab**: `https://tegg.teggpro.com/Report/SSOReportViewer.aspx?db=TEGGProLippolis595&rt=rv&u=<user>&t=<token>`
* title `TEGGPro Reports`
* is a **SQL Server Reporting Services ReportViewer** (`Reserved.ReportViewerWebControl.axd`, `ReportID=…`)
* fires **no** download event and **no** dialog

## SSRS export mechanism — exact control IDs

The viewer toolbar is precisely the SOP's "Select a Format → Export":

| Control | Selector |
|---|---|
| Format dropdown | `#ReportViewer1_ctl01_ctl05_ctl00` (title `Export Formats`) |
| Export link | `#ReportViewer1_ctl01_ctl05_ctl01` (title `Export`) |
| Format label | `Acrobat (PDF) file` |

**Order matters** — select the format *first*, then click Export. Clicking
Export first does nothing.

The dropdown is **not usable immediately** after `networkidle`; the viewer keeps
rendering. Retry `select_option` in a loop.

## PDF capture approach — the key unlock

Export delivers the PDF as an **inline response**, not a download event and not
a navigation. Neither `expect_download()` nor popup-watching catches it.

**What works:** attach a `response` listener to the viewer *and* the context
before clicking Export, and grab any response whose `content-type` contains
`pdf` or whose URL contains `format=pdf`, verifying the body starts with
`%PDF-`:

```python
def grab(response):
    ctype = (response.headers or {}).get("content-type", "").lower()
    if "pdf" in ctype or "format=pdf" in response.url.lower():
        body = response.body()
        if body[:5] == b"%PDF-":
            pdf_bodies.append(body)
viewer.on("response", grab)
context.on("response", grab)
```

A second gotcha: do **not** put `settle()` inside an `expect_download()` block —
it consumes the whole timeout budget. That starved the first attempts.

## ReportSession / ControlID extraction (fallback, unverified)

A direct export URL can be built, but the ids live in the **iframe URLs**, not
the top-level document:

```python
html = viewer.content() + "".join(f.url for f in viewer.frames)
session = re.search(r"ReportSession=([^&\"'\s]+)", html)
control = re.search(r"ControlID=([^&\"'\s]+)", html)
```

```
https://tegg.teggpro.com/Reserved.ReportViewerWebControl.axd
  ?ReportSession=<s>&ControlID=<c>&Culture=1033&CultureOverrides=False
  &UICulture=9&UICultureOverrides=False&ReportStack=1&OpType=Export
  &FileName=report&ContentDisposition=AlwaysAttachment&Format=PDF
```

**This fallback has never successfully returned a PDF.** It is implemented but
unproven — treat it as a hypothesis, not a working path.

## Resume strategy

`Workspace.create()` reopens an existing job folder without losing history, and
`workspace.needs(key)` returns False once a document is settled *and* its file
is still on disk. This was proven live: the Long Form retry run did not
re-download the Short Form, and the assembly step still picked it up.

Assembly order is driven by canonical type, not download order, so a partial
run assembles whatever exists in correct business order.

## Popup handling

Register `context.on("page", ...)` **before** clicking. The viewer tab is found
by polling `context.pages` for a URL containing `Report` — the popup can take up
to ~30 s to appear, well beyond a default timeout.

## The site visit list loads asynchronously

The visit table is filled by a later API call. Scanning at load sees
`Loading site visits...` and yields **zero** rows — which is why the first live
run reported no completed visits when the portal has **123**. The list also
defaults to the **Recent** timeframe, hiding older completed visits; set
**All Site Visits**. Pagination is 12 rows/page, 15 pages.

## remote.teggpro.com is a red herring

Site-visit rows SSO out to `remote.teggpro.com` ("TEGGPro Remote 2.3",
`/work/2945/832/4776/1031976/0`). That app is **per-asset field data** —
Overview, Tasking, Problems, Variables, Forms, Images. Its "Documentation" is an
in-page anchor, not a document library. **The ESA reports are not there.** Don't
spend time on it. Its heading does carry site location: `ATLAS-CAPITAL - QUEENS, NY`.

---

# Current State

| Stage | State |
|---|---|
| Login | **Working** — live, ~750 ms |
| Contractor selection | **Working** — `Lippolis` → `TEGGPro Lippolis` |
| Customer selection | **Working** — via typeahead |
| Site selection | **Working** — `The Factory` |
| Visit selection | **Working** — 123 completed visits listed; Agreement + Site Visit auto-populate |
| Report navigation | **Working** — Reports → Standard ESA Reports → leaf |
| Parameter setting | **Working** — Agreement, Order By, Images |
| SSRS popup handling | **Working** |
| **Short Form export** | **Working** — 70 p, 11.9 MB captured live |
| **Long Form export** | **Partially working** — navigates, sets params, opens viewer, selects format, clicks Export; PDF never arrives within 90 s |
| Certificate download | **Not working** — no control produced a file |
| Other 4 reports | **Not working** — see blockers |
| **Final assembly** | **Partially working** — assembles + watermarks whatever exists; cannot produce the full 10-section report |
| Certificate field population | **Not implemented** |
| Test suite | 131 unit tests pass in ~1 s; `test_sitevisit.py` has failures from today's listing rewrite |

---

# Remaining Blockers

### 1. Target site visit is Incomplete (business blocker)

Every Atlas-Capital / The Factory visit in all 180 rows:

| Agreement | Job Num | Lead Tech | Start | End | Status |
|---|---|---|---|---|---|
| STD88117209SM-05/25-**02** | T 26-173 | Colin Reid | 7/16/2026 | 9/30/2026 | **Incomplete** |
| STD88117209SM-05/25-**01** | T25-204 | N/A | 5/2/2025 | 7/8/2025 | **Completed** |

The 2026 visit — the intended target, with a named technician — is
**Incomplete**. The only Completed exact match is **T25-204**, completed
**7/8/2025**, whose Lead Tech is `N/A` so the technician cannot be read
automatically. This run used T25-204 (operator decision).

### 2. Long Form export times out

Navigation, parameters, viewer, format selection and the Export click all
succeed. No PDF response arrives within 90 s. The Short Form is 70 pages /
11.9 MB, so the Long Form is materially larger. **Not diagnosed further** —
whether it needs a longer budget or a different capture path is unknown.

### 3. Certificate download produces no file

On the Document Library tab with the site selected, controls labelled
`Certificates` and `Certificate` both produced no file. The DOM of that tab
with a site selected has not been inspected — this is the single least-explored
part of the flow.

### 4. Four reports never got a working export attempt

Problem Count Summary, Standard IR Report, EDS Component Problem Summary and
Equipment Item Problems were attempted **before** the inline-PDF capture fix
landed. They reached the correct form with the Agreement set (confirmed by
screenshot). They have **not** been retried since the fix. Their status is
unknown, not failed.

### 5. Certificate field population not implemented

Writing customer, site, address, visit ID, dates, technician, certificate
number and agreement into the certificate does not exist. Separately, section B
checkboxes are **Wingdings glyphs, two per item across eleven items**, and are
deliberately never set automatically. `_FINAL` in a filename is therefore not
yet truthful; output stays DRAFT.

---

# Important Files Changed

## New modules

| File | Why |
|---|---|
| `src/tegg/login.py` | Structural sign-in location (anchors on the password field), error classification, post-submit outcome polling, credential redaction, extra-field support |
| `src/tegg/sitevisit.py` | Site-visit explorer: listing with async wait, header-aware table parsing, pagination, fail-closed context checks, download capture |
| `src/tegg/workspace.py` | `work/jobs/<id>/` layout, manifest, checksums, resume logic |
| `src/tegg/canonical.py` | Canonical report types, business order, label/filename classification |
| `src/tegg/certdoc.py` | Legacy `.doc` → `.docx`/PDF via LibreOffice; checkbox encoding classification |
| `src/tegg/pipeline.py` | Deterministic assembly, page-count validation, duplicate detection |
| `src/tegg/evidence.py` | Outcome taxonomy, screenshots/HTML/JSON capture |
| `src/tegg/draft.py` | DRAFT watermark (overlay, preserves page count) |
| `src/tegg/fetch.py` | Session orchestration into a workspace |

## Modified

| File | Why |
|---|---|
| `src/tegg/cli.py` | New commands: `portal list-completed`, `portal inspect`, `portal probe-login [--submit]`, `resume`, `status`, `certificate-inspect`; `run --site-visit`; import fix for `portal_credentials` |
| `src/tegg/portal.py` | Legacy login routed through the shared structural resolver (it had the same bug) |
| `config/workflow.yaml` | Real login labels, `documentation_path`, `visit_timeframe`, `login_timeout_ms`, `extra_fields`, and the confirmed `esa_reports:` route block |
| `tests/test_end_to_end.py` | Skip guard now uses `find_soffice()` — it was silently skipping on macOS |
| `.gitignore` | Ignore `work/`, `test-data/`, `*.doc`, `.DS_Store` — customer data |
| `README.md` | Corrected status; removed overclaims |

## New docs / evidence

* `docs/OPERATOR.md` — operator guide
* `TEGG-DRYRUN/FINDINGS.md` — live portal findings
* `TEGG-DRYRUN/` — screenshots, HTML, manifest, PDFs, logs
* `FINAL_HANDOFF.md` — this file

## Working scripts (not yet library code)

Under `~/.claude/jobs/2ad19574/tmp/`: `short_long.py` (the run that produced the
PDF), `probe_print.py`, `export_pdf.py`, `dryrun.py`, `find_atlas.py`.
**These are the reference implementation of the working route** — port
`short_long.py`'s export logic into `src/tegg/` before relying on it.

---

# Commands for Tomorrow

```bash
cd ~/TEGG
export TEGG_USERNAME='<your-portal-username>'
export TEGG_PASSWORD='<rotated password>'

# 1. Reproduce today's result (Short Form → assembled DRAFT)
.venv/bin/python ~/.claude/jobs/2ad19574/tmp/short_long.py

# 2. Confirm login independently, no credentials typed by you
.venv/bin/tegg portal probe-login --submit --headed

# 3. List completed visits (123 expected)
.venv/bin/tegg portal list-completed --headed --work-root ~/TEGG/TEGG-DRYRUN

# 4. Job state
.venv/bin/tegg status --job-id atlas-capital-the-factory-T25-204 \
    --work-root ~/TEGG/TEGG-DRYRUN

# 5. Fast unit tests (skip the browser files)
.venv/bin/python -m pytest tests/test_canonical.py tests/test_workspace.py \
    tests/test_config.py tests/test_resolve.py tests/test_assemble.py \
    tests/test_pipeline.py tests/test_certdoc.py -q --timeout=60
```

Never pipe pytest through `tail` — it buffers and looks like a hang.

---

# Suggested First Task Tomorrow

**Retry the other four reports with the inline-PDF capture fix.**

Take `short_long.py` and change `TARGETS` to:

```python
TARGETS = [
    (canonical.PROBLEM_COUNT_SUMMARY, "Problem Count Summary"),
    (canonical.STANDARD_IR,           "Standard IR Report"),
    (canonical.EDS_ALL_PROBLEMS,      "EDS Component Problem Summary"),
    (canonical.EQUIPMENT_ITEM_PROBLEMS, "Equipment Item Problems"),
]
```

Those four are top-level entries (not accordion children), and all reached the
correct form with the Agreement set — they simply never met the working capture
code. If they export, the report goes from 1 section to 5 of 10 in one run, and
the only gaps left are the certificate and the IR cover split (which already
works, given the IR PDF).

Highest ROI because it is a config change to already-proven code, not new
engineering.

---

# Lessons Learned

Things that would cost another engineer hours:

1. **Every "login failed" here was a timing bug, not credentials.** Angular
   submits without navigation. Poll for an outcome; never check immediately.
2. **The contractor dropdown is required.** Omit it and the form silently
   refuses. Looks exactly like a bad password.
3. **The company-level `/reports` page is a dead end** (`currently no
   agreements`). Everything lives under Documentation.
4. **A site must be selected before any tab works.** Search the **site** name,
   not the customer — "Atlas" does not surface "The Factory" under Sites.
5. **The typeahead needs real keystrokes.** `fill()` is silently ignored.
6. **Clicking an accordion parent collapses it.** `Short Form` / `Long Form` are
   visible by default; clicking `Equipment Inventory` hides them.
7. **`Print Report` takes ~20 s and opens a popup.** Not a download.
8. **It's SSRS.** Select `Acrobat (PDF) file` in
   `#ReportViewer1_ctl01_ctl05_ctl00`, *then* click
   `#ReportViewer1_ctl01_ctl05_ctl01`. Order matters.
9. **The PDF arrives as an inline response.** Watch `response` events; do not
   rely on `expect_download()`.
10. **Never wrap `settle()` inside `expect_download()`** — it eats the budget.
11. **Lists load async.** Wait for `Loading …` to clear *and* rows to exist, or
    you will conclude the portal is empty when it has 123 records.
12. **Default timeframe is "Recent."** Set "All Site Visits" or you will miss
    completed work.
13. **`remote.teggpro.com` is per-asset field data.** Reports are not there.
14. **"Incomplete" contains "complete."** Match status exactly or an unfinished
    visit will pass as reportable.
15. **The certificate is Wingdings glyphs, 2 boxes/item, 11 items** (SOP answers
    10). Never tick them programmatically without a proven mapping.
16. **The portal serves the certificate as legacy `.doc`** (OLE2, Aspose), which
    python-docx cannot open. Convert via LibreOffice first.
17. **`test-data/`, `work/` and `*.doc` are customer data.** They are gitignored.
18. **Real report sizes are large** — Short Form alone is 70 pages / 11.9 MB.
    Budget generously for generation and transfer.
