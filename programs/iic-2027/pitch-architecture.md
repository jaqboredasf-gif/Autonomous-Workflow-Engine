# Designing it twice

Two complete pitch architectures, both attacked, one selected with borrowings from the other. This
document exists because the first version of the deck would otherwise have been the shape every
startup deck is, and that shape was designed for a different audience answering a different
question.

---

## 1. The design constraint nobody usually writes down

**The judges score eight things, and four of them are unusual.** Verified from the 2nd annual
(2019); see `competition-intelligence.md` §2b for the caveat about its age:

> feasibility, uniqueness, market need, impact, cost of implementation, ease of implementation,
> idea articulation, and overall impression

There is **no traction criterion, no revenue criterion, and no team criterion**. There *are* two
criteria about whether the thing can actually be built and run, and two about whether the idea was
communicated well.

That single fact decides most of what follows. A venture deck exists to convince an investor to
take a risk on future returns, so it front-loads market size, traction and team. None of those three
is on this list. **Half the marks here go to: can it be built (feasibility, cost, ease) and was it
understood (articulation, impression).** AWE is unusually strong on the first half and its main
liability is the second.

---

## 2. The two designs

### DESIGN A — Classic venture

```
Problem → Solution → Product → Market → Traction → Business model → Competition → Team → Ask
```

**The case for it.** Judges drawn from "corporate, investment and nonprofit partners" have seen this
shape a hundred times and can follow it without effort. It is legible, it signals seriousness, and
it makes the business case explicit rather than leaving a judge to infer one.

**Attacked:**

| Dimension | Verdict |
|---|---|
| Judge comprehension | **Good.** Familiar structure, low cognitive cost. |
| Emotional engagement | **Poor.** Opens on an abstraction. "Businesses lose time to manual processes" is a category, and nobody has ever been moved by a category. |
| Evidence density | **Bad for us.** Traction and Ask are two of nine sections and both are near-empty today. It allocates 22% of the pitch to our two weakest claims. |
| Technical clarity | Neutral. |
| Memorability | **Poor.** It is the same shape as every other entry with a business plan. |
| Feasibility (scored) | **Weak.** "Product" as a described section is much less convincing than a product running. |
| Uniqueness (scored) | **Weak.** A Competition slide asserts uniqueness; it does not show it. |
| Market need (scored) | Moderate — asserted, not evidenced. |
| Impact (scored) | Moderate. |
| Implementation credibility (scored twice) | **Wasted.** The strongest thing AWE has — installed, running, provisioned twice — is buried in "Product". |
| Articulation (scored) | Neutral. |
| Q&A defensibility | **Bad.** A Traction slide with nothing on it invites the exact question we least want to spend the Q&A on, and invites it early. |

**Fatal flaw:** it spends its best minutes on the three things this rubric does not score, and it
buries the two things it does.

### DESIGN B — Proof-driven transformation

```
Real business chaos → founder discovers it → the before-state → AWE executes →
live demonstration → measurable transformation → the same pain elsewhere →
a second company, no rebuild → business model → the larger vision
```

**The case for it.** It opens inside a specific real business with a specific real person, which is
concrete, and it puts the working system in the middle where the attention is. It matches the
rubric: feasibility and implementation are *demonstrated* rather than asserted.

**Attacked:**

| Dimension | Verdict |
|---|---|
| Judge comprehension | **Good, with a risk.** A story is easy to follow; the risk is a judge who reaches minute three still thinking this is one company's internal tool. |
| Emotional engagement | **Strong.** A named person and a real Tuesday. |
| Evidence density | **Strong** — and honest, because the beats where evidence is missing are visibly the later ones. |
| Technical clarity | **Risk.** The demonstration can consume the pitch if it is not ruthlessly scoped. |
| Memorability | **Strong**, if the reframe lands. |
| Feasibility (scored) | **Excellent.** They watch it work. |
| Uniqueness (scored) | **Good** — execution versus answering is visible, not claimed. |
| Market need (scored) | **Currently the weakest point.** One company's story, told well, is still one company. |
| Impact (scored) | **Depends entirely on the baseline** existing by January. |
| Implementation credibility | **Excellent** — the second-organization provisioning is exactly this. |
| Articulation (scored) | **Strong**, if the one sentence lands early. |
| Q&A defensibility | **Strong.** Every claim traces to something, and the admissions are pre-scripted. |

**Two real flaws:**
1. **The market question arrives late** and it is the one a judge is already forming by minute two.
2. **There is no explicit business section**, and a judge who wants one and does not get one
   concludes the founder has not thought about it.

---

## 3. The selected architecture — B, with two borrowings from A

**Design B, with the business model made an explicit beat (borrowed from A), and the market beat
moved earlier than a pure story order would put it (also from A).**

Reasoning:

- **B wins on six of the eight scored criteria** and ties on the other two.
- **A's real contribution is not its order, it is its explicitness.** A judge with an unanswered
  question stops listening. So the business question gets a named beat even while its evidence is
  thin — a short honest answer beats an absent one.
- **The market beat is promoted to position 7 of 12** — immediately after the proof — rather than
  waiting for the expansion story. The question "is this just one company's software" forms early
  and must be answered before the reveal, not after it.
- **The defensibility argument is demoted to Q&A.** It is the strongest single argument AWE has, and
  it is an *answer*. Volunteered, it sounds defensive; delivered on request, it is decisive.

The result is the twelve beats in `narrative.mjs` → `BEATS`, with cut orders that collapse cleanly
to seven for the four-minute final.

### What was rejected and why

| Idea | Rejected because |
|---|---|
| Opening on the technology | Half the audience is gone before the problem arrives, and two scored criteria are about being understood. |
| Opening on a market-size number | We have no defensible one. A judge who tests an invented one finds it instantly, and everything after it is discounted. |
| A "Team" beat | Not scored, and a solo undergraduate founder is not strengthened by a slide about it. Proximity to the problem is what matters, and it belongs in beat 1. |
| An "Ask" beat | Not scored, and there is no raise. The prize question belongs in Q&A — see `use-of-funds.md`. |
| Leading with the second capability | The reveal only works after the audience has committed to a smaller reading of AWE. Reveal-first is just a claim. |

---

## 4. The one sentence — alternatives and attacks

The sentence must carry four things: **operational work**, **execution**, **the organization's own
rules**, and **human time returned**. Banned: agent, ontology, kernel, orchestration, context
assembly, capability graph, platform, LLM.

| Candidate | Attack | Verdict |
|---|---|---|
| "AWE takes repetitive operational work that currently requires employees to move information between people, paper, email and software, and executes that work autonomously under company rules." | 34 words in one breathless sentence with two subordinate clauses. "Autonomously" is doing enormous work and is the exact word that triggers "what if it's wrong?" before the safety answer has been given. **Carries no human-time payoff at all.** | Rejected — fails 1 of 4, and is hard to say. |
| "AWE does the office work that a business currently does by hand, following that company's own rules, and keeps a record of what it did." | Better. "Keeps a record" smuggles in auditability, which is genuinely differentiating. But "office work" is vague enough to include answering the phone, and again no time payoff. | Rejected — fails 1 of 4. |
| "Every business has work that is really just moving information between people, paper, email and software. AWE does that work itself, by the company's own rules, and gives the hours back." | Carries all four. But **"gives the hours back" is a measured claim we cannot currently make**, and putting an unprovable number-shaped promise in the opening sentence starts the Q&A we least want. | Rejected — on integrity, not on style. |
| **"Every business runs on work that is really just moving information between people, paper, email and software. AWE does that work itself, under the company's own rules, so the people don't have to."** | Two short sentences. All four elements. "So the people don't have to" is a description of what the software does, not a quantity — it survives Q&A. Only weakness: it does not by itself distinguish AWE from workflow automation, which is what the contrast line is for. | **Selected — spoken.** |
| "AWE is software that does a company's routine operational work — the requests, approvals, purchase orders and follow-ups — by that company's own rules, instead of leaving people to carry it between paper, email and other software." | Reads better than it speaks; the em-dash list needs eyes. Names concrete artifacts, which is what a written reader needs. | **Selected — written.** |
| "AWE does the office work itself." | Six words. Says almost nothing on its own, which is correct for a hook whose only job is to buy eight seconds. | **Selected — hook.** |

**Companion line, not part of the sentence:** *Today's AI answers questions. AWE does the work, and
it can show you what it did.* It does the differentiation the main sentence deliberately does not
attempt, and it is the sentence a judge is most likely to repeat.

**Nothing above is frozen.** The sentence is canonical in code so that changing it changes every
artifact at once; it is not final until three non-technical people have restated it correctly an
hour later. That test is the required evidence slot on beat 4, and it has not been run.

---

## 5. How the selected architecture is held to this

Everything above is enforced rather than remembered:

- Every beat names the audience question it answers; a beat without one fails the suite.
- Every beat names which published criteria it serves; a beat serving none fails the suite.
- Every criterion must be served by at least one beat.
- Every beat carries a kill condition, so cutting is a decision made in advance rather than in a
  panic in April.
- The one sentence is checked for the banned vocabulary and for length by `eval-narrative.mjs`.
