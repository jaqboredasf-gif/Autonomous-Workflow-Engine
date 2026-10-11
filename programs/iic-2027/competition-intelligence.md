# Competition intelligence — Iona Innovation Challenge

**Retrieved 2026-08-27, refreshed 2026-09-01, from official Iona University sources.** Every fact
below carries the URL it came from and the date it was read. Anything not stated on those pages is
left `UNKNOWN` — an assumption in this file would be the same failure the proof architecture exists
to prevent, applied to a different subject.

**What the 2026-09-01 refresh changed.** The single most valuable unknown — *what are the pitches
actually judged on* — is no longer unknown. It was recovered from Iona's own report of the second
annual challenge, along with the length of the final pitch. Both are seven editions old and are
recorded here with that caveat attached rather than quietly promoted to current fact. Nothing about
the 2027 edition has been announced; the main competition page still describes Spring 2026.

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

## 2b. VERIFIED, AND SEVEN EDITIONS OLD — what the judges score

This is the most decision-changing fact in the file, and it is also the one most likely to be out
of date. Both halves matter.

| Item | Value | Source |
|---|---|---|
| Final pitch length | **four minutes**, "followed by a Q&A" | [2nd annual report] |
| Judging criteria | **"feasibility, uniqueness, market need, impact, cost of implementation, ease of implementation, idea articulation, and overall impression"** — eight, quoted exactly | [2nd annual report] |
| Weights | **UNKNOWN.** No weighting is published for any edition | — |

**Retrieved 2026-09-01. Describes the 2nd annual (2019).** Later editions publish winners, prizes
and judges, but no rubric. The 7th (2024) and 8th (2025) reports name the judges and the prizes and
say nothing about criteria or format. So this is the only published rubric there is, and it is old
enough that confirming it is one of the three questions worth an email.

### What it changes, immediately

This is not the rubric a startup pitch deck is built for, and building to the wrong one is
expensive:

- **No traction criterion. No revenue criterion. No team criterion.** AWE's three weakest areas —
  paying customers, external deployments, and being one undergraduate — are, on this evidence, not
  directly scored at all. A deck that leads with traction is spending its strongest minutes on
  something nobody is marking.
- **Two of eight are cost and ease of implementation.** A system installed and running at a real
  company is the strongest possible evidence for both, and it is the thing almost no other entrant
  can show. This is where AWE's actual advantage sits, and it was not obvious before this rubric
  was recovered.
- **Two of eight are idea articulation and overall impression.** A quarter of the marks are for
  being understood and remembered. That is not a soft quarter; it is the quarter most technical
  entries lose.
- **Feasibility, uniqueness, market need and impact** are the remaining four, and the first three
  of those are answerable today from the deployment, the proof architecture and — once anybody has
  been asked — customer discovery.

`programs/iic-2027/narrative.mjs` weights every presentation beat by how many of these eight it
serves, so the ranking of what to work on is derived from the rubric rather than from taste. If the
rubric turns out to have changed, edit `JUDGING_CRITERIA` and every downstream ranking moves with
it.

### Prize structure is per-edition, not fixed

| Edition | 1st | 2nd | 3rd | Other |
|---|---|---|---|---|
| 2nd (2019) | $3,000 | $1,200 | — | Fan Favourite $500 |
| 7th (2024) | $6,000 (1st + Fan Favourite) | $2,500 | $1,500 | 2 superlatives, $500 each |
| 8th (2025) | $10,000 | $5,000 | $3,000 | Fan Favourite $1,000; 2 superlatives, $500 each |
| 9th (2026) | $10,000 | $5,000 | $3,000 | Fan Favourite $1,000; superlatives $1,000 total |
| **10th (2027)** | **UNKNOWN** | | | |

The prize pool has changed shape in four of the last five editions. The $10,000 first prize is two
editions old, not a constant, and any plan that spends it should say so.

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
| **Whether the eight 2019 criteria still apply** | PARTIALLY ANSWERED — the criteria are known for the 2nd annual (§2b); whether they hold in 2027 is UNKNOWN, and this is now the single most valuable unknown |
| Criteria **weights** | UNKNOWN — never published for any edition |
| 10th annual prize structure | UNKNOWN — it has changed in four of the last five editions |
| Names and backgrounds of 2027 judges | UNKNOWN |
| How mentors are assigned, and when | UNKNOWN |
| Whether judges read the executive summary before pitching | UNKNOWN |
| Pitch length and Q&A length at the final | PARTIALLY ANSWERED — four minutes plus Q&A in the 2nd annual (§2b); Q&A length never stated, 2027 UNKNOWN |
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

- **Judging criteria and pitch format** (2nd annual, 2019): <https://www.iona.edu/about/news-events/news/second-annual-iona-innovation-challege-winners-ann.aspx> — retrieved 2026-09-01
- 7th annual (2024), judges and prize split: <https://www.iona.edu/news/iona-universitys-hynes-institute-hosts-seventh-annual-iona-innovation-challenge> — retrieved 2026-09-01
- Official competition page: <https://www.iona.edu/academics/schools-institutes/hynes-institute-entrepreneurship-innovation/iona-innovation-challenge> — retrieved 2026-08-27
- 9th annual kickoff announcement (6 Feb 2026): <https://www2.iona.edu/internal/announcementDetail.cfm?id=F337A195-7593-427B-BF76-BE3379EFA9B8> — retrieved 2026-08-27
- 9th annual final announcement (30 Apr 2026): <https://www2.iona.edu/internal/announcementDetail.cfm?id=018B0273-D356-4EA8-98BA-0BBDD54BEA56> — retrieved 2026-08-27
- 8th annual results: <https://www.iona.edu/news/big-ideas-take-center-stage-eighth-annual-iona-innovation-challenge> — retrieved 2026-08-27
- Hynes Institute: <https://www.iona.edu/academics/schools-institutes/hynes-institute-entrepreneurship-innovation> — retrieved 2026-08-27

**Re-verify before relying on any date.** These are 2026 dates used to predict 2027.

**The `www2.iona.edu/internal/announcementDetail.cfm` links rotate.** On 2026-09-01 they no longer
returned the announcements they were cited for on 2026-08-27; they serve whatever is current. The
facts taken from them on 2026-08-27 stand as recorded, and are not re-checkable at those URLs.
Anything future work needs from an announcement should be quoted into this file at the time it is
read, not linked to.

**Nothing about the 10th annual (2027) has been announced as of 2026-09-01.** The main competition
page still describes Spring 2026. Expect the announcement in January 2027 and the kickoff in early
February; that is a prediction from two editions, not a fact.
