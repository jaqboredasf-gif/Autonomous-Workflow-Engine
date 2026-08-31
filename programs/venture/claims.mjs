// ---------------------------------------------------------------------------
// claims.mjs — the twelve things AWE will eventually have to defend, and what
// would make each of them true.
//
// WHAT THIS IS NOT. It is not a scorecard — programs/iic-2027/readiness.mjs
// scores twelve DIMENSIONS and does it well. A dimension answers "how strong is
// this area"; a claim answers "could we say this sentence in front of somebody
// who will check". Those are different questions and the second one is the one
// that decides what to work on, because a claim carries what it REQUIRES, what
// it UNLOCKS, and who can move it.
//
// So this file adds ordering and interpretation, and computes no evidence. Every
// `assess` below reads the same facts object the scorecard reads, produced by
// programs/iic-2027/derive.mjs, which in turn reads proof/, deployment/,
// capability/ and programs/discovery/. If a number appears here that appears
// nowhere else, this file is wrong. A test asserts it.
//
// CONFIDENCE IS THE PROOF LAYER'S VOCABULARY, deliberately. MEASURED,
// ESTIMATED, INFERRED, SELF_REPORTED, UNAVAILABLE mean the same thing about a
// business claim as they mean about a quantity of hours, and inventing a second
// five-word scale would guarantee the two drift.
//
// NO MARKETING LANGUAGE IS A FACT. A claim is UNAVAILABLE until something
// outside a sentence supports it. "AWE produces measurable organizational
// value" is UNAVAILABLE today and will stay so until a measured baseline exists
// and real executions run against it, however good the architecture is.
//
// TRACKS, because "what should we do next" has more than one answer at once:
//
//   ENGINEERING  movable inside this repository, by writing or fixing code
//   FOUNDER      movable by a person, this week, without anybody's permission —
//                measuring a baseline, having a conversation
//   EXTERNAL     needs a decision or an action from somebody outside AWE. Never
//                an action; always a blocker, and naming it as one is the point.
//
// AND SOME CLAIMS ARE NOT TASKS AT ALL. `actionable: false` marks a claim that
// is EARNED rather than worked on: "AWE produces measurable organizational
// value" does not become true by building something, it becomes true when a
// measured baseline meets real production executions. Recommending it as an
// action is how a planner sends somebody to build a fourth abstraction layer
// for a number that is waiting on a person with a stopwatch.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { PROVENANCE_GRADES, weakestOf } from '../../proof/provenance.mjs';

export const TRACKS = Object.freeze(['ENGINEERING', 'FOUNDER', 'EXTERNAL']);
export const COSTS = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);

/** Strongest first, matching proof/provenance.mjs exactly. */
export const GRADES = PROVENANCE_GRADES;
const GRADE_RANK = new Map(GRADES.map((g, i) => [g, i]));

/** A claim is proven when something other than our own say-so supports it. */
export function isProven(status) {
  return status.grade === 'MEASURED';
}
/** Partially: there is evidence, and it is not yet the kind that settles it. */
export function isPartial(status) {
  return status.grade !== 'MEASURED' && status.grade !== 'UNAVAILABLE';
}

function at(grade, because, { have = [], missing = [], provenance = [] } = {}) {
  if (!GRADE_RANK.has(grade)) throw new Error(`unknown evidence grade: ${grade}`);
  return { grade, because, have, missing, provenance };
}

/**
 * The claims, in the order a company actually earns them.
 *
 * `requires` is a HARD prerequisite, and the bar is EVIDENCE EXISTS rather than
 * CLAIM PROVEN. A prerequisite blocks only when it is UNAVAILABLE — when there
 * is nothing at all. Blocking on MEASURED was the first version and it was
 * wrong in the expensive direction: almost every claim sits at INFERRED for
 * months, so everything blocked everything and the planner refused to recommend
 * the deployment work it exists to recommend.
 *
 * This is the property the scorecard alone does not have, and it is why the
 * scorecard could recommend "get executions into production" on a day when the
 * software cannot legally be installed yet.
 */
export const CLAIMS = Object.freeze([
  {
    id: 'problem_real',
    claim: 'The operational problem is real.',
    whyItMatters: 'Everything else is a solution looking for one.',
    requiredEvidence: [
      'a named person doing the work, describing it in their own words',
      'the same workflow described independently at more than one organization',
    ],
    requires: [], unlocks: ['problem_economic', 'external_pain'],
    actionable: true,
    track: 'FOUNDER', cost: 'LOW',
    assess: (f) => {
      const d = f.discovery ?? {};
      const n = d.interviews ?? 0;
      const orgs = d.organizations ?? 0;
      if (n === 0) {
        return at('UNAVAILABLE', 'no conversation with anybody who does this work has been recorded',
          { missing: ['one recorded interview with a person who does the work'] });
      }
      if (orgs < 2) {
        return at('SELF_REPORTED', `${n} conversation(s), all inside one organization — that is a customer, not a problem`,
          { have: [`${n} interview(s)`], missing: ['a conversation at a second organization'],
            provenance: ['programs/discovery/interviews/'] });
      }
      return at('MEASURED', `${n} conversations across ${orgs} organizations describe the same workflow`,
        { have: [`${n} interviews`, `${orgs} organizations`], provenance: ['programs/discovery/interviews/'] });
    },
    nextAction: () => 'Record one interview with a person who does purchasing at a trades business, using the protocol in programs/discovery/interview.mjs. Ask about their Tuesday, not about AWE.',
  },

  {
    id: 'problem_economic',
    claim: 'The problem is economically meaningful.',
    whyItMatters: 'A real annoyance that costs nothing does not get bought.',
    requiredEvidence: [
      'a measured pre-AWE handling time for the work, from observation or records',
      'a loaded labour rate from payroll, not from a guess',
    ],
    // NOTHING. Measuring how long Mike's purchasing took before PCC needs no
    // interview with a stranger — the work is observable at Lippolis today, and
    // it must be measured BEFORE production starts, so making it wait on
    // customer discovery would sequence it into being impossible.
    requires: [], unlocks: ['measurable_value', 'will_pay'],
    actionable: true,
    track: 'FOUNDER', cost: 'MEDIUM',
    assess: (f) => {
      const p = f.proof ?? {};
      const stated = f.discovery?.statedAmounts ?? 0;
      if (p.baselineMeasured) {
        return at('MEASURED', 'a measured baseline exists for the pre-AWE process',
          { have: ['measured baseline'], provenance: ['proof/baselines/'] });
      }
      if (stated > 0) {
        return at('SELF_REPORTED', `${stated} interviewee(s) put a figure on it; nothing has been measured`,
          { have: [`${stated} stated amount(s)`], missing: ['a measured baseline'] });
      }
      if (p.baselineFieldProtocolExists) {
        return at('UNAVAILABLE', 'the method for measuring it is written and has not been carried out',
          { have: ['docs/proof/LIPPOLIS_BASELINE_FIELD_PROTOCOL.md'],
            missing: ['observed handling times', 'a loaded labour rate from payroll'] });
      }
      return at('UNAVAILABLE', 'nothing has been measured and no method is written down',
        { missing: ['a baseline methodology', 'observed handling times'] });
    },
    nextAction: () => 'Carry out docs/proof/LIPPOLIS_BASELINE_FIELD_PROTOCOL.md, starting with items 2 and 3 — the dated paper POs — which need a filing cabinet and nobody\'s morning. It must happen BEFORE the first real purchase runs through PCC: a baseline cannot govern work that predates it, so those purchases would be permanently unvaluable. The sequencing is docs/proof/FIRST_REAL_PROOF_ACTIVATION.md.',
  },

  {
    id: 'awe_solves',
    claim: 'AWE solves the problem.',
    whyItMatters: 'The narrow version of "it works": the workflow runs end to end.',
    requiredEvidence: [
      'the whole workflow driven through the packaged artifact on an empty database',
      'an objective test that asks whether the organization got what it wanted, separately from whether the software finished',
    ],
    requires: [], unlocks: ['works_in_production'],
    actionable: true,
    track: 'ENGINEERING', cost: 'LOW',
    assess: (f) => {
      const p = f.proof ?? {};
      const d = f.deployment ?? {};
      if (!d.capabilities) return at('UNAVAILABLE', 'no capability has a stated contract', { missing: ['a capability contract'] });
      if (!p.objectiveTestable) {
        return at('SELF_REPORTED', 'the workflow runs, but nothing tests whether the objective was achieved',
          { missing: ['an objective test'] });
      }
      if (p.unclassifiedActions > 0) {
        return at('INFERRED', `${p.unclassifiedActions} audit action(s) are unclassified and would be priced as free`,
          { missing: ['every audit action classified'] });
      }
      return at('MEASURED', 'the workflow runs end to end against the packaged artifact, and the objective is tested separately from completion',
        { have: ['scripts/rehearse-locally.sh', 'objective test'],
          provenance: ['scripts/eval-production-coldstart.mjs', 'proof/adapters/purchasing.mjs'] });
    },
    nextAction: () => 'Run scripts/rehearse-locally.sh and fix whatever it reports.',
  },

  {
    id: 'works_in_production',
    claim: 'AWE works in production.',
    whyItMatters: 'A rehearsal proves the software. Only production proves the company.',
    requiredEvidence: [
      'a database that declared itself production at creation',
      'real transactions raised by the people whose job it is',
      'the installation surviving a reboot without a human',
    ],
    requires: ['awe_solves'], unlocks: ['measurable_value', 'repeatable_deployment'],
    actionable: true,
    track: 'EXTERNAL', cost: 'HIGH',
    assess: (f) => {
      const u = f.usage ?? {};
      const d = f.deployment ?? {};
      const env = f.proof?.evidenceEnvironment;
      if ((u.executions ?? 0) === 0) {
        const because = env && env !== 'production'
          ? `the only database offered declares itself "${env}" — its executions are not production evidence`
          : `nothing has run in production; the deployment can reach ${d.phase ?? 'UNKNOWN'}`;
        return at('UNAVAILABLE', because, {
          missing: ['a production-stamped installation', 'real transactions'],
          provenance: ['scripts/pcc-deployment-gate.mjs'],
        });
      }
      if (u.executions < 20) {
        return at('INFERRED', `${u.executions} execution(s) in production — a pilot, and possibly a demonstration`,
          { have: [`${u.executions} executions`] });
      }
      if ((u.activeDays ?? 0) < 30) {
        return at('ESTIMATED', `${u.executions} executions over ${u.activeDays} day(s) — real, not yet routine`,
          { have: [`${u.executions} executions`] });
      }
      return at('MEASURED', `${u.executions} executions over ${u.activeDays} days of routine production use`,
        { have: [`${u.executions} executions`, `${u.activeDays} days`] });
    },
    nextAction: () => 'Install PCC on LIPELE-RDS02 following docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md, and let Mike raise real purchases.',
  },

  {
    id: 'measurable_value',
    claim: 'AWE produces measurable organizational value.',
    whyItMatters: 'The claim a judge, a finance director and a customer all check first.',
    requiredEvidence: [
      'human hours returned, computed from a measured baseline against production executions',
      'a confidence grade that is not NONE',
      'objective outcomes observed, not inferred from the workflow completing',
    ],
    requires: ['works_in_production', 'problem_economic'], unlocks: ['will_pay', 'path_beyond_wedge'],
    actionable: false,
    track: 'FOUNDER', cost: 'HIGH',
    assess: (f) => {
      const p = f.proof ?? {};
      if (!p.architectureOperational) return at('UNAVAILABLE', 'no proof architecture exists', { missing: ['a proof layer'] });
      if (!p.baselineMeasured || !p.moneyMeasurable) {
        return at('UNAVAILABLE',
          'the architecture computes value and refuses to state one, because no measured baseline and no production executions exist yet',
          { have: ['proof/ operational and adversarially tested'],
            missing: ['a measured baseline', 'production executions'],
            provenance: ['scripts/eval-proof.mjs'] });
      }
      if (p.confidence === 'NONE' || p.confidence === 'LOW') {
        return at('ESTIMATED', `value is computed at ${p.confidence} confidence over ${p.valuedUnits} unit(s) of work`,
          { have: [`${p.valuedUnits} valued units`] });
      }
      return at('MEASURED', `value computed at ${p.confidence} confidence over ${p.valuedUnits} units of work`,
        { have: [`${p.valuedUnits} valued units`, `${p.confidence} confidence`] });
    },
    nextAction: () => 'Nothing to build. This becomes provable when a measured baseline meets real production executions, and not before.',
  },

  {
    id: 'multi_capability',
    claim: 'AWE works across more than one business capability.',
    whyItMatters: 'One capability is a product. Several is a company.',
    requiredEvidence: [
      'a second capability producing execution records through the same boundary',
      'the arithmetic unchanged by the second capability',
    ],
    requires: [], unlocks: ['path_beyond_wedge'],
    actionable: false,
    track: 'ENGINEERING', cost: 'MEDIUM',
    assess: (f) => {
      const p = f.proof ?? {};
      if (!p.capabilityNeutral) {
        return at('UNAVAILABLE', 'no organization-level view exists that more than one capability could feed',
          { missing: ['a capability-neutral aggregation'] });
      }
      if (!p.secondCapabilityAdapter) {
        return at('SELF_REPORTED', 'the aggregation claims to be capability-neutral and only one capability has been through it',
          { missing: ['a second capability adapter'] });
      }
      // The adapter exists and is tested against real ledgers, but the second
      // capability has produced no production evidence of its own.
      return at('INFERRED',
        'a second capability feeds the same boundary with no change to the arithmetic; it has produced no production value evidence',
        { have: ['proof/adapters/tegg.mjs', 'scripts/eval-tegg-generalization.mjs'],
          missing: ['production executions from the second capability', 'a baseline for it'],
          provenance: ['scripts/eval-tegg-generalization.mjs'] });
    },
    nextAction: () => 'Nothing to build. The boundary is proven; what is missing is production evidence from the second capability, which follows deployment.',
  },

  {
    id: 'not_hardcoded',
    claim: 'AWE is not hard-coded for one company.',
    whyItMatters: 'The difference between a product and a very good favour.',
    requiredEvidence: [
      'the share of the organization profile honoured by configuration rather than by code',
      'the capability proven against a second organization whose vocabulary shares no words with the first',
    ],
    requires: [], unlocks: ['repeatable_deployment'],
    actionable: true,
    track: 'ENGINEERING', cost: 'MEDIUM',
    assess: (f) => {
      const r = f.repeatability ?? {};
      const pct = r.profileHonouredPercent ?? null;
      if (pct === null) return at('UNAVAILABLE', 'nothing measures how much is configuration and how much is engineering', { missing: ['a profile measurement'] });
      if (!r.secondOrganizationProven) {
        return at('SELF_REPORTED', `${pct}% of the profile is honoured by configuration, never tested against a second organization`,
          { have: [`${pct}% honoured`], missing: ['a second organization profile'] });
      }
      if (pct < 85) {
        return at('INFERRED', `${pct}% of the profile is configuration, proven against a second organization's data and role names`,
          { have: [`${pct}% honoured`, 'second organization profile'],
            missing: [`the remaining ${100 - pct}% of extraction debt`],
            provenance: ['scripts/eval-organization-provisioning.mjs'] });
      }
      return at('MEASURED', `${pct}% of the profile is configuration, proven against a second organization`,
        { have: [`${pct}% honoured`], provenance: ['scripts/eval-organization-provisioning.mjs'] });
    },
    nextAction: (f) => `Extract the highest-value hard-coded fields named in capability/purchasing/profile.mjs. Currently ${f.repeatability?.profileHonouredPercent ?? 0}% is configuration.`,
  },

  {
    id: 'external_pain',
    claim: 'Businesses other than the first one have the same pain.',
    whyItMatters: 'Decides whether this is a market or a favour for a neighbour.',
    requiredEvidence: [
      'the same pain named independently by people at more than one outside organization',
      'enough conversations that a pattern is a pattern rather than a coincidence',
    ],
    requires: ['problem_real'], unlocks: ['external_want', 'will_pay'],
    actionable: true,
    track: 'FOUNDER', cost: 'LOW',
    assess: (f) => {
      const d = f.discovery ?? {};
      const n = d.externalInterviews ?? 0;
      const repeated = d.repeatedPatterns ?? 0;
      if (n === 0) return at('UNAVAILABLE', 'no conversation outside the deploying organization', { missing: ['5 external interviews'] });
      if (n < 5) return at('SELF_REPORTED', `${n} external interview(s) — anecdote`, { have: [`${n} interviews`], missing: [`${5 - n} more to reach the first checkpoint`] });
      if (repeated === 0) return at('INFERRED', `${n} external interviews and no pain named independently by two of them`, { have: [`${n} interviews`], missing: ['a repeated pattern'] });
      if (n < 20) return at('ESTIMATED', `${repeated} repeated pattern(s) across ${n} external interviews — below 20 a pattern is still noise`, { have: [`${repeated} patterns`] });
      return at('MEASURED', `${repeated} repeated patterns across ${n} external interviews`, { have: [`${repeated} patterns`, `${n} interviews`] });
    },
    nextAction: (f) => `Book the next ${Math.max(1, 5 - (f.discovery?.externalInterviews ?? 0))} conversation(s) from programs/discovery/CAMPAIGN.md — 10-60 employee trades businesses, at least one not electrical, twenty minutes each. Record each one with programs/discovery/interview.mjs; the pattern only counts when two different ORGANIZATIONS name it.`,
  },

  {
    id: 'external_want',
    claim: 'Businesses other than the first one want this solved.',
    whyItMatters: 'Pain people have decided to live with is not a market.',
    requiredEvidence: [
      'people outside the company committing something — time, data, a pilot',
      'somebody actively looking for a fix rather than content with a workaround',
    ],
    requires: ['external_pain'], unlocks: ['will_pay'],
    actionable: true,
    track: 'FOUNDER', cost: 'MEDIUM',
    assess: (f) => {
      const d = f.discovery ?? {};
      const partners = d.designPartnerCandidates ?? 0;
      const looking = d.activelyLooking ?? 0;
      const v = f.validation ?? {};
      if ((v.externalDeployments ?? 0) > 0) {
        return at('MEASURED', `${v.externalDeployments} external deployment(s)`, { have: [`${v.externalDeployments} deployments`] });
      }
      if ((v.designPartners ?? 0) > 0) return at('INFERRED', `${v.designPartners} design partner(s) committed time`, { missing: ['an external deployment'] });
      if (partners > 0 || looking > 0) {
        return at('SELF_REPORTED', `${partners} design-partner candidate(s), ${looking} actively looking — interest, not commitment`,
          { have: [`${partners} candidates`], missing: ['a committed design partner'] });
      }
      return at('UNAVAILABLE', 'no external organization has committed anything, including time', { missing: ['one design partner'] });
    },
    nextAction: () => 'Ask the strongest discovery conversation to be a design partner. Time and data, not money.',
  },

  {
    id: 'will_pay',
    claim: 'Customers will pay for it.',
    whyItMatters: 'The only test of value that cannot be argued with.',
    requiredEvidence: [
      'a defined unit of sale and a price put to a real prospect',
      'what they said, recorded, including a refusal',
    ],
    requires: ['external_want'], unlocks: [],
    actionable: true,
    track: 'FOUNDER', cost: 'HIGH',
    assess: (f) => {
      const r = f.revenue ?? {};
      const b = f.businessModel ?? {};
      const stated = f.discovery?.statedAmounts ?? 0;
      if ((r.payingCustomers ?? 0) > 0) return at('MEASURED', `${r.payingCustomers} paying customer(s)`, { have: [`${r.payingCustomers} customers`] });
      if (b.pricingTested) return at('INFERRED', 'a price has been put to somebody and not accepted', { missing: ['an acceptance'] });
      if (stated > 0) return at('SELF_REPORTED', `${stated} interviewee(s) named a figure unprompted — an opinion, not a purchase`, { have: [`${stated} stated amounts`] });
      if (b.pricingHypothesis) return at('SELF_REPORTED', 'a pricing hypothesis exists and has never been put to anybody', { missing: ['a price put to a prospect'] });
      return at('UNAVAILABLE', 'no unit of sale is defined and no price has been proposed', { missing: ['a defined unit', 'a pricing hypothesis'] });
    },
    nextAction: () => 'Define the unit of sale — per capability, per organization, per execution — and write down why. A hypothesis, not a price list.',
  },

  {
    id: 'repeatable_deployment',
    claim: 'Deployment can be repeated without rebuilding the product.',
    whyItMatters: 'The difference between a consultancy and a company that scales.',
    requiredEvidence: [
      'a deployment gate that reaches go-live on what is known',
      'a second installation performed from the same package by somebody else',
    ],
    requires: ['not_hardcoded'], unlocks: ['path_beyond_wedge'],
    actionable: true,
    track: 'ENGINEERING', cost: 'MEDIUM',
    assess: (f) => {
      const d = f.deployment ?? {};
      if (!d.deployable) return at('UNAVAILABLE', 'nothing is installable by somebody who is not us', { missing: ['a deployment package'] });
      if (d.phase === 'BLOCKED_BEFORE_BUILD') return at('UNAVAILABLE', 'the deployment cannot even be built on what is known', { missing: ['build-blocking facts'] });
      if (d.phase === 'BUILD_ONLY') {
        return at('SELF_REPORTED',
          `a package and a runbook exist; the gate says BUILD_ONLY with ${d.aweOwnedBlockers} blocker(s) we own`,
          { have: ['PCC_VM_INSTALLATION_RUNBOOK.md', 'docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md'],
            missing: d.blockers.filter((b) => b.kind !== 'EXTERNAL').map((b) => b.path),
            provenance: ['scripts/pcc-deployment-gate.mjs'] });
      }
      if (d.phase === 'DEPLOY_ONLY') {
        return at('INFERRED', 'everything AWE owns is cleared; go-live waits on facts only the customer has',
          { missing: d.blockers.map((b) => b.path), provenance: ['scripts/pcc-deployment-gate.mjs'] });
      }
      if ((d.deployments ?? 0) < 2) return at('ESTIMATED', 'the gate reaches go-live; one installation is not repetition', { missing: ['a second installation'] });
      return at('MEASURED', `${d.deployments} installations from the same package`, { have: [`${d.deployments} installations`] });
    },
    nextAction: (f) => {
      const own = (f.deployment?.blockers ?? []).filter((b) => b.kind !== 'EXTERNAL');
      if (!own.length) return 'Perform a second installation from the same package.';
      return `Clear the ${own.length} deployment blocker(s) AWE owns: ${own.map((b) => b.path).join(', ')}. Run: npm run deployment-gate`;
    },
  },

  {
    id: 'path_beyond_wedge',
    claim: 'There is a credible path from the construction wedge to broader autonomous business execution.',
    whyItMatters: 'Decides whether this is a purchasing tool or a company.',
    requiredEvidence: [
      'the proof architecture demonstrated to be capability-neutral rather than asserted',
      'value measured in at least one capability, so the path starts from something real',
    ],
    requires: ['multi_capability'], unlocks: [],
    actionable: false,
    track: 'ENGINEERING', cost: 'MEDIUM',
    assess: (f) => {
      const p = f.proof ?? {};
      if (!p.capabilityNeutral) return at('UNAVAILABLE', 'nothing shows the architecture works beyond one capability', { missing: ['a capability-neutral proof layer'] });
      if (!p.secondCapabilityAdapter) return at('SELF_REPORTED', 'the architecture claims capability-neutrality with one capability through it', { missing: ['a second capability'] });
      if (!p.baselineMeasured) {
        return at('INFERRED',
          'a second capability passes through the same boundary unchanged; no capability has measured value yet, so the path starts from architecture rather than from a result',
          { have: ['proof/adapters/tegg.mjs verified against real run ledgers'],
            missing: ['measured value in at least one capability'] });
      }
      return at('MEASURED', 'the architecture is capability-neutral and at least one capability has measured value', { have: ['measured value', 'second capability'] });
    },
    nextAction: () => 'Nothing to build. This strengthens when the first capability produces measured value, not when more architecture is added.',
  },
]);

export const CLAIM_IDS = Object.freeze(CLAIMS.map((c) => c.id));

/**
 * Every claim, assessed against one set of facts.
 *
 * `blockedBy` is computed rather than declared: a claim is blocked when any of
 * its prerequisites is not yet proven. That is what stops the planner
 * recommending production usage on a day when the software cannot be installed.
 */
export function assessClaims(facts = {}) {
  const byId = new Map();
  const out = CLAIMS.map((c) => {
    const status = c.assess(facts);
    const row = Object.freeze({
      id: c.id, claim: c.claim, whyItMatters: c.whyItMatters,
      requiredEvidence: Object.freeze([...c.requiredEvidence]),
      requires: Object.freeze([...c.requires]),
      unlocks: Object.freeze([...c.unlocks]),
      track: c.track, cost: c.cost,
      actionable: c.actionable,
      grade: status.grade,
      because: status.because,
      have: Object.freeze([...status.have]),
      missing: Object.freeze([...status.missing]),
      provenance: Object.freeze([...status.provenance]),
      proven: isProven(status),
      partial: isPartial(status),
      nextAction: c.nextAction(facts),
    });
    byId.set(c.id, row);
    return row;
  });

  return Object.freeze(out.map((row) => Object.freeze({
    ...row,
    // Blocked by a prerequisite with NO evidence at all. A prerequisite that is
    // merely weak is a reason to be careful, not a reason to refuse.
    blockedBy: Object.freeze(row.requires.filter((r) => (byId.get(r)?.grade ?? 'UNAVAILABLE') === 'UNAVAILABLE')),
  })));
}

/** The weakest grade across a set of claims — the whole is its worst part. */
export function weakestGrade(claims) {
  if (!claims.length) return 'UNAVAILABLE';
  return weakestOf(claims.map((c) => c.grade));
}

export function byId(claims) {
  return new Map(claims.map((c) => [c.id, c]));
}
