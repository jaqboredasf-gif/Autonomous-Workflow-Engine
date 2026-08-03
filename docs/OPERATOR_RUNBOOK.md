# Operator runbook

Two operations. Both read TEGG and stop. Neither submits a form, approves
anything, sends an email, uploads a file, or changes a single TEGG record.

| operation | what you get |
|---|---|
| `visit-findings` | **one completed site visit, read end to end**: its two inspection reports, the equipment problems in them, what the technician recommended, a rough size for the outstanding work, and a Markdown page you can review |
| `documentation-read` | the list of completed site visits, and nothing else |

Start with `visit-findings`. `documentation-read` exists because it was proved
first and is a useful way to check the tool can still see the portal.

You do not need Claude Code, or any AI tool, to run either of these.

---

## 1. Prerequisites

* macOS, Linux or Windows
* Python **3.10 or newer** (`python3 --version`)
* Chrome or Chromium — the tool will install one if you have none
* Network access to `tegg2.teggpro.com` and `tegg.teggpro.com`
* A TEGG portal account for the **Lippolis** contractor workspace

## 2. Installation, once per machine

```bash
cd ~/TEGG
python3 -m venv .venv
.venv/bin/pip install -e '.[portal,dev]'
.venv/bin/python -m playwright install chromium
```

That gives you `.venv/bin/awe-tegg`. Every command below uses the full path to
it on purpose: typing plain `awe-tegg` runs whichever one is on your `PATH`,
and if the virtual environment is not active there is none, and you get

```
command not found: awe-tegg
```

`.venv/bin/python -m awe_tegg …` is the same program if you prefer it.

## 3. Credentials — never stored, never in a file

Type them into your terminal. Do not put them in a file, do not paste them into
a chat window, and do not add them to a script.

```bash
export TEGG_USERNAME='your portal username'
export TEGG_PASSWORD='your portal password'
```

They live in that terminal window only. Open a new window and you type them
again — that is deliberate.

The tool reads these two variables at the moment it types them into the sign-in
form. It records **the names** of the variables in its log and never the
values. A file under `config/` whose key looks like a credential — `password`,
`secret`, `token`, `credential`, `cookie` — is **refused rather than read**, so
pasting a password into one cannot be made to work.

## 4. Check the machine is ready

```bash
cd ~/TEGG
.venv/bin/awe-tegg doctor
```

Every line is `OK`, `WARN` or `PROBLEM`. Only `PROBLEM` stops you. A `WARN` is
something worth knowing — most often that your rate card is still the shipped
placeholder, so the estimate will run but the money will not be real.

Add `--online` to also check the portal answers. That check sends no
credentials and does not sign in — it asks for the public sign-in page, exactly
as a browser would before anybody types anything.

`doctor` changes nothing, anywhere: it does not sign in, does not send a
credential, and does not create so much as a directory.

## 5. The one command

```bash
cd ~/TEGG
./scripts/visit-findings.sh
```

It takes about **90 seconds**. Add `--headed` to watch the browser do it.

The script runs from the installation whatever directory you were standing in,
picks up your rate card if you have made one, and turns the exit code into a
sentence. The long form is the same thing:

```bash
.venv/bin/awe-tegg run visit-findings
```

---

## 6. Choosing which site visit

**Without `--site-visit`** the tool applies a standing rule and prints which
visit it chose and why:

> the most recently completed visit carrying an agreement, a site and an
> identifier — ordered by end date, then start date, then identifier

Ties break on the identifier, so two runs a minute apart choose the same visit.

**To choose one yourself**, pass its identifier exactly as the portal lists it:

```bash
./scripts/visit-findings.sh T25-204
```

To see what is available:

```bash
./scripts/documentation-read.sh
```

An identifier that matches nothing, or matches more than one visit, is an error
that lists the alternatives. It never guesses.

## 7. What you get back

On screen: the run id, 13 steps, which visit was read, what knowledge was used,
and where the result is.

On disk, under `work/operations/<run id>/`:

| | |
|---|---|
| `review/review.md` | **the thing to read** — the repair items, in order of urgency |
| `review/review.json` | the same, as data, if you want to put it somewhere else |
| `documents/*.pdf` | the two reports exactly as TEGG rendered them |
| `state.json` | every step, when it happened, and what it proved |
| `evidence/` | screenshots and page captures |

The run folder names real customers and real sites. It stays on your machine —
`work/` is never committed.

### Reading `review.md`

It opens with a **DRAFT** banner. That is not boilerplate. Read it.

Then, in order:

1. **What this comes to** — how many items are outstanding, how many are urgent,
   and a rough range for the ones that could be sized.
2. **Items** — one table row per problem, worst first. The `Rough range` column
   either has a number or says *why there isn't one*.
3. **Each item in full** — for every problem: the technician's own description,
   their own recommendation **verbatim**, why the tool graded the urgency the
   way it did, what it assumed to size the work, and the page of which PDF each
   fact came from.
4. **Assumptions behind every number** — read this before repeating any figure
   to anybody.
5. **Anything the tool was not sure about** — your job list.

### Reading the recommendation

The recommendation is **the technician's**, quoted. The tool does not write
repair advice and does not paraphrase it. What the tool adds is structure:
repair or replace (from their tick), urgency (from a stated rule you can read),
and whether the work needs an outage (from whether their text says so).

Anything the tool derived says which rule produced it. Anything it could not
derive says so instead of guessing.

### Reading the estimate

**The estimate is a draft, and out of the box the money is not real.**

The rate card that ships — `config/estimating.example.yaml` — is marked
`placeholder: true`. While that is true, every total is stamped `NOT PRICED`
and the review says on its first screen that the figures are illustrative.

To make estimates mean something:

```bash
cp config/estimating.example.yaml config/estimating.yaml
# put your own labour rate, hours and material allowances in it
# then set: placeholder: false
./scripts/visit-findings.sh
```

`./scripts/visit-findings.sh` picks up `config/estimating.yaml` automatically
once it exists. The long form needs `--rate-card config/estimating.yaml`.

`config/estimating.yaml` is gitignored — your rates are not committed.

Even with real rates, the output is a **draft for an estimator**. It is not a
quotation. It contains no site conditions, no access or permit costs, no lead
times, no after-hours premium, and no priced bill of materials. An item the
card does not cover is listed as *not estimated* with the reason — it is never
priced off the nearest-looking row.

---

## 8. Exit codes

| code | meaning | what to do |
|-----:|---------|------------|
| `0` | finished, read-only | read `review/review.md` |
| `1` | could not continue | read **human action required** on the output |
| `2` | stopped and needs a person | same, and the run is resumable |

Note: `2` is also what the command-line parser returns for a bad argument
(`run: error: argument operation: invalid choice`). If you are scripting this,
treat a `2` with no run id printed as a usage error, not an escalation.

## 9. Safe resume

Every verified step is written to disk the moment it is verified. Close the
laptop, lose the network, kill the terminal — nothing is wasted.

```bash
.venv/bin/awe-tegg status                     # every run, and where each got to
.venv/bin/awe-tegg resume --run-id <run id>
```

Resume is **cheap and safe**:

* if both PDFs are already on disk and their checksums still match what the run
  recorded, it does not sign in at all and finishes in under a second;
* if they are not, it signs in again — a browser session cannot be saved — and
  carries on;
* resuming a run that already **finished** does nothing at all. It reprints the
  answer. Re-rendering a customer's reports for no reason is not free.

A resume never chooses a different site visit than the run it is resuming.

---

## 10. When it needs you

### `TEGG_USERNAME and TEGG_PASSWORD not set`

Step 3, in *this* terminal window. Each window is separate.

### `the portal rejected the credentials`

Sign in to the portal in a normal browser first. If that works and this does
not, the account may have picked up a second-factor prompt. This tool cannot
answer one and says so rather than retrying.

### `signed in, but the page never named the 'Lippolis' workspace`

The sign-in landed in a different contractor's workspace. The run refuses to
read anything at that point, on purpose. Check which account is being used.

### `the report form offers no agreements for this site`

The search landed on the *customer* rather than the *site*, or that site's
agreements are not published to the reporting module. Nothing was changed and
no report was requested. Open the portal by hand, check that the site has an
agreement under Reports, and try `--site-visit` with a different visit.

### `the report viewer did not open within 180 s of Print Report`

TEGG generates these reports on its server and a large one can time out. Try
again; if it happens twice on the same visit, that report is too big for this
route and needs a person to export it by hand. Nothing was changed.

### `no route proved to be the Documentation area`

The portal moved the area somewhere the tool could not find from the navigation
it was shown. Nothing was changed. Find where Documentation now lives and tell
whoever maintains this tool — the fix is one line of knowledge, not a code
change.

### `this site visit recorded no equipment problems`

Not an error. Both reports came back and both are empty, which means the
inspection found nothing to repair. There is nothing to quote. The PDFs are in
the run folder if you want to check.

### `<n> page(s) had checkboxes that could not be read unambiguously`

The tool found a tick it could not attribute to a box, so it refused to report
that page's ticks rather than guess. Those items are still in the review,
flagged. Open the PDF page it cites and read them yourself.

---

## 11. What this tool will not do

| | |
|---|---|
| sign in, read pages, tables and links | yes |
| set a report form's own dropdowns (agreement, order, images) | yes |
| render and download the two inspection reports | yes — this creates a document from data already there; it changes no TEGG record |
| set the visit list's timeframe filter | yes — reported every run |
| submit, approve, send, email, upload, delete, sign, invoice, mark complete | **no — refused in code** |
| save a password, cookie, token or session | **no** |
| use another contractor's knowledge | **no — refused** |
| contact the customer | **no** |
| price materials from a supplier | **no** |

The refusals are not convention. Route discovery is handed an object with no
`click`, no `fill` and no `submit` on it. The report-retrieval step, which must
click, screens every control it touches and raises on anything labelled with a
word that means a change. There are tests that try all of them.

## 12. Known limitations

1. **The estimate is a size, not a price.** Out of the box the rates are
   placeholders. Even with real rates it is a first pass for an estimator.
2. **One visit per run.** There is no batch mode.
3. **The tool reads two of TEGG's reports**, not all seven. The Problem Count
   Summary, EDS Component Problem Summary and the Equipment Inventory forms are
   not part of this operation.
4. **The certificate is not touched.** Filling it in is not implemented and its
   section-B checkboxes are never ticked automatically, on purpose.
5. **The thermal figures attach by tag id.** A problem whose tag has no
   infrared sheet simply has no thermal reading; it is not inferred.
6. **A site whose search result is ambiguous may land on the customer rather
   than the site.** The run detects this and stops rather than producing an
   empty report, but it cannot resolve it for you.
7. **Everything above was proved by the person who built it.** A second
   operator on a second machine has not yet run this cold. That is the next
   thing worth doing, and until it happens this is a pilot, not a rollout.

---

## 13. The older manual workflow

Before either operation existed, reports were built from documents downloaded
by hand. That path still works and is still the only way to produce an
**assembled ESA customer report**, because neither operation above does that
yet.

It is a different tool — `tegg`, not `awe_tegg` — and it is not part of the
coworker pilot. Recorded here so the knowledge is not lost with the documents
that used to hold it.

```bash
.venv/bin/tegg doctor                                   # what is ready
.venv/bin/tegg plan --job config/job.example.yaml       # what a run would do
.venv/bin/tegg build --job config/job.example.yaml --source ~/Downloads/acme
.venv/bin/tegg status --job-id <job-id>                 # where a job got to
.venv/bin/tegg resume --job-id <job-id>
```

`tegg --help` lists the rest. Two things to know before relying on it:

* **It has never produced a complete report.** It assembles and watermarks
  whatever documents it finds and names what is missing. See
  [`END_TO_END_GAP_REPORT.md`](END_TO_END_GAP_REPORT.md).
* **The certificate is never filled in automatically**, and its section-B
  checkboxes are never ticked. They are Wingdings glyphs, two per item across
  eleven items, and a wrongly ticked box on a legal attestation is worse than
  an unticked one. Output stays a watermarked DRAFT until a person completes it.

For what the manual process is supposed to be, end to end, read
[`SOP.md`](SOP.md) — that is Paul's own procedure, and it is the source this
automation is measured against.

## 14. Where the rest of the documentation is

| document | what it is for |
|---|---|
| **this file** | how to run it. Start here. |
| [`SOP.md`](SOP.md) | Paul's manual procedure — background, not instructions |
| [`END_TO_END_GAP_REPORT.md`](END_TO_END_GAP_REPORT.md) | what works, what does not, and the open questions for the business |
| [`LIVE_TEST_EVIDENCE.md`](LIVE_TEST_EVIDENCE.md) | the runs behind every claim made anywhere |
| [`OPERATIONAL_KNOWLEDGE.md`](OPERATIONAL_KNOWLEDGE.md) | how the tool learns and what it refuses to believe |
| [`KNOWLEDGE_HANDOFF.md`](KNOWLEDGE_HANDOFF.md) | for whoever maintains the code next |
| [`COWORKER_READINESS.md`](COWORKER_READINESS.md) | the readiness checklist and its progress |
