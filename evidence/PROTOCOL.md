# Evidence protocol — AWE → IIC 2027

This directory holds **real-world evidence**. Not documentation, not plans, not
architecture. Every file under `evidence/records/` is a claim about something
that actually happened in the physical world, and every one of them must survive
a hostile reader asking *"how do you know that?"*

The engineering exists. The bottleneck is the evidence. This file is the field
manual for closing that gap.

```
node scripts/evidence.mjs help       # command surface
node scripts/evidence.mjs status     # what is actually captured
```

---

## 1. The one idea this whole layer is built on

**A value with no provenance is not evidence.** So nothing here is stored as a
bare value. Everything is stored as a *claim*:

```json
"touch_time_minutes_per_po": {
  "value": 18,
  "confidence": "estimated",
  "basis": "she walked through a typical PO out loud, start to filing",
  "range": { "low": 12, "high": 30 }
}
```

`confidence` is the load-bearing field. There are six classes:

| class | means | required alongside |
|---|---|---|
| `documentary` | Copied off an artifact that exists independently of memory | record must carry `source_document` |
| `observed` | A named person watched it happen and wrote it down then | `observed_at`, `observed_by` |
| `testimony` | A person stated it from their own knowledge | `attributed_to`, `stated_on` |
| `estimated` | A person's best guess | `basis`, `range: {low, high}` |
| `derived` | Computed by AWE from other claims | **never hand-entered** — rejected |
| `unknown` | Explicitly recorded absence | `value` must be `null` |

Three rules follow, and the validator enforces all three:

1. **An estimate can never pass as a measurement.** `estimated` without a stated
   basis *and* an honest low/high range is rejected. A point guess with no range
   would be indistinguishable in a report from something you timed.
2. **`unknown` is a real answer.** If you could not read the amount on a PO, that
   is `{"value": null, "confidence": "unknown"}` — never `0`, never blank, never
   your best guess. Blank cells in a CSV import as `unknown` automatically.
3. **Documentary and testimony never mix on one field.** A PO's vendor is
   documentary because it is written on the page. Touch time is never documentary
   because it is not written on any page. The validator rejects the wrong class
   on the wrong field.

---

## 2. What counts, and what can never count

`record_class` on every record is one of `production`, `rehearsal`, `synthetic`.

**Only `production` records raise IIC status.** Rehearsal and synthetic records
are structurally incapable of it — `status` filters them out before counting and
reports how many it excluded. Runner 6 asserts this: 20 rehearsal POs still score
zero. There is no flag to override it.

Also excluded from status:

- records that fail validation (they are reported, not silently dropped)
- files that do not parse
- **documents.** A markdown file existing has never satisfied a requirement here
  and cannot. Requirements are satisfied by validated records only.

---

## 3. Field procedure — Lippolis pre-AWE purchasing baseline

### 3.1 Before you touch a single PO: declare the scope

This is the step that makes the baseline defensible, and it must happen **first**.
Declaring scope after seeing the data is how baselines get gamed, and a reviewer
will ask.

```bash
node scripts/evidence.mjs new baseline_manifest --id lippolis-purchasing-2026 --by "Jack Daly"
```

That writes `evidence/records/baseline_manifest/lippolis-purchasing-2026.json`.
Open it and fill in every `null`.

Fill in, in particular:

- `process_scope` — the exact boundary. *"Materials purchasing: need identified on
  a job → PO written → order placed with vendor → PO filed."* If a step is not in
  this sentence, it is not in the baseline and it may not appear in the after.
- `window_start` / `window_end` — the date range of POs you will accept.
- `awe_production_start` — **the contamination cutoff.** Any PO dated on or after
  this is rejected automatically. `null` while AWE has not touched purchasing.
- `sampling_method` — say the truth. *"Every PO in the binder between these dates,
  in binder order, skipping none"* or *"every third"* or *"all the legible ones."*
  Disclosed selection is survivable. Hidden selection is fatal.
- `sampling_exhaustive` — **read this one twice.** `true` only if you transcribed
  *every* PO in the window with none skipped. This single flag decides whether PO
  volume can be computed from your sample at all. Thirteen POs pulled from a
  six-month binder tells you nothing about POs per week; thirteen POs that are
  *all* the POs in that window tells you everything. Set it `false` and volume
  falls back to testimony, clearly labelled — which is correct, not a failure.

Commit the manifest **before** capturing. The git timestamp is the proof.

### 3.2 At Lippolis, with the binder — the paper pass

```bash
node scripts/evidence.mjs baseline sheet    # print this, take it with you
```

One block per PO, 15 blocks. Target **15 POs**, hard floor **12**, spanning at
least **30 days**. The span floor exists so the sample cannot be dismissed as one
unusual week.

For each PO, copy only what is **on the page**:

| Field | Note |
|---|---|
| `po_number`, `po_date` | The date *on the PO*, not today |
| `vendor`, `job_reference` | Job number, or `STOCK` if shop stock |
| `requested_by`, `approved_by` | Names as written |
| `line_item_count` | Count them |
| `document_form` | handwritten_carbon / handwritten_pad / typed_printed / faxed / other |
| `approval_marking` | signature / initials / stamp / none / illegible |
| `amendments_on_face` | **Count crossed-out and rewritten entries.** This is documentary evidence of rework — the single most valuable field on the sheet. Do not skip it. |
| `total_amount`, `needed_by_date` | Only if present |
| `received_marking` | Evidence goods arrived |
| `legibility` | clear / partial / poor |

**Photograph every PO you transcribe.** A photo is what lets a skeptic re-check
your transcription in 2027. Drop them in `evidence/scans/`.

Anything you cannot read: **leave it blank.** Blank becomes `unknown`. Do not
reconstruct it from memory and do not ask someone — that would be testimony
wearing a documentary label.

### 3.3 Type it in

```bash
node scripts/evidence.mjs baseline csv > /tmp/pos.csv   # delete the example row
# fill /tmp/pos.csv in any spreadsheet, one row per PO
node scripts/evidence.mjs baseline import /tmp/pos.csv \
  --baseline lippolis-purchasing-2026 --by "Jack Daly"
node scripts/evidence.mjs validate
```

Only documentary fields are importable by CSV. Testimony and estimates never come
through a spreadsheet, because a spreadsheet column has nowhere to say how a
number is known — and that is exactly how estimates get laundered into facts.

### 3.4 The part paper cannot give you — testimony

Paper tells you *what* was ordered. It cannot tell you what it *cost in human
time*. Sit with whoever actually writes the POs (the person, not their manager —
the record captures which, and second-hand testimony is flagged as weaker).

```bash
node scripts/evidence.mjs questions baseline_testimony
node scripts/evidence.mjs new baseline_testimony --id testimony-office-manager --by "Jack Daly"
```

Ask about: minutes of hands-on time per PO, how many people touch one, calls per
PO, POs per week, rework rate, hours from "we need this" to "it's ordered", how
often a PO goes missing, what happens when the approver is out, and — in their own
words, quoted — the worst part.

Every number here is `testimony` or `estimated`, never documentary. Estimates need
a range. If she says "fifteen, twenty minutes?", that is
`value: 18, range: {low: 12, high: 30}` — not `18`.

### 3.5 The strongest evidence available — watch one

```bash
node scripts/evidence.mjs new baseline_observation --id obs-001 --by "Jack Daly"
```

Sit with a stopwatch and watch **one** PO go from need to filed. Record elapsed
time, hands-on time, wait time, handoffs, interruptions, calls, and the ordered
steps as actually performed.

This is what converts estimates into measurement. One observation gets you
`measured_thin`; **three or more gets you `measured`.** If you can get three, get
three — it is the cheapest possible upgrade to the credibility of the headline
number, and it costs one afternoon.

Record honestly whether the subject knew they were being timed. Observer effect
is real; recording it is stronger than pretending it is absent.

### 3.6 Freeze

```bash
node scripts/evidence.mjs baseline summary
node scripts/evidence.mjs freeze lippolis-purchasing-2026 \
  --by "Jack Daly" \
  --attest "These are faithful transcriptions of purchase orders I physically handled at Lippolis Electric."
git add evidence && git commit -m "evidence: freeze baseline lippolis-purchasing-2026 v1"
```

A freeze is an **attestation**, not a button — `--attest` is mandatory and goes in
the receipt in your words.

Freeze refuses unless: every record validates, ≥12 POs, ≥30-day span, ≥1 testimony,
≥1 observation. It writes a SHA-256 over the canonical form of every record.

**Commit the receipt immediately.** An uncommitted freeze proves nothing about
*when* it happened, and *when* is the entire point.

After freezing, `node scripts/evidence.mjs verify` detects any edit, deletion,
addition or manifest change, and names the record that moved.

A frozen baseline is **never overwritten**. If you find a transcription error
later, that is an amendment — it chains to the prior hash and the original receipt
stays on disk:

```bash
node scripts/evidence.mjs freeze lippolis-purchasing-2026 --by "Jack Daly" \
  --attest "..." --amend "PO 4407 line count was transcribed as 4, the page reads 7"
```

Correcting an error in the open is credible. A hash that quietly changed is not.

---

## 4. What contaminates Case Study #001

Any one of these, undisclosed, is fatal to the case study:

1. **A post-AWE PO in the pre-AWE baseline.** Blocked automatically by
   `awe_production_start` and by the required `awe_involved` assertion on every PO.
2. **Editing the baseline after seeing production results.** Blocked by freeze +
   `verify`. This is *the* attack the freeze exists to stop.
3. **Choosing the metric after seeing the outcome.** Blocked by `observation_window`
   requiring `metrics_declared`, `success_definition` and `failure_definition`
   filled in *before* the window carries weight.
4. **A changed process compared against an unchanged-process baseline.** Your
   `process_scope` sentence is the boundary. If AWE changes what the process *is*,
   say so explicitly rather than comparing incomparable things.
5. **Rehearsal activity counted as production.** Blocked by `record_class`.
6. **Cherry-picked POs.** Not blocked — it *cannot* be, only disclosed. That is
   what `sampling_method` and `sampling_exhaustive` are for. Tell the truth there.
7. **Task completion mistaken for objective success.** "The automation ran" is not
   "the right materials reached the right job on time." `success_definition` must
   describe the outcome in the world, not the software's exit status.

---

## 5. Observation window (post-AWE)

Gated on purpose. `window start` refuses unless the baseline is **frozen**, the
freeze **verifies**, and a real human has **approved production use**:

```bash
node scripts/evidence.mjs new release_approval --id approval-001 --by "Jack Daly"
# fill it in, then:
node scripts/evidence.mjs window start \
  --baseline lippolis-purchasing-2026 --by "Jack Daly" \
  --commit "$(git rev-parse --short HEAD)" --approval approval-001
node scripts/evidence.mjs window status
```

Without a named human authorizing production use, what you are running is a
**rehearsal**, and measuring it would not be Case Study #001.

The scaffolded window is deliberately **not valid** until you fill in the declared
metrics and the success/failure definitions. Declare them before the window opens.

---

## 6. External interviews, comprehension tests, founder story

```bash
node scripts/evidence.mjs questions interview            # what to ask, in order
node scripts/evidence.mjs questions comprehension_test
node scripts/evidence.mjs questions founder_story_fact
node scripts/evidence.mjs questions release_approval
```

**Interviews.** Ask about *their world* before describing AWE — the record has a
`pitched_before_asking` flag and setting it `true` marks every pain and commercial
answer as leading-question contaminated. Capture their exact words: their
vocabulary is the product's vocabulary. `disconfirming` is **required** — an
interview that only confirms your hopes was probably run as a pitch. Do not name a
price; ask what it would be worth and record what they say. Five interviews needed,
at least two arms-length (friends count, but cannot carry the market claim alone).

**Comprehension tests.** Show one artifact, ask "what does this do?", write down
exactly what they say including "I don't know". Do not help, do not correct.
`confusions` is required and must be non-empty — the misses are the entire point.
Five needed, all with testers of prior exposure `none` or `heard_the_name`; someone
who has heard the pitch five times cannot comprehension-test it, and the status
report will not count them.

**Founder story facts.** One checkable fact each, with a `verifier` — a commit
hash, an email, a person who would confirm it. Facts with no possible verifier are
recorded as `unverifiable` and **kept**, but they do not count toward the verified
requirement. Nothing is deleted for being inconvenient.

---

## 7. Non-negotiables

- Never invent a number. If evidence is missing, the report says so — see
  `clerical_hours.available: false` rather than a plausible figure.
- Never convert rehearsal or synthetic activity into readiness.
- Never delete negative or disconfirming evidence.
- Never re-freeze silently. Amend, in the open.
- Never present a point estimate as a measurement. Check `range_is_point` before
  quoting any figure — equal low and high means uncertainty was never captured,
  not that the number is precise.
- Never let a document's existence raise status.

The purpose of this layer is not to make the evidence look better. It is to make
it impossible to accidentally claim more than you can prove — so that what you
*do* claim is unarguable.
