// ---------------------------------------------------------------------------
// cognition-ingest.mjs — ingest a structured handoff as CANDIDATE cognition.
//
//   npm run cognition:ingest-handoff -- --handoff <path>
//   npm run cognition:ingest-handoff -- --handoff <path> --apply
//
// Without --apply it writes a report and changes nothing. With --apply it will
// append to ONE designated operational section, and only when every candidate
// cleared preflight and nothing was contradicted. It will never touch identity,
// operating policies, the active capability spec, or critical decisions — those
// are strategic truth, and an agent does not get to edit them.
//
// OFFLINE and READ-ONLY apart from its report and, with --apply, one append.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { proposeCognitionPatch, proposalToMarkdown, isProtected } from './lib/cognition/ingest.mjs';
import { loadTask } from './lib/dispatch/store.mjs';
import { validateHandoff } from './lib/dispatch/handoff.mjs';

const root = process.cwd();
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const apply = argv.includes('--apply');

const git = (a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

const path = arg('--handoff');
if (!path) { console.error('usage: cognition:ingest-handoff -- --handoff <path> [--apply]'); process.exit(1); }
if (!existsSync(path)) { console.error(`cognition:ingest — handoff not found: ${path}`); process.exit(1); }

let handoff;
try { handoff = JSON.parse(readFileSync(path, 'utf8')); }
catch (e) { console.error(`cognition:ingest — handoff is not valid JSON: ${e.message}`); process.exit(1); }

const task = loadTask(root, handoff.task_id);
const structural = validateHandoff(handoff, { requiredTests: task?.required_tests || [] });
if (structural.length) {
  console.error('cognition:ingest — the handoff is not structurally valid:');
  for (const e of structural) console.error(`  FAIL  ${e}`);
  process.exit(1);
}

const obs = {
  commitExists: (sha) => !!sha && git(['cat-file', '-t', sha]) === 'commit',
  fileExists: (p) => existsSync(resolve(root, p)),
  filesInRange: () => {
    const { starting_commit: a, ending_commit: b } = handoff;
    if (!a || !b) return [];
    const out = git(['diff', '--name-only', `${a}..${b}`]);
    return out ? out.split('\n').filter(Boolean) : [];
  },
  suiteExists: (name) => {
    const bare = String(name).replace(/^scripts\//, '').replace(/\.(sh|mjs)$/, '');
    return existsSync(join(root, 'scripts', `${bare}.sh`)) || existsSync(join(root, 'scripts', `${bare}.mjs`));
  },
};

const proposal = proposeCognitionPatch(handoff, task, obs, { generatedAt: new Date().toISOString() });

const outDir = resolve(root, '.awe', 'cognition', 'ingestion');
mkdirSync(outDir, { recursive: true });
const base = join(outDir, `${handoff.task_id}`);

console.log(`cognition:ingest ${handoff.task_id}`);
for (const [k, v] of Object.entries(proposal.counts).sort()) console.log(`  ${k.padEnd(28)} ${v}`);
for (const f of proposal.preflight_failures) console.log(`  PREFLIGHT FAIL  ${f}`);
for (const c of proposal.candidates.filter((c) => c.classification === 'CONTRADICTED')) {
  console.log(`  CONTRADICTED    ${c.claim} — ${c.reason}`);
}

if (apply) {
  if (!proposal.patch) {
    console.error(`\ncognition:ingest — --apply given but no patch is proposed. ${proposal.note}`);
    writeFileSync(`${base}.json`, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
    writeFileSync(`${base}.md`, proposalToMarkdown(proposal), 'utf8');
    process.exit(1);
  }
  if (isProtected(proposal.patch.document)) {
    console.error(`\ncognition:ingest — refusing to write ${proposal.patch.document}: it is a protected document.`);
    process.exit(1);
  }
  const target = resolve(root, proposal.patch.document);
  if (!existsSync(target)) {
    console.error(`\ncognition:ingest — target document does not exist: ${proposal.patch.document}`);
    process.exit(1);
  }
  const text = readFileSync(target, 'utf8');
  const marker = '**Total reproduced:';
  const idx = text.indexOf(marker);
  if (idx < 0) {
    console.error(`\ncognition:ingest — could not locate the operational append point in ${proposal.patch.document}.`);
    console.error('Refusing to guess where to write. Apply the proposed lines by hand.');
    process.exit(1);
  }
  const updated = `${text.slice(0, idx)}${proposal.patch.lines.join('\n')}\n\n${text.slice(idx)}`;
  writeFileSync(target, updated, 'utf8');
  proposal.applied = true;
  proposal.applied_to = proposal.patch.document;
  console.log(`\ncognition:ingest — appended ${proposal.patch.lines.length} line(s) to ${proposal.patch.document}`);
  console.log('  Protected documents were not touched.');
} else if (proposal.patch) {
  console.log(`\ncognition:ingest — a patch is PROPOSED, not applied.`);
  console.log(`  target: ${proposal.patch.document}`);
  for (const l of proposal.patch.lines) console.log(`    ${l}`);
  console.log('  Re-run with --apply to write it.');
} else {
  console.log(`\ncognition:ingest — no patch proposed. ${proposal.note}`);
}

writeFileSync(`${base}.json`, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
writeFileSync(`${base}.md`, proposalToMarkdown(proposal), 'utf8');
console.log(`  report: ${base}.md`);
