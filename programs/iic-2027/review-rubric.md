# Review rubric

**For scoring a rehearsal, not for predicting a result.**

**No probability of winning is computed anywhere in this repository, and none should be.** A number
like "68% ready to win" is unfalsifiable, moves for reasons nobody can trace, and becomes the thing
people optimise instead of the pitch. What follows is a transparent scoring sheet a human fills in
after watching a rehearsal, plus the prompts that make the reviewer useful rather than kind.

---

## Part 1 — The published criteria

Score each **0–4**, using the same bands as everything else in this directory: 0 nothing, 1 claimed
and unevidenced, 2 evidenced once, 3 evidenced repeatedly or by somebody outside, 4 evidenced
repeatedly and externally.

Criteria quoted from the 2nd annual (2019) — see `competition-intelligence.md` §2b for the caveat.

| Criterion | What the reviewer is actually judging | Which beats served it | Score |
|---|---|---|---|
| **Feasibility** | Could this be built and run? Did I see it run? | 5, 6, 9, 11 | |
| **Uniqueness** | Is this different from what already exists, in a way I could explain to somebody else? | 4, 5, 8, 10, 11 | |
| **Market need** | Does anybody outside this one company need it? | 1, 2, 3, 7, 9, 10 | |
| **Impact** | If it worked everywhere, would it matter? | 1, 3, 6, 7, 8, 10, 12 | |
| **Cost of implementation** | What does it cost to put this into a business? | 8 | |
| **Ease of implementation** | How hard is it to adopt? | 5, 8 | |
| **Idea articulation** | Could I repeat what this is, an hour later? | 3, 4, 12 | |
| **Overall impression** | Do I believe this person is building a real company? | 1, 2, 4, 5, 12 | |

Beat numbering follows `MASTER_SPEC.md` §5. Run `npm run pitch` for the live status of each beat —
**a criterion whose beats are all NOT_READY should not be scoring above 1, and if it did, the
delivery is outrunning the evidence.** That gap is the single most useful thing this sheet finds.

## Part 2 — Delivery, which the rubric does not name but the judges feel

| | Question | Score |
|---|---|---|
| Time | Did it finish inside four minutes without rushing the close? | |
| The demo | Did it work? Did it need explaining? | |
| The admissions | Were "no hours yet", "no outside users", "no revenue" delivered flat and briefly? | |
| Recovery | When something went wrong, did the room notice? | |
| Q&A | Did any answer contain a number that is not in `proof/`? | |

**A single yes to that last question is a failed rehearsal**, regardless of every other score.

---

## Part 3 — Adversarial prompts

Give these to the reviewer *before* they watch. A reviewer asked for feedback gives encouragement; a
reviewer given a job does the job.

**On comprehension**
1. In one sentence, what does this company do? *(Ask an hour later, not immediately.)*
2. What is the difference between this and ChatGPT? If you cannot say, the pitch did not tell you.
3. Which word did you have to translate while listening? Name it.

**On evidence**
4. Which number in that pitch would you check first if you were writing the cheque?
5. Which claim was supported by a demonstration, and which by a sentence? Separate them.
6. Was anything presented as real that was actually a rehearsal or a plan? Be specific.
7. What did they admit they could not prove? Did that admission make you trust them more or less?

**On the business**
8. Who buys this, and what do they already do instead?
9. If you ran a construction company, what would stop you adopting it?
10. What would you have to believe for the expansion story to be true?

**On the weakest point**
11. Where did you stop believing?
12. What was the least convincing thirty seconds?
13. If they could only keep half of it, what should go?

**On memory** — asked an hour later, without warning
14. What was the company called?
15. What problem did it solve?
16. What is one thing you remember about how it worked?

**Questions 14–16 are the highest-value part of this sheet.** Two of eight criteria are articulation
and overall impression, and both are decided by what survives an hour. Nothing else in this document
measures that.

---

## Part 4 — Rules for the reviewer

- **Do not say what was good unless asked.** Time spent on praise is time not spent finding the
  weak thirty seconds.
- **Name the moment, not the theme.** "The wedge slide was unconvincing" is unusable; "at 3:10 you
  said the same architecture runs another workflow and I did not believe it, because I had not seen
  one" is a fix.
- **Attack the numbers.** Ask "how do you know?" after any figure. The answer should be a command,
  and it should run.
- **You are allowed to be wrong.** A reviewer who is wrong about a fact has still found a place
  where the pitch failed to establish it.

---

## Part 5 — What this sheet must never become

- A score that gets tracked over time and optimised.
- A prediction of placing.
- A reason to add a slide. Every fix should be a cut, a rewrite or a piece of evidence — a rehearsal
  that produces a new slide has usually diagnosed the wrong problem.
- A substitute for `npm run pitch`, which measures evidence. **This sheet measures delivery.** When
  the two disagree — a beat scoring 3 here whose evidence slots are empty — the evidence is right
  and the delivery is writing cheques the proof layer will not cash.
