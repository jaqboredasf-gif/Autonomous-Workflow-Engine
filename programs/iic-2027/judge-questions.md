# The questions that would hurt

Not an FAQ. The questions a hostile, competent judge — or a customer's finance director, which is
the same conversation with money on it — would ask, and where the honest answer comes from.

**Every answer is either derivable today or is an admission.** Nothing here is a talking point. If
an answer needs a number, the command that produces it is named, and if the software refuses to
produce that number, so does the answer.

Each entry carries: the **answer**, its **evidence**, its **weak spot**, the **evidence still
needed**, and the **overclaim that is prohibited**. The last one is the most useful field in the
document — under pressure, the tempting sentence is always the one that is slightly more than true.

**Rehearse the three that end in an admission** — hours, external users, revenue — until saying them
is boring. An admission delivered smoothly reads as rigour; the same admission delivered badly reads
as a gap somebody has just found.

---

## Understanding it

### 1. "What exactly is AWE?"

**Answer.** Every business runs on work that is really just moving information between people,
paper, email and software. AWE does that work itself, under the company's own rules, so the people
don't have to.
**Evidence.** `programs/iic-2027/narrative.mjs` → `ONE_SENTENCE`; the demonstration.
**Weak spot.** It does not by itself distinguish AWE from workflow automation. That is what question
2 is for, and the contrast line handles it: *today's AI answers questions; AWE does the work, and it
can show you what it did.*
**Still needed.** Three non-technical people restating it correctly an hour later. Not yet done.
**Prohibited.** "A platform for autonomous business execution." True, and it means nothing to
somebody hearing it for the first time.

### 2. "Why isn't this ChatGPT?"

**Answer.** An assistant answers a question and hands the work back to you. AWE does the work:
it applies this company's rules about who may approve what, produces the purchase order under the
company's own numbering, records what it did, and stops at the boundary the company set. And it
knows the organization — the roles, the limits, the vendors — without being told each time.
**Evidence.** The demonstration; `capability/purchasing/profile.mjs`;
`scripts/eval-purchasing-authorization.mjs`.
**Weak spot.** A judge may say an assistant plus integrations could do this. The answer is
governance and evidence, not capability: an assistant cannot refuse to send an email because a
database constraint forbids it, and cannot tell you afterwards whether the objective was achieved.
**Still needed.** The competitive analysis in `competitive-positioning.md` — currently empty.
**Prohibited.** Claiming assistants cannot do parts of this that they plainly can.

### 3. "Why can't Microsoft or OpenAI build this?"

**Answer.** They could build the general parts, and probably will. What is hard to build centrally
is the part that is specific to one organization: its rules, its roles, its approval limits, its
vendors, and the evidence of what was actually achieved for *that* company. That is earned per
customer, not shipped.
**Evidence.** The organization profile; the second-organization provisioning.
**Weak spot.** This is a real risk and the answer is a bet, not a proof. Say so.
**Still needed.** More than one real organization, which is the only thing that turns the bet into
evidence.
**Prohibited.** "We have a technical moat." We do not, and a judge from a technology company will
know it.

### 4. "What is proprietary?"

**Answer.** Not the models — those are commodity. What is ours is the way an organization's rules
and structure are represented so that the same product runs a different company without a rewrite,
and the measurement layer that reports whether the organization's objective was achieved rather than
whether a task completed.
**Evidence.** `capability/purchasing/profile.mjs` (88% of the profile is configuration, measured);
`proof/`.
**Weak spot.** "88% configuration" is measured against our own profile definition. Do not present it
as an industry metric.
**Still needed.** A second real customer, which is what would prove the representation generalises.
**Prohibited.** Any claim of patents, or of unique technology. There are none.

---

## The evidence

### 5. "You say it saved time. How do you know?"

**Answer.** Today: **we do not, and the system says so.** The case study prints `NOT MEASURABLE` for
hours returned, because nobody has yet timed how the work was done before. That is not modesty — the
software refuses to produce the figure. A baseline with an unmeasured step has no total, and every
figure downstream of it is unavailable. What we *do* know, measured: how many executions ran, how
many objectives were achieved, how many times a human had to intervene, and how long the process
takes end to end now.
**Evidence.** `node scripts/proof-case-study.mjs --db … --org … --from … --to …`
**Weak spot.** It is a real gap and it is the most important number in the pitch.
**Still needed.** The Lippolis baseline. `docs/proof/BASELINE_METHODOLOGY.md` §8 lists three ways to
recover most of it without watching anybody work.
**Prohibited.** Any estimate of hours. Not "roughly", not "we think about".

### 6. "So it doesn't do anything?"

**Answer.** It does the work. What we cannot yet state is its value in hours, because we did not
measure the old process before switching it off. That was a mistake, it is recoverable, and the
method for recovering it is written down.
**Evidence.** The demonstration; `docs/proof/BASELINE_METHODOLOGY.md` §8.
**Weak spot.** None — this is the honest answer and it lands well when delivered without defence.
**Prohibited.** Getting defensive. The mistake is admitted in one clause and the answer moves on.

### 7. "How do we know these numbers weren't tuned for this pitch?"

**Answer.** The proof modules are pure — no clock, no randomness, no I/O, no network, no model. The
suite greps them for `Date.now`, `Math.random` and `new Date()`. The same database and the same
period reproduce the same figure byte for byte, and the audit chain behind any figure is one flag
away: `--explain`.
**Evidence.** `scripts/eval-proof.mjs`.
**Weak spot.** None. This is the strongest answer in the document.
**Prohibited.** Nothing — but do not volunteer it. It is worth more as an answer than as a claim.

### 8. "Every workflow tool claims a success rate. What's different about yours?"

**Answer.** Most report that a task completed. We report whether the organization's **objective** was
achieved, which is a different question and usually a lower number. A purchase order can be issued
perfectly for material that arrived three days late: our system records that as one execution
succeeded and one objective failed, from two different sets of columns.
**Evidence.** `proof/adapters/purchasing.mjs` → `materialObjective()`.
**Weak spot.** "Most workflow tools" is a claim about other people's products that we have not
researched.
**Still needed.** `competitive-positioning.md`, filled in with sources.
**Prohibited.** Naming a specific competitor's behaviour without having checked it.

### 9. "Isn't that just a lower number you chose to report?"

**Answer.** It is a lower number the software will not let us not report. Objective success gates
valuation: an execution whose objective was not achieved returns **negative** minutes — the attempt
cost real human time and displaced nothing — and those negatives are summed into the period total
rather than excluded.
**Evidence.** `scripts/eval-proof.mjs` asserts it.
**Weak spot.** None.

### 10. "What stops you counting the same saving twice?"

**Answer.** Every execution names a `scopeKey` — the thing in the real world it worked on. The ledger
banks one unit of work once, folds earlier attempts' human cost into the attempt that finally
counted, and reports how many duplicates it collapsed. Two baselines pricing the same human work for
one organization are refused outright at the point they would be used.
**Evidence.** `proof/ledger.mjs`.
**Weak spot.** None.

---

## The market

### 11. "Do you have customers outside the first company?"

**Answer.** No. One organization is deploying it. That is the honest state, it is the weakest thing
about the whole project, and it is what the readiness scorecard's recommended next action has been
pointing at since the day it was written.
**Evidence.** `npm run readiness`.
**Weak spot.** This is the gap. There is no way to dress it.
**Still needed.** External interviews, then a design partner.
**Prohibited.** Describing the synthetic second company as a customer, a deployment, a pilot, or a
partner. It is a rehearsal, it is described as one, and this is the single most damaging available
overclaim.

### 12. "How large is the market?"

**Answer.** I do not have a defensible number, so I am not going to give you one. What I can tell
you is who has the problem and how I know: [n] conversations with [n] contractors, and the pains
they named without being prompted.
**Evidence.** `programs/discovery/`.
**Weak spot.** With zero interviews today this answer is currently empty, and there is no substitute.
**Still needed.** Interviews. Below five, there is nothing to say.
**Prohibited.** Any top-down sizing — "the US construction industry is $2 trillion, if we capture
0.1%…". A judge who has seen one of those before has seen a hundred, and it discredits everything
around it.

### 13. "Why construction?"

**Answer.** Because that is where I found the problem, not because I modelled the market. It is a
good wedge: the work is high-volume, rule-bound and mostly still on paper, the businesses are large
enough to feel the cost and small enough to decide quickly, and nothing in what we built is specific
to electrical work.
**Evidence.** The founder story; `proof/organization.mjs` knows nothing about purchasing.
**Weak spot.** "Nothing is specific to construction" is an architectural claim, not a demonstrated
one.
**Prohibited.** Implying construction was chosen after a market analysis. It was not.

### 14. "Why wouldn't companies use their existing ERP?"

**Answer.** Many will, for the parts it covers. What ERPs do well is record what happened. What they
do not do is *carry out* the work between the records — the request, the chase, the approval, the
follow-up — which is where the hours actually go. AWE is not trying to replace the system of record;
it does the work that ends in one.
**Evidence.** The first customer's own workflow: QuickBooks, a spreadsheet, and Outlook —
`docs/planning/CURRENT_WORKFLOW.md` §5.
**Weak spot.** Some ERPs do have workflow modules and we have not evaluated them.
**Still needed.** `competitive-positioning.md`.
**Prohibited.** Claiming ERPs cannot do workflow. Several can.

---

## The business

### 15. "Who pays, and how much?"

**Answer.** The business owner or the operations manager — the person whose staff currently do the
work. Pricing is not yet established, and the readiness scorecard scores it at zero for that reason.
The plan is to price against measured value; there is no measured value yet, so a price now would be
a number with nothing behind it.
**Evidence.** `npm run readiness`.
**Weak spot.** A judge may read this as not having thought about it. Follow with the *unit*
question — per capability, per organization, per execution — which is a real decision and can be
answered.
**Still needed.** A defined unit of sale, then a price put to a real prospect.
**Prohibited.** Inventing a price to sound prepared. A made-up price invites "how did you get to
that?", which is a worse conversation than "I haven't priced it yet".

### 16. "What has someone actually paid?"

**Answer.** Nothing. Nobody has been asked to pay.
**Weak spot.** It is a one-word answer and should stay one. **There is no revenue criterion in the
published rubric.**
**Prohibited.** Counting anything internal as revenue. Counting a salary as revenue.

### 17. "How hard is deployment?"

**Answer.** For a second organization, the product does not change: we provisioned one end to end
with zero source changes, and 88% of what makes a company different is configuration rather than
code. What I cannot tell you yet is how long a *real* second installation takes, because the second
organization we provisioned was synthetic — a rehearsal, deliberately, to prove the architecture
before spending a customer's time on it.
**Evidence.** `scripts/eval-second-customer.mjs`; `COMPANY_B_PROVISIONING_CHECKLIST.md`;
`npm run readiness` for the measured percentage.
**Weak spot.** The rehearsal caveat must be said before a judge finds it. Said first, it reads as
rigour; found later, it reads as concealment.
**Still needed.** One real external installation, timed.
**Prohibited.** Any elapsed-time claim for a real deployment. There has not been one.

### 18. "Is this custom software for the first company?"

**Answer.** It started as one thing for one company and it is not that any more. The measured answer:
88% of what differs between organizations is configuration, a second organization was provisioned
and driven through the entire purchasing lifecycle with no source change specific to it, and the
measurement layer knows nothing about purchasing at all — a second, unrelated workflow plugs into it
through an adapter.
**Evidence.** `capability/purchasing/profile.mjs`; `proof/organization.mjs`; `proof/adapters/tegg.mjs`.
**Weak spot.** All of that is architecture. The only thing that settles it is a second real company.
**Prohibited.** Presenting the synthetic second organization as anything but synthetic.

---

## The risks

### 19. "What happens when the AI gets it wrong?"

**Answer.** Nothing autonomous leaves the building. Vendor email is draft-only, enforced by a
database constraint rather than by a setting — a human reviews every outbound message. That is a
business rule the customer chose, and it is why the human-intervention count is a headline figure
rather than an embarrassment: we report how often a person had to step in, because that is the
number that tells you whether to trust it.
**Evidence.** `scripts/eval-purchasing-authorization.mjs`; the demonstration.
**Weak spot.** A judge may ask what happens as the constraint is relaxed. The honest answer: it is
relaxed per customer, per capability, on evidence — not on a roadmap.
**Prohibited.** "It doesn't make mistakes."

### 20. "What if AWE makes things worse?"

**Answer.** It can, and the system is built to show it. An execution whose objective was not achieved
counts as *negative* time — the attempt cost somebody real minutes and displaced nothing — and those
negatives are summed into the total rather than excluded. If AWE made a workflow worse, the case
study would say so before anybody else noticed.
**Evidence.** `proof/ledger.mjs`; `scripts/eval-proof.mjs`.
**Weak spot.** None. This is the second-strongest answer in the document.

### 21. "Can an employee approve their own actions? How is company data protected?"

**Answer.** Authority is enforced by the system, not by convention: who may approve what, at what
value, is part of the organization's profile, and the checks are asserted by the suite. Each
organization's data is isolated at the database level, and that isolation is tested rather than
assumed — including the case where one organization's staff might see another's names.
**Evidence.** `scripts/eval-purchasing-isolation.mjs`; `scripts/eval-purchasing-authorization.mjs`.
**Weak spot.** No external security review has been done, and a customer with a finance director
will want one.
**Still needed.** An independent review. It is a candidate use of the prize.
**Prohibited.** Any claim of certification or compliance. There is none.

### 22. "Why are you the person to build this?"

**Answer.** Because I was doing the work. I mapped the workflow before building anything so I would
not automate the wrong process, and the record of that is older than the product.
**Evidence.** `docs/planning/BOSS_INTERVIEW.md`, `CURRENT_WORKFLOW.md`.
**Weak spot.** Solo undergraduate founder. **There is no team criterion in the published rubric**, so
do not over-answer it.
**Prohibited.** Anything in `founder-story.md` under *Prohibited*.

### 23. "What would you do with the $10,000?"

**Answer.** See `use-of-funds.md`. Today the honest answer is that money is not the constraint — the
next three things this needs are a morning with a stopwatch, five phone calls and a signature — and
the answer in April depends on which of those has happened.
**Weak spot.** "I don't need the money" is not the answer; the answer is a specific costed thing
that the money makes happen sooner.
**Prohibited.** "Marketing and development."

---

## Preparing this

1. **Say every prohibited sentence out loud once**, so it is recognisable under pressure. The
   overclaim is always the fluent one.
2. **Any answer that needs a number: run the command first.** If it does not run, the answer is an
   admission, not a number.
3. **The three admissions are rehearsed until flat.** Hours, external users, revenue.
4. **Never answer a question with more than three sentences.** A long answer to a hard question is
   read as discomfort, whatever it contains.
