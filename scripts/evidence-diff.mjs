// ---------------------------------------------------------------------------
// evidence-diff.mjs — what changed since anyone last looked.
//
//   npm run evidence:diff                     (latest two snapshots)
//   npm run evidence:diff -- --from <dir> --to <dir>
//
// OFFLINE and READ-ONLY apart from writing its own report under .awe/.
// ---------------------------------------------------------------------------

import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readJson, writeJson } from './lib/evidence/fs-context.mjs';
import { diffSnapshots, summarizeDiff, diffToMarkdown } from './lib/evidence/diff.mjs';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

const root = process.cwd();
const snapDir = resolve(root, '.awe', 'evidence', 'snapshots');

function loadSnapshot(dir) {
  const parts = ['git', 'packages', 'migrations', 'tests', 'documentation', 'security', 'summary'];
  const out = {};
  for (const p of parts) out[p] = readJson(join(dir, `${p}.json`)) || {};
  out.meta = { dir, generated_at: out.summary.generated_at || null };
  return out;
}

let fromDir = arg('--from');
let toDir = arg('--to');

if (!fromDir || !toDir) {
  if (!existsSync(snapDir)) {
    console.error('evidence:diff — no snapshots exist yet.');
    console.error('Run `npm run evidence:collect -- --snapshot` at least twice, then diff.');
    process.exit(1);
  }
  const snaps = readdirSync(snapDir).sort();
  if (snaps.length < 2) {
    console.error(`evidence:diff — need two snapshots, found ${snaps.length}.`);
    console.error('Run `npm run evidence:collect -- --snapshot` again to create a second one.');
    process.exit(1);
  }
  fromDir = join(snapDir, snaps[snaps.length - 2]);
  toDir = join(snapDir, snaps[snaps.length - 1]);
}

const a = loadSnapshot(fromDir);
const b = loadSnapshot(toDir);
const changes = diffSnapshots(a, b);
const summary = summarizeDiff(changes);

const outDir = resolve(root, '.awe', 'evidence', 'diff');
mkdirSync(outDir, { recursive: true });
writeJson(join(outDir, 'latest.json'), {
  from: { dir: fromDir, generated_at: a.meta.generated_at, commit: a.git?.commit || null },
  to: { dir: toDir, generated_at: b.meta.generated_at, commit: b.git?.commit || null },
  summary,
  changes,
});
writeFileSync(join(outDir, 'latest.md'), diffToMarkdown(a, b, changes), 'utf8');

console.log(`evidence:diff — ${summary.total} change(s)`);
for (const [kind, n] of Object.entries(summary.by_kind).sort()) console.log(`  ${kind}: ${n}`);
for (const c of changes.slice(0, 25)) console.log(`      ${c.kind}: ${c.message}`);
if (changes.length > 25) console.log(`      … and ${changes.length - 25} more (see the report)`);
console.log(`  written: ${outDir}`);
