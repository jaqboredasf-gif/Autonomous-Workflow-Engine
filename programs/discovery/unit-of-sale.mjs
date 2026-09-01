// ---------------------------------------------------------------------------
// unit-of-sale.mjs — what exactly would a customer be buying?
//
// THE QUESTION BEFORE PRICE, and the one the business beat is actually missing.
// `readiness.mjs` scores `business_model` at zero because "the thing being sold
// has not been defined", and the tempting fix is to define it — pick "per
// company per capability", write a paragraph, watch the band move. That fix is
// available this afternoon and it is worth nothing, because the band would then
// be measuring a decision rather than a discovery.
//
// So NOTHING HERE PICKS A UNIT. It counts what businesses said about who would
// sign, who would use it, what they think they would be buying, and what the
// problem costs them today, and it reports the leading candidate WITH the
// evidence behind it and the disagreement inside it. `unitDefined` becomes true
// when the customers agree, not when a founder decides.
//
// FOUR RESULTS THAT ARE NOT "WE FOUND THE UNIT", each computed rather than
// noticed, because each one is a real outcome of real conversations and each
// one is invisible if you only count the winner:
//
//   SPLIT_BUYER_USER   the person who wants it does not sign for it
//   WANTS_A_SERVICE    they do not want software, they want the work done
//   USE_NOT_PAY        willing to use it, unwilling to pay for it
//   CONTESTED          the businesses do not agree on what they would buy
//
// NO PRICING. No optimiser, no tiers, no willingness-to-pay curve. What people
// said about money is already recorded on the interview as `willingnessToPay`
// and `statedAmount`, and this file reads those two and adds nothing to them.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { DEPLOYMENT_UNITS } from './interview.mjs';

export const VERDICTS = Object.freeze([
  'NOT_ASKED',            // nobody has been asked the commercial questions
  'TOO_FEW',              // asked, below the threshold where agreement means anything
  'CONTESTED',            // asked enough, and they do not agree
  'CANDIDATE',            // a leading unit, from too few organizations to lean on
  'SUPPORTED',            // three or more outside organizations, same unit, same buyer
]);

/**
 * How many outside organizations have to agree before the unit is SUPPORTED.
 *
 * THREE, and the number is arbitrary in the same way the five-interview
 * checkpoint is arbitrary: it is the smallest number at which "they all said
 * the same thing" is not just "the two people I know best said the same thing".
 * It is stated here as a constant so that it can be argued with rather than
 * discovered inside a conditional.
 */
export const SUPPORTED_ORGANIZATIONS = 3;
const CANDIDATE_ORGANIZATIONS = 2;

/**
 * What the conversations show about the shape of a sale.
 *
 * INTERNAL CONVERSATIONS ARE EXCLUDED FROM THE VERDICT and counted separately.
 * The deploying organization's opinion about what it would buy is worth having
 * and is the single most biased data point available: they already have it, for
 * free, built by somebody they know.
 */
export function analyseUnitOfSale(interviews) {
  const asked = interviews.filter((i) => i.commercial?.fromCustomer);
  const external = asked.filter((i) => !i.internal);

  const tally = (pick) => {
    const m = new Map();
    for (const i of external) {
      const v = pick(i);
      if (!v || v === 'UNKNOWN' || v === 'unknown') continue;
      const e = m.get(v) ?? { value: v, organizations: new Set(), interviews: [] };
      e.organizations.add(i.organization);
      e.interviews.push(i.id);
      m.set(v, e);
    }
    return [...m.values()]
      .map((e) => Object.freeze({ value: e.value, organizations: e.organizations.size, interviews: Object.freeze([...e.interviews]) }))
      .sort((a, b) => b.organizations - a.organizations || String(a.value).localeCompare(String(b.value)));
  };

  const units = tally((i) => i.commercial.deploymentUnit);
  const buyers = tally((i) => i.commercial.buyer);
  const users = tally((i) => i.commercial.user);
  const budgetOwners = tally((i) => i.commercial.budgetOwner);

  const externalOrganizations = new Set(external.map((i) => i.organization)).size;
  const leadingUnit = units[0] ?? null;
  const runnerUp = units[1] ?? null;

  // THE FOUR FINDINGS THAT ARE NOT A UNIT.
  const splitBuyerUser = external.filter((i) => i.commercial.splitBuyerUser);
  const wantsService = external.filter((i) => i.commercial.wantsService === true || i.commercial.deploymentUnit === 'service');
  const useNotPay = external.filter((i) =>
    i.willingnessToPay === 'WOULD_NOT_PAY' &&
    (i.willingnessToChange === 'ACTIVELY_LOOKING' || i.willingnessToChange === 'OPEN_IF_PROVEN'));

  const verdict = verdictOf({ asked: asked.length, externalOrganizations, leadingUnit, runnerUp });

  return Object.freeze({
    asked: asked.length,
    externalAsked: external.length,
    externalOrganizations,
    internalAsked: asked.length - external.length,
    units: Object.freeze(units),
    buyers: Object.freeze(buyers),
    users: Object.freeze(users),
    budgetOwners: Object.freeze(budgetOwners),
    unitsNeverNamed: Object.freeze(DEPLOYMENT_UNITS.filter((u) => u !== 'unknown' && !units.some((x) => x.value === u))),
    leadingUnit,
    verdict,
    // What the problem costs them today, in their words. The input to a price
    // argument, which is a later conversation and a different file.
    costOfProblem: Object.freeze(external
      .filter((i) => i.commercial.currentCostOfProblem)
      .map((i) => Object.freeze({ organization: i.organization, interview: i.id, said: i.commercial.said, text: i.commercial.currentCostOfProblem }))),
    findings: Object.freeze({
      splitBuyerUser: Object.freeze(splitBuyerUser.map((i) => i.id)),
      wantsService: Object.freeze(wantsService.map((i) => i.id)),
      useNotPay: Object.freeze(useNotPay.map((i) => i.id)),
    }),
  });
}

function verdictOf({ asked, externalOrganizations, leadingUnit, runnerUp }) {
  if (asked === 0) return Object.freeze({ verdict: 'NOT_ASKED', because: 'no conversation has reached the commercial questions' });
  if (!leadingUnit) {
    return Object.freeze({ verdict: 'NOT_ASKED', because: `${asked} conversation(s) reached the commercial questions and none named what they would be buying` });
  }
  if (externalOrganizations < CANDIDATE_ORGANIZATIONS) {
    return Object.freeze({
      verdict: 'TOO_FEW',
      because: `one outside organization named "${leadingUnit.value}" — that is a customer's preference, not a unit of sale`,
    });
  }
  // CONTESTED BEATS CANDIDATE. A tie, or a near-tie, is a result: it says the
  // businesses do not agree, and picking the alphabetically-first one would
  // manufacture a consensus out of a disagreement.
  if (runnerUp && runnerUp.organizations >= leadingUnit.organizations) {
    return Object.freeze({
      verdict: 'CONTESTED',
      because: `"${leadingUnit.value}" and "${runnerUp.value}" were each named by ${leadingUnit.organizations} organization(s) — they do not agree`,
    });
  }
  if (leadingUnit.organizations < SUPPORTED_ORGANIZATIONS) {
    return Object.freeze({
      verdict: 'CANDIDATE',
      because: `${leadingUnit.organizations} outside organizations named "${leadingUnit.value}" — a candidate, ${SUPPORTED_ORGANIZATIONS} would make it a finding`,
    });
  }
  return Object.freeze({
    verdict: 'SUPPORTED',
    because: `${leadingUnit.organizations} outside organizations independently described buying "${leadingUnit.value}"`,
  });
}

/**
 * The facts the `business_model` dimension and the `unit_of_sale` slot read.
 *
 * `unitDefined` IS THE WHOLE POINT AND IT IS DERIVED FROM CUSTOMERS. It is true
 * only at SUPPORTED. A founder writing "we sell per company per capability" in
 * a document moves nothing, which is the correct behaviour for a band whose
 * question is "do we know what we sell" — knowing is not deciding.
 *
 * `pricingHypothesis` and `pricingTested` are NOT derived here. A price put to
 * a prospect is a thing that happened in a room, recorded as a declared fact
 * with a witness like everything else of that kind.
 */
export function businessModelFacts(analysis) {
  return Object.freeze({
    unitDefined: analysis.verdict.verdict === 'SUPPORTED',
    unitOfSaleVerdict: analysis.verdict.verdict,
    unitOfSaleBecause: analysis.verdict.because,
    unitOfSaleCandidate: analysis.leadingUnit?.value ?? null,
  });
}
