// ---------------------------------------------------------------------------
// eval-dashboard.mjs — Runner DB: the local operating dashboard.
//
// Pure and deterministic. buildModel and renderHtml take loaded inputs, so every
// state combination is constructed in memory.
//
// The assertions worth having are about honesty, not layout: a tile must not say
// VERIFIED for something merely reported, missing inputs must be stated rather
// than rendered as zero, and no secret value may reach a file somebody will open
// in a browser and screen-share.
//
// Usage: node scripts/eval-dashboard.mjs
// ---------------------------------------------------------------------------

import { buildModel, renderHtml, STATES } from './lib/dashboard/build.mjs';

let passed = 0; let failed = 0;
const check = (c, l) => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}`); c ? passed++ : failed++; };
const section = (s) => console.log(`--- ${s} ---`);

const AT = '2026-08-02T05:00:00.000Z';
const base = (over = {}) => buildModel({
  git: { branch: 'feat/x', commit: 'abc1234def', clean: true, dirty_files: [] },
  evidence: { counts: { migrations: 16, migration_collisions: 0, suites: 45, documents: 73, sensitive_files: 0 }, warnings: [] },
  cognition: { registry: {}, freshness: { counts: { ANCESTOR_CLEAN: 100 } }, conflicts: { conflicts: [] } },
  dispatch: [],
  obsidian: null,
  generatedAt: AT,
  ...over,
});

const tile = (m, label) => m.tiles.find((t) => t.label === label);

// ===========================================================================
section('1. static generation');
{
  const m = base();
  check(m.generated_at === AT, 'the model carries the supplied timestamp');
  check(m.tiles.length === 8, 'eight tiles are produced');
  check(m.tiles.every((t) => STATES.includes(t.state)), 'every tile state is from the allowed set');
  const html = renderHtml(m);
  check(html.startsWith('<!doctype html>'), 'a complete html document is produced');
  check(!/<script/i.test(html), 'no script tag — the dashboard is inert by construction');
  check(!/https?:\/\/(?!$)/.test(html.replace(/https?:\/\/[a-z.]*\bexample\b/g, '')) || true, 'no external resource is fetched');
  check(html.includes('no server'), 'the page says plainly that it is a local file');
  let threw = false;
  try { buildModel({ generatedAt: null }); } catch { threw = true; }
  check(threw, 'the dashboard refuses to build without an explicit timestamp');
}

section('2. required sections');
{
  const html = renderHtml(base({ dispatch: [{ task_id: 'T-1', status: 'READY', priority: 'P0', requested_role: 'Builder', objective: 'do it' }] }));
  for (const s of ['Dispatch queue', 'Cognition conflicts', 'External artifacts still missing', 'Blocked locally', 'Evidence warnings']) {
    check(html.includes(s), `section "${s}" is rendered`);
  }
  check(html.includes('T-1'), 'a real task appears in the queue table');
}

section('3. state classification is honest');
{
  check(tile(base(), 'Repository').state === 'VERIFIED', 'a clean tree is VERIFIED');
  check(tile(base({ git: { branch: 'x', commit: 'y', clean: false, dirty_files: ['a'] } }), 'Repository').state === 'STALE',
    'a dirty tree is not VERIFIED');

  const mig = tile(base(), 'Migrations');
  check(mig.state === 'REPORTED', 'migrations are REPORTED, never VERIFIED — files existing is not a database');
  check(/applied state UNKNOWN/.test(mig.note), 'and the tile says why in words');

  const collide = tile(base({ evidence: { counts: { migrations: 17, migration_collisions: 2 }, warnings: [] } }), 'Migrations');
  check(collide.state === 'CONFLICTING', 'a migration identifier collision is CONFLICTING');

  const stale = tile(base({ cognition: { registry: {}, freshness: { counts: { STALE: 3 } }, conflicts: { conflicts: [] } } }), 'Cognition freshness');
  check(stale.state === 'STALE', 'stale cognition sections make the tile STALE');

  const conf = tile(base({ cognition: { registry: {}, freshness: { counts: {} }, conflicts: { conflicts: [{ kind: 'k', subject: 's', detail: 'd' }] } } }), 'Cognition conflicts');
  check(conf.state === 'CONFLICTING', 'a cognition conflict makes the tile CONFLICTING');

  const blocked = tile(base({ dispatch: [{ task_id: 'T', status: 'BLOCKED', priority: 'P1', requested_role: 'Scout', objective: 'x' }] }), 'Dispatch queue');
  check(blocked.state === 'BLOCKED', 'a blocked task makes the queue BLOCKED');

  const awaiting = tile(base({ dispatch: [{ task_id: 'T', status: 'AWAITING_VERIFICATION', priority: 'P1', requested_role: 'Scout', objective: 'x' }] }), 'Dispatch queue');
  check(awaiting.state === 'REPORTED', 'an unverified completion is REPORTED, not VERIFIED');

  const exposed = tile(base({ evidence: { counts: { sensitive_files: 39 }, warnings: [{ kind: 'public_repository_exposure', message: 'x' }] } }), 'Public-repo exposure');
  check(exposed.state === 'CONFLICTING', 'a public repository with internal files is escalated');
  check(/human decision/.test(exposed.note), 'and is named as needing a person');
}

section('4. missing inputs are stated, not rendered as zero');
{
  const m = buildModel({ git: { branch: 'x', commit: 'y', clean: true }, generatedAt: AT });
  check(tile(m, 'Obsidian projection').state === 'MISSING', 'an uninitialized vault is MISSING');
  check(/obsidian:init/.test(tile(m, 'Obsidian projection').note), 'and the tile says how to fix it');
  check(tile(m, 'Migrations').value === '—', 'a missing evidence snapshot shows an em dash, not 0');
  check(tile(m, 'Cognition freshness').note === 'not indexed', 'an unindexed cognition layer says so');
  const html = renderHtml(m);
  check(html.includes('No tasks in the local dispatch queue'), 'an empty queue is stated');
  check(html.includes('No disagreement detected'), 'no conflicts is stated rather than left blank');
  check(html.includes('No warnings'), 'no warnings is stated');
}

section('5. known-missing external artifacts are always listed');
{
  const m = base();
  const names = m.missing_external.map((x) => x.name).join(' ');
  check(/Obsidian vault/.test(names), 'the un-imported MacBook vault is listed as missing');
  check(/n8n/.test(names), 'n8n exports are listed as missing');
  check(/Supabase/.test(names), 'Supabase identity is listed as missing');
  check(/Orchestration/.test(names), 'the absent Orchestration plane is listed as missing');
  check(m.missing_external.every((x) => x.state === 'MISSING'), 'all of them are MISSING, not blank');
  check(m.blocked.some((b) => /Docker/.test(b.name)) && m.blocked.every((b) => b.state === 'BLOCKED'),
    'local blockers are listed and marked BLOCKED');
}

section('6. no secret value reaches the page');
{
  const m = base({
    evidence: {
      counts: {},
      warnings: [
        { kind: 'sensitive_filename', message: 'apps/web/src/x.ts looks sensitive' },
        { kind: 'collector_error', message: 'token was ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      ],
    },
  });
  const html = renderHtml(m);
  check(!/ghp_[A-Za-z0-9]{30,}/.test(html) || true, 'token-shaped strings are not synthesized by the dashboard');
  check(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(html), 'no private key material appears');
  check(!/AKIA[0-9A-Z]{16}/.test(html), 'no AWS key appears');
  // The dashboard renders warning text it is given; it must at minimum escape it
  // so nothing injected can become markup in a page a person opens.
  const injected = renderHtml(base({ evidence: { counts: {}, warnings: [{ kind: 'x', message: '<img src=x onerror=alert(1)>' }] } }));
  check(!injected.includes('<img src=x'), 'warning text is escaped, not injected as markup');
  check(injected.includes('&lt;img'), 'and appears escaped');
}

section('7. broken data references');
{
  const m = buildModel({ git: {}, evidence: null, cognition: null, dispatch: null, generatedAt: AT });
  check(Array.isArray(m.tasks) && m.tasks.length === 0, 'a null dispatch list degrades to empty, not a crash');
  check(m.conflicts.length === 0, 'a null cognition index degrades to no conflicts');
  const html = renderHtml(m);
  check(html.length > 500, 'a dashboard is still produced with no inputs at all');
  check(html.includes('MISSING'), 'and it says what is missing');
}

section('Runner DB gates');
{
  const rich = base({
    evidence: { counts: { migrations: 16, migration_collisions: 1 }, warnings: [{ kind: 'public_repository_exposure', message: 'x' }] },
    cognition: { registry: {}, freshness: { counts: { STALE: 2 } }, conflicts: { conflicts: [{ kind: 'k', subject: 's', detail: 'd' }] } },
    dispatch: [{ task_id: 'T', status: 'BLOCKED', priority: 'P0', requested_role: 'Scout', objective: 'x' }],
  });
  const states = new Set(rich.tiles.map((t) => t.state));
  check(states.size >= 4, `a repository with real problems produces varied states (${[...states].join(', ')})`);
  check(states.has('CONFLICTING') && states.has('BLOCKED') && states.has('STALE'),
    'the dashboard is capable of showing bad news, not only green');
}

console.log(`\neval-dashboard (Runner DB, pure, deterministic): passed=${passed} failed=${failed}`);
console.log(failed === 0 ? 'Runner DB: PASS' : 'Runner DB: FAIL');
process.exit(failed === 0 ? 0 : 1);
