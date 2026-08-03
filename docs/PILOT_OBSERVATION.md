# First operator pilot — what to watch

For Jack, during the pilot. Not for the coworker.

The purpose of this pilot is **not** to find out whether the coworker can use
the tool. It is to find out where the tool fails to explain itself. Every
hesitation is a defect report that has not been written down yet.

## The one rule

**Do not help.** Sit where you can see the screen, say "just carry on as if I
weren't here", and write down what happens. The moment you explain something,
that explanation leaves the room with you and the system never learns it.

If they get genuinely stuck for more than five minutes, help — but write down
*exactly what you had to say*, because that sentence is the missing
documentation, verbatim.

---

## Before they arrive

- [ ] Build a fresh package: `python packaging/build_package.py --zip`
- [ ] Put `dist/TEGG-Report-Tool.zip` somewhere they can get it
- [ ] Confirm they have a TEGG login that works in a browser
- [ ] Decide whether you are giving them a real rate card. **Recommended: no.**
      Let the pilot run on the template so nothing they produce can be mistaken
      for a quote.
- [ ] Have this checklist open, and something to write on

---

## What to record

For every item below, write the **time**, what they **did**, and what they
**said**. Verbatim where you can — paraphrase loses the thing you need.

### 1. Receiving it

- [ ] Where did they put the folder? (Desktop? Downloads? Somewhere odd?)
- [ ] Did they open `START HERE.txt`, or go straight for a `.command` file?
- [ ] Did they read it all, or skim and stop?
- [ ] **Which file did they try to open first?** This is the single most
      informative thing in the whole pilot.

### 2. Setup

- [ ] Did macOS block the `.command` file? Did they work out the right-click
      fix from `START HERE.txt`, or get stuck?
- [ ] Did they have Python 3.10+? If not, did the instruction get them there
      without help?
- [ ] How long did setup take? Did they think it had frozen?
- [ ] Did they understand what "storing your sign-in in the Keychain" meant, or
      did it worry them?
- [ ] Did they type their password confidently, or hesitate? *(If they
      hesitated, the tool has not earned trust yet — note why.)*

### 3. First run

- [ ] Did they find `Run Report.command` without being told?
- [ ] **Did they wait, or double-click again?** The progress lines exist for
      exactly this. If they still double-clicked, the lines are not enough.
- [ ] Did they read the progress messages, or look away?
- [ ] What did they expect to happen when it finished?

### 4. The output

- [ ] Did they find `review.md`? Did the folder opening automatically help?
- [ ] Could they open a `.md` file at all? *(This is a real risk — note what
      they used.)*
- [ ] **What did they read first?** Top to bottom, or straight to the numbers?
- [ ] Did they notice the DRAFT banner? Ask afterwards: *"is this a quote?"*
      If they say yes, that is a serious finding.
- [ ] Did they understand "confidence: LOW"? Ask: *"what would you do about
      that?"*
- [ ] Did they understand why some items had no price?
- [ ] Did they understand that the money was not real? Ask directly.

### 5. Terminology

Write down every word they had to think about. Candidates already suspected:

- [ ] "site visit" vs "job"
- [ ] "scope item"
- [ ] "ancillary" / "mobilization"
- [ ] "provenance" / "evidence"
- [ ] "clarification" / "blocking question"
- [ ] "rate card"
- [ ] "confidence"
- [ ] "agreement"
- [ ] "escalate"

### 6. What they tried to do that the tool does not do

- [ ] Did they try to choose a different site visit? How?
- [ ] Did they try to edit anything?
- [ ] Did they try to send or share the result?
- [ ] Did they ask "can it just do X"? Write down every X.

### 7. Failure and recovery

Only if it happens naturally. **Do not stage a failure on a first pilot** —
you will learn more from a clean run, and a manufactured problem teaches them
to distrust it.

- [ ] If something failed, did the message tell them what to do?
- [ ] Did they find `OPERATOR_GUIDE.md`? Did they use it?
- [ ] Did they know whether it was safe to run it again?

---

## Questions to ask afterwards

Ask these in this order. Do not lead.

1. "Walk me through what you think just happened."
2. "What would you do with this report?"
3. "Is there anything in it you would not trust?"
4. "Is this a quote you could send a customer?"
5. "What was the most annoying part?"
6. "Was there a moment you thought it had broken?"
7. "If you had to do this again next week, would you need me?"

Question 4 is the safety question. Question 7 is the readiness question.

---

## How to turn what you saw into system changes

Every observation becomes exactly one of these. Sort them the same day, while
you still remember the tone of voice.

| what you saw | what it becomes |
|---|---|
| they asked a question you answered | **documentation** — the answer, in your words, in `OPERATOR_GUIDE.md` |
| they did something wrong and the tool allowed it | **validation** — refuse it, and say why |
| they did something correct but tedious | **automation** — do it for them |
| they needed a value only you knew | **configuration** — with the question written next to it |
| they hesitated over a word | **terminology** — rename it in the output, not in their head |
| the tool did the right thing and they could not tell | **output** — say it louder |
| another business would hit the same thing | **platform capability** — into `awe_runtime` or `awe_estimating` |

Record each one in `docs/COWORKER_READINESS.md` under a new pilot section, with
the observation next to the change. The observation is the evidence; without it
the change is just an opinion.

---

## What would make this pilot a success

Not "they completed a run". This:

- [ ] They completed a run **without asking you anything**.
- [ ] They correctly said the money was not real.
- [ ] They correctly said it was not a quote.
- [ ] They could say what they would do next with the report.
- [ ] They could say what they would do if it failed.

Four out of five is a good first pilot. Five is unlikely and you should be
suspicious of it.

## What would make it a failure worth having

- They could not install it. *(Fix the setup path.)*
- They thought the money was real. *(Fix the banner — this is the dangerous
  one.)*
- They asked you more than three questions. *(Each is a documentation gap.)*
- They completed it and could not say what it was for. *(Fix the report's first
  screen.)*

None of those are the coworker's fault, and none of them are failures of the
pilot. They are the pilot working.
