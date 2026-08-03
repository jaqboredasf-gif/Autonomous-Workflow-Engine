# TEGG ESA report automation

Reads a completed TEGG site visit and tells you what needs repairing, how
urgent it is, and roughly what it involves — with every claim traceable to a
page of an inspection report you can open.

**Read-only.** It signs in, reads, and stops. It never submits a form, approves
anything, sends an email, uploads a file, or changes a TEGG record.

---

## If you are here to run it

```bash
cd ~/TEGG
export TEGG_USERNAME='your portal username'
export TEGG_PASSWORD='your portal password'

.venv/bin/awe-tegg doctor      # is this machine ready?
./scripts/visit-findings.sh    # read one site visit, ~90 seconds
```

The answer lands in `work/operations/<run id>/review/review.md`.

**→ [`docs/OPERATOR_RUNBOOK.md`](docs/OPERATOR_RUNBOOK.md) is the guide.**
Installation, credentials, choosing a visit, reading the result, exit codes,
resume, and every failure mode with the exact recovery action. Start there,
not here.

You do not need Claude Code, or any AI tool, to run this.

---

## What it produces

One Markdown page per site visit, ordered by urgency:

- every equipment problem the inspection recorded, from the **Equipment Item
  Problems Report** and the **Standard IR Report**
- the technician's own repair recommendation, **quoted verbatim** — the tool
  does not write repair advice, because a licensed person already did
- work type, urgency, and whether an outage is needed, each stating which rule
  produced it
- a rough size for the outstanding work, with every assumption listed
- a citation on every line: document, page, and the file's checksum

Everything is a **draft for a person to check**. It is not a quotation.

> **The money is not real until you make it real.** The rate card that ships is
> marked `placeholder`, so every total is stamped `NOT PRICED`. Supplying real
> rates is a deliberate act by whoever owns them — see the runbook.

## The two operations

| | |
|---|---|
| `visit-findings` | one completed site visit, read end to end. **This is the one.** |
| `documentation-read` | lists the completed site visits and stops. Useful for checking the tool can still see the portal. |

Both are live-proven against `tegg2.teggpro.com`.
[`docs/LIVE_TEST_EVIDENCE.md`](docs/LIVE_TEST_EVIDENCE.md) records the actual
runs: what each did, and what was checked against the source PDFs by hand.

## Status

**Ready for a coworker pilot.** One person can install this, run one command,
and get a reviewable result for one real site visit.

Not ready for full use, for two reasons that are not engineering problems:

1. nobody has supplied real labour and material rates;
2. it has been installed and run on one machine, by its author.

Stage by stage, what works and what does not:
[`docs/END_TO_END_GAP_REPORT.md`](docs/END_TO_END_GAP_REPORT.md).

---

## If you are here to work on it

```
src/awe_tegg/        the two operations, the retrieval boundary, the report
                     parsers, the recommendations, the estimate, the review page
src/awe_knowledge/   what the tool believes about the portal, how it earns and
                     loses trust in that, and what it refuses to write down
src/tegg/            the older manual-download pipeline and the portal driver
data/operational_knowledge/   the knowledge store, committed and reviewable
tests/               .venv/bin/python -m pytest     (about six minutes)
```

Read [`docs/KNOWLEDGE_HANDOFF.md`](docs/KNOWLEDGE_HANDOFF.md) before changing
anything under `src/awe_knowledge/` or `src/awe_tegg/`.

Two module docstrings carry load-bearing arguments and are worth reading before
touching the file: `awe_tegg/documents.py` (why the retrieval step is allowed
to click at all, and what bounds it instead) and `awe_tegg/findings.py` (why
the reports are parsed by coordinate rather than by line, and why an
unattributable tick is an error rather than a default).

### The design, in one paragraph

Where things are in the portal is **knowledge**, not configuration. It is
stored with evidence, applied exactly as written, checked against the live page
on every run, and repaired by bounded read-only discovery when it stops
holding — so a portal change produces a recorded correction rather than a
silent wrong answer. Route discovery is handed an object with no `click`,
`fill` or `submit` on it. Report retrieval must click, so instead it screens
every control it touches and refuses anything labelled with a word that means a
change.

### The older manual pipeline

`tegg` (as opposed to `awe_tegg`) builds an assembled ESA customer report from
documents downloaded by hand. It still works, it is still the only path that
attempts the full ten-section deliverable, and it has never produced a complete
one. It is not part of the coworker pilot. See §13 of the runbook, and
[`docs/SOP.md`](docs/SOP.md) for the manual procedure it automates.

## Safety, in short

| | |
|---|---|
| sign in, read pages and tables, render the two reports | yes |
| submit, approve, send, email, upload, delete, sign, invoice, mark complete | **no — refused in code, and tested** |
| store a password, cookie, token or session | **no** |
| use another contractor's knowledge | **no — refused on read** |
| contact the customer | **no** |

Credentials come from `TEGG_USERNAME` / `TEGG_PASSWORD` in your environment. No
code path reads one from a file, and a config file whose key looks like a
credential is refused rather than read.
