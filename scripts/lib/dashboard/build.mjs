// ---------------------------------------------------------------------------
// build.mjs — assemble the local operating dashboard.
//
// A static file, opened from disk. No server, no framework, no build step — the
// same reasoning the repository already applies to everything else: this project
// has no server to hang a dashboard on, and a speculative one rots.
//
// The dashboard's one real job is to distinguish states that look alike in prose.
// "Migrations: 16" tells a reader nothing about whether they were applied.
// So every tile carries a state — VERIFIED, REPORTED, MISSING, BLOCKED, STALE,
// CONFLICTING — and the colour follows the state rather than the number.
//
// PURE: takes already-loaded inputs, returns { html, data }. The CLI reads files.
// ---------------------------------------------------------------------------

export const STATES = ['VERIFIED', 'REPORTED', 'MISSING', 'BLOCKED', 'STALE', 'CONFLICTING'];

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function buildModel(inputs) {
  const { git = {}, evidence = null, cognition = null, dispatch = [], obsidian = null, handoff = null, generatedAt } = inputs;
  if (!generatedAt) throw new Error('the dashboard needs an explicit timestamp');

  const counts = evidence?.counts || {};
  const tasks = dispatch || [];
  const byStatus = tasks.reduce((a, t) => { a[t.status] = (a[t.status] || 0) + 1; return a; }, {});
  const conflicts = cognition?.conflicts?.conflicts || [];
  const freshness = cognition?.freshness?.counts || {};
  const warnings = evidence?.warnings || [];
  const wk = (k) => warnings.filter((w) => w.kind === k);

  const tiles = [
    {
      label: 'Repository',
      value: `${git.branch || '?'} @ ${String(git.commit || '').slice(0, 7)}`,
      state: git.clean ? 'VERIFIED' : 'STALE',
      note: git.clean ? 'working tree clean' : `${(git.dirty_files || []).length} uncommitted file(s)`,
    },
    {
      label: 'Migrations',
      value: String(counts.migrations ?? '—'),
      state: (counts.migration_collisions || 0) > 0 ? 'CONFLICTING' : 'REPORTED',
      note: (counts.migration_collisions || 0) > 0
        ? `${counts.migration_collisions} identifier collision(s)`
        : 'files present; applied state UNKNOWN — no database contacted',
    },
    {
      label: 'Test suites',
      value: String(counts.suites ?? '—'),
      state: 'VERIFIED',
      note: 'inventory from direct inspection',
    },
    {
      label: 'Cognition freshness',
      value: `${freshness.STALE || 0} stale`,
      state: (freshness.STALE || 0) > 0 ? 'STALE' : 'VERIFIED',
      note: Object.entries(freshness).map(([k, v]) => `${k} ${v}`).join(' · ') || 'not indexed',
    },
    {
      label: 'Cognition conflicts',
      value: String(conflicts.length),
      state: conflicts.length ? 'CONFLICTING' : 'VERIFIED',
      note: conflicts.length ? 'documents disagree — see below' : 'no disagreement detected',
    },
    {
      label: 'Dispatch queue',
      value: String(tasks.length),
      state: byStatus.BLOCKED ? 'BLOCKED' : byStatus.AWAITING_VERIFICATION ? 'REPORTED' : 'VERIFIED',
      note: Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(' · ') || 'empty',
    },
    {
      label: 'Obsidian projection',
      value: obsidian ? `${(obsidian.entries || []).length} files` : 'not initialized',
      state: obsidian ? 'VERIFIED' : 'MISSING',
      note: obsidian ? `synced ${String(obsidian.generated_at || '').slice(0, 19)} — git is canonical` : 'run cognition:obsidian:init',
    },
    {
      label: 'Public-repo exposure',
      value: String((counts.sensitive_files ?? 0)),
      state: wk('public_repository_exposure').length ? 'CONFLICTING' : (counts.sensitive_files ? 'REPORTED' : 'VERIFIED'),
      note: wk('public_repository_exposure').length
        ? 'PUBLIC repository with internal-looking files — needs a human decision'
        : 'filenames suggesting internal or personal material',
    },
  ];

  const missingExternal = [
    { name: 'Obsidian vault (MacBook original)', state: 'MISSING', note: 'never imported; requires three-way reconciliation' },
    { name: 'n8n workflow exports', state: 'MISSING', note: 'zero exports tracked in git; live-instance only' },
    { name: 'Supabase project identity', state: 'MISSING', note: 'applied-migration state therefore UNKNOWN' },
    { name: 'Orchestration & Responsibility Plane', state: 'MISSING', note: 'no package, branch or table anywhere' },
  ];

  const blocked = [
    { name: 'Docker daemon', state: 'BLOCKED', note: 'WSL2 installed, no distribution — blocks isolated migration replay' },
    { name: 'jq', state: 'BLOCKED', note: 'not installed — mcp-smoke fails' },
    { name: 'Credential-gated suites', state: 'BLOCKED', note: 'SUPABASE_ACCESS_TOKEN absent — 12 suites skipped' },
  ];

  return {
    generated_at: generatedAt,
    git,
    tiles,
    conflicts,
    tasks,
    warnings: warnings.map((w) => ({ kind: w.kind, message: w.message })),
    missing_external: missingExternal,
    blocked,
    handoff,
    obsidian,
  };
}

export function renderHtml(model) {
  const tile = (t) => `
      <div class="tile ${t.state.toLowerCase()}">
        <div class="tile-label">${esc(t.label)}</div>
        <div class="tile-value">${esc(t.value)}</div>
        <div class="tile-state">${esc(t.state)}</div>
        <div class="tile-note">${esc(t.note)}</div>
      </div>`;

  const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const badge = (s) => `<span class="badge ${String(s).toLowerCase()}">${esc(s)}</span>`;

  return `<!doctype html>
<meta charset="utf-8">
<title>AWE — Cognition and Dispatch</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --line: #262c36; --text: #e6edf3; --dim: #8b949e;
    --verified: #2ea043; --reported: #9e6a03; --missing: #6e7681; --blocked: #a371f7;
    --stale: #bb8009; --conflicting: #f85149;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#ffffff; --panel:#f6f8fa; --line:#d0d7de; --text:#1f2328; --dim:#656d76; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1.5rem 4rem; background:var(--bg); color:var(--text);
         font:14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  h1 { font-size:1.35rem; margin:0 0 .25rem; }
  h2 { font-size:1rem; margin:2.25rem 0 .75rem; color:var(--dim); text-transform:uppercase; letter-spacing:.08em; }
  .sub { color:var(--dim); margin-bottom:2rem; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:.75rem; }
  .tile { background:var(--panel); border:1px solid var(--line); border-left-width:4px; border-radius:6px; padding:.85rem 1rem; }
  .tile-label { color:var(--dim); font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; }
  .tile-value { font-size:1.5rem; margin:.3rem 0; }
  .tile-state { font-size:.7rem; letter-spacing:.08em; }
  .tile-note { color:var(--dim); font-size:.75rem; margin-top:.35rem; }
  .tile.verified{border-left-color:var(--verified)} .tile.verified .tile-state{color:var(--verified)}
  .tile.reported{border-left-color:var(--reported)} .tile.reported .tile-state{color:var(--reported)}
  .tile.missing{border-left-color:var(--missing)} .tile.missing .tile-state{color:var(--missing)}
  .tile.blocked{border-left-color:var(--blocked)} .tile.blocked .tile-state{color:var(--blocked)}
  .tile.stale{border-left-color:var(--stale)} .tile.stale .tile-state{color:var(--stale)}
  .tile.conflicting{border-left-color:var(--conflicting)} .tile.conflicting .tile-state{color:var(--conflicting)}
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:6px; overflow:hidden; }
  th,td { text-align:left; padding:.5rem .75rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
  tr:last-child td { border-bottom:none; }
  .badge { display:inline-block; padding:.1rem .45rem; border-radius:3px; font-size:.7rem; letter-spacing:.05em; }
  .badge.verified{background:var(--verified);color:#fff} .badge.reported{background:var(--reported);color:#fff}
  .badge.missing{background:var(--missing);color:#fff} .badge.blocked{background:var(--blocked);color:#fff}
  .badge.stale{background:var(--stale);color:#fff} .badge.conflicting{background:var(--conflicting);color:#fff}
  .legend { display:flex; gap:1rem; flex-wrap:wrap; color:var(--dim); font-size:.75rem; margin-top:.5rem; }
  .empty { color:var(--dim); padding:.75rem; background:var(--panel); border:1px solid var(--line); border-radius:6px; }
  footer { margin-top:3rem; color:var(--dim); font-size:.75rem; border-top:1px solid var(--line); padding-top:1rem; }
</style>
<h1>AWE — Cognition and Dispatch</h1>
<div class="sub">
  ${esc(model.git.branch)} @ ${esc(String(model.git.commit || '').slice(0, 7))} ·
  generated ${esc(model.generated_at)} · local static file, no server
</div>

<div class="grid">${model.tiles.map(tile).join('')}</div>
<div class="legend">
  ${STATES.map((s) => `${badge(s)}`).join(' ')}
</div>

<h2>Dispatch queue</h2>
${model.tasks.length ? `<table><tr><th>Task</th><th>Status</th><th>Pri</th><th>Role</th><th>Objective</th></tr>
${model.tasks.map((t) => row([esc(t.task_id), badge(t.status === 'VERIFIED' ? 'VERIFIED' : t.status === 'BLOCKED' ? 'BLOCKED' : 'REPORTED') + ' ' + esc(t.status), esc(t.priority), esc(t.requested_role), esc(t.objective)])).join('\n')}</table>`
    : '<div class="empty">No tasks in the local dispatch queue.</div>'}

<h2>Cognition conflicts</h2>
${model.conflicts.length ? `<table><tr><th>Kind</th><th>Subject</th><th>Detail</th></tr>
${model.conflicts.map((c) => row([badge('CONFLICTING') + ' ' + esc(c.kind), esc(c.subject), esc(c.detail)])).join('\n')}</table>`
    : '<div class="empty">No disagreement detected between cognition documents.</div>'}

<h2>External artifacts still missing</h2>
<table><tr><th>Artifact</th><th>State</th><th>Note</th></tr>
${model.missing_external.map((m) => row([esc(m.name), badge(m.state), esc(m.note)])).join('\n')}</table>

<h2>Blocked locally</h2>
<table><tr><th>Dependency</th><th>State</th><th>Note</th></tr>
${model.blocked.map((b) => row([esc(b.name), badge(b.state), esc(b.note)])).join('\n')}</table>

<h2>Evidence warnings</h2>
${model.warnings.length ? `<table><tr><th>Kind</th><th>Message</th></tr>
${model.warnings.slice(0, 40).map((w) => row([esc(w.kind), esc(w.message)])).join('\n')}</table>`
    : '<div class="empty">No warnings in the latest evidence collection.</div>'}

<footer>
  Generated by <code>npm run dashboard:build</code> from <code>.awe/evidence</code>,
  <code>.awe/cognition</code> and <code>.awe/dispatch</code>.
  Git is canonical; this page is derived and gitignored. A tile marked REPORTED is a claim, not a measurement —
  migrations exist as files, but no database was contacted, so their applied state is genuinely unknown.
</footer>
`;
}
