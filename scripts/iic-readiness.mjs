// ---------------------------------------------------------------------------
// iic-readiness.mjs — where does AWE actually stand, and what is next?
//
// Assembles the facts the readiness scorecard scores. Everything it can derive
// from the repository or a live database, it derives; the short remainder comes
// from programs/iic-2027/facts.mjs, where each entry must name a witness.
//
//   node scripts/iic-readiness.mjs
//   node scripts/iic-readiness.mjs --db /data/pcc.sqlite --org lippolis
//   node scripts/iic-readiness.mjs --json
//
//   --db          a purchasing database, to derive production-usage and proof
//                 facts from real executions rather than from nothing.
//   --org         which organization the database facts are about.
//   --milestones  also print the dated targets and which are met.
//   --json        machine-readable.
//
// NOTHING HERE ASSERTS A SCORE. Every band comes from a fact, and a fact that
// does not exist scores zero with the absence named. Running this against an
// empty repository prints twelve zeros, which is correct.
//
// READ ONLY.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { assess, render } = await import(join(ROOT, 'programs/iic-2027/readiness.mjs'));
const { DECLARED, mergeFacts } = await import(join(ROOT, 'programs/iic-2027/facts.mjs'));
const { status: milestoneStatus } = await import(join(ROOT, 'programs/iic-2027/milestones.mjs'));
const { summarize } = await import(join(ROOT, 'programs/discovery/interview.mjs'));

const args = parseArgs(process.argv.slice(2));

const derived = {
  ...deriveRepeatability(),
  ...deriveDeployment(),
  ...await deriveDiscovery(),
  ...await deriveProof(),
};

const facts = mergeFacts(derived, DECLARED);
const assessment = assess(facts);

if (args.json) {
  console.log(JSON.stringify({
    facts,
    assessment,
    milestones: milestoneStatus(facts),
  }, null, 2));
} else {
  console.log(render(assessment, { title: 'AWE readiness — derived from the repository' }));
  console.log('');
  console.log('--- where the facts came from --------------------------------------');
  for (const [group, values] of Object.entries(derived)) {
    console.log(`  ${group}: ${JSON.stringify(values)}`);
  }
  if (Object.keys(DECLARED).length === 0) {
    console.log('  declared: nothing. Every band above rests on something the code could check.');
  }
  if (args.milestones) {
    const st = milestoneStatus(facts);
    console.log('');
    console.log('--- dated targets (computed, not ticked) ---------------------------');
    for (const m of st.months) {
      console.log(`  ${m.at}: ${m.met}/${m.total} met`);
      for (const id of m.outstanding) {
        const row = st.rows.find((r) => r.id === id);
        console.log(`      ☐ ${row.target}`);
        console.log(`        evidence: ${row.evidence}`);
      }
    }
  }
}

process.exit(0);

// ---------------------------------------------------------------------------
// Derivation. Each function reads the repository and states what it found.
// ---------------------------------------------------------------------------

/** How much of the capability is configuration rather than engineering. */
function deriveRepeatability() {
  try {
    const src = readFileSync(join(ROOT, 'capability/purchasing/profile.mjs'), 'utf8');
    const fields = [...src.matchAll(/extractable:\s*'(yes|partial|no)'/g)].map((m) => m[1]);
    if (!fields.length) return {};
    const yes = fields.filter((f) => f === 'yes').length;
    const partial = fields.filter((f) => f === 'partial').length;
    const percent = Math.round(((yes + partial * 0.5) / fields.length) * 100);
    // A second organization is PROVEN only when a profile exists for one whose
    // roles share no name with the first, and the suite that checks it exists.
    const secondProfile = existsSync(join(ROOT, 'capability/purchasing/profiles/org-002-trades.mjs'));
    const secondSuite = existsSync(join(ROOT, 'scripts/eval-organization-provisioning.mjs'));
    return { repeatability: { profileHonouredPercent: percent, secondOrganizationProven: secondProfile && secondSuite } };
  } catch { return {}; }
}

/** Is there a capability with a contract, and can somebody else install it? */
function deriveDeployment() {
  const capDir = join(ROOT, 'capability');
  let capabilities = 0;
  try {
    capabilities = readdirSync(capDir).filter((d) => {
      try { return statSync(join(capDir, d)).isDirectory() && existsSync(join(capDir, d, 'README.md')); }
      catch { return false; }
    }).length;
  } catch { /* no capability directory */ }

  const deployable = existsSync(join(ROOT, 'Dockerfile')) &&
    existsSync(join(ROOT, 'deploy')) &&
    existsSync(join(ROOT, 'PCC_VM_INSTALLATION_RUNBOOK.md'));

  // Readiness under the deployment policy is NOT derived from the presence of
  // documents. deployment/evidence.mjs derives it from an evidence log, and no
  // such log is committed — so this stays false until one is, which is the
  // correct answer rather than a convenient one.
  return { deployment: { capabilities, deployable, readyUnderPolicy: false, deployments: 0 } };
}

/** Customer discovery, counted from the interview records. */
async function deriveDiscovery() {
  const dir = join(ROOT, 'programs/discovery/interviews');
  const processExists = existsSync(join(ROOT, 'programs/discovery/interview.mjs'));
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.mjs') || f.endsWith('.json')); } catch { /* none yet */ }

  const interviews = [];
  for (const f of files) {
    const full = join(dir, f);
    if (f.endsWith('.json')) {
      const { interview } = await import(join(ROOT, 'programs/discovery/interview.mjs'));
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
async function deriveProof() {
  const PA = await import(join(ROOT, 'proof/adapters/purchasing.mjs'));
  const { ACTIVITY_ACTIONS } = await import(join(ROOT, 'apps/purchasing/src/purchasing/domain/activity.mjs'));

  const base = {
    architectureOperational: existsSync(join(ROOT, 'proof/index.mjs')) && existsSync(join(ROOT, 'scripts/eval-proof.mjs')),
    baselineMethodologyExists: existsSync(join(ROOT, 'docs/proof/BASELINE_METHODOLOGY.md')),
    objectiveTestable: typeof PA.materialObjective === 'function',
    unclassifiedActions: PA.unmappedActions(ACTIVITY_ACTIONS).length,
    objectivesTested: 0,
    baselineMeasured: false,
    moneyMeasurable: false,
    confidence: 'NONE',
    valuedUnits: 0,
  };

  if (!args.db || !args.org) return { proof: base, usage: { executions: 0, activeDays: 0, organizations: 0 } };
  if (!existsSync(args.db)) {
    console.error(`No database at ${args.db}; reporting repository facts only.`);
    return { proof: base, usage: { executions: 0, activeDays: 0, organizations: 0 } };
  }

  const { DatabaseSync } = await import('node:sqlite');
  const { readExecutions } = await import(join(ROOT, 'proof/adapters/purchasing-sqlite.mjs'));
  const { caseStudy } = await import(join(ROOT, 'proof/case-study.mjs'));
  const LIP = await import(join(ROOT, 'proof/baselines/lippolis-purchasing.mjs'));

  const db = new DatabaseSync(args.db, { readOnly: true });
  // The whole recorded history, not a chosen window: readiness is about what
  // the deployment has done, and picking a favourable period is the first step
  // toward a favourable number.
  const span = db.prepare(
    `select min(created_at) as first, max(created_at) as last, count(*) as n
       from purchase_requests where org_id = ?`).get(args.org);
  const first = span?.first ?? null;
  const last = span?.last ?? null;

  if (!first) { db.close(); return { proof: base, usage: { executions: 0, activeDays: 0, organizations: 0 } }; }

  const to = new Date(Date.parse(last) + 86_400_000).toISOString();
  const { records } = readExecutions(db, { orgId: args.org, from: first, to, baselineId: 'lippolis_purchasing_v0' });
  db.close();

  const study = caseStudy({
    orgId: args.org, orgName: args.org, capability: 'purchasing', capabilityLabel: 'Purchasing',
    records, baselines: [LIP.lippolisPurchasingBaseline], touchStandards: [LIP.lippolisPurchasingTouchStandard],
    from: first, to,
  });

  const activeDays = Math.max(1, Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000));

  return {
    proof: {
      ...base,
      objectivesTested: study.objectiveSuccess.testable,
      baselineMeasured: study.baseline.some((b) => b.handlingMinutes.known),
      moneyMeasurable: study.labourValueCents.known,
      confidence: study.confidence.level,
      valuedUnits: study.ledger.valued,
    },
    usage: { executions: Number(span.n), activeDays, organizations: 1 },
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (['json', 'milestones'].includes(key)) { out[key] = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}
