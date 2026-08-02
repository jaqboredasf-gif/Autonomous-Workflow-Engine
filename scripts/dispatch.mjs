// ---------------------------------------------------------------------------
// dispatch.mjs — the local dispatch CLI.
//
//   npm run dispatch:add      -- --task-id AWE-INT-101 --objective "..." ...
//   npm run dispatch:list
//   npm run dispatch:prepare  -- --task-id AWE-INT-101
//   npm run dispatch:claim    -- --task-id AWE-INT-101 --owner session-a
//   npm run dispatch:complete -- --task-id AWE-INT-101 --handoff <path>
//   npm run dispatch:verify   -- --task-id AWE-INT-101
//   npm run dispatch:block    -- --task-id AWE-INT-101 --reason "..."
//   npm run dispatch:status
//
// It NEVER launches a worker. Preparing a task compiles its context; claiming it
// records ownership. What happens next is a human opening an agent with the
// packet — deliberately, because an engine that starts agents by itself is an
// engine that can run unbounded work while nobody is watching.
//
// OFFLINE. Writes only under the gitignored .awe/.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  newTask, validateTask, applyTransition, transitionError, dependencyErrors, STATES,
} from './lib/dispatch/state.mjs';
import { validateHandoff, handoffToMarkdown } from './lib/dispatch/handoff.mjs';
import { verifyHandoff } from './lib/dispatch/verify.mjs';
import {
  saveTask, loadTask, listTasks, tasksById, acquireClaim, readClaim, saveHandoff, loadHandoff, paths,
} from './lib/dispatch/store.mjs';
import { collectAll, collectKnownPaths } from './lib/context-compiler/fs-sources.mjs';
import { compile, toJson, toMarkdown } from './lib/context-compiler/compile.mjs';

const root = process.cwd();
const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const now = () => new Date().toISOString();

const git = (args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};

const die = (msg, code = 1) => { console.error(`dispatch: ${msg}`); process.exit(code); };
const ok = (msg) => console.log(`dispatch: ${msg}`);

// ---------------------------------------------------------------------------

function cmdAdd() {
  const id = arg('--task-id') || die('--task-id is required');
  if (loadTask(root, id)) die(`${id} already exists`);
  const task = newTask({
    task_id: id,
    objective: arg('--objective') || die('--objective is required'),
    capability: arg('--capability') || 'unspecified',
    priority: arg('--priority', 'P2'),
    requested_role: arg('--role', 'Builder'),
    required_branch: arg('--branch', git(['rev-parse', '--abbrev-ref', 'HEAD'])),
    depends_on: (arg('--depends-on', '') || '').split(',').filter(Boolean),
    allowed_scope: (arg('--scope', '') || '').split(',').filter(Boolean),
    required_tests: (arg('--tests', '') || '').split(',').filter(Boolean),
    required_evidence: (arg('--evidence', '') || '').split(',').filter(Boolean),
    definition_of_done: (arg('--done', '') || '').split('|').filter(Boolean),
    // Every task inherits the universal prohibitions; --forbid adds task-specific ones.
    forbidden_actions: [
      'push to any remote', 'merge or rebase any branch', 'commit to main',
      'apply a migration in any environment', 'contact Supabase, n8n or Microsoft Graph',
      'send email', 'expose a credential',
      ...(arg('--forbid', '') || '').split(',').filter(Boolean),
    ],
    history: [{ from: null, to: 'DRAFT', at: now(), by: arg('--owner', 'cli'), note: 'created' }],
  });
  const errors = validateTask(task);
  if (errors.length) die(`task is invalid:\n  ${errors.join('\n  ')}`);
  saveTask(root, task);
  ok(`added ${id} (DRAFT)`);
}

function cmdList() {
  const tasks = listTasks(root);
  if (!tasks.length) return ok('no tasks');
  const filter = arg('--status');
  for (const t of tasks) {
    if (filter && t.status !== filter) continue;
    const claim = readClaim(root, t.task_id);
    console.log(`${t.task_id}  ${String(t.status).padEnd(22)} ${t.priority}  ${t.requested_role.padEnd(13)} ${claim ? `[${claim.owner}] ` : ''}${t.objective}`);
  }
}

async function cmdPrepare() {
  const id = arg('--task-id') || die('--task-id is required');
  const task = loadTask(root, id) || die(`${id} not found`);

  const problems = [];
  problems.push(...validateTask(task).map((e) => `invalid task: ${e}`));
  problems.push(...dependencyErrors(task, tasksById(root)));

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = git(['rev-parse', 'HEAD']);
  if (task.required_branch && task.required_branch !== branch) {
    problems.push(`task requires branch "${task.required_branch}" but HEAD is on "${branch}"`);
  }

  const { records, git: gitState } = await collectAll(root, { objective: task.objective, taskId: id });
  const { packet, manifest, warnings, errors } = compile(records, {
    objective: task.objective,
    taskId: id,
    capability: task.capability,
    git: gitState,
    generatedAt: now(),
    knownPaths: collectKnownPaths(root),
    knownBranches: new Set(gitState.branches),
  });
  problems.push(...errors.map((e) => `packet invalid: ${e}`));

  // Refusal conditions. A packet full of stale or absent context is worse than
  // no packet, because the worker will act on it.
  const stale = warnings.filter((w) => w.kind === 'stale_source');
  const missingCap = warnings.filter((w) => w.kind === 'missing_capability');
  if (has('--strict') && stale.length) problems.push(`${stale.length} stale source(s) and --strict was given`);

  const dir = resolve(root, '.awe', 'packets', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'execution-packet.md'), toMarkdown(packet), 'utf8');
  writeFileSync(join(dir, 'execution-packet.json'), toJson(packet), 'utf8');
  writeFileSync(join(dir, 'source-manifest.json'), toJson(manifest), 'utf8');
  writeFileSync(join(dir, 'warnings.json'), toJson({ count: warnings.length, warnings }), 'utf8');

  console.log(`dispatch:prepare ${id}`);
  console.log(`  packet   : ${dir}`);
  console.log(`  sources  : ${packet.sources.length} · warnings ${warnings.length}`);
  if (missingCap.length) for (const w of missingCap) console.log(`  ABSENT   : ${w.message}`);
  if (stale.length) console.log(`  stale    : ${stale.length} source(s)`);

  if (problems.length) {
    console.error('\ndispatch:prepare REFUSED');
    for (const p of problems) console.error(`  FAIL  ${p}`);
    console.error('The packet was written for inspection, but the task stays in its current state.');
    process.exit(1);
  }

  const next = task.status === 'DRAFT' || task.status === 'REJECTED' || task.status === 'BLOCKED'
    ? applyTransition({ ...task, status: task.status === 'BLOCKED' ? 'BLOCKED' : task.status }, 'READY', { at: now(), by: 'prepare' })
    : task;
  saveTask(root, {
    ...next,
    packet_id: packet.packet_id,
    packet_path: join('.awe', 'packets', id),
    required_starting_commit: task.required_starting_commit || commit,
  });
  ok(`${id} is READY`);
}

function cmdClaim() {
  const id = arg('--task-id') || die('--task-id is required');
  const owner = arg('--owner') || die('--owner is required (a session label, not a person)');
  const task = loadTask(root, id) || die(`${id} not found`);
  const err = transitionError(task.status, 'CLAIMED');
  if (err) die(err);

  const claim = acquireClaim(root, id, owner, now());
  if (!claim.ok) die(`${id} is already claimed by "${claim.owner}" — a second claim is refused, not merged`);

  const t = applyTransition(task, 'CLAIMED', { at: now(), by: owner });
  saveTask(root, {
    ...t,
    claim_owner: owner,
    claim_timestamp: now(),
    related_commits: [...(task.related_commits || []), git(['rev-parse', 'HEAD'])].filter(Boolean),
  });
  ok(`${id} claimed by ${owner} at ${git(['rev-parse', '--abbrev-ref', 'HEAD'])} @ ${String(git(['rev-parse', 'HEAD'])).slice(0, 7)}`);
  console.log('       No agent was launched. Open a worker with the packet yourself.');
}

function cmdComplete() {
  const id = arg('--task-id') || die('--task-id is required');
  const path = arg('--handoff') || die('--handoff <path> is required');
  const task = loadTask(root, id) || die(`${id} not found`);
  if (!existsSync(path)) die(`handoff not found: ${path}`);

  let handoff;
  try { handoff = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { die(`handoff is not valid JSON: ${e.message}`); }

  const errors = validateHandoff(handoff, { requiredTests: task.required_tests || [] });
  if (errors.length) {
    console.error(`dispatch:complete REFUSED — the handoff is not admissible:`);
    for (const e of errors) console.error(`  FAIL  ${e}`);
    process.exit(1);
  }
  if (handoff.task_id !== id) die(`handoff is for ${handoff.task_id}, not ${id}`);

  const err = transitionError(task.status, 'AWAITING_VERIFICATION');
  if (err) die(err);

  saveHandoff(root, id, handoff);
  writeFileSync(join(paths(root).handoffs, `${id}.md`), handoffToMarkdown(handoff), 'utf8');
  const t = applyTransition(task, 'AWAITING_VERIFICATION', { at: now(), by: handoff.worker });
  saveTask(root, { ...t, result_handoff: join('.awe', 'dispatch', 'handoffs', `${id}.json`) });
  ok(`${id} is AWAITING_VERIFICATION`);
  console.log('       A worker saying "done" does not make it done. Run dispatch:verify.');
}

function cmdVerify() {
  const id = arg('--task-id') || die('--task-id is required');
  const task = loadTask(root, id) || die(`${id} not found`);
  const handoff = loadHandoff(root, id) || die(`no handoff submitted for ${id}`);

  const obs = {
    currentBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    currentCommit: git(['rev-parse', 'HEAD']),
    commitExists: (sha) => !!sha && git(['cat-file', '-t', sha]) === 'commit',
    filesInRange: (from, to) => {
      if (!from || !to) return [];
      const out = git(['diff', '--name-only', `${from}..${to}`]);
      return out ? out.split('\n').filter(Boolean) : [];
    },
    forbiddenTouched: (() => {
      const scope = task.allowed_scope || [];
      if (!scope.length) return [];
      const changed = handoff.starting_commit && handoff.ending_commit
        ? (git(['diff', '--name-only', `${handoff.starting_commit}..${handoff.ending_commit}`]) || '').split('\n').filter(Boolean)
        : [];
      return changed.filter((f) => !scope.some((s) => f === s || f.startsWith(s.replace(/\/$/, '') + '/')));
    })(),
    evidenceExists: (p) => existsSync(resolve(root, p)),
  };

  const v = verifyHandoff(task, handoff, obs);
  console.log(`dispatch:verify ${id}`);
  for (const c of v.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.check}: ${c.message}`);

  const t = applyTransition(task, v.verdict, { at: now(), by: 'verify', note: v.failed_checks.join(',') || null });
  saveTask(root, { ...t, verification: { at: now(), ...v } });
  console.log(`\ndispatch:verify — ${id} is ${v.verdict}`);
  if (!v.passed) process.exit(1);
}

function cmdBlock() {
  const id = arg('--task-id') || die('--task-id is required');
  const reason = arg('--reason') || die('--reason is required — an unexplained block is a lost task');
  const task = loadTask(root, id) || die(`${id} not found`);
  const err = transitionError(task.status, 'BLOCKED');
  if (err) die(err);
  const t = applyTransition(task, 'BLOCKED', { at: now(), by: 'cli', note: reason });
  saveTask(root, { ...t, blocked_by: reason, blockers: [...(task.blockers || []), reason] });
  ok(`${id} is BLOCKED: ${reason}`);
}

function cmdStatus() {
  const tasks = listTasks(root);
  const by = {};
  for (const s of STATES) by[s] = 0;
  for (const t of tasks) by[t.status] = (by[t.status] || 0) + 1;
  console.log(`dispatch:status — ${tasks.length} task(s) on ${git(['rev-parse', '--abbrev-ref', 'HEAD'])} @ ${String(git(['rev-parse', 'HEAD'])).slice(0, 7)}`);
  for (const [s, n] of Object.entries(by)) if (n) console.log(`  ${s.padEnd(22)} ${n}`);
  const blocked = tasks.filter((t) => t.status === 'BLOCKED');
  const awaiting = tasks.filter((t) => t.status === 'AWAITING_VERIFICATION');
  if (blocked.length) { console.log('\n  blocked:'); for (const t of blocked) console.log(`    ${t.task_id}: ${t.blocked_by}`); }
  if (awaiting.length) { console.log('\n  awaiting verification:'); for (const t of awaiting) console.log(`    ${t.task_id}`); }
}

const commands = {
  add: cmdAdd, list: cmdList, prepare: cmdPrepare, claim: cmdClaim,
  complete: cmdComplete, verify: cmdVerify, block: cmdBlock, status: cmdStatus,
};

if (!commands[cmd]) {
  console.log(`usage: dispatch <${Object.keys(commands).join('|')}> [options]`);
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
