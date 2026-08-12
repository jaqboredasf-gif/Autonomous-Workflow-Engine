// ---------------------------------------------------------------------------
// check-deployable.mjs — refuse to ship a package with somebody's data in it.
//
// THE FAILURE THIS CATCHES. `next build --output standalone` copies the
// application directory into the artifact, and on a developer machine that
// directory contains `.data/purchasing.db` — a real database with real pilot
// purchase orders. Deploy that image and it is the database the application
// opens: the developer's records become the company's, and the next redeploy
// silently replaces them with the same stale copy again. Nothing errors. The
// health check is green. The purchase orders are simply somebody else's.
//
// Next has no setting that prevents this (outputFileTracingExcludes governs
// the dependency trace, not the app-directory copy), so it is checked instead
// of hoped for. The Docker build runs this after `next build` and before the
// runtime stage copies anything.
//
// Also checks the two other things that must not be in an image: a committed
// environment file, and the artifact missing its server entirely.
//
//   node scripts/check-deployable.mjs [path-to-standalone]
//
// Exits 0 when the package is safe to ship, 1 with an explanation when it is
// not. Prints what it examined either way — a check nobody can see the work of
// is a check nobody trusts.
// ---------------------------------------------------------------------------

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STANDALONE = process.argv[2] ?? join(ROOT, 'apps', 'purchasing', '.next', 'standalone');

function dirname(path) {
  return path.slice(0, path.lastIndexOf(sep));
}

/** Things that must never be inside a deployable package. */
const FORBIDDEN = [
  { test: (name) => /\.(db|sqlite|sqlite3)$/.test(name), why: 'a database file — deploying it serves somebody else\'s records' },
  { test: (name) => /\.db-(wal|shm)$/.test(name), why: 'a database journal — it belongs to a database that is not in this image' },
  { test: (name) => name === '.env' || /^\.env\.(local|production)$/.test(name), why: 'an environment file — secrets belong in the runtime, never in an image' },
  { test: (name) => name === 'id_rsa' || name.endsWith('.pem') || name.endsWith('.p12'), why: 'a private key' },
];

if (!existsSync(STANDALONE)) {
  console.error(`check-deployable: nothing at ${STANDALONE}.`);
  console.error('Run `npm run build -w purchasing` first (next.config.ts sets output: "standalone").');
  process.exit(1);
}

const findings = [];
let examined = 0;

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // node_modules is enormous and is not where anybody's database ends up.
      // Skipping it keeps this check fast enough to run on every build.
      if (entry.name === 'node_modules') continue;
      walk(full);
      continue;
    }
    examined += 1;
    for (const rule of FORBIDDEN) {
      if (rule.test(entry.name)) {
        findings.push({ path: relative(STANDALONE, full), why: rule.why });
        break;
      }
    }
  }
}

walk(STANDALONE);

const server = existsSync(join(STANDALONE, 'apps', 'purchasing', 'server.js'));
if (!server) {
  findings.push({ path: 'apps/purchasing/server.js', why: 'missing — the standalone build did not produce a server' });
}

console.log(`check-deployable: examined ${examined} file(s) in ${STANDALONE}`);

if (!findings.length) {
  console.log('check-deployable: PASS — no database, no journal, no secret, and the server is present.');
  process.exit(0);
}

console.error('\ncheck-deployable: FAIL — this package must not be deployed.\n');
for (const f of findings) console.error(`  ${f.path}\n    ${f.why}`);
console.error(
  '\nIf this is a local build, delete the offending file(s) from the package (or build in a clean\n' +
    'checkout). The Docker build excludes them by context (.dockerignore) and should never reach here.',
);
process.exit(1);
