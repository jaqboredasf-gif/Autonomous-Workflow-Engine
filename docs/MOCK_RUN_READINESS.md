# Mock run readiness — the Windows coworker workflow

**Date:** 2026-08-05
**Branch:** `claude/tegg-agent-gaps-af4ziv`
**Artefact:** `dist/TEGG-Report-Tool-Windows.zip` (86 files, 651 KB)

This document says what the Windows mock run got wrong, why, what changed, and
what is and is not proven. It separates **mocked verification** (done here, on
a Mac, against a mock portal) from **live TEGG verification** (not done, and
what it would take).

---

## 1. The package contract — read this first

### It is EIGHT documents, not seven

The correction that set this contract listed seven items, but named item 2
**"Certificate – Standard IR"**. On the live portal those are two separate
documents, reached by two different routes, with different parameters and
different file formats:

| | Certificate | Standard IR Report |
|---|---|---|
| tab | **Document Library** | **Reports → Standard ESA Reports** |
| parameter | `Solution = <agreement>` | `Agreement = <agreement>` |
| action | `Print/Generate Document` | `Print Report` → SSRS viewer → Export |
| arrives as | legacy `.doc`, needs conversion | PDF |

Both were confirmed required. That makes **eight**. Every count in the code,
the tests, the manifest, the progress display and the email is eight, and the
operator progress reads **1/8 … 8/8**, not 1/7 … 7/7.

### The eight

| # | Canonical name | Source | Route / origin | Filename |
|---|---|---|---|---|
| 1 | TEGG Table of Contents | **static asset** | `assets/static/ESA Table of Contents.pdf` | `ESA Table of Contents.pdf` |
| 2 | Certificate | **Document Library** | `Document Library > Certificates`, `Solution = <agreement>` | `{visit}-Certificate.pdf` |
| 3 | Standard IR Report | ESA report | `Standard IR Report` | `{visit}-StandardIRReport.pdf` |
| 4 | Inventory Equipment - Long Form | ESA report | `Equipment Inventory > Long Form` | `{visit}-EquipmentInventoryLongForm.pdf` |
| 5 | Inventory Equipment - Short Form | ESA report | `Equipment Inventory > Short Form` | `{visit}-EquipmentInventoryShortForm.pdf` |
| 6 | Problem Counts | ESA report | `Problem Count Summary` | `{visit}-ProblemCountSummary.pdf` |
| 7 | Summary (EDS Component Problem Summary) | ESA report | `EDS Component Problem Summary > All Problems` | `{visit}-EDSComponentProblemSummary.pdf` |
| 8 | Equipment Problems | ESA report | `Equipment Item Problems > Exclude All Images` | `{visit}-EquipmentItemProblems.pdf` |

Defined once, in `src/awe_tegg/deliverables.py` → `REQUIRED`.

**Additional, recorded but not gating:** `review/review.md`,
`review/review.json`, `deliverables.json`, `email/draft.eml`.

### Where the Table of Contents comes from — confirmed

**It is a static PDF that ships with the tool and is copied into every
package.** It is not downloaded from TEGG and not generated.

Evidence: `assets/static/README.md` names it as one of two documents that "are
the same on every job and are not exported from the portal";
`src/tegg/canonical.py` classifies it `SOURCE_STATIC`; `config/workflow.yaml`
lists it under `static_assets`. It ships inside the Windows ZIP (verified) and
`stage_table_of_contents()` copies it into each run's `documents/` folder and
records it in the manifest like any other document.

> ⚠️ **Open question, not resolved here.** `assets/static/README.md` asks
> whether the contents page is genuinely identical for every report or varies
> with report length. If it varies it must be generated per job and the copy
> is wrong. It will be wrong *visibly* — the same file appears in every
> package — but nobody has confirmed it either way. This is GAPS #8.

### Long Form and Short Form are separate — confirmed

They are **not** alternatives. Repository evidence:

- `config/workflow.yaml` defines them as two documents with two routes
  (`Equipment Inventory > Short Form`, `Equipment Inventory > Long Form`) and
  different parameters — the Short Form takes `order_by` and `images`, the
  Long Form takes `record_selection`.
- `src/tegg/canonical.py` gives each its own type, with `short` and `long` as
  required discriminating tokens.
- **The decisive one:** the 2026-07-29 dry-run manifest
  (`TEGG-DRYRUN/jobs/atlas-capital-the-factory-T25-204/manifest.json`) records
  `equipment_inventory_short` as `downloaded` with a checksum, and
  `equipment_inventory_long` as `unavailable` — *on the same site, in the same
  run*. One succeeded while the other failed. They cannot be the same document.

Enforced by `test_the_long_and_short_inventory_are_separate_and_cannot_substitute`
and, on genuinely rendered files, by
`test_the_long_and_short_inventory_come_back_as_different_documents`.

### Routes were inspected, not assumed

The live Standard ESA Reports list offers **four** reports whose name ends in
"Summary": Problem Count Summary, Inventory Summary, Visual Inspection
Summary, Tasking Completion Summary — plus the EDS Component Problem Summary
the package wants. Only `Problem Count Summary` and
`EDS Component Problem Summary` are wired; the other three are wired into the
**mock as decoys**, so a route that matched on the word "Summary" fetches the
wrong document and fails a test.

Two tests assert no two documents share a route
(`test_no_two_documents_share_a_route`) or a filename
(`test_every_expected_filename_is_distinct`).

---

## 2. Defects found, and their root causes

### D1 — The intake wizard was never skipped, because there was never one

No intake code existed anywhere. `Run Report.ps1` built its argument list and
went straight to `awe-tegg run visit-findings`. Site and customer names came
from whatever the portal's visit row said; recipient name, recipient email,
site address and job number had **no representation in any data structure**.

### D2 — Only two documents, by design

`src/awe_tegg/documents.py` defined exactly two report routes (old lines
97–98) and `visit_operation._retrieve()` asked for exactly those two (old lines
484–490). Two arrived, so the run was correct to call itself finished. There
was **no contract stating what a finished package contains**, so nothing could
detect a shortfall. `docs/COWORKER_READINESS.md:45` records the same two files
from the earlier live run.

### D3 — No package contract existed at all

`config/workflow.yaml` had 7 portal documents for the *older* pipeline;
`docs/SOP.md` and `canonical.py` described 10 sections merged into **one** PDF.
Nothing described the package the coworker was expected to produce.

### D4 — The portal renders reports; it does not create records

It does neither of the two things suspected. It does not open an existing file,
and it did not create a record. It drives SSRS to **render a new report
server-side** and captures the export. What it deliberately did not do is
create or update a TEGG *record* — `FORBIDDEN_WORDS` refuses save/submit/
approve/send/delete/complete/sign, and `guard.ReadOnlyPage` has no `click`.

### D5 — No email draft code existed

`src/tegg/draft.py` is PDF *watermarking*, unrelated. No recipient field, no
message builder, no attachment handling, no `.eml` writer.

### D6 — Progress was invisible during the slow part

`retrieve_documents` printed one line and then nothing for ~40 seconds.

---

## 3. Files changed

### New

| File | What it is |
|---|---|
| `src/awe_tegg/intake.py` | The nine-question wizard: numbered prompts, examples, validation, confirmation, revise-by-number, safe cancel. Collects no credential. |
| `src/awe_tegg/deliverables.py` | The eight-document contract, the manifest, and `Manifest.enforce()`. |
| `src/awe_tegg/email_draft.py` | The reviewable draft. Has no transport code of any kind. |
| `src/awe_tegg/portal_write.py` | Gated create/update of a TEGG report record. Off by default, two locks. |
| `tests/awe_tegg/test_operator_workflow.py` | 60 tests. |
| `tests/awe_tegg/mock_ssrs.py` | Mock portal: typeahead, expand-only parents, late SSRS toolbar, inline PDF response, **Document Library route**, **four Summary decoys**. |
| `tests/awe_tegg/test_package_end_to_end.py` | 12 tests driving a **real browser** through the real click-path. |
| `docs/MOCK_RUN_READINESS.md` | This document. |

### Modified

| File | Change |
|---|---|
| `src/awe_tegg/deliverables.py` | Rewritten for eight documents, three sources, page counts, duplicate and misfiling detection. |
| `src/awe_tegg/documents.py` | `retrieve_certificate()` — the Document Library route, written out separately from the report flow. |
| `src/awe_tegg/visit_operation.py` | `stage_table_of_contents()`, `retrieve_certificate()`, six-report loop; manifest built and enforced; three new steps; intake on the ledger and restored on resume; per-document reuse; budgets raised to 110 actions / 2700 s. |
| `src/awe_tegg/cli.py` | Wizard before the browser; `--no-intake`, `--create-tegg-report`; per-document progress; closing screen; **preflight now checks the Table of Contents exists and LibreOffice is installed**. |
| `src/awe_tegg/operation.py` | `Settings.write` — write-control labels, empty by default. |
| `packaging/operator/windows/Run Report.ps1` | Explains the questions; `--run-id` resumes; closing screen lists eight documents and the draft status. |
| `packaging/operator/windows/TEGG-Common.ps1` | `Get-LatestRunFolder`, `-LiteralPath` throughout. |
| `pyproject.toml` | Registers the `slow` marker. |

---

## 4. The manifest

`deliverables.json` records, per document, exactly what was asked for:

| Field | Example |
|---|---|
| canonical name | `Inventory Equipment - Long Form` |
| expected source / route | `TEGG Reports > Standard ESA Reports (SSRS render)` / `Equipment Inventory > Long Form` |
| parameters | `Agreement = <agreement>` |
| generated filename | `T25-204-EquipmentInventoryLongForm.pdf` |
| generation status | `generated` / `copied` / `converted` / `reused` / `failed` |
| validation status | `valid` / `not-a-pdf` / `empty` / `missing` / `duplicate-of-another-document` |
| page count | `12` |
| final path | full path |
| bytes, sha256, detail | |

`Manifest.enforce()` raises unless **all** of:

1. all eight are produced and `valid` — validation opens the file with pypdf
   and counts pages, so a truncated export or an error page saved as `.pdf`
   fails;
2. **no two slots hold the same file** — same checksum or same path. One
   report filed as two would otherwise look like a complete package;
3. **no slot holds another slot's document** — checked by filename, since
   every expected filename is distinct.

---

## 5. Expected operator screens

### Screen 1 — the questions

```
====================================================================
  TEGG REPORT -- what this report is about
====================================================================

  Nine questions. Nothing is sent to TEGG until you confirm them.
  Press Ctrl-C at any point to stop; nothing will have been done.

  Your TEGG sign-in is NOT asked for here and is never saved by this
  tool. It is read from this window only while signing in.

  [1 of 9]  TEGG visit ID
           On the visit in TEGG Documentation. This is what gets read.
           example: T25-204
  >
```

Blank required answer re-asks: `! This one is needed.`

### Screen 2 — confirmation

```
--------------------------------------------------------------------
  CONFIRM -- this is what the report will be built from
--------------------------------------------------------------------
    1. TEGG visit ID              T25-204
    2. Customer / company name    Atlas Capital
    3. Site name                  The Factory
    4. Site address               120 Mill Street, Toledo OH 43604
    5. Report recipient's name    Paul Lippolis
    6. Report recipient's email   paul.lippolis@example.com
    7. Job / reference number     T25-204-ESA
    8. Reports wanted             the standard TEGG ESA package
    9. Findings source            retrieve findings from TEGG

   Enter Y to start, a number (1-9) to change that answer,
   or C to cancel without doing anything.
  >
```

### Screen 3 — the package, counting to eight

```
  Documents for visit T25-204:
   [1/8]   OK   TEGG Table of Contents                     ESA Table of Contents.pdf 2p
   [2/8]   OK   Certificate                                T25-204-Certificate.pdf 3p
   [3/8]   OK   Standard IR Report                         T25-204-StandardIRReport.pdf 4p
   [4/8]   OK   Inventory Equipment - Long Form            T25-204-EquipmentInventoryLongForm.pdf 5p
   [5/8]   OK   Inventory Equipment - Short Form           T25-204-EquipmentInventoryShortForm.pdf 6p
   [6/8]   OK   Problem Counts                             T25-204-ProblemCountSummary.pdf 7p
   [7/8]   OK   Summary (EDS Component Problem Summary)    T25-204-EDSComponentProblemSummary.pdf 8p
   [8/8]   OK   Equipment Problems                         T25-204-EquipmentItemProblems.pdf 9p
   8 of 8 required documents produced.
   plus  Review page: review.md

  Email draft   ...\work\operations\visit-findings-.../email/draft.eml
    to          paul.lippolis@example.com
    subject     TEGG ESA Report 2026 - Atlas Capital - The Factory [T25-204-ESA]
    status      DRAFT -- this tool has NOT sent it. Open it, read it, press Send yourself.

  Everything is in:  ...\work\operations\visit-findings-...
```

The window then says `Press Enter to close this window.` — on success **and**
on failure.

### Screen 4 — a short package (the D2 defect, closed)

```
  human action required:
    the package needs 8 documents and has 7. Not calling this finished.
      - Inventory Equipment - Long Form: failed; 'Long Form' is not visible
        in the Standard ESA Reports list
```

Exit code 3. No email draft is written.

---

## 6. Expected email draft behaviour

- `<run>/email/draft.eml`, plus `<run>/email/attachments/` holding the same
  eight files, plus `HOW TO SEND.txt`.
- Subject: `TEGG ESA Report <year> - <customer> - <site> [<job number>]`.
- Body names all eight, numbered 1–8.
- All eight attached (`Content-Type: application/pdf` appears exactly 8 times
  in the message — asserted).
- `X-Unsent: 1` so Outlook opens it as a composable draft.
- **Nothing is sent.** `email_draft.py` imports no `smtplib`, `socket`,
  `requests`, `urllib`, `http`, `subprocess`, `ssl` or `win32com`, and defines
  no function whose name contains "send" — asserted by parsing the module's
  AST, not by grepping its text.
- A short package raises before a draft is composed. There is no code path
  that emails an incomplete package.

---

## 7. Expected TEGG portal changes

### By default: none beyond what was already documented

Six reports and one certificate are **rendered/generated server-side** by TEGG
and captured. This creates documents from data already there; it creates and
changes no TEGG record. The visit list's timeframe filter is a client-side view
filter. Both are reported under *external changes performed*.

### If `--create-tegg-report` is used

Two locks: the flag **and** typing exactly `CREATE THE REPORT IN TEGG` at a
prompt that first names the customer, site and visit. No Windows launcher
passes the flag. Control labels come from `service.write.create_labels`, which
**ships empty** — an armed run with no configured label escalates rather than
hunting for a button.

> ⚠️ **These selectors are unverified against the live portal.** No authorised
> live write was available. The design fails closed. **Do not enable this
> during the pilot.**

---

## 8. Verification: what is proven, and how

### Mocked verification — done on this machine

| Suite | Result |
|---|---|
| whole repository, `-m "not slow"` | **749 passed** |
| `tests/awe_tegg` | **258 passed** |
| `tests/awe_tegg/test_operator_workflow.py` | **60 passed** |
| `tests/awe_tegg/test_package_end_to_end.py` (real browser) | **12 passed** (14m 28s) |

The browser suite drives the **production** `documents.ReportRun` through the
mock and proves, on genuinely produced files:

- all six Standard ESA Reports render and export, each opening with pages;
- six distinct files, six distinct checksums, no duplicates;
- Long Form and Short Form come back as **different documents** — different
  paths, filenames, checksums, page counts and bytes;
- the Summary slot gets the EDS report and not one of the three decoy
  "…Summary" reports;
- the expand-only parent is walked to its child;
- the Certificate is fetched through the **Document Library** route
  (`/certificate-file` appears in the server's request log) and converted from
  `.doc` to PDF — **this machine has LibreOffice, so the conversion path was
  genuinely exercised**;
- the Table of Contents is copied from the shipped assets, and a missing one
  fails that slot with an actionable message;
- the full **eight**-document package reaches an email draft with eight
  attachments and eight filenames in the body;
- a refused report yields seven, fails `enforce()`, names
  *Inventory Equipment - Long Form*, and **cannot** produce a draft;
- a rerun issues **zero** further `/export` requests.

Required test coverage:

| Required test | Where |
|---|---|
| all required prompts appear | `test_every_required_prompt_is_asked` |
| blank required fields rejected | `test_blank_required_field_is_rejected_and_reasked` |
| confirm or revise intake | `test_the_operator_can_revise_one_answer_then_confirm` |
| correct visit ID reaches portal layer | `test_the_typed_visit_id_is_what_choose_visit_is_asked_for` |
| full manifest enforced | `test_a_complete_manifest_passes_enforcement` + browser |
| short package fails | `test_fewer_than_the_full_package_is_a_failed_run` (0,1,2,4,6,7) |
| **7 valid + 1 missing fails, naming the missing document** | `test_seven_valid_and_one_missing_fails_and_names_the_missing_document` — parametrised over **all eight**, so every document is checked as the missing one |
| **long/short are separate and cannot substitute** | `test_the_long_and_short_inventory_are_separate_and_cannot_substitute` + browser equivalent |
| duplicate filed as two documents | `test_the_long_and_short_inventory_...` (duplicate branch) |
| wrong report type in a slot | `test_a_document_filed_under_another_documents_name_is_caught` |
| email lists and attaches all eight | `test_the_email_draft_lists_every_filename` (updated), browser suite |
| no automatic send | `test_the_email_module_cannot_send` (AST) |
| credentials not written anywhere | 5 tests incl. AST scan of all of `src/` |
| Windows paths with spaces | `test_a_path_with_spaces_survives_the_whole_package` |
| operator cancellation exits safely | 3 tests (`C`, Ctrl-C, EOF) |
| reruns do not duplicate work | 3 tests + browser rerun test |

### ZIP inspection

Rebuilt and re-inspected: 86 entries, no caches, tests, docs, packaging,
`.venv`, `.git`, `ratecard.yaml`, `.env`, dry-run data or generated outputs.
The four new modules ship; `deliverables.py` in the ZIP has 8 `Expected(...)`
entries; the launcher says "eight documents"; `ESA Table of Contents.pdf`
ships. The shipped knowledge store was scanned by value for customer names,
site names, visit IDs, agreements and email addresses: **zero hits**.

### NOT verified — live TEGG

| Route | Live status |
|---|---|
| `Standard IR Report` | ✅ **live-proven** — exported in the 2026-07-31 run |
| `Equipment Item Problems > Exclude All Images` | ✅ **live-proven** — same run |
| `Equipment Inventory > Short Form` | ⚠️ **partially** — downloaded in the 2026-07-29 dry run by the *older* pipeline, never by `awe_tegg` |
| `Equipment Inventory > Long Form` | ❌ **failed live** — "no PDF exported" in the 2026-07-29 dry run |
| `Problem Count Summary` | ❌ **failed live** — "Print Report produced no PDF" (2026-07-29) |
| `EDS Component Problem Summary > All Problems` | ❌ **failed live** — same |
| `Document Library > Certificates` | ❌ **failed live** — produced no file (2026-07-29), never retried |
| Table of Contents (static copy) | ✅ no portal involved; copy verified locally |

**Read that table carefully.** Five of the seven portal documents have either
never been exported live by any code, or were tried once and failed. Those
failures were against the *older* `tegg` pipeline, before the agreement-
selection defect was found and fixed, so they are not evidence that the routes
are wrong — but they are not evidence that they work either.

Also unverified live: that seven fetches fit the raised budget (110 actions /
2700 s) on a slow morning — that is arithmetic, not measurement — and anything
about the TEGG record write.

### NOT verified — Windows

**No PowerShell exists on this build machine** (`pwsh` and `powershell` both
absent). `Run Report.ps1` and `TEGG-Common.ps1` were **not parsed or
executed**; changes were reviewed by reading. Setup, credential
encryption/decryption and a complete run remain unproven on Windows.

The intake wizard needs an interactive console. `Run Report.bat` →
`powershell.exe -File` inherits it, so `sys.stdin.isatty()` should be true —
**untested, and the single most likely thing to be wrong on the coworker's
PC.** If wrong, the run says so and proceeds without a draft rather than
hanging.

**LibreOffice is required** on the coworker's PC for document 2. This machine
has it, so the conversion is proven here; a Windows PC without it will stop at
seven of eight. `preflight` and `doctor` now check for it before the browser
opens.

---

## 9. Windows setup steps

1. Copy `TEGG-Report-Tool-Windows.zip` to the PC.
2. Right-click → **Properties** → tick **Unblock** → OK.
3. Right-click → **Extract All…** to e.g. `C:\TEGG-Report-Tool`. A path with
   spaces is fine and is tested.
4. **Install LibreOffice** — https://www.libreoffice.org/download — needed to
   convert the Certificate from `.doc` to PDF.
5. Double-click **`Setup.bat`**. Once per PC.
6. Double-click **`Check Setup.bat`** — expect all OK lines, including the
   Table of Contents and LibreOffice checks.

## 10. Windows test procedure

1. Double-click **`Run Report.bat`**.
2. Answer the nine questions with a real completed visit ID.
   - Press Enter on a required field → expect `! This one is needed.`
   - Type `paul-at-example` for the email → expect
     `does not look like an email address`.
3. At the confirmation screen press `2`, change the customer, confirm the
   summary updated, then `Y`.
4. Watch progress. Expect eight per-document lines during the retrieval step.
5. On completion expect Screen 3 and Explorer opening the run folder.
6. Check `documents\` holds **eight** files; open the Certificate and the two
   Inventory reports and confirm the Long and Short forms differ.
7. Open `email\draft.eml`. Outlook should show an unsent message, To: filled,
   eight attachments. **Close it. Do not send.**
8. Check `deliverables.json` shows `"complete": true`, `"produced": 8`, and a
   `page_count` on every row.
9. Press Enter to close the window.
10. **Rerun test:** run again for the same visit — already-valid documents must
    not be re-fetched.
11. **Cancel test:** run, press Ctrl-C at question 3. Expect a clean "nothing
    was done" message.

Report against `docs/PILOT_OBSERVATION.md`.

---

## 11. Remaining limitations

1. **Five of seven portal routes are unproven or previously failed live** (see
   §8 table). This is the dominant risk. If any one fails, the run correctly
   stops at seven of eight and names it — designed behaviour, but it means the
   first live run may produce no package.
2. **LibreOffice is a hard dependency** for document 2 on the operator's PC.
3. **The certificate has never been retrieved successfully live**, by any
   code, on any run.
4. **Whether the Table of Contents varies per report is unresolved** (GAPS #8).
   The same static file goes into every package.
5. **PowerShell changes are unexecuted.** No PowerShell on the build machine.
6. **The interactive-stdin assumption is untested on Windows.**
7. **TEGG write selectors are hypothetical**, and ship disabled and
   unconfigured.
8. **Retrieval budgets are reasoned, not measured.**
9. **The rate card is still a placeholder.** Every figure in `review.md` says
   so. Still blocking real pricing.
10. **The certificate's SOP edits are not applied** — its section-B checkboxes
    are Wingdings glyphs and are deliberately never ticked automatically. The
    document is carried through unedited and the job is flagged for review.
11. **No batch mode.** One visit per run.
12. **Attachment size is unbounded.** The live Standard IR Report was 1.5 MB;
    eight documents could exceed a mail server's limit. The staging folder
    covers this; nothing warns about it.

---

## 12. Recommendation

### **GO for a supervised Windows mock run — NO-GO for unsupervised customer use**

**Why GO.** Every defect the earlier run exposed has a specific, tested fix.
The one that mattered most — success reported on a partial package — is now
structurally impossible: `enforce()` runs before the email step, the email
builder calls it again itself, and it now also rejects duplicates and misfiled
documents. The contract is written down once and eight is enforced everywhere.
The full eight-document package, including a real `.doc` → PDF certificate
conversion, is proven end-to-end in a real browser. The ZIP is clean.

**Why supervised.** Five of the seven portal routes have never been proven
live, and one of them — the Certificate — failed the only time it was tried.
No PowerShell on this machine could parse the launcher. Both are the kind of
thing that is fine or obviously broken within the first few minutes, with
somebody watching.

**Conditions:**

1. Install LibreOffice first, and run `Check Setup.bat` before anything else.
2. Somebody who can read the error text present or reachable.
3. Use a real completed visit; do **not** send the draft email.
4. Do not pass `--create-tegg-report`; leave `service.write` unconfigured.
5. If it stops short of eight, that is the safety behaviour working. Capture
   which document failed and why — with five unproven routes, that is the most
   valuable output the run can produce.

**NO-GO for unsupervised use** until (a) all eight documents have been produced
against live TEGG at least twice, (b) the launcher has been run on Windows,
and (c) somebody who owns the numbers has filled in the rate card.
