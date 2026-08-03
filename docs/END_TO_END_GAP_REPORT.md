# End-to-end gap report

The intended coworker outcome, stage by stage, with each stage classified by
what is actually true of it rather than by what exists in the repository.

Updated 2026-07-31. Branch `claude/tegg-agent-gaps-af4ziv`, working tree on
`b406447`. Evidence for every "live-proven" below is in
[`LIVE_TEST_EVIDENCE.md`](LIVE_TEST_EVIDENCE.md).

## What the coworker is actually trying to do

Read one completed TEGG site visit and come away with: **which equipment
problems are outstanding, what each needs, how urgent it is, and roughly how
big the job is** — with every claim traceable to a page of an inspection report
they can open, and nothing sent anywhere.

That is now one command. What it does *not* yet cover is at the bottom.

## Classification

| | |
|---|---|
| **live-proven** | implemented, and run against the live portal with the result checked against its source |
| **mock-tested** | implemented, and tested only against a mock or a fixture |
| **partial** | implemented for the path that was needed, with known cases it does not handle |
| **missing** | not implemented |
| **blocked** | cannot be done from here; an external dependency decides |

## The pipeline

| # | stage | state | evidence / what is missing |
|--:|---|---|---|
| 1 | TEGG sign-in | **live-proven** | every run below; selectors come from stored knowledge, ~750 ms |
| 2 | confirm the contractor workspace | **live-proven** | refuses to read if the page never names `Lippolis`; proved by the cross-tenant run |
| 3 | reach the Documentation area | **live-proven** | `procedure:documentation-read.reach-documentation v3`, applied, verified by page markers, and repaired live when broken on purpose |
| 4 | list completed site visits | **live-proven** | 121 records across 20 pages |
| 5 | choose exactly one visit, deterministically | **live-proven** | a stated rule, printed with the choice; `--site-visit` overrides; ambiguity is an error, never a guess |
| 6 | put the portal in that site's context | **live-proven** | typeahead search, site entry rather than customer entry; a context with no agreements is detected and stopped |
| 7 | reach the report list | **live-proven** | Reports → Standard ESA Reports |
| 8 | retrieve the **Standard IR Report** | **live-proven** | 773 899 bytes in 17.2 s, captured as an inline SSRS response. **First successful export of this report by this repository.** |
| 9 | retrieve the **Equipment Item Problems Report** | **live-proven** | 99 223 bytes in 17.7 s. Reached through its parent entry and the *Exclude All Images* child — clicking the parent alone only expands it, which is how an earlier attempt exported an Arc Flash inventory and called it a problems report |
| 10 | extract equipment issues into a versioned schema | **live-proven** | 13 findings from a real visit, checked page by page against the PDF; schema v1 with per-finding source, page and document sha256 |
| 11 | corroborate with the infrared measurement | **live-proven** | ΔT matched to tags, graded against the report's own printed bands; a tag with no sheet gets no reading, and an IR report about different equipment is flagged rather than silently ignored |
| 12 | generate bounded repair recommendations | **live-proven** | the technician's own words, verbatim, plus derived work type, urgency and outage — each stating which rule fired |
| 13 | generate an explainable estimate | **live-proven, deliberately unpriced** | hours, materials, low/expected/high and every assumption, from a rate card. The card that ships is a placeholder and every total is stamped `NOT PRICED`. **Nobody has supplied real rates.** |
| 14 | validate the result | **live-proven** | fatal checks (counts match, every line cited, ranges ordered, placeholder rates cannot be presented as priced) and advisory ones carried into the output |
| 15 | produce a coworker-reviewable output | **live-proven** | `review/review.md` and `review.json`, draft-banner first |
| 16 | stop before any submission or mutation | **live-proven** | see the refusals below |
| 17 | safe resume and idempotent rerun | **live-proven** | interrupted with `os._exit(9)` and resumed in 0.30 s without touching the portal; rerunning a finished run is a no-op |
| 18 | persistent memory across sessions | **live-proven** | knowledge broken on purpose → contradicted → bounded rediscovery → persisted → reused by an independent run → promoted |

## Refusals, and how each is enforced

| | how |
|---|---|
| route discovery cannot act on the portal | the object it is given has four verbs; all 30 mutating Playwright methods raise. Probes come from a frozen catalogue, not arbitrary JavaScript |
| report retrieval cannot touch a control that changes something | every label screened against `save, submit, approve, send, email, delete, remove, complete, sign, upload, publish, invoice, mark as`; 15 labels tested |
| no credential reaches disk | the ledger records the *names* of the environment variables; every payload is screened by value before writing and the write raises rather than proceeding |
| no session token reaches disk | SSO hand-off URLs are redacted at the boundary **and** refused by the screen |
| no other contractor's knowledge is spent | enforced on read, by tenant / integration / environment; a mislabelled document is refused rather than replaced |
| retrieval cannot run away | 40 actions, 900 s, one host; the full trail is in the ledger |

## The one thing that touches TEGG at all

Rendering a report. TEGG has no download endpoint: it builds the PDF through
SQL Server Reporting Services and the sequence requires typing into a search
box, clicking two tabs, selecting a report, setting the form's own dropdowns,
and clicking *Print Report* then *Export*.

This is a read — the document is built from data that is already there, and no
TEGG record is created, changed, submitted or sent — but it is **not** a read
that can be made structurally impossible to misuse the way route discovery can.
It is bounded by an explicit permitted-control list, a forbidden-word screen,
and an action and time budget, all of which are tested. That is as strong as
this route allows, and it is written down rather than assumed.

The only other write is the visit list's timeframe filter, which is a
client-side view filter the portal does not keep. Both are reported in every
run's output under *external changes performed*.

## What is still missing

| | state | note |
|---|---|---|
| the other five TEGG reports (Problem Count Summary, EDS Component Problem Summary, Equipment Inventory short/long, Oil Analysis) | **missing** | the route is the same; only the leaf label and the parser differ |
| assembling the full 10-section ESA customer report | **partial** | `tegg run --site-visit` assembles and watermarks whatever exists, and has never produced a complete one |
| the certificate: download, and filling its fields | **partial / missing** | download produced no file in the 2026-07-29 dry run and has not been retried. Filling it is not implemented; its section-B checkboxes are Wingdings glyphs and are deliberately never ticked automatically |
| real labour and material rates | **blocked — needs a person** | the estimate is a shape until whoever owns the numbers fills in `config/estimating.yaml` and sets `placeholder: false`. No amount of engineering substitutes for this |
| priced bill of materials | **missing** | the technician quotes part numbers (`FRN-R-200`, `TR400R`, `CEFCON CRN-R-400`); nothing prices them |
| batch — many visits in one run | **missing** | one visit per run, on purpose for now |
| application-version boundary on knowledge | **missing** | commit and version are recorded as provenance; nothing invalidates knowledge when either changes |
| selector fallbacks | **missing** | records carry `fallbacks: []` and nothing populates or tries them. Repair means rediscovery |
| `preflight_selectors` | **missing** | still has no caller |
| `documentation_path` in `config/workflow.yaml` | **partial** | still read by the older `tegg portal` commands. `awe_tegg` deliberately ignores it, so two things can disagree about where Documentation is |
| resume that skips durable steps in `documentation-read` | **partial** | `RunLedger.resume_point()` exists and nothing calls it, so a `documentation-read` resume re-reads the list. `visit-findings` does skip its expensive step, by checksum |
| integration with the wider AWE runtime | **missing** | nothing at `~/Autonomous-Workflow-Engine` calls any of this |
| **a second operator, on a second machine, cold** | **not done** | every claim in this repository was proved by the person who wrote it. This is the weakest thing about the whole handoff |

## Verdict

**READY FOR COWORKER PILOT.**

A coworker can install this, run one command, and get a reviewable result for
one real site visit, with every claim traceable to a page they can open,
failures that say what to do, and a resume that costs nothing. That is the bar
for a pilot and it is met.

It is **not** ready for full use, for two reasons that are not engineering
problems:

1. **The estimate has no real rates in it.** Until somebody who owns the
   numbers fills in the rate card, the money is illustrative and the tool says
   so on every path out.
2. **Nobody but its author has ever run it.** The runbook has not survived
   contact with a second machine.

The next thing worth doing is not another feature. It is watching one coworker
follow `OPERATOR_RUNBOOK.md` on their own laptop, and fixing whatever they trip
over.

---

## Open questions only a person can answer

Carried forward from the original `docs/GAPS.md`, which this document replaces.
These are not engineering tasks. Each needs a decision or a fact from the
business, and each blocks something real.

### 1. What is the shared drive, actually?

The Google Drive connector returns nothing for "TEGG" — `TEGG T SharedDrive` is
not visible to it. It may be a Shared Drive rather than My Drive, on a
different account, or a Windows file share and not Google Drive at all.

The code sidesteps this: `--drive-root` takes any mounted path, so it works
against a mapped network drive, a synced folder or a local directory without
caring which. But the **final save step cannot be trusted** until somebody
confirms what the destination is.

### 2. Automation is running as a named human account

The credentials in use are Paul's own login. Three problems, in order of how
much they will hurt:

1. **Audit trail** — every automated action looks like Paul did it by hand.
2. **Fragility** — it breaks the next time he changes his password.
3. **Blast radius** — the credential ends up wherever the automation runs.

Those credentials were also pasted into a chat window at some point and should
be **treated as exposed and rotated**.

**Recommended:** a dedicated service account from the TEGG Pro vendor, scoped
to report generation. Until then, credentials come from `TEGG_USERNAME` /
`TEGG_PASSWORD` in the environment and no code path reads one from a file.

### 3. The output filename separator is a guess

The SOP writes the final name as `"Company Name""Site Name""Year" ESA
Report.pdf`. The quotes are placeholder markers, so the real separator is
unknown — spaces, underscores or nothing. Currently single spaces, set by
`assembly.output_template` in `config/workflow.yaml`.

**Ask Paul:** one real filename settles it.

### 4. Do the two static documents vary by job?

`ESA Table of Contents.pdf` and `TEGGPro View Customer Instructions.pdf` are
assumed identical for every customer and are kept in `assets/static/` rather
than pulled from the portal. If the table of contents varies by report length
it has to be generated, not stored.

### 5. Where should this run, and what triggers it?

Three options with real tradeoffs:

| | |
|---|---|
| Paul's workstation, run by hand | simplest, no infrastructure — but only helps when he runs it |
| a shared VM, run on demand | anyone can trigger it; needs the service account and the drive sorted first |
| fully scheduled | highest leverage, but something has to decide *which* visits are ready |

**The question that decides it:** how does Paul know today that a site visit is
ready to be reported on? Nothing in the SOP describes that judgement, and
without it full scheduling is not possible.

### Deliberately out of scope

- quality-checking report *contents* — the automation reproduces the manual
  output faithfully, including any upstream data problems
- emailing or delivering the finished report to a customer
- backfilling historical reports
