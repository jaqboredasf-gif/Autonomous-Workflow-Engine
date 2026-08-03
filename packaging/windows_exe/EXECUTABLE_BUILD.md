# The standalone Windows executable

**Status: written, reviewed, and never built.** Read the next section before
anything else.

---

## What is and is not true about this

PyInstaller does not cross-compile. A Windows `.exe` can only be produced on
Windows, by a Windows Python; there is no flag, no target triple and no
supported workaround. This repository is developed on macOS, so the build in
this directory has never been executed, and neither has the executable it
describes.

What has been done here:

| | |
|---|---|
| the spec file is valid Python and imports only real PyInstaller hooks | checked |
| the build script parses under the PowerShell parser | checked |
| the frozen-build path problem is fixed in the shared runtime | checked, and the fix is exercised by the normal test suite |
| the executable builds | **not done — needs Windows** |
| the executable runs | **not done — needs Windows** |
| the executable drives a browser | **not done — needs Windows** |

Nobody should tell the coworker this exists until somebody has run
"What to check the first time" below on a real PC and it passed.

**The script-based package is what ships today.** `dist/TEGG-Report-Tool-Windows.zip`
is complete, verified as far as a Mac allows, and does not depend on any of
this.

---

## The build command

On a Windows PC, from a checkout of this repository:

```
powershell -ExecutionPolicy Bypass -File "packaging\windows_exe\Build Executable.ps1"
```

That script does the whole thing: finds a Python, makes a clean build
environment in `.venv-build\` (not the developer's environment, so the
executable does not absorb whatever else is installed), installs the tool,
PyInstaller and Playwright, downloads Chromium, runs PyInstaller against
`tegg-report-tool.spec`, and copies `config\` and `data\` next to the result.

To run PyInstaller by hand instead:

```
python -m PyInstaller packaging\windows_exe\tegg-report-tool.spec --noconfirm --clean
```

---

## Where the executable ends up

```
dist\awe-tegg\awe-tegg.exe          the executable
dist\awe-tegg\_internal\            everything it carries (PyInstaller 6+)
dist\awe-tegg\config\               copied beside it, editable
dist\awe-tegg\data\                 copied beside it, written to as it learns
```

This is a **one-folder** build, not a single file, and that is deliberate:

* a one-file build extracts itself to `%TEMP%` on every launch, which adds
  seconds to start-up and is the single most reliable way to be quarantined by
  an endpoint protection product;
* the tool writes to `data\operational_knowledge` as it runs, and anything
  inside a one-file bundle is discarded when the process exits.

To distribute it, zip `dist\awe-tegg\` whole.

---

## What is included

Inside the executable:

* the Python interpreter and standard library;
* `awe_tegg`, `awe_runtime`, `awe_knowledge`, `awe_estimating`, `tegg`;
* `pypdf`, `python-docx`, `PyYAML`, `reportlab`;
* Playwright, **including its Node driver**, collected with `collect_all`.
  This is the part most likely to be got wrong: Playwright's driver is a real
  file on disk rather than an importable module, so a build that only follows
  imports produces an executable that starts cleanly and then fails the moment
  it tries to open a browser;
* `assets/static` — the two customer-instruction documents.

Beside the executable, as ordinary editable files: `config\`, `data\`.

Excluded on purpose: `tkinter`, `matplotlib`, `numpy`, `pytest`, `IPython`.
None is used, and each costs tens of megabytes.

---

## Browser automation

**The browser is not bundled, and the executable will not work without one.**

Playwright's Chromium is roughly 150 MB and lives outside the Python
package, in `%LOCALAPPDATA%\ms-playwright\`. Three ways to deal with it, in
order of preference:

1. **Use the PC's existing Chrome or Edge.** `tegg.browser.find_chromium`
   already looks in the standard Windows install locations and will use what it
   finds. Most business PCs have one. This is the reason the executable is
   worth trying at all: with it, the coworker needs nothing installed.
2. **Point at a specific binary.** Set `TEGG_CHROMIUM` to the full path of a
   `chrome.exe` or `msedge.exe`.
3. **Download Playwright's own.** Needs a Python with Playwright installed —
   which defeats the purpose of the executable, and is what the script package
   already does properly.

If you ship the executable, ship it with instructions that say which of these
applies, and confirm the first one on the target PC before assuming it.

---

## Is Python still required?

**On the PC that runs it: no.** That is the entire point.

**On the PC that builds it: yes** — Python 3.10 or newer, on Windows.

A caveat worth stating plainly: a build made on Windows 11 with Python 3.12
should run on Windows 10 1809 and later, but PyInstaller builds are not
guaranteed portable backwards across Windows versions. Build on the oldest
Windows you must support, not the newest you have.

---

## Antivirus and SmartScreen

Expect trouble, and plan for it rather than being surprised.

* **SmartScreen.** An unsigned executable downloaded from the internet gets
  "Windows protected your PC". "More info" then "Run anyway" clears it — unless
  the organisation has removed that option, in which case the coworker cannot
  proceed and IT must allow it. There is no way around this that does not
  involve a code-signing certificate.
* **Reputation.** SmartScreen's judgement is based partly on how many people
  have run that exact binary. A newly built one has no reputation, and *every
  rebuild starts again from nothing*. A signed binary accumulates reputation
  against the certificate rather than the file, which is the main practical
  argument for signing.
* **False-positive detection.** PyInstaller executables are detected as
  malware by some scanners with dispiriting regularity, because packers are
  what actual malware uses. Mitigations already applied here: UPX compression
  is **off** (it is one of the strongest triggers), and the build is one-folder
  rather than one-file (self-extracting-to-temp is another).
* **Code signing.** An Authenticode certificate from a commercial CA solves
  most of the above. It costs money and requires an organisational identity.
  Until there is one, the script-based package — which runs an operator's own
  Python and is never a novel binary — will always have an easier time getting
  past corporate controls than any executable will.

The blunt summary: **the executable is more convenient and less likely to be
allowed to run.** That is why it is second in line, not first.

---

## Known limitations

1. **Never built or tested.** Top of this document, and it governs everything
   below it.
2. **No browser is included** — see above.
3. **Antivirus and SmartScreen** — see above.
4. **64-bit only.** Nothing here is built or tested for 32-bit Windows.
5. **The one-folder layout must stay together.** Moving `awe-tegg.exe` out of
   its folder breaks it. It is not a portable single file.
6. **`config\` and `data\` must sit beside the executable.** The frozen build
   anchors its installation to the executable's own directory (see
   `awe_runtime.workspace_root`), so a build without them next to it will
   correctly refuse to start rather than guess.
7. **No credential storage.** The `.ps1` launchers are what read the Windows
   protected store and hand the sign-in over as environment variables. A bare
   executable expects `TEGG_USERNAME` and `TEGG_PASSWORD` to already be set. If
   the executable is ever adopted properly, the right shape is to keep the
   `.bat`/`.ps1` launchers exactly as they are and have them run
   `awe-tegg.exe` instead of `.venv\Scripts\awe-tegg.exe` — one line changed in
   `TEGG-Common.ps1`.
8. **Build time and size.** Several minutes, and expect 120–250 MB in
   `dist\awe-tegg\` depending on what Playwright pulls in.

---

## What to check the first time, on Windows

Do these in order. Stop at the first failure and record it; do not skip ahead.

1. `Build Executable.ps1` completes and `dist\awe-tegg\awe-tegg.exe` exists.
2. `.\awe-tegg.exe exit-codes` prints the table. (Proves the interpreter,
   the packages and the console all work. No browser, no network.)
3. `.\awe-tegg.exe doctor` — expect PROBLEM lines for the credentials, and OK
   for python, dependencies and paths. Confirm the browser line finds
   something.
4. Set `TEGG_USERNAME` and `TEGG_PASSWORD` in the shell, then
   `.\awe-tegg.exe doctor --online`. Expect exit code 0.
5. `.\awe-tegg.exe run visit-findings`. Expect a full run and a
   `review\review.md`.
6. **On a second PC that has never had Python installed**, repeat 2–5. This is
   the only step that proves the thing this executable exists for; a build that
   only works on the machine that built it has demonstrated nothing.
7. Copy it from a network share or download it, so Mark-of-the-Web applies, and
   record exactly what SmartScreen says and whether "Run anyway" is available.
8. Note the antivirus product in use and whether it interfered.

Write the results into `docs/LIVE_TEST_EVIDENCE.md`. Until step 6 passes on a
clean PC, this document's first line stands.
