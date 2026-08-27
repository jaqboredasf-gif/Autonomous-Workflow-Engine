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
  // --- differentiation -----------------------------------------------------
  // Not yet done. Naming the three things a trades business would buy instead
  // is an afternoon's work and it is currently one of the cheapest bands to
  // move — see `highestLeverage()`.
  //
  // differentiation: {
  //   alternativesAnalysed: 3,
  //   statedDifference: true,
  //   evidencedDifference: true,
  //   note: 'analysed 2026-09-xx; see programs/iic-2027/competition-intelligence.md',
  // },

  // --- business model ------------------------------------------------------
  // businessModel: { unitDefined: true, pricingHypothesis: true, ... }

  // --- revenue -------------------------------------------------------------
  // revenue: { payingCustomers: 0, pricingHypothesis: false }

  // --- external validation -------------------------------------------------
  // validation: { designPartners: 0, externalDeployments: 0, externalTestimony: 0 }

  // --- demo and narrative --------------------------------------------------
  // demo: { liveDemoExists: false, backupExists: false, rehearsals: 0 }
  // narrative: { oneMinuteExists: false, ... }
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
