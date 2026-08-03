# Coworker readiness checklist

Everything standing between the current state and a first-time coworker
operating this system on their own machine without help.

Produced 2026-08-03 by inspection and by *running the wrong commands on
purpose* — the way a first-timer will. Every finding below was reproduced, not
predicted; the evidence is quoted with each one.

**Status: P0 and P1 complete** (2026-08-03). Each item below carries its
checkboxes; done ones are ticked and annotated with the commit that did it.
P2 is outstanding.

Ordered by what stops or endangers a coworker first, not by effort.

---

## P0 — do not put this in front of a coworker until these are fixed

### P0-1 · A wrong working directory leaks real customer data and does 90 seconds of live work before failing

**Reproduced.** From `/tmp`, with credentials exported:

```
$ cd /tmp
$ /Users/jackdaly/TEGG/.venv/bin/python -m awe_tegg run visit-findings
```

The run signed into the live portal, chose visit `T26-PAUL`, retrieved two real
Crestron Electronics inspection reports, parsed them, generated
recommendations — and *then* failed:

```
status     escalated
steps      open_knowledge sign_in locate_workspace reach_documentation
           select_visit open_visit_context retrieve_documents
           extract_findings recommend_repairs
human      no rate card at config/estimating.example.yaml
```

Left behind, world-readable:

```
/tmp/work/operations/visit-findings-.../documents/
    T26-PAUL-StandardIRReport.pdf        1 532 285 bytes
    T26-PAUL-EquipmentItemProblems.pdf      75 306 bytes
```

Two separate defects meet here:

- **(a) Preflight ordering.** The rate card is validated at step 10 of 13,
  after every expensive and privacy-relevant step. It is checked by `doctor`
  but not at the *start* of the run. Everything a run needs that can be checked
  without the portal must be checked before the browser opens.
- **(b) Unanchored relative paths.** `DEFAULT_RATE_CARD`, `--work-root` and
  `--service-file` are all resolved against the current directory, with no
  check that the current directory is the repository.

The failure message names the rate card. It gives no hint that the real problem
is where the coworker was standing. They will not work this out.

- [x] Validate everything checkable — rate card, service file, writable paths,
      credentials — **before** opening a browser
- [x] Detect "not in the repository" explicitly and say so, rather than
      producing a rate-card error
- [x] Decide and document whether customer PDFs may ever be written outside the
      repository; if not, refuse

### P0-2 · `doctor` creates directories, in a command whose whole promise is that it changes nothing

**Reproduced.** Running `doctor` from `/tmp` reported:

```
writable paths
  OK       work -- writable
  OK       work/operations -- writable
  OK       data/operational_knowledge -- writable
```

It reported OK because `_writable()` calls `path.mkdir(parents=True,
exist_ok=True)` — it *made* them. Three directories appeared in `/tmp`.

The runbook tells the coworker `doctor` "changes nothing, anywhere". That is
currently untrue, and it is the first command they will run.

- [x] Probe writability without creating the tree, or create only inside a
      confirmed repository root and say so

### P0-3 · A run splits its state across two different roots

`work_root` is resolved against the current directory. The knowledge store root
is **absolute**, derived from `__file__`.

So the stray `/tmp` run wrote its ledger and its customer PDFs to `/tmp`, and
still wrote to the **real** knowledge store — the document version moved from
`v13` at the stopping point to `v19`. Half the run's state went somewhere the
coworker will never look, and the other half went somewhere they did not
intend.

- [x] One anchor for all run state. Either both roots follow the repository, or
      both follow the invocation — not one of each

### P0-4 · `docs/OPERATOR.md` sends the coworker to the wrong, unproven pipeline

It opens with:

```
.venv/bin/tegg portal list-completed          # 1. which site visits are ready
.venv/bin/tegg run --site-visit 71999         # 2. build the report
```

That is the **older** pipeline, which `END_TO_END_GAP_REPORT.md` classifies as
*partial* and which has never produced a complete report. A coworker who opens
the file called "Operator guide" runs the wrong thing, and it fails in ways
nobody has characterised.

- [x] Retire, redirect or clearly date-stamp `OPERATOR.md`; there must be
      exactly one document a coworker can open called "how do I run this"

---

## P1 — the coworker gets stuck and has to ask you

### P1-5 · `README.md`, the front door, does not mention any of this work

It never says `awe_tegg`, `visit-findings`, or `docs/OPERATOR_RUNBOOK.md`. Its
two matches for "doctor" are the *old* `tegg doctor` and a file listing. A
coworker who starts where everyone starts finds no path to the working
operation.

- [x] README leads with: what this does, the one command, and a link to
      `OPERATOR_RUNBOOK.md`

### P1-6 · Five overlapping operator documents, no signpost

`docs/` holds ten files. Five read as "how to operate this":

| file | what it is |
|---|---|
| `OPERATOR_RUNBOOK.md` | **the current one** |
| `OPERATOR.md` | the old pipeline (see P0-4) |
| `QUICKSTART.md` | the manual download workflow |
| `RUNBOOK.documentation-read.md` | one operation, superseded by the runbook |
| `SOP.md` | Paul's manual process, background not instruction |

Nothing tells a newcomer which to open, and the newest is not the
alphabetically or obviously first.

- [x] One entry point. Archive or clearly label the rest as background/history

### P1-7 · Two different `doctor` commands that check different things

`tegg doctor` checks static assets and the offline stages. `python -m awe_tegg
doctor` checks the portal path. Both exist, neither mentions the other, and the
runbook only names the second.

- [x] Merge, rename, or have each point at the other

### P1-8 · The coworker must pass `documentation-read`'s config file to `visit-findings`

`config/` holds `service.documentation-read.yaml` and no
`service.visit-findings.yaml`. The runbook duly instructs:

```
python -m awe_tegg run visit-findings --service-file config/service.documentation-read.yaml
```

The obvious guess — `config/service.visit-findings.yaml` — fails with:

```
error: [Errno 2] No such file or directory: 'config/service.visit-findings.yaml'
```

- [x] Add `config/service.visit-findings.yaml` (or a neutral
      `config/service.yaml`), and default to it so `--service-file` is optional

### P1-9 · No launcher script for the operation that matters

`scripts/documentation-read.sh` exists for the *lesser* operation. There is no
`scripts/visit-findings.sh`. The runbook's "one copy-paste start command" is a
three-line invocation with two flags.

- [x] `scripts/visit-findings.sh` — one command, correct defaults, echoes where
      the result landed

### P1-10 · No installed command; `python -m awe_tegg` only

`pyproject.toml` declares `tegg = "tegg.cli:main"` and nothing for `awe_tegg`.
Every instruction is therefore `.venv/bin/python -m awe_tegg …`, which is
long, easy to mistype, and breaks silently outside the venv:

```
$ python3 -m awe_tegg doctor
/Library/Frameworks/Python.framework/Versions/3.14/bin/python3: No module named awe_tegg
```

That message does not say "you used the wrong python".

- [x] Add an `awe-tegg` console script
- [x] Detect the wrong interpreter and say so in words

---

## P2 — friction, polish, and things that will bite later

### P2-11 · Exit code `2` means two different things

`2` is documented as "stopped and needs a person". `argparse` also returns `2`
for a usage error:

```
$ python -m awe_tegg run bogus-operation   → 2
$ python -m awe_tegg run visit-findings    → 2 (escalated)
```

Anyone scripting this cannot tell a typo from an escalation. The runbook
already carries a paragraph apologising for this, which is the wrong fix.

- [ ] Move usage errors off `2`, or move escalation off it

### P2-12 · `doctor` passes with no `--service-file`, using hard-coded defaults

Run without it, `doctor` still reports `OK lippolis/tegg-pro/production`,
because `Settings` defaults to that tenant. The service file looks required in
the runbook and is nearly decorative in practice — so a coworker who omits it
gets a green light and a run that may not be configured the way they think.

- [ ] Either require it, or state on the `doctor` output which settings are
      defaults rather than from a file

### P2-13 · `reportlab` is a dev dependency but `src/tegg/draft.py` imports it at runtime

The DRAFT watermark path imports `reportlab`. It is guarded by
`watermark_available()`, so it degrades rather than crashes — but a coworker who
installs `'.[portal]'` (as a reasonable person might) silently loses the
watermark on a document whose entire safety story is that it is watermarked.

The runbook says `'.[portal,dev]'`, which works. The packaging still says this
is a test-only dependency, and it is not.

- [ ] Move `reportlab` to a runtime extra, or make the missing-watermark case
      loud

### P2-14 · Rate-card onboarding is manual, undocumented in `doctor`, and easy to skip

Getting real money out of this needs: copy the example, edit it, flip
`placeholder: false`, and remember `--rate-card` on every run. `doctor` reports
the placeholder as `OK`. Nothing prompts the coworker to do it, and nothing
reminds them they have not.

- [ ] `doctor` should report placeholder rates as a warning, not `OK`
- [ ] Let the run pick up `config/estimating.yaml` automatically when it exists

### P2-15 · No data-retention guidance, and `work/` accumulates customer documents

`work/operations/` currently holds 19 run folders. Several contain multi-megabyte
PDFs naming real customers and sites. Nothing tells a coworker how long to keep
them, how to clear them, or that they are there at all beyond one line in the
runbook.

- [ ] A `work/` retention note and a `clean` command or documented `rm`

### P2-17 · `pytest tests/awe_tegg tests/knowledge` fails to collect

Pre-existing, and confirmed pre-existing by testing at the commit before this
work. Two `conftest.py` files are both importable as bare `conftest`, so
passing both directories in one invocation resolves the wrong one:

```
ImportError: cannot import name 'open_run' from 'conftest'
             (/Users/jackdaly/TEGG/tests/knowledge/conftest.py)
```

The documented command — plain `pytest` — is unaffected, and each directory
passes on its own (186 and 111). But a coworker debugging will type exactly
that combination.

- [ ] `--import-mode=importlib` in `pyproject.toml`, or package the test
      directories so each `conftest` resolves to its own

### P2-16 · Never installed or run anywhere but this machine

Unchanged from the stopping point and still the largest unquantified risk. The
install path, the browser discovery, the relative paths and every error message
above have been exercised on exactly one macOS machine, by the person who wrote
them.

- [ ] One clean install on a second machine, by someone else, following
      `OPERATOR_RUNBOOK.md` and nothing else
- [ ] Windows path handling in particular is entirely unverified

---

## What is already good, and should not be disturbed

Worth recording so it does not get "improved" away:

- `OPERATOR_RUNBOOK.md` is genuinely written for a non-author: prerequisites,
  exit codes, resume, failure modes with exact recovery actions, prohibited
  actions, known limitations.
- The failure messages *inside* the operation are unusually good — "the report
  form offers no agreements for this site … the search usually landed on the
  customer rather than the site" tells a coworker what to do.
- `doctor`'s output format (`OK` / `PROBLEM` + what to do) is right.
- The draft/NOT-PRICED banners are impossible to miss and appear on every path
  out, including the JSON.
- Resume is genuinely cheap and safe, and says why it did nothing.

---

## Suggested order of work

1. **P0-1 and P0-2 together** — preflight-before-browser plus a repository-root
   check fixes the leak, the litter and most of the confusion in one pass.
2. **P0-3** — one anchor for run state.
3. **P0-4, P1-5, P1-6** — the documentation pass: one front door, one runbook,
   everything else labelled as history.
4. **P1-8, P1-9, P1-10** — make the happy path one command with no flags.
5. **P2** — as time allows.
6. **P2-16** — the second machine. Do this *after* 1–4, because it is the test
   that tells you whether the rest worked.
