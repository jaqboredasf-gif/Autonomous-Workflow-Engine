# Evidence

**The point of this directory: make it cheap for a real thing that happened to change what AWE may
claim.**

Everything else in `programs/` computes. `venture/` ranks claims, `iic-2027/` scores beats,
`discovery/` counts conversations. All of it reads facts, and until now three of the most important
facts had no way in except hand-editing `programs/iic-2027/facts.mjs`:

| fact | what it means | how it moved before |
|---|---|---|
| `narrative.plainLanguageTests` | people who restated what AWE is, correctly | edit a JS file |
| `businessModel.unitDefined` | we know what is being sold | edit a JS file |
| `differentiation.alternativesAnalysed` | we know what they use instead | edit a JS file |

All three have been zero since the day they were written. That is not an accident and it is not
laziness: **the friction was the reason.**

---

## The loop

```
  a real thing happens
        │
        ▼
  a field sheet          programs/evidence/templates/*.md      ← fill on a phone
        │                programs/discovery/templates/*.md
        ▼
  npm run evidence -- --import <file>                          ← the only validation gate
        │
        ▼
  a validated record     records/… , programs/discovery/interviews/…
        │
        ▼
  derive.mjs  →  claims.mjs  →  narrative.mjs  →  readiness.mjs
        │
        ▼
  npm run evidence       what to collect next
```

**Two steps between reality and readiness.** That is the target and it is audited: `EVIDENCE_MAP`
in `status.mjs` carries a `steps` count per evidence type, and a row above 2 has friction left in it.
Nothing is at 1, because validation is not optional — a capture that skipped it is not evidence.

---

## The commands

```bash
npm run evidence                      # what is needed, per area, and the act that supplies it
npm run evidence -- --queue           # today / this week / when available
npm run evidence -- --snapshot        # if the pitch were tomorrow, what could we truthfully say
npm run evidence -- --check           # validate every capture file on disk
npm run evidence -- --new interview   # write a blank field sheet
npm run evidence -- --import <file>   # turn one filled-in sheet into a validated record
```

---

## What is here

| file | what it is |
|---|---|
| `comprehension.mjs` | can a normal person say what AWE is after hearing it once |
| `mock-pitch.mjs` | what a **listener** took away, which is not what the pitcher felt |
| `founder-story.mjs` | the five facts about Jack's own history the pitch rests on |
| `field-sheet.mjs` | the `key: value` format, and the refusals |
| `import.mjs` | one sheet → one validated record |
| `load.mjs` | read the records, exclude what does not validate, never throw |
| `status.mjs` | the evidence map, the founder queue, the pitch snapshot |

**Alternatives and unit-of-sale are not here.** They live in `programs/discovery/`, on the interview
record, because they come out of the same conversation. Asking Jack to fill in a second form with
the same company name is how a second form stops being filled in.

---

## The three refusals

Each is one filter, in one place, and each has a test.

1. **A comprehension test on somebody inside the project is refused outright.** Not down-weighted —
   refused. Anybody who has heard the pitch cannot be surprised by the sentence, and one such
   record in a sample of five moves the only number that says whether the explanation works.
2. **An alternative the founder inferred is never counted as analysis.** It is kept and shown. The
   difference between "the customer told me they use a spreadsheet" and "I assume they use a
   spreadsheet" is the difference between discovery and a competitive landscape slide.
3. **A unit of sale one company preferred is not a unit of sale.** Three outside organizations
   agreeing makes it `SUPPORTED`; two makes it a `CANDIDATE`; a tie makes it `CONTESTED`, which is a
   result rather than a failure.

---

## What this is not

Not a CRM. Not a dashboard. Not a survey tool. Not a pipeline, and there is no stage, owner or
next-action date anywhere in it — those model a sales process, and at this stage optimising for
closing rather than for learning is the expensive mistake.

**And no record here is ever market evidence.** A mock pitch that went well says something about the
pitch and nothing whatever about whether contractors have this problem. That temptation is the most
available self-deception in this project — rehearsals are fun, repeatable, and produce enthusiasm on
demand — so nothing in this directory writes to a discovery fact, and `scripts/eval-evidence.mjs`
asserts it.
