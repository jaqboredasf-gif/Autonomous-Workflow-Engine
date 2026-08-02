// ---------------------------------------------------------------------------
// evidence-collect.mjs — refresh the repository's inspectable facts.
//
//   npm run evidence:collect
//   npm run evidence:collect -- --snapshot        (also write a timestamped copy)
//
// OFFLINE and READ-ONLY. Reads files, runs allowlisted git queries, writes only
// under the gitignored .awe/evidence/. Never contacts a database, a provider or
// a network.
//
// Every record it writes carries an origin — DIRECT_INSPECTION or
// NARRATIVE_CLAIM — because the one thing this collector must never do is
// launder a document's assertion into a measured fact.
// ---------------------------------------------------------------------------

import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { createFsContext, writeJson } from './lib/evidence/fs-context.mjs';
import {
  collectGit, collectPackages, collectMigrations, collectTests,
  collectDocumentation, collectSecurity,
} from './lib/evidence/collectors.mjs';
import { envelope, COLLECTOR_SCHEMA_VERSION } from './lib/evidence/schema.mjs';

const args = process.argv.slice(2);
const wantSnapshot = args.includes('--snapshot');
const quiet = args.includes('--quiet');
const visArg = args.indexOf('--visibility');
const isPublic = visArg >= 0 ? args[visArg + 1] === 'public' : null;

const root = process.cwd();
const ctx = createFsContext(root);
const generatedAt = new Date().toISOString();

/**
 * Runner numbers asserted in the cognition layer, so collectTests can report a
 * claim with no suite behind it. Read from context/, which is exactly the kind
 * of narrative source the collector is built to keep at arm's length.
 */
function cognitionClaims() {
  const out = [];
  const dir = join(root, 'context');
  if (!existsSync(dir)) return out;
  for (const f of ctx.list('context').filter((x) => x.endsWith('.md'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const m of text.matchAll(/Runner\s+([A-Z0-9]{1,3})\b/g)) {
      out.push({ runner: m[1], source: `context/${f}` });
    }
  }
  return out;
}

const git = collectGit(ctx);
const packages = collectPackages(ctx);
const migrations = collectMigrations(ctx);
const tests = collectTests(ctx, { cognitionClaims: cognitionClaims() });
const documentation = collectDocumentation(ctx);
const security = collectSecurity(ctx, { isPublic });

const commit = git.payload.commit;
const parts = { git, packages, migrations, tests, documentation, security };

const allWarnings = Object.values(parts).flatMap((p) => p.warnings);
const allErrors = Object.values(parts).flatMap((p) => p.errors);
const allRecords = Object.values(parts).flatMap((p) => p.records);

const files = {
  'repository.json': envelope('repository', commit, {
    root,
    remote: git.payload.remote,
    branch: git.payload.branch,
    commit,
    collector_schema_version: COLLECTOR_SCHEMA_VERSION,
    records: allRecords,
  }, { generatedAt }),
  'git.json': envelope('git', commit, git.payload, { warnings: git.warnings, errors: git.errors, generatedAt }),
  'packages.json': envelope('packages', commit, packages.payload, { warnings: packages.warnings, errors: packages.errors, generatedAt }),
  'migrations.json': envelope('migrations', commit, migrations.payload, { warnings: migrations.warnings, errors: migrations.errors, generatedAt }),
  'tests.json': envelope('tests', commit, tests.payload, { warnings: tests.warnings, errors: tests.errors, generatedAt }),
  'documentation.json': envelope('documentation', commit, documentation.payload, { warnings: documentation.warnings, errors: documentation.errors, generatedAt }),
  'security.json': envelope('security', commit, security.payload, { warnings: security.warnings, errors: security.errors, generatedAt }),
  'summary.json': envelope('summary', commit, {
    branch: git.payload.branch,
    clean: git.payload.status.dirty.length === 0 && git.payload.status.staged.length === 0,
    counts: {
      packages: packages.payload.packages.length,
      migrations: migrations.payload.migrations.length,
      migration_collisions: migrations.payload.collisions.length,
      suites: tests.payload.suites.length,
      documents: documentation.payload.documents.length,
      broken_references: documentation.payload.broken_references.length,
      sensitive_files: security.payload.sensitive_files.length,
      tracked_files: security.payload.tracked_file_count,
    },
    origins: allRecords.reduce((acc, r) => { acc[r.origin] = (acc[r.origin] || 0) + 1; return acc; }, {}),
    warning_kinds: allWarnings.reduce((acc, w) => { acc[w.kind] = (acc[w.kind] || 0) + 1; return acc; }, {}),
  }, { warnings: allWarnings, errors: allErrors, generatedAt }),
};

const latest = resolve(root, '.awe', 'evidence', 'latest');
for (const [name, value] of Object.entries(files)) writeJson(join(latest, name), value);

let snapshotDir = null;
if (wantSnapshot) {
  const stamp = generatedAt.replace(/[:.]/g, '-');
  snapshotDir = resolve(root, '.awe', 'evidence', 'snapshots', stamp);
  for (const [name, value] of Object.entries(files)) writeJson(join(snapshotDir, name), value);
}

if (!quiet) {
  const s = files['summary.json'];
  console.log(`evidence:collect — ${s.branch} @ ${String(commit).slice(0, 7)}${s.clean ? ' (clean)' : ' (DIRTY)'}`);
  console.log(`  packages ${s.counts.packages} · migrations ${s.counts.migrations} (${s.counts.migration_collisions} collision) · suites ${s.counts.suites} · docs ${s.counts.documents}`);
  console.log(`  origins: ${Object.entries(s.origins).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`  warnings ${allWarnings.length}, errors ${allErrors.length}`);
  for (const [k, v] of Object.entries(s.warning_kinds).sort()) console.log(`      ${k}: ${v}`);
  console.log(`  written  : ${latest}`);
  if (snapshotDir) console.log(`  snapshot : ${snapshotDir}`);
}

process.exit(allErrors.length ? 1 : 0);
