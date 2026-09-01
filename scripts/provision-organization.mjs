#!/usr/bin/env node
// ---------------------------------------------------------------------------
// provision-organization.mjs — stand up a new organization from its dossier.
//
//   node scripts/provision-organization.mjs --org northgate            # plan only
//   node scripts/provision-organization.mjs --org northgate --write-env out/
//   node scripts/provision-organization.mjs --org northgate --json
//
//   --org        directory under organizations/. Required.
//   --write-env  write the derived environment to <dir>/<org>.env
//   --json       machine-readable output, for the rehearsal suite
//
// WHAT IT DOES AND DELIBERATELY DOES NOT DO.
//
// It VALIDATES the dossier, loads the three models it references, checks they
// agree with each other, runs the readiness gate, and DERIVES the environment
// the application reads. That is the whole of the part nobody could do reliably
// by hand.
//
// It does NOT create the database and it does NOT load the reference data,
// because both already have a correct implementation and a second one would be
// a second place for the rules to live:
//
//   the database    is created by the application's own first production start
//                   (infrastructure/bootstrap.ts), which refuses an
//                   under-identified organization and stamps the environment
//                   permanently. A provisioning script that created the row
//                   itself would bypass every one of those refusals.
//   reference data  is loaded by scripts/pcc-onboard.mjs, which calls the same
//                   functions the Admin screens call. A row it refuses is a row
//                   the screen would have refused.
//
// So this prints the two commands with the right arguments already filled in,
// which is the actual failure it is built against: not that the steps are hard,
// but that getting one environment variable wrong creates a tenant under the
// wrong permanent id.
//
// PLAN BEFORE APPLY, ALWAYS. The default output is a plan. Nothing is written
// unless --write-env is given, and even then the only artifact is a file of
// non-secret configuration.
//
// IDEMPOTENT. Reading a dossier and deriving an environment has no side effects
// at all, so running this twice produces byte-identical output. The steps that
// DO have side effects are idempotent in their own right: bootstrap refuses a
// second creation, and pcc-onboard skips what already matches.
//
// NO SECRETS. SESSION_SECRET and any database credential come from the
// manifest's secret store at install time and are never derived here — so the
// output of this script is safe to print, paste into a ticket, and commit.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const R = (...p) => join(ROOT, ...p);

const { validateDossier, deploymentEnvFor, missingFacts, DOSSIER_FIELDS } =
  await import(R('capability/purchasing/organization.mjs'));
const { designPartnerReadiness } = await import(R('programs/design-partner/readiness.mjs'));
const { IMPLEMENTED_IDS } = await import(R('apps/purchasing/src/purchasing/organization/po-numbering.mjs'));

// The template keys the build can draw. Read from the adapter's own registry so
// this cannot drift from what the renderer will actually accept.
const PO_TEMPLATE_KEYS = (() => {
  const src = readFileSync(R('apps/purchasing/src/purchasing/infrastructure/pdf-adapter.ts'), 'utf8');
  const block = src.slice(src.indexOf('export const PO_TEMPLATES'));
  return [...block.slice(0, block.indexOf('});')).matchAll(/^\s{2}([a-z0-9_]+):/gim)].map((m) => m[1]);
})();

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const org = arg('org');
const asJson = flag('json');
const out = [];
const say = (s = '') => { if (!asJson) console.log(s); out.push(s); };
let failed = false;
const refuse = (message, detail = []) => {
  failed = true;
  if (asJson) return;
  console.error(`REFUSED: ${message}`);
  for (const d of detail) console.error(`  ${d}`);
};

if (!org) {
  const available = existsSync(R('organizations'))
    ? readdirSync(R('organizations'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  console.error('REFUSED: --org is required.');
  console.error(`  Available: ${available.join(', ') || '(none)'}`);
  console.error('  node scripts/provision-organization.mjs --org northgate');
  process.exit(1);
}

// --- load the dossier -------------------------------------------------------
const dossierPath = `organizations/${org}/dossier.mjs`;
if (!existsSync(R(dossierPath))) {
  console.error(`REFUSED: no dossier at ${dossierPath}.`);
  console.error('  Copy organizations/northgate/dossier.mjs and answer it from the discovery call.');
  process.exit(1);
}
const dossierModule = await import(R(dossierPath));
const dossier = dossierModule.default ?? Object.values(dossierModule)[0];

// --- validate before anything else reads it --------------------------------
const shape = validateDossier(dossier);
const errors = shape.problems.filter((p) => p.level === 'error');

say(`=== provisioning plan: ${dossier?.organization?.id ?? org}`);
say('');

if (errors.length) {
  refuse(`${dossierPath} is not a valid dossier`, errors.map((p) => `${p.path}: ${p.message}`));
  say('MISSING FACTS, and who owns each:');
  for (const m of missingFacts(dossier)) say(`  ${m.owner.padEnd(8)} ${m.fact} — unlocks ${m.unlocks}`);
}

// --- load the three referenced models -------------------------------------
const loadRef = async (ref, label) => {
  if (!ref || typeof ref !== 'string') return null;
  if (!existsSync(R(ref))) { refuse(`${label} not found: ${ref}`); return null; }
  const m = await import(R(ref));
  return m.default ?? Object.values(m)[0] ?? null;
};
const profile = errors.length ? null : await loadRef(dossier.profile_ref, 'purchasing profile');
const authorization = errors.length ? null : await loadRef(dossier.authorization_ref, 'authorization profile');
const manifest = errors.length ? null : await loadRef(dossier.manifest_ref, 'deployment manifest');

// --- instance data ---------------------------------------------------------
const instanceDir = dossier?.instance_data?.dir;
const REQUIRED_CSV = ['users.csv', 'jobs.csv', 'vendors.csv', 'assignments.csv', 'po_sequences.csv'];
const instanceMissing = instanceDir && existsSync(R(instanceDir))
  ? REQUIRED_CSV.filter((f) => !existsSync(R(instanceDir, f)))
  : REQUIRED_CSV;
const instanceDataPresent = Boolean(instanceDir) && instanceMissing.length === 0;

// --- the readiness gate ----------------------------------------------------
const readiness = designPartnerReadiness({
  dossier, profile, authorization, manifest,
  implementedNumberingIds: IMPLEMENTED_IDS,
  implementedTemplateKeys: PO_TEMPLATE_KEYS,
  // REHEARSAL IS NEVER ASSUMED. This script cannot know whether the
  // second-organization rehearsal has been run, and a gate that guessed "yes"
  // would report READY_FOR_PILOT for a path nobody has walked.
  evidence: { instanceDataPresent, rehearsed: false },
});

// --- the derived environment ----------------------------------------------
let env = null;
if (!errors.length && profile) {
  try {
    env = deploymentEnvFor(dossier, profile, authorization);
  } catch (err) {
    refuse('cannot derive the deployment environment', [err.message]);
  }
}

if (env) {
  say('DERIVED ENVIRONMENT — every value below comes from the dossier or its');
  say('profile, so it cannot disagree with them. No secrets appear here.');
  say('');
  for (const [k, v] of Object.entries(env)) say(`  ${k}=${v}`);
  say('');
  say('STILL REQUIRED, and NOT derivable — these are the deployment\'s own:');
  say('  PCC_ENVIRONMENT   production | rehearsal. Stamped once, permanently.');
  say('  NODE_ENV          production');
  say('  APP_BASE_URL      from the manifest\'s network.hostname');
  say('  SESSION_SECRET    from the manifest\'s secret store. NEVER from a dossier.');
  say('');
}

if (instanceMissing.length) {
  say(`INSTANCE DATA INCOMPLETE in ${instanceDir ?? '(no directory declared)'}:`);
  for (const f of instanceMissing) say(`  missing ${f}`);
  say('');
}

// --- the plan --------------------------------------------------------------
say('THE STEPS, in dependency order. None of them is performed by this script:');
say('');
say('  1. install the release on the target host');
say('     see PCC_VM_INSTALLATION_RUNBOOK.md');
say('  2. write the environment above, plus the four values it cannot derive');
say(`     node scripts/provision-organization.mjs --org ${org} --write-env <dir>`);
say('  3. FIRST START — this is what creates the organization, and the only');
say('     moment its id, name, letterhead and environment stamp can be set');
say('     an under-identified organization is refused; nothing is created');
say('  4. load the reference data, dry run first');
say(`     node scripts/pcc-onboard.mjs --dir ${instanceDir ?? '<dir>'} --dry-run`);
say(`     node scripts/pcc-onboard.mjs --dir ${instanceDir ?? '<dir>'}`);
say('  5. verify the deployment');
say('     node scripts/pcc-verify-deployment.mjs');
say('  6. open the proof boundary only when the baseline is frozen');
say('     npm run baseline:freeze');
say('');

// --- verdict ---------------------------------------------------------------
say(`READINESS: ${readiness.verdict}`);
say(readiness.summary);
say('');
if (readiness.aweOwned.length) {
  say('OURS TO CLOSE:');
  for (const b of readiness.aweOwned) say(`  ${b.fact} — unlocks ${b.unlocks}${b.detail ? `\n      ${b.detail}` : ''}`);
  say('');
}
if (readiness.customerOwned.length) {
  say('THEIRS TO ANSWER — the agenda for the next call:');
  for (const b of readiness.customerOwned) say(`  ${b.fact} — unlocks ${b.unlocks}${b.detail ? `\n      ${b.detail}` : ''}`);
  say('');
}

// --- --write-env -----------------------------------------------------------
const writeDir = arg('write-env');
if (writeDir) {
  if (!env) {
    refuse('will not write an environment file for an invalid dossier');
  } else {
    const target = resolve(writeDir, `${dossier.organization.id}.env`);
    const body = [
      `# Derived from ${dossierPath} by scripts/provision-organization.mjs.`,
      '# DO NOT EDIT. Change the dossier and re-derive — a value edited here is a',
      '# value that no longer matches the profile it was supposed to come from.',
      '#',
      '# NO SECRETS ARE IN THIS FILE. Append the four values named below from the',
      '# deployment manifest and its secret store before the first start.',
      '',
      ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      '',
      '# --- required, and not derivable from configuration ---',
      '# PCC_ENVIRONMENT=production',
      '# NODE_ENV=production',
      '# APP_BASE_URL=',
      '# SESSION_SECRET=',
      '',
    ].join('\n');
    writeFileSync(target, body);
    say(`wrote ${target}`);
  }
}

if (asJson) {
  console.log(JSON.stringify({
    org: dossier?.organization?.id ?? null,
    valid: errors.length === 0,
    problems: shape.problems,
    env,
    instanceDataPresent,
    instanceMissing,
    readiness: {
      verdict: readiness.verdict,
      blockers: readiness.blockers,
      aweOwned: readiness.aweOwned.length,
      customerOwned: readiness.customerOwned.length,
    },
    plannedSteps: 6,
    dossierFields: Object.keys(DOSSIER_FIELDS).length,
  }, null, 2));
}

process.exit(failed ? 1 : 0);
