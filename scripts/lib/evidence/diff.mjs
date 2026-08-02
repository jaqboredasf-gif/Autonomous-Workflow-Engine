// ---------------------------------------------------------------------------
// diff.mjs — compare two evidence snapshots.
//
// This is what lets an agent open a session with "here is what changed since
// anyone last looked" instead of re-deriving the world. It is also the honest
// answer to a question the cognition layer cannot answer on its own: a document
// says what someone believed; a diff of two collections says what moved.
//
// PURE: takes two snapshot objects, returns findings. No I/O.
// ---------------------------------------------------------------------------

const setOf = (xs) => new Set(xs || []);
const added = (before, after) => [...setOf(after)].filter((x) => !setOf(before).has(x));
const removed = (before, after) => [...setOf(before)].filter((x) => !setOf(after).has(x));

function change(kind, message, detail = null) {
  return { kind, message, detail };
}

/**
 * @param a older snapshot { git, packages, migrations, tests, documentation, security }
 * @param b newer snapshot
 */
export function diffSnapshots(a, b) {
  const changes = [];
  const g1 = a.git || {}; const g2 = b.git || {};

  // --- git -----------------------------------------------------------------
  if (g1.branch !== g2.branch) changes.push(change('branch_changed', `branch ${g1.branch} → ${g2.branch}`, { from: g1.branch, to: g2.branch }));
  if (g1.commit !== g2.commit) changes.push(change('commit_changed', `commit ${String(g1.commit).slice(0, 7)} → ${String(g2.commit).slice(0, 7)}`, { from: g1.commit, to: g2.commit }));

  const dirty1 = (g1.status?.dirty?.length || 0) + (g1.status?.staged?.length || 0);
  const dirty2 = (g2.status?.dirty?.length || 0) + (g2.status?.staged?.length || 0);
  if (dirty1 !== dirty2) changes.push(change('dirty_state_changed', `uncommitted files ${dirty1} → ${dirty2}`, { from: dirty1, to: dirty2 }));

  for (const br of added(g1.branches_without_upstream, g2.branches_without_upstream)) {
    changes.push(change('new_unpushed_branch', `"${br}" now exists locally with no upstream`, { branch: br }));
  }

  // --- packages ------------------------------------------------------------
  const p1 = (a.packages?.packages || []).map((p) => p.dir);
  const p2 = (b.packages?.packages || []).map((p) => p.dir);
  for (const p of added(p1, p2)) changes.push(change('package_added', `new workspace package: ${p}`, { package: p }));
  for (const p of removed(p1, p2)) changes.push(change('package_removed', `workspace package removed: ${p}`, { package: p }));

  const edges = (snap) => (snap.packages?.dependency_graph || [])
    .flatMap((e) => (e.to || []).map((t) => `${e.from}→${t}`));
  for (const e of added(edges(a), edges(b))) changes.push(change('dependency_edge_added', `new internal dependency ${e}`, { edge: e }));

  // --- migrations ----------------------------------------------------------
  const m1 = (a.migrations?.migrations || []).map((m) => m.file);
  const m2 = (b.migrations?.migrations || []).map((m) => m.file);
  for (const m of added(m1, m2)) changes.push(change('migration_added', `new migration: ${m}`, { migration: m }));
  for (const m of removed(m1, m2)) changes.push(change('migration_removed', `migration removed: ${m}`, { migration: m }));

  const c1 = (a.migrations?.collisions || []).map((c) => c.identifier);
  const c2 = (b.migrations?.collisions || []).map((c) => c.identifier);
  for (const c of added(c1, c2)) {
    changes.push(change('migration_collision_added', `identifier ${c} is now claimed by more than one migration`, { identifier: c }));
  }
  for (const c of removed(c1, c2)) {
    changes.push(change('migration_collision_resolved', `identifier ${c} no longer collides`, { identifier: c }));
  }

  // --- tests ---------------------------------------------------------------
  const t1 = (a.tests?.suites || []).map((s) => s.path);
  const t2 = (b.tests?.suites || []).map((s) => s.path);
  for (const t of added(t1, t2)) changes.push(change('test_added', `new suite: ${t}`, { suite: t }));
  for (const t of removed(t1, t2)) changes.push(change('test_removed', `suite removed: ${t}`, { suite: t }));

  const r1 = setOf(a.tests?.runners); const r2 = setOf(b.tests?.runners);
  const runnerDelta = [...r2].filter((x) => !r1.has(x));
  if (runnerDelta.length) changes.push(change('runner_set_changed', `new runner(s): ${runnerDelta.join(', ')}`, { runners: runnerDelta }));

  // --- documentation -------------------------------------------------------
  const d1 = (a.documentation?.documents || []).map((d) => d.path);
  const d2 = (b.documentation?.documents || []).map((d) => d.path);
  for (const d of added(d1, d2)) changes.push(change('document_added', `new document: ${d}`, { document: d }));
  for (const d of removed(d1, d2)) changes.push(change('document_removed', `document removed: ${d}`, { document: d }));

  const status = (snap) => Object.fromEntries((snap.documentation?.adrs || []).map((x) => [x.path, x.status]));
  const s1 = status(a); const s2 = status(b);
  for (const [p, st] of Object.entries(s2)) {
    if (s1[p] && s1[p] !== st) changes.push(change('decision_status_changed', `${p}: "${s1[p]}" → "${st}"`, { path: p, from: s1[p], to: st }));
  }

  const br1 = (a.documentation?.broken_references || []).map((x) => `${x.from}→${x.missing}`);
  const br2 = (b.documentation?.broken_references || []).map((x) => `${x.from}→${x.missing}`);
  for (const x of added(br1, br2)) changes.push(change('broken_reference_added', `new broken reference ${x}`, { reference: x }));
  for (const x of removed(br1, br2)) changes.push(change('reference_repaired', `reference now resolves: ${x}`, { reference: x }));

  // --- security ------------------------------------------------------------
  const sf1 = (a.security?.sensitive_files || []).map((f) => f.path);
  const sf2 = (b.security?.sensitive_files || []).map((f) => f.path);
  for (const f of added(sf1, sf2)) changes.push(change('sensitive_file_added', `new file with a sensitive-looking name: ${f}`, { path: f }));

  const sc1 = (a.security?.secret_scan?.findings || []).map((f) => `${f.path}:${f.pattern}`);
  const sc2 = (b.security?.secret_scan?.findings || []).map((f) => `${f.path}:${f.pattern}`);
  for (const f of added(sc1, sc2)) changes.push(change('secret_finding_added', `new secret-shaped finding in ${f.split(':')[0]}`, { finding: f }));

  // --- claims whose evidence disappeared -----------------------------------
  const u1 = (a.tests?.unreproducible_claims || []).map((c) => `${c.source}:${c.runner}`);
  const u2 = (b.tests?.unreproducible_claims || []).map((c) => `${c.source}:${c.runner}`);
  for (const c of added(u1, u2)) changes.push(change('claim_lost_evidence', `a cognition claim no longer has a reproducing suite: ${c}`, { claim: c }));
  for (const c of removed(u1, u2)) changes.push(change('claim_gained_evidence', `a previously unreproducible claim now has a suite: ${c}`, { claim: c }));

  return changes;
}

export function summarizeDiff(changes) {
  const by = {};
  for (const c of changes) by[c.kind] = (by[c.kind] || 0) + 1;
  return { total: changes.length, by_kind: by };
}

export function diffToMarkdown(a, b, changes) {
  const L = [];
  L.push('# Evidence Diff');
  L.push('');
  L.push(`**From:** \`${a.meta?.generated_at || 'unknown'}\` @ commit \`${String(a.git?.commit || '').slice(0, 7)}\` (${a.git?.branch || '?'})`);
  L.push(`**To:**   \`${b.meta?.generated_at || 'unknown'}\` @ commit \`${String(b.git?.commit || '').slice(0, 7)}\` (${b.git?.branch || '?'})`);
  L.push('');
  if (!changes.length) {
    L.push('No differences detected between these two snapshots.');
    L.push('');
    return L.join('\n');
  }
  const s = summarizeDiff(changes);
  L.push(`**${s.total} change(s).**`);
  L.push('');
  const grouped = {};
  for (const c of changes) (grouped[c.kind] = grouped[c.kind] || []).push(c);
  for (const kind of Object.keys(grouped).sort()) {
    L.push(`## ${kind} (${grouped[kind].length})`);
    L.push('');
    for (const c of grouped[kind]) L.push(`- ${c.message}`);
    L.push('');
  }
  return L.join('\n');
}
