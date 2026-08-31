// ---------------------------------------------------------------------------
// gates.mjs — the five stages, in the order a company actually passes them.
//
// WHY GATES AT ALL, given a scorecard already exists. A scorecard says how
// strong each area is; it does not say which area matters NOW. Twelve
// dimensions all improvable at once is how a small company works on the
// interesting thing instead of the necessary one. A gate is a commitment about
// ORDER: nothing in gate 3 is worth an hour while gate 1 is open, because gate
// 1 is what makes gate 3's evidence collectable at all.
//
// EACH GATE IS DEFINED BY CLAIMS, NOT BY TASKS. A task list is done when the
// tasks are done. A gate is passed when the claims are supported, which is a
// different and harder thing, and it is the thing a judge or a customer
// actually checks.
//
// A GATE ALSO CARRIES ITS OWN REPOSITORY REQUIREMENTS — the artifacts that must
// exist for the gate to mean anything, checked against the tree rather than
// remembered. Those are derived from the deployment gate and the proof layer;
// none of them is restated here.
//
// WHAT WAS CONSIDERED AND REJECTED: dated milestones as the ordering mechanism.
// programs/iic-2027/milestones.mjs already has those and they answer a
// different question — "are we on schedule" rather than "what is the next thing
// that can be true". A date slips and tells you nothing about what to do; a
// gate names the missing evidence. Both are kept, and they do not overlap.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

export const GATES = Object.freeze([
  {
    n: 1,
    id: 'production_ready',
    name: 'Production ready',
    question: 'Could this be installed on the real machine, correctly, tomorrow?',
    claims: ['awe_solves', 'repeatable_deployment'],
    // Checked against the tree. Each is something a deployment day needs and
    // that somebody would otherwise discover is missing at 8am on the day.
    requires: [
      {
        id: 'deployment_gate_clears_awe_blockers',
        what: 'every deployment blocker AWE owns is cleared',
        met: (f) => (f.deployment?.aweOwnedBlockers ?? 1) === 0,
        detail: (f) => {
          const own = (f.deployment?.blockers ?? []).filter((b) => b.kind !== 'EXTERNAL');
          return own.length
            ? `${own.length} outstanding: ${own.map((b) => b.path).join(', ')}`
            : 'none outstanding';
        },
      },
      {
        id: 'approved_commit',
        what: 'a specific commit is approved for deployment, signed by a person',
        met: (f) => Boolean(f.deployment?.approvedCommit?.commit && f.deployment?.approvedCommit?.signedBy),
        detail: (f) => {
          const a = f.deployment?.approvedCommit;
          if (!a) return 'no approval record exists';
          if (!a.commit) return `${a.path} exists and names no commit`;
          if (!a.signedBy) return `${a.path} proposes ${a.commit} and nobody has signed it`;
          return `${a.commit}, approved by ${a.signedBy}`;
        },
      },
      {
        id: 'release_package',
        what: 'a command produces the artifact the installation runbook tells the installer to copy',
        met: (f) => Boolean(f.deployment?.packageBuilder),
        detail: (f) => (f.deployment?.packageBuilder
          ? 'scripts/package-release.mjs exists'
          : 'the RDS02 execution package step 1 says "copy PCC-<commit>.zip and verify its .sha256"; nothing produces one'),
      },
      {
        id: 'evidence_identity_enforced',
        what: 'the installation cannot produce records that are refused as evidence later',
        met: (f) => (f.deployment?.blockers ?? []).every((b) => !b.path.startsWith('measurement.')) ||
          Boolean(f.proof?.architectureOperational),
        detail: () => 'PCC_ENVIRONMENT and PCC_ORG_ID are checked at every start and refuse a disagreement',
      },
    ],
  },

  {
    n: 2,
    id: 'first_real_proof',
    name: 'First real proof',
    question: 'Can we state, and defend, one number about what AWE did for a real company?',
    claims: ['problem_economic', 'works_in_production', 'measurable_value'],
    requires: [
      {
        id: 'baseline_measured',
        what: 'the pre-AWE process is measured, from observation or records',
        met: (f) => Boolean(f.proof?.baselineMeasured),
        detail: (f) => (f.proof?.baselineMeasured
          ? 'a measured baseline is in force'
          : 'no baseline is measured — every value figure reads NOT MEASURABLE, correctly'),
      },
      {
        id: 'production_evidence',
        what: 'executions exist in a database that declared itself production at creation',
        met: (f) => (f.usage?.executions ?? 0) > 0,
        detail: (f) => {
          const env = f.proof?.evidenceEnvironment;
          if ((f.usage?.executions ?? 0) > 0) return `${f.usage.executions} production execution(s)`;
          return env && env !== 'production'
            ? `the database offered declares itself "${env}" and is not counted`
            : 'no production database has been read';
        },
      },
      {
        id: 'objectives_observed',
        what: 'objective outcomes are observed, separately from the workflow completing',
        met: (f) => (f.proof?.objectivesTested ?? 0) > 0,
        detail: (f) => `${f.proof?.objectivesTested ?? 0} objective(s) reached a testable state`,
      },
    ],
  },

  {
    n: 3,
    id: 'repeatable',
    name: 'Repeatable solution',
    question: 'Could a second organization get this without us rebuilding it?',
    claims: ['not_hardcoded', 'multi_capability', 'repeatable_deployment'],
    requires: [
      {
        id: 'second_organization',
        what: 'the capability is proven against a second organization\'s data and role names',
        met: (f) => Boolean(f.repeatability?.secondOrganizationProven),
        detail: (f) => `${f.repeatability?.profileHonouredPercent ?? 0}% of the profile is configuration`,
      },
      {
        id: 'capability_neutral_proof',
        what: 'a second capability feeds the proof layer with no change to the arithmetic',
        met: (f) => Boolean(f.proof?.capabilityNeutral && f.proof?.secondCapabilityAdapter),
        detail: (f) => (f.proof?.secondCapabilityAdapter
          ? 'a second capability adapter exists and is tested against real run ledgers'
          : 'only one capability has been through the boundary'),
      },
      {
        id: 'second_installation',
        what: 'somebody who is not us installs it from the same package',
        met: (f) => (f.deployment?.deployments ?? 0) >= 2,
        detail: (f) => `${f.deployment?.deployments ?? 0} installation(s) recorded`,
      },
    ],
  },

  {
    n: 4,
    id: 'commercial',
    name: 'Commercial validation',
    question: 'Do people outside the building want this, and will they pay?',
    claims: ['problem_real', 'external_pain', 'external_want', 'will_pay'],
    requires: [
      {
        id: 'twenty_interviews',
        what: 'at least twenty conversations outside the deploying organization',
        met: (f) => (f.discovery?.externalInterviews ?? 0) >= 20,
        detail: (f) => `${f.discovery?.externalInterviews ?? 0} of 20`,
      },
      {
        id: 'repeated_pain',
        what: 'a pain named independently by more than one outside organization',
        met: (f) => (f.discovery?.repeatedPatterns ?? 0) > 0,
        detail: (f) => `${f.discovery?.repeatedPatterns ?? 0} repeated pattern(s)`,
      },
      {
        id: 'design_partner',
        what: 'an outside organization commits time',
        met: (f) => (f.validation?.designPartners ?? 0) > 0 || (f.discovery?.designPartnerCandidates ?? 0) > 0,
        detail: (f) => `${f.discovery?.designPartnerCandidates ?? 0} candidate(s), ${f.validation?.designPartners ?? 0} committed`,
      },
      {
        id: 'price_tested',
        what: 'a price has been put to a real prospect and the answer recorded',
        met: (f) => Boolean(f.businessModel?.pricingTested),
        detail: (f) => (f.businessModel?.pricingHypothesis ? 'a hypothesis exists, untested' : 'no pricing hypothesis'),
      },
    ],
  },

  {
    n: 5,
    id: 'iic_ready',
    name: 'IIC ready',
    question: 'Is the evidence strong enough that the presentation is the easy part?',
    claims: ['path_beyond_wedge', 'measurable_value', 'will_pay'],
    requires: [
      {
        id: 'verified_case_study',
        what: 'a case study produced by the proof layer from production data, not written by hand',
        met: (f) => Boolean(f.proof?.moneyMeasurable),
        detail: (f) => (f.proof?.moneyMeasurable ? 'a value figure exists' : 'no value figure exists to build a case study on'),
      },
      {
        id: 'demo',
        what: 'a live demonstration with a backup that needs no network',
        met: (f) => Boolean(f.demo?.liveDemoExists && f.demo?.backupExists),
        detail: (f) => (f.demo?.liveDemoExists ? 'a live demo exists' : 'no live demonstration exists'),
      },
      {
        id: 'narrative',
        what: 'a one-minute version, a written summary, and answers to the hardest questions',
        met: (f) => Boolean(f.narrative?.oneMinuteExists && f.narrative?.executiveSummaryExists &&
          (f.narrative?.judgeQuestionsAnswered ?? 0) > 0),
        detail: (f) => (f.narrative?.oneMinuteExists ? 'a one-minute version exists' : 'no one-minute version exists'),
      },
    ],
  },
]);

/**
 * Evaluate every gate against the facts and the assessed claims.
 *
 * A gate is PASSED when every repository requirement is met AND no claim it
 * names is UNAVAILABLE. The claim bar is "has evidence", not "is measured":
 * demanding MEASURED everywhere would leave gate 1 open until the company was
 * finished, which tells nobody anything.
 */
export function assessGates(facts, claims) {
  const byId = new Map(claims.map((c) => [c.id, c]));
  return Object.freeze(GATES.map((g) => {
    const requirements = g.requires.map((r) => Object.freeze({
      id: r.id, what: r.what, met: Boolean(r.met(facts)), detail: r.detail(facts),
    }));
    const gateClaims = g.claims.map((id) => byId.get(id)).filter(Boolean);
    const unsupported = gateClaims.filter((c) => c.grade === 'UNAVAILABLE');
    const unmet = requirements.filter((r) => !r.met);
    return Object.freeze({
      n: g.n, id: g.id, name: g.name, question: g.question,
      claims: Object.freeze(gateClaims.map((c) => c.id)),
      requirements: Object.freeze(requirements),
      unmet: Object.freeze(unmet.map((r) => r.id)),
      unsupportedClaims: Object.freeze(unsupported.map((c) => c.id)),
      passed: unmet.length === 0 && unsupported.length === 0,
    });
  }));
}

/**
 * The gate the company is actually at: the first one not passed.
 *
 * FIRST, not lowest-scoring. Gates later than this one may look further along —
 * gate 3 is nearly satisfied today while gate 1 is open — and working on them
 * is the mistake this whole file exists to prevent. Evidence collected out of
 * order is usually evidence collected twice.
 */
export function currentGate(gates) {
  return gates.find((g) => !g.passed) ?? null;
}

export function nextGate(gates) {
  const current = currentGate(gates);
  if (!current) return null;
  return gates.find((g) => g.n > current.n) ?? null;
}

/** Which gate a claim belongs to. Used to order work; a claim may serve several. */
export function gateOf(claimId) {
  const g = GATES.find((x) => x.claims.includes(claimId));
  return g ? g.n : GATES.length + 1;
}
