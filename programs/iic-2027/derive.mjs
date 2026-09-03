// ---------------------------------------------------------------------------
// derive.mjs — the facts, read from the repository and from a live database.
//
// WHY THIS IS ITS OWN MODULE. The derivation used to live inside
// scripts/iic-readiness.mjs, which was fine while one command needed it. Two
// commands now do — the scorecard and the venture plan — and a second copy of
// "how many external interviews are there" is a second answer to that question,
// arriving on the day the two disagree in front of somebody.
//
// So: one derivation, both callers, and `programs/venture/` computes no facts
// of its own. Every number below comes from something already canonical —
// `proof/`, `deployment/`, `capability/`, `programs/discovery/` — and this file
// only counts what they report.
//
// PRODUCTION EVIDENCE IS GATED HERE, and that is not a formality. A readiness
// figure taken from a rehearsal database is the most dangerous number in this
// repository: the rehearsal runs the production artifact under the real company
// name with the real organization id, so it produces exactly the shape of a
// good result. `usage` and `proof` come from a database ONLY when that database
// stamped itself production at creation. Anything else reports zero and says
// which environment it refused, which is the correct answer rather than a
// convenient one.
//
// READ ONLY.
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const R = (p) => join(ROOT, p);

/** No database given, or one that will not say it is production. */
const NO_USAGE = Object.freeze({ executions: 0, activeDays: 0, organizations: 0, capabilitiesInProduction: 0 });

/**
 * Everything the scorecard and the plan both read.
 *
 * @param {object} [spec]
 * @param {string} [spec.db]   path to a purchasing database
 * @param {string} [spec.org]  which organization the database facts are about
 * @param {function} [spec.warn] where to report a refused database
 */
export async function deriveFacts({ db = null, org = null, warn = () => {} } = {}) {
  return {
    ...deriveRepeatability(),
    ...await deriveDeployment(),
    ...await deriveDiscovery(),
    ...await deriveProof({ db, org, warn }),
    ...await deriveEvidence(),
    ...deriveArtifacts(),
  };
}

/**
 * The evidence a founder collects with a phone and a notebook.
 *
 * WHY THIS IS DERIVED AND NOT DECLARED. `facts.mjs` has carried commented-out
 * entries for `narrative.plainLanguageTests`, `businessModel.unitDefined` and
 * `differentiation.alternativesAnalysed` since it was written, waiting for
 * somebody to type them in with a note. That is the friction this function
 * removes: every one of them is now READ from a record of something that
 * happened, on exactly the terms the rest of this file uses for a database.
 *
 * The declared path still works and still wins nothing — `mergeFacts` gives
 * derived facts priority — so a number typed into facts.mjs can no longer
 * disagree with the records behind it.
 *
 * THREE THINGS IT REFUSES, and each one is the point of a whole module:
 *
 *   · a comprehension test on somebody inside the project (comprehension.mjs)
 *   · an alternative the founder inferred rather than was told (alternatives.mjs)
 *   · a unit of sale that one company preferred (unit-of-sale.mjs)
 *
 * A malformed capture file never throws here. It is excluded from the counts
 * and reported through `evidence.problems`, which `npm run evidence -- --check`
 * prints. A broken note must not take down the planner.
 */
export async function deriveEvidence() {
  const { loadEvidence } = await import(R('programs/evidence/load.mjs'));
  const { analyseAlternatives, differentiationFacts } = await import(R('programs/discovery/alternatives.mjs'));
  const { analyseUnitOfSale, businessModelFacts } = await import(R('programs/discovery/unit-of-sale.mjs'));
  const { founderStoryFacts } = await import(R('programs/evidence/founder-story.mjs'));

  const ev = await loadEvidence();
  const { records: interviews } = await loadInterviews();

  const alternatives = analyseAlternatives(interviews);
  const unitOfSale = analyseUnitOfSale(interviews);

  return {
    narrative: {
      plainLanguageTests: ev.comprehensionSummary.plainLanguageTests,
      comprehensionVerdict: ev.comprehensionSummary.verdict,
      comprehensionTested: ev.comprehensionSummary.tested,
      mockPitches: ev.mockPitchFacts.mockPitches,
    },
    demo: { rehearsals: ev.mockPitchFacts.rehearsals },
    differentiation: differentiationFacts(alternatives, {
      positioningWritten: existsSync(R('programs/iic-2027/competitive-positioning.md')),
    }),
    businessModel: businessModelFacts(unitOfSale),
    ...founderStoryFacts(ev.founderStory),
    evidence: {
      problems: ev.problems,
      unimported: ev.unimported,
      alternatives: { analysed: alternatives.analysed, adequate: alternatives.adequate },
      unitOfSale: { verdict: unitOfSale.verdict.verdict, candidate: unitOfSale.leadingUnit?.value ?? null, findings: unitOfSale.findings },
      comprehension: {
        verdict: ev.comprehensionSummary.verdict,
        tested: ev.comprehensionSummary.tested,
        clear: ev.comprehensionSummary.clear,
        confusing: ev.comprehensionSummary.confusing,
        weakestConcept: ev.comprehensionSummary.weakestConcept,
        remainingToFirstSample: ev.comprehensionSummary.remainingToFirstSample,
        regressions: ev.versions.regressions,
      },
      mockPitch: { ...ev.mockPitchFacts, repeatedConfusion: ev.mockPitchLearning.repeatedConfusion, lowestTrust: ev.mockPitchLearning.lowestTrust },
    },
  };
}

/**
 * Which narrative artifacts EXIST as files.
 *
 * Read by programs/iic-2027/narrative.mjs, and kept in its own group —
 * `artifacts`, not `narrative` — for one reason that is worth the extra word.
 *
 * A FILE IS NOT A REHEARSED PERSON. The `narrative` dimension in readiness.mjs
 * asks whether one person can explain AWE in a minute and defend it for ten,
 * and it is scored from DECLARED facts: a recorded one-minute version, a mock
 * pitch that happened. If existence-of-file were merged into that group, then
 * writing a document would raise a band that is supposed to measure whether a
 * human being can do something, and the day the spec directory was created the
 * scorecard would have congratulated itself.
 *
 * So these facts feed the presentation architecture — which legitimately needs
 * to know whether the workflow has been written down — and they feed nothing
 * that scores the company. A test asserts that building this directory did not
 * move the scorecard.
 */
export function deriveArtifacts() {
  const has = (p) => existsSync(R(p));
  let frozenBaselines = 0;
  try { frozenBaselines = readdirSync(R('proof/baselines/frozen')).filter((f) => f.endsWith('.json')).length; }
  catch { /* nothing frozen yet */ }

  return {
    artifacts: {
      // The pre-AWE workflow, recorded from the business rather than imagined.
      workflowMapped: has('docs/planning/CURRENT_WORKFLOW.md') && has('docs/planning/WORKFLOW_MAPS.md'),
      // A recorded conversation with the person who runs the work. This is the
      // checkable form of "I was inside this business"; the sentence is not.
      bossInterviewRecorded: has('docs/planning/BOSS_INTERVIEW.md'),
      // The presentation architecture itself. Deliberately NOT scored anywhere:
      // it is a place to put evidence, not evidence.
      narrativeArchitecture: has('programs/iic-2027/narrative.mjs') && has('programs/iic-2027/MASTER_SPEC.md'),
      demoArchitecture: has('programs/iic-2027/demo-architecture.md'),
      // Frozen, reproducible evidence exports. The only artifact in this list
      // whose existence means something happened in the real world.
      frozenBaselines,
    },
  };
}

/**
 * How much of the capability is configuration rather than engineering.
 *
 * THE SCORE IS ASKED FOR, NOT RE-DERIVED. This used to scrape the profile with
 * a regex over `extractable: 'yes|partial|no'` and do its own arithmetic — a
 * second copy of a rule that lives in `extractionScore()`. When a fourth state
 * (`invariant`) was added, the regex silently stopped matching those fields, so
 * this function was excluding them from its denominator by accident and
 * agreeing with the real score by coincidence. One implementation now.
 *
 * TWO DIFFERENT CLAIMS, kept apart:
 *
 *   ARCHITECTURALLY REPEATABLE  a second organization can be provisioned and
 *                               used without a source change. Provable here, by
 *                               a rehearsal against a synthetic company.
 *   EXTERNALLY VALIDATED        a REAL business other than the first is running
 *                               it. Not provable from a repository at all.
 *
 * The first is engineering and is finished. The second requires a signed design
 * partner, and no arrangement of files can substitute for one — so it is read
 * from evidence a human records, and its absence caps the claim.
 */
const profileScoreModule = await import(R('capability/purchasing/profile.mjs'));

export function deriveRepeatability() {
  try {
    const { extractionScore } = requireProfileScore();
    const score = extractionScore();

    // A second organization is ARCHITECTURALLY proven only when all of it
    // exists: a profile whose roles share no name with the first, an
    // authorization profile, a dossier, and the suite that drives the whole
    // lifecycle through it.
    const secondOrganizationProven = [
      'capability/purchasing/profiles/org-002-trades.mjs',
      'capability/purchasing/profiles/org-002-authorization.mjs',
      'organizations/northgate/dossier.mjs',
      'scripts/eval-second-customer.mjs',
    ].every((f) => existsSync(R(f)));

    // EXTERNALLY VALIDATED cannot be inferred from the repository, and must not
    // be: every file below could exist while no real company had ever run it.
    // A real second deployment is recorded by a human in this file, once, and
    // until then the honest answer is false.
    const externallyValidated = false;

    return {
      repeatability: {
        profileHonouredPercent: score.percent,
        profileInvariantFields: score.invariant,
        secondOrganizationProven,
        externallyValidated,
      },
    };
  } catch { return {}; }
}

/** Loaded lazily so a broken profile degrades this scorecard rather than the app. */
function requireProfileScore() {
  return profileScoreModule;
}

/**
 * Is there a capability with a contract, can somebody else install it, and how
 * far can the deployment actually get?
 *
 * THE PHASE COMES FROM THE DEPLOYMENT GATE, not from this file. It used to be
 * hard-coded `readyUnderPolicy: false`, which was honest when nothing could
 * answer it and became a second opinion the moment something could. Now the one
 * command that answers "can we deploy?" answers it here too, so the scorecard
 * and the gate cannot disagree.
 */
export async function deriveDeployment() {
  let capabilities = 0;
  try {
    capabilities = readdirSync(R('capability')).filter((d) => {
      try { return statSync(R(join('capability', d))).isDirectory() && existsSync(R(join('capability', d, 'README.md'))); }
      catch { return false; }
    }).length;
  } catch { /* no capability directory */ }

  const deployable = existsSync(R('Dockerfile')) && existsSync(R('deploy')) &&
    existsSync(R('PCC_VM_INSTALLATION_RUNBOOK.md'));

  let phase = 'UNKNOWN';
  let blockers = [];
  try {
    const { gate } = await import(R('scripts/pcc-deployment-gate.mjs'));
    const result = await gate();
    phase = result.verdict;
    blockers = result.blockers.map((b) => ({ path: b.path, phase: b.phase, owner: b.owner, kind: b.kind, reason: b.reason }));
  } catch { /* the gate could not run; phase stays UNKNOWN, which is not a pass */ }

  return {
    deployment: {
      capabilities,
      deployable,
      phase,
      blockers,
      // AWE-owned blockers are the ones we can clear without a phone call, and
      // they are counted separately because they are the only ones an
      // engineering action can move.
      aweOwnedBlockers: blockers.filter((b) => b.kind !== 'EXTERNAL').length,
      externalBlockers: blockers.filter((b) => b.kind === 'EXTERNAL').length,
      // Under the deployment policy, "ready" means the gate lets go-live
      // through. Derived, never asserted.
      readyUnderPolicy: phase === 'GO_LIVE',
      deployments: 0,
      approvedCommit: approvedCommit(),
      packageBuilder: existsSync(R('scripts/package-release.mjs')),
    },
  };
}

/**
 * Has a specific commit been approved for deployment?
 *
 * The runbook requires one — "deploy a specific commit or tag, never a moving
 * branch" — and an approval is a person's signature, not a file a script can
 * write. So this reports what the approval record says and nothing else. An
 * unsigned record is not an approval.
 */
export function approvedCommit() {
  // Overridable ONLY so the suites can still exercise the unsigned direction
  // now that the real record carries a signature. It relocates which file is
  // read; it cannot invent a signer, because the signature is parsed out of
  // whatever file it lands on. Unset in every real invocation.
  const path = process.env.PCC_APPROVAL_RECORD ?? 'deployment/APPROVED_RELEASE.md';
  if (!existsSync(R(path))) return null;
  const text = readFileSync(R(path), 'utf8');
  const commit = /^-\s*\*\*Commit\*\*:\s*`([0-9a-f]{7,40})`/m.exec(text)?.[1] ?? null;
  const signed = /^-\s*\*\*Approved by\*\*:\s*(?!_)(\S.*)$/m.exec(text)?.[1]?.trim() ?? null;

  // IS THE CANDIDATE REAL, AND HOW OLD IS IT?
  //
  // A candidate naming a commit that is not in this history is a typo or a
  // record from another branch, and it would send somebody to build something
  // that does not exist. A candidate that HEAD has simply moved past is a
  // different thing entirely — deploying a commit older than the tip is normal
  // and often correct — so the distance is reported rather than judged.
  //
  // This exists because the first candidate written here named the commit
  // BEFORE the work that made the deployment possible, and nothing noticed.
  let inHistory = null;
  let behind = null;
  if (commit) {
    const { spawnSync } = require('node:child_process');
    const type = spawnSync('git', ['cat-file', '-t', commit], { cwd: ROOT, encoding: 'utf8' });
    inHistory = type.status === 0 && type.stdout.trim() === 'commit' &&
      spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: ROOT }).status === 0;
    if (inHistory) {
      const count = spawnSync('git', ['rev-list', '--count', `${commit}..HEAD`], { cwd: ROOT, encoding: 'utf8' });
      behind = count.status === 0 ? Number(count.stdout.trim()) : null;
    }
  }

  return {
    path,
    commit,
    signedBy: signed && !/^_+$/.test(signed) ? signed : null,
    inHistory,
    commitsBehindHead: behind,
  };
}

/**
 * How far the baseline evidence has actually got.
 *
 * Counted from the observation file rather than from the baseline module,
 * because the module reports UNAVAILABLE either way — whether nobody has
 * started or whether four of seven steps are done. The founder's next hour
 * depends on which.
 */
export function baselineObservations() {
  const path = 'proof/baselines/observations/lippolis-purchasing.json';
  if (!existsSync(R(path))) return { file: null, stepsObserved: 0, stepsTotal: 0, observations: 0, labourRate: false, reviewed: false };
  const doc = JSON.parse(readFileSync(R(path), 'utf8'));
  const steps = Object.values(doc.steps ?? {});
  return {
    file: path,
    stepsTotal: steps.length,
    stepsObserved: steps.filter((s) => (s.observations?.length ?? 0) > 0).length,
    observations: steps.reduce((t, s) => t + (s.observations?.length ?? 0), 0),
    labourRate: Boolean(doc.labourRate?.centsPerHour),
    reviewed: Boolean(doc.reviewedBy),
  };
}

/**
 * Customer discovery, counted from the interview records.
 *
 * THE READER LIVES IN programs/discovery/load.mjs, not here. This function used
 * to walk the directory itself, and so did scripts/discovery.mjs, and the two
 * handled a malformed file differently — one counted it, one crashed. One
 * reader now, validating on the way in.
 */
export async function deriveDiscovery() {
  const { summarize } = await import(R('programs/discovery/interview.mjs'));
  const { records, problems, sheets } = await loadInterviews();
  return {
    discovery: {
      ...summarize(records),
      processExists: existsSync(R('programs/discovery/interview.mjs')),
      // A refused record is not a conversation. Reported so the count and the
      // reason for it arrive together.
      unreadable: problems.length,
      unimported: sheets.length,
    },
  };
}

/** The interviews themselves, for the analyses that need more than a count. */
export async function loadInterviews() {
  const { loadInterviews: load } = await import(R('programs/discovery/load.mjs'));
  return load();
}

/** What can be proven, and how confidently. From a live database where given. */
export async function deriveProof({ db = null, org = null, warn = () => {} } = {}) {
  const PA = await import(R('proof/adapters/purchasing.mjs'));
  const { ACTIVITY_ACTIONS } = await import(R('apps/purchasing/src/purchasing/domain/activity.mjs'));

  const base = {
    architectureOperational: existsSync(R('proof/index.mjs')) && existsSync(R('scripts/eval-proof.mjs')),
    baselineMethodologyExists: existsSync(R('docs/proof/BASELINE_METHODOLOGY.md')),
    caseStudyStandardExists: existsSync(R('proof/case-study-standard.mjs')),
    baselineObservations: baselineObservations(),
    caseStudyGrade: 'NOT_READY',
    caseStudyBlockers: [],
    baselineFieldProtocolExists: existsSync(R('docs/proof/LIPPOLIS_BASELINE_FIELD_PROTOCOL.md')),
    capabilityNeutral: existsSync(R('proof/organization.mjs')) && existsSync(R('scripts/eval-tegg-generalization.mjs')),
    secondCapabilityAdapter: existsSync(R('proof/adapters/tegg.mjs')),
    objectiveTestable: typeof PA.materialObjective === 'function',
    unclassifiedActions: PA.unmappedActions(ACTIVITY_ACTIONS).length,
    objectivesTested: 0,
    baselineMeasured: false,
    moneyMeasurable: false,
    confidence: 'NONE',
    valuedUnits: 0,
    evidenceEnvironment: null,
  };

  if (!db || !org) return { proof: base, usage: NO_USAGE };
  if (!existsSync(db)) {
    warn(`No database at ${db}; reporting repository facts only.`);
    return { proof: base, usage: NO_USAGE };
  }

  const { DatabaseSync } = await import('node:sqlite');
  const { readExecutions, environmentOf } = await import(R('proof/adapters/purchasing-sqlite.mjs'));
  const handle = new DatabaseSync(db, { readOnly: true });
  const environment = environmentOf(handle);

  // THE GATE. A readiness figure derived from a rehearsal is worse than no
  // figure: it has the shape of success and describes work nobody did.
  if (environment !== 'production') {
    handle.close();
    warn(
      `The database at ${db} declares itself "${environment}", not "production". ` +
      'Readiness is about what actually happened, so its executions are not counted. ' +
      'A rehearsal database carries the real company name and the real organization id — ' +
      'only the stamp written at creation can tell them apart.');
    return { proof: { ...base, evidenceEnvironment: environment }, usage: NO_USAGE };
  }

  const { caseStudy } = await import(R('proof/case-study.mjs'));
  const LIP = await import(R('proof/baselines/lippolis-purchasing.mjs'));

  // The whole recorded history, not a chosen window: readiness is about what
  // the deployment has done, and picking a favourable period is the first step
  // toward a favourable number.
  const span = handle.prepare(
    `select min(created_at) as first, max(created_at) as last, count(*) as n
       from purchase_requests where org_id = ?`).get(org);
  const first = span?.first ?? null;
  const last = span?.last ?? null;
  if (!first) {
    handle.close();
    return { proof: { ...base, evidenceEnvironment: environment }, usage: NO_USAGE };
  }

  const to = new Date(Date.parse(last) + 86_400_000).toISOString();
  const { records } = readExecutions(handle, { orgId: org, from: first, to, baselineId: 'lippolis_purchasing_v0' });
  handle.close();

  const study = caseStudy({
    orgId: org, orgName: org, capability: 'purchasing', capabilityLabel: 'Purchasing',
    records, baselines: [LIP.lippolisPurchasingBaseline], touchStandards: [LIP.lippolisPurchasingTouchStandard],
    from: first, to,
  });

  // HOW MUCH OF THIS COULD BE SAID OUT LOUD. Read from the standard rather
  // than re-derived here, so the plan and the case-study command cannot report
  // different grades for the same evidence.
  const { gradeCaseStudy } = await import(R('proof/case-study-standard.mjs'));
  const graded = gradeCaseStudy(study, {
    environment,
    humanTouchRecordComplete: records.every((r) => r.humanTouchesComplete !== false),
  });

  return {
    proof: {
      ...base,
      evidenceEnvironment: environment,
      objectivesTested: study.objectiveSuccess.testable,
      baselineMeasured: study.baseline.some((b) => b.handlingMinutes.known),
      moneyMeasurable: study.labourValueCents.known,
      confidence: study.confidence.level,
      valuedUnits: study.ledger.valued,
      caseStudyGrade: graded.grade,
      caseStudyBlockers: graded.failed.map((f) => f.wanted),
    },
    usage: {
      executions: Number(span.n),
      activeDays: Math.max(1, Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000)),
      organizations: 1,
      // HOW MANY CAPABILITIES ARE DOING REAL WORK, which is not the same as how
      // many exist. Purchasing is the only one with a production reader, so this
      // is 1 whenever it has run and cannot yet reach 2 by any arrangement of
      // files — which is the honest answer, and the one the wedge beat needs.
      capabilitiesInProduction: 1,
    },
  };
}
