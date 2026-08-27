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
  workflow, pain, frequency, currentTools = [],
  humanTimeStated = null, failureModes = [], economicConsequence = null,
  existingWorkaround = null,
  willingnessToChange = 'NOT_ASKED', willingnessToPay = 'NOT_ASKED', statedAmount = null,
  capabilityFit = null, patternTags = [], followUp = null, designPartnerInterest = false,
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

  return Object.freeze({
    id, at, organization, organizationType, role, internal,
    workflow, pain, frequency,
    currentTools: Object.freeze([...currentTools]),
    // What THEY said their time costs. Testimony about their own work, and it
    // is a candidate baseline for their organization — never for anybody
    // else's, and never SELF_REPORTED evidence about ours.
    humanTimeStated,
    failureModes: Object.freeze([...failureModes]),
    economicConsequence, existingWorkaround,
    willingnessToChange, willingnessToPay, statedAmount,
    capabilityFit,
    patternTags: Object.freeze([...patternTags]),
    followUp, designPartnerInterest, notes,
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
