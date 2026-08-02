// ---------------------------------------------------------------------------
// dashboard-build.mjs — generate the local operating dashboard.
//
//   npm run dashboard:build
//
// Writes .awe/dashboard/index.html plus its data. Open the file from disk; there
// is no server, and starting one is explicitly out of scope.
//
// OFFLINE and READ-ONLY apart from its own output.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildModel, renderHtml } from './lib/dashboard/build.mjs';
import { listTasks } from './lib/dispatch/store.mjs';

const root = process.cwd();
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const git = (a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

const evidence = readJson(join(root, '.awe', 'evidence', 'latest', 'summary.json'));
const cognition = {
  registry: readJson(join(root, '.awe', 'cognition', 'registry.json')),
  freshness: readJson(join(root, '.awe', 'cognition', 'freshness.json')),
  conflicts: readJson(join(root, '.awe', 'cognition', 'conflicts.json')),
};
const vault = arg('--vault');
const obsidian = vault ? readJson(join(resolve(vault), 'AWE', '.awe-sync-manifest.json')) : null;

const porcelain = git(['status', '--porcelain']) || '';
const model = buildModel({
  git: {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: git(['rev-parse', 'HEAD']),
    clean: porcelain.trim().length === 0,
    dirty_files: porcelain.split('\n').map((l) => l.slice(3).trim()).filter(Boolean),
  },
  evidence,
  cognition: cognition.registry ? cognition : null,
  dispatch: listTasks(root),
  obsidian,
  handoff: existsSync(join(root, 'context', 'LATEST_AGENT_HANDOFF.md')) ? 'context/LATEST_AGENT_HANDOFF.md' : null,
  generatedAt: new Date().toISOString(),
});

const outDir = resolve(root, '.awe', 'dashboard');
mkdirSync(join(outDir, 'data'), { recursive: true });
writeFileSync(join(outDir, 'index.html'), renderHtml(model), 'utf8');
writeFileSync(join(outDir, 'data', 'model.json'), `${JSON.stringify(model, null, 2)}\n`, 'utf8');

console.log('dashboard:build');
for (const t of model.tiles) console.log(`  ${t.state.padEnd(12)} ${t.label.padEnd(24)} ${t.value}`);
console.log(`  written: ${join(outDir, 'index.html')}`);
if (!evidence) console.log('  note: no evidence snapshot — run evidence:collect for a fuller picture');
if (!cognition.registry) console.log('  note: no cognition index — run cognition:index');
if (!obsidian) console.log('  note: pass --vault "<path>" to include Obsidian projection state');
