// ---------------------------------------------------------------------------
// patterns.mjs — do different businesses describe the same problem?
//
// THE ONE QUESTION. An electrical contractor says "the guys text me what they
// need and half of it's wrong by the time it gets to the counter". An HVAC
// contractor says "we're re-keying the same order into three systems". Those
// might be one problem or two, and the difference decides whether AWE has a
// market or a customer.
//
// SO THE CUSTOMER'S WORDS ARE NEVER REPLACED, only tagged alongside. A taxonomy
// that overwrites what somebody said is a taxonomy that can only ever confirm
// itself: six months later nobody can check whether the tag was fair, because
// the sentence it was derived from is gone.
//
// THE CATALOGUE BELOW IS A STARTING VOCABULARY, NOT A SCHEMA. `interview.mjs`
// accepts any snake_case tag, and a tag not on this list is a FINDING rather
// than an error — it is how a pain nobody predicted gets discovered. This file
// reports unknown tags prominently for exactly that reason.
//
// WHAT THIS FILE REFUSES TO DO: say anything about the market. Five
// conversations that a founder arranged through his own network are a
// convenience sample of a convenience sample. Every projection here is labelled
// with what it is a statement ABOUT — this sample — and the one function that
// could be mistaken for a market claim returns a refusal instead.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

/**
 * Pains this catalogue has words for, drawn from what PCC was built against and
 * what the trade obviously shares. Each carries the capability that would
 * address it, or `null` where AWE has nothing.
 *
 * `null` is the important column. A pain reported by four businesses that AWE
 * cannot touch is the most valuable thing discovery can find, and a taxonomy
 * that only listed things we already do would never surface one.
 */
export const PAIN_CATALOGUE = Object.freeze({
  // AN ABSENCE IS A FINDING, AND IT IS NOT A PAIN. Two businesses agreeing that
  // ordering is fine is a real and valuable result — it belongs in the report,
  // and it must not advance a gate whose name is REPEATED_PAIN_OBSERVED. The
  // first version of this counted it and the market stage jumped on the
  // strength of two people saying they had no problem.
  no_purchasing_pain: {
    means: 'the business reports no problem in this area',
    capability: null,
    absence: true,
  },
  material_request_fragmentation: {
    means: 'requests arrive by phone, text and in person, and nothing holds them',
    capability: 'purchasing',
  },
  repeated_data_entry: {
    means: 'the same detail is typed into more than one system',
    capability: 'purchasing',
  },
  manual_po_creation: {
    means: 'purchase orders are written or typed by hand, including the number',
    capability: 'purchasing',
  },
  approval_delay: {
    means: 'work waits on one person to approve it',
    capability: 'purchasing',
  },
  approval_bottleneck: {
    means: 'everything routes through a single person by necessity, not by policy',
    capability: 'purchasing',
  },
  receiving_visibility: {
    means: 'nobody can say what actually turned up without a phone call',
    capability: 'purchasing',
  },
  status_visibility: {
    means: '"did that ship?" has no answer without asking somebody',
    capability: 'purchasing',
  },
  material_arrives_late: { means: 'the crew stands down waiting for material', capability: 'purchasing' },
  material_arrives_wrong: { means: 'wrong item, wrong quantity, or short', capability: 'purchasing' },
  po_numbering_pain: { means: 'numbering by hand, or the same number issued twice', capability: 'purchasing' },
  field_office_handoff: {
    means: 'what the field knows and what the office knows diverge',
    capability: 'purchasing',
  },
  paper_lost: { means: 'the paperwork exists somewhere', capability: 'purchasing' },
  invoice_reconciliation: {
    means: 'matching invoices to orders and receipts by hand',
    // PCC records ordered and received quantities, which is most of the input —
    // but it does not touch invoices, and saying otherwise would be a demo.
    capability: null,
  },
  job_costing_gap: {
    means: 'nobody knows what a job cost until it is finished',
    capability: null,
  },
  inspection_report_labor: {
    means: 'writing up a site inspection takes hours of somebody senior',
    capability: 'tegg_reporting',
  },
  proposal_preparation: {
    means: 'putting a quote or proposal together is slow and manual',
    capability: null,
  },
  document_routing: {
    means: 'getting a document to the right person is a manual chase',
    capability: null,
  },
  scheduling_churn: {
    means: 'crews and jobs are rescheduled constantly and by hand',
    capability: null,
  },
});

export const KNOWN_TAGS = Object.freeze(Object.keys(PAIN_CATALOGUE));

/**
 * What this sample shows. NOT what the market is.
 *
 * Every row says how many ORGANIZATIONS reported it, never how many
 * conversations: three people at one company agreeing is one company's opinion,
 * and counting it as three is the arithmetic that turns a bespoke build into a
 * "product".
 */
export function analyse(interviews, { minOrganizations = 2 } = {}) {
  const external = interviews.filter((i) => !i.internal);
  const orgs = new Set(external.map((i) => i.organization));

  const byTag = new Map();
  for (const i of interviews) {
    for (const tag of i.patternTags) {
      const e = byTag.get(tag) ?? {
        tag, organizations: new Set(), externalOrganizations: new Set(),
        interviews: [], roles: new Set(), types: new Set(),
        consequences: [], workarounds: [], tools: new Set(),
        statedFrequencies: [], quotes: [],
      };
      e.organizations.add(i.organization);
      if (!i.internal) e.externalOrganizations.add(i.organization);
      e.interviews.push(i.id);
      e.roles.add(i.role);
      if (i.organizationType) e.types.add(i.organizationType);
      for (const t of i.currentTools) e.tools.add(t);
      if (i.economicConsequence.value) {
        e.consequences.push({ said: i.economicConsequence.said, what: i.economicConsequence.value, org: i.organization });
      }
      if (i.existingWorkaround.value) {
        e.workarounds.push({ said: i.existingWorkaround.said, what: i.existingWorkaround.value, org: i.organization });
      }
      if (i.frequency.value) e.statedFrequencies.push({ said: i.frequency.said, what: i.frequency.value });
      if (i.pain.quote) e.quotes.push({ org: i.organization, quote: i.pain.quote });
      byTag.set(tag, e);
    }
  }

  const patterns = [...byTag.values()].map((e) => {
    const known = PAIN_CATALOGUE[e.tag] ?? null;
    // CORROBORATION IS BY ORGANIZATION AND EXCLUDES OUR OWN CUSTOMER. A pain
    // named by Lippolis and one outside business is one outside business.
    const externallyCorroborated = e.externalOrganizations.size >= minOrganizations;
    return Object.freeze({
      tag: e.tag,
      known: Boolean(known),
      means: known?.means ?? null,
      // The column that decides what this discovery is worth to us.
      capability: known?.capability ?? null,
      addressable: Boolean(known?.capability),
      // A recorded absence: corroborating it is a finding about the market and
      // is never evidence that a pain exists.
      absence: Boolean(known?.absence),
      organizations: e.organizations.size,
      externalOrganizations: e.externalOrganizations.size,
      interviews: Object.freeze([...e.interviews]),
      roles: Object.freeze([...e.roles].sort()),
      organizationTypes: Object.freeze([...e.types].sort()),
      toolsInUse: Object.freeze([...e.tools].sort()),
      // Kept with their attribution, so a consequence a founder inferred cannot
      // be read as one a customer reported.
      consequences: Object.freeze(e.consequences),
      workarounds: Object.freeze(e.workarounds),
      frequencies: Object.freeze(e.statedFrequencies),
      quotes: Object.freeze(e.quotes),
      statedConsequences: e.consequences.filter((c) => c.said === 'STATED').length,
      externallyCorroborated,
    });
  }).sort((a, b) =>
    b.externalOrganizations - a.externalOrganizations ||
    b.organizations - a.organizations ||
    a.tag.localeCompare(b.tag));

  const corroborated = patterns.filter((p) => p.externallyCorroborated);
  const corroboratedPains = corroborated.filter((p) => !p.absence);
  const corroboratedAbsences = corroborated.filter((p) => p.absence);

  return Object.freeze({
    // --- what the sample IS, stated before anything derived from it ---------
    sample: Object.freeze({
      interviews: interviews.length,
      externalInterviews: external.length,
      organizations: new Set(interviews.map((i) => i.organization)).size,
      externalOrganizations: orgs.size,
      organizationTypes: Object.freeze([...new Set(external.map((i) => i.organizationType).filter(Boolean))].sort()),
      roles: Object.freeze([...new Set(external.map((i) => i.role))].sort()),
      // How it was assembled. A founder's warm network is not a random sample
      // and the report should never let anybody forget it.
      selection: 'conversations the founder could arrange; not a random sample of any population',
    }),

    patterns: Object.freeze(patterns),
    corroborated: Object.freeze(corroborated),
    // What the market-validation gate counts. Absences are excluded: "two
    // businesses told me they have no problem" is worth knowing and is not a
    // repeated pain.
    corroboratedPains: Object.freeze(corroboratedPains),
    corroboratedAbsences: Object.freeze(corroboratedAbsences),

    // --- the two findings that matter most ---------------------------------
    // A pain several businesses have that AWE cannot address is a product
    // direction. A pain AWE addresses that nobody outside reported is a warning.
    unaddressed: Object.freeze(corroboratedPains.filter((p) => !p.addressable)),
    unknownTags: Object.freeze(patterns.filter((p) => !p.known).map((p) => p.tag)),
    awePainsNotCorroborated: Object.freeze(
      Object.entries(PAIN_CATALOGUE)
        .filter(([tag, v]) => v.capability && !corroboratedPains.some((p) => p.tag === tag))
        .map(([tag]) => tag)),

    // --- how much of this is the customers talking -------------------------
    testimony: Object.freeze({
      painsStated: interviews.filter((i) => i.pain.said === 'STATED').length,
      painsInferred: interviews.filter((i) => i.pain.said === 'INFERRED').length,
      consequencesStated: patterns.reduce((t, p) => t + p.statedConsequences, 0),
    }),
  });
}

/**
 * What may honestly be said about the market on this evidence.
 *
 * IT RETURNS A REFUSAL, and that is the function's purpose. Every early company
 * reaches a moment of writing "80% of contractors report X" from eight
 * conversations, and the arithmetic is correct and the sentence is false —
 * eight businesses a founder could reach through his own network cannot
 * estimate a population he did not sample.
 */
export function marketClaim(analysis) {
  const s = analysis.sample;
  const strongest = analysis.corroboratedPains[0] ?? null;

  return Object.freeze({
    mayNotSay: Object.freeze([
      'any percentage of the market, of contractors, or of the trade',
      'that a pain is "common", "widespread" or "universal"',
      'a market size derived from these conversations',
    ]),
    maySay: Object.freeze([
      `${s.externalInterviews} conversation(s) at ${s.externalOrganizations} organization(s) outside the deploying customer`,
      ...(strongest
        ? [`${strongest.externalOrganizations} of them independently described ${strongest.tag}`]
        : ['no pain has yet been described independently by two outside organizations']),
      `selected as: ${s.selection}`,
    ]),
    // A single sentence to paste, correct at whatever the sample currently is.
    sentence: strongest
      ? `Of ${s.externalOrganizations} construction businesses interviewed, ${strongest.externalOrganizations} independently described ${strongest.tag}. This is what we observed in our sample, not an estimate of the market.`
      : `${s.externalOrganizations} construction business(es) interviewed so far; no pain has yet been described independently by two of them.`,
  });
}
