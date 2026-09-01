// ---------------------------------------------------------------------------
// alternatives.mjs — what do businesses use instead of AWE today?
//
// THE QUESTION A JUDGE ASKS AND A COMPETITIVE LANDSCAPE SLIDE CANNOT ANSWER.
// "Who are your competitors" invites a diagram of logos. The useful version is
// "what happens today, and why has nobody fixed it", and the only people who
// can answer it are the ones doing the work. So this file computes over
// INTERVIEW RECORDS and has no vendor list, no feature matrix, and no opinion
// about anybody else's software.
//
// WHY IT IS NOT programs/iic-2027/competitive-positioning.md. That document is
// the argument. This is the evidence, and it is deliberately capable of
// contradicting the argument: an alternative that several businesses are happy
// with is reported as prominently as one they hate, and the "adequate ERP"
// result — a real pain, already adequately handled — is a specific verdict
// rather than an absence.
//
// THE THREE THINGS THIS REFUSES TO DO:
//
//   · Count a founder's conclusion. An alternative block marked
//     FOUNDER_INFERRED is kept, shown, and never counted as analysis. That is
//     the entire competitor-fantasy defence and it is one filter.
//   · Turn a count into a market statement. Five interviews naming email is
//     "named by five of five organizations asked", never "80% of contractors".
//   · Decide that AWE wins. `evidencedDifference` is not derivable here and is
//     not derived; showing a difference is something a person does in front of
//     somebody, and no arrangement of interview records is a demonstration.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { ALTERNATIVE_KINDS, SWITCHING_COST } from './interview.mjs';

const SWITCHING_RANK = new Map(SWITCHING_COST.map((s, i) => [s, i]));

/**
 * Every alternative anybody named, grouped by kind.
 *
 * ORGANIZATIONS, NOT MENTIONS, for the same reason repeatedPatterns() counts
 * organizations: three people at one company naming the same spreadsheet is one
 * company's spreadsheet.
 */
export function analyseAlternatives(interviews) {
  const byKind = new Map();

  for (const i of interviews) {
    for (const a of i.alternatives ?? []) {
      const e = byKind.get(a.kind) ?? {
        kind: a.kind,
        organizations: new Set(), externalOrganizations: new Set(),
        interviews: [], inferredOnly: new Set(),
        whyUsed: [], whatWorks: [], whatFails: [], whyNotFixed: [], quotes: [],
        switching: [],
      };
      e.interviews.push(i.id);
      if (a.fromCustomer) {
        e.organizations.add(i.organization);
        if (!i.internal) e.externalOrganizations.add(i.organization);
      } else {
        e.inferredOnly.add(i.organization);
      }
      // THE CUSTOMER'S WORDS ARE KEPT, never replaced by the tag. Same rule as
      // patterns.mjs: a taxonomy that discards the sentence it came from can
      // only ever confirm itself.
      const keep = (list, v) => { if (v) list.push({ organization: i.organization, interview: i.id, said: a.said, text: v }); };
      keep(e.whyUsed, a.whyUsed);
      keep(e.whatWorks, a.whatWorks);
      keep(e.whatFails, a.whatFails);
      keep(e.whyNotFixed, a.whyNotFixed);
      if (a.quote) e.quotes.push({ organization: i.organization, interview: i.id, text: a.quote });
      if (a.switchingCost !== 'NOT_ASKED') e.switching.push(a.switchingCost);
      byKind.set(a.kind, e);
    }
  }

  const rows = [...byKind.values()].map((e) => Object.freeze({
    kind: e.kind,
    organizations: e.organizations.size,
    externalOrganizations: e.externalOrganizations.size,
    interviews: Object.freeze([...e.interviews]),
    // Named ONLY by the founder's inference at every organization that has it.
    // Shown, never counted.
    founderInferredOnly: e.organizations.size === 0 && e.inferredOnly.size > 0,
    whyUsed: Object.freeze(e.whyUsed.map(Object.freeze)),
    whatWorks: Object.freeze(e.whatWorks.map(Object.freeze)),
    whatFails: Object.freeze(e.whatFails.map(Object.freeze)),
    whyNotFixed: Object.freeze(e.whyNotFixed.map(Object.freeze)),
    quotes: Object.freeze(e.quotes.map(Object.freeze)),
    switchingCosts: Object.freeze([...e.switching]),
    // The worst switching cost anybody reported, because the hardest case is
    // what a deployment plan has to survive.
    hardestSwitch: e.switching.length
      ? e.switching.reduce((w, s) => (SWITCHING_RANK.get(s) > SWITCHING_RANK.get(w) ? s : w))
      : 'NOT_ASKED',
    // ANALYSED means the two fields that carry information are both present and
    // both came from somebody who does the work. An alternative named with no
    // failure and no reason it persists has been listed, not analysed.
    analysed: e.organizations.size > 0 && e.whatFails.length > 0 && e.whyNotFixed.length > 0,
    // ADEQUATE. They use it, it works, and nothing about it fails. This is a
    // finding and it is the one that argues against AWE, so it is computed
    // rather than left to be noticed.
    adequate: e.organizations.size > 0 && e.whatWorks.length > 0 && e.whatFails.length === 0,
  }));

  return Object.freeze({
    rows: Object.freeze(rows.sort((a, b) =>
      b.organizations - a.organizations || a.kind.localeCompare(b.kind))),
    analysed: rows.filter((r) => r.analysed).length,
    adequate: Object.freeze(rows.filter((r) => r.adequate).map((r) => r.kind)),
    founderInferredOnly: Object.freeze(rows.filter((r) => r.founderInferredOnly).map((r) => r.kind)),
    // Kinds nobody has been asked about. Not a gap in the product; a gap in the
    // conversation, and the difference matters when reading the report.
    neverMentioned: Object.freeze(ALTERNATIVE_KINDS.filter((k) => !byKind.has(k))),
    interviewsWithAlternatives: interviews.filter((i) => (i.alternatives ?? []).some((a) => a.fromCustomer)).length,
    interviewsWithout: interviews.filter((i) => !(i.alternatives ?? []).some((a) => a.fromCustomer)).length,
  });
}

/**
 * The facts the readiness scorecard's `differentiation` dimension reads.
 *
 * THREE BANDS AND ONLY TWO ARE DERIVABLE, which is the honest shape:
 *
 *   alternativesAnalysed  counted from customer testimony. Derived.
 *   statedDifference      the difference is written down AND anchored to at
 *                         least one alternative somebody actually uses. The
 *                         document alone is not enough: a difference stated
 *                         against an imagined alternative is a sentence about
 *                         nothing, and that is what the document was when it
 *                         was written.
 *   evidencedDifference   NOT DERIVED, ever, and the omission is the point. It
 *                         means somebody was shown the difference and saw it.
 *                         That is a declared fact with a witness, like a mock
 *                         pitch, and a file cannot stand in for it.
 *
 * @param {object} analysis   from analyseAlternatives()
 * @param {boolean} positioningWritten  does the positioning document exist
 */
export function differentiationFacts(analysis, { positioningWritten = false } = {}) {
  return Object.freeze({
    alternativesAnalysed: analysis.analysed,
    statedDifference: positioningWritten && analysis.analysed > 0,
    // Deliberately absent rather than false: `false` here would be a claim that
    // somebody looked and found nothing, and nobody has looked.
  });
}

/**
 * What may honestly be said about alternatives, in one paragraph.
 *
 * Modelled on marketClaim() in patterns.mjs, and for the same reason: the
 * sentence somebody will reach for is always broader than the sample, so the
 * repository writes the narrow one first.
 */
export function alternativesClaim(analysis, { externalOrganizations = 0 } = {}) {
  // THE WARNING IS COMPUTED BEFORE THE BRANCH, because the case where it
  // matters most is the one where nothing was analysed: a business whose
  // existing tool works has told us something important and contributed no
  // "analysed" alternative, and the first version of this function reported
  // "nothing to say" over the top of it.
  const adequateWarning = analysis.adequate.length
    ? `${analysis.adequate.join(', ')} was described as working, with nothing failing. That is evidence ` +
      'against the problem in those businesses and must appear wherever the alternatives do.'
    : null;

  if (analysis.analysed === 0) {
    return Object.freeze({
      claimable: false,
      say: 'Nothing. No business has described what it uses instead AND what fails about it, so any ' +
        'statement about alternatives is a guess about other people\'s software.',
      mustNotSay: 'Anything comparing AWE to a named product, or any claim about what businesses use today.',
      adequateWarning,
    });
  }
  const kinds = analysis.rows.filter((r) => r.analysed).map((r) => r.kind);
  return Object.freeze({
    claimable: true,
    say: `Across ${externalOrganizations} outside organization(s) asked, the work is done today with ` +
      `${kinds.join(', ')}. Each was described by the person doing it, with what fails and why they ` +
      'have not fixed it.',
    mustNotSay: 'That this is what the industry uses. It is what the businesses we asked use, and ' +
      'they were reached through one founder\'s network.',
    adequateWarning,
  });
}
