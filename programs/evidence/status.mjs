// ---------------------------------------------------------------------------
// status.mjs — what real evidence should the founder collect next?
//
// THE LOOP THIS CLOSES, and the only reason the file exists:
//
//   REAL FOUNDER ACTION -> VALIDATED EVIDENCE -> CANONICAL CLAIM
//   -> PRESENTATION SLOT -> READINESS -> NEXT ACTION
//
// Every one of those five arrows already existed. What did not exist was a view
// FROM the founder's end of it: `npm run plan` says which claim to move,
// `npm run pitch` says which beat is weakest, and neither says "go and ask five
// people to repeat a sentence back to you", which is the actual next physical
// act. This projects the same facts onto the things a person does.
//
// IT IS NOT A SECOND PLANNER, and the distinction is enforced rather than
// promised: every `action` below is READ from claims.mjs `nextAction`, and
// nothing here ranks work. The ordering is by EVIDENCE MAP, a fixed table of
// what unlocks what, and where the planner and this file disagree the planner
// is right — it knows about gates, and this knows about errands.
//
// AND IT BUILDS NOTHING. No dashboard, no CRM, no pipeline. The output is a
// page of text with five things on it.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

/**
 * Real event -> capture -> import -> fact -> slot -> claim -> beat.
 *
 * THE TABLE IS THE PHASE-7 MAPPING AND THE PHASE-10 AUDIT AT ONCE. Every row
 * names the file a person writes, the one command that validates it, and every
 * downstream id it moves — and a test asserts that each of those ids is real,
 * so a slot that gets renamed cannot leave a promise dangling here.
 *
 * `steps` is the audit: how many actions stand between something happening in
 * the world and the readiness number changing. Two is the target — write the
 * sheet, run the import — and a row above two is a row with friction left in
 * it. `external_interview` is at 2. Nothing is at 1, because validation is not
 * optional and a capture that skipped it is not evidence.
 */
export const EVIDENCE_MAP = Object.freeze([
  {
    id: 'plain_language_test',
    realEvent: 'Say the one-sentence explanation to somebody who has never heard of AWE, then ask them to say it back two minutes later.',
    capture: 'programs/evidence/records/comprehension/<id>.md',
    importAction: 'npm run evidence -- --import <file>',
    steps: 2,
    facts: ['narrative.plainLanguageTests'],
    slots: ['plain_language_test'],
    claims: ['awe_solves'],
    beats: ['what_awe_is'],
    dimensions: ['narrative'],
    minutes: 15,
    needs: 'people, not permission',
  },
  {
    id: 'external_interview',
    realEvent: 'Twenty minutes with somebody who does purchasing at a trades business that is not Lippolis.',
    capture: 'programs/discovery/interviews/<id>.md',
    importAction: 'npm run evidence -- --import <file>',
    steps: 2,
    facts: ['discovery.externalInterviews', 'discovery.externalOrganizations'],
    slots: ['external_interviews'],
    claims: ['problem_real', 'external_pain'],
    beats: ['market'],
    dimensions: ['customer_discovery', 'problem_evidence'],
    minutes: 45,
    needs: 'somebody else\'s twenty minutes',
  },
  {
    id: 'repeated_pain',
    realEvent: 'The same pain named, unprompted, by a second organization. Not a separate errand — it falls out of the interviews.',
    capture: 'the patternTags on each interview',
    importAction: 'npm run discovery',
    steps: 0,
    facts: ['discovery.repeatedPatterns'],
    slots: ['repeated_pain'],
    claims: ['external_pain'],
    beats: ['market'],
    dimensions: ['problem_evidence'],
    minutes: 0,
    needs: 'two organizations, independently',
  },
  {
    id: 'alternatives',
    realEvent: 'Ask, in an interview, what they use instead — and what fails, and why they have not fixed it.',
    capture: 'the alternatives block on each interview',
    importAction: 'npm run evidence -- --import <file>',
    steps: 0,
    facts: ['differentiation.alternativesAnalysed'],
    slots: ['alternatives'],
    claims: ['external_want'],
    beats: ['business', 'defensibility'],
    dimensions: ['differentiation'],
    minutes: 0,
    needs: 'the same conversation, four more questions',
  },
  {
    id: 'unit_of_sale',
    realEvent: 'Ask who would sign for it, who would use it, and what they would think they were buying.',
    capture: 'the commercial block on each interview',
    importAction: 'npm run evidence -- --import <file>',
    steps: 0,
    facts: ['businessModel.unitDefined'],
    slots: ['unit_of_sale'],
    claims: ['will_pay'],
    beats: ['business'],
    dimensions: ['business_model'],
    minutes: 0,
    needs: 'three outside organizations agreeing',
  },
  {
    id: 'lippolis_baseline',
    realEvent: 'A morning at Lippolis with a stopwatch and the filing cabinet, before the first real purchase runs through PCC.',
    capture: 'proof/baselines/observations/field/handling.csv',
    importAction: 'npm run baseline:import',
    steps: 2,
    facts: ['proof.baselineMeasured'],
    slots: ['baseline'],
    claims: ['problem_economic'],
    beats: ['before', 'proof'],
    dimensions: ['measurable_outcomes'],
    minutes: 180,
    needs: 'access to the office, and it must happen BEFORE go-live',
  },
  {
    id: 'mock_pitch',
    realEvent: 'Deliver the pitch to a person and write down what THEY said afterwards.',
    capture: 'programs/evidence/records/mock-pitch/<id>.md',
    importAction: 'npm run evidence -- --import <file>',
    steps: 2,
    facts: ['narrative.mockPitches', 'demo.rehearsals'],
    slots: [],
    claims: [],
    beats: [],
    dimensions: ['narrative', 'demo_quality'],
    minutes: 30,
    needs: 'a listener willing to be unkind',
  },
  {
    id: 'founder_story',
    realEvent: 'Confirm the five facts about your own history that the pitch rests on.',
    capture: 'programs/evidence/records/founder-story.json',
    importAction: 'npm run evidence -- --check',
    steps: 1,
    facts: ['founderStory.complete'],
    slots: [],
    claims: [],
    beats: ['discovery'],
    dimensions: [],
    minutes: 20,
    needs: 'nobody. This one is entirely yours.',
  },
  {
    id: 'design_partner',
    realEvent: 'An outside organization commits time or data.',
    capture: 'designPartnerInterest on an interview, then a declared fact with a witness',
    importAction: 'npm run evidence -- --import <file>',
    steps: 2,
    facts: ['validation.designPartners'],
    slots: ['design_partner'],
    claims: ['external_want'],
    beats: ['market'],
    dimensions: ['external_validation'],
    minutes: 0,
    needs: 'somebody else\'s decision. Not schedulable.',
  },
]);

/**
 * The founder-facing areas, in the order a person cares about them.
 *
 * These are NOT the twelve dimensions and NOT the twelve beats. They are the
 * five or six things somebody asks about AWE, and each one names which
 * dimension and which beat answers it — so the number here can never disagree
 * with the number there, because it is the same number.
 */
export const AREAS = Object.freeze([
  { id: 'what_awe_is', label: 'WHAT AWE IS', beat: 'what_awe_is', evidence: ['plain_language_test'] },
  { id: 'problem', label: 'THE PROBLEM', beat: 'before', evidence: ['lippolis_baseline'] },
  { id: 'market', label: 'MARKET', beat: 'market', evidence: ['external_interview', 'repeated_pain', 'design_partner'] },
  { id: 'proof', label: 'PROOF', beat: 'proof', evidence: ['lippolis_baseline'] },
  { id: 'business', label: 'BUSINESS', beat: 'business', evidence: ['unit_of_sale'] },
  { id: 'defensibility', label: 'DEFENSIBILITY', beat: 'defensibility', evidence: ['alternatives'] },
  { id: 'repeatability', label: 'REPEATABILITY', beat: 'repeatability', evidence: ['design_partner'] },
  { id: 'narrative', label: 'NARRATIVE & DEMO', beat: 'execution', evidence: ['mock_pitch', 'plain_language_test'] },
]);

const MAP_BY_ID = new Map(EVIDENCE_MAP.map((e) => [e.id, e]));

/**
 * What is needed, per area, and what act would supply it.
 *
 * `status` is the BEAT's status, unchanged, read from the narrative assessment.
 * `nextAction` is the CLAIM's action, unchanged, read from the plan. Neither is
 * recomputed here; this file joins them and adds the errand.
 */
export function evidenceStatus({ narrative, claims, facts = {} }) {
  const beatById = new Map(narrative.beats.map((b) => [b.id, b]));
  const claimById = new Map(claims.map((c) => [c.id, c]));
  const slotById = new Map(narrative.slots.map((s) => [s.id, s]));

  return Object.freeze(AREAS.map((a) => {
    const beat = beatById.get(a.beat);
    const rows = a.evidence.map((id) => MAP_BY_ID.get(id));
    // What is MISSING, from the slots this area's evidence fills. A slot
    // already REAL is not needed, however much more of it could exist.
    const needed = [];
    for (const row of rows) {
      for (const slotId of row.slots) {
        const s = slotById.get(slotId);
        if (s && s.known && s.source === 'REAL') continue;
        needed.push(Object.freeze({ evidence: row.id, slot: slotId, what: row.needs, realEvent: row.realEvent }));
      }
      if (row.slots.length === 0) needed.push(Object.freeze({ evidence: row.id, slot: null, what: row.needs, realEvent: row.realEvent }));
    }
    const owningClaims = [...new Set(rows.flatMap((r) => r.claims))];
    const action = owningClaims.map((c) => claimById.get(c)).find((c) => c && c.grade !== 'MEASURED' && c.blockedBy.length === 0);

    return Object.freeze({
      id: a.id, label: a.label,
      beat: a.beat,
      status: beat?.status ?? 'NOT_READY',
      why: beat?.why ?? 'no beat',
      needed: Object.freeze(needed),
      // READ FROM THE PLANNER. If this line ever computes an action of its own,
      // there are two planners.
      nextAction: action?.nextAction ?? null,
      owningClaim: action?.id ?? null,
      blocked: Object.freeze(owningClaims
        .map((c) => claimById.get(c))
        .filter((c) => c && c.blockedBy.length)
        .map((c) => Object.freeze({ claim: c.id, blockedBy: c.blockedBy }))),
    });
  }));
}

/**
 * The queue, in the only three buckets that mean anything.
 *
 * THE BUCKETS ARE ABOUT WHO HAS TO SAY YES, not about priority:
 *
 *   TODAY           needs nobody's permission and no appointment
 *   THIS WEEK       needs one appointment, which can be made today
 *   WHEN AVAILABLE  needs somebody else to decide, and cannot be scheduled
 *
 * A DATE-BASED QUEUE WOULD BE PROJECT-MANAGEMENT THEATRE. "Overdue" against a
 * date this file invented is a false accusation; "waiting on a stranger" is a
 * true statement, and only the second one changes what anybody does.
 */
export function founderQueue(status, { facts = {} } = {}) {
  const open = status.filter((a) => a.status !== 'STRONG');
  const wanted = new Map();
  for (const a of open) {
    for (const n of a.needed) {
      const row = MAP_BY_ID.get(n.evidence);
      const e = wanted.get(row.id) ?? { row, unlocks: new Set() };
      e.unlocks.add(a.label);
      wanted.set(row.id, e);
    }
  }

  const bucket = (row) => {
    if (row.id === 'design_partner') return 'WHEN_AVAILABLE';
    if (row.needs.includes('Not schedulable')) return 'WHEN_AVAILABLE';
    if (row.steps === 0) return 'THIS_WEEK';             // rides on another errand
    if (row.needs.includes('permission') || row.minutes <= 20) return 'TODAY';
    return 'THIS_WEEK';
  };

  const tasks = [...wanted.values()].map(({ row, unlocks }) => Object.freeze({
    id: row.id,
    bucket: bucket(row),
    what: row.realEvent,
    why: row.needs,
    unlocks: Object.freeze([...unlocks]),
    unlocksClaims: Object.freeze([...row.claims]),
    minutes: row.minutes,
    capture: row.capture,
    then: row.importAction,
  }));

  const of = (b) => Object.freeze(tasks.filter((t) => t.bucket === b).sort((a, z) => a.minutes - z.minutes || a.id.localeCompare(z.id)));
  return Object.freeze({ today: of('TODAY'), thisWeek: of('THIS_WEEK'), whenAvailable: of('WHEN_AVAILABLE') });
}

/**
 * If the pitch were tomorrow, what could be said truthfully?
 *
 * REGENERATED FROM FACTS EVERY TIME. Nothing is stored, so this cannot drift
 * from the evidence the way a written summary does — which is the entire reason
 * it exists rather than a document called PITCH_STATUS.md.
 *
 * `mustNotClaim` IS DERIVED FROM ABSENCE, and each entry carries the fact that
 * would retire it. A list of prohibitions somebody typed is a list that goes
 * stale in the flattering direction: the sentence stays forbidden long after it
 * became true, so people stop reading it.
 */
export function pitchSnapshot({ facts, claims, narrative, demoTier = null }) {
  const supported = claims.filter((c) => c.grade === 'MEASURED');
  const partial = claims.filter((c) => c.grade !== 'MEASURED' && c.grade !== 'UNAVAILABLE');
  const unsupported = claims.filter((c) => c.grade === 'UNAVAILABLE');

  const strongest = [...narrative.slots]
    .filter((s) => s.known && s.source === 'REAL')
    .sort((a, b) => a.id.localeCompare(b.id));

  const mustNot = [];
  const forbid = (say, until) => mustNot.push(Object.freeze({ say, until }));

  if (!facts.repeatability?.externallyValidated) {
    forbid('That a second company is using AWE. Northgate is synthetic — not a customer, not a deployment, not a pilot.',
      'a real business other than Lippolis runs it');
  }
  if ((facts.proof?.caseStudyGrade ?? 'NOT_READY') === 'NOT_READY') {
    forbid('Any figure for hours or money saved, including "roughly" and "we think about".',
      'the case-study standard publishes a value');
  }
  if ((facts.usage?.executions ?? 0) === 0) {
    forbid('That AWE is running in production, or any elapsed-time claim for a real deployment.',
      'the first production execution');
  }
  if (facts.proof?.evidenceEnvironment && facts.proof.evidenceEnvironment !== 'production') {
    forbid(`Anything from the ${facts.proof.evidenceEnvironment} database presented as production.`,
      'a production-stamped installation exists');
  }
  if ((facts.discovery?.externalInterviews ?? 0) === 0) {
    forbid('That other businesses have this problem. Nobody outside the company has been asked.',
      'the first external interview');
  }
  if ((facts.discovery?.repeatedPatterns ?? 0) === 0) {
    forbid('That the problem is repeated across the industry, or any market size derived from it.',
      'two outside organizations name the same pain independently');
  }
  if (!facts.businessModel?.unitDefined) {
    forbid('Any price, and any statement about what AWE costs. An invented price invites "how did you get to that".',
      'customer evidence supports a unit of sale');
  }
  if ((facts.revenue?.payingCustomers ?? 0) === 0) {
    forbid('Anything that sounds like revenue.', 'somebody pays');
  }
  if ((facts.narrative?.plainLanguageTests ?? 0) === 0) {
    forbid('That the explanation is clear. Nobody outside the project has repeated it back.',
      'the first plain-language test comes back CLEAR');
  }
  if (!facts.founderStory?.mayTellTheIncident) {
    forbid('The specific founding incident. It has not been confirmed in this repository, and the founder story is the one part a judge cannot check.',
      'programs/evidence/records/founder-story.json records it with a date');
  }
  if ((facts.differentiation?.alternativesAnalysed ?? 0) === 0) {
    forbid('What any competitor\'s product can or cannot do. Nothing has been checked.',
      'businesses describe what they use instead');
  }

  return Object.freeze({
    supported: Object.freeze(supported.map((c) => Object.freeze({ id: c.id, claim: c.claim, because: c.because }))),
    partial: Object.freeze(partial.map((c) => Object.freeze({ id: c.id, claim: c.claim, grade: c.grade, because: c.because }))),
    unsupported: Object.freeze(unsupported.map((c) => Object.freeze({ id: c.id, claim: c.claim, because: c.because }))),
    bestDemo: demoTier,
    bestProof: Object.freeze(strongest.slice(0, 4).map((s) => Object.freeze({ slot: s.id, label: s.label, value: s.value }))),
    biggestWeakness: narrative.weakest
      ? Object.freeze({ beat: narrative.weakest.id, title: narrative.weakest.title, status: narrative.weakest.status, why: narrative.weakest.why })
      : null,
    mustNotClaim: Object.freeze(mustNot),
  });
}
