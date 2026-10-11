// ---------------------------------------------------------------------------
// interview.mjs — customer discovery, structured just enough to be countable.
//
// The question this exists to answer, and the ONLY one:
//
//     Is this one customer's custom request, or a repeated market problem?
//
// A pile of transcripts cannot answer it. Neither can a CRM, which is built for
// tracking a deal rather than for detecting a pattern. So: a small record with
// one required field that does the work — `patternTags` — and a function that
// finds tags named INDEPENDENTLY by more than one organization.
//
// DELIBERATELY NOT A CRM. No pipeline, no stages, no owner, no next-action
// date, no scoring. Those model a sales process; this models a research one,
// and mixing them produces a tool that quietly optimises for closing rather
// than for learning, which at this stage is the expensive mistake.
//
// PURE: no clock, no randomness, no I/O. Interviews are loaded by the caller.
// ---------------------------------------------------------------------------

/**
 * WHO SAID THIS — attribution, which is a different question from grade.
 *
 * proof/provenance.mjs answers "how well is this quantity known" and its words
 * are deliberately NOT reused here. In that vocabulary SELF_REPORTED is weak,
 * because somebody's account of their own work is a poor way to measure a
 * duration. In discovery it is the opposite: what the customer said, in their
 * words, is the strongest evidence there is, and a founder's conclusion about
 * what they meant is the weak one. Same words, inverted ranking, guaranteed
 * confusion — so this is its own small axis and says so.
 *
 * THE FAILURE THIS EXISTS AGAINST. An interview record reading
 * `economicConsequence: 'the crew stands idle for a morning'` is quotable, and
 * six weeks later nobody can tell whether the operations manager said that or
 * whether Jack watched a crew standing around and wrote it down. The first is
 * customer testimony. The second is a founder's inference, which is worth
 * having and is not the same thing, and the difference is exactly what a judge
 * or an investor will push on.
 *
 * So the interpreted fields cannot be read without their attribution: they are
 * `{ value, said }` and a bare string is refused.
 */
export const ATTRIBUTION = Object.freeze([
  'STATED',            // they said it, in substance, unprompted or in answer
  'FOUNDER_OBSERVED',  // the founder saw it happen
  'FOUNDER_INFERRED',  // the founder concluded it from what was said or seen
  'UNKNOWN',           // it did not come up
]);

// The two founder values name the founder ON PURPOSE. `INFERRED` alone is also
// a word in proof/provenance.mjs, where it means "derived from other measured
// quantities" and sits mid-table; here it would mean "Jack decided this" and is
// the weakest thing in the file. One word, two rankings, in a repository where
// both appear near each other — so the actor is in the name.

/** The strongest attribution is the customer's own words. */
const ATTRIBUTION_RANK = new Map(ATTRIBUTION.map((a, i) => [a, i]));

/**
 * One interpreted field: what it is, and who is responsible for it.
 *
 * `quote` is optional and is what makes a STATED field checkable — the words
 * they actually used, rather than a paraphrase that has already drifted toward
 * the answer we wanted.
 */
export function testimony(value, said = 'UNKNOWN', quote = null) {
  if (value === null || value === undefined || value === '') {
    return Object.freeze({ value: null, said: 'UNKNOWN', quote: null });
  }
  if (!ATTRIBUTION.includes(said)) {
    throw new Error(
      `unknown attribution ${JSON.stringify(said)}. One of: ${ATTRIBUTION.join(', ')}. ` +
      'A value with no attribution is a founder\'s note wearing a customer\'s voice.');
  }
  if (said === 'UNKNOWN') {
    throw new Error(`"${value}" is recorded with attribution UNKNOWN — say who it came from, or leave the field empty`);
  }
  return Object.freeze({ value, said, quote });
}

/** Accepts a bare value only where the caller has already said who said it. */
function attributed(field, id, input) {
  if (input === null || input === undefined) return testimony(null);
  if (typeof input === 'object' && 'value' in input) return testimony(input.value, input.said, input.quote ?? null);
  throw new Error(
    `interview ${id}: ${field} is a bare value. Say who it came from:\n` +
    `  ${field}: { value: ${JSON.stringify(input)}, said: 'STATED', quote: '<their words>' }\n` +
    'STATED = they said it, FOUNDER_OBSERVED = you saw it, FOUNDER_INFERRED = you concluded it.');
}

/** How the person answered the money question. Closed, because the shades matter. */
export const WILLINGNESS = Object.freeze([
  'WOULD_PAY_STATED_AMOUNT',   // named a figure unprompted
  'WOULD_PAY_UNSPECIFIED',     // "we'd pay for that" — enthusiasm, not a price
  'WOULD_NOT_PAY',
  'NOT_ASKED',
  'UNCLEAR',
]);

/** How ready they are to change anything, which is usually the real constraint. */
export const WILLINGNESS_TO_CHANGE = Object.freeze([
  'ACTIVELY_LOOKING',
  'OPEN_IF_PROVEN',
  'CONTENT_WITH_WORKAROUND',
  'WILL_NOT_CHANGE',
  'NOT_ASKED',
]);

// ---------------------------------------------------------------------------
// What they use instead, and what they would be buying
// ---------------------------------------------------------------------------

/**
 * The things a business already uses to do this work.
 *
 * THE POINT OF THE LIST IS THAT IT IS NOT A COMPETITOR LIST. "Who else sells
 * this" is a question about a category; "what do they do on Tuesday instead"
 * is a question about the customer, and only the second one can be answered by
 * a person who does the work. Email, paper and a spreadsheet beat every named
 * vendor in this market and none of them appear on a competitive landscape
 * slide, which is exactly why the landscape slide is worthless here.
 *
 * `other` exists so an unanticipated answer is recorded rather than forced into
 * a bucket. A tag nobody predicted is a finding, the same way an unknown
 * patternTag is in patterns.mjs.
 */
export const ALTERNATIVE_KINDS = Object.freeze([
  'nothing',                            // the work simply does not get done
  'memory',                             // one person keeps it in their head
  'paper',
  'text_message',
  'phone_call',
  'email',
  'spreadsheet',
  'accounting_software',
  'erp',
  'construction_management_software',
  'custom_software',
  'admin_staff',                        // a person hired to be the integration
  'rpa',
  'general_purpose_ai',
  'other',
]);

/** How hard it would be to stop using it. Their answer, not our estimate. */
export const SWITCHING_COST = Object.freeze(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'BLOCKING', 'NOT_ASKED']);

/**
 * One alternative, as the customer described it.
 *
 * SIX FIELDS, AND THE LAST TWO DO THE WORK. What it is and what it fails at are
 * the obvious ones and they are the least informative: every tool fails at
 * something. `switchingCost` and `whyNotFixed` are the ones that decide whether
 * a real pain is a real market — a business that has lived with a problem for
 * nine years, knowing the fix, is telling us something about the problem, and
 * usually it is that the pain is smaller than the disruption.
 *
 * ATTRIBUTION IS ON THE BLOCK, not on each field, deliberately. Six attributed
 * sub-fields per alternative is a form nobody fills in after a phone call, and
 * an evidence format that does not get used records nothing. What matters is
 * the one distinction that can be got wrong in a damaging way: did the customer
 * describe this, or did the founder conclude it. A block marked
 * FOUNDER_INFERRED is kept and is never counted as analysis.
 */
export function alternativeInUse(input, owner = 'an interview') {
  const {
    kind, what = null, whyUsed = null, whatWorks = null, whatFails = null,
    switchingCost = 'NOT_ASKED', whyNotFixed = null, said = 'UNKNOWN', quote = null,
  } = input ?? {};

  if (!ALTERNATIVE_KINDS.includes(kind)) {
    throw new Error(
      `${owner}: unknown alternative kind ${JSON.stringify(kind)}. One of: ${ALTERNATIVE_KINDS.join(', ')}. ` +
      'Use "other" and say what it was in `what` rather than inventing a kind.');
  }
  if (kind === 'other' && !what) throw new Error(`${owner}: an "other" alternative must say what it was`);
  if (!SWITCHING_COST.includes(switchingCost)) {
    throw new Error(`${owner}: unknown switching cost ${JSON.stringify(switchingCost)}. One of: ${SWITCHING_COST.join(', ')}`);
  }
  if (!ATTRIBUTION.includes(said) || said === 'UNKNOWN') {
    throw new Error(
      `${owner}: the alternative "${kind}" does not say who it came from. ` +
      'said: STATED (they described it), FOUNDER_OBSERVED (you saw it), FOUNDER_INFERRED (you concluded it). ' +
      'An alternative with no attribution is a competitor slide wearing a customer\'s voice.');
  }

  return Object.freeze({
    kind, what, whyUsed, whatWorks, whatFails, switchingCost, whyNotFixed, said, quote,
    // The one derived field, and the one every count downstream filters on.
    fromCustomer: said === 'STATED' || said === 'FOUNDER_OBSERVED',
  });
}

/** Who signs, who uses it, and whether those are the same person. */
export const COMMERCIAL_ROLES = Object.freeze(['OWNER', 'OPERATIONS', 'OFFICE_MANAGER', 'FIELD', 'FINANCE', 'IT', 'EXTERNAL_BOOKKEEPER', 'UNKNOWN']);

/** What they would expect to be buying, if they bought anything. */
export const DEPLOYMENT_UNITS = Object.freeze([
  'company',            // one price, whole business
  'company_workflow',   // the business, for one capability
  'site',
  'seat',
  'usage',              // per request, per purchase order
  'project',            // one job at a time
  'service',            // they want a person to do it, not software
  'unknown',
]);

/**
 * What a sale would actually be, as far as this conversation showed.
 *
 * NOT A PRICE. Nothing here optimises or proposes a number; `willingnessToPay`
 * and `statedAmount` already record what they said about money and they are
 * deliberately left where they are. This block answers the question BEFORE
 * price, which is the one currently unanswered: what is the thing.
 *
 * EVERY FIELD DEFAULTS TO UNKNOWN AND STAYS THERE. A discovery call that did
 * not reach the commercial questions is the normal case and must not be padded
 * out with plausible answers — a `buyer` nobody named is the single easiest
 * place for a persona to enter this repository wearing evidence's clothes.
 */
export function commercialSignal(input, owner = 'an interview') {
  const {
    buyer = 'UNKNOWN', user = 'UNKNOWN', budgetOwner = 'UNKNOWN',
    problemPurchased = null, deploymentUnit = 'unknown',
    currentCostOfProblem = null, wantsService = null,
    said = 'UNKNOWN', quote = null,
  } = input ?? {};

  for (const [f, v] of [['buyer', buyer], ['user', user], ['budgetOwner', budgetOwner]]) {
    if (!COMMERCIAL_ROLES.includes(v)) {
      throw new Error(`${owner}: unknown ${f} ${JSON.stringify(v)}. One of: ${COMMERCIAL_ROLES.join(', ')}`);
    }
  }
  if (!DEPLOYMENT_UNITS.includes(deploymentUnit)) {
    throw new Error(`${owner}: unknown deploymentUnit ${JSON.stringify(deploymentUnit)}. One of: ${DEPLOYMENT_UNITS.join(', ')}`);
  }
  const anythingSaid = buyer !== 'UNKNOWN' || user !== 'UNKNOWN' || budgetOwner !== 'UNKNOWN' ||
    problemPurchased !== null || deploymentUnit !== 'unknown' || currentCostOfProblem !== null || wantsService !== null;
  if (anythingSaid && (!ATTRIBUTION.includes(said) || said === 'UNKNOWN')) {
    throw new Error(
      `${owner}: the commercial block records something and does not say who it came from. ` +
      'said: STATED, FOUNDER_OBSERVED or FOUNDER_INFERRED.');
  }

  return Object.freeze({
    buyer, user, budgetOwner, problemPurchased, deploymentUnit,
    currentCostOfProblem, wantsService, said, quote,
    // ASKED AT ALL. The difference between "we do not know who buys this" and
    // "nobody has been asked" is the difference between a finding and a gap.
    asked: anythingSaid,
    fromCustomer: anythingSaid && (said === 'STATED' || said === 'FOUNDER_OBSERVED'),
    // TWO PEOPLE, NOT ONE. A buyer who is not the user is the most common way a
    // product that everybody likes never gets bought, and it is invisible unless
    // both are recorded.
    buyerIsUser: buyer !== 'UNKNOWN' && buyer === user,
    splitBuyerUser: buyer !== 'UNKNOWN' && user !== 'UNKNOWN' && buyer !== user,
  });
}

/**
 * One conversation.
 *
 * `organization` is REQUIRED and is what makes counting honest: five
 * conversations inside one company are five conversations with one
 * organization, and `repeatedPatterns()` will not let them look like a market.
 *
 * `internal` marks a conversation inside the deploying organization. Those are
 * valuable and they are NOT external validation, so they are counted separately
 * everywhere.
 */
export function interview({
  id, at, organization, organizationType, role, internal = false,
  workflow, pain, frequency = null, currentTools = [],
  humanTimeStated = null, failureModes = [], economicConsequence = null,
  existingWorkaround = null, satisfactionWithWorkaround = null, urgency = null,
  organizationSize = null,
  willingnessToChange = 'NOT_ASKED', willingnessToPay = 'NOT_ASKED', statedAmount = null,
  capabilityFit = null, patternTags = [], followUp = null, designPartnerInterest = false,
  alternatives = [], commercial = null,
  notes = null,
}) {
  if (!id || !at || !organization || !role) {
    throw new Error('an interview needs an id, a date, an organization and the role interviewed');
  }
  if (!workflow) throw new Error(`interview ${id} names no workflow — a conversation about nothing in particular is not discovery`);
  if (!pain) throw new Error(`interview ${id} records no pain`);

  if (!WILLINGNESS.includes(willingnessToPay)) throw new Error(`unknown willingness to pay: ${willingnessToPay}`);
  if (!WILLINGNESS_TO_CHANGE.includes(willingnessToChange)) throw new Error(`unknown willingness to change: ${willingnessToChange}`);
  if (willingnessToPay === 'WOULD_PAY_STATED_AMOUNT' && statedAmount === null) {
    throw new Error(`interview ${id} says an amount was stated but records no amount`);
  }
  if (!Array.isArray(patternTags) || patternTags.length === 0) {
    throw new Error(
      `interview ${id} has no patternTags — an untagged interview cannot contribute to finding a repeated ` +
      'problem, which is the only reason this record exists');
  }
  for (const t of patternTags) {
    if (!/^[a-z][a-z0-9_]*$/.test(t)) throw new Error(`pattern tag must be snake_case: ${t}`);
  }

  // THE INTERPRETED FIELDS. Each one is something a founder could plausibly
  // have concluded rather than been told, so each one has to say which.
  //
  // CHECKED LAST, after everything structural. A record missing its workflow or
  // its tags has a different problem, and reporting the form of a field before
  // reporting that a required one is absent sends somebody to fix the wrong
  // thing — which is what happened to three existing test fixtures the moment
  // this check was added at the top.
  const interpreted = {
    pain: attributed('pain', id, pain),
    frequency: attributed('frequency', id, frequency),
    humanTimeStated: attributed('humanTimeStated', id, humanTimeStated),
    economicConsequence: attributed('economicConsequence', id, economicConsequence),
    existingWorkaround: attributed('existingWorkaround', id, existingWorkaround),
    satisfactionWithWorkaround: attributed('satisfactionWithWorkaround', id, satisfactionWithWorkaround),
    urgency: attributed('urgency', id, urgency),
  };

  return Object.freeze({
    id, at, organization, organizationType, organizationSize, role, internal,
    workflow,
    ...interpreted,
    currentTools: Object.freeze([...currentTools]),
    failureModes: Object.freeze([...failureModes]),
    // WHAT THEY USE INSTEAD. Optional, because a first conversation that only
    // reached the workflow is still a real conversation; absent is absent and
    // is never read as "no alternative exists".
    alternatives: Object.freeze(alternatives.map((a) => alternativeInUse(a, `interview ${id}`))),
    commercial: commercialSignal(commercial, `interview ${id}`),
    willingnessToChange, willingnessToPay, statedAmount,
    capabilityFit,
    patternTags: Object.freeze([...patternTags]),
    followUp, designPartnerInterest, notes,

    /** How much of this record is the customer's own account. */
    testimonyMix: Object.freeze(Object.fromEntries(ATTRIBUTION.map((a) => [a,
      Object.values(interpreted).filter((t) => t.said === a).length]))),
    /** True when nothing load-bearing rests on the founder's interpretation. */
    restsOnTestimony: interpreted.pain.said === 'STATED',
  });
}

/**
 * A pain named INDEPENDENTLY by more than one organization.
 *
 * Independence is by organization, not by interview. Three people at one
 * company describing the same frustration is one organization's frustration,
 * however strongly they agree with each other — and treating it as three is the
 * error that turns a bespoke build into a "product".
 */
export function repeatedPatterns(interviews, { minOrganizations = 2 } = {}) {
  const byTag = new Map();
  for (const i of interviews) {
    for (const tag of i.patternTags) {
      const entry = byTag.get(tag) ?? { tag, organizations: new Set(), interviews: [], external: new Set() };
      entry.organizations.add(i.organization);
      if (!i.internal) entry.external.add(i.organization);
      entry.interviews.push(i.id);
      byTag.set(tag, entry);
    }
  }
  return [...byTag.values()]
    .filter((e) => e.organizations.size >= minOrganizations)
    .map((e) => Object.freeze({
      tag: e.tag,
      organizations: e.organizations.size,
      externalOrganizations: e.external.size,
      interviews: Object.freeze([...e.interviews]),
      // A pattern named only inside the deploying organization is a strong
      // signal about that customer and no signal at all about a market.
      externallyCorroborated: e.external.size >= minOrganizations,
    }))
    .sort((a, b) => b.organizations - a.organizations || a.tag.localeCompare(b.tag));
}

/** The counts the readiness scorecard reads. Nothing is inferred here. */
export function summarize(interviews) {
  const external = interviews.filter((i) => !i.internal);
  const patterns = repeatedPatterns(interviews);
  return Object.freeze({
    interviews: interviews.length,
    externalInterviews: external.length,
    organizations: new Set(interviews.map((i) => i.organization)).size,
    externalOrganizations: new Set(external.map((i) => i.organization)).size,
    repeatedPatterns: patterns.filter((p) => p.externallyCorroborated).length,
    allPatterns: patterns.length,
    designPartnerCandidates: external.filter((i) => i.designPartnerInterest).length,
    statedAmounts: external.filter((i) => i.willingnessToPay === 'WOULD_PAY_STATED_AMOUNT').length,
    activelyLooking: external.filter((i) => i.willingnessToChange === 'ACTIVELY_LOOKING').length,
    // HOW MANY CONVERSATIONS REACHED THE TWO NEW QUESTIONS. Counted separately
    // from the interview count because an interview that never got to "what do
    // you use instead" is not weak evidence about alternatives, it is no
    // evidence about them, and the difference decides the next phone call.
    alternativesRecorded: interviews.filter((i) => i.alternatives.some((a) => a.fromCustomer)).length,
    commercialRecorded: interviews.filter((i) => i.commercial.fromCustomer).length,
  });
}

/**
 * The questions, in the order that produces useful answers.
 *
 * Order matters more than wording. Asking about AWE first produces politeness;
 * asking about their Tuesday produces a workflow. The money question comes last
 * because it changes how everything before it is answered.
 */
export const PROTOCOL = Object.freeze([
  'Walk me through what happens when [workflow] comes up. Start from the beginning.',
  'Who touches it, and in what order?',
  'How often does that happen — a day, a week?',
  'What do you use to do it today?',
  'How long does each of those steps take, when it goes normally?',
  'And when it goes wrong — what does that look like, and how often?',
  'What does it cost you when it goes wrong?',
  'What do you do about it today? Has anybody built a workaround?',
  'If this were solved, what would change for you?',
  'Is this something you are actively trying to fix, or something you live with?',
  'What would you expect something that fixed it to cost?',
  'Would you be willing to try it early, and tell us what is wrong with it?',
]);
