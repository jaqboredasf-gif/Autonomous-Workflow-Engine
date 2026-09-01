# Iona Innovation Challenge 2027

A deadline, not a product.

**The competition is downstream of the company.** If AWE can prove it returns measurable value to
real organizations, the pitch is a consequence. If it cannot, no amount of preparation in this
directory will fix that, and the highest-leverage thing to do about the competition will almost
always turn out to be building the company.

That claim is enforced rather than asserted: every readiness band here is scored from a fact
derived from the repository or from a live database, and `highestLeverage()` routinely recommends
customer discovery and baseline measurement over anything pitch-shaped.

---

## Run it

```bash
npm run readiness                    # twelve company dimensions, scored from facts
npm run pitch                        # twelve presentation beats, and what evidence is missing
npm run pitch -- --beats             # every beat, every slot, every source
npm run pitch -- --artifacts         # the four deliverables, in detail
npm run plan                         # what to actually do about it

node scripts/iic-readiness.mjs --db /data/pcc.sqlite --org lippolis --milestones
node scripts/iic-pitch.mjs --json    # for a dashboard or AXIS
```

Read-only. All of it. Writes nothing, and asserts nothing.

---

## What is here

| File | What it is |
|---|---|
| `readiness.mjs` | Twelve dimensions, each scored 0–4 **from facts**, each band citing why. Plus `highestLeverage()`, which is the reason the file exists. |
| `milestones.mjs` | Dated targets for Sep 2026, Dec 2026, Feb 2027, Apr 2027. **No milestone has a `done` field** — whether one is met is computed from the same facts the scorecard reads. |
| `facts.mjs` | The short list of things software cannot derive. Each entry must name a witness; an unwitnessed declaration is refused, and a derived measurement always beats a declared one. |
| `competition-intelligence.md` | What is actually known about the competition, and what is not. |
| `evidence-index.md` | Where each claim's evidence lives. Pointers, never copies. |
| `judge-questions.md` | Twenty-three questions that would hurt: the answer, its evidence, its weak spot, and **the overclaim that is prohibited**. |
| `narrative.mjs` | **The presentation as a structure that reads evidence.** Twelve beats, twenty-one evidence slots, weighted by the published judging criteria. Finds the weakest beat and the evidence that would most improve the pitch. Proposes no actions — that is the planner's job. |
| `artifacts.mjs` | The four things that get submitted, as **budgets**: what each carries, what it drops and at what cost, and the evidence threshold below which it should not be made. Plus the four demonstration tiers. |
| `MASTER_SPEC.md` | The canonical spec: audience, thesis, claim stack, beats, demo, wow moment, slots, Q&A, capability reveal, funds, rehearsal, red team. **A spec, not a deck.** |
| `pitch-architecture.md` | Two full pitch designs, both attacked, one selected — and the one-sentence alternatives with the reason each was rejected. |
| `demo-architecture.md` | The demonstration as an engineered artifact: what is shown, what is hidden, four fallback tiers, and the wow moment. |
| `visual-language.md` | The design system future graphics must obey. No graphics yet. |
| `competitive-positioning.md` | How the comparison will be made. **Deliberately empty** — every cell is a claim about somebody else's product. |
| `founder-story.md` | What the repository can attest, and what Jack must confirm before it is said out loud. |
| `use-of-funds.md` | A living allocation model, keyed to which gate is open when the money arrives. |
| `red-team.md` | Fifteen ways this loses, with mitigations. Three are live today. |
| `review-rubric.md` | A scoring sheet for rehearsals, and the adversarial prompts that make a reviewer useful. **No probability of winning.** |

**No operational truth is duplicated into markdown.** Every figure in a pitch traces back through
`proof/case-study.mjs` to executions, baseline steps and sources. There is no competition database,
and no narrative document holds a number.

**The compounding property.** Every beat's evidence is READ at runtime, never stored. When the
baseline is measured, the value beat improves; when five interviews are recorded, the market beat
improves; and nobody edits a narrative document for either. When a rehearsal is mistaken for a
deployment, nothing improves — the slot refuses rehearsal evidence by name, and a suite asserts it.

---

## The scoring bands

The same everywhere:

| Band | Means |
|---|---|
| 0 | nothing |
| 1 | claimed, unevidenced |
| 2 | evidenced once |
| 3 | evidenced repeatedly, or by somebody outside the company |
| 4 | evidenced repeatedly **and** externally, and it survived contact with money |

The total is printed last, small, and without a colour. A single number across twelve
incommensurable dimensions is a summary, not a measurement.

---

## Where things stand

Run the command; this file will be out of date and the command will not be. As of the commit that
introduced this directory, derived from the repository with no production database:

- **Deployment repeatability 3/4** — 71% of the organization profile is honoured by the code, proven
  against a second organization's role vocabulary.
- **Product maturity 2/4** — installable by somebody else; the deployment readiness policy is not
  yet satisfied by a committed evidence log.
- **Measurable outcomes 2/4** with a production database — objective success is measured; no
  baseline exists, so no improvement can be stated.
- **Everything else 0** — including customer discovery, which is why it is the recommended action.

September 2026 targets: **4/4 met.** December 2026: 0/5.

**The rubric is no longer unknown, and it changes the plan.** Verified 2026-09-01 from Iona's own
report of the 2nd annual: pitches are judged on *feasibility, uniqueness, market need, impact, cost
of implementation, ease of implementation, idea articulation and overall impression* — eight
criteria, seven editions old, no weights published. There is **no traction, revenue or team
criterion**, and two of the eight are about whether the thing can actually be built and run. That is
the opposite of a venture-capital rubric, and a deck built for one would spend its best minutes on
things nobody is marking. See `competition-intelligence.md` §2b.

**The deadline is earlier than this directory first assumed.** Verified from Iona's own pages on
2026-08-27: the 9th annual kicked off 6 February 2026 and ran its final on 30 April 2026, with a
one-minute video as the first of three spring milestones. So evidence has to be **frozen by
January 2027**, not gathered through April. See `competition-intelligence.md`; `milestones.mjs` has
been corrected.

---

## The rule for this directory

**Do not build anything here that would be worthless if the competition were cancelled.**

Everything currently in it passes that test. The readiness scorecard is a company scorecard with a
deadline attached; the discovery structure is how a company finds out whether it has a market; the
proof architecture it reads is how a company keeps its customers. Judge Q&A is the only genuinely
competition-shaped artifact, and answering hard questions about your own numbers is not wasted work
either.
