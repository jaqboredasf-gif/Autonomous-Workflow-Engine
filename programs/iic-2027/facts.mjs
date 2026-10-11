// ---------------------------------------------------------------------------
// facts.mjs — what is true, and who says so.
//
// The readiness scorecard scores FACTS. This is where they come from, and it is
// split deliberately in two:
//
//   DERIVED    read from the repository and from a live database. Nobody can
//              type these, and nobody has to remember to update them.
//   DECLARED   things software cannot know — whether a mock pitch happened,
//              whether anybody paid. Each one requires a note saying who
//              observed it and when, and an entry with no note is refused.
//
// The split is the point. Everything that CAN be derived is derived, so the
// declared list stays short enough that its honesty is checkable by reading it.
//
// A declared fact that has not happened is simply absent. There is no `false`
// with an excuse attached, because a field somebody set to false with a note
// about why is indistinguishable, three months later, from a field somebody
// set to true with a note about why.
// ---------------------------------------------------------------------------

/**
 * Facts nobody can derive.
 *
 * TODAY: almost nothing, because almost nothing has happened yet. Adding to
 * this list is how the scorecard moves, and every addition should be something
 * a person did rather than something a person decided.
 */
export const DECLARED = Object.freeze({
  // --- FOUR OF THESE ARE NO LONGER DECLARED --------------------------------
  //
  // `differentiation.alternativesAnalysed`, `businessModel.unitDefined`,
  // `narrative.plainLanguageTests` and `narrative.mockPitches` all used to wait
  // here, commented out, for somebody to type them in with a note. All four are
  // now DERIVED by programs/iic-2027/derive.mjs from records of things that
  // happened:
  //
  //   alternatives      the alternatives block on an interview record
  //   unit of sale      the commercial block on an interview record
  //   plain language    programs/evidence/records/comprehension/
  //   mock pitches      programs/evidence/records/mock-pitch/
  //
  // WHY THAT MATTERS MORE THAN THE CONVENIENCE. All four sat at zero from the
  // day this file was written, and it was not laziness: hand-editing a
  // JavaScript module is a strange thing to do after a phone call, so it never
  // happened. `npm run evidence -- --new interview` and one import now do it.
  // And because derived facts beat declared ones in `mergeFacts`, a number
  // typed here can no longer disagree with the records behind it.
  //
  // WHAT IS STILL DECLARED, and rightly: everything that happened in a room and
  // left no artifact — a price put to a prospect, a design partner's
  // commitment, a deployment at a company that is not ours.

  // --- differentiation -----------------------------------------------------
  // `alternativesAnalysed` and `statedDifference` are derived from what
  // businesses said they use instead. `evidencedDifference` is NOT derivable
  // and must not become so: it means somebody was SHOWN the difference and saw
  // it, which caps the band at 2 until a person does that in front of another
  // person.
  //
  // differentiation: { evidencedDifference: true, note: 'shown to ... on 2026-xx-xx' },

  // --- business model ------------------------------------------------------
  // The unit of sale is derived. A PRICE is not: putting one to somebody is an
  // event with a witness.
  // businessModel: { pricingHypothesis: true, pricingTested: true, note: '...' }

  // --- revenue -------------------------------------------------------------
  // revenue: { payingCustomers: 0, pricingHypothesis: false }

  // --- external validation -------------------------------------------------
  // validation: { designPartners: 0, externalDeployments: 0, externalTestimony: 0 }

  // --- demo and narrative --------------------------------------------------
  // demo: { liveDemoExists: false, backupExists: false, rehearsals: 0 }
  // narrative: { oneMinuteExists: false, ... }

  // --- the presentation ----------------------------------------------------
  // Read by programs/iic-2027/narrative.mjs. Every one of these is something a
  // PERSON did, which is why none of them is derived: a file proving that a
  // sentence is understandable cannot be written by the person who wrote the
  // sentence.
  //
  // THE CHEAPEST EVIDENCE IN THE PROJECT — say the sentence to five people who
  // do not work in software and ask them to say it back — HAS MOVED OUT of this
  // file. It is recorded per person now, with the words they actually used, in
  // programs/evidence/records/comprehension/, which is strictly more honest
  // than a count with a note attached and considerably easier to produce:
  //
  //   npm run evidence -- --new comprehension
  //
  // narrative: {
  //   oneMinuteExists: true,   // a recorded, timed, spoken minute — not a script
  //   executiveSummaryExists: true,
  //   judgeQuestionsAnswered: 20,
  //   evidenceFrozen: true,
  //   deckExists: true,
  //   note: 'recorded 2026-xx-xx by ...',
  // },

  // --- the competition itself ----------------------------------------------
  // Filled in from a reply to the Hynes Institute or from the February kickoff.
  // Until then the UNKNOWN table in competition-intelligence.md stands.
  //
  // competition: {
  //   datesConfirmed: true,
  //   registered: true,
  //   criteriaConfirmed: true,   // does the 2019 eight-criteria rubric still hold?
  //   note: 'confirmed by ... on 2027-02-xx',
  // },
});

/**
 * Every declared entry must say who observed it and when.
 *
 * Called by the assembler before the facts reach the scorecard, so a fact
 * asserted without a witness fails loudly rather than quietly raising a band.
 */
export function assertDeclarationsWitnessed(declared = DECLARED) {
  for (const [key, value] of Object.entries(declared)) {
    if (value === null || typeof value !== 'object') continue;
    if (!value.note) {
      throw new Error(
        `declared fact "${key}" has no note — a claim with no witness is not evidence. ` +
        'Say who observed it and when, or remove the entry.');
    }
  }
  return true;
}

/**
 * Merge derived facts with declared ones.
 *
 * DERIVED WINS on any key both supply. A declaration cannot overrule a
 * measurement, which is the whole reason for deriving anything.
 */
export function mergeFacts(derived, declared = DECLARED) {
  assertDeclarationsWitnessed(declared);
  const out = { ...declared };
  for (const [group, values] of Object.entries(derived)) {
    out[group] = { ...(declared[group] ?? {}), ...values };
  }
  return out;
}
