// ---------------------------------------------------------------------------
// cognition-obsidian.mjs — project the canonical cognition layer into a vault.
//
//   npm run cognition:obsidian:init   -- --vault "C:\AWE\vault"
//   npm run cognition:obsidian:status -- --vault "C:\AWE\vault"
//   npm run cognition:obsidian:sync   -- --vault "C:\AWE\vault"
//
// Git is canonical. This writes ONE subdirectory — AWE/ — inside the vault and
// touches nothing else. It never deletes, never overwrites a file it does not
// recognize, and refuses rather than choosing when both copies changed.
//
// It also never pulls vault edits back into Git. Bringing a human's writing into
// the repository is a review step with a commit attached, not something a sync
// command does unattended.
//
// OFFLINE. The only writes are inside <vault>/AWE/.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

import {
  PROJECTIONS, GENERATED_PAGES, VAULT_FOLDERS, VAULT_SUBDIR,
  targetPath, newManifest, planSync, manifestEntries, findUntracked, generateNavigationPages,
} from './lib/cognition/obsidian.mjs';
import { listTasks } from './lib/dispatch/store.mjs';

const root = process.cwd();
const argv = process.argv.slice(2);
const mode = argv[0];
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const git = (a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

const vault = arg('--vault');
if (!vault) { console.error('usage: cognition:obsidian:<init|status|sync> -- --vault "<path>"'); process.exit(1); }

const vaultAbs = resolve(vault);
const aweDir = join(vaultAbs, VAULT_SUBDIR);
const manifestPath = join(aweDir, '.awe-sync-manifest.json');
const posix = (p) => p.split(sep).join('/');

function readVaultFiles() {
  const out = {};
  if (!existsSync(aweDir)) return out;
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const abs = join(dir, f);
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      if (!f.endsWith('.md')) continue;
      out[posix(relative(vaultAbs, abs))] = readFileSync(abs, 'utf8');
    }
  };
  walk(aweDir);
  return out;
}

function readSourceFiles() {
  const out = {};
  for (const p of PROJECTIONS) {
    const abs = join(root, p.source);
    out[p.source] = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  }
  return out;
}

function loadManifest() {
  if (!existsSync(manifestPath)) return null;
  try { return JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return null; }
}

const commit = git(['rev-parse', 'HEAD']);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------

function cmdInit() {
  const vaultExisted = existsSync(vaultAbs);
  if (!vaultExisted) {
    mkdirSync(vaultAbs, { recursive: true });
    console.log(`cognition:obsidian:init — created vault directory ${vaultAbs}`);
  } else {
    console.log(`cognition:obsidian:init — vault exists at ${vaultAbs}`);
    const top = readdirSync(vaultAbs).filter((f) => f !== VAULT_SUBDIR);
    if (top.length) {
      console.log(`  ${top.length} existing item(s) at the vault root will not be touched: ${top.slice(0, 8).join(', ')}${top.length > 8 ? ' …' : ''}`);
    }
  }
  mkdirSync(aweDir, { recursive: true });
  for (const f of VAULT_FOLDERS) mkdirSync(join(aweDir, f), { recursive: true });

  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${JSON.stringify(newManifest({ generatedAt: now(), vaultPath: vaultAbs, repositoryCommit: commit }), null, 2)}\n`, 'utf8');
  }

  // The provenance note is written once and is itself a projection artifact: a
  // reader who opens the vault cold must learn immediately that it is not the
  // source of truth, and that the historical Mac vault has not been imported.
  const readme = join(aweDir, 'README.md');
  if (!existsSync(readme)) {
    writeFileSync(readme, `---
awe_generated: true
awe_canonical_source: git
---
# AWE — projected cognition layer

**The Git-backed \`context/\` directory in the AWE repository is canonical.**
This folder is a projection and an editing surface. If a note here disagrees with the
repository, the repository is right.

- Projected from: \`${git(['remote', 'get-url', 'origin']) || 'unknown remote'}\`
- Branch: \`${branch}\` · Commit: \`${String(commit).slice(0, 7)}\`
- Initialized: ${now()}

## What this is not

This is a **new home-PC projection**, created on ${now().slice(0, 10)}.

**The historical MacBook Obsidian vault has NOT been imported.** Nothing in this folder was
recovered from it, and none of its content has been reconstructed or guessed. Importing it
is a separate task requiring a three-way reconciliation — original vault, canonical Git
files, and this projection — because the original may contain decisions that were never
written to the repository, and this projection must not silently overwrite them.

Until that import happens, treat this vault as complete with respect to Git and **empty with
respect to the original vault's history**.

## Rules

1. Files under \`Core/\`, \`Evidence/\`, \`Decisions/\`, \`Handoffs/\`, \`Dispatch/\` and
   \`Capabilities/\` are copies of canonical files. Edit them if you like — but your edit
   lives only here until a human brings it back into Git deliberately.
2. Sync never overwrites a vault edit. If both sides changed, it reports a conflict and
   stops.
3. Anything you create here that AWE did not put here is left alone, forever.
4. Generated navigation pages carry \`awe_generated: true\` and WILL be overwritten.
`, 'utf8');
  }

  console.log(`  created ${VAULT_SUBDIR}/ with ${VAULT_FOLDERS.length} folders`);
  console.log('  Git remains canonical. The historical MacBook vault has NOT been imported.');
  cmdSync();
}

function cmdStatus() {
  if (!existsSync(aweDir)) {
    console.log(`cognition:obsidian:status — no AWE projection at ${aweDir}`);
    console.log('  run cognition:obsidian:init first');
    process.exit(0);
  }
  const manifest = loadManifest() || newManifest({ generatedAt: now(), vaultPath: vaultAbs, repositoryCommit: commit });
  const files = { source: readSourceFiles(), vault: readVaultFiles() };
  const { plan, conflicts } = planSync(manifest, files);
  const untracked = findUntracked(files.vault);

  console.log(`cognition:obsidian:status — ${vaultAbs}`);
  console.log(`  canonical: git @ ${branch} ${String(commit).slice(0, 7)}`);
  console.log(`  manifest : ${manifest.generated_at || 'none'}`);
  const counts = plan.reduce((a, p) => { a[p.state] = (a[p.state] || 0) + 1; return a; }, {});
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(20)} ${v}`);
  if (conflicts.length) {
    console.log(`\n  CONFLICTS (${conflicts.length}) — nothing will be overwritten:`);
    for (const c of conflicts) console.log(`    ${c.target_path}: ${c.detail}`);
  }
  if (untracked.length) {
    console.log(`\n  ${untracked.length} file(s) in ${VAULT_SUBDIR}/ that AWE did not create — these are never touched:`);
    for (const u of untracked.slice(0, 10)) console.log(`    ${u}`);
  }
  return { plan, conflicts, untracked, manifest, files };
}

function cmdSync() {
  if (!existsSync(aweDir)) { console.error('cognition:obsidian:sync — no projection; run init first'); process.exit(1); }
  const manifest = loadManifest() || newManifest({ generatedAt: now(), vaultPath: vaultAbs, repositoryCommit: commit });
  const files = { source: readSourceFiles(), vault: readVaultFiles() };
  const { plan, conflicts } = planSync(manifest, files);

  let copied = 0;
  for (const item of plan) {
    if (item.action !== 'copy') continue;
    const abs = join(vaultAbs, item.target_path.split('/').join(sep));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, files.source[item.source_path], 'utf8');
    copied += 1;
  }

  // Navigation pages are always regenerated — they are views, and a stale view
  // of a dashboard is worse than none.
  const evidencePath = join(root, '.awe', 'evidence', 'latest', 'summary.json');
  const conflictsPath = join(root, '.awe', 'cognition', 'conflicts.json');
  const evidenceSummary = existsSync(evidencePath) ? (JSON.parse(readFileSync(evidencePath, 'utf8')).counts || null) : null;
  const cogConflicts = existsSync(conflictsPath) ? (JSON.parse(readFileSync(conflictsPath, 'utf8')).conflicts || []) : [];
  const pages = generateNavigationPages({
    commit, branch, generatedAt: now(), dispatchTasks: listTasks(root), evidenceSummary, conflicts: cogConflicts,
  });
  for (const [name, text] of Object.entries(pages)) {
    writeFileSync(join(aweDir, name), text, 'utf8');
  }

  const after = { source: files.source, vault: readVaultFiles() };
  const updated = {
    ...manifest,
    generated_at: now(),
    repository_commit: commit,
    vault_path: vaultAbs,
    entries: manifestEntries(plan, after, { syncedAt: now() }),
  };
  writeFileSync(manifestPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');

  console.log(`cognition:obsidian:sync — ${copied} file(s) projected, ${Object.keys(pages).length} navigation page(s) regenerated`);
  if (conflicts.length) {
    console.log(`  ${conflicts.length} CONFLICT(S) — left untouched, and not overwritten:`);
    for (const c of conflicts) console.log(`    ${c.target_path}: ${c.detail}`);
    console.log('  Resolve by hand. This tool will not choose between your edit and the repository.');
  }
  const untracked = findUntracked(after.vault);
  if (untracked.length) console.log(`  ${untracked.length} unknown file(s) in ${VAULT_SUBDIR}/ preserved untouched`);
  console.log(`  manifest: ${manifestPath}`);
}

const commands = { init: cmdInit, status: cmdStatus, sync: cmdSync };
if (!commands[mode]) { console.error(`usage: cognition:obsidian:<${Object.keys(commands).join('|')}> -- --vault "<path>"`); process.exit(1); }
commands[mode]();
