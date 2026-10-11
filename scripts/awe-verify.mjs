// ---------------------------------------------------------------------------
// awe-verify.mjs — run the registered suites and write down what happened.
//
//   npm run verify                         # profile "ci" (what CI runs)
//   node scripts/awe-verify.mjs --profile local
//   node scripts/awe-verify.mjs --only proof,programs
//   node scripts/awe-verify.mjs --out .awe --registry autonomy/suites.json
//
// Writes <out>/verify.json and one log per suite under <out>/logs/. Every
// registered suite appears in verify.json with PASS, FAIL, BLOCKED or SKIPPED
// and a reason. Rules: autonomy/lib/verify.mjs.
//
// EXIT CODES. CI uses them, so they are part of the contract:
//   0  every blocking suite passed
//   1  a blocking suite FAILED, or the registry is invalid
//   3  no blocking failure, but a blocking suite was BLOCKED: the environment,
//      not the code, prevented an answer
//  64  usage error
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateRegistry, selectSuites, preflight, classify, summarize, probeEnvironment, runSuite, BUILD_SUITE,
} from '../autonomy/lib/verify.mjs';
import { treeFacts } from '../autonomy/lib/git.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d = null) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const known = new Set(['--profile', '--only', '--out', '--registry', '--root']);
for (let i = 0; i < argv.length; i += 2) {
  if (!known.has(argv[i]) || argv[i + 1] === undefined) {
    console.error(`usage: awe-verify [--profile ci|local|docker|manual|all] [--only id,id] [--out dir] [--registry file] [--root dir]`);
    process.exit(64);
  }
}

const root = resolve(arg('root', REPO));
const registryPath = resolve(arg('registry', join(REPO, 'autonomy/suites.json')));
const outDir = resolve(arg('out', join(REPO, '.awe')));
const profile = arg('profile', 'ci');
const only = arg('only') ? arg('only').split(',').map((s) => s.trim()).filter(Boolean) : null;

// Facts about the tree are taken BEFORE anything runs. A suite that writes into
// the tree must not be able to make a dirty run look clean, or the reverse.
const tree = treeFacts(root);
const startedAt = new Date();
const registryBytes = readFileSync(registryPath);
const registry = JSON.parse(registryBytes);
const registryErrors = validateRegistry(registry, { root });
const unknownOnly = (only ?? []).filter((id) => !registry.suites.some((s) => s.id === id));
if (unknownOnly.length) registryErrors.push(`--only names unregistered suite(s): ${unknownOnly.join(', ')}`);

// Fail before running anything if the result cannot be written. Discovering
// that after forty minutes of suites throws the evidence away.
try { mkdirSync(join(outDir, 'logs'), { recursive: true }); }
catch (e) { console.error(`awe-verify: cannot write results to ${outDir}: ${e.message}`); process.exit(64); }

const probe = probeEnvironment(root, registry.environment?.node);
const results = [];
const statusOf = new Map();

console.log(`awe-verify — profile ${profile}${only ? `, only ${only.join(',')}` : ''} — ${tree.commit?.slice(0, 12) ?? 'no commit'}${tree.dirty ? ' (DIRTY TREE)' : ''} — node ${process.version}`);

if (registryErrors.length) {
  for (const e of registryErrors) console.log(`REGISTRY  ${e}`);
}

for (const { suite, selected, reason } of registryErrors.length ? [] : selectSuites(registry, { profile, only })) {
  const base = {
    id: suite.id, name: suite.name, category: suite.category, area: suite.area,
    criticality: suite.criticality, blocking: suite.blocking, authority: suite.authority,
    command: suite.command.join(' '),
  };
  if (!selected) {
    results.push({ ...base, status: 'SKIPPED', reason, started_at: null, finished_at: null, duration_ms: 0, exit_code: null });
    statusOf.set(suite.id, 'SKIPPED');
    console.log(`SKIPPED  ${suite.id} — ${reason}`);
    continue;
  }
  const unmet = preflight(suite, {
    ...probe,
    buildStatus: statusOf.has(BUILD_SUITE) && statusOf.get(BUILD_SUITE) !== 'SKIPPED' ? statusOf.get(BUILD_SUITE) : null,
  });
  if (unmet.length) {
    const r = { ...base, status: 'BLOCKED', reason: `unmet: ${unmet.join('; ')}`, unmet,
      started_at: null, finished_at: null, duration_ms: 0, exit_code: null };
    results.push(r);
    statusOf.set(suite.id, 'BLOCKED');
    console.log(`BLOCKED  ${suite.id} — ${r.reason}`);
    continue;
  }
  const run = await runSuite(suite, { root, logDir: join(outDir, 'logs') });
  const { status, reason: why } = classify(suite, run.outcome);
  const r = {
    ...base, status, reason: why,
    started_at: run.started.toISOString(), finished_at: run.finished.toISOString(),
    duration_ms: run.finished - run.started,
    exit_code: run.outcome.exitCode ?? null, signal: run.outcome.signal ?? null, timed_out: !!run.outcome.timedOut,
    log: relative(outDir, run.logPath),
    log_tail: run.tail.slice(-15),
  };
  if (suite.requires_build && !statusOf.has(BUILD_SUITE)) {
    r.note = 'used a production build already present on disk; it was not built in this run';
  }
  results.push(r);
  statusOf.set(suite.id, status);
  console.log(`${status.padEnd(7)}  ${suite.id} (${(r.duration_ms / 1000).toFixed(1)}s)${status === 'PASS' ? '' : ` — ${why}`}`);
}

const finishedAt = new Date();
const { summary, verdict, exitCode } = registryErrors.length
  ? { summary: { pass: 0, fail: 0, blocked: 0, skipped: 0, blocking_fail: 0, blocking_blocked: 0 }, verdict: 'FAIL', exitCode: 1 }
  : summarize(results);

const record = {
  schema: 'awe.verify/1',
  run_id: `${startedAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${(tree.commit ?? 'nocommit').slice(0, 7)}-${process.pid}`,
  tree,
  started_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  duration_ms: finishedAt - startedAt,
  host: {
    node: process.version, platform: `${process.platform}-${process.arch}`,
    root_user: probe.isRoot, deps_installed: probe.depsInstalled,
  },
  profile,
  selection: { only },
  registry: {
    path: relative(root, registryPath) || registryPath,
    sha256: createHash('sha256').update(registryBytes).digest('hex'),
    suites: registry.suites?.length ?? 0,
    errors: registryErrors,
  },
  verdict,
  summary,
  suites: results,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'verify.json'), JSON.stringify(record, null, 2) + '\n');

const line = `verify: ${verdict} — pass ${summary.pass}, fail ${summary.fail} (blocking ${summary.blocking_fail}), blocked ${summary.blocked} (blocking ${summary.blocking_blocked}), skipped ${summary.skipped}`;
console.log(`\n${line}\nwrote ${relative(process.cwd(), join(outDir, 'verify.json')) || join(outDir, 'verify.json')}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.filter((r) => r.status !== 'SKIPPED')
    .map((r) => `| ${r.status} | \`${r.id}\` | ${r.blocking ? 'yes' : 'no'} | ${(r.duration_ms / 1000).toFixed(1)}s | ${r.status === 'PASS' ? '' : String(r.reason).replace(/\|/g, '\\|')} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `## awe-verify: ${verdict}`, '', line, '',
    verdict === 'BLOCKED' ? '**BLOCKED means the environment could not answer, not that the code is wrong.**\n' : '',
    '| Status | Suite | Blocking | Time | Reason |', '|---|---|---|---|---|', ...rows, '',
    `${summary.skipped} suite(s) not in this profile are listed with reasons in verify.json.`, '',
  ].join('\n'));
}

process.exit(exitCode);
