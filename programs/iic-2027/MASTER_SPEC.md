# IIC 2027 — Master Presentation Spec

**This is a spec, not a deck.** It says what every artifact must contain, what evidence each part
rests on, and when to cut things. It contains no slide copy, no script and no final wording, and it
is designed to still be correct in February when the evidence has changed underneath it.

**Nothing in this file duplicates a number.** Every figure the presentation will ever quote is read
at runtime from `proof/`, `deployment/`, `capability/` and `programs/discovery/`:

```bash
npm run pitch                 # beat readiness, evidence gaps, deliverable status
npm run pitch -- --beats      # every beat, every slot, every source
npm run pitch -- --artifacts  # the four deliverables, in detail
npm run plan                  # what to actually do about it
```

If a figure appears in a submission that `npm run pitch` cannot produce, it is not evidence,
whatever it says.

---

## 1. Audience and objective

**Audience.** A panel of judges drawn from "corporate, nonprofit, investment, and higher education
partners across the region" — verified. Judges named in past editions include the Institute's
benefactors, alumni founders, and professionals from health, media and finance. They are not
technical and should not be assumed to be investors.

**What they score** — verified for the 2nd annual (2019), seven editions old, and the only rubric
ever published:

> feasibility, uniqueness, market need, impact, cost of implementation, ease of implementation,
> idea articulation, and overall impression

**Objective.** Win the 10th annual. Concretely: reach the final, and be the entry the judges are
still arguing about afterwards. The competition is a deadline, not a product — see `README.md` —
and every item in this spec had to pass the test of being worth doing if the challenge were
cancelled. Two items failed that test and are marked as such.

**The three deliverables and the final** — verified:

| | What | When | Notes |
|---|---|---|---|
| Milestone 1 | 1-minute video pitch | weeks after a February kickoff | scored twice — also decides the $1,000 Fan Favourite on public engagement |
| Milestone 2 | Executive summary | spring | whether judges read it before pitching is UNKNOWN |
| Milestone 3 | Pitch slide deck | spring | |
| Final | Four-minute pitch, then Q&A | late April / first week of May | four minutes verified for 2019 only |

**Therefore the evidence deadline is 31 January 2027**, not April. Milestone 1 is due within weeks
of the kickoff, and it is built from whatever is true in January.

---

## 2. Governing thesis

> A student worked inside a real business, found a repeated operational problem, built a system to
> **execute** that work, deployed it in production, measured the human time it returned, found the
> same problem outside that company, deployed the same platform to another business, and in doing
> so demonstrated a repeatable business — which reveals a much larger idea about how companies
> could run.

**The architecture is the reason to believe the vision is credible. It is never the opening
explanation.** A judge who hears "capability graph" in the first thirty seconds has stopped
listening to the story and started translating vocabulary.

**Today, five of the eight steps in that sentence are unproven.** The thesis is the shape the story
takes as evidence arrives, not a claim about the present. `npm run pitch` says which steps are real.

---

## 3. The one sentence

Canonical, in code, at `programs/iic-2027/narrative.mjs` → `ONE_SENTENCE`. Every artifact reads it
from there.

> **Spoken:** Every business runs on work that is really just moving information between people,
> paper, email and software. AWE does that work itself, under the company's own rules, so the people
> don't have to.

> **Written:** AWE is software that does a company's routine operational work — the requests,
> approvals, purchase orders and follow-ups — by that company's own rules, instead of leaving people
> to carry it between paper, email and other software.

> **Hook (video, 8 seconds):** AWE does the office work itself.

> **Contrast:** Today's AI answers questions. AWE does the work, and it can show you what it did.

It has to carry four things: that the work is **operational**; that AWE **executes** rather than
advises; that it does so under the **organization's rules**; and that the payoff is **human time**.
Alternatives and why each was rejected: `pitch-architecture.md` §3.

**Banned from the opening explanation**, and asserted by the suite: agent, ontology, kernel,
orchestration, context assembly, capability graph, platform, LLM. All true, all available in Q&A,
none worth the four seconds of translation they cost at the moment a judge decides whether to keep
listening.

**The one test that matters.** Say it to three people who do not work in software; ask them an hour
later what AWE does. Record how many get it right in `facts.mjs` → `narrative.plainLanguageTests`.
Until somebody has, the "What AWE is" beat is `NOT_READY`, and it is currently the weakest beat in
the whole pitch.

---

## 4. The winning claim stack

Ten claims, in the order the audience needs them. **Status is computed, never written here** — run
`npm run plan` for the live grade of each. The mapping to the twelve canonical claims in
`programs/venture/claims.mjs` is given so nothing drifts.

| # | Claim | Canonical claim | Where it appears | The judge question it invites |
|---|---|---|---|---|
| 1 | Businesses lose meaningful human time to fragmented operational work | `problem_real`, `problem_economic` | Beat 1, 3 | "How much time, and how do you know?" |
| 2 | The problem exists in actual construction operations | `problem_real` | Beat 1, 2 | "Is that just this one company?" |
| 3 | AWE executes the work rather than suggesting what to do | `awe_solves` | Beat 4, 5 | "Why isn't this ChatGPT?" |
| 4 | AWE works in real production | `works_in_production` | Beat 5, 6 | "Is it live, or is that a demo?" |
| 5 | AWE measurably returns human hours | `measurable_value` | Beat 6 | "How do you know?" — the hardest one |
| 6 | The problem repeats outside the first company | `external_pain` | Beat 7 | "How many people have you asked?" |
| 7 | The architecture works across more than one business process | `multi_capability` | Beat 8, 10 | "Is the second one real or planned?" |
| 8 | A second organization can be provisioned without rebuilding the product | `not_hardcoded`, `repeatable_deployment` | Beat 8 | "How long did the second install take?" |
| 9 | Customers will adopt and pay | `external_want`, `will_pay` | Beat 9 | "Has anybody paid?" |
| 10 | Construction is the wedge, not the ceiling | `path_beyond_wedge` | Beat 10 | "Isn't this just construction software?" |

**Claims 5, 6, 8 (externally), 9 and 10 are not established today.** Claim 8 is *architecturally*
proven and *externally* unproven, and the difference between those two words is the difference
between an honest pitch and a disqualifying one.

**The rule.** No claim appears in any artifact at a strength the evidence does not support. The
proof layer refuses to print a value it cannot defend; the presentation inherits that refusal.

---

## 5. Final pitch architecture

Twelve beats, defined in `narrative.mjs` → `BEATS`. Each carries its audience question, its
takeaway, the criteria it serves, its evidence slots, and **the condition under which it should be
cut**.

| # | Beat | The question the audience is asking | Cut order |
|---|---|---|---|
| 1 | The moment | Is there a real problem here, and can I see it? | never |
| 2 | The discovery | Why does this person know that? | 6 |
| 3 | Before AWE | What exactly was the old way? | 4 |
| 4 | What AWE is | What is this, in one sentence I could repeat? | never |
| 5 | Live execution | Does it actually work? | 3 (to recording) |
| 6 | Proof | It ran — what did it accomplish? | 5 (unmeasured parts only) |
| 7 | Outside the first company | Is this one company's custom software? | cannot be cut |
| 8 | PCC is not the company | Is this a product or a project? | 8 (half) |
| 9 | Who pays, and for what | Is there a business here? | 9 |
| 10 | The wedge | How big does this get, credibly? | 10 |
| 11 | Why this and not the obvious thing | Why not ChatGPT or their ERP? | 11 → Q&A |
| 12 | The close | What do I remember tomorrow? | never |

**Four minutes holds about seven of these.** The final pitch carries beats 1, 4, 5, 6, 7, 8, 12 and
folds the rest into single clauses — see `artifacts.mjs` → `final_pitch`.

**Beat 7 cannot be cut and cannot be faked.** With no external evidence it is the loudest silence
in the pitch. That is why external discovery outranks every pitch-shaped task in the planner.

---

## 6. Demo architecture

Full design in `demo-architecture.md`. In one line: **one complete workflow, 60–75 seconds, showing
what a person used to do at each step.**

Four tiers, computed by `artifacts.mjs` → `bestDemoTier()`:

| Tier | What | Loses |
|---|---|---|
| PRIMARY | the real deployment, live, on production data, draft-only | nothing |
| BACKUP A | the same packaged artifact, local, against a rehearsal database, **labelled out loud** | the claim the data is real |
| BACKUP B | a recording of the primary, narrated live rather than voiced over | the sense it is happening now |
| BACKUP C | four printed screens | motion |

All four tell the same story. **No fake production evidence is ever recorded**, and a rehearsal is
always announced as one.

---

## 7. The wow moment

**PRIMARY — "PCC is not the company."** After the audience has watched purchasing work end to end
and has quietly filed AWE as *a purchasing app for a construction firm*, the same architecture is
shown running a second, unrelated organizational workflow, and a second organization. The
reframing is the product truth, not an effect.

**SECONDARY — "How do you know?"** Take a headline number and walk it, live, down to the individual
executions, the baseline steps and the sources behind it. Then name a number the system **refuses**
to produce. Almost nothing in this category can do either.

Neither depends on animation. Selection reasoning and the rejected candidates: `demo-architecture.md` §5.

---

## 8. Evidence slots

Twenty-one slots, defined once in `narrative.mjs` → `SLOTS`, shared by whatever beats need them,
each naming the claim that owns it. Every slot reports a **source**:

| Source | Meaning |
|---|---|
| `REAL` | it happened, outside a test, at a real organization |
| `REHEARSAL` | it ran, against a synthetic company or a non-production database |
| `ARCHITECTURE` | the code can do it; nobody has done it |
| `NONE` | nothing |

**A slot filled from a rehearsal can never make a beat STRONG.** This is the safety property the
whole system exists for: the second-customer rehearsal produces exactly the shape of a real result,
which is what makes it useful and what makes it dangerous.

---

## 9. Readiness, gaps and the loop

`npm run pitch` reports, from live facts: every beat's status; the weakest beat; the top evidence
gaps ranked by what they cost the beat and how many judging criteria they serve; each deliverable's
status and whether it is **producible**; and the best demo tier available today.

**The compounding loop:**

```
  REAL EVENT           somebody is interviewed; the baseline is measured; PCC runs in production;
                       a design partner signs; a customer pays
        ↓
  EVIDENCE INGESTED    into proof/, programs/discovery/, deployment/ — never into a slide
        ↓
  CLAIM STATUS         programs/venture/claims.mjs re-grades, from the same facts
        ↓
  SLOT FILLS           narrative.mjs reads it; no narrative document is edited
        ↓
  BEAT IMPROVES        and so does every artifact carrying that beat
        ↓
  NEXT HLA             programs/venture/plan.mjs names the next action, in gate order
```

Worked examples, all live today:

| When this happens | This changes |
|---|---|
| 3 people restate the one sentence correctly | "What AWE is" NOT_READY → STRONG. Cost: one afternoon. |
| The Lippolis baseline is measured | `problem_economic` gains evidence; the value slot unblocks |
| PCC runs in production for 30 days | Proof beat PARTIAL → and the video becomes producible |
| 5 external interviews recorded | Market beat NOT_READY → PARTIAL |
| A real second company installs it | Repeatability beat INFERRED → STRONG; the wow moment gets its evidence |
| A customer pays | Business beat NOT_READY → STRONG |

**Nobody edits a narrative document for any of those.**

---

## 10. Q&A

`judge-questions.md` — twenty questions, each with a concise answer, its supporting evidence, its
weak spot, the evidence still needed, and **the overclaim that is prohibited**.

**Three answers end in an admission**: hours returned, external users, revenue. Rehearse those
until they are boring. An admission delivered smoothly reads as rigour; the same admission delivered
badly reads as a gap somebody has just found.

---

## 11. Visual principles

`visual-language.md`. In short: serious, industrial, built rather than branded. Real screens over
diagrams, real photographs over illustration, one accent colour, no neon-purple AI gradient, no
stock imagery, no animation that is not showing a state change that actually happened.

---

## 12. Capability reveal

| Capability | Treatment | Why |
|---|---|---|
| PCC (purchasing) | **MUST SHOW** | the only thing with production evidence; the whole demonstration |
| Proof / measurement | **MUST SHOW** | the answer to "how do you know", and the strongest differentiator |
| Second organization | **MUST SHOW** | half the wow moment; two of eight criteria |
| TEGG / second capability | **SUPPORTING** | the other half of the wow. Named as a workflow, never as an acronym |
| Governance and authority limits | **SUPPORTING** | the answer to "what if the AI is wrong" |
| Organizational kernel, agent runtime, AXIS | **Q&A ONLY** | true, load-bearing, and incomprehensible in four minutes |
| Anything not yet built | **DO NOT MENTION** | |

**One product story.** The pitch is about a company that does its own operational work, not about a
system with named parts. Rule of thumb: **no acronym that is not a customer's** in the spoken pitch.

---

## 13. Founder story

`founder-story.md`. Answers two questions and no others: *why did you see this before somebody
else*, and *why will you keep building it*. Evidence-backed, short, delivered as one clause inside
beat 1 in the four-minute version.

---

## 14. Use of the prize

`use-of-funds.md`. A living allocation model tied to the gate the company is at when the money
arrives — not "marketing and development". The prize should accelerate something already moving.
**Not finalised**, deliberately: the right allocation in April depends on whether there is a paying
customer by then, and there is no way to know that now.

---

## 15. Rehearsal plan

In `milestones.mjs`, computed like everything else, one rung a month, each naming **what must be
better than the rung below it**:

| | Better than the previous version by |
|---|---|
| Sep 2026 | it exists — three non-technical people can explain AWE back |
| Oct 2026 | showing the product instead of describing it |
| Nov 2026 | surviving questions — five minutes, hostile listener |
| Dec 2026 | containing a real production number |
| Jan 2027 | not being about one company |
| Mar 2027 | being the real thing, to time, with Q&A |
| Apr 2027 | being boring to deliver |

A rung cannot be climbed by rehearsing harder. Each requires evidence the previous one did not have.

---

## 16. Red team

`red-team.md` — fifteen ways this loses, each with a mitigation and each named honestly. The three
that are live today: *the audience does not understand what it does*; *this looks like custom
software for one company*; *the pitch is mostly future*.

---

## 17. What must NOT be built yet

- Polished slides, animations, final logos, a cinematic video, or a final script.
- A market-size number built on assumptions. There is no defensible one, and a judge who tests it
  will find it faster than anything else in the deck.
- Any metric that is not derived from `proof/`.
- A separate presentation planner. `programs/venture/plan.mjs` is the planner.

Wireframes and specifications are fine. **The story must earn its evidence first**, and every hour
spent on polish before January is an hour not spent on the evidence that would make the polish
worth having.
