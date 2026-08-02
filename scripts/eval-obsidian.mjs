// ---------------------------------------------------------------------------
// eval-obsidian.mjs — Runner OB: the Obsidian bridge.
//
// Pure and deterministic. The planner takes file contents as plain objects, so
// every conflict shape can be constructed in memory — no vault on disk.
//
// The assertions that matter are the ones about not losing work: an unknown file
// is never touched, a vault edit is never overwritten, and "both sides changed"
// stops rather than choosing. A projection tool that guesses is a projection
// tool that eventually deletes somebody's notes.
//
// Usage: node scripts/eval-obsidian.mjs
// ---------------------------------------------------------------------------

import {
  PROJECTIONS, GENERATED_PAGES, VAULT_FOLDERS, VAULT_SUBDIR, SYNC_STATES,
  hashContent, targetPath, newManifest, classifyEntry, planSync,
  manifestEntries, findUntracked, generateNavigationPages, MANIFEST_SCHEMA_VERSION,
} from './lib/cognition/obsidian.mjs';

let passed = 0; let failed = 0;
const check = (c, l) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}`); c ? passed++ : failed++; };
const section = (s) => console.log(`--- ${s} ---`);

const AT = '2026-08-02T04:00:00.000Z';
const ID = 'context/AWE_IDENTITY.md';
const IDT = `${VAULT_SUBDIR}/Core/AWE_IDENTITY.md`;

const manifestWith = (entries = []) => ({ ...newManifest({ generatedAt: AT, vaultPath: '/v', repositoryCommit: 'abc' }), entries });

const entry = (sourceText, vaultText) => ({
  source_path: ID, target_path: IDT,
  source_hash: hashContent(sourceText), target_hash: hashContent(vaultText),
  last_synced_at: AT, last_state: 'IN_SYNC',
});

// ===========================================================================
section('1. shape');
{
  check(PROJECTIONS.length === 10, 'all ten cognition documents are projected');
  check(VAULT_FOLDERS.length === 6, 'six vault folders are defined');
  check(GENERATED_PAGES.length === 8, 'eight navigation pages are generated');
  check(SYNC_STATES.length === 7, 'seven sync states are defined');
  check(targetPath({ source: ID, folder: 'Core' }) === IDT, 'a projection maps to its vault path');
  check(newManifest({ generatedAt: AT, vaultPath: '/v', repositoryCommit: 'x' }).canonical_source === 'git',
    'the manifest states that git is canonical');
  check(/never the source of truth/.test(newManifest({ generatedAt: AT, vaultPath: '/v', repositoryCommit: 'x' }).note),
    'and says so in words a human will read');
  let threw = false;
  try { newManifest({}); } catch { threw = true; }
  check(threw, 'a manifest refuses to exist without a timestamp');
  check(newManifest({ generatedAt: AT, vaultPath: '/v', repositoryCommit: 'x' }).schema_version === MANIFEST_SCHEMA_VERSION,
    'the manifest carries its schema version');
}

section('2. change classification');
{
  check(classifyEntry(entry('a', 'a'), 'a', 'a') === 'IN_SYNC', 'identical content is in sync');
  check(classifyEntry(entry('a', 'a'), 'b', 'a') === 'SOURCE_CHANGED', 'a changed canonical file is SOURCE_CHANGED');
  check(classifyEntry(entry('a', 'a'), 'a', 'b') === 'VAULT_CHANGED', 'a changed vault file is VAULT_CHANGED');
  check(classifyEntry(entry('a', 'a'), 'b', 'c') === 'BOTH_CHANGED', 'both changed is BOTH_CHANGED');
  check(classifyEntry(entry('a', 'a'), 'a', null) === 'MISSING_IN_VAULT', 'an absent vault copy is MISSING_IN_VAULT');
  check(classifyEntry(entry('a', 'a'), null, 'a') === 'MISSING_SOURCE', 'an absent canonical file is MISSING_SOURCE');
  check(classifyEntry(null, 'a', 'b') === 'BOTH_CHANGED',
    'differing content with no sync record is BOTH_CHANGED — with no history we must not guess who changed what');
  check(classifyEntry(null, 'a', 'a') === 'IN_SYNC', 'identical content with no record is still in sync');
}

section('3. the planner never overwrites a vault edit');
{
  const files = { source: { [ID]: 'canonical v2' }, vault: { [IDT]: 'human edited' } };
  const { plan, conflicts } = planSync(manifestWith([entry('canonical v2', 'canonical v2')]), files);
  const item = plan.find((p) => p.source_path === ID);
  check(item.state === 'VAULT_CHANGED', 'a vault-side edit is detected');
  check(item.action === 'conflict', 'and produces a conflict, not a copy');
  check(conflicts.length === 1, 'the conflict is reported');
  check(/by hand/.test(conflicts[0].detail), 'the conflict tells the human what to do');
  check(!plan.some((p) => p.source_path === ID && p.action === 'copy'), 'no copy action targets the edited file');
}

section('4. both-changed stops rather than choosing');
{
  const files = { source: { [ID]: 'git v2' }, vault: { [IDT]: 'vault v2' } };
  const { plan, conflicts } = planSync(manifestWith([entry('git v1', 'git v1')]), files);
  const item = plan.find((p) => p.source_path === ID);
  check(item.state === 'BOTH_CHANGED', 'both-sides change is detected');
  check(item.action === 'conflict', 'and refuses');
  check(/needs a human diff/.test(conflicts[0].detail), 'the conflict says a human must diff it');
  check(/nothing will be overwritten/.test(conflicts[0].detail), 'and promises nothing was destroyed');
}

section('5. canonical changes do project');
{
  const files = { source: { [ID]: 'git v2' }, vault: { [IDT]: 'git v1' } };
  const { plan, conflicts } = planSync(manifestWith([entry('git v1', 'git v1')]), files);
  const item = plan.find((p) => p.source_path === ID);
  check(item.state === 'SOURCE_CHANGED' && item.action === 'copy', 'a canonical-only change is copied out');
  check(conflicts.length === 0, 'and is not a conflict');
  const first = planSync(manifestWith([]), { source: { [ID]: 'x' }, vault: {} });
  check(first.plan.find((p) => p.source_path === ID).action === 'copy', 'a first sync copies everything out');
}

section('6. one-way only — there is no reverse-copy action');
{
  const files = { source: { [ID]: 'git' }, vault: { [IDT]: 'vault' } };
  const { plan } = planSync(manifestWith([entry('git', 'git')]), files);
  const actions = new Set(plan.map((p) => p.action));
  check(!actions.has('reverse-copy') && !actions.has('pull'),
    'the planner has no action that writes the vault back into git — that is a human review step');
  check([...actions].every((a) => ['copy', 'skip', 'conflict'].includes(a)), 'only copy, skip and conflict exist');
}

section('7. unknown vault content is never touched');
{
  const vault = {
    [IDT]: 'x',
    [`${VAULT_SUBDIR}/my-scratch.md`]: 'personal',
    [`${VAULT_SUBDIR}/Core/my-own-note.md`]: 'personal',
    'Personal/notes.md': 'entirely outside AWE',
  };
  const untracked = findUntracked(vault);
  check(untracked.includes(`${VAULT_SUBDIR}/my-scratch.md`), 'an unknown file inside AWE/ is reported');
  check(untracked.includes(`${VAULT_SUBDIR}/Core/my-own-note.md`), 'even inside a projected folder');
  check(!untracked.includes('Personal/notes.md'), 'files outside AWE/ are not even considered — the bridge owns one subdirectory');
  check(!untracked.includes(IDT), 'a projected file is not "unknown"');
  check(!untracked.includes(`${VAULT_SUBDIR}/README.md`), 'the provenance note is recognized as ours');
  const { plan } = planSync(manifestWith([]), { source: { [ID]: 'x' }, vault });
  check(!plan.some((p) => p.target_path.includes('my-scratch')), 'no plan item ever targets an unknown file');
}

section('8. manifest tracking');
{
  const files = { source: { [ID]: 'v2' }, vault: { [IDT]: 'v2' } };
  const { plan } = planSync(manifestWith([entry('v1', 'v1')]), files);
  const entries = manifestEntries(plan, files, { syncedAt: AT });
  const e = entries.find((x) => x.source_path === ID);
  check(e.source_hash === hashContent('v2'), 'the source hash is recorded');
  check(e.target_hash === hashContent('v2'), 'the target hash is recorded');
  check(e.last_synced_at === AT, 'the sync time is recorded');
  check(e.source_path && e.target_path, 'both paths are recorded');
  check(entries.length === PROJECTIONS.length, 'every projection gets an entry');
  const conflicted = manifestEntries(
    planSync(manifestWith([entry('a', 'a')]), { source: { [ID]: 'a' }, vault: { [IDT]: 'edited' } }).plan,
    { source: { [ID]: 'a' }, vault: { [IDT]: 'edited' } }, { syncedAt: AT },
  ).find((x) => x.source_path === ID);
  check(conflicted.last_synced_at === null, 'a conflicted file records no successful sync time');
}

section('9. generated navigation pages');
{
  const pages = generateNavigationPages({
    commit: 'abc1234def', branch: 'feat/x', generatedAt: AT,
    dispatchTasks: [{ task_id: 'AWE-INT-101', status: 'READY', priority: 'P0', requested_role: 'Integrator', objective: 'do a thing' }],
    evidenceSummary: { packages: 8, migrations: 16, migration_collisions: 0, suites: 45, documents: 73 },
    conflicts: [{ kind: 'status_disagreement', subject: 'migration 0016', detail: 'both VERIFIED and REPORTED_NOT_VERIFIED' }],
  });
  for (const g of GENERATED_PAGES) check(!!pages[g], `${g} is generated`);
  check(Object.values(pages).every((t) => t.startsWith('---\nawe_generated: true')),
    'every generated page declares itself generated in front matter');
  check(Object.values(pages).every((t) => /awe_canonical_source: git/.test(t)),
    'and names git as canonical');
  check(pages['Dispatch Queue.md'].includes('AWE-INT-101'), 'the dispatch view lists real tasks');
  check(pages['Evidence Dashboard.md'].includes('migration 0016'), 'the evidence view surfaces cognition conflicts');
  check(pages['Current State Dashboard.md'].includes('pointer, not a copy'),
    'the dashboard explains why it does not duplicate the state');
  check(pages['AWE Home.md'].includes('the repository is right'),
    'the home page states the asymmetry a cold reader needs to know first');
  check(pages['AWE Home.md'].includes('[[AWE_IDENTITY]]'), 'wiki-links are preserved for Obsidian navigation');

  const empty = generateNavigationPages({ commit: 'a', branch: 'b', generatedAt: AT });
  check(empty['Dispatch Queue.md'].includes('No tasks'), 'an empty queue says so rather than rendering an empty table');
  check(empty['Current State Dashboard.md'].includes('No evidence snapshot'),
    'a missing evidence snapshot is stated, not silently omitted');
}

section('Runner OB gates');
{
  // Non-vacuity: the planner must be able to do nothing, and to refuse.
  const same = planSync(manifestWith([entry('a', 'a')]), { source: { [ID]: 'a' }, vault: { [IDT]: 'a' } });
  check(same.conflicts.length === 0 && !same.plan.some((p) => p.action === 'copy' && p.source_path === ID),
    'an unchanged file produces neither a copy nor a conflict');
  const missing = planSync(manifestWith([]), { source: {}, vault: {} });
  check(missing.plan.every((p) => p.state === 'MISSING_SOURCE'),
    'when no canonical file exists, nothing is invented');
}

console.log(`\neval-obsidian (Runner OB, pure, deterministic): passed=${passed} failed=${failed}`);
console.log(failed === 0 ? 'Runner OB: PASS' : 'Runner OB: FAIL');
process.exit(failed === 0 ? 0 : 1);
