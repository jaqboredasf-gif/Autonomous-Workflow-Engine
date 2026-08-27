// ---------------------------------------------------------------------------
// proof-case-study.mjs — what did PCC actually accomplish, and how do we know?
//
// Reads a live (or backup) purchasing database READ-ONLY and prints the
// deployment case study for a period: executions, objective success, human
// interventions, cycle time, hours returned, economic value, and — the part
// that makes the rest trustworthy — everything it could not measure and why.
//
//   node scripts/proof-case-study.mjs --db /data/pcc.sqlite \
//                                     --org lippolis \
//                                     --from 2026-09-01 --to 2026-10-01
//
//   --db      the database. Default: $PCC_DATABASE_PATH.
//   --org     the organization. REQUIRED — a metric that is not tenant-bound
//             is not a metric, it is a leak.
//   --from    period start, inclusive, ISO date. REQUIRED.
//   --to      period end, exclusive, ISO date. REQUIRED.
//   --explain print the audit chain behind the hours figure: every execution,
//             every baseline step, every source.
//   --json    machine-readable, for a dashboard or AXIS.
//   --allow-nonproduction  report from a database that has not declared itself
//             production. REQUIRED for a rehearsal or development file, and the
//             output is stamped so the result cannot be mistaken for evidence.
//
// A DATABASE MUST PROVE IT IS PRODUCTION. The deployment rehearsal builds the
// production artifact, starts it with the real company name and the real
// organization id, and drives real purchases through it — so the file it leaves
// behind is indistinguishable from production by inspection. Only the
// environment the installation stamped at creation can tell them apart, and
// anything that is not explicitly `production` is refused here unless somebody
// asks for it by name.
//
// IT WILL NOT invent a baseline. If nobody has measured how Lippolis bought
// material before PCC, this prints NOT MEASURABLE against every value figure
// and lists what has to be observed. That output is the correct output today.
//
// READ ONLY. It opens the database with readOnly: true and writes nothing.
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { caseStudy, explain, render } = await import(join(ROOT, 'proof/case-study.mjs'));
const { readExecutions } = await import(join(ROOT, 'proof/adapters/purchasing-sqlite.mjs'));
const LIP = await import(join(ROOT, 'proof/baselines/lippolis-purchasing.mjs'));

// Which baseline and touch standard govern which organization. One place, so
// adding a second customer is a line here rather than an edit to the reader.
const REGISTRY = {
  lippolis: {
    name: 'Lippolis Electric, Inc.',
    baselineId: 'lippolis_purchasing_v0',
    baselines: [LIP.lippolisPurchasingBaseline],
    touchStandards: [LIP.lippolisPurchasingTouchStandard],
  },
};

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db ?? process.env.PCC_DATABASE_PATH;

if (!dbPath) fail('Set --db or PCC_DATABASE_PATH to the purchasing database file.');
if (!existsSync(dbPath)) fail(`No database at ${dbPath}.`);
if (!args.org) fail('Set --org. Evidence is organization-bound; there is no all-tenants view.');
if (!args.from || !args.to) fail('Set --from and --to (ISO dates). A figure with no period is not a figure.');

const org = REGISTRY[args.org];
if (!org) {
  fail(`No baseline is registered for "${args.org}". Known: ${Object.keys(REGISTRY).join(', ') || 'none'}.\n` +
       'An organization with no registered baseline cannot be measured — see docs/proof/BASELINE_METHODOLOGY.md.');
}

const from = `${args.from}T00:00:00Z`;
const to = `${args.to}T00:00:00Z`;

const db = new DatabaseSync(dbPath, { readOnly: true });

// The read is a module (proof/adapters/purchasing-sqlite.mjs), not inline SQL,
// so the suite exercises the same statements this command runs.
const { records, adminTouches, requestsRead, environment } = readExecutions(db, {
  orgId: args.org, from, to, baselineId: org.baselineId,
});

db.close();

if (environment !== 'production' && !args.allowNonproduction) {
  fail(
    `This database declares itself "${environment}", not "production".\n` +
    'Its records are not evidence about a real organization, and a rehearsal database is built to\n' +
    'look exactly like production — same artifact, same company name, same organization id.\n\n' +
    'To read it anyway: --allow-nonproduction (the output will be stamped as such).\n' +
    'To make a real installation report as production: set PCC_ENVIRONMENT=production before its\n' +
    'FIRST start. The stamp is written once, when the database is created.');
}

// --- the projection ------------------------------------------------------
const study = caseStudy({
  orgId: args.org,
  orgName: org.name,
  capability: 'purchasing',
  capabilityLabel: 'Purchasing Workflow',
  records,
  baselines: org.baselines,
  touchStandards: org.touchStandards,
  from,
  to,
  // Administrative work in the period is a period cost. It is COLLECTED here
  // and left unpriced, so it shows as an unmeasured overhead — which correctly
  // refuses a net hours figure — rather than being quietly omitted.
  overheads: [],
});

if (args.json) {
  console.log(JSON.stringify({ environment, ...(args.explain ? explain(study) : study) }, replacer, 2));
} else {
  if (environment !== 'production') {
    console.log('='.repeat(72));
    console.log(`NOT EVIDENCE — this database declares itself "${environment}", not "production".`);
    console.log('Everything below describes a rehearsal. Do not quote it.');
    console.log('='.repeat(72));
    console.log('');
  }
  console.log(render(study));
  console.log('');
  console.log(`Requests read:                                                    ${requestsRead}`);
  console.log(`Administrative interactions in period (unpriced period overhead): ${adminTouches.length}`);
  if (args.explain) {
    console.log('');
    console.log('--- how do we know? ------------------------------------------------');
    const chain = explain(study, 'hoursReturned');
    console.log(`${chain.metric}: ${chain.value ?? 'NOT MEASURABLE'} ${chain.unit} [${chain.grade}]`);
    console.log(`  ${chain.basis}`);
    console.log('');
    for (const b of chain.restsOn.baselines) {
      console.log(`  baseline ${b.key}  total ${b.totalMinutes ?? 'NOT MEASURED'} min  [${b.grade}]`);
      for (const s of b.steps) console.log(`    · ${s.label}: ${s.minutes ?? 'not measured'} [${s.grade}]`);
    }
    console.log('');
    for (const c of chain.contributions) {
      console.log(`  ${c.unitOfWork}  exec=${c.executionOutcome}  objective=${c.objective}  ` +
        `touches=${c.humanTouches}  returned=${c.minutesReturned ?? '—'}${c.excludedBecause ? `  (${c.excludedBecause})` : ''}`);
    }
  }
}

process.exit(0);

// ---------------------------------------------------------------------------

function replacer(_key, value) {
  return value instanceof Map ? Object.fromEntries(value) : value;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (['explain', 'json'].includes(key)) { out[key] = true; continue; }
    if (key === 'allow-nonproduction') { out.allowNonproduction = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
