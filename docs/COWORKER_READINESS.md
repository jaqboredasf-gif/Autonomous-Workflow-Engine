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

**Attempted and reverted:** `--import-mode=importlib` does not fix this. Both
suites share helpers via `from conftest import ...`, which importlib mode does
not support — it trades one collection error for two.

- [ ] Move the shared helpers into uniquely-named modules
      (`tests/awe_tegg/tegg_helpers.py`, `tests/knowledge/knowledge_helpers.py`)
      and import those instead of `conftest`. About ten mechanical edits.
      Deliberately deferred: it is a maintainer papercut, not a coworker one,
      and `pytest` alone is unaffected.

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

---

# Founder-assumption audit — 2026-08-03

Every place a successful run depended on something that existed only in the
founder's head. Each one is now encoded, or has a stated reason why it cannot
be. The test applied throughout: *if the only person who knows this leaves,
does a run still succeed — and does a wrong answer still get caught?*

## Encoded into code, by removing the assumption

### F-1 · Agreement numbers were recognised by three observed prefixes

The report form's agreement dropdown was identified by
`o.startswith(("STD", "DES", "PRM"))` — three prefixes seen in one
contractor's data. A fourth prefix, or a different contractor, and the branch
is never entered: the agreement is never set, and the run then reports

> the report form did not offer agreement STD88117209SM-05/25-01

which is **false**, and sends the reader to the portal instead of to that
tuple. A stale founder assumption producing a confident wrong diagnosis is the
worst shape this debt takes.

**Encoded by deletion.** The agreement is now selected by matching *the value
the run came for*, which cannot be wrong about whether it is present. A shape
pattern survives only to recognise the list when our agreement is absent, so
the error can quote what *was* offered — and if that pattern is wrong the run
still fails safely, just less specifically.

## Encoded into configuration, with the defaults named as unconfirmed

### F-2 · Three business judgements were compiled into Python

Which consequences make an item a **safety** matter; which severities are
urgent **on their own**; what wording means the work needs an **outage**.
All three were tuples in `recommend.py`, inferred by reading live reports, and
changing any of them meant editing code.

They are now `policy:` in `config/service.yaml` — commented out, documented
with the full set of values the report can actually contain, and defaulting to
the previous behaviour.

The part that matters: **every review page now prints which rules were in
force and where they came from**, and while nobody has confirmed them it says
so in those words:

```
- safety consequences: Fire Hazard, Safety Hazard
- urgent on severity alone: Critical, Severe
- source: built-in defaults (nobody has confirmed these)
```

A reader who disagrees can now see what to change. Before, they would have had
to notice the grading was wrong and then go looking in Python for why.

### F-3 · Which two reports, and which variant of one of them

That `Equipment Item Problems` is a parent whose real report is the
`Exclude All Images` child — and that clicking the parent alone exports
whatever form is showing — is knowledge that cost a wrong export to learn.
Encoded as named constants with the reasoning in the module docstring, and
pinned by a test that asserts the path is two hops.

## Encoded into validation, because documentation would not have caught it

### F-4 · The checkbox geometry

That an SSRS tick sits 15–20 points left of its label was measured, once, from
one contractor's reports. It is the single most load-bearing measurement in the
system: get it wrong and the tool reports "no fire hazard" with total
confidence.

It could not be made a fact, so it was made **falsifiable**. A tick no label
claims, or a label two ticks claim, marks that page untrustworthy and it
reaches the coworker flagged rather than silently half-read. The founder
assumption is still there — it is now impossible for it to fail quietly.

### F-5 · That the exported report is the one that was asked for

A blank Equipment Item Problems report is believed to mean "a clean visit"
**only when the IR report agrees**. If one is empty and the other lists faults,
neither is trusted. That check exists because the alternative was trusting the
founder's judgement about which empty PDFs are real.

## Encoded into documentation

### F-6 · Who this is configured to act as

`contractor = "Lippolis"` and `TENANT = "lippolis"` remain as defaults in
Python. They are overridable from the service file and always were — but
nothing told the operator which identity was in force, so a coworker at a
second contractor would have had no signal they were running as somebody else.

`doctor` now names it, first, before anything else:

```
who this is configured to act as
  OK  Lippolis at https://tegg2.teggpro.com -- tenant lippolis/tegg-pro/production,
      from /Users/jackdaly/TEGG/config/service.yaml
```

and says explicitly when there is no service file and the values are "whoever
the code was written for".

### F-7 · The manual process itself

`docs/SOP.md` is Paul's own procedure and is the only record of how this work
is done by hand. It is kept, banner-labelled as background rather than
instructions, and every stage in it names what is and is not automated. Losing
it would mean losing the definition of correct.

## Cannot yet be encoded — and why

These are the ones where writing something down would be pretending. Each is
in `END_TO_END_GAP_REPORT.md` under *Open questions only a person can answer*.

| assumption | why it cannot be encoded yet |
|---|---|
| **labour rates, hours and material allowances** | Nobody has supplied them. The shape is encoded and validated; the numbers are a commercial decision. Until then every total is stamped `NOT PRICED` — the tool refuses to imply it knows. |
| **how you know a site visit is ready to report on** | This is the trigger the whole automation would hang off, and it is a judgement Paul makes that nothing in the SOP describes. Until it is articulated, scheduling is not possible and the tool reads visits on demand only. |
| **what the shared drive actually is** | The destination for finished reports is unidentified — Shared Drive, different account, or a Windows file share. `--drive-root` takes any mounted path so the code does not care, but the final save step cannot be trusted until somebody says what it is. |
| **the output filename separator** | The SOP writes it with placeholder quote marks. One real filename settles it. Currently single spaces, in `config/workflow.yaml`, where it is at least visible. |
| **whether the two static documents vary by job** | Assumed identical for every customer and kept in `assets/static/`. If the table of contents varies with report length it has to be generated. Nobody has checked. |
| **that the automation may run as a named human account** | It currently runs as Paul's personal login: every automated action looks like he did it by hand, it breaks when he changes his password, and those credentials should be treated as exposed and rotated. A service account is a request to the vendor, not a code change. |

## What remains founder-shaped, and is acceptable

Two things, recorded so nobody mistakes them for oversights:

1. **The knowledge store was seeded by one account against one portal.** That
   is what it is for — it is evidence of what *this* portal did — and it
   carries provenance for every record. A second contractor gets their own
   tenant, empty, and seeds it from their own runs. The boundary is enforced
   on read and tested.
2. **The visit-selection rule** is a defensible default, not a business
   decision. It is stated in the runbook, printed with every run's choice, and
   overridable per run with `--site-visit`. If it is wrong for somebody, they
   will see it is wrong, which is the property that matters.

## The test that has not been run

**Nobody but the author has installed or run this.** Every claim above was
verified by the person who wrote it. That is itself the largest founder
dependency in the repository, and no amount of documentation removes it — only
a second person on a second machine does.
