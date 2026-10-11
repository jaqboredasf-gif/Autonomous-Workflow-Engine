// ---------------------------------------------------------------------------
// awe-ci-evidence.mjs — import what CI said about one commit.
//
//   node scripts/awe-ci-evidence.mjs --commit <40-char sha> --check-runs runs.json \
//        [--ref pcc-production] [--by "who imported it"]
//   node scripts/awe-ci-evidence.mjs --show <sha>
//
// runs.json is a check-runs document for that commit, as returned by
//   GET /repos/{owner}/{repo}/commits/{sha}/check-runs
// or by the GitHub MCP tools. This script makes no network call: the engine
// judges evidence, and whoever can read GitHub supplies it. The record keeps
// the run ids and URLs and the sha256 of the document, so a person can check
// it against GitHub.
//
// Writes .awe/ci/<sha>.json (gitignored). The engine uses it only for that
// exact commit (autonomy/lib/ci-evidence.mjs).
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromCheckRuns, ciVerdict } from '../autonomy/lib/ci-evidence.mjs';
import { git } from '../autonomy/lib/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const die = (m) => { console.error(`awe-ci-evidence: ${m}`); process.exit(64); };

if (arg('show')) {
  const sha = arg('show');
  let rec = null;
  try { rec = JSON.parse(readFileSync(join(ROOT, '.awe/ci', `${sha}.json`), 'utf8')); } catch { /* absent */ }
  const v = ciVerdict(rec, sha);
  console.log(`${sha.slice(0, 12)}: ${v.status} — ${v.detail}`);
  process.exit(0);
}

const commit = arg('commit');
const file = arg('check-runs');
if (!commit || !file) die('usage: --commit <sha> --check-runs <file>');
if (git(ROOT, ['cat-file', '-e', `${commit}^{commit}`]) === null) die(`${commit} is not a commit in this repository (fetch it first)`);

let doc;
try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { die(`cannot read ${file}: ${e.message}`); }
let rec;
try {
  rec = fromCheckRuns(doc, { commit, ref: arg('ref'), importedBy: arg('by') ?? 'unspecified', importedAt: new Date().toISOString() });
} catch (e) { die(e.message); }

mkdirSync(join(ROOT, '.awe/ci'), { recursive: true });
writeFileSync(join(ROOT, '.awe/ci', `${commit}.json`), JSON.stringify(rec, null, 2) + '\n');
const v = ciVerdict(rec, commit);
console.log(`awe-ci-evidence: ${commit.slice(0, 12)} ${v.status} — ${v.detail}`);
console.log(`wrote .awe/ci/${commit}.json`);
