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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = (p) => join(ROOT, p);

/** No database given, or one that will not say it is production. */
const NO_USAGE = Object.freeze({ executions: 0, activeDays: 0, organizations: 0 });

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
  };
}

/** How much of the capability is configuration rather than engineering. */
export function deriveRepeatability() {
  try {
    const src = readFileSync(R('capability/purchasing/profile.mjs'), 'utf8');
    const fields = [...src.matchAll(/extractable:\s*'(yes|partial|no)'/g)].map((m) => m[1]);
    if (!fields.length) return {};
    const yes = fields.filter((f) => f === 'yes').length;
    const partial = fields.filter((f) => f === 'partial').length;
    const percent = Math.round(((yes + partial * 0.5) / fields.length) * 100);
    // A second organization is PROVEN only when a profile exists for one whose
    // roles share no name with the first, and the suite that checks it exists.
    const secondProfile = existsSync(R('capability/purchasing/profiles/org-002-trades.mjs'));
    const secondSuite = existsSync(R('scripts/eval-organization-provisioning.mjs'));
    return { repeatability: { profileHonouredPercent: percent, secondOrganizationProven: secondProfile && secondSuite } };
  } catch { return {}; }
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
  const path = 'deployment/APPROVED_RELEASE.md';
  if (!existsSync(R(path))) return null;
  const text = readFileSync(R(path), 'utf8');
  const commit = /^-\s*\*\*Commit\*\*:\s*`([0-9a-f]{7,40})`/m.exec(text)?.[1] ?? null;
  const signed = /^-\s*\*\*Approved by\*\*:\s*(?!_)(\S.*)$/m.exec(text)?.[1]?.trim() ?? null;
  return { path, commit, signedBy: signed && !/^_+$/.test(signed) ? signed : null };
}

/** Customer discovery, counted from the interview records. */
export async function deriveDiscovery() {
  const { summarize } = await import(R('programs/discovery/interview.mjs'));
  const dir = R('programs/discovery/interviews');
  const processExists = existsSync(R('programs/discovery/interview.mjs'));
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.mjs') || f.endsWith('.json')); } catch { /* none yet */ }

  const interviews = [];
  for (const f of files) {
    const full = join(dir, f);
    if (f.endsWith('.json')) {
      const { interview } = await import(R('programs/discovery/interview.mjs'));
      const raw = JSON.parse(readFileSync(full, 'utf8'));
      for (const r of Array.isArray(raw) ? raw : [raw]) interviews.push(interview(r));
    } else {
      const mod = await import(full);
      for (const v of Object.values(mod)) {
        if (v && typeof v === 'object' && v.patternTags) interviews.push(v);
        if (Array.isArray(v)) for (const x of v) if (x?.patternTags) interviews.push(x);
      }
    }
  }
  return { discovery: { ...summarize(interviews), processExists } };
}

/** What can be proven, and how confidently. From a live database where given. */
export async function deriveProof({ db = null, org = null, warn = () => {} } = {}) {
  const PA = await import(R('proof/adapters/purchasing.mjs'));
  const { ACTIVITY_ACTIONS } = await import(R('apps/purchasing/src/purchasing/domain/activity.mjs'));

  const base = {
    architectureOperational: existsSync(R('proof/index.mjs')) && existsSync(R('scripts/eval-proof.mjs')),
    baselineMethodologyExists: existsSync(R('docs/proof/BASELINE_METHODOLOGY.md')),
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

  return {
    proof: {
      ...base,
      evidenceEnvironment: environment,
      objectivesTested: study.objectiveSuccess.testable,
      baselineMeasured: study.baseline.some((b) => b.handlingMinutes.known),
      moneyMeasurable: study.labourValueCents.known,
      confidence: study.confidence.level,
      valuedUnits: study.ledger.valued,
    },
    usage: {
      executions: Number(span.n),
      activeDays: Math.max(1, Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000)),
      organizations: 1,
    },
  };
}
