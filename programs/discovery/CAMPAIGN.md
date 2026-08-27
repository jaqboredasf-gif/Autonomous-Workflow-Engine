# The first five conversations

**Target: 5 external conversations. Then 20+ by December 2026.**

The purpose of the first five is not to find customers. It is to find out whether the pain PCC was
built for is **Lippolis's pain** or **the trade's pain**. Those lead to different companies, and
five conversations is enough to tell them apart in outline.

**Do not change the product on the strength of five interviews.** Five is enough to form a
hypothesis and nowhere near enough to act on one.

---

## Who to talk to

Businesses shaped like Lippolis: they buy material for jobs, they have a person who does that, and
that person is not the owner.

| Trade | Why | Where |
|---|---|---|
| Electrical contractors | same trade — highest signal on whether PCC transfers | IBEW/NECA chapters, supply-house counters |
| HVAC contractors | same material-to-job shape, different suppliers | ACCA chapters, distributor counters |
| Plumbing contractors | same shape again | PHCC chapters |
| General contractors | buy differently — subs and materials both; a useful negative control | AGC/ABC chapters |
| Low-voltage / fire alarm / elevator service | small shops, heavy paperwork | trade associations |

**Size matters more than trade.** Aim for **10–60 employees**. Below that the owner does everything
and there is no handoff to fix; above it they have already bought Procore or an ERP and the
conversation is about migration, not pain.

**The first five should include at least one that is not electrical.** Five electrical contractors
in Westchester will agree with each other and with Lippolis, and you will learn that Lippolis has
neighbours rather than that a market exists.

### How to reach them

In descending order of reply rate:

1. **Lippolis's own network.** Mike, Paul and Karen know their counterparts at other shops, and
   supply-house reps know everybody. Ask for an introduction, not a referral — an introduction is a
   name and a sentence.
2. **Supply house counters.** Graybar, Rexel, City Electric. The counter staff know which shops are
   organised and which are chaos, and a counter conversation is itself discovery.
3. **Trade association chapter meetings.** One evening, several conversations.
4. **Cold email/LinkedIn to the operations or office manager**, never the owner. The owner will
   send you to them anyway, and the office manager is the person who feels the pain.

### The ask

> "I'm a student building software for trades businesses. I'm not selling anything — I'm trying to
> understand how material actually gets bought on a job. Could I take twenty minutes of whoever
> handles that?"

**Twenty minutes.** Ask for twenty and take twenty. Running long is how a second conversation
stops being offered.

---

## What you are listening for

Three buckets, and every interview sorts into them:

| Bucket | Sounds like | What it means |
|---|---|---|
| **LIPPOLIS-SPECIFIC** | "we do PO numbers per job and vendor" | one customer's convention. Configuration, or nothing. |
| **REPEATED MARKET PAIN** | named unprompted by 2+ *different organizations* | this is the product |
| **POSSIBLE AWE CAPABILITY** | a pain adjacent to something AWE could do but does not | the roadmap, not the pitch |

The distinction is enforced in code: `repeatedPatterns()` counts **organizations**, not interviews.
Three people at one company describing the same frustration produce **no pattern at all**.

### Candidate pattern tags

Use these where they fit; invent snake_case tags where they do not. Consistency matters more than
elegance — a tag that never matches another is a tag that never becomes a pattern.

```
duplicate_data_entry          the same detail typed into three systems
no_visibility_of_orders       "did that ship?" has no answer without a phone call
approval_bottleneck           everything waits on one person
po_numbering_pain             numbering by hand, or duplicated numbers
material_arrives_late         the crew stands down
material_arrives_wrong        wrong item, wrong quantity, short
receiving_not_recorded        nobody knows what actually turned up
invoice_reconciliation        matching invoices to orders by hand
job_costing_gap               nobody knows what a job cost until it is over
paper_lost                    the paperwork exists somewhere
phone_intake_unrecorded       requests arrive by phone and vanish
foreman_texts_requests        requests arrive as texts to a personal phone
```

---

## The interview

**A conversation, not a survey.** The protocol in `interview.mjs` (`PROTOCOL`) is twelve questions;
these are the same questions with the trade vocabulary in them. Follow the tangents — the tangents
are the findings.

### Open — their process, never our product

> "Walk me through what happens when a crew on a job needs material they don't have. Start from the
> moment they realise."

Then stay quiet. This one question usually produces half the interview.

Follow with:
- "Who do they tell, and how — call, text, radio?"
- "Then what happens? Who picks it up?"
- "How often does that happen — a day? a week?"

### The handoffs — where the work actually lives

- "Who decides whether it gets bought?"
- "How do they find out they need to decide?"
- "How does the order actually reach the supplier — email, phone, the counter?"
- "Who writes the purchase order? What does it look like?"
- "How do you number them?"
- "When it arrives, who signs for it, and where does the packing slip go?"
- "How do you know a job's material actually turned up?"

### Steps before durations — always

Ask what the steps are first, then how long each takes. "How long does purchasing take you?"
produces a feeling. Six named steps produce six numbers they will defend.

- "How long does that bit take, when it goes normally?"

### The failures

- "When does it go wrong? What does that look like?"
- "How often — weekly, monthly?"
- "What does it cost you when it does?" — chase this. "A crew stood down for a morning" is worth
  more than any duration in the interview.
- "Has anything ever been ordered twice? Or missed entirely?"

### The neighbouring workflows — capability fit, not a pitch

Ask lightly. You are mapping, not selling.

- "Who puts proposals together, and what does that take?"
- "How do you know what a job actually cost, and when do you find out?"
- "Anything with inspections or sign-offs that generates paperwork?"
- "What gets re-typed between systems?"

### The tooling

- "What do you use for all this today?"
- "Has anyone tried to fix it? What happened?"
- "Is there a spreadsheet somebody maintains?" — a maintained spreadsheet is a workaround, and a
  workaround is a costed problem.

### The two that matter most

> "What part of this does whoever handles it **hate**?"

> "If you could make one part of the office work just disappear, which?"

These two produce the most quotable material in the whole interview, and quotes are what the
executive summary and the video are made of.

### Change and money — last, always

The money question changes every answer that comes after it, so nothing comes after it.

- "Is this something you're actively trying to fix, or something you live with?"
- "What would you expect something that fixed it to cost?"
- "Would you be willing to try something early and tell us what's wrong with it?"

---

## After the conversation — within the hour

Memory degrades fast and a transcript nobody tagged is a transcript nobody can count.

1. Write the file. `programs/discovery/interviews/iNNN.mjs`, one `interview({...})` export. The
   shape and a worked example are in `programs/discovery/README.md`.
2. **Tag it.** `patternTags` is required — an untagged interview is refused at import, because it
   cannot contribute to finding a repeated problem, which is the only reason the record exists.
3. `organization` must be the real organization. `internal: true` for anyone inside Lippolis.
4. Record `humanTimeStated` in **their words** — "about twenty minutes a purchase". It is testimony
   about their own work. It is a candidate baseline **for their organization** and never evidence
   about ours.
5. Quote `pain` and `economicConsequence` as close to verbatim as you can manage.
6. `willingnessToPay: 'WOULD_PAY_STATED_AMOUNT'` requires `statedAmount` — the code refuses the
   claim without the figure.
7. Run `node scripts/iic-readiness.mjs`. The bands move on their own.

---

## After five — the comparison

Sit down with all five and answer three questions in writing:

1. **Which pains did 2+ different organizations name unprompted?** `repeatedPatterns()` gives the
   list; you decide which are real.
2. **Which pains did only Lippolis name?** Those are configuration or they are nothing.
3. **Which repeated pains does AWE already address, and which does it not?** The second list is more
   interesting than the first, and it is the roadmap.

Then stop and **do not change the product.** Five interviews is a hypothesis. Twenty is a finding.

The one decision worth making at five: **who to go back to.** Anybody who said "actively looking" or
offered to try it early is a design-partner candidate, and a design partner is the cheapest route
to the second deployment.
