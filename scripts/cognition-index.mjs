// ---------------------------------------------------------------------------
// cognition-index.mjs — build and report the cognition registry.
//
//   npm run cognition:index    (rebuild .awe/cognition/*.json)
//   npm run cognition:status   (report without rebuilding, if an index exists)
//
// The registry is DERIVED. It is written under the gitignored .awe/ so that
// nobody edits it and creates a second truth alongside the canonical Markdown.
// Deleting it costs nothing; regenerate.
//
// OFFLINE and READ-ONLY apart from its own output.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildRegistry } from './lib/cognition/registry.mjs';

const root = process.cwd();
const statusOnly = process.argv.includes('--status');
const git = (a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

const outDir = resolve(root, '.awe', 'cognition');

if (statusOnly && existsSync(join(outDir, 'registry.json'))) {
  const reg = JSON.parse(readFileSync(join(outDir, 'registry.json'), 'utf8'));
  const fre = JSON.parse(readFileSync(join(outDir, 'freshness.json'), 'utf8'));
  const con = JSON.parse(readFileSync(join(outDir, 'conflicts.json'), 'utf8'));
  const current = git(['rev-parse', 'HEAD']);
  console.log(`cognition:status — indexed at ${reg.generated_at}`);
  console.log(`  index commit : ${String(reg.repository_commit).slice(0, 7)}${reg.repository_commit === current ? '' : `  (HEAD is now ${String(current).slice(0, 7)} — re-run cognition:index)`}`);
  console.log(`  documents ${reg.document_count} · sections ${reg.section_count}`);
  console.log(`  freshness: ${Object.entries(fre.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`  conflicts: ${con.count}`);
  for (const c of con.conflicts.slice(0, 10)) console.log(`      ${c.kind}: ${c.subject} — ${c.detail}`);
  process.exit(0);
}

const currentCommit = git(['rev-parse', 'HEAD']);
const branches = new Set(
  (git(['branch', '-a', '--format=%(refname:short)']) || '')
    .split('\n').map((b) => b.replace(/^origin\//, '').trim()).filter((b) => b && !b.includes('->')),
);

// Same ancestry semantics as context:check — an ancestor commit with no
// *modified* evidence path since is still a true statement about the code.
const EVIDENCE_PATHS = /^(packages|supabase|scripts|apps)\//;
function classifyRef(ref) {
  if (!ref) return null;
  if (String(currentCommit).startsWith(ref)) return 'current';
  const isAncestor = git(['merge-base', '--is-ancestor', ref, 'HEAD']) !== null;
  if (!isAncestor) return git(['cat-file', '-t', ref]) === 'commit' ? 'other_branch' : 'unknown';
  const diff = git(['diff', '--name-status', `${ref}..HEAD`]) || '';
  const changed = diff.split('\n').map((l) => l.split('\t'))
    .filter(([s, p]) => s && p && /^[MDR]/.test(s) && EVIDENCE_PATHS.test(p));
  return changed.length ? 'stale' : 'fresh';
}

const dirs = ['context', 'docs/integration'];
const documents = [];
for (const d of dirs) {
  const abs = join(root, d);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs).filter((x) => x.endsWith('.md'))) {
    documents.push({ path: `${d}/${f}`, text: readFileSync(join(abs, f), 'utf8') });
  }
}

const obs = {
  currentCommit,
  lastCommitFor: (p) => git(['log', '-1', '--format=%h', '--', p]),
  classifyRef,
  branchExists: (b) => branches.has(b),
  pathExists: (p) => existsSync(join(root, p)),
};

const built = buildRegistry(documents, obs, { generatedAt: new Date().toISOString() });

mkdirSync(outDir, { recursive: true });
for (const [name, value] of Object.entries({
  'registry.json': built.registry,
  'sources.json': built.sources,
  'freshness.json': built.freshness,
  'conflicts.json': built.conflicts,
})) {
  writeFileSync(join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

console.log(`cognition:index — ${built.registry.document_count} document(s), ${built.registry.section_count} section(s)`);
console.log(`  freshness: ${Object.entries(built.freshness.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`  conflicts: ${built.conflicts.count}`);
for (const c of built.conflicts.conflicts.slice(0, 12)) console.log(`      ${c.kind}: ${c.subject} — ${c.detail}`);
console.log(`  written: ${outDir}`);
