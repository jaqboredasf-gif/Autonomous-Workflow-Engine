# Jack — the first five conversations

**Open this on your phone during the call.** The script is the middle section; everything else is
before and after.

**What you are trying to find out:** whether the problems you watched at Lippolis happen at other
construction businesses. **Not** whether people like AWE. Those are different questions and only
one of them is worth five conversations.

**You are allowed to come back and say the answer is no.** That is a real result, it is cheap to
get now and expensive to get later, and `npm run discovery` is built to show it.

---

# WHO TO TALK TO

**Businesses shaped like Lippolis:** they buy material for jobs, somebody in an office does that,
and it is not the owner.

| Trade | Why |
|---|---|
| Electrical | same trade — the highest signal on whether PCC transfers at all |
| HVAC | same material-to-job shape, different suppliers |
| Plumbing | same shape again |
| Low-voltage / fire alarm / elevator service | small shops, heavy paperwork |
| General contractor | buys differently — a useful negative control |

**Size matters more than trade: 10–60 employees.** Below that the owner does everything and there
is no handoff to fix. Above it they have already bought Procore or an ERP and the conversation is
about migration, not pain.

**Make at least one of the five not electrical.** Five electrical contractors in Westchester will
agree with each other and with Lippolis, and you will have learned that Lippolis has neighbours.

## Who inside the company

**Ask for whoever handles material ordering.** Usually an office manager, operations manager or
purchasing coordinator.

- **Best:** the person who does it, plus five minutes with the owner at the end.
- **Not the owner alone** — they will describe the process they believe exists.
- If you can only get the owner, ask them to describe the last order *they personally* watched go
  wrong.

## How to ask

> "I'm a student building software for trades businesses. I'm not selling anything — I'm trying to
> understand how material actually gets bought on a job. Could I take twenty minutes of whoever
> handles that?"

**Ask for twenty minutes and take twenty.** Running long is how a second conversation stops being
offered. Warm introductions first: Mike, Paul and Karen know their counterparts, and supply-house
counter staff know everybody.

---

# THE CONVERSATION — 20 to 30 minutes

## Do not open by explaining AWE

If you describe the product first, everything after it is a reaction to your idea instead of a
description of their week. If they ask what you are building, say: *"Software for the office side of
trades work — but I'd rather hear how you do it now first, or I'll just build what I already
think."* Then tell them properly at the end.

## 1. Their process — 8 minutes

> "Walk me through what happens when somebody on a job needs material. Start from the beginning."

Let them talk. When they stop:

> "Who touches it, and in what order?"
> "How does it reach you — phone, text, in person?"
> "What do you use to do it — paper, spreadsheet, something else?"
> "Then what happens? Who approves it?"
> "How does the vendor find out?"
> "How do you know it arrived?"

## 2. The last time it went wrong — 8 minutes

**The most valuable question of the interview.**

> "Tell me about the last time an order went wrong. What happened?"

Then:
> "How often does that happen — a week, a month?"
> "What did it cost you when it did?"
> "Who had to fix it?"
> "What did you do about it afterwards? Has anybody built a workaround?"

Stories are evidence. "It's frustrating" is not.

## 3. The rest of the office — 5 minutes

> "Is there anything else in the office that eats time like that?"
> "What's the job everybody puts off?"
> "If one part of this disappeared tomorrow, which would you pick?"

This is where a pain AWE does not solve shows up. **Write it down anyway** — it is the most useful
thing you can bring back.

## 4. Change and money — last, always — 5 minutes

Asking earlier changes every answer before it.

> "Is this something you're actively trying to fix, or something you live with?"
> "Have you looked at anything? What happened?"
> "What would you expect something that fixed it to cost?"
> "Would you be willing to try something early and tell us what's wrong with it?"

Then, only now, tell them what you are building. Their reaction is worth having *after* they have
described their own process.

## What not to say

| Do not | Because |
|---|---|
| "Would automation help you?" | Everybody says yes. It is worth nothing. |
| "Do you have a problem with X?" | You have handed them the answer. Ask what happens, not whether it is bad. |
| "We can solve that" | The moment you say it, they stop describing and start evaluating. |
| "Most contractors we talk to..." | You have talked to four. |
| Fill a silence | The sentence after a pause is usually the honest one. |

---

# IMMEDIATELY AFTER — 10 minutes, before the next thing

Do it in the car. Memory decays fastest in the first hour, and it decays toward what you hoped
they said.

Write one file: `programs/discovery/interviews/<org>-<date>.json`

```json
{
  "id": "acme-2026-10-14",
  "at": "2026-10-14",
  "organization": "Acme Electric",
  "organizationType": "electrical",
  "organizationSize": "~35 employees",
  "role": "office manager",
  "workflow": "material request to receipt",

  "pain": { "value": "requests arrive by text and get lost", "said": "STATED",
            "quote": "half of them are on my phone and half are on a Post-it" },
  "frequency": { "value": "several a day", "said": "STATED" },
  "humanTimeStated": { "value": "20 minutes per order", "said": "STATED" },
  "economicConsequence": { "value": "a crew stood down for a morning last month", "said": "STATED" },
  "existingWorkaround": { "value": "a shared spreadsheet nobody updates", "said": "STATED" },
  "satisfactionWithWorkaround": { "value": "hates it", "said": "FOUNDER_OBSERVED" },
  "urgency": { "value": "wants it fixed this year", "said": "STATED" },

  "currentTools": ["paper", "text messages", "QuickBooks"],
  "failureModes": ["wrong quantity", "ordered twice"],
  "willingnessToChange": "ACTIVELY_LOOKING",
  "willingnessToPay": "NOT_ASKED",
  "patternTags": ["material_request_fragmentation", "repeated_data_entry"],
  "designPartnerInterest": true,
  "followUp": "send a note; owner is Dave, back from holiday the 28th",
  "notes": "..."
}
```

## The one rule that keeps this honest

**Every interpreted field says who it came from.**

| `said` | Means |
|---|---|
| `STATED` | they said it, in substance |
| `FOUNDER_OBSERVED` | you saw it — a sigh, a stack of paper, three people looking for the same order |
| `FOUNDER_INFERRED` | you concluded it |

The last two name you on purpose. In six weeks the difference between "the operations manager told
me a crew stood down" and "I worked out that a crew must have stood down" is the whole difference
between evidence and a hunch, and it is the first thing anybody serious will ask about.

`FOUNDER_INFERRED` is legitimate and it is **not customer testimony**. Six weeks from now you will not
remember which was which, and a judge will ask. The file refuses a bare value for these fields for
exactly that reason.

**`quote` on the pain, if you have their words.** One sentence they actually used is worth a
paragraph of your summary.

## Tags

Use the ones in `programs/discovery/patterns.mjs` where they fit. **Invent a snake_case tag where
they do not** — a pain nobody predicted is a finding, and the report prints new tags prominently.
Never change what they said to fit a tag; the tag sits beside their words, not over them.

---

# THEN

```bash
npm run discovery
```

It shows what more than one outside organization described independently, which pains AWE cannot
address, which AWE pains nobody has corroborated, and who might be a design partner.

**Three of them count nothing until two different organizations say the same thing.** Three people
at one company agreeing is one company's opinion.

## After five

- **Same pains recurring, and AWE addresses them** → keep going to twenty; start qualifying partners.
- **Same pains recurring, and AWE does not address them** → the wedge is wrong and you found out
  after five conversations instead of after a year. This is the best possible outcome per hour spent.
- **No pattern at all** → your five were too similar, or the segment is wrong. Change one thing —
  the trade, or the size — and do five more.

**Do not change the product on five interviews.** Five is enough to form a hypothesis and nowhere
near enough to act on one.
