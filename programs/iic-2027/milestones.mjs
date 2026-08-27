// ---------------------------------------------------------------------------
// milestones.mjs — dated TARGETS, and the evidence each one would need.
//
// DATES ARE DERIVED FROM VERIFIED COMPETITION FACTS, not from a comfortable
// reading of the calendar. See programs/iic-2027/competition-intelligence.md:
// the 9th annual kicked off 6 February 2026 and ran its final on 30 April 2026,
// with a one-minute video as the first of three spring milestones. So the
// evidence deadline is JANUARY 2027, not April — the version of this file that
// said April was quietly assuming a quarter of runway that does not exist.
//
// These are targets, not achievements, and the distinction is enforced rather
// than trusted: a milestone has no `done` field. Whether it has been met is
// computed from the same facts the readiness scorecard reads, so a milestone
// cannot be ticked off by editing this file.
//
// That constraint is why the file is useful. A plan somebody can mark complete
// is a plan that gets marked complete.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Milestone
 * @property {string} at        the month it is aimed at
 * @property {string} target    what should be true
 * @property {(facts: object) => boolean} met  computed, never stored
 * @property {string} evidence  what would demonstrate it
 */
export const MILESTONES = Object.freeze([
  // --- September 2026 ------------------------------------------------------
  {
    at: '2026-09', id: 'proof_architecture',
    target: 'The proof architecture is operational: value claims are derived from evidence, and unknown stays unknown.',
    evidence: 'scripts/eval-proof.mjs passes; proof/ produces a case study from a live database',
    met: (f) => Boolean(f.proof?.architectureOperational),
  },
  {
    at: '2026-09', id: 'pcc_measurement_ready',
    target: 'PCC is instrumented: every execution it runs can be measured without further engineering.',
    evidence: 'proof/adapters/purchasing.mjs classifies every action in ACTIVITY_ACTIONS; the objective test runs from existing columns',
    met: (f) => Boolean(f.proof?.objectiveTestable) && (f.proof?.unclassifiedActions ?? 1) === 0,
  },
  {
    at: '2026-09', id: 'baseline_methodology',
    target: 'The method for measuring the pre-AWE process is written down and specific enough to follow.',
    evidence: 'docs/proof/BASELINE_METHODOLOGY.md; the Lippolis baseline names each step and what to observe',
    met: (f) => Boolean(f.proof?.baselineMethodologyExists),
  },
  {
    at: '2026-09', id: 'discovery_process',
    target: 'A customer-discovery process exists that can distinguish one customer\'s request from a market problem.',
    evidence: 'programs/discovery/interview.mjs; repeatedPatterns() requires independent organizations',
    met: (f) => Boolean(f.discovery?.processExists),
  },

  // --- December 2026 -------------------------------------------------------
  {
    at: '2026-12', id: 'production_evidence',
    target: 'Genuine production evidence: PCC in routine use, with measured objective success.',
    evidence: 'a case study over 30+ days with a non-zero objective success rate',
    met: (f) => (f.usage?.activeDays ?? 0) >= 30 && (f.proof?.objectivesTested ?? 0) > 0,
  },
  {
    at: '2026-12', id: 'first_case_study',
    target: 'A defensible Lippolis case study: baseline measured, hours returned computable, confidence stated.',
    evidence: 'proof-case-study.mjs prints a number rather than NOT MEASURABLE, at MODERATE confidence or better',
    met: (f) => Boolean(f.proof?.baselineMeasured) && ['MODERATE', 'HIGH'].includes(f.proof?.confidence),
  },
  {
    at: '2026-12', id: 'twenty_conversations',
    target: '20+ customer-discovery conversations outside the deploying organization.',
    evidence: 'programs/discovery/interviews/',
    met: (f) => (f.discovery?.externalInterviews ?? 0) >= 20,
  },
  {
    at: '2026-12', id: 'repeated_patterns',
    target: 'Pain patterns named independently by more than one outside organization.',
    evidence: 'repeatedPatterns() with externallyCorroborated',
    met: (f) => (f.discovery?.repeatedPatterns ?? 0) >= 3,
  },
  {
    at: '2026-12', id: 'design_partners',
    target: 'External design-partner candidates identified.',
    evidence: 'interviews recording designPartnerInterest',
    met: (f) => (f.discovery?.designPartnerCandidates ?? 0) >= 2,
  },

  // --- January 2027 --------------------------------------------------------
  //
  // THE REAL DEADLINE, and it is a quarter earlier than this file first said.
  //
  // Verified from Iona's own pages (programs/iic-2027/competition-intelligence.md,
  // retrieved 2026-08-27): the 9th annual kicked off 6 February 2026 and ran its
  // final on 30 April 2026, with three milestones across the spring semester and
  // a 1-minute video as the FIRST of them. So the evidence that appears in the
  // submission has to be collected and frozen before the February kickoff — not
  // gathered through April, which is what an earlier reading of "April 2027"
  // assumed and which would have left five months of runway on the table.
  {
    at: '2027-01', id: 'external_deployment',
    target: 'A second deployment, at an organization that is not the first.',
    evidence: 'a case study for a second orgId',
    met: (f) => (f.usage?.organizations ?? 0) >= 2,
  },
  {
    at: '2027-01', id: 'quantified_roi',
    target: 'Customer ROI quantified from evidence rather than asserted.',
    evidence: 'a case study with a known labourValueCents at MODERATE confidence or better',
    met: (f) => Boolean(f.proof?.moneyMeasurable) && ['MODERATE', 'HIGH'].includes(f.proof?.confidence),
  },
  {
    at: '2027-01', id: 'repeatable_deployment',
    target: 'A repeatable deployment story: the second installation did not require rebuilding the capability.',
    evidence: 'the redeployability measurement, plus a second organization proven',
    met: (f) => Boolean(f.repeatability?.secondOrganizationProven) && (f.repeatability?.profileHonouredPercent ?? 0) >= 75,
  },
  {
    at: '2027-01', id: 'evidence_frozen',
    target: 'The strongest evidence is frozen: a dated, reproducible case study nobody edits afterwards.',
    evidence: 'a case study exported with its period, baseline version, touch-standard version and confidence recorded',
    met: (f) => Boolean(f.narrative?.evidenceFrozen),
  },

  // --- February 2027: the kickoff, and Milestone 1 -------------------------
  //
  // Milestone 1 is a ONE-MINUTE VIDEO, and it is scored twice: as a milestone
  // and as the basis of the $1,000 Fan Favourite, which is decided on public
  // engagement. It is due within weeks of the kickoff, it is the first thing
  // anybody sees, and it is therefore the highest-leverage artifact in the whole
  // competition.
  {
    at: '2027-02', id: 'registered',
    target: 'Registered for the 10th annual challenge, with the real dates confirmed from Iona.',
    evidence: 'the UNKNOWN table in competition-intelligence.md is filled in from a reply or the kickoff',
    met: (f) => Boolean(f.competition?.datesConfirmed) && Boolean(f.competition?.registered),
  },
  {
    at: '2027-02', id: 'milestone_one_video',
    target: 'Milestone 1: the one-minute video pitch, built on frozen evidence.',
    evidence: 'the video exists and every figure in it traces to a frozen case study',
    met: (f) => Boolean(f.narrative?.oneMinuteExists) && Boolean(f.narrative?.evidenceFrozen),
  },
  {
    at: '2027-02', id: 'pricing_tested',
    target: 'The pricing hypothesis has been put to a real prospect and the answer recorded.',
    evidence: 'businessModel.pricingTested',
    met: (f) => Boolean(f.businessModel?.pricingTested),
  },
  {
    at: '2027-02', id: 'first_revenue',
    target: 'First external revenue.',
    evidence: 'a paying customer',
    met: (f) => (f.revenue?.payingCustomers ?? 0) >= 1,
  },

  // --- March 2027: Milestones 2 and 3 --------------------------------------
  {
    at: '2027-03', id: 'milestone_two_summary',
    target: 'Milestone 2: the executive summary.',
    evidence: 'the document exists',
    met: (f) => Boolean(f.narrative?.executiveSummaryExists),
  },
  {
    at: '2027-03', id: 'milestone_three_deck',
    target: 'Milestone 3: the pitch slide deck.',
    evidence: 'the deck exists',
    met: (f) => Boolean(f.narrative?.deckExists),
  },

  // --- April/May 2027: the final -------------------------------------------
  // Finalists are notified by mid-April; the final pitch is the first week of
  // May. Whether a live demo is permitted at the final is UNKNOWN, so a backup
  // that needs no network is planned for regardless.
  {
    at: '2027-04', id: 'pitch_ready',
    target: 'Live demo, backup demo and written answers to the hardest judge questions.',
    evidence: 'each artifact exists',
    met: (f) => Boolean(f.demo?.liveDemoExists) && Boolean(f.demo?.backupExists)
             && (f.narrative?.judgeQuestionsAnswered ?? 0) >= 10,
  },
  {
    at: '2027-04', id: 'rehearsed',
    target: 'Extensively mock-pitched, by people willing to be unkind.',
    evidence: 'mock pitch count',
    met: (f) => (f.narrative?.mockPitches ?? 0) >= 5,
  },
]);

/** Which targets the current facts actually meet. Computed, never stored. */
export function status(facts) {
  const rows = MILESTONES.map((m) => ({
    at: m.at, id: m.id, target: m.target, evidence: m.evidence, met: Boolean(m.met(facts)),
  }));
  const byMonth = new Map();
  for (const r of rows) {
    const b = byMonth.get(r.at) ?? [];
    b.push(r);
    byMonth.set(r.at, b);
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    months: Object.freeze([...byMonth.entries()].map(([at, items]) => Object.freeze({
      at,
      met: items.filter((i) => i.met).length,
      total: items.length,
      outstanding: Object.freeze(items.filter((i) => !i.met).map((i) => i.id)),
    }))),
  });
}
