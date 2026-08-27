// ---------------------------------------------------------------------------
// readiness.mjs — how ready is AWE, and what should we do next?
//
// A scorecard whose scores are DERIVED FROM EVIDENCE, following the same rule
// deployment/evidence.mjs applies to deployments: nothing anywhere sets
// `ready = true`. A dimension with no evidence scores zero and says so, and the
// only way to move a number is to produce the artifact it names.
//
// The score itself is close to worthless. What this exists for is the last
// function in the file:
//
//     highestLeverage(assessment)
//
// which answers "what is the single most valuable thing to do next" by finding
// the weakest dimension that is also cheap to move. That question has an
// answer on any given Tuesday, and it is the same answer whether or not a
// competition exists — which is the test every part of this file had to pass.
//
// WHY THIS IS NOT A DASHBOARD. The competition is a deadline, not a product.
// If the Iona Innovation Challenge were cancelled tomorrow, this file would
// still be the right way to ask whether AWE is a real company yet, and
// `proof/` — which it reads and does not duplicate — would be untouched.
//
// ONE SOURCE OF TRUTH. This module computes nothing about value. It reads a
// case study produced by `proof/case-study.mjs` and counts what is in it. There
// is no competition database and no second set of numbers.
//
// PURE: no clock, no randomness, no I/O. Facts are gathered by the caller.
// ---------------------------------------------------------------------------

/**
 * The dimensions, each with what would have to be TRUE to score at each level.
 *
 * Bands are 0–4 and mean the same thing everywhere:
 *   0  nothing
 *   1  claimed, unevidenced
 *   2  evidenced once
 *   3  evidenced repeatedly, or by somebody outside the company
 *   4  evidenced repeatedly AND externally, and it survived contact with money
 *
 * `cost` is a rough estimate of effort to move up one band, and it is what makes
 * `highestLeverage()` useful rather than merely accusatory: the weakest
 * dimension is not always the one to work on.
 */
export const DIMENSIONS = Object.freeze([
  {
    id: 'problem_evidence',
    label: 'Problem evidence',
    blocks: ['differentiation', 'business_model'],
    question: 'Do we know the problem is real, for more than one organization?',
    cost: 'LOW',
    score: (f) => {
      const n = f.discovery?.interviews ?? 0;
      const orgs = f.discovery?.organizations ?? 0;
      const repeated = f.discovery?.repeatedPatterns ?? 0;
      if (n === 0) return band(0, 'no customer conversations recorded');
      if (orgs === 1) return band(1, `${n} conversation(s), all inside one organization — that is a customer, not a market`);
      if (repeated === 0) return band(2, `${n} conversations across ${orgs} organizations, but no pain named by two of them independently`);
      if (repeated < 3) return band(3, `${repeated} pain pattern(s) named independently by more than one organization`);
      return band(4, `${repeated} repeated pain patterns across ${orgs} organizations`);
    },
  },
  {
    id: 'customer_discovery',
    label: 'Customer discovery',
    blocks: ['problem_evidence', 'external_validation', 'business_model', 'revenue'],
    question: 'Have we talked to enough people outside the building?',
    cost: 'LOW',
    score: (f) => {
      const n = f.discovery?.externalInterviews ?? 0;
      if (n === 0) return band(0, 'no interviews outside the deploying organization');
      if (n < 5) return band(1, `${n} external interview(s) — anecdote`);
      if (n < 20) return band(2, `${n} external interviews — a pattern may be visible but is not yet strong`);
      if (n < 40) return band(3, `${n} external interviews`);
      return band(4, `${n} external interviews`);
    },
  },
  {
    id: 'product_maturity',
    label: 'Product maturity',
    blocks: ['production_usage', 'external_validation', 'demo_quality'],
    question: 'Is it a real system, or a demonstration?',
    cost: 'HIGH',
    score: (f) => {
      const d = f.deployment ?? {};
      if (!d.capabilities) return band(0, 'no capability has a stated contract');
      if (!d.deployable) return band(1, `${d.capabilities} capability contract(s), nothing installable by somebody else`);
      if (!d.readyUnderPolicy) return band(2, 'installable, but the deployment readiness policy is not satisfied');
      if ((d.deployments ?? 0) < 2) return band(3, 'one deployment satisfies the readiness policy end to end');
      return band(4, `${d.deployments} deployments satisfy the readiness policy`);
    },
  },
  {
    id: 'production_usage',
    label: 'Production usage',
    blocks: ['measurable_outcomes'],
    question: 'Is somebody actually using it, for real work?',
    cost: 'MEDIUM',
    score: (f) => {
      const e = f.usage?.executions ?? 0;
      const days = f.usage?.activeDays ?? 0;
      if (e === 0) return band(0, 'no recorded executions in production');
      if (e < 20) return band(1, `${e} execution(s) — a pilot, and possibly a demonstration`);
      if (days < 30) return band(2, `${e} executions over ${days} day(s) — real, but not yet routine`);
      if ((f.usage?.organizations ?? 1) < 2) return band(3, `${e} executions over ${days} days at one organization — routine use`);
      return band(4, `${e} executions across ${f.usage.organizations} organizations`);
    },
  },
  {
    id: 'measurable_outcomes',
    label: 'Measurable outcomes',
    blocks: ['external_validation', 'revenue', 'business_model', 'differentiation', 'narrative'],
    question: 'Can we prove what it accomplished, not just that it ran?',
    cost: 'MEDIUM',
    score: (f) => {
      const p = f.proof ?? {};
      if (!p.objectiveTestable) return band(0, 'no capability tests its own objective — completion is the only signal');
      if (!p.objectivesTested) return band(1, 'an objective test exists but no execution has reached a state where it applies');
      if (!p.baselineMeasured) {
        return band(2, `objective success is measured (${p.objectivesTested} tested) but no baseline exists, so no improvement can be stated`);
      }
      if (p.confidence === 'LOW' || p.confidence === 'NONE') {
        return band(3, `a baseline exists and value is computed, at ${p.confidence} confidence`);
      }
      return band(4, `value computed at ${p.confidence} confidence over ${p.valuedUnits} units of work`);
    },
  },
  {
    id: 'external_validation',
    label: 'External validation',
    blocks: ['revenue'],
    question: 'Has anybody outside the company said this is worth something?',
    cost: 'MEDIUM',
    score: (f) => {
      const v = f.validation ?? {};
      if (!(v.designPartners ?? 0) && !(v.externalDeployments ?? 0)) {
        return band(0, 'no external organization has committed anything, including time');
      }
      if (!(v.externalDeployments ?? 0)) return band(2, `${v.designPartners} design-partner candidate(s), no external deployment`);
      if (!(v.externalTestimony ?? 0)) return band(3, `${v.externalDeployments} external deployment(s), no recorded statement of value`);
      return band(4, `${v.externalDeployments} external deployment(s) with recorded statements of value`);
    },
  },
  {
    id: 'revenue',
    label: 'Revenue',
    blocks: [],
    question: 'Has anybody paid?',
    cost: 'HIGH',
    score: (f) => {
      const r = f.revenue ?? {};
      if (!(r.payingCustomers ?? 0)) {
        return r.pricingHypothesis
          ? band(1, 'a pricing hypothesis exists; nobody has paid')
          : band(0, 'no pricing hypothesis and no revenue');
      }
      if (r.payingCustomers === 1) return band(3, 'one paying customer');
      return band(4, `${r.payingCustomers} paying customers`);
    },
  },
  {
    id: 'differentiation',
    label: 'Differentiation',
    blocks: ['narrative'],
    question: 'Can we say what this does that the alternatives do not?',
    cost: 'LOW',
    score: (f) => {
      const d = f.differentiation ?? {};
      if (!(d.alternativesAnalysed ?? 0)) return band(0, 'no alternative has been analysed');
      if (!d.statedDifference) return band(1, `${d.alternativesAnalysed} alternative(s) analysed, no difference stated in one sentence`);
      if (!d.evidencedDifference) return band(2, 'a difference is stated but not demonstrated');
      return band(4, 'the difference is stated and demonstrable');
    },
  },
  {
    id: 'deployment_repeatability',
    label: 'Deployment repeatability',
    blocks: ['external_validation'],
    question: 'Could a second organization get this without us rebuilding it?',
    cost: 'MEDIUM',
    score: (f) => {
      const pct = f.repeatability?.profileHonouredPercent ?? null;
      const second = f.repeatability?.secondOrganizationProven ?? false;
      if (pct === null) return band(0, 'no measurement of how much is configuration and how much is engineering');
      if (pct < 50) return band(1, `${pct}% of the organization profile is honoured by the code`);
      if (!second) return band(2, `${pct}% honoured, not yet proven against a second organization's data`);
      if (pct < 85) return band(3, `${pct}% honoured and proven against a second organization`);
      return band(4, `${pct}% honoured and proven against a second organization`);
    },
  },
  {
    id: 'business_model',
    label: 'Business model',
    blocks: ['revenue'],
    question: 'Do we know what we sell, to whom, for how much?',
    cost: 'LOW',
    score: (f) => {
      const b = f.businessModel ?? {};
      if (!b.unitDefined) return band(0, 'the thing being sold has not been defined');
      if (!b.pricingHypothesis) return band(1, 'the unit is defined; no price has been proposed');
      if (!b.pricingTested) return band(2, 'a price has been proposed but never put to anybody');
      if (!(b.priceAccepted ?? 0)) return band(3, 'a price has been put to a customer and not accepted');
      return band(4, 'a price has been accepted');
    },
  },
  {
    id: 'demo_quality',
    label: 'Demo quality',
    blocks: [],
    question: 'Can somebody see it work, reliably, in the time available?',
    cost: 'LOW',
    score: (f) => {
      const d = f.demo ?? {};
      if (!d.liveDemoExists) return band(0, 'no live demonstration exists');
      if (!d.backupExists) return band(1, 'a live demo exists with no backup — one bad network is the whole pitch');
      if (!(d.rehearsals ?? 0)) return band(2, 'a live demo and a backup exist, unrehearsed');
      if (d.rehearsals < 5) return band(3, `rehearsed ${d.rehearsals} time(s)`);
      return band(4, `rehearsed ${d.rehearsals} times`);
    },
  },
  {
    id: 'narrative',
    label: 'Narrative readiness',
    blocks: [],
    question: 'Can one person explain it in a minute, and defend it for ten?',
    cost: 'LOW',
    score: (f) => {
      const n = f.narrative ?? {};
      if (!n.oneMinuteExists) return band(0, 'no one-minute version exists');
      if (!n.executiveSummaryExists) return band(1, 'a one-minute version exists; no written summary');
      if (!(n.judgeQuestionsAnswered ?? 0)) return band(2, 'a summary exists; no anticipated question has a written answer');
      if (!(n.mockPitches ?? 0)) return band(3, `${n.judgeQuestionsAnswered} anticipated questions answered, never tested on a person`);
      return band(4, `tested in ${n.mockPitches} mock pitch(es)`);
    },
  },
]);

function band(level, why) {
  return { level, why };
}

export const MAX_BAND = 4;

/**
 * Score every dimension against the facts.
 *
 * A fact that is absent scores at whatever the dimension's own logic says about
 * absence — usually zero — and the `why` names the absence rather than a
 * number. That is the difference between a scorecard and a mood board.
 */
export function assess(facts = {}) {
  const dimensions = DIMENSIONS.map((d) => {
    const { level, why } = d.score(facts);
    return Object.freeze({
      id: d.id, label: d.label, question: d.question,
      level, why, cost: d.cost,
      blocks: Object.freeze([...d.blocks]),
      headroom: MAX_BAND - level,
    });
  });

  const total = dimensions.reduce((t, d) => t + d.level, 0);
  const max = dimensions.length * MAX_BAND;

  return Object.freeze({
    dimensions: Object.freeze(dimensions),
    total,
    max,
    // Reported as a fraction, not a percentage, and deliberately without a
    // grade or a colour. A single number across twelve incommensurable
    // dimensions is a summary, not a measurement, and dressing it up as one
    // invites exactly the kind of reasoning this file is meant to replace.
    fraction: total / max,
    weakest: Object.freeze([...dimensions].sort((a, b) => a.level - b.level || a.label.localeCompare(b.label))),
    highestLeverage: highestLeverage(dimensions),
  });
}

const COST_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 };

/**
 * The single highest-leverage action.
 *
 * Ranked by the value of moving ONE BAND, weighted by what that unblocks,
 * divided by what it costs:
 *
 *     leverage = (1 + dimensions this one unblocks) / cost
 *
 * ONE band, not the whole headroom, and that is the correction that makes this
 * function useful. Ranking by total headroom always recommends whatever is at
 * zero, because four bands of theoretical distance beats two bands of real
 * one — and nobody moves four bands from one action. A dimension is worth
 * working on for what the NEXT step opens up, not for how far away its ceiling
 * is.
 *
 * TIES BREAK ON WHAT A DIMENSION UNBLOCKS, and that tie-break does most of the
 * real work early on. At the start everything is zero and everything is cheap,
 * so a pure headroom-over-cost ranking degenerates into alphabetical order —
 * which is how a scorecard ends up recommending "write a pricing hypothesis"
 * to a company that has not yet spoken to a customer. `blocks` names the
 * dimensions each one gates, and a dimension that unblocks four others is
 * worth more than one that unblocks none, at identical cost.
 *
 * A dimension is only counted as unblocking another if that other is itself
 * still below its maximum band: unblocking something already finished is not
 * leverage.
 *
 * The returned `action` is the thing to DO, phrased as a task, because a
 * scorecard that says "improve differentiation" has told nobody anything.
 */
export function highestLeverage(dimensions) {
  const byId = new Map(dimensions.map((d) => [d.id, d]));
  const ranked = [...dimensions]
    .filter((d) => d.headroom > 0)
    .map((d) => {
      const unblocks = d.blocks.filter((b) => (byId.get(b)?.headroom ?? 0) > 0).length;
      return { ...d, unblocks, leverage: (1 + unblocks) / COST_RANK[d.cost] };
    })
    .sort((a, b) =>
      b.leverage - a.leverage ||
      b.unblocks - a.unblocks ||
      a.level - b.level ||
      a.label.localeCompare(b.label));

  const top = ranked[0];
  if (!top) return null;
  return Object.freeze({
    dimension: top.id,
    label: top.label,
    currentBand: top.level,
    why: top.why,
    cost: top.cost,
    unblocks: top.unblocks,
    action: ACTIONS[top.id]?.[top.level] ?? `Move ${top.label} up one band. Currently: ${top.why}`,
    runnersUp: Object.freeze(ranked.slice(1, 3).map((d) => ({ dimension: d.id, action: ACTIONS[d.id]?.[d.level] ?? d.label }))),
  });
}

/**
 * What to actually do, per dimension, per band.
 *
 * Concrete enough to start this afternoon. A generic instruction ("strengthen
 * the evidence") is how a scorecard becomes decoration.
 */
export const ACTIONS = Object.freeze({
  problem_evidence: {
    0: 'Interview one person outside the deploying organization about the same workflow. One conversation moves this from nothing to something.',
    1: 'Interview somebody at a second organization. One customer\'s pain is a custom request until a stranger names it too.',
    2: 'Look for a pain named independently by two organizations, and record it as a repeated pattern in programs/discovery/.',
    3: 'Find a third independent organization naming the same pattern.',
  },
  customer_discovery: {
    0: 'Book five conversations with trades businesses of a similar size. Ask about the workflow, not about AWE.',
    1: 'Get to twenty. Below that, every pattern is noise.',
    2: 'Keep going to forty, and start tagging repeated patterns rather than accumulating transcripts.',
    3: 'Convert the strongest three into design-partner conversations.',
  },
  product_maturity: {
    0: 'Write the capability contract for the workflow that is furthest along.',
    1: 'Make it installable by somebody who is not you. deployment/ already states the bar.',
    2: 'Satisfy the PILOT readiness policy end to end and record the evidence.',
    3: 'Install it somewhere that is not the first customer.',
  },
  production_usage: {
    0: 'Get the deployed capability in front of the people who do the work, and let them use it for real.',
    1: 'Keep it running for thirty days. Twenty executions in a week is a demonstration; twenty a week for a month is a system.',
    2: 'Keep it running until use is routine rather than supervised.',
    3: 'Deploy to a second organization.',
  },
  measurable_outcomes: {
    0: 'Define the objective test for the deployed capability: what the organization actually wanted, not what the workflow did.',
    1: 'Let executions run until some reach a state where the objective can be tested.',
    2: 'MEASURE THE BASELINE. docs/proof/BASELINE_METHODOLOGY.md §8 lists three items that need nobody\'s morning: sample the paper POs, ask payroll for the loaded rate, and date the paper POs against the packing slips.',
    3: 'Raise confidence: more valued units of work, or a measured rather than self-reported touch standard.',
  },
  external_validation: {
    0: 'Ask one organization from the discovery conversations to be a design partner. Time, not money.',
    1: 'Convert a design-partner conversation into an installation.',
    2: 'Deploy to one external organization.',
    3: 'Ask the external deployment to state, in their words and on the record, what it was worth.',
  },
  revenue: {
    0: 'Write down what is being sold and what it should cost. A hypothesis, not a price list.',
    1: 'Put the price to somebody and record what they said.',
    2: 'Close one.',
    3: 'Close a second, at a price you did not discount to zero.',
  },
  differentiation: {
    0: 'Name the three things a trades business would buy instead, and what each one does not do.',
    1: 'Write the difference in one sentence that does not contain the word "platform".',
    2: 'Demonstrate the difference — the objective-versus-completion distinction is demonstrable today and almost nothing else in the category does it.',
    3: 'Keep it current as the alternatives change.',
  },
  deployment_repeatability: {
    0: 'Run scripts/eval-purchasing-redeployability.mjs and record the number.',
    1: 'Extract the profile fields that are hard-coded, highest-value first.',
    2: 'Prove the capability against a second organization\'s data and role vocabulary.',
    3: 'Close the remaining extraction debt.',
  },
  business_model: {
    0: 'Define the unit: per capability, per organization, per execution, per seat. Pick one and write down why.',
    1: 'Propose a price against the measured value, once there is one.',
    2: 'Put it to a real prospect.',
    3: 'Find out why the price was refused, and change one of the two things.',
  },
  demo_quality: {
    0: 'Build the five-minute live demonstration against real data.',
    1: 'Record a backup that needs no network and no server.',
    2: 'Rehearse it once, timed, in front of somebody.',
    3: 'Rehearse until the timing is boring.',
  },
  narrative: {
    0: 'Write the one-minute version. Out loud, timed.',
    1: 'Write the one-page executive summary.',
    2: 'Write answers to the ten hardest questions a judge or a finance director would ask.',
    3: 'Run a mock pitch with somebody willing to be unkind.',
  },
});

/**
 * The scorecard as text.
 *
 * Leads with the weakest dimensions and the next action, because that is what
 * the document is for. The total is printed last, small, and without ceremony.
 */
export function render(assessment, { title = 'AWE readiness' } = {}) {
  const L = [];
  const bar = (n) => '█'.repeat(n) + '·'.repeat(MAX_BAND - n);
  L.push(title);
  L.push('='.repeat(title.length));
  L.push('');
  for (const d of assessment.dimensions) {
    L.push(`${bar(d.level)} ${d.level}/${MAX_BAND}  ${d.label}`);
    L.push(`          ${d.why}`);
  }
  L.push('');
  L.push(`Total: ${assessment.total} / ${assessment.max}`);
  L.push('');
  const hl = assessment.highestLeverage;
  if (hl) {
    L.push('HIGHEST-LEVERAGE NEXT ACTION');
    L.push(`  ${hl.label} — band ${hl.currentBand}/${MAX_BAND}, ${hl.cost.toLowerCase()} cost to move` +
      (hl.unblocks ? `, unblocks ${hl.unblocks} other dimension(s)` : ''));
    L.push(`  because: ${hl.why}`);
    L.push('');
    L.push(`  ${hl.action}`);
    if (hl.runnersUp.length) {
      L.push('');
      L.push('  then:');
      for (const r of hl.runnersUp) L.push(`    · ${r.action}`);
    }
  } else {
    L.push('Every dimension is at its maximum band. Check the facts before believing that.');
  }
  return L.join('\n');
}
