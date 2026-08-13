// ---------------------------------------------------------------------------
// pcc-preflight.mjs — is this machine ready to run PCC?
//
// Run it on the VM BEFORE installing, and again after configuring, to find the
// problems that otherwise surface as a container that will not start or — worse
// — one that starts against the wrong directory.
//
//   node scripts/pcc-preflight.mjs                    # check the environment
//   node scripts/pcc-preflight.mjs --data /srv/pcc/data --port 3000
//
//   --data   the persistent data directory (default: $PCC_DATABASE_PATH's parent)
//   --port   the port PCC will listen on (default: $PORT or 3000)
//   --strict treat warnings as failures
//
// Exit 0 = ready (warnings may still be printed). Exit 1 = at least one FAIL.
//
// ---------------------------------------------------------------------------
// THIS IS NOW A WRAPPER, NOT AN IMPLEMENTATION.
//
// The environment checks — runtime version and capabilities, data path absolute
// and writable and outside the source tree, free space, port, required
// variables, secret strength, base URL, datastore present or creation
// authorized — all live in deployment/preflight.mjs and are shared by every AWE
// deployment. They were duplicated here, and the two copies had already begun
// to drift.
//
// What remains PCC's is the part that is genuinely about this application:
//   · the manifest describing PCC, overlaid with what the environment says
//   · a small number of checks about PCC's own conventions (its backup
//     directory, the demo identity picker, the first-start admin password)
//   · the report format an operator has already learned to read
//
// STRICTLY READ-ONLY, and now structurally so: the shared runner refuses to
// execute any check that declares it mutates anything. The single write is a
// temporary file inside the directory being tested for writability, removed
// immediately.
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { declared, unknown } from '../deployment/facts.mjs';
import { validateManifest } from '../deployment/manifest.mjs';
import { CHECKS, nodeHostProbe, runPreflight } from '../deployment/preflight.mjs';
import { pccManifest } from '../deployment/examples/pcc.manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const strict = process.argv.includes('--strict');

// ---------------------------------------------------------------------------
// THE MANIFEST, OVERLAID WITH REALITY.
//
// The manifest states what this deployment is INTENDED to be. The environment
// states what it actually is. Preflight compares them, so the manifest values
// are the fallback and the environment wins where it speaks — this script is
// usually run on the machine, from the environment PCC will really start in.
// ---------------------------------------------------------------------------
const dbPathFromEnv = process.env.PCC_DATABASE_PATH ?? process.env.PURCHASING_DB_PATH ?? '';
const dataDir = arg('data') ?? (dbPathFromEnv ? dirname(dbPathFromEnv) : null);
const port = Number(arg('port') ?? process.env.PORT ?? 3000);

const manifest = {
  ...pccManifest,
  runtime: {
    ...pccManifest.runtime,
    // PCC's store is part of the runtime rather than a dependency. Declared
    // here so the shared check can test it without knowing what PCC is.
    capabilities: ['node:sqlite'],
  },
  storage: {
    ...pccManifest.storage,
    data_path: dataDir ? declared(dataDir, 'environment') : unknown('no --data given and PCC_DATABASE_PATH is unset'),
  },
  network: { ...pccManifest.network, port: declared(port, 'environment') },
  database: {
    ...pccManifest.database,
    location: dbPathFromEnv ? declared(dbPathFromEnv, 'environment') : pccManifest.database.location,
  },
  operations: {
    ...pccManifest.operations,
    create_authorization_env: 'PCC_DATABASE_ALLOW_CREATE',
    session_secret_env: 'SESSION_SECRET',
    base_url_env: 'APP_BASE_URL',
  },
};

// ---------------------------------------------------------------------------
// The checks that are genuinely PCC's.
//
// Each is here because it is about a convention of THIS application rather than
// a property of deployment. Anything true of every AWE capability belongs in
// the shared module, not in this file.
// ---------------------------------------------------------------------------
const PCC_CHECKS = [
  {
    id: 'pcc.backup_directory',
    phase: 'REQUIRED_BEFORE_GO_LIVE',
    mutates: false,
    describe: "PCC's backup directory",
    run(m, facts, probe) {
      const data = facts['storage.data_path'];
      if (!data?.value) return { id: this.id, status: 'UNKNOWN', detail: 'no data directory to look in' };
      const dir = join(String(data.value), 'backups');
      const exists = probe.pathExists(dir);
      if (exists === null) return { id: this.id, status: 'UNKNOWN', detail: `cannot see ${dir}` };
      // Absence is not a problem: pcc-backup.mjs creates it on first run. Said
      // as a fact rather than a scold — a warning that fires on every correct
      // installation teaches operators to ignore warnings.
      return exists
        ? { id: this.id, status: 'PASS', detail: `${dir} exists` }
        : { id: this.id, status: 'WARNING', detail: `${dir} does not exist yet — pcc-backup.mjs creates it on first run` };
    },
  },
  {
    id: 'pcc.demo_mode_refused',
    phase: 'REQUIRED_BEFORE_DEPLOY',
    mutates: false,
    describe: 'the developer identity picker is not enabled in production',
    run(m, facts, probe) {
      if (probe.env.PURCHASING_DEMO_MODE !== '1') return { id: this.id, status: 'PASS', detail: 'not enabled' };
      return probe.env.NODE_ENV === 'production'
        ? { id: this.id, status: 'BLOCKED', detail: 'PURCHASING_DEMO_MODE=1 in production — PCC will refuse to start' }
        : { id: this.id, status: 'WARNING', detail: 'PURCHASING_DEMO_MODE=1 — correct only outside production' };
    },
  },
  {
    id: 'pcc.bootstrap_password',
    phase: 'REQUIRED_BEFORE_GO_LIVE',
    mutates: false,
    describe: 'the first-start administrator password has been removed',
    run(m, facts, probe) {
      return probe.env.PCC_BOOTSTRAP_ADMIN_PASSWORD
        ? { id: this.id, status: 'WARNING', detail: 'PCC_BOOTSTRAP_ADMIN_PASSWORD is set — correct for the FIRST start only. Remove it afterwards.' }
        : { id: this.id, status: 'PASS', detail: 'not set' };
    },
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const probe = await nodeHostProbe();
const { problems } = validateManifest(manifest);
const report = await runPreflight(manifest, {
  probe,
  manifestProblems: problems,
  checks: [...CHECKS, ...PCC_CHECKS],
});

// ---------------------------------------------------------------------------
// Report — the format operators already read.
//
// BLOCKED prints as FAIL and UNKNOWN as WARNING, because those are the words
// the runbook and the installation record use. The mapping is stated here
// rather than in the shared module: the vocabulary is this script's, and the
// distinction between "checked and bad" and "could not check" is preserved in
// the detail line either way.
// ---------------------------------------------------------------------------
const LEVEL = { PASS: 'PASS   ', WARNING: 'WARNING', BLOCKED: 'FAIL   ', UNKNOWN: 'WARNING' };
const width = Math.max(...report.results.map((r) => r.id.length));

console.log('');
console.log('pcc-preflight — read-only readiness check (AWE deployment substrate)');
console.log('');
for (const r of report.results) {
  const detail = r.status === 'UNKNOWN' ? `could not be checked from here — ${r.detail}` : r.detail;
  console.log(`  ${LEVEL[r.status]}  ${r.id.padEnd(width)}  ${detail}`);
}

const failed = report.results.filter((r) => r.status === 'BLOCKED');
const warned = report.results.filter((r) => r.status === 'WARNING' || r.status === 'UNKNOWN');
console.log('');
console.log(`${report.counts.PASS} passed, ${warned.length} warning(s), ${failed.length} failure(s)`);

if (failed.length) {
  console.log('\nThis machine is NOT ready. Fix the failures above and run this again.');
  process.exit(1);
}
if (warned.length && strict) {
  console.log('\n--strict was given and there are warnings.');
  process.exit(1);
}
console.log(warned.length ? '\nReady, with warnings worth reading.' : '\nReady.');
process.exit(0);
