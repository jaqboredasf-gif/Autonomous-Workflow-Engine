# Live test evidence — 2026-07-31

Every run below was executed against the live portal at `tegg2.teggpro.com`
with real credentials in the environment. Read-only throughout: nothing was
submitted, approved, sent, uploaded, deleted or marked complete, and no TEGG
record was changed.

Branch `claude/tegg-agent-gaps-af4ziv`, working tree on top of `b406447`.

Run folders are under `work/operations/<run id>/` and are gitignored — they
name real customers and sites.

---

## Part 1 — persistent memory across sessions

The claim being tested is not "the tool remembers". It is the whole loop:
knowledge is retrieved, spent, contradicted by the live portal when it stops
holding, repaired inside a bounded read-only budget, persisted, and then
**used by a later independent run**.

Runs `p1b`–`p1e` execute against a **copy** of the knowledge store under
`/tmp`, pointed at by `store_root` in a scratch service file, so breaking
knowledge on purpose cannot damage the real store. `p1a` runs against the real
one.

### p1a — knowledge is loaded and discovery is skipped

```
.venv/bin/python -m awe_tegg run documentation-read \
  --service-file config/service.documentation-read.yaml --run-id p1a-known-knowledge
```

`exit 0`, 46.4 s, 121 records read from 20 pages.

```
knowledge used
    procedure:documentation-read.reach-documentation  v3  (VERIFIED)
stale knowledge detected
    none -- everything the run believed still held
corrected knowledge created
    none -- nothing needed correcting
```

`state.json` has **no `discovery` key** and no contradictions: the stored route
was applied, the page markers held, and nothing was worked out again.

### p1b — invalid knowledge triggers bounded rediscovery

The store copy was altered to reproduce a **genuinely relocated area**, which
the previous handoff listed as tested only against a mock:

* `procedure:documentation-read.reach-documentation` — **removed**
* `navigation:documentation-area` — restored from its own `previous_good`
  (VERIFIED, v5, vouched for by 3 executions), with its route changed to
  `/sales/documentation-archive`, which does not exist

`exit 0`, 47.1 s, 121 records.

```
knowledge used
    navigation:documentation-area  v5  (VERIFIED)
stale knowledge detected
    navigation:documentation-area  v5  VERIFIED -> DEGRADED
    why: the record carries no settle step and no page markers, so it was
         applied and judged exactly as written
corrected knowledge created
    procedure:documentation-read.reach-documentation  v2  (CANDIDATE)
        supersedes navigation:documentation-area
```

The discovery, from the ledger — bounded, read-only, and sourced from the
portal's own live navigation rather than from the record:

```
ok            True
route         /sales/documentation
settle_ms     1500
budget        spent_actions 3 of 12   elapsed 8.28 s of 120 s
              hosts ['tegg2.teggpro.com']
trail         goto /sales/documentation-archive
              goto /sales/gm-dashboard
              goto /sales/documentation
candidates    [{url: .../sales/documentation, source: 'link',
                tried: True, verified: True}]
reason        /sales/documentation showed every Documentation marker
              1500 ms after loading
contradiction record_id navigation:documentation-area
              believed_version 5   VERIFIED -> DEGRADED
              field expected_result
              believed 'the site-visit list is on screen'
```

### p1c — the repaired knowledge is reused by an independent run

Same store copy, a new execution:

`exit 0`, 46.4 s, 121 records.

```
knowledge used
    procedure:documentation-read.reach-documentation  v2  (CANDIDATE)
stale knowledge detected   none
corrected knowledge created   none
```

`state.json` for this run has **no `discovery` key** and zero contradictions:
the replacement was retrieved and spent, and nothing was rediscovered. The
knowledge report shows the promotion the reuse earned:

```
{"record_id": "procedure:documentation-read.reach-documentation",
 "before": "CANDIDATE", "after": "VERIFIED",
 "reason": "2 distinct executions succeeded", "execution_id": "p1c-reuse-repaired"}
```

Store state after `p1a`–`p1c`:

```
INVALID    navigation:documentation-area                     v7  ok=3 fail=1 runs=0
                                    -> superseded by procedure:documentation-read…
VERIFIED   procedure:documentation-read.reach-documentation  v3  ok=2  runs=2
```

### p1d — idempotent behaviour, two ways

**Resuming a finished run.** `resume --run-id p1c-reuse-repaired`: `exit 0`,
**0.31 s**, no browser, no portal traffic. The knowledge document is
**byte-identical** before and after (`diff -q` reports no difference), and the
ledger records `resume asked for a run that was already complete; nothing
re-run`.

**Resuming an interrupted run.** A run was killed with `os._exit(9)` — the
process-level equivalent of `kill -9` — immediately after
`verify_documentation` was checkpointed. `status` then reported `5/7` steps.
`resume` completed it: `exit 0`, 7/7, 121 records, **no rediscovery and no
contradiction**, using `procedure:…reach-documentation v3 (VERIFIED)`.

### p1e — the tenant / integration / environment boundary

A live run as tenant `acme-hvac` against the same store:

`exit 2`, escalated at 3/7 steps.

```
human action required
    no usable navigation knowledge exists for this tenant. Run
    'tegg knowledge inspect' and seed it from a live run first.
```

It signed in and confirmed the workspace, then **refused to spend Lippolis's
navigation knowledge** and read nothing from the Documentation area.
`history.jsonl` for `lippolis` contains **zero** entries for execution
`p1e-cross-tenant`; the run created a separate, empty `acme-hvac/` document.

The full boundary matrix, read directly from the store:

```
lippolis/tegg-pro/production   -> 15 record(s)
lippolis/tegg-pro/staging      -> REFUSED: no knowledge for this environment
lippolis/other-portal/production -> REFUSED: no knowledge for this integration
acme-hvac/tegg-pro/production  -> 0 record(s)   (its own slot, empty)
mislabelled document           -> REFUSED: TenantMismatch: ...knowledge.json holds
                                  lippolis/tegg-pro/production, not acme-hvac/...
```

### Honest limit on this section

**Application version is recorded but not enforced.** Every piece of evidence
carries the `commit` and the package version that produced it, and those travel
with the record — but nothing invalidates or partitions knowledge when the
application or the portal changes version. Tenant, integration and environment
are boundaries; application version is provenance only.

---

## Part 2 — the end-to-end operation, live

### p5a — one completed site visit, read end to end

```
.venv/bin/python -m awe_tegg run visit-findings \
  --service-file config/service.documentation-read.yaml \
  --site-visit T25-204 --run-id p5a-visit-findings
```

`exit 0`, **92 s**, 13/13 steps.

```
open_knowledge  sign_in  locate_workspace  reach_documentation  select_visit
open_visit_context  retrieve_documents  extract_findings  recommend_repairs
build_estimate  validate_result  publish_review  finish
```

Knowledge used: `procedure:documentation-read.reach-documentation v3
(VERIFIED)` — the same repaired record from Part 1, reused by a different
operation.

Documents retrieved live, both as inline SSRS responses:

| report | bytes | seconds |
|---|---:|---:|
| Standard IR Report | 773 899 | 17.2 |
| Equipment Item Problems (Exclude All Images) | 99 223 | 17.7 |

**This is the first time either report has been exported successfully by this
repository.** The previous handoff recorded all four non-inventory reports as
"never got a working export attempt … status unknown, not failed".

Result, verified against the source PDFs by hand:

* 13 problems read, one per page of the Equipment Item Problems Report
* all 13 marked **Estimate Required** by the technician
* 4 not corrected during the visit; all 4 graded `high` because the report ticks
  a fire or safety consequence
* 3 sized; 1 not sized, because the report ticks neither *Repair Equipment* nor
  *Replace Equipment* and the scope is therefore undecided
* thermal readings attached to 6 findings by tag `03322`
  (ΔT 7.8 °C → the report's own **Alert** band, 4.1–8.0 °C)
* `USD 4,048 – 9,852` for the priced items, stamped **NOT PRICED** because the
  rate card is the shipped placeholder

Spot-checks against the PDFs:

| claim | source | checked |
|---|---|---|
| tag `03303`, *Individual Disconnect Switch*, Replace Equipment ticked | EIP p.1 | ✓ |
| its consequences: Fire Hazard, Safety Hazard, Power/Business Interruption; **not** Equipment Failure | EIP p.1 | ✓ |
| tag `03321` p.4 ticks neither repair box | EIP p.4 | ✓ |
| its repair text ends "…to facilitate safe cover removal" | EIP p.4 | ✓ (the continuation is on the far side of a section heading) |
| tag `03322` ΔT 7.8 °C, Alert band 4.1C–8.0C | IR p.2A | ✓ |

### p5c — interrupt and resume

A live run killed with `os._exit(9)` the instant `retrieve_documents` finished.
`status` reported `running`, 7/13 steps, with both PDFs and their checksums
recorded.

`resume --run-id p5c-interrupted`: `exit 0`, **0.30 s**, 13/13.

```
notes
    both reports were already retrieved by this run and their checksums still
    match, so the portal was not asked for them again
```

No browser was launched, no sign-in happened, and TEGG was not touched. The
check is by **checksum**, not by existence — a file that changed underneath is
not the file the ledger is describing, and is re-fetched.

### p5b — rerunning a finished run

`resume --run-id p5a-visit-findings`: `exit 0`, **0.14 s**, `resumes: 0`,
`review.md` byte-identical (`md5` unchanged). Nothing re-read, nothing
rewritten.

### p5e — a failure path, and what it turned out to be

`--site-visit T26-170` (New York College of Podiatric Medicine).

First attempt: `exit 1`. Both reports came back, the Equipment Item Problems
Report was **883 bytes and one blank page**, and the parser refused it:

```
T26-170-EquipmentItemProblems.pdf carries no page headed 'Equipment Item
Problems Report'. It is not the Equipment Item Problems Report, or the export
produced an empty one -- check the Agreement was set before Print Report.
```

Investigating the PDFs showed the refusal was right to stop but wrong about
why: the agreement **was** set (`STD11741671GM-06/26-01`, recorded in the
ledger), the IR report rendered 2 pages — a cover and a summary page with
column headings and **no rows** — and the problems report was genuinely empty.
**This visit recorded no equipment problems.**

That is a real answer, and a useful one, so the code now distinguishes it:

* a blank problems report raises `EmptyReport`, not `FindingsError`;
* it is **only believed when the IR report agrees** — a blank problems report
  alongside an IR report that does list faults is treated as a retrieval that
  went wrong, and neither is trusted;
* the review page then leads with *Nothing to quote* and cites both documents.

Re-run: `exit 0`, 13/13, `review.md` reading:

> **This site visit recorded no equipment problems.** Both reports were
> retrieved and both are empty of findings, so there is no repair work to
> price.

A second failure path — a site whose report form offers **no agreements at
all** — is now caught at the parameter step with an explanation, rather than
five steps later as an unreadable PDF.

### Confirmation that nothing was mutated

* Every control the retrieval step touches is screened; anything labelled
  `save`, `submit`, `approve`, `send`, `email`, `delete`, `remove`, `complete`,
  `sign`, `upload`, `publish`, `invoice`, `mark as` raises `ActionRefused`.
  15 such labels are tested.
* The only writes are: the report form's own dropdowns (agreement, order by,
  images) and the visit list's timeframe filter. The portal keeps neither. Both
  are reported in every run's output.
* Route discovery is handed a `ReadOnlyPage` with four verbs; all 30 mutating
  Playwright methods raise `MutationRefused`.
* Retrieval spent **13 actions of 40** and well under its 900 s budget; the
  full trail is in each run's `state.json`.

---

## Part 3 — defects found and fixed while testing

### A knowledge document that is there but unreadable was replaced by an empty one

`KnowledgeStore.load_or_create` created a fresh empty document whenever loading
raised anything except `TenantMismatch`. So a document written by a newer
schema, or one a hand-edit had corrupted, was answered with an empty document —
and the run's own save then **overwrote every record in it**.

Observed, not theorised: a store copy carrying 15 records (117 456 bytes) was
reduced to an empty document (284 bytes) by a single run against a
one-character corruption.

Fixed: the one and only reason to start an empty document is that **no file
exists**. Every other failure is refused. Re-tested on a fresh corrupt copy —
the run fails cleanly, names the record and the field, and the 15-record
document is byte-identical afterwards:

```
record 'navigation:site-visit-list' in the knowledge document for
lippolis/tegg-pro/production cannot be read: ValueError: 'verified' is not a
valid TrustLevel
```

Covered by `test_a_document_that_is_there_but_unreadable_is_never_replaced`,
parametrised over corrupt record / future schema / another tenant.

### The run ledger persisted live single-sign-on tokens

Every site-visit row links out through
`remote.teggpro.com/auth/gsso/…/<64 hex>/…`, and that hex is a **live session
token** — whoever holds the URL is signed in as the account that produced it.
The listing captured it under the innocent key `url` and the ledger wrote it to
disk for all 121 visits.

Fixed in two places, so removing either one fails a test:

* `SiteVisit.to_dict` redacts it — the live URL stays in memory, because a run
  has to be able to follow it, and the stored form keeps only the host:
  `<sso hand-off to remote.teggpro.com; token not recorded>`;
* the secret screen now refuses any payload containing such a URL, so a ledger
  save carrying one **raises rather than writing**, leaving the previous ledger
  intact.

### A corrupt knowledge file produced a raw traceback

`TrustLevel('verified')` raised `ValueError` out of the enum constructor three
frames down. `knowledge.json` is meant to be read and argued with by people, so
a typo in it now comes back as a sentence naming the record and the fault.

### A time budget that could never fire

`RetrievalBudget.started` used `0.0` as its "not started" sentinel, so a clock
reading zero restarted the window on every action. Changed to `None`. Found by
a test using a fake clock — with a real `time.monotonic()` it would have been
invisible until it mattered.

---

## Part 4 — full verification

| command | result |
|---|---|
| `.venv/bin/python -m pytest -q` | **556 passed, 0 failed, 0 skipped, 370.05 s** |
| `.venv/bin/python -m pytest tests/knowledge -q` | 107 passed, 18.08 s |
| `.venv/bin/python -m pytest tests/awe_tegg -q` | 90 passed → now 152, 166 s |
| `.venv/bin/python -m compileall -q src tests scripts` | exit 0 |
| `.venv/bin/python -m ruff check --select F,E9 src tests scripts` | 7 findings, all `F401` unused imports in test files; no undefined names, no syntax faults |
| `git diff --check` / `git diff --cached --check` | exit 0, no whitespace errors |
| secret scan by value over the worktree | 643 files scanned; 9 hits, **all in gitignored paths** (`.claude/worktrees/`, `TEGG-DRYRUN/`, `test-data/`); no password hit anywhere |
| secret scan over what git would ship | 94 files, **clean** |

No linter or type checker is configured in `pyproject.toml`; `ruff` was
installed ad hoc for the pass above and is not a project dependency. Its
default ruleset reports 271 findings, of which 87 are `RUF100` (unused `noqa`)
and 75 are `BLE001` (broad `except`, used deliberately throughout the portal
drivers). Only the 7 above are substantive, and none is a defect.

### Credential refusals

| what | result |
|---|---|
| `doctor` / `preflight` with no credentials | `exit 1`, both named `MISSING`, values never read |
| `run` with no credentials | `exit 2`, escalates **before opening a browser** |
| a service file carrying `password:` | refused on both `preflight` (`exit 1`) and `run` (`exit 2`) |

### CLI smoke

| command | exit |
|---|---|
| `awe_tegg --help` | 0 |
| `awe_tegg doctor --online` | 0 |
| `awe_tegg status` | 0 |
| `awe_tegg run bogus-operation` | 2 (argparse usage) |
| `awe_tegg resume --run-id does-not-exist` | 1, `no run ledger at …` |
| `tegg knowledge validate` | 0, `ok` with one warning |

### Git

`git status --short` is unchanged from the start of the session apart from the
files this work created or edited. **Note for whoever reads this next: none of
this is committed.** Everything, including the previous session's work, is in
the working tree on `claude/tegg-agent-gaps-af4ziv` on top of `b406447`.
