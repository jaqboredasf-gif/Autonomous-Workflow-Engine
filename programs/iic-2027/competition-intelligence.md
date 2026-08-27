# Competition intelligence — Iona Innovation Challenge

**Retrieved 2026-08-27 from official Iona University sources.** Every fact below carries the URL it
came from. Anything not stated on those pages is left `UNKNOWN` — an assumption in this file would
be the same failure the proof architecture exists to prevent, applied to a different subject.

---

## 1. VERIFIED — the calendar, and why it matters more than it looks

| Fact | Value | Source |
|---|---|---|
| Competition | Iona Innovation Challenge, run by the Hynes Institute for Entrepreneurship & Innovation | [official page] |
| Launched | 2018 | [official page] |
| 2026 edition | **9th annual** | [kickoff announcement] |
| **2027 edition** | **10th annual** — the one we are entering | derived from the above |
| 9th annual kickoff | **Friday 6 February 2026**, noon–2 p.m., Hynes Institute | [kickoff announcement] |
| 9th annual final | **30 April 2026** | [final announcement] |
| Finalist notification | "by mid-April" | [official page] |
| Final pitch event | "first week of May" | [official page] |
| Cadence | Milestones run across the **spring semester** | [official page] |

### The correction this forced

The repository's milestone plan assumed evidence could be assembled through **April 2027**. It
cannot. If the 10th annual follows the 9th:

```
  early Feb 2027    kickoff — registration and Milestone 1 begin
  Feb–Mar 2027      Milestone 1 (video), Milestone 2 (summary), Milestone 3 (deck)
  mid-Apr 2027      finalists notified
  late Apr / 1st wk May 2027   final pitch
```

**Milestone 1 is a 1-minute video pitch, due within weeks of a February kickoff.** So the evidence
that appears in the submission has to be *already collected and frozen* by roughly **31 January
2027** — not April. That is about five months from today, and it moves the real deadline forward by
a full quarter. `milestones.mjs` has been corrected accordingly.

---

## 2. VERIFIED — rules, prizes, deliverables

| Item | Value | Source |
|---|---|---|
| Eligibility | "All Iona undergraduate and graduate students! A valid @iona.edu email address is required to enter" | [official page] |
| Team or solo | Both permitted | [official page] |
| Entry limit | "Students can only submit one idea" | [official page] |
| Mentors | "Connect with your paired mentors for feedback" — students are paired with mentors | [official page] |
| Format | 'Shark Tank'-style pitch to a panel of expert judges | [news] |
| Judge pool | Drawn from "corporate, nonprofit, investment, and higher education partners across the region" | [news] |
| Total prizes | **$20,000** | [official page] |
| 1st place | $10,000 | [official page] |
| 2nd place | $5,000 | [official page] |
| 3rd place | $3,000 | [official page] |
| Fan Favourite | $1,000 — **judged on Milestone 1 video engagement** | [official page] |
| Superlative Awards | $1,000 total | [official page] |

### The three milestones — the actual deliverables

1. **1-minute video pitch**
2. **Executive summary**
3. **Pitch slide deck**

Two consequences worth noting now:

- **The video is scored twice.** It is Milestone 1 *and* the basis of the $1,000 Fan Favourite,
  which is decided on public engagement. It is the single highest-leverage artifact and it is due
  first.
- **There is no live-demo requirement in the stated deliverables.** A demo may still be permitted
  at the final; the deliverables are a video, a document and a deck. `readiness.mjs` scores
  `demo_quality` and `narrative` separately, and on this evidence **narrative outranks demo** for
  the milestone stages.

---

## 3. VERIFIED — the field

**8th annual winners** ([news](https://www.iona.edu/news/big-ideas-take-center-stage-eighth-annual-iona-innovation-challenge)):

| Place | Venture | What it is |
|---|---|---|
| 1st ($10,000) | Hydrate and Regulate | "a water bottle sensory support" |
| 2nd ($5,000) | Strendex | "Rehab hand glove that moves with you" |
| 3rd ($3,000) | Bracelet Buddy | "Jewelry that empowers independence" |

All three are **consumer physical products**, presented by undergraduate teams. Development stage
is **not stated** for any of them, and one year is one data point — do not build a strategy on it.

**What it does suggest, held loosely:** a B2B operations system in production at a paying-adjacent
real company would be an unusual entrant here. If that holds, AWE's differentiator is not the
technology, it is that **a real business is using it and we can prove what it did**. That is
precisely the claim the proof architecture exists to support, and precisely the claim we cannot yet
make.

---

## 4. UNKNOWN — go and find out

Each of these is answerable by one email to the Hynes Institute or by attending the February
kickoff. None is worth guessing.

| Question | Status |
|---|---|
| 10th annual (2027) exact kickoff date | UNKNOWN — expect early February 2027; confirm when announced |
| 10th annual milestone due dates | UNKNOWN |
| Registration deadline | UNKNOWN |
| **Published judging criteria and weights** | UNKNOWN — the single most valuable unknown |
| Names and backgrounds of 2027 judges | UNKNOWN |
| How mentors are assigned, and when | UNKNOWN |
| Whether judges read the executive summary before pitching | UNKNOWN |
| Pitch length and Q&A length at the final | UNKNOWN |
| Whether a live demo is permitted at the final | UNKNOWN |
| Number of entrants and finalists | UNKNOWN |
| Any claim on intellectual property | UNKNOWN — ask before submitting |
| Whether a venture with an existing real deployment is eligible / advantaged | UNKNOWN |
| Typical stage of entrants (idea / prototype / revenue) | UNKNOWN beyond the 8th-annual snapshot |

**Ask the Hynes Institute directly.** Judging criteria, IP terms and demo rules are the three that
change what we build, and all three are a single email.

---

## 5. Product alternatives — a different question, and the one that matters more

Not competitors in the contest. What a trades business would actually buy instead. `readiness.mjs`
scores `differentiation` against this table and it is currently band 0 because the table is empty.

| Alternative | What it does | What it does not do | Source |
|---|---|---|---|
| — | | | |

Candidates to analyse, drawn from what Lippolis actually uses today
(`docs/planning/CURRENT_WORKFLOW.md` §5): QuickBooks purchase orders, a shared Excel sheet,
Outlook, and the general-contractor procurement suites (Procore, Buildertrend and similar).

**The sentence to aim for** — testable today, and rare in the category:

> Most workflow tools report that a task completed. AWE reports whether the organization's
> objective was achieved, which is a different question, and it can show you the difference.

Do not put that in a pitch until this table is filled in and the claim survives it.

---

## Sources

- Official competition page: <https://www.iona.edu/academics/schools-institutes/hynes-institute-entrepreneurship-innovation/iona-innovation-challenge> — retrieved 2026-08-27
- 9th annual kickoff announcement (6 Feb 2026): <https://www2.iona.edu/internal/announcementDetail.cfm?id=F337A195-7593-427B-BF76-BE3379EFA9B8> — retrieved 2026-08-27
- 9th annual final announcement (30 Apr 2026): <https://www2.iona.edu/internal/announcementDetail.cfm?id=018B0273-D356-4EA8-98BA-0BBDD54BEA56> — retrieved 2026-08-27
- 8th annual results: <https://www.iona.edu/news/big-ideas-take-center-stage-eighth-annual-iona-innovation-challenge> — retrieved 2026-08-27
- Hynes Institute: <https://www.iona.edu/academics/schools-institutes/hynes-institute-entrepreneurship-innovation> — retrieved 2026-08-27

**Re-verify before relying on any date.** These are 2026 dates used to predict 2027.
