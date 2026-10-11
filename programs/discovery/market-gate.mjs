// ---------------------------------------------------------------------------
// market-gate.mjs — how far external validation has actually got, and what a
// good design partner would look like.
//
// WHY A SEPARATE GATE, given the venture planner already scores customer
// discovery. The planner answers "what should we do next"; this answers "what
// may we claim". They are different questions and the second one is the one a
// judge, an investor or a design partner will test — and it is the one where an
// early company reaches for a stronger word than it has earned.
//
// THE STAGES ARE ORDINAL AND EACH NEEDS SOMETHING SOMEBODY ELSE DID. None of
// them can be reached by working harder alone, which is the point: market
// validation is the one thing a founder cannot produce by building.
//
//   UNVALIDATED              nobody outside has been asked
//   DISCOVERY_STARTED        conversations are happening
//   REPEATED_PAIN_OBSERVED   two outside organizations, independently, same pain
//   DESIGN_PARTNER_INTEREST  somebody outside wants to try it
//   DESIGN_PARTNER_COMMITTED somebody outside has given time or data
//   EXTERNALLY_DEPLOYED      it is running somewhere that is not our customer
//   PAYING_CUSTOMER          somebody outside has paid
//
// WHAT WILL NOT PASS, because these are the things that feel like validation:
// a family friend saying it sounds useful; five survey responses; a professor
// liking the concept; one enthusiastic conversation repeated to three people at
// the same company. Every stage below counts ORGANIZATIONS and requires
// something that cost the other party something.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

export const STAGES = Object.freeze([
  'UNVALIDATED',
  'DISCOVERY_STARTED',
  'REPEATED_PAIN_OBSERVED',
  'DESIGN_PARTNER_INTEREST',
  'DESIGN_PARTNER_COMMITTED',
  'EXTERNALLY_DEPLOYED',
  'PAYING_CUSTOMER',
]);

/**
 * What each stage requires. Read top to bottom; the furthest one whose test
 * passes, and whose predecessors all pass, is where we are.
 *
 * `needs` is written as the thing somebody else must have done, not as a
 * number we produce.
 */
export const REQUIREMENTS = Object.freeze([
  {
    stage: 'DISCOVERY_STARTED',
    needs: 'at least three conversations, at three different organizations outside the deploying customer',
    met: (f) => f.externalInterviews >= 3 && f.externalOrganizations >= 3,
    found: (f) => `${f.externalInterviews} conversation(s) at ${f.externalOrganizations} outside organization(s)`,
  },
  {
    stage: 'REPEATED_PAIN_OBSERVED',
    needs: 'the same pain described independently by two outside organizations, in their own words',
    met: (f) => f.corroboratedPains >= 1 && f.painsStated >= 2,
    found: (f) => `${f.corroboratedPains} pain(s) corroborated across outside organizations; ${f.painsStated} described in the customer's own words`,
  },
  {
    stage: 'DESIGN_PARTNER_INTEREST',
    needs: 'an outside organization saying it would try this, having heard what it is',
    met: (f) => f.designPartnerCandidates >= 1,
    found: (f) => `${f.designPartnerCandidates} candidate(s)`,
  },
  {
    stage: 'DESIGN_PARTNER_COMMITTED',
    needs: 'an outside organization that has given something — time, data, or a scheduled pilot',
    met: (f) => f.designPartners >= 1,
    found: (f) => `${f.designPartners} committed`,
  },
  {
    stage: 'EXTERNALLY_DEPLOYED',
    needs: 'AWE running at an organization that is not the deploying customer',
    met: (f) => f.externalDeployments >= 1,
    found: (f) => `${f.externalDeployments} external deployment(s)`,
  },
  {
    stage: 'PAYING_CUSTOMER',
    needs: 'money from an organization outside the deploying customer',
    met: (f) => f.payingCustomers >= 1,
    found: (f) => `${f.payingCustomers} paying`,
  },
]);

/**
 * Where external validation stands.
 *
 * Stages do not skip. Reaching a later test without its predecessors is
 * reported as an anomaly rather than promoted — a paying customer with no
 * recorded discovery means the record is incomplete, not that the company
 * validated instantly.
 */
export function marketStage(facts) {
  const f = {
    externalInterviews: 0, externalOrganizations: 0, corroboratedPains: 0, painsStated: 0,
    designPartnerCandidates: 0, designPartners: 0, externalDeployments: 0, payingCustomers: 0,
    ...facts,
  };

  const results = REQUIREMENTS.map((r) => Object.freeze({
    stage: r.stage, needs: r.needs, met: Boolean(r.met(f)), found: r.found(f),
  }));

  let stage = 'UNVALIDATED';
  for (const r of results) {
    if (!r.met) break;
    stage = r.stage;
  }

  const skipped = results.filter((r, i) => r.met && results.slice(0, i).some((p) => !p.met));
  const next = results.find((r) => !r.met) ?? null;

  return Object.freeze({
    stage,
    stages: Object.freeze(results),
    next,
    anomalies: Object.freeze(skipped.map((r) =>
      `${r.stage} is satisfied while an earlier stage is not (${r.found}) — the record is incomplete rather than the company validated`)),
    claim: CLAIM[stage],
  });
}

const CLAIM = Object.freeze({
  UNVALIDATED: 'Nothing about a market may be claimed. We have one customer.',
  DISCOVERY_STARTED: 'Say how many conversations, at how many organizations, and that patterns are not yet established.',
  REPEATED_PAIN_OBSERVED: 'Say which pain was described independently by which kinds of business, in their words, and that this is our sample rather than the market.',
  DESIGN_PARTNER_INTEREST: 'As above, plus that an outside organization has said it would try it. Interest is not commitment.',
  DESIGN_PARTNER_COMMITTED: 'Say that an outside organization has committed time or data, and what they committed.',
  EXTERNALLY_DEPLOYED: 'Say that AWE runs at an organization that did not build it. This is the claim that separates a product from a favour.',
  PAYING_CUSTOMER: 'Say that somebody outside paid, and what for.',
});

// ---------------------------------------------------------------------------
// Design-partner qualification
// ---------------------------------------------------------------------------

/**
 * What makes a good first external partner, and why each one is on the list.
 *
 * DELIBERATELY NOT A SCORE OUT OF 100. Six criteria, each either met or not,
 * each derived from something in the interview record rather than from an
 * impression. A weighted score would imply a precision that four conversations
 * cannot support, and would let enthusiasm in one column outvote a missing
 * decision-maker in another.
 *
 * The two marked `disqualifying` are not tradeable: without a pain AWE actually
 * addresses, and without somebody who can say yes, a pilot is a favour that
 * wastes both parties' time.
 */
export const QUALIFICATION = Object.freeze([
  {
    id: 'addressable_pain',
    disqualifying: true,
    asks: 'is their strongest pain one an existing AWE capability addresses?',
    why: 'a pilot against a pain we cannot touch teaches us nothing and costs them a month',
  },
  {
    id: 'pain_is_frequent',
    disqualifying: false,
    asks: 'does it happen often enough to measure inside a pilot?',
    why: 'a monthly problem needs a year to show a difference; a daily one needs a fortnight',
  },
  {
    id: 'decision_maker_reachable',
    disqualifying: true,
    asks: 'have we spoken to somebody who can say yes, or to somebody who can reach them?',
    why: 'enthusiasm from a person who cannot authorise anything is the commonest way a pilot dies slowly',
  },
  {
    id: 'measurable_before',
    disqualifying: false,
    asks: 'could their current process be measured before we change it?',
    why: 'without a before there is no after, and the whole point of a second deployment is the comparison',
  },
  {
    id: 'willing_to_change',
    disqualifying: false,
    asks: 'are they actively looking, or content with the workaround?',
    why: 'content-with-the-workaround is the most honest answer a prospect gives and the most expensive to ignore',
  },
  {
    id: 'would_consider_paying',
    disqualifying: false,
    asks: 'has money come up at all, in any direction?',
    why: 'a partner who has never considered paying is a research subject; both are useful and they are not the same',
  },
]);

/**
 * Qualify one organization from its interviews.
 *
 * Returns what is met, what is not, and — where the answer is not knowable from
 * the record — says so rather than assuming the worse or the better.
 */
export function qualify(interviews, analysis) {
  const org = interviews[0]?.organization;
  if (!org || interviews.some((i) => i.organization !== org)) {
    throw new Error('qualify() takes the interviews for ONE organization — a partner is an organization, not a conversation');
  }
  if (interviews.some((i) => i.internal)) {
    throw new Error(`${org}: these are internal interviews. The deploying customer cannot be its own external design partner.`);
  }

  const tags = new Set(interviews.flatMap((i) => i.patternTags));
  const addressable = analysis.patterns.filter((p) => tags.has(p.tag) && p.addressable);
  const frequencies = interviews.map((i) => i.frequency).filter((f) => f.value);

  const answers = {
    addressable_pain: addressable.length > 0
      ? yes(`${addressable.map((p) => p.tag).join(', ')} maps to ${[...new Set(addressable.map((p) => p.capability))].join(', ')}`)
      : no('no reported pain maps to a capability AWE has'),

    pain_is_frequent: frequencies.length === 0
      ? unknown('frequency did not come up')
      : (/daily|every ?day|constant|several (times )?a (day|week)|multiple|weekly|per day|a day\b/i.test(frequencies.map((f) => f.value).join(' '))
        ? yes(frequencies.map((f) => `${f.value} [${f.said}]`).join('; '))
        : no(frequencies.map((f) => `${f.value} [${f.said}]`).join('; '))),

    decision_maker_reachable: interviews.some((i) => /owner|principal|president|director|manager|partner/i.test(i.role))
      ? yes(`spoke to ${[...new Set(interviews.map((i) => i.role))].join(', ')}`)
      : unknown(`spoke to ${[...new Set(interviews.map((i) => i.role))].join(', ')} — nothing says whether they can authorise a pilot`),

    measurable_before: interviews.some((i) => i.humanTimeStated.value)
      ? yes(`they described their own handling time: ${interviews.find((i) => i.humanTimeStated.value).humanTimeStated.value}`)
      : unknown('nothing was said about how long the current process takes'),

    willing_to_change: interviews.some((i) => i.willingnessToChange === 'ACTIVELY_LOOKING')
      ? yes('actively looking')
      : interviews.some((i) => i.willingnessToChange === 'OPEN_IF_PROVEN')
        ? yes('open if proven')
        : interviews.some((i) => i.willingnessToChange === 'CONTENT_WITH_WORKAROUND' || i.willingnessToChange === 'WILL_NOT_CHANGE')
          ? no('content with the workaround, or will not change')
          : unknown('not asked'),

    would_consider_paying: interviews.some((i) => i.willingnessToPay === 'WOULD_PAY_STATED_AMOUNT')
      ? yes(`named a figure: ${interviews.find((i) => i.statedAmount).statedAmount}`)
      : interviews.some((i) => i.willingnessToPay === 'WOULD_PAY_UNSPECIFIED')
        ? yes('said they would pay, without a figure')
        : interviews.some((i) => i.willingnessToPay === 'WOULD_NOT_PAY')
          ? no('said they would not pay')
          : unknown('not asked'),
  };

  const criteria = QUALIFICATION.map((c) => Object.freeze({
    ...c, ...answers[c.id],
  }));
  const blocked = criteria.filter((c) => c.disqualifying && c.answer !== 'YES');

  return Object.freeze({
    organization: org,
    organizationType: interviews[0].organizationType ?? null,
    interviews: Object.freeze(interviews.map((i) => i.id)),
    criteria: Object.freeze(criteria),
    met: criteria.filter((c) => c.answer === 'YES').length,
    unknown: criteria.filter((c) => c.answer === 'UNKNOWN').length,
    // NOT a score. Either the two disqualifying criteria are met or this is not
    // a candidate yet, and the unknowns are the next conversation.
    viable: blocked.length === 0,
    blockedBy: Object.freeze(blocked.map((c) => `${c.id}: ${c.because}`)),
    nextConversation: Object.freeze(criteria.filter((c) => c.answer === 'UNKNOWN').map((c) => c.asks)),
  });
}

const yes = (because) => ({ answer: 'YES', because });
const no = (because) => ({ answer: 'NO', because });
const unknown = (because) => ({ answer: 'UNKNOWN', because });

/** Every outside organization, qualified, best first. */
export function candidates(interviews, analysis) {
  const byOrg = new Map();
  for (const i of interviews.filter((x) => !x.internal)) {
    byOrg.set(i.organization, [...(byOrg.get(i.organization) ?? []), i]);
  }
  return Object.freeze([...byOrg.values()]
    .map((group) => qualify(group, analysis))
    .sort((a, b) => Number(b.viable) - Number(a.viable) || b.met - a.met || a.unknown - b.unknown));
}
