// ---------------------------------------------------------------------------
// obsidian.mjs — projecting the canonical cognition layer into a vault.
//
// Git is the source of truth. Obsidian is an editing surface. Everything here
// exists to keep that asymmetry true while still letting a human edit in the
// tool they actually like.
//
// WHY A MANIFEST AND NOT SYMLINKS
// Directory junctions and symlinks were the obvious first choice and are the
// wrong one here. On Windows, symlink creation needs Developer Mode or elevation,
// so `init` would fail for some users and silently succeed for others — the
// worst possible split. Junctions work without elevation but only for
// directories, and pointing a junction at `context/` would put a live git
// working tree inside a vault that Obsidian writes to freely: an editor crash or
// a plugin doing housekeeping could then dirty or delete tracked files. A
// manifest with content hashes costs one copy step and cannot corrupt the repo.
//
// THE CONFLICT RULE
// When both sides changed, this reports and refuses. It never picks. Choosing
// the Git copy silently would discard a person's writing; choosing the vault
// copy silently would let an editor overwrite reviewed, committed truth. Both
// are worse than stopping.
//
// PURE: takes file state in, returns a plan. The CLI does the I/O.
// ---------------------------------------------------------------------------

import { digest } from '../../../packages/awe-kernel/src/canonical.mjs';

export const MANIFEST_SCHEMA_VERSION = '1.0.0';
export const VAULT_SUBDIR = 'AWE';

export const VAULT_FOLDERS = ['Core', 'Evidence', 'Dispatch', 'Handoffs', 'Decisions', 'Capabilities'];

// Which canonical document goes where in the vault.
export const PROJECTIONS = [
  { source: 'context/AWE_IDENTITY.md', folder: 'Core' },
  { source: 'context/AWE_CURRENT_STATE.md', folder: 'Core' },
  { source: 'context/AWE_SYSTEM_MAP.md', folder: 'Core' },
  { source: 'context/AWE_UBIQUITOUS_LANGUAGE.md', folder: 'Core' },
  { source: 'context/AGENT_OPERATING_POLICIES.md', folder: 'Core' },
  { source: 'context/VERIFIED_EVIDENCE.md', folder: 'Evidence' },
  { source: 'context/CRITICAL_DECISIONS.md', folder: 'Decisions' },
  { source: 'context/LATEST_AGENT_HANDOFF.md', folder: 'Handoffs' },
  { source: 'context/AGENT_EXECUTION_PACKET.md', folder: 'Dispatch' },
  { source: 'context/ACTIVE_CAPABILITY_SPECIFICATION.md', folder: 'Capabilities' },
];

// Generated navigation pages. Kept in their own folder and marked in their own
// front matter so a reader never mistakes a generated index for source material.
export const GENERATED_PAGES = [
  'AWE Home.md',
  'Current State Dashboard.md',
  'System Map Index.md',
  'Critical Decisions Index.md',
  'Evidence Dashboard.md',
  'Dispatch Queue.md',
  'Latest Agent Handoff.md',
  'Capability Index.md',
];

export const SYNC_STATES = ['IN_SYNC', 'SOURCE_CHANGED', 'VAULT_CHANGED', 'BOTH_CHANGED', 'MISSING_IN_VAULT', 'MISSING_SOURCE', 'UNTRACKED_IN_VAULT'];

export function hashContent(text) {
  return digest({ body: text ?? '' });
}

export function targetPath(projection) {
  const name = projection.source.split('/').pop();
  return `${VAULT_SUBDIR}/${projection.folder}/${name}`;
}

export function newManifest({ generatedAt, vaultPath, repositoryCommit }) {
  if (!generatedAt) throw new Error('a manifest needs an explicit timestamp');
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    generated_at: generatedAt,
    vault_path: vaultPath,
    repository_commit: repositoryCommit,
    canonical_source: 'git',
    note: 'The Git-backed context/ directory is canonical. This vault is a projection and an editing surface. It is never the source of truth.',
    entries: [],
  };
}

/**
 * Compare one projection against the vault.
 *
 * @param entry     previous manifest entry, or null on first sync
 * @param sourceText current canonical content (null if the source is gone)
 * @param vaultText  current vault content (null if absent)
 */
export function classifyEntry(entry, sourceText, vaultText) {
  if (sourceText === null) return 'MISSING_SOURCE';
  if (vaultText === null) return 'MISSING_IN_VAULT';

  const sourceHash = hashContent(sourceText);
  const vaultHash = hashContent(vaultText);
  if (sourceHash === vaultHash) return 'IN_SYNC';

  if (!entry) {
    // No record of a previous sync, and the two differ. We cannot tell who
    // changed what, so we must not guess.
    return 'BOTH_CHANGED';
  }
  const sourceMoved = entry.source_hash !== sourceHash;
  const vaultMoved = entry.target_hash !== vaultHash;
  if (sourceMoved && vaultMoved) return 'BOTH_CHANGED';
  if (sourceMoved) return 'SOURCE_CHANGED';
  if (vaultMoved) return 'VAULT_CHANGED';
  return 'IN_SYNC';
}

/**
 * Build the sync plan. Actions are: 'copy' (git → vault), 'skip', 'conflict'.
 * There is deliberately NO 'reverse-copy' action — pulling vault edits back into
 * Git is a human review step, not something a sync command does at 2am.
 */
export function planSync(manifest, files) {
  const plan = [];
  const conflicts = [];
  for (const p of PROJECTIONS) {
    const target = targetPath(p);
    const prev = (manifest.entries || []).find((e) => e.source_path === p.source) || null;
    const sourceText = files.source[p.source] ?? null;
    const vaultText = files.vault[target] ?? null;
    const state = classifyEntry(prev, sourceText, vaultText);

    let action = 'skip';
    if (state === 'MISSING_IN_VAULT' || state === 'SOURCE_CHANGED') action = 'copy';
    else if (state === 'BOTH_CHANGED' || state === 'VAULT_CHANGED') action = 'conflict';
    else if (state === 'MISSING_SOURCE') action = 'skip';

    if (action === 'conflict') {
      conflicts.push({
        source_path: p.source,
        target_path: target,
        state,
        detail: state === 'VAULT_CHANGED'
          ? 'the vault copy was edited and the canonical file was not — bring the edit back into git by hand, then re-sync'
          : 'both copies changed since the last sync — this needs a human diff; nothing will be overwritten',
      });
    }

    plan.push({ source_path: p.source, target_path: target, state, action });
  }
  return { plan, conflicts };
}

/** Entries for the manifest after a successful sync. */
export function manifestEntries(plan, files, { syncedAt }) {
  return plan.map((item) => {
    const sourceText = files.source[item.source_path] ?? null;
    const vaultText = item.action === 'copy' ? sourceText : (files.vault[item.target_path] ?? null);
    return {
      source_path: item.source_path,
      target_path: item.target_path,
      source_hash: sourceText === null ? null : hashContent(sourceText),
      target_hash: vaultText === null ? null : hashContent(vaultText),
      last_synced_at: item.action === 'copy' ? syncedAt : (item.state === 'IN_SYNC' ? syncedAt : null),
      last_state: item.state,
    };
  });
}

/**
 * Which vault files under AWE/ are not ours? These must never be touched.
 * A projection tool that deletes what it does not recognize is a projection tool
 * that eventually deletes somebody's notes.
 */
export function findUntracked(vaultFiles) {
  const known = new Set([
    ...PROJECTIONS.map(targetPath),
    ...GENERATED_PAGES.map((g) => `${VAULT_SUBDIR}/${g}`),
    `${VAULT_SUBDIR}/README.md`, // the provenance note written by init
  ]);
  return Object.keys(vaultFiles)
    .filter((p) => p.startsWith(`${VAULT_SUBDIR}/`))
    .filter((p) => !known.has(p));
}

const FRONT_MATTER = [
  '---',
  'awe_generated: true',
  'awe_canonical_source: git',
  'awe_note: Generated navigation page. Edits here are NOT synced back to Git and will be overwritten.',
  '---',
  '',
].join('\n');

/** Generated navigation pages. They link to projections; they never restate facts. */
export function generateNavigationPages(ctx) {
  const { commit, branch, generatedAt, dispatchTasks = [], evidenceSummary = null, conflicts = [] } = ctx;
  const link = (p) => `[[${p.split('/').pop().replace(/\.md$/, '')}]]`;
  const pages = {};

  pages['AWE Home.md'] = `${FRONT_MATTER}# AWE

**Branch:** \`${branch}\` · **Commit:** \`${String(commit).slice(0, 7)}\` · **Projected:** ${generatedAt}

> The Git-backed \`context/\` directory is canonical. This vault is a projection and an
> editing surface. If a note here disagrees with the repository, the repository is right.

## Core
${PROJECTIONS.filter((p) => p.folder === 'Core').map((p) => `- ${link(p.source)}`).join('\n')}

## Everything else
- ${link('context/VERIFIED_EVIDENCE.md')} — the evidence ledger
- ${link('context/CRITICAL_DECISIONS.md')} — decisions and their status
- ${link('context/LATEST_AGENT_HANDOFF.md')} — where the last session left off
- ${link('context/ACTIVE_CAPABILITY_SPECIFICATION.md')} — what is being worked on now

## Generated views
${GENERATED_PAGES.filter((g) => g !== 'AWE Home.md').map((g) => `- [[${g.replace(/\.md$/, '')}]]`).join('\n')}
`;

  pages['Current State Dashboard.md'] = `${FRONT_MATTER}# Current State Dashboard

**Projected:** ${generatedAt} · **Branch:** \`${branch}\` @ \`${String(commit).slice(0, 7)}\`

The authoritative text is ${link('context/AWE_CURRENT_STATE.md')}. This page is a pointer, not a copy —
duplicating the state here would create a second version of it that goes stale silently.

${evidenceSummary ? `## Latest evidence collection\n\n- packages: ${evidenceSummary.packages}\n- migrations: ${evidenceSummary.migrations} (${evidenceSummary.migration_collisions} collision)\n- suites: ${evidenceSummary.suites}\n- documents: ${evidenceSummary.documents}\n` : '_No evidence snapshot has been collected yet. Run `npm run evidence:collect`._'}
`;

  pages['System Map Index.md'] = `${FRONT_MATTER}# System Map Index

See ${link('context/AWE_SYSTEM_MAP.md')} for the diagrams and the package graph.
`;

  pages['Critical Decisions Index.md'] = `${FRONT_MATTER}# Critical Decisions Index

See ${link('context/CRITICAL_DECISIONS.md')}.

Decisions live in \`docs/architecture/decisions/\` in the repository. The index there is the
authority on status; this page exists so the vault has a way in.
`;

  pages['Evidence Dashboard.md'] = `${FRONT_MATTER}# Evidence Dashboard

See ${link('context/VERIFIED_EVIDENCE.md')} for the ledger.

${conflicts.length ? `## Cognition conflicts (${conflicts.length})\n\n${conflicts.map((c) => `- **${c.kind}** — ${c.subject}: ${c.detail}`).join('\n')}` : '_No cognition conflicts detected at the last index._'}
`;

  pages['Dispatch Queue.md'] = `${FRONT_MATTER}# Dispatch Queue

**Projected:** ${generatedAt}

${dispatchTasks.length
    ? `| Task | Status | Priority | Role | Objective |\n|---|---|---|---|---|\n${dispatchTasks.map((t) => `| ${t.task_id} | \`${t.status}\` | ${t.priority} | ${t.requested_role} | ${t.objective} |`).join('\n')}`
    : '_No tasks in the local dispatch queue._'}

Tasks are managed with \`npm run dispatch:*\`. Editing this page does nothing — it is a view.
`;

  pages['Latest Agent Handoff.md'] = `${FRONT_MATTER}# Latest Agent Handoff

See ${link('context/LATEST_AGENT_HANDOFF.md')}.
`;

  pages['Capability Index.md'] = `${FRONT_MATTER}# Capability Index

Active work: ${link('context/ACTIVE_CAPABILITY_SPECIFICATION.md')}

Capabilities are recorded in ${link('context/AWE_CURRENT_STATE.md')} with an evidence status.
A capability with no test behind it is not a capability; it is an intention.
`;

  return pages;
}
