# The demonstration

The demonstration is the only moment the audience sees the product instead of hearing about it, and
it is worth four of the eight scored criteria: feasibility, uniqueness, ease of implementation and
overall impression. It is engineered as its own artifact.

**The audience must leave with exactly two things:**

> **What the human used to do.**
> **What AWE just did instead.**

Anything on screen that does not serve one of those two is cut, however impressive it is.

---

## 1. The primary demonstration

**One workflow, complete, 60–75 seconds.** Material purchasing, because it is the only capability
with production evidence and because everybody in the room understands buying something.

```
  A person in the field needs material
        ↓
  AWE reads the request and classifies it
        ↓
  The company's own rules are applied — who may approve what, at what value
        ↓
  The approval goes to the right person, in the right form
        ↓
  A purchase order is produced, numbered under the company's own sequence
        ↓
  The vendor message is DRAFTED — and stops there, by a database constraint
        ↓
  Every step is recorded, and the objective is tested separately from the task
```

### Specification

| | |
|---|---|
| **Setup** | The system already open on the request list. No login, no navigation, no "let me just…". The first frame is the product doing its job. |
| **Input** | One realistic material request, read aloud as it is entered. Real vendor, real job, real material, a real quantity. |
| **Visible** | The request; the classification; the rule being applied and *why that person*; the approval; the numbered PO; the drafted vendor email; the audit record. |
| **Hidden** | Configuration, admin, the profile, the schema, the deployment, anything requiring an explanation of AWE's internals. |
| **Runtime** | 60–75 seconds. Above 90 the audience starts reading the screen instead of listening. |
| **Expected output** | A numbered purchase order and a drafted, unsent vendor email. |
| **Narration rule** | **Narrate the human, not the software.** "This used to be a phone call to the office" — not "the system now classifies the request." |
| **Shown afterwards** | The proof beat: what happened over the whole period, not just this one. |

### What is deliberately not demonstrated

- Typing prompts. Watching text generate is the least interesting thing a computer can do on a stage.
- More than one capability. The second capability is *revealed*, not demonstrated — see §5.
- Anything requiring the audience to hold a concept in memory to understand the next step.
- Error handling, edge cases, the admin surface. All real, all Q&A.

**The single most important design decision: nothing autonomous leaves the building, and that is
shown rather than said.** The vendor email is drafted and stops. It is the answer to "what happens
when the AI is wrong", delivered before anyone asks.

---

## 2. Resilience

A competition cannot depend on Wi-Fi and luck. Four tiers, each telling the same story, computed by
`artifacts.mjs` → `bestDemoTier(facts)`.

| Tier | What | Requires | Loses |
|---|---|---|---|
| **PRIMARY** | the real deployment, driven live against production data | a production deployment, a network | nothing |
| **BACKUP A** | the same packaged artifact, run locally against a rehearsal database | a laptop | the claim that this data is real |
| **BACKUP B** | a screen recording of the primary, **narrated live** | a file | the sense that it is happening now |
| **BACKUP C** | four printed screens: request, rule, approval, purchase order | paper | motion, and the sense that the system acts |

**Rules that are not negotiable:**

1. **No fake production evidence is ever recorded.** A recording is made of something that actually
   happened. If the primary has never run against production data, the recording is of a rehearsal.
2. **A rehearsal is labelled out loud, every time.** "This is running against a rehearsal database,
   not the live system" costs two seconds and is the difference between rigour and a
   misrepresentation somebody could catch.
3. **The recording is narrated live, never voiced over.** A voiced-over video is a video; a
   narrated recording is still a person presenting.
4. **Backup C exists from the start.** It is four sheets of paper and it makes total technical
   failure survivable.

**Today the best available tier is BACKUP A** — the artifact is installable, nothing has run in
production. `npm run pitch` reports the current tier.

---

## 3. Rehearsal

The demo is rehearsed to the point of boredom, not to the point of competence.

- Rehearse the **failure path**: unplug the network mid-demo and continue into Backup B without
  commenting on it. That transition is what separates a recovered demo from a lost pitch.
- Rehearse **the narration without the screen**. If the story does not survive the screen going
  black, the story is the screen.
- Time it. Every time. Record the count in `facts.mjs` → `narrative.mockPitches`.

---

## 4. The demo's relationship to the proof beat

The demonstration proves the system **can** do it. It proves nothing about what it **has** done, and
conflating the two is the most common way a technical pitch overclaims.

> "That is one request. Here is what happened over three months."

The demo is capability. The proof beat is evidence. They are adjacent and they are not the same
claim, and the sentence above is the seam.

---

## 5. The wow moment

The point where understanding shifts from *interesting automation* to *this is a platform*.

### Candidates evaluated

| Candidate | Assessment |
|---|---|
| **A second, unrelated workflow through the same architecture** | Reframes everything already shown. The audience has spent three minutes filing AWE as "a purchasing app"; the reveal makes that reading wrong, retroactively. It is a product truth, not an effect. Needs the second capability to be visible — architecture-grade today. |
| **A second organization, provisioned with no source change** | Directly serves two scored criteria (cost and ease of implementation) and answers "is this custom software" definitively. Weakness today: the second company is synthetic, and saying so out loud — which is required — takes most of the force out of it. |
| **"How do you know?" — tracing a headline number to individual executions** | Extremely strong, and almost nothing in the category can do it. Weakness: it needs a real number to trace, and there is none. |
| **Organization-level value accumulation** | Conceptually the biggest idea here and the hardest to convey in a competition. Needs evidence that does not exist. |
| **Anything animated** | Rejected outright. A wow moment that survives being described in a sentence afterwards is a product truth; one that does not is a transition effect. |

### Selected

**PRIMARY — "PCC is not the company."** Delivered immediately after the proof beat, at the moment
the audience is most confident they have understood the scope. One line, then the second workflow,
then the second organization. It works whether or not the second organization is real, because the
*architectural* claim is true today and is stated as an architectural claim.

**SECONDARY — "How do you know?"** Held for Q&A, where it is worth more. It is the single strongest
answer AWE has to the single hardest question, and it lands best when a judge has asked for it.
Becomes the primary candidate if a defensible production figure exists by January.

**The sentence the wow moment turns on:**

> Purchasing is not what AWE is. It is the first thing we pointed it at.

---

## 6. What would make this demonstration better, in order

1. **Production data.** Everything else is a substitute for it.
2. **A second capability visible on screen** rather than described. Today it is an adapter and a
   test, which is real engineering and is not watchable.
3. **A measured before-time for one step**, so the narration can say "this took eleven minutes" and
   have it be true.
4. **A real second organization**, which converts the reveal from an architectural claim into a fact.

All four are evidence, not production values. None of them is a design problem.
