// ---------------------------------------------------------------------------
// narrative.mjs — the presentation, as a structure that reads evidence.
//
// WHAT THIS IS. A pitch has beats; each beat makes an audience believe one
// thing; each belief needs evidence; and the evidence already exists somewhere
// canonical in this repository or does not exist at all. This file is the join
// between those three, and nothing else.
//
// WHAT IT IS NOT, and the distinction is the whole point:
//
//   NOT A DECK      there is no copy here, no slide, no image, no script. Those
//                   are written late, from this, when the evidence has earned
//                   them. Freezing wording in September for a February
//                   submission produces a document that is edited by hand every
//                   time reality changes, which is the failure mode this file
//                   exists to remove.
//   NOT A PLANNER   programs/venture/plan.mjs already answers "what should we do
//                   next" and does it with gates, tracks and refusals. Every
//                   gap found here names the CLAIM that owns it, and the action
//                   comes from the planner. A second planner is a second answer.
//   NOT A SCORECARD programs/iic-2027/readiness.mjs scores twelve company
//                   dimensions. This scores twelve PRESENTATION BEATS, which is
//                   a different question: a beat can be unpresentable while the
//                   company behind it is fine, and vice versa.
//
// THE COMPOUNDING PROPERTY, which is the reason to build it now rather than in
// February: every number a beat needs is READ, never stored. When a baseline is
// measured, the value beat improves without anybody editing a narrative
// document. When five interviews are recorded, the market beat improves. When a
// rehearsal is mistaken for a deployment, it does not improve, because the
// slot that would have improved refuses rehearsal evidence by name.
//
// JUDGE IMPORTANCE IS NOT MY OPINION. Beats are weighted by how many of the
// EIGHT PUBLISHED JUDGING CRITERIA they serve — see JUDGING_CRITERIA below and
// competition-intelligence.md for the source and its age. Weighting by taste
// was the first design and it was wrong: it produced a ranking that could not
// be argued with, because there was nothing behind it to argue about.
//
// PURE: no clock, no randomness, no I/O. Facts arrive from
// programs/iic-2027/derive.mjs, the same object the scorecard and the planner
// read. This file computes no evidence of its own; a test asserts it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The audience's rubric
// ---------------------------------------------------------------------------

/**
 * The eight criteria the final pitches are judged on.
 *
 * VERIFIED, AND OLD. Quoted from Iona's own report of the SECOND annual
 * challenge (2019), retrieved 2026-09-01: pitches are judged on "feasibility,
 * uniqueness, market need, impact, cost of implementation, ease of
 * implementation, idea articulation, and overall impression". No later edition
 * publishes a rubric, and the 2027 rubric is UNKNOWN.
 *
 * SEVEN YEARS IS LONG ENOUGH FOR A RUBRIC TO CHANGE, so this list is used the
 * way an old map is used: it is far better than walking without one, and the
 * first thing to do on arrival is check it. Confirming the current rubric is
 * one email to the Hynes Institute and is listed as an UNKNOWN in
 * competition-intelligence.md for that reason.
 *
 * WHAT IT ALREADY CHANGES, and this is why recovering it mattered more than any
 * other piece of competition intelligence:
 *
 *   · There is NO traction criterion and NO revenue criterion. AWE's two
 *     weakest areas are not, on this evidence, directly scored.
 *   · There is NO team criterion. The founder story earns its place by making
 *     the problem credible, not by being scored.
 *   · TWO of the eight — cost of implementation and ease of implementation —
 *     are about whether the thing can actually be built and run. A system in
 *     production at a real company is overwhelming evidence for both, and it is
 *     the one thing AWE will have that a concept entry cannot.
 *   · TWO of the eight — idea articulation and overall impression — are pure
 *     narrative. Half the remaining marks are won by being understood.
 *
 * A pitch built to the venture-capital rubric (traction, market size, team,
 * ask) would spend its time on three things nobody here is scoring.
 */
export const JUDGING_CRITERIA = Object.freeze([
  'feasibility',
  'uniqueness',
  'market_need',
  'impact',
  'cost_of_implementation',
  'ease_of_implementation',
  'idea_articulation',
  'overall_impression',
]);

/** Where that list came from, carried with it so it cannot drift into folklore. */
export const CRITERIA_PROVENANCE = Object.freeze({
  quote: 'feasibility, uniqueness, market need, impact, cost of implementation, ease of implementation, idea articulation, and overall impression',
  edition: '2nd annual (2019)',
  url: 'https://www.iona.edu/about/news-events/news/second-annual-iona-innovation-challege-winners-ann.aspx',
  retrieved: '2026-09-01',
  caveat: 'Seven editions old. The 2027 rubric is UNKNOWN and is one email to the Hynes Institute.',
});

// ---------------------------------------------------------------------------
// The canonical explanation
// ---------------------------------------------------------------------------

/**
 * What AWE is, in the words the audience hears first.
 *
 * ONE PLACE. The video, the executive summary, the deck and the spoken pitch
 * all read from here, so there is never a version of AWE that exists only in
 * one artifact and only until somebody notices.
 *
 * THE FOUR THINGS IT HAS TO CARRY: what kind of work this is (operational, not
 * strategic); that AWE EXECUTES rather than advises; that it does so under the
 * organization's own rules; and that the payoff is human time. Alternatives
 * considered, and why each was rejected, are in pitch-architecture.md §3 —
 * including the version this file was originally handed, which failed on two of
 * the four.
 *
 * WHAT IS DELIBERATELY ABSENT: agent, ontology, kernel, orchestration, context
 * assembly, capability graph, platform, AI. Every one of them is true and every
 * one of them costs a judge four seconds of translation at the exact moment
 * they are deciding whether to keep listening. They are available in Q&A, where
 * a question has already bought the attention they need.
 *
 * NOT FROZEN COPY. The claim inside it — that a company's people stop doing the
 * work — is a description of what the software does, not a quantity of hours
 * saved. Hours are a MEASURED number and appear only in the proof beat, only
 * when proof/ will produce one. That separation is the difference between a
 * sentence that survives Q&A and one that starts it.
 */
export const ONE_SENTENCE = Object.freeze({
  spoken:
    'Every business runs on work that is really just moving information between people, paper, ' +
    'email and software. AWE does that work itself, under the company\'s own rules, so the ' +
    'people don\'t have to.',
  written:
    'AWE is software that does a company\'s routine operational work — the requests, approvals, ' +
    'purchase orders and follow-ups — by that company\'s own rules, instead of leaving people to ' +
    'carry it between paper, email and other software.',
  hook: 'AWE does the office work itself.',
  contrast: 'Today\'s AI answers questions. AWE does the work, and it can show you what it did.',
});

// ---------------------------------------------------------------------------
// Evidence slots
// ---------------------------------------------------------------------------

/**
 * Where a slot's content came from, ranked.
 *
 * THE RANKING IS THE SAFETY PROPERTY. A rehearsal against a synthetic company
 * produces exactly the shape of a real result — that is what makes it a useful
 * rehearsal and what makes it the most dangerous number in the repository — so
 * a slot filled from one can never reach STRONG. `derive.mjs` already refuses
 * to count executions from a database that will not call itself production;
 * this is the same rule applied to the presentation.
 */
export const SOURCES = Object.freeze(['REAL', 'REHEARSAL', 'ARCHITECTURE', 'NONE']);
const SOURCE_RANK = new Map(SOURCES.map((s, i) => [s, SOURCES.length - i]));

export const BEAT_STATUS = Object.freeze(['STRONG', 'INFERRED', 'PARTIAL', 'NOT_READY']);

const COST_RANK = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3 });

/** A slot's reading. `value` is for display only; `source` decides everything. */
function slot(source, value, provenance) {
  return { known: source !== 'NONE', source, value, provenance };
}
const EMPTY = (why) => slot('NONE', why, null);

/**
 * The evidence slots, defined once and shared by whatever beats need them.
 *
 * DEFINED ONCE ON PURPOSE. "How many external interviews" appears in the market
 * beat, the repeatability beat and the one-minute video, and three copies of
 * that question are three answers on the day they disagree. A slot is a
 * question with exactly one reader.
 *
 * `owner` names the claim in programs/venture/claims.mjs that moves this slot.
 * That is the handoff to the planner: this file finds the gap, claims.mjs owns
 * it, plan.mjs says what to do about it on a Tuesday. A test asserts every
 * owner is a real claim id, because a dangling owner is a gap nobody is
 * assigned to close.
 *
 * `independentValue` answers "would we want this even if the competition were
 * cancelled?" — the rule this whole directory is held to. It is a tie-break in
 * the gap ranking and a column in the report, so that a gap which is worth
 * closing only for a pitch is visible as such.
 */
export const SLOTS = Object.freeze([
  {
    id: 'workflow_before',
    label: 'The pre-AWE workflow, drawn from the real business',
    owner: 'problem_real', cost: 'LOW', independentValue: true,
    read: (f) => (f.artifacts?.workflowMapped
      ? slot('REAL', 'the current workflow is mapped from the business itself', 'docs/planning/CURRENT_WORKFLOW.md')
      : EMPTY('the pre-AWE workflow has not been written down')),
  },
  {
    id: 'founder_proximity',
    label: 'Evidence the founder was inside the business, not researching it',
    owner: 'problem_real', cost: 'LOW', independentValue: true,
    // A recorded interview with the person who runs the work is the artifact a
    // person outside the company can check. "I worked there" is a sentence.
    read: (f) => (f.artifacts?.bossInterviewRecorded
      ? slot('REAL', 'the operator was interviewed inside the business and the record is in the repository', 'docs/planning/BOSS_INTERVIEW.md')
      : EMPTY('no recorded conversation with the person who runs the work')),
  },
  {
    id: 'customer_quote',
    label: 'A person describing this work in their own words',
    owner: 'problem_real', cost: 'LOW', independentValue: true,
    // TWO SOURCES, AND THE ORDER MATTERS. The discovery corpus is the real
    // answer. The interview with the operator of the first business is a
    // genuine recorded conversation and it is REAL evidence — for the OPENING
    // beat, which is explicitly about one company. It is not evidence for the
    // market beat, which requires `external_interviews` and cannot be satisfied
    // from inside the building. Keeping one slot honest about which beat it can
    // serve is cheaper than two slots that look alike.
    read: (f) => {
      const n = f.discovery?.interviews ?? 0;
      if (n > 0) return slot('REAL', `${n} recorded interview(s)`, 'programs/discovery/interviews/');
      if (f.artifacts?.bossInterviewRecorded) {
        return slot('REAL', 'one recorded conversation, inside the deploying organization — enough for the opening beat, not for the market beat',
          'docs/planning/BOSS_INTERVIEW.md');
      }
      return EMPTY('no interview has been recorded');
    },
  },
  {
    id: 'external_interviews',
    label: 'Conversations outside the deploying organization',
    owner: 'external_pain', cost: 'LOW', independentValue: true,
    read: (f) => {
      const n = f.discovery?.externalInterviews ?? 0;
      const orgs = f.discovery?.externalOrganizations ?? 0;
      if (n === 0) return EMPTY('nobody outside the first company has been asked');
      return slot('REAL', `${n} interview(s) across ${orgs} outside organization(s)`, 'programs/discovery/interviews/');
    },
  },
  {
    id: 'repeated_pain',
    label: 'The same pain named independently by more than one organization',
    owner: 'external_pain', cost: 'LOW', independentValue: true,
    read: (f) => {
      const n = f.discovery?.repeatedPatterns ?? 0;
      if (n === 0) return EMPTY('no pain has been named independently by two organizations');
      return slot('REAL', `${n} repeated pattern(s)`, 'programs/discovery/patterns.mjs');
    },
  },
  {
    id: 'plain_language_test',
    label: 'A non-technical person restating what AWE does, correctly',
    owner: 'awe_solves', cost: 'LOW', independentValue: true,
    // The only test of an explanation. It cannot be derived and it cannot be
    // self-assessed: the founder always understands the sentence.
    read: (f) => {
      const n = f.narrative?.plainLanguageTests ?? 0;
      if (n === 0) return EMPTY('nobody outside the project has repeated the one-sentence version back correctly');
      return slot('REAL', `${n} successful restatement(s)`, 'declared in programs/iic-2027/facts.mjs');
    },
  },
  {
    id: 'live_execution',
    label: 'The workflow running end to end, watchable',
    owner: 'awe_solves', cost: 'MEDIUM', independentValue: true,
    read: (f) => {
      if (f.demo?.liveDemoExists) return slot('REAL', 'a live demonstration exists', 'declared');
      if (f.deployment?.deployable) {
        return slot('ARCHITECTURE', 'the packaged artifact runs the workflow end to end in the suite; no demonstration has been built from it',
          'scripts/eval-purchasing-e2e.mjs');
      }
      return EMPTY('nothing installable exists to demonstrate');
    },
  },
  {
    id: 'demo_backup',
    label: 'A demonstration that survives no network and no server',
    owner: 'awe_solves', cost: 'LOW', independentValue: false,
    read: (f) => (f.demo?.backupExists
      ? slot('REAL', 'a backup demonstration exists', 'declared')
      : EMPTY('one bad network is the whole pitch')),
  },
  {
    id: 'production_executions',
    label: 'Real work done in production',
    owner: 'works_in_production', cost: 'HIGH', independentValue: true,
    read: (f) => {
      const n = f.usage?.executions ?? 0;
      const env = f.proof?.evidenceEnvironment;
      if (n === 0 && env && env !== 'production') {
        return slot('REHEARSAL', `a ${env} database exists; its executions are not production evidence`, 'programs/iic-2027/derive.mjs');
      }
      if (n === 0) return EMPTY('nothing has run in production');
      return slot('REAL', `${n} execution(s) over ${f.usage?.activeDays ?? 0} day(s)`, 'purchase_requests, via proof/adapters/purchasing-sqlite.mjs');
    },
  },
  {
    id: 'objective_success',
    label: 'Whether the organization\'s objective was achieved, not just the task',
    owner: 'works_in_production', cost: 'MEDIUM', independentValue: true,
    read: (f) => {
      const n = f.proof?.objectivesTested ?? 0;
      if (n > 0) return slot('REAL', `${n} execution(s) reached a state where the objective could be tested`, 'proof/case-study.mjs');
      if (f.proof?.objectiveTestable) {
        return slot('ARCHITECTURE', 'the objective test exists and nothing has reached it yet', 'proof/adapters/purchasing.mjs materialObjective()');
      }
      return EMPTY('no capability tests its own objective');
    },
  },
  {
    id: 'baseline',
    label: 'How the work was done before AWE, measured',
    owner: 'problem_economic', cost: 'MEDIUM', independentValue: true,
    read: (f) => {
      const b = f.proof?.baselineObservations ?? {};
      if (f.proof?.baselineMeasured) return slot('REAL', 'a measured baseline governs the case study', 'proof/baselines/frozen/');
      if ((b.stepsObserved ?? 0) > 0) {
        return slot('REAL', `${b.stepsObserved}/${b.stepsTotal} steps observed, ${b.observations} observation(s) — incomplete`,
          'proof/baselines/observations/lippolis-purchasing.json');
      }
      if (f.proof?.baselineFieldProtocolExists) {
        return slot('ARCHITECTURE', 'the method for measuring it is written and has not been carried out', 'docs/proof/LIPPOLIS_BASELINE_FIELD_PROTOCOL.md');
      }
      return EMPTY('no baseline and no method for one');
    },
  },
  {
    id: 'hours_returned',
    label: 'Human hours the organization got back',
    owner: 'measurable_value', cost: 'HIGH', independentValue: true,
    // THE HEADLINE NUMBER OF THE WHOLE PITCH, and the one the software refuses
    // to produce today. It is deliberately gated on the case-study grade rather
    // than on a value being computable: a number the standard would not let us
    // publish is not a number to build a beat on.
    read: (f) => {
      const grade = f.proof?.caseStudyGrade ?? 'NOT_READY';
      if (grade === 'NOT_READY') {
        return EMPTY('the case-study standard refuses to publish a value; ' +
          `${(f.proof?.caseStudyBlockers ?? []).length || 'several'} condition(s) unmet`);
      }
      return slot('REAL', `value published at ${f.proof?.confidence} confidence over ${f.proof?.valuedUnits} unit(s), graded ${grade}`,
        'proof/case-study-standard.mjs');
    },
  },
  {
    id: 'evidence_traceable',
    label: 'Any headline figure walked back to the executions behind it',
    owner: 'measurable_value', cost: 'LOW', independentValue: true,
    read: (f) => (f.proof?.architectureOperational
      ? slot('ARCHITECTURE', 'every figure has an --explain path; no production figure exists to walk yet', 'scripts/proof-case-study.mjs --explain')
      : EMPTY('no derivation path exists')),
  },
  {
    id: 'second_organization',
    label: 'A second organization running the same product',
    owner: 'not_hardcoded', cost: 'MEDIUM', independentValue: true,
    read: (f) => {
      const r = f.repeatability ?? {};
      if (r.externallyValidated) return slot('REAL', 'a real second organization is running it', 'declared with a witness');
      if (r.secondOrganizationProven) {
        return slot('REHEARSAL', `a synthetic second company was provisioned and driven end to end; ${r.profileHonouredPercent}% of the profile is configuration`,
          'scripts/eval-second-customer.mjs');
      }
      return EMPTY('nothing has been provisioned but the first company');
    },
  },
  {
    id: 'second_capability',
    label: 'A second, unrelated business process through the same architecture',
    owner: 'multi_capability', cost: 'MEDIUM', independentValue: true,
    // THE PATH TO REAL IS NAMED, and it is not "write a better adapter". It is a
    // second capability doing real work in production, counted by
    // `usage.capabilitiesInProduction`. Without that path the slot could only
    // ever be ARCHITECTURE, which would make the wedge beat permanently
    // unreachable — and a beat that can never be STRONG is a beat everybody
    // stops reading.
    read: (f) => {
      if ((f.usage?.capabilitiesInProduction ?? 0) >= 2) {
        return slot('REAL', `${f.usage.capabilitiesInProduction} capabilities are doing real work in production`, 'proof/organization.mjs');
      }
      if (f.proof?.secondCapabilityAdapter && f.proof?.capabilityNeutral) {
        return slot('ARCHITECTURE', 'a second capability feeds the same measurement boundary with no change to the arithmetic; neither has run in production',
          'proof/adapters/tegg.mjs');
      }
      return EMPTY('only one business process exists');
    },
  },
  {
    id: 'deployment_cost',
    label: 'What it costs to put this into a company that is not the first',
    owner: 'repeatable_deployment', cost: 'MEDIUM', independentValue: true,
    // Two of the eight judging criteria are cost and ease of implementation.
    // This is the slot that answers both, and today it answers them from a
    // rehearsal, which is honest and is not the same as an installation.
    read: (f) => {
      const r = f.repeatability ?? {};
      if ((f.usage?.organizations ?? 0) >= 2) {
        return slot('REAL', 'a second organization was installed and the elapsed time is recorded', 'the deployment record');
      }
      if (r.secondOrganizationProven) {
        return slot('REHEARSAL', `zero source changes were needed for the second company; ${r.profileHonouredPercent}% configuration`,
          'scripts/eval-second-customer.mjs, COMPANY_B_PROVISIONING_CHECKLIST.md');
      }
      return EMPTY('never attempted');
    },
  },
  {
    id: 'design_partner',
    label: 'An outside organization that has committed something, including time',
    owner: 'external_want', cost: 'MEDIUM', independentValue: true,
    read: (f) => {
      const signed = f.validation?.designPartners ?? 0;
      const candidates = f.discovery?.designPartnerCandidates ?? 0;
      if (signed > 0) return slot('REAL', `${signed} design partner(s)`, 'declared with a witness');
      if (candidates > 0) return slot('REAL', `${candidates} candidate(s) identified in discovery, none committed`, 'programs/discovery/interviews/');
      return EMPTY('no outside organization has committed anything');
    },
  },
  {
    id: 'unit_of_sale',
    label: 'What is being sold, and to whom',
    owner: 'will_pay', cost: 'LOW', independentValue: true,
    // A DEFINITION IS REAL EVIDENCE OF A DECISION, and nothing more. Somebody
    // wrote down what is being sold and signed it; that is a fact about this
    // company. Whether anybody will buy it is the NEXT slot, and it is the one
    // that decides whether the business beat can be delivered — which is why
    // `price_tested` is required rather than optional on that beat. Grading the
    // definition itself as ARCHITECTURE was the first version and it made the
    // business beat structurally unreachable: a beat that can never be STRONG
    // is a beat everybody learns to ignore.
    read: (f) => (f.businessModel?.unitDefined
      ? slot('REAL', 'the unit of sale is defined', 'declared with a witness')
      : EMPTY('the thing being sold has not been defined')),
  },
  {
    id: 'price_tested',
    label: 'A price put to a real prospect, and what they said',
    owner: 'will_pay', cost: 'HIGH', independentValue: true,
    read: (f) => {
      if ((f.revenue?.payingCustomers ?? 0) > 0) return slot('REAL', `${f.revenue.payingCustomers} paying customer(s)`, 'declared with a witness');
      if (f.businessModel?.pricingTested) return slot('REAL', 'a price was put to a prospect and the answer recorded', 'declared with a witness');
      if (f.businessModel?.pricingHypothesis) return slot('ARCHITECTURE', 'a price has been proposed and never put to anybody', 'declared');
      return EMPTY('no price has been proposed');
    },
  },
  {
    id: 'alternatives',
    label: 'What a trades business would buy instead, and what it does not do',
    owner: 'external_want', cost: 'LOW', independentValue: true,
    read: (f) => {
      const n = f.differentiation?.alternativesAnalysed ?? 0;
      if (n === 0) return EMPTY('no alternative has been analysed');
      if (!f.differentiation?.evidencedDifference) return slot('ARCHITECTURE', `${n} alternative(s) analysed; the difference is stated, not shown`, 'competitive-positioning.md');
      return slot('REAL', `${n} alternative(s) analysed and the difference demonstrated`, 'competitive-positioning.md');
    },
  },
  {
    id: 'governance',
    label: 'What the system is not allowed to do on its own',
    owner: 'awe_solves', cost: 'LOW', independentValue: true,
    // The answer to "what happens when the AI is wrong", and it is a product
    // fact rather than a promise: vendor email is draft-only by database
    // constraint. Architecture-sourced is the honest grade — it is proven by the
    // suite, not by a year of production.
    read: (f) => (f.deployment?.capabilities > 0 && f.proof?.architectureOperational
      ? slot('ARCHITECTURE', 'authority limits are enforced by the schema and asserted by the suite', 'scripts/eval-purchasing-authorization.mjs')
      : EMPTY('no enforced authority limits')),
  },
]);

const SLOT_BY_ID = new Map(SLOTS.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// The beats
// ---------------------------------------------------------------------------

/**
 * The presentation, as twelve beats.
 *
 * SELECTED ARCHITECTURE: proof-driven transformation, with two borrowings from
 * the classic venture order. The comparison, the attack on both, and why the
 * hybrid beat each of them is in pitch-architecture.md. In one line: the classic
 * order asks a judge to accept a market before they have seen the problem, and
 * this competition's own rubric does not score the slides that order exists to
 * set up.
 *
 * EVERY BEAT ANSWERS A QUESTION THE AUDIENCE IS ACTUALLY ASKING at that moment.
 * A beat with no `question` is a slide that exists because decks usually have
 * one, and a test refuses it.
 *
 * `criteria` names which of the eight published judging criteria the beat is
 * for. Every criterion must be served by at least one beat, and a beat serving
 * none is decoration; both are asserted.
 *
 * `killCondition` is when to CUT the beat. A deck with no kill conditions grows
 * until it is a document, and the four-minute final pitch — verified, 2019 —
 * has room for perhaps six of these twelve. `cutOrder` is the order they go:
 * highest number leaves first.
 */
export const BEATS = Object.freeze([
  {
    id: 'moment',
    title: 'The moment',
    question: 'Is there a real problem here, and can I see it?',
    takeaway: 'A real business loses real days to work that is just moving information around.',
    criteria: ['market_need', 'impact', 'overall_impression'],
    claims: ['problem_real'],
    // A drawn workflow shows what the work IS. A person saying it out loud is
    // what makes an audience believe it costs anybody anything, so both are
    // required. Mapping the workflow alone was enough to report this beat
    // STRONG in the first version, which flattered the one beat the whole
    // pitch opens on.
    slots: [{ id: 'workflow_before', required: true }, { id: 'customer_quote', required: true }],
    cutOrder: 1,
    killCondition: 'Never cut. If this beat goes, every later beat is a solution with nothing to attach to. Shorten it instead.',
  },
  {
    id: 'discovery',
    title: 'The discovery',
    question: 'Why does this person know that, and why should I believe them?',
    takeaway: 'The founder worked inside the business and hit the problem himself; he did not read about it.',
    criteria: ['market_need', 'overall_impression'],
    claims: ['problem_real'],
    slots: [{ id: 'founder_proximity', required: true }],
    cutOrder: 6,
    killCondition: 'Cut to a single sentence inside the opening beat if the pitch runs over four minutes. It is credibility, not content, and it can ride on one clause.',
  },
  {
    id: 'before',
    title: 'Before AWE',
    question: 'What exactly was the old way, and why was it bad?',
    takeaway: 'One request touched six people, three systems and a filing cabinet before anything was ordered.',
    criteria: ['market_need', 'impact', 'idea_articulation'],
    claims: ['problem_real', 'problem_economic'],
    slots: [{ id: 'workflow_before', required: true }, { id: 'baseline', required: false }],
    cutOrder: 4,
    killCondition: 'Cut if the demonstration itself shows the old path clearly enough. Two explanations of one workflow is one too many.',
  },
  {
    id: 'what_awe_is',
    title: 'What AWE is',
    question: 'What is this thing, in one sentence I could repeat to somebody else?',
    takeaway: 'Today\'s AI answers questions; AWE does the work, under the company\'s rules.',
    criteria: ['uniqueness', 'idea_articulation', 'overall_impression'],
    claims: ['awe_solves'],
    slots: [{ id: 'plain_language_test', required: true }],
    cutOrder: 2,
    killCondition: 'Never cut. If the audience cannot restate what AWE is, nothing after this beat is retained.',
  },
  {
    id: 'execution',
    title: 'Live execution',
    question: 'Does it actually work, or is this a description of something that would work?',
    takeaway: 'One request went in; a governed purchase order came out; nobody typed it.',
    criteria: ['feasibility', 'uniqueness', 'ease_of_implementation', 'overall_impression'],
    claims: ['awe_solves', 'works_in_production'],
    slots: [
      { id: 'live_execution', required: true },
      { id: 'demo_backup', required: true },
      { id: 'governance', required: false },
    ],
    cutOrder: 3,
    killCondition: 'Cut to the recording if the format forbids a live demonstration, which is UNKNOWN for the final. Never cut the beat itself: it is the only moment the audience sees the product rather than hears about it.',
  },
  {
    id: 'proof',
    title: 'Proof',
    question: 'Fine, it ran. What did it actually accomplish?',
    takeaway: 'Here is what it did in production, what the organization got back, and how you can check every number.',
    criteria: ['feasibility', 'impact', 'uniqueness'],
    claims: ['works_in_production', 'measurable_value'],
    slots: [
      { id: 'production_executions', required: true },
      { id: 'objective_success', required: true },
      { id: 'hours_returned', required: true },
      { id: 'evidence_traceable', required: false },
    ],
    cutOrder: 5,
    killCondition: 'Cut ONLY the unmeasured parts. If nothing in this beat is REAL by January, the beat becomes one honest sentence about what is not yet known, and the pitch leans on execution and repeatability. It is never replaced with an estimate.',
  },
  {
    id: 'market',
    title: 'Outside the first company',
    question: 'Is this one company\'s custom software?',
    takeaway: 'Other businesses describe the same problem, unprompted, in their own words.',
    criteria: ['market_need', 'impact'],
    claims: ['external_pain', 'external_want'],
    slots: [
      { id: 'external_interviews', required: true },
      { id: 'repeated_pain', required: true },
      { id: 'design_partner', required: false },
    ],
    cutOrder: 7,
    killCondition: 'Cannot be cut and cannot be faked. With no external evidence this beat is the single loudest silence in the pitch, and the honest version — "we have not asked anybody yet" — is worse than not reaching the beat at all. It is why external discovery outranks every pitch-shaped task.',
  },
  {
    id: 'repeatability',
    title: 'PCC is not the company',
    question: 'Is this a product or a project?',
    takeaway: 'Purchasing is one capability on a platform; a second organization and a second process run through the same thing unchanged.',
    criteria: ['uniqueness', 'cost_of_implementation', 'ease_of_implementation', 'impact'],
    claims: ['not_hardcoded', 'multi_capability', 'repeatable_deployment'],
    slots: [
      { id: 'second_organization', required: true },
      { id: 'deployment_cost', required: true },
      { id: 'second_capability', required: false },
    ],
    cutOrder: 8,
    killCondition: 'Cut the second-capability half if time is short; keep the second-organization half. A judge scoring cost and ease of implementation is scoring this beat.',
  },
  {
    id: 'business',
    title: 'Who pays, and for what',
    question: 'Is there a business here or only a system?',
    takeaway: 'A named buyer, a defined unit of sale, and a price argued from measured value rather than from a spreadsheet.',
    criteria: ['feasibility', 'market_need'],
    claims: ['will_pay'],
    slots: [{ id: 'unit_of_sale', required: true }, { id: 'price_tested', required: true }, { id: 'alternatives', required: false }],
    cutOrder: 9,
    killCondition: 'Cut to one sentence while the unit of sale is undefined. A business-model slide with no evidence invites the one question — "has anybody paid?" — whose answer we do not want to spend the Q&A on.',
  },
  {
    id: 'expansion',
    title: 'The wedge',
    question: 'How big does this get, and is that credible or wishful?',
    takeaway: 'Construction is where it starts because that is where the problem was found, not where it ends.',
    criteria: ['impact', 'market_need', 'uniqueness'],
    claims: ['path_beyond_wedge'],
    slots: [{ id: 'second_capability', required: true }, { id: 'second_organization', required: false }],
    cutOrder: 10,
    killCondition: 'Cut entirely if the second-capability slot is empty. A vision beat with no architectural evidence under it converts a credible pitch into a speculative one, and it is the single most common way a strong entry loses.',
  },
  {
    id: 'defensibility',
    title: 'Why this and not the obvious thing',
    question: 'Why can\'t they just use ChatGPT, or their existing software?',
    takeaway: 'Assistants answer, workflow tools report that a task finished; AWE reports whether the objective was achieved and refuses to state what it cannot measure.',
    criteria: ['uniqueness', 'feasibility'],
    claims: ['awe_solves', 'not_hardcoded'],
    slots: [{ id: 'alternatives', required: true }, { id: 'governance', required: false }, { id: 'evidence_traceable', required: false }],
    cutOrder: 11,
    killCondition: 'Cut from the spoken pitch and hold in Q&A. It is the best answer in the whole project and it is an ANSWER — it lands when a judge asks it and it sounds defensive when volunteered.',
  },
  {
    id: 'close',
    title: 'The close',
    question: 'What am I meant to remember tomorrow?',
    takeaway: 'People should not spend their working lives carrying information between systems.',
    criteria: ['overall_impression', 'impact', 'idea_articulation'],
    claims: [],
    slots: [],
    cutOrder: 12,
    killCondition: 'Never cut, never lengthen. If it needs evidence it is not a close.',
  },
]);

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/**
 * Read every slot once, then score every beat from the readings.
 *
 * ONCE is deliberate. A slot read twice in one assessment can return two
 * answers if a reader is ever made impure, and the failure would show up as a
 * beat that disagrees with itself in the same report.
 */
export function assessNarrative(facts = {}) {
  const readings = new Map(SLOTS.map((s) => [s.id, Object.freeze({ ...s.read(facts), id: s.id, label: s.label, owner: s.owner, cost: s.cost, independentValue: s.independentValue })]));

  const beats = BEATS.map((b) => {
    const slots = b.slots.map((ref) => {
      const r = readings.get(ref.id);
      if (!r) throw new Error(`beat "${b.id}" names an unknown evidence slot: ${ref.id}`);
      return Object.freeze({ ...r, required: ref.required });
    });
    const required = slots.filter((s) => s.required);
    const { status, why } = statusOf(required);
    return Object.freeze({
      id: b.id, title: b.title, question: b.question, takeaway: b.takeaway,
      criteria: Object.freeze([...b.criteria]),
      claims: Object.freeze([...b.claims]),
      slots: Object.freeze(slots),
      status, why,
      cutOrder: b.cutOrder,
      killCondition: b.killCondition,
      missing: Object.freeze(required.filter((s) => !s.known).map((s) => s.id)),
      weakLinks: Object.freeze(required.filter((s) => s.known && s.source !== 'REAL').map((s) => s.id)),
    });
  });

  return Object.freeze({
    beats: Object.freeze(beats),
    slots: Object.freeze([...readings.values()]),
    weakest: weakestBeat(beats),
    gaps: presentationGaps(beats, readings),
    criteriaCoverage: criteriaCoverage(beats),
  });
}

/**
 * A beat's status, from its required slots only.
 *
 * OPTIONAL SLOTS CANNOT RAISE A BEAT, which is the rule that stops a beat
 * looking healthy because of the evidence it did not need. They appear in the
 * report because they are what the beat gets STRONGER with, and they are the
 * first thing to add once the required ones are filled.
 *
 * A BEAT WITH NO REQUIRED SLOTS IS NOT STRONG, it is RHETORICAL — the close
 * asserts nothing checkable and is not supposed to. Calling it STRONG would put
 * a green light next to the one beat that carries no evidence at all, which is
 * exactly the reading a scorecard should never allow.
 */
function statusOf(required) {
  if (required.length === 0) return { status: 'STRONG', why: 'rhetorical — this beat makes no checkable claim and needs no evidence' };
  const known = required.filter((s) => s.known);
  if (known.length === 0) {
    return { status: 'NOT_READY', why: `none of the ${required.length} required slot(s) has any evidence` };
  }
  if (known.length < required.length) {
    return { status: 'PARTIAL', why: `${known.length} of ${required.length} required slot(s) filled; missing ${required.filter((s) => !s.known).map((s) => s.id).join(', ')}` };
  }
  const weak = known.filter((s) => s.source !== 'REAL');
  if (weak.length) {
    const worst = weak.map((s) => s.source).sort((a, b) => SOURCE_RANK.get(b) - SOURCE_RANK.get(a))[weak.length - 1];
    return { status: 'INFERRED', why: `every required slot is filled, but ${weak.map((s) => `${s.id} is ${s.source}`).join(' and ')} — ${worst === 'REHEARSAL' ? 'a rehearsal is not a customer' : 'code that can do it is not somebody having done it'}` };
  }
  return { status: 'STRONG', why: `all ${required.length} required slot(s) filled from real evidence` };
}

const STATUS_RANK = new Map(BEAT_STATUS.map((s, i) => [s, BEAT_STATUS.length - i]));

/**
 * The beat to worry about.
 *
 * WEAKEST BY STATUS, THEN BY WHAT IT COSTS THE SCORE. Two beats at NOT_READY
 * are not equally bad: the one serving four judging criteria is worse than the
 * one serving two. Ranking by status alone made the close and the market beat
 * look interchangeable, which they are not by a distance.
 *
 * Rhetorical beats are excluded outright. The close cannot be the weakest beat;
 * it has nothing to be weak about.
 */
export function weakestBeat(beats) {
  const candidates = beats.filter((b) => b.slots.some((s) => s.required));
  const ranked = [...candidates].sort((a, b) =>
    STATUS_RANK.get(a.status) - STATUS_RANK.get(b.status) ||
    b.criteria.length - a.criteria.length ||
    a.cutOrder - b.cutOrder);
  return ranked[0] ?? null;
}

/**
 * The evidence that would most improve the presentation, ranked.
 *
 * THE RANKING, stated so it can be argued with:
 *
 *   1. WHAT IT COSTS THE BEAT, first and above everything. A slot whose absence
 *      leaves a beat NOT_READY outranks one that leaves a beat merely INFERRED,
 *      whatever the arithmetic below says. A beat nobody can deliver is a hole
 *      in the argument; a beat delivered from a rehearsal is an argument with a
 *      caveat, and those are not the same size of problem. Ranking on leverage
 *      alone put "record a backup demo" above "ask anybody outside the company",
 *      which is how a presentation gets polished instead of earned.
 *   2. leverage = (judging criteria served × beats served) / cost
 *   3. independentValue, the rule this directory is held to: work worth doing
 *      whether or not the competition happens wins ties against work that is
 *      only worth doing for a pitch.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: recommend an action, or claim to outrank the
 * planner. This list ranks EVIDENCE by what it is worth to the PRESENTATION.
 * programs/venture/plan.mjs ranks WORK by what it is worth to the COMPANY, in
 * gate order, which is a different and more important question. When the two
 * disagree the planner wins — the competition is downstream of the company, and
 * a directory that forgot that would be the first thing to delete.
 *
 * A SLOT ALREADY FILLED FROM REAL EVIDENCE IS NOT A GAP. One filled from a
 * rehearsal is — that is the whole difference between the two words.
 */
export function presentationGaps(beats, readings) {
  const required = new Map();
  for (const b of beats) {
    for (const s of b.slots) {
      if (!s.required) continue;
      const e = required.get(s.id) ?? { beats: [], criteria: new Set(), worst: 'STRONG' };
      e.beats.push(b.id);
      for (const c of b.criteria) e.criteria.add(c);
      if (STATUS_RANK.get(b.status) < STATUS_RANK.get(e.worst)) e.worst = b.status;
      required.set(s.id, e);
    }
  }

  const gaps = [];
  for (const [id, use] of required) {
    const r = readings.get(id);
    if (r.known && r.source === 'REAL') continue;
    const def = SLOT_BY_ID.get(id);
    gaps.push({
      slot: id,
      label: r.label,
      status: r.known ? r.source : 'NONE',
      because: r.value,
      ownedByClaim: def.owner,
      cost: def.cost,
      independentValue: def.independentValue,
      beats: Object.freeze([...use.beats]),
      // The worst state this slot leaves a beat in. The sort key that matters.
      costsBeat: use.worst,
      judgeImportance: use.criteria.size,
      criteria: Object.freeze([...use.criteria]),
      leverage: (use.criteria.size * use.beats.length) / COST_RANK[def.cost],
    });
  }

  return Object.freeze(gaps.sort((a, b) =>
    STATUS_RANK.get(a.costsBeat) - STATUS_RANK.get(b.costsBeat) ||
    b.leverage - a.leverage ||
    b.judgeImportance - a.judgeImportance ||
    (b.independentValue === a.independentValue ? 0 : b.independentValue ? 1 : -1) ||
    a.slot.localeCompare(b.slot)).map(Object.freeze));
}

/**
 * How well the eight criteria are covered, and by what.
 *
 * A criterion served only by beats that are NOT_READY is a criterion nobody is
 * currently scoring us on favourably, however many beats point at it.
 */
export function criteriaCoverage(beats) {
  return Object.freeze(JUDGING_CRITERIA.map((c) => {
    const serving = beats.filter((b) => b.criteria.includes(c));
    const best = serving.map((b) => b.status).sort((a, b) => STATUS_RANK.get(b) - STATUS_RANK.get(a))[0] ?? 'NOT_READY';
    return Object.freeze({
      criterion: c,
      beats: Object.freeze(serving.map((b) => b.id)),
      strongestBeat: best,
      strongCount: serving.filter((b) => b.status === 'STRONG').length,
    });
  }));
}
