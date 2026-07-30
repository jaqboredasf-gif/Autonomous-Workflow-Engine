# The controlled mock run

One command exercises the whole ESA report path against a local mock portal:

```
python -m tegg.mock_runner
```

It signs in to a mock portal bound to `127.0.0.1`, walks the report route in a
real browser, exports every section, converts the certificate, splits the
Standard IR cover, assembles a ten-section DRAFT, validates every artifact,
prints a summary, writes a JSON result, and exits non-zero if any acceptance
criterion fails.

Nothing it touches is live. It sends nothing, uploads nothing, and needs no
credentials — the mock's account is a fake constant in `tegg.mockportal`.

## What kind of execution this is

**Full browser/UI execution against a local mock HTTP server.** Playwright
drives Chromium through the same modules that drove the live portal
(`tegg.login`, `tegg.esaroute`, `tegg.ssrs`): Print Report → popup ReportViewer
→ select PDF in the format dropdown → click Export → capture the inline
response. There is no API shortcut and no direct-URL export on the success
path; `ssrs.direct_export` exists only as a last-resort fallback and does not
fire in a healthy run (the log records `exported via inline response` for every
report). The only difference from the live route is the host it points at.

## Prerequisites

```
python -m tegg.mock_runner --preflight
```

Checks, in the order a run needs them:

| Check | Blocking | What it means |
| --- | --- | --- |
| `target_is_local` | yes | Nothing points the run at a non-loopback host |
| `credentials` | no | Whether `TEGG_USERNAME`/`TEGG_PASSWORD` are set. Reports presence only, never values. The mock run does not need them |
| `dotenv_ignored` | yes | `.gitignore` ignores `.env` |
| `static_assets` | yes | Both fixed sections are present and non-empty |
| `case_file` | yes | `config/mock_cases.yaml` loads and covers all ten sections |
| `output_writable` | yes | The work root accepts a write |
| `document_converter` | yes | LibreOffice, for the legacy `.doc` certificate |
| `browser_runtime` | yes | Chromium launches headless |
| `portal_reachable` | yes | The mock portal starts, serves its sign-in page, and stops |

Exits 0 when ready, 2 when something blocks. A full run performs the same check
first and refuses to start on a blocker; `--skip-preflight` bypasses that.

## Options

| Flag | Effect |
| --- | --- |
| `--work-root DIR` | Where job workspaces are written (default `mock-run/`) |
| `--assets DIR` | Folder holding the two fixed PDF sections |
| `--cases FILE` | Case file (default `config/mock_cases.yaml`) |
| `--report FILE` | Where to write the JSON result |
| `--max-attempts N` | Bounded retries per case (default 2) |
| `--headed` | Show the browser |
| `--slow` | Timings closer to the live portal's, to exercise the waits |
| `--quiet` | Print only the verdict |
| `--preflight` | Check prerequisites and exit |
| `--skip-preflight` | Run without the prerequisite check |
| `--synthesize-assets` | Write stand-ins for the fixed sections if absent |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every acceptance criterion met (or, with `--preflight`, ready to run) |
| 1 | At least one criterion failed — the summary names which |
| 2 | The run could not start: failed preflight, bad case file, missing assets, no browser |

## What it produces

Under `<work-root>/jobs/<job-id>/`:

- `source/` — one PDF per portal-exported section, plus the downloaded `.doc`
  certificate
- `converted/` — the certificate as PDF, the split IR cover and body, the two
  fixed sections
- `evidence/` — login and ReportViewer screenshots, plus `observations.json`
- `logs/mock-run.log` — every step, in order
- `manifest.json` — one record per section with checksums and page counts
- `output/DRAFT - TEGG_<Customer>_<Site>_<date>.pdf` — the assembled report

Each fault scenario gets its own job directory, so one injected failure cannot
mask another. The machine-readable result for the whole run is
`<work-root>/mock-result.json`.

## Scenarios

Eleven section cases cover all ten sections of the business order plus the
Standard IR source that gets split. Seven fault cases inject a deterministic
failure and assert it is detected *and localised to the right stage*:

| Case | Injects | Expected diagnosis |
| --- | --- | --- |
| `export-serves-no-pdf` | 500 with no body | `export/pdf_never_arrived` |
| `export-serves-html-as-pdf` | Error page typed `application/pdf` | `export/response_was_not_a_pdf` |
| `export-serves-empty-body` | Zero-length `application/pdf` | `export/pdf_never_arrived` |
| `print-opens-no-viewer` | Print Report opens nothing | `report_viewer/viewer_never_opened` |
| `form-omits-the-agreement` | Form does not offer the job's agreement | `parameters/parameter_unsatisfiable` |
| `report-absent-from-the-list` | The leaf is not in the accordion | `report_navigation/report_leaf_not_found` |
| `recommendation-and-estimate-malformed` | Valid PDF carrying unresolved tokens | `validation/placeholder_left_in_output` |

The last one is the only fault whose export *succeeds*. The document opens
cleanly and passes every structural check; what is wrong is inside it. It is
there to prove the text pass is load-bearing rather than decorative.

One further scenario, `rerun-the-same-report`, re-exports a section that already
succeeded and asserts that the second export is valid, that the manifest still
holds one record per section, and that the deliverable assembled before the
rerun is byte-for-byte unchanged.

## The certificate is deliberately not finished

The certificate's section B is eleven items with two Wingdings-glyph checkboxes
each. There is no proven glyph-to-item mapping, so the boxes are never set
automatically and the signature line is never filled. The run reports:

```
generation_status:   completed
review_status:       human_review_required
finalization_status: blocked
```

That is the automation declining to make a claim it cannot support, not a
failure. A human must tick section B and sign before the report goes anywhere.
`results.ReportResult.consistent()` enforces in code that no result claims to be
ready to finalize while review is outstanding.

## Reproducing from a clean clone

The two fixed sections in `assets/static/` are gitignored on purpose — one
carries the contractor's branding, a named staff email address and a
customer-portal URL. A fresh clone therefore has no way to assemble a
ten-section report.

```
python -m tegg.mock_runner --synthesize-assets
```

writes stand-ins under the same filenames, each stamped
`SYNTHETIC STAND-IN -- NOT THE REAL SECTION` in its text layer. Existing files
are never overwritten. Any run that uses a stand-in marks the deliverable
`finalization_status: blocked` and says so in the summary: it demonstrates the
machinery, it is not a report anyone may send.

## Limitations

- The portal is a mock. It reproduces the live portal's awkward behaviours
  faithfully — client-side login with no navigation, keystroke-driven typeahead,
  accordion leaves with no `href`, a delayed popup, a format dropdown that is
  disabled while the viewer renders, PDF delivered as an inline response — but
  it is not the live system, and passing here is not proof the live route still
  works.
- The live route cannot be re-run from this environment: `TEGG_USERNAME` and
  `TEGG_PASSWORD` are unset and no `.env` exists.
- The portal password that appeared in an earlier transcript must be treated as
  compromised and rotated by its owner. Rotation has not been performed here and
  is not claimed.
- Timings are compressed. `--slow` moves them towards live (the live Print
  Report takes roughly twenty seconds) but does not match them.
