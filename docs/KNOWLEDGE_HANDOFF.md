# Handoff — AWE operational knowledge layer

For whoever picks this up next. Read this before touching `src/awe_knowledge/`
or `src/awe_tegg/`; it says what is real, what is not, and what to do next.

Updated 2026-07-31, **third session**. Branch `claude/tegg-agent-gaps-af4ziv`.
**Nothing has been committed** — the whole change, from all three sessions, is
in the working tree on top of `b406447`.

---

# STOPPING POINT — 2026-07-31, end of third session

The session was stopped by the operator part-way through Phase 6. Nothing was
left running. **Read this section first; the rest of the document is the
standing handoff.**

## 1. Where each phase got to

| phase | state | what was done |
|---|---|---|
| **1 — prove persistent memory** | **complete** | five live runs. Knowledge loaded and discovery skipped (`p1a`); knowledge broken on purpose → contradicted → bounded read-only rediscovery in 3 of 12 permitted actions → replacement persisted (`p1b`); an independent run reused the replacement and promoted it CANDIDATE→VERIFIED (`p1c`); resume of a finished run in 0.31 s with a byte-identical store, and resume of a `kill -9`'d run with no rediscovery (`p1d`); cross-tenant refusal with zero writes to the other tenant's history (`p1e`). Evidence: `docs/LIVE_TEST_EVIDENCE.md` Part 1. |
| **2 — full repository verification** | **complete** | full suite, focused suites, compileall, ad-hoc `ruff`, CLI smoke, credential refusals, secret scan, `git diff --check`, `git status --short`. Three real defects found and fixed (§12 below). |
| **3 — map the end-to-end operation** | **complete** | `docs/END_TO_END_GAP_REPORT.md`: 18 stages, each classified live-proven / mock-tested / partial / missing / blocked. |
| **4 — implement the vertical slice** | **complete** | new operation `visit-findings`, six new modules, four new test files, 85 new tests. |
| **5 — execute and validate live** | **complete** | full slice live-proven 13/13 in 92 s; rerun idempotency; interrupt-and-resume in 0.30 s without touching the portal; two failure paths exercised and both improved as a result. Evidence: `docs/LIVE_TEST_EVIDENCE.md` Part 2. |
| **6 — coworker handoff** | **substantially complete, stopped mid-polish** | `docs/OPERATOR_RUNBOOK.md`, `docs/LIVE_TEST_EVIDENCE.md`, `docs/END_TO_END_GAP_REPORT.md` written; this document updated; `awe_tegg doctor` implemented and live-verified. See §2 for what was left. |

## 2. What is incomplete

Nothing is half-written or in a broken state. What remains is small and named:

1. **`README.md` still describes only the old operations.** It does not mention
   `visit-findings`, `doctor`, or `docs/OPERATOR_RUNBOOK.md`. This is the single
   biggest gap for a coworker who starts at the front door.
2. **One cosmetic lint finding is unfixed and pre-existing:**
   `src/awe_tegg/discovery.py:32` imports `.guard.Budget` without using it. Not
   mine, not a defect, left alone deliberately so this session's diff stays
   about this session's work.
3. **`docs/RUNBOOK.documentation-read.md` is now the *older* of two runbooks.**
   It is still accurate for what it covers. It should probably be folded into
   `OPERATOR_RUNBOOK.md` and deleted, but that is an editorial call.
4. **No mock SSRS portal exists**, so `documents.py`'s happy path is proved
   live but not in CI. Its *refusals* and its budget are unit-tested; the
   click-path is not. Building a mock that renders an SSRS-shaped viewer is the
   obvious next test investment.
5. **Nothing is committed.** See §5.

## 3. Every file created or changed in this session

**New source (`src/awe_tegg/`):**

| file | lines | what it is |
|---|---:|---|
| `documents.py` | 502 | the SSRS retrieval route and the explicit boundary around it |
| `findings.py` | 820 | coordinate-based parsing of both reports into a versioned schema |
| `recommend.py` | 235 | grounded recommendations — the technician's words plus stated rules |
| `estimate.py` | 348 | rate-card estimate with ranges, assumptions and refusals |
| `review.py` | 291 | the Markdown page a coworker opens |
| `visit_operation.py` | 696 | the operation, the visit-selection rule, the validation |

**Modified source:**

| file | change |
|---|---|
| `src/awe_tegg/cli.py` | `visit-findings` wired into `run`/`resume`/`status`; new `doctor` command |
| `src/awe_tegg/report.py` | `render_visit()` for the new operation |
| `src/awe_tegg/checkpoint.py` | `RunLedger` now owns its step list rather than reading a module global, so two operations can share it without either loosening the other's checks |
| `src/awe_knowledge/store.py` | **`load_or_create` data-loss fix** (§12) |
| `src/awe_knowledge/models.py` | `MalformedKnowledge`; a hand-edit typo names the record instead of raising out of the enum constructor |
| `src/awe_knowledge/evidence.py` | SSO hand-off URLs added to the secret screen; `redact_sso()` |
| `src/awe_knowledge/__init__.py` | exports `MalformedKnowledge` |
| `src/tegg/sitevisit.py` | `SiteVisit.storable_url` — the token comes off at the disk boundary |
| `src/tegg/fetch.py` | writes `storable_url` into the workspace, not the raw URL |

**New config / docs:**

`config/estimating.example.yaml` (93) · `docs/OPERATOR_RUNBOOK.md` (305) ·
`docs/LIVE_TEST_EVIDENCE.md` (412) · `docs/END_TO_END_GAP_REPORT.md` (119) ·
`docs/KNOWLEDGE_HANDOFF.md` (this file, rewritten) · `.gitignore`
(ignores `config/estimating.yaml`)

**New tests:**

`tests/awe_tegg/mock_reports.py` (199, synthetic SSRS-geometry PDFs) ·
`test_findings.py` (252) · `test_recommend_estimate.py` (310) ·
`test_retrieval_bounds.py` (119)

**Modified tests:** `tests/awe_tegg/test_no_secrets_persisted.py` (+3 SSO-token
tests) · `tests/knowledge/test_store.py` (+2, one parametrised ×3)

## 4. Branch and worktree

```
branch   claude/tegg-agent-gaps-af4ziv
HEAD     b40644758090ceb8df787efc1ebfbfc0f55b397c
worktree /Users/jackdaly/TEGG   (the main checkout, not a git worktree)
```

## 5. `git status --short` and `git diff --stat`

```
 M .gitignore                          ?? docs/END_TO_END_GAP_REPORT.md
 M README.md                           ?? docs/KNOWLEDGE_HANDOFF.md
 M config/workflow.yaml                ?? docs/LIVE_TEST_EVIDENCE.md
 M docs/QUICKSTART.md                  ?? docs/OPERATIONAL_KNOWLEDGE.md
 M src/tegg/cli.py                     ?? docs/OPERATOR.md
 M src/tegg/portal.py                  ?? docs/OPERATOR_RUNBOOK.md
 M tests/mock_portal.py                ?? docs/RUNBOOK.documentation-read.md
 M tests/test_end_to_end.py            ?? scripts/documentation-read.sh
?? FINAL_HANDOFF.md                    ?? src/awe_knowledge/
?? config/estimating.example.yaml      ?? src/awe_tegg/
?? config/service.documentation-read.yaml   ?? src/tegg/{canonical,certdoc,draft,
?? data/                                        evidence,fetch,login,pipeline,
                                                sitevisit,workspace}.py
                                       ?? tests/awe_tegg/  tests/knowledge/
                                       ?? tests/{mock_documentation,mock_sitevisit}.py
                                       ?? tests/test_{canonical,certdoc,job_end_to_end,
                                            login,pipeline,sitevisit,workspace}.py
```

79 untracked paths; 108 files in the committable set.

```
 .gitignore               |  24 ++
 README.md                | 122 ++++++--
 config/workflow.yaml     |  92 ++++++-
 docs/QUICKSTART.md       |   2 +-
 src/tegg/cli.py          | 704 ++++++++++++++++++++++++++++++++++++++++++++++-
 src/tegg/portal.py       |  34 ++-
 tests/mock_portal.py     |   2 +-
 tests/test_end_to_end.py |   8 +-
 8 files changed, 937 insertions(+), 51 deletions(-)
```

`git diff --stat` shows only the *tracked* files. **The overwhelming majority of
this work — all of `src/awe_knowledge/`, all of `src/awe_tegg/`, all of
`tests/awe_tegg/` and `tests/knowledge/` — is untracked and therefore invisible
to `git diff`.** Do not judge the size of the change from that stat.

## 6. Exact test commands run, and results

| command | result |
|---|---|
| `.venv/bin/python -m pytest -q` (baseline, session start) | **471 passed**, 0 skipped, 413.28 s |
| `.venv/bin/python -m pytest -q` (after the store fix) | **475 passed**, 0 skipped, 409.43 s |
| `.venv/bin/python -m pytest -q` (after the vertical slice) | **556 passed**, 0 skipped, 370.05 s |
| `.venv/bin/python -m pytest -q` (final, after the token-fixture fix) | **556 passed**, 0 skipped, 360.26 s |
| `.venv/bin/python -m pytest tests/knowledge -q --durations=5` | 107 passed, 18.08 s |
| `.venv/bin/python -m pytest tests/awe_tegg -q --durations=8` | 90 → **171 passed**, 125.22 s |
| `.venv/bin/python -m pytest tests/awe_tegg/test_findings.py -q` | 18 passed, 0.15 s |
| `.venv/bin/python -m pytest tests/awe_tegg/test_recommend_estimate.py -q` | 30 passed, 0.18 s |
| `.venv/bin/python -m pytest tests/awe_tegg/test_retrieval_bounds.py -q` | 30 passed, 0.02 s |
| `.venv/bin/python -m pytest tests/awe_tegg/test_no_secrets_persisted.py -q` | 11 passed, 15.96 s |
| `.venv/bin/python -m pytest tests/knowledge/test_store.py -q` | 18 passed, 0.17 s |

**Nothing failed at the end. Nothing was skipped.** Failures that occurred
during the session (`test_the_time_budget_stops_a_hang`, and two live runs) are
described in §12; all were fixed and re-run green.

Note for the next session: `tests/awe_tegg/test_retrieval_bounds.py` ran 30
tests here but 29 at first — the count moved when the parametrised
forbidden-word list grew. That is expected, not drift.

## 7. Latest verification sweep

Run immediately before stopping:

| check | result |
|---|---|
| `.venv/bin/python -m pytest -q` | 556 passed, 0 failed, 0 skipped, 360.26 s |
| `.venv/bin/python -m compileall -q src tests scripts` | exit 0 |
| `.venv/bin/python -m ruff check --select F,E9 --no-fix src` | **1 finding**, pre-existing: `discovery.py:32 F401 .guard.Budget imported but unused` |
| `git diff --check` | exit 0 |
| `git diff --cached --check` | exit 0 |
| `git status --short` | unchanged from session start except this session's own files |
| secret scan, whole worktree by value (765 files) | 9 hits, **all in gitignored paths** (`.claude/worktrees/`, `TEGG-DRYRUN/`, `test-data/`), username only, no password anywhere |
| secret scan, committable set (108 files) | see §13 |

No linter or type checker is configured in `pyproject.toml`. `ruff` was
installed into `.venv` ad hoc for these passes and is **not** a project
dependency — it is not in `pyproject.toml` and does not need to be installed to
run anything.

## 8. Running or interrupted processes

**None.** Verified before stopping:

* no background shell jobs;
* `pgrep -fl "playwright|chromium|Google Chrome for Testing"` returns nothing —
  no browser was left open;
* the last long-running command (the full test suite) exited 0 and was reaped;
* no `Workflow`, agent, cron or scheduled task was created at any point.

## 9. Live portal state and partially completed operations

**Nothing is pending at TEGG and nothing was mutated.** Every live run reached
a terminal state.

Ledgers under `work/operations/` (gitignored, machine-local):

```
completed   live-1 … live-6              documentation-read   7/7   (previous session)
completed   p1a-known-knowledge          documentation-read   7/7
completed   p1b-forced-stale             documentation-read   7/7
completed   p1c-reuse-repaired           documentation-read   7/7
completed   p1d-interrupted              documentation-read   7/7   (kill -9, then resumed)
escalated   p1e-cross-tenant             documentation-read   3/7   (deliberate refusal)
escalated   p2-corrupt, p2-corrupt2/3    documentation-read   3/7   (deliberate corruption)
failed      p2-corrupt-fixed             documentation-read   0/7   (deliberate; proves the fix)
escalated   p2-nocreds                   documentation-read   0/7   (deliberate)
completed   p5a-visit-findings           visit-findings      13/13
completed   p5c-interrupted              visit-findings      13/13  (kill -9, then resumed)
completed   p5e-no-agreement             visit-findings      13/13  (clean-visit path)
```

The `escalated` and `failed` runs are **intended outcomes of negative tests**,
not unfinished work. None of them needs resuming.

Two things a next session should know about local state:

* **`data/operational_knowledge/…/knowledge.json` was written by live runs.**
  It is untracked but *committable* (not gitignored) and now records executions
  `p1a` and, via the earlier session, `live-1`…`live-6`. It contains no
  credential and no token — checked (§13).
* **Two real customer PDFs are cached at `work/samples/`** (Atlas-Capital / The
  Factory, T25-204). They were used to develop the parser. `work/` is
  gitignored. Delete them if you would rather they were not on the disk:
  `rm -rf work/samples`.

## 10. Exact commands to resume safely

```bash
cd ~/TEGG

# 1. credentials, in this terminal only (never in a file)
export TEGG_USERNAME='...'
export TEGG_PASSWORD='...'

# 2. confirm the machine and the repo are as they were left
.venv/bin/python -m awe_tegg doctor --service-file config/service.documentation-read.yaml
git status --short
git rev-parse --short HEAD        # expect b406447

# 3. confirm the suite is still green (about 6 minutes)
.venv/bin/python -m pytest -q     # expect: 556 passed
```

Nothing needs to be resumed, re-run or cleaned up before starting work. If you
want to see the slice work without touching the portal, the last run's output
is already on disk:

```bash
open work/operations/p5a-visit-findings/review/review.md
```

To do a fresh live run (about 90 s, read-only):

```bash
.venv/bin/python -m awe_tegg run visit-findings \
  --service-file config/service.documentation-read.yaml \
  --site-visit T25-204
```

## 11. The next single task

**Update `README.md` so it describes `visit-findings`, `doctor`, and
`docs/OPERATOR_RUNBOOK.md`.**

It is the front door and it currently sends a reader to the old operations
only. It is a documentation-only change, needs no portal access and no
credentials, and it is the last thing standing between the current state and a
coworker being able to find the runbook unaided.

After that, in order: (a) a second operator on a second machine running
`OPERATOR_RUNBOOK.md` cold — this is the real remaining risk; (b) somebody who
owns the numbers filling in `config/estimating.yaml`; (c) a mock SSRS portal so
`documents.py`'s click-path is covered in CI.

## 12. Blockers, failures, assumptions and unsafe conditions

### Genuine blockers — not solvable from here

1. **The estimate has no real rates.** `config/estimating.example.yaml` is
   marked `placeholder: true`. Whoever owns the numbers has to supply them.
   Until then every total is stamped `NOT PRICED` and the output says the money
   is not real on its first screen. This is by design and must not be "fixed"
   by inventing rates.
2. **Nobody but the author has run any of this.** Every claim in this
   repository was proved by the person who wrote it.
3. **Some site visits have no agreements published to the reporting module**
   (`T26-170` behaved this way on one search path). The run detects it and
   stops with an explanation, but cannot resolve it.

### Failures during the session — all fixed, all re-run green

1. **`load_or_create` destroyed a knowledge store.** Any load failure except
   `TenantMismatch` was answered with a fresh empty document, which the run then
   saved over the real one. Observed: 15 records / 117 456 bytes → 284 bytes,
   from a one-character corruption. Fixed: the only reason to start an empty
   document is that no file exists. Regression test parametrised over corrupt
   record / future schema / another tenant.
2. **The run ledger persisted live SSO session tokens** for all 121 visits,
   under the innocent key `url`. Fixed in two independent places (redaction at
   the boundary, refusal in the secret screen) so removing either fails a test.
3. **`RetrievalBudget`'s time limit could never fire** — `0.0` doubled as "not
   started". Found by a fake-clock test; invisible with a real `monotonic()`.
4. **Two live-run bugs**, both fixed: `context.on("download", list.append)`
   raised because a builtin method has no `__dict__`; and the SSRS viewer
   detection matched a stale viewer left over from the previous report, which
   is how one run exported an Arc Flash inventory and would have called it a
   problems report.

### Assumptions a next session should be able to challenge

* **The checkbox geometry rule** — an `X` ticks the label 3–30 points to its
  right, within 5 points vertically — is measured from live output on one
  contractor's reports. If SSRS is upgraded or another contractor's template
  differs, this is the first thing to re-measure. An unclaimed tick already
  fails loudly rather than guessing, which is the safety net.
* **`Equipment Item Problems → Exclude All Images`** is chosen because it
  carries the same problem records at a fraction of the size and render time.
  If images ever matter, the sibling children are `Include All Images` and
  `Include Primary Images Only`.
* **The visit-selection rule** (most recent completed visit with an agreement,
  a site and an identifier; ties on identifier) is a defensible default, not a
  business decision. A coworker may well want a different one.
* **"Rendering a report is a read"** is the load-bearing claim behind
  `documents.py` being allowed to click at all. It is argued in that module's
  docstring. If anybody disagrees with it, that is the conversation to have —
  not a code change.

### Unsafe conditions

**None outstanding.** Specifically: no browser is running, no operation is
mid-flight, no TEGG record was created or changed, nothing was sent to a
customer, nothing was committed or pushed, and no scheduled or background task
was created.

One standing item, unchanged from the previous session and still the repository
owner's call: **the live portal username remains in git history** at
`HEAD:docs/QUICKSTART.md` and `HEAD:tests/mock_portal.py`, and on
`origin/worktree-tegg-mock-sprint` at `f64b3db` and `b76b1dc`. The password was
never committed. Cleaning this needs a history rewrite and a force-push, and
was not attempted.

## 13. Credential and token confirmation

Scanned **by value** against the live environment variables, plus by pattern
for session tokens, over the 108 files in the committable set (tracked +
untracked-not-ignored):

| | |
|---|---|
| `TEGG_USERNAME` value in committable source, fixtures, docs or config | **none** |
| `TEGG_PASSWORD` value anywhere in the worktree at all | **none** |
| live SSO session token in committable files | **none** |
| `knowledge.json` / `history.jsonl` (committable) | clean — the only `/auth/gsso/` occurrence is a descriptive sentence in a record's prose, with no token |
| run ledgers, evidence, screenshots, review output | under `work/`, gitignored, and screened by `reject_secrets` on every write |

Two pattern hits remain in the committable set, both in
`tests/awe_tegg/test_no_secrets_persisted.py`, and both are **deliberately
synthetic**:

```
/gsso/104/TEGGProExample595/...
0F1E2D3C4B5A69788796A5B4C3D2E1F00F1E2D3C4B5A69788796A5B4C3D2E1F0
```

The fixture originally carried a **real** token copied from live run output.
That was caught by the final sweep and replaced; the real value
(`E9853546…`) now appears in nothing git would ship. The fixture's comment
says why it must stay synthetic.

The 9 username occurrences elsewhere in the worktree are all in gitignored
paths — `.claude/worktrees/`, `TEGG-DRYRUN/`, `test-data/` — and were present
before this session.

---

## What the third session changed

Read [`END_TO_END_GAP_REPORT.md`](END_TO_END_GAP_REPORT.md) for the stage-by-
stage picture and [`LIVE_TEST_EVIDENCE.md`](LIVE_TEST_EVIDENCE.md) for the runs
behind every claim. In short:

**A second operation, `visit-findings`, is live-proven end to end.** It reads
one completed site visit, retrieves its Standard IR Report and Equipment Item
Problems Report from TEGG, extracts the equipment problems, carries the
technician's own repair recommendations through with citations, sizes the
outstanding work against a rate card, validates the result and writes a
Markdown page a coworker can review. 13 steps, ~92 s, read-only. Operators:
[`OPERATOR_RUNBOOK.md`](OPERATOR_RUNBOOK.md).

**Both reports exported successfully for the first time.** The previous handoff
recorded all four non-inventory reports as "never got a working export
attempt … status unknown, not failed". They now work, via the inline-response
capture that was reference-implementation-only, ported into
`src/awe_tegg/documents.py`. Two things the earlier attempts got wrong and this
one does not: *Equipment Item Problems* is a **parent** entry whose children are
the image modes — clicking the parent only expands it, and an earlier run
exported an Arc Flash inventory believing it was a problems report — and the
search typeahead must select the **site**, not the customer, or the agreement
list comes back empty and the export "succeeds" with one blank page.

**The relocated-area repair happened live.** The handoff below lists it as
covered by tests but never seen live (limit 6). It has now happened: a run
whose only navigation knowledge pointed at a route that does not exist
contradicted it, rediscovered `/sales/documentation` from the portal's own
navigation in 3 of 12 permitted actions, stored the replacement with
provenance, and a later independent run reused it.

**Three defects were found by testing and fixed**, in descending order of how
much they would have cost:

1. `KnowledgeStore.load_or_create` answered *any* load failure except
   `TenantMismatch` with a fresh empty document — so a corrupt or newer-schema
   file was replaced and then **overwritten**. Observed destroying a 15-record
   store (117 456 bytes → 284) from a one-character corruption. Now: the only
   reason to start an empty document is that no file exists.
2. The run ledger persisted **live single-sign-on tokens**. Every site-visit row
   links out through `remote.teggpro.com/auth/gsso/…/<64 hex>/…` and that hex
   signs the holder in; it arrived under the innocent key `url` and was written
   to disk for all 121 visits. Now redacted at the boundary *and* refused by the
   secret screen, so removing either fails a test.
3. `RetrievalBudget`'s time limit could never fire, because `0.0` was doing
   double duty as "not started".

**Tests: 556 pass, none skipped, 370 s.** Up from 471.

**A `doctor` command** checks python, dependencies, a launchable browser,
credentials, writable paths, the knowledge store, the rate card and — with
`--online` — that the portal answers. It signs in to nothing and prints no
secret.

---

## What exists and is proven

A deterministic, versioned, evidence-backed knowledge layer with the full loop
closed, plus one bounded operation an operator can start on their own that
spends it:

```
live run -> evidence -> observation -> validation -> approval -> storage
                                                                    |
        outcome <- applied by a later run <- retrieved <------------+
                        |
                        +-> contradicted by the live portal
                               -> demoted -> bounded read-only discovery
                               -> replacement + provenance -> supersession
                               -> retrieved by the next run -> reused
```

The second branch was added and proved live in the second session; the third
session proved it again against a route that genuinely did not exist.

### The knowledge layer — `src/awe_knowledge/`

- `models.py` — schema, trust levels, record and document types, lifecycle
- `evidence.py` — secret screening, redaction, provenance, evidence building
- `promotion.py` — the trust state machine
- `lifecycle.py` — contradiction, approval, supersession, expiry
- `store.py` — atomic JSON writes, append-only JSONL history, tenant boundary
- `validator.py` — well-formedness, safety, staleness
- `runtime.py` — `KnowledgeRun`: open, retrieve, resolve, **contradict**,
  **replace**, measure, close
- `adapters/tegg_portal.py` — TEGG observation files in, records out
- `adapters/tegg_login.py` — spends stored selectors on a live sign-in
- `cli.py` — `tegg knowledge <command>`

### The operations — `src/awe_tegg/`

`documentation-read`, added in the second session — seven steps, read-only:

```
sign in -> locate the workspace -> reach Documentation -> verify the page
        -> list the records -> finish -> return a result
```

- `guard.py` — the read-only boundary. `ReadOnlyPage` exposes four verbs;
  every mutating Playwright method raises `MutationRefused`. Probes come from
  a frozen catalogue, not arbitrary JavaScript. `Budget` caps actions, seconds
  and hosts.
- `markers.py` — what proves a page is the Documentation area: it says the
  word, it shows at least two of the area's own labels, and it carries a table
  headed the way that area's table is headed. All three, or no verdict.
- `discovery.py` — bounded route discovery over **live navigation only**.
- `checkpoint.py` — the durable run ledger; a step is written the moment it is
  verified, atomically, screened for secrets.
- `operation.py` — the operation, and the retrieve / apply / contradict /
  discover / replace sequence.
- `report.py` — the ten lines an operator reads.
- `cli.py`, `__main__.py` — `python -m awe_tegg`.

`visit-findings`, added in the third session, is described at the top of
this document and in [`OPERATOR_RUNBOOK.md`](OPERATOR_RUNBOOK.md).

**556 tests pass, none skipped**, in about six minutes. Run them with
`.venv/bin/python -m pytest`.

---

## The navigation repair — 2026-07-31

### What was actually wrong

The previous handoff recorded this as "`/sales/documentation` no longer opens
the Documentation area". **That diagnosis was wrong, and it is worth saying so
plainly.** A read-only live probe established the truth:

```
t=     0ms  url=/sales/documentation  textlen=    0  tables=0 links=0
t=  1012ms  url=/sales/documentation  textlen=    0  tables=0 links=0
t=  2018ms  url=/sales/documentation  textlen= 2138  tables=8 links=197
```

The route is alive. It renders about two seconds after a hard navigation,
because the portal is an Angular application and a `goto` tears the shell down
and rebuilds it.

Two defects met:

1. **In the driver.** `Explorer.open_documentation` judged the route at
   `domcontentloaded` with `_looks_like_documentation()`, which reads the body
   text. At that instant the body is empty, so a live route was declared dead.
2. **In the fallback.** It then searched that same still-blank page for a link
   labelled "Documentation". There were zero links on it. And even on a
   rendered page it would have struggled: the live sidebar entry is an icon
   with the text inside a nested `<span>` and no accessible name on the anchor.

3. **In the knowledge, which is the part that matters here.**
   `navigation:documentation-area` was VERIFIED by three executions and carried
   this:

   ```json
   { "starting_state": "signed in, on the dashboard",
     "actions": ["open the Documentation area"],
     "expected_result": "the site-visit list is on screen",
     "url": "https://tegg2.teggpro.com/sales/documentation" }
   ```

   An English sentence for an expected result, no page markers, and no notion
   that arriving takes time. A run applying it faithfully has no way to tell
   "not there" from "not there *yet*". The URL was right and the record was
   still useless.

### What the repair is

Not a `sleep`. The route, the *time it takes to become real*, and the *markers
that prove it* are now knowledge, discovered live and stored with provenance:

```
procedure:documentation-read.reach-documentation
  steps:      goto -> settle until page_markers (budget 20 000 ms) -> verify
  route:      /sales/documentation
  markers:    text_all_of ["documentation"]
              text_any_of ["document library", "choose timeframe",
                           "site visits", "site forms", "attach images"]  (>= 2)
              table_headers_any_of ["customer","site name","status",
                                    "agreement"]                          (>= 2)
  observed_settle_ms: 1500
  supersedes: navigation:documentation-area
  provenance: execution id, time, tenant, marker verdict, every candidate
              weighed, the discovery budget spent, the screenshot kept
```

The driver was **not** patched to wait. Fixing it there would have made the
stale record appear to work and buried the real defect — knowledge that cannot
be checked. `apply_navigation` performs a record's own steps and nothing more,
so a record with no settle step still gets none, and still contradicts.

### Old and new record identities

| | before | after |
|---|---|---|
| `navigation:documentation-area` | VERIFIED, v5, 3 runs | **INVALID**, v7, superseded |
| `procedure:documentation-read.reach-documentation` | did not exist | **VERIFIED**, v3, 6 runs |

The old record is kept, not deleted. `superseded_by` and `supersedes` link the
two in both directions, and `history.jsonl` holds every step of the change.

---

## Proven live — six runs against `tegg2.teggpro.com`

Read-only throughout. Nothing was submitted, downloaded, or changed.

| run | knowledge applied | outcome |
|---|---|---|
| `live-1` | `navigation:documentation-area` v5 VERIFIED | contradicted → DEGRADED → discovery (3 navigations) → replacement created CANDIDATE → **121 records** |
| `live-2` | `procedure:…reach-documentation` v2 CANDIDATE | reused, no discovery, no contradiction → 121 records; second distinct execution promotes it to **VERIFIED** |
| `live-3` | `procedure:…` v3 VERIFIED | reused → 121 records |
| `live-4` | `procedure:…` v3 VERIFIED | **`kill -9` after `verify_documentation`**, then `resume` → completed 7/7, no rediscovery |
| `live-3` (again) | — | resume of a finished run: 0.12 s, no browser, no portal traffic, no store write |
| `live-6` | `procedure:…` v3 VERIFIED | via `./scripts/documentation-read.sh` → 121 records |

`live-1`'s operator output, verbatim:

```
stale knowledge detected
    navigation:documentation-area  v5  VERIFIED -> DEGRADED
    why: the record carries no settle step and no page markers, so it was
         applied and judged exactly as written

corrected knowledge created
    procedure:documentation-read.reach-documentation  v2  (CANDIDATE)
        supersedes navigation:documentation-area
```

`live-2`, the run that matters:

```
knowledge used
    procedure:documentation-read.reach-documentation  v2  (CANDIDATE)
stale knowledge detected
    none -- everything the run believed still held
corrected knowledge created
    none -- nothing needed correcting
```

Store state after all six:

```
VERIFIED   auth:contractor-selection                         v5  ok=11  runs=11
VERIFIED   auth:portal-login                                 v8  ok=6   runs=3
VERIFIED   auth:portal-login-form                            v5  ok=3   runs=3
INVALID    navigation:documentation-area                     v7  ok=3 fail=1 runs=0
                                    -> superseded by procedure:documentation-read…
VERIFIED   procedure:documentation-read.reach-documentation  v3  ok=6   runs=6
                                    (supersedes navigation:documentation-area)
VERIFIED   selector:login.username | .password | .submit     v5  ok=11  runs=11
CANDIDATE  navigation:open-site-visit | …-actions | …-documentation | …-documents
… document v12, 0 pending, `tegg knowledge validate` -> ok
   (one warning, which is the point: navigation:documentation-area is INVALID
    and will not be used)
```

The version of the replacement stays at v3 across runs 3–6 on purpose: a record
that is already VERIFIED is confirmed, not re-promoted, so `success_count` and
`verified_by_runs` grow while `version` does not.

---

## The twelve required proofs, and where each is checked

| # | proof | where |
|---|---|---|
| 1 | dead navigation knowledge is detected as contradicted | `test_contradiction.py::test_stale_navigation_knowledge_is_applied_as_written_and_fails`, `…is_recorded_with_structure_not_a_log_line` |
| 2 | contradicted knowledge is not reinforced | `…test_contradicted_knowledge_is_demoted_and_never_reinforced`, `…test_the_dead_step_is_attempted_exactly_once` |
| 3 | bounded discovery cannot perform mutations | `test_discovery_bounds.py::test_every_mutating_verb_is_refused` (parametrised over all 30), `…_probe_catalogue_contains_nothing…`, `…changes_nothing` (asserted from the server's side) |
| 4 | a new route requires verified page markers | `test_supersession.py::test_a_replacement_is_only_created_from_a_marker_verified_route`, `test_no_replacement_is_written_when_nothing_verified` |
| 5 | the replacement preserves provenance | `…test_the_replacement_preserves_provenance_from_the_live_run`, `…survives_a_round_trip_through_the_store` |
| 6 | the stale procedure is superseded correctly | `…test_the_stale_record_is_superseded_not_deleted`, `…can_never_be_applied_again`, `…starts_as_a_hypothesis` |
| 7 | a fresh run retrieves the replacement | `test_reuse.py::test_the_first_run_repairs_and_the_second_reuses`; live `live-2` |
| 8 | the fresh run reaches Documentation without rediscovery | same test — asserted from the mock server's request log (one dashboard fetch, one route fetch); live `live-2` |
| 9 | the run resumes after interruption | `test_resume.py` (5 tests); live `live-4`, killed with `kill -9` |
| 10 | cross-tenant knowledge cannot be applied | `test_tenant_isolation.py` (5 tests) |
| 11 | credentials and sessions cannot be persisted | `test_no_secrets_persisted.py` (8 tests) — every byte of a completed run scanned by value |
| 12 | unknown portal states escalate honestly | `test_discovery_bounds.py::test_discovery_escalates_when_the_area_is_gone`, `…reports_what_it_dropped_when_the_budget_runs_out` |

`tests/mock_documentation.py` is the stand-in portal these run against. It
reproduces the three properties that caused the live failure: the area renders
late, its navigation link has no visible text, and it can be moved. Every
non-login POST/PUT/DELETE it receives is recorded, so "read-only" is checked
from the server's side rather than from the client's intentions.

---

## Two bugs found and fixed on the way

1. **`KnowledgeStore.load_or_create` swallowed `TenantMismatch`.** `TenantMismatch`
   subclasses `KnowledgeError`, and `load_or_create` caught the base class. A
   document sitting in one tenant's directory but belonging to another was
   therefore replaced by a fresh empty one — and the run's own save would then
   **overwrite that tenant's records**. Now re-raised. Found by writing proof
   10; covered by `test_a_mislabelled_document_is_refused_rather_than_replaced`.

2. **`contradicted()` reported the post-demotion version.** The contradiction
   evidence named v6 for a record that was v5 when it was applied. What is
   contradicted is the version that ran. Fixed by capturing it first.

---

## Security state

- **No credential is in any source file, fixture, doc, knowledge record, run
  ledger, screenshot or page capture.** Checked by *value* against the live
  environment variables over the whole worktree (567 files) and over
  `git diff HEAD` plus every untracked file.
- The only occurrences of the username inside the git-visible diff are
  **deletion lines** — the previous session's redaction of a pre-existing leak.
- Credentials are read from `TEGG_USERNAME` / `TEGG_PASSWORD` at the moment
  they are typed into the sign-in form. The ledger records the *names* of those
  variables and nothing else.
- `RunLedger.save` runs `reject_secrets` over the payload before writing and
  raises rather than writing. A refused write leaves the previous ledger intact.
- A service file carrying anything named like a credential is refused rather
  than read, so pasting a password into `config/service.*.yaml` cannot be made
  to work.
- **Still not fixed, still the repository owner's call:** the live portal
  username remains in git history at `HEAD:docs/QUICKSTART.md` and
  `HEAD:tests/mock_portal.py`, and on `origin/worktree-tegg-mock-sprint` at
  `f64b3db` and `b76b1dc`. The password was never committed. Cleaning this
  needs a history rewrite and a force-push.
- Remaining working-tree copies are all in gitignored paths: `test-data/`,
  `.claude/worktrees/`, `TEGG-DRYRUN/`.

---

## What is NOT proven

Said plainly rather than left to be inferred. Items 1 and 6 were written in the
second session and are **now out of date** — they are kept, struck through,
because what replaced them is the point.

1. ~~**One operation, not a workflow.**~~ **Superseded.** There are now two
   operations, and `visit-findings` goes from sign-in to a reviewable
   recommendation and estimate, live-proven. What remains unproven from the
   original list: the certificate (download produced no file in the 2026-07-29
   dry run and has not been retried; filling it is not implemented), the other
   five reports, and the full 10-section assembled ESA report. See
   [`END_TO_END_GAP_REPORT.md`](END_TO_END_GAP_REPORT.md).
2. **Selector fallbacks are still a schema field, not a mechanism.** Records
   carry `fallbacks: []` and nothing populates or tries them. Repair means
   rediscovery.
3. **`preflight_selectors` still has no caller.**
4. **No integration with the wider AWE runtime** at
   `~/Autonomous-Workflow-Engine`. Nothing over there calls this.
5. **The knowing sign-in is still not faster in wall-clock**, only in guessing.
   Four locator resolutions cost more round trips than one `page.evaluate`.
   Resolving all four in one round trip is a measurement task, not a redesign,
   and it is not done.
6. ~~**Discovery has only ever repaired one kind of thing.**~~ **Superseded.**
   A genuinely relocated area — a route that does not exist, not a render race —
   was repaired live on 2026-07-31 in 3 of 12 permitted actions, and the
   replacement was reused by a later independent run. Evidence: run `p1b`/`p1c`
   in [`LIVE_TEST_EVIDENCE.md`](LIVE_TEST_EVIDENCE.md).
7. **`documentation_path` still sits in `config/workflow.yaml`** and is still
   read by the older `tegg portal` commands. `awe_tegg` deliberately does not
   read it. Two sources of truth for the same fact is a trap; the config one
   should go once nothing else needs it.

---

## Running it

Operators: **`docs/OPERATOR_RUNBOOK.md`**, which covers both operations.
`docs/RUNBOOK.documentation-read.md` is the older, single-operation copy and is
still accurate for what it describes. The short form:

```bash
export TEGG_USERNAME='...' TEGG_PASSWORD='...'     # typed, never in a file
cd ~/TEGG
.venv/bin/python -m awe_tegg doctor --service-file config/service.documentation-read.yaml
.venv/bin/python -m awe_tegg run visit-findings --service-file config/service.documentation-read.yaml
```

The older list-only operation, and its wrapper script:

```bash
.venv/bin/python -m awe_tegg preflight --service-file config/service.documentation-read.yaml
./scripts/documentation-read.sh
```

Exit `0` finished, `1` could not continue, `2` needs a person.

Interrupted:

```bash
.venv/bin/python -m awe_tegg status
.venv/bin/python -m awe_tegg resume --run-id <run id>
```

Inspecting what the system believes:

```bash
.venv/bin/tegg knowledge inspect
.venv/bin/tegg knowledge degraded          # the work queue
.venv/bin/tegg knowledge changes --limit 3
```

Rebuilding the seeded records from the 2026-07-30 evidence under `work/`
(gitignored) still works, and still produces the *old* navigation record — it
is the live runs above that correct it:

```bash
rm -rf data/operational_knowledge
for d in work/evidence-list work/live-run/evidence-list work/exploration; do
  tegg knowledge ingest --observations "$d/observations.json"
done
```

---

## The next slice

Item 3 below was the second session's next step and is done. The rest stand,
and item 1 has only got more important now that there is something worth
handing over.

1. **A second operator, on a second machine, running the runbook cold.** Every
   claim in this repository was proved by the person who wrote it. That is
   still the weakest thing about this handoff, and it is now the only thing
   between "pilot" and "use".
2. **Somebody who owns the numbers fills in `config/estimating.yaml`** and sets
   `placeholder: false`. Until then the estimate is a shape, every total is
   stamped `NOT PRICED`, and no amount of engineering changes that.
3. ~~Extend the same shape one step further — open one site visit and verify
   its context by markers.~~ **Done, and further:** `visit-findings` opens the
   visit's site context, retrieves both inspection reports, and produces a
   reviewable recommendation and estimate.
4. **Retire `documentation_path` from `config/workflow.yaml`**, and point the
   older `tegg portal` commands at the same knowledge `awe_tegg` uses. Until
   then two things can disagree about where Documentation is.
5. **Make `documentation-read`'s resume skip its durable steps.**
   `RunLedger.resume_point()` exists and nothing calls it, so that operation's
   resume re-reads all 121 records. `visit-findings` does skip, by checksum —
   the same shape would work there.
6. **Make the knowing sign-in actually faster**, so the wall clock stops
   contradicting the story.

## Where the design is written down

- `docs/OPERATIONAL_KNOWLEDGE.md` — the trust model, the refusals, the storage
  format, the commands, and how to capture TEGG lessons without credentials.
- `docs/OPERATOR_RUNBOOK.md` — the operator's copy, both operations.
- `docs/END_TO_END_GAP_REPORT.md` — every stage, classified honestly.
- `docs/LIVE_TEST_EVIDENCE.md` — the runs behind every claim made here.
- `docs/RUNBOOK.documentation-read.md` — the older single-operation runbook.

## The new modules, and what each is for

- `src/awe_tegg/documents.py` — the SSRS retrieval route, and the explicit
  boundary around it. Read its module docstring before changing anything in it:
  it is the only part of this system that clicks, and it explains why it cannot
  use `guard.ReadOnlyPage` and what it does instead.
- `src/awe_tegg/findings.py` — reads the two reports by **coordinate**, not by
  line. An SSRS tick is a separate text run positioned left of its label, and
  reading the page as a stream of lines attaches it to the wrong box without
  producing any error. An unclaimed tick makes the page untrustworthy rather
  than half-read.
- `src/awe_tegg/recommend.py` — carries the technician's words through and
  derives only what a stated rule or arithmetic supports.
- `src/awe_tegg/estimate.py` — three refusals: no rate compiled in, no single
  number, no silent gaps.
- `src/awe_tegg/review.py` — the page a coworker opens.
- `src/awe_tegg/visit_operation.py` — the operation, the visit-selection rule,
  and the validation.
