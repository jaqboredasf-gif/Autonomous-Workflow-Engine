// ---------------------------------------------------------------------------
// eval-autonomy.mjs — can the verification layer be made to lie?
//
// The layer exists so that "the tests passed" stops being something a session
// says. That only holds if the layer itself cannot be flattered, so most of
// this suite is adversarial:
//
//   · a failing suite must never come back PASS, however it fails: non-zero
//     exit, a signal, a timeout, or a crash whose text looks environmental;
//   · BLOCKED must come only from a declared requirement or a declared exit
//     code, never from reading a log;
//   · a non-blocking failure must stay visible, and must not move the verdict;
//   · a new suite added to scripts/ without registering it must fail this file,
//     so "never silently skip" covers suites nobody knew to skip;
//   · a blocker must keep its paths closed even when its detector says the
//     problem looks fixed;
//   · the engineering state must refuse to call a dirty, partial, stale or
//     unverified tree safe.
//
// The end-to-end section runs the real scripts/awe-verify.mjs, in a child
// process, against throwaway suites that pass, fail, time out and report a
// missing environment, and reads the verify.json it writes.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, mkdtempSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  validateRegistry, selectSuites, preflight, classify, summarize, nodeSatisfies,
} from '../autonomy/lib/verify.mjs';
import { checkChange, matches, closedPaths } from '../autonomy/lib/guard.mjs';
import { deriveEngineeringState } from '../autonomy/lib/state.mjs';
import { findMigrationCollisions, DETECTOR_NAMES } from '../autonomy/lib/detectors.mjs';
import { parseLedger, resolveFacts, baselineGate, validateRecord, BASELINE_FACT, BASELINE_BANNER } from '../autonomy/lib/attestations.mjs';
import { deriveReadiness, answerQuestion } from '../autonomy/lib/readiness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

let pass = 0;
const fails = [];
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const registry = load('autonomy/suites.json');
const { blockers } = load('autonomy/blockers.json');
const policy = load('autonomy/policy.json');
const suite = (over = {}) => ({
  id: 't', name: 't', entry: 'x', command: ['node', 'x'], category: 'unit', area: 'autonomy',
  requires: [], offline: true, requires_build: false, timeout_s: 5, criticality: 'normal',
  blocking: true, authority: 'authoritative', profiles: ['ci'], ...over,
});

console.log('--- the registry describes the repository ----------------------');

const regErrors = validateRegistry(registry, { root: ROOT });
ok(regErrors.length === 0, 'autonomy/suites.json is valid against the files it names', regErrors.join('; '));

const registered = new Set(registry.suites.flatMap((s) => [s.entry, ...(s.components ?? [])]));
const discoverable = [
  ...readdirSync(join(ROOT, 'scripts')).filter((f) => /^(eval-|acceptance-)/.test(f)).map((f) => `scripts/${f}`),
  ...readdirSync(join(ROOT, 'supabase/tests')).filter((f) => f.endsWith('.sql')).map((f) => `supabase/tests/${f}`),
];
const unregistered = discoverable.filter((p) => !registered.has(p));
ok(unregistered.length === 0, 'every scripts/eval-*, scripts/acceptance-* and supabase/tests/*.sql is registered or a named component',
   unregistered.join(', '));
ok(registry.suites.filter((s) => s.blocking).every((s) => s.profiles.includes('ci')),
   'every blocking suite runs in CI');
ok(registry.suites.filter((s) => s.live_writes).every((s) => s.profiles.join() === 'live-human-only'),
   'every suite that writes to a hosted system is human-only');
ok(registry.suites.find((s) => s.id === 'autonomy-selftest')?.blocking === true,
   'this suite is itself registered and blocking');
ok(selectSuites(registry, { profile: 'all' }).filter((x) => x.selected).every((x) => !x.suite.live_writes),
   '--profile all still never selects a live-writing suite');
const ciSkips = selectSuites(registry, { profile: 'ci' }).filter((x) => !x.selected);
ok(ciSkips.length > 0 && ciSkips.every((x) => x.reason && x.reason.length > 20),
   'every suite left out of CI carries a stated reason');

console.log('--- the registry refuses to describe a lie ----------------------');

const bad = (over, why) => validateRegistry({ suites: [suite(over)] }).length > 0
  ? ok(true, `rejected: ${why}`) : ok(false, `rejected: ${why}`, 'validateRegistry accepted it');
bad({ profiles: ['local'], ci_excluded_because: 'x' }, 'a blocking suite that CI never runs');
bad({ blocking: false, profiles: ['local'] }, 'a suite excluded from CI with no reason');
bad({ live_writes: true, blocking: false, profiles: ['ci'] }, 'a live-writing suite in CI');
bad({ requires: ['vibes'] }, 'an undeclared requirement kind');
bad({ timeout_s: 0 }, 'a suite with no timeout');
ok(validateRegistry({ suites: [suite(), suite()] }).some((e) => /duplicate/.test(e)), 'rejected: duplicate ids');

console.log('--- classify: a failure is never a pass ------------------------');

const s0 = suite();
ok(classify(s0, { exitCode: 0 }).status === 'PASS', 'exit 0 is PASS');
ok(classify(s0, { exitCode: 1 }).status === 'FAIL', 'exit 1 is FAIL');
ok(classify(s0, { exitCode: 2 }).status === 'FAIL', 'exit 2 is FAIL when the suite has not declared it');
ok(classify(suite({ env_exit_codes: [2] }), { exitCode: 2 }).status === 'BLOCKED', 'exit 2 is BLOCKED when the suite declares it');
ok(classify(suite({ env_exit_codes: [2] }), { exitCode: 1 }).status === 'FAIL', 'a declared env exit code does not soften other exits');
ok(classify(s0, { exitCode: null, signal: 'SIGSEGV' }).status === 'FAIL', 'death by signal is FAIL');
ok(classify(s0, { exitCode: 0, timedOut: true }).status === 'FAIL', 'a timeout is FAIL even if the exit code reads 0');
ok(classify(s0, { spawnError: 'ENOENT' }).status === 'BLOCKED', 'a command that cannot start is BLOCKED, and says why');
ok(!classify.toString().includes('tail') && !classify.toString().includes('log'),
   'classify never reads output: BLOCKED cannot come from a log heuristic');

console.log('--- preflight: BLOCKED only from a declared requirement ---------');

const probe = (over = {}) => ({ node: 'v24.1.0', nodeRange: '>=24', env: {}, isRoot: false, depsInstalled: true,
  hasTool: () => true, dockerUp: true, buildStatus: null, artifactExists: true, ...over });
ok(preflight(suite(), probe()).length === 0, 'nothing declared, nothing unmet');
ok(preflight(suite(), probe({ node: 'v22.22.0' })).some((u) => /node/.test(u)), 'node 22 against >=24 is unmet');
ok(nodeSatisfies('>=24', 'v24.0.0') && !nodeSatisfies('>=24', 'v9.0.0'), 'node range compares majors numerically');
ok(preflight(suite({ requires: ['deps'] }), probe({ depsInstalled: false })).length === 1, 'missing npm ci is unmet');
ok(preflight(suite({ requires: ['nonroot'] }), probe({ isRoot: true })).length === 1, 'root is unmet for a nonroot suite');
ok(preflight(suite({ requires: ['env:PILOT_PASSWORD'] }), probe()).length === 1, 'an unset variable is unmet');
ok(!preflight(suite({ requires: ['env:PILOT_PASSWORD'] }), probe({ env: { PILOT_PASSWORD: 'x' } })).join().includes('x '),
   'and a set one is not echoed anywhere');
ok(preflight(suite({ requires_build: true }), probe({ buildStatus: 'FAIL' }))[0]?.includes('purchasing-build is FAIL'),
   'a dependant of a failed build is BLOCKED, naming the build');
ok(preflight(suite({ requires_build: true }), probe({ buildStatus: null, artifactExists: false })).length === 1,
   'a dependant with no build anywhere is BLOCKED');

console.log('--- summarize: blocking decides, nothing hides -----------------');

const r = (status, blocking = true) => ({ status, blocking });
let v = summarize([r('PASS'), r('FAIL', false)]);
ok(v.verdict === 'PASS' && v.summary.fail === 1, 'a non-blocking FAIL is counted but does not fail the run');
v = summarize([r('PASS'), r('BLOCKED')]);
ok(v.verdict === 'BLOCKED' && v.exitCode === 3, 'a blocking BLOCKED gives verdict BLOCKED and exit 3');
v = summarize([r('FAIL'), r('BLOCKED')]);
ok(v.verdict === 'FAIL' && v.exitCode === 1, 'FAIL outranks BLOCKED');
v = summarize([r('SKIPPED'), r('PASS')]);
ok(v.verdict === 'PASS' && v.summary.skipped === 1, 'SKIPPED is counted, never silently dropped');

console.log('--- end to end: the real runner, real processes -----------------');

const tmp = mkdtempSync(join(tmpdir(), 'awe-verify-eval-'));
try {
  mkdirSync(join(tmp, 's'));
  const script = (name, body) => writeFileSync(join(tmp, 's', name), body);
  script('pass.mjs', 'console.log("all good");');
  script('fail.mjs', 'console.log("assertion failed"); process.exit(1);');
  script('env.mjs', 'console.log("Docker is not available. SKIPPED"); process.exit(2);');
  script('lies.mjs', 'console.log("Error: Cannot find module \'@awe/workflow\'"); process.exit(1);');
  script('hang.mjs', 'setInterval(() => {}, 1000);');
  const fx = (id, file, over = {}) => suite({ id, entry: `s/${file}`, command: ['node', `s/${file}`], ...over });
  writeFileSync(join(tmp, 'suites.json'), JSON.stringify({
    environment: { node: '>=1' },
    suites: [
      fx('ok', 'pass.mjs'),
      fx('broken', 'fail.mjs'),
      fx('nodocker', 'env.mjs', { env_exit_codes: [2] }),
      fx('looks-environmental', 'lies.mjs'),
      fx('hangs', 'hang.mjs', { timeout_s: 1 }),
      fx('needs-secret', 'pass.mjs', { requires: ['env:AWE_EVAL_DEFINITELY_UNSET'] }),
      fx('soft', 'fail.mjs', { blocking: false }),
      fx('elsewhere', 'pass.mjs', { blocking: false, profiles: ['docker'], ci_excluded_because: 'test fixture' }),
    ],
  }));
  const out = join(tmp, 'out');
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts/awe-verify.mjs'), '--root', tmp,
    '--registry', join(tmp, 'suites.json'), '--out', out], { encoding: 'utf8', env });
  const rec = existsSync(join(out, 'verify.json')) ? JSON.parse(readFileSync(join(out, 'verify.json'), 'utf8')) : null;
  ok(rec !== null, 'awe-verify wrote verify.json', run.stderr.slice(0, 200));
  const st = (id) => rec?.suites.find((x) => x.id === id);
  ok(st('ok')?.status === 'PASS' && st('ok')?.exit_code === 0, 'a passing suite is PASS with its exit code');
  ok(st('broken')?.status === 'FAIL' && st('broken')?.exit_code === 1, 'a failing suite is FAIL with its exit code');
  ok(st('nodocker')?.status === 'BLOCKED', 'a declared missing environment is BLOCKED');
  ok(st('looks-environmental')?.status === 'FAIL',
     'a crash that LOOKS environmental is still FAIL: its requirements were met');
  ok(st('hangs')?.status === 'FAIL' && st('hangs')?.timed_out === true, 'a hung suite is killed and reported FAIL');
  ok(st('hangs')?.duration_ms < 10000, 'and the timeout actually bounded it', String(st('hangs')?.duration_ms));
  ok(st('needs-secret')?.status === 'BLOCKED' && st('needs-secret')?.started_at === null,
     'an unmet requirement is BLOCKED before the suite starts');
  ok(st('soft')?.status === 'FAIL', 'a non-blocking failure is still reported as FAIL');
  ok(st('elsewhere')?.status === 'SKIPPED' && /docker/.test(st('elsewhere')?.reason), 'an out-of-profile suite is SKIPPED with its reason');
  ok(rec?.suites.length === 8, 'every registered suite appears in the result', String(rec?.suites.length));
  ok(rec?.verdict === 'FAIL' && run.status === 1, 'blocking failures make the run FAIL and exit 1', `exit ${run.status}`);
  ok(rec?.suites.every((x) => x.status === 'SKIPPED' || 'started_at' in x) && rec?.started_at && rec?.finished_at,
     'the run and each suite carry timestamps');
  ok(typeof rec?.registry?.sha256 === 'string' && rec.registry.sha256.length === 64, 'the registry is fingerprinted');
  ok(st('broken')?.log_tail?.some((l) => /assertion failed/.test(l)), 'the failing output is carried into the record');

  // Only blocked: verdict BLOCKED, exit 3. The environment cannot answer, and CI must be able to say so.
  const onlyBlocked = spawnSync(process.execPath, [join(ROOT, 'scripts/awe-verify.mjs'), '--root', tmp,
    '--registry', join(tmp, 'suites.json'), '--out', join(tmp, 'out2'), '--only', 'ok,nodocker'], { encoding: 'utf8', env });
  ok(onlyBlocked.status === 3, 'a run whose only problem is a blocked environment exits 3, not 0 and not 1', `exit ${onlyBlocked.status}`);
  const unknown = spawnSync(process.execPath, [join(ROOT, 'scripts/awe-verify.mjs'), '--root', tmp,
    '--registry', join(tmp, 'suites.json'), '--out', join(tmp, 'out3'), '--only', 'nope'], { encoding: 'utf8', env });
  ok(unknown.status === 1, '--only naming an unregistered suite fails rather than running nothing green');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('--- the guard: discovering a problem is not permission ----------');

const auto = 'autonomy/2026-10-12-01';
const reasons = (paths, ref = auto) => checkChange({ paths, ref }, policy, blockers);
ok(reasons(['docs/autonomy/notes.md', 'scripts/eval-proof.mjs']).length === 0, 'an ordinary change on an autonomy branch is clean');
const mig = reasons(['supabase/migrations/0039_fix_s1.sql']).map((x) => x.rule);
ok(mig.includes('blocker:S1') && mig.includes('blocker:MIGRATION-0016') && mig.includes('l3'),
   'a migration that "fixes S1" is refused by S1, by MIGRATION-0016 and by L3', mig.join(','));
ok(reasons(['packages/mcp-server/src/index.js']).some((x) => x.rule === 'blocker:S1'), 'the MCP service-role surface is closed by S1');
ok(reasons(['docs/recovered/2026-08-10-local-out-of-band-migrations/README.md']).some((x) => x.rule === 'blocker:MIGRATION-0016'),
   'the recovered out-of-band migrations are closed by MIGRATION-0016');
ok(reasons(['autonomy/suites.json']).some((x) => x.rule === 'l3'), 'the registry itself is L3: no agent can make a failure non-blocking');
ok(reasons(['autonomy/blockers.json']).some((x) => x.rule === 'l3'), 'and so is the blocker registry');
ok(reasons(['.github/workflows/awe-verify.yml']).some((x) => x.rule === 'l3'), 'and CI');
ok(reasons(['README.md'], 'pcc-production').some((x) => x.rule === 'blocker:GOV-1'), 'pcc-production is not an autonomy ref');
ok(reasons(['README.md'], 'main').length >= 2, 'nor is main');
ok(reasons(['README.md'], 'security/phase-1-remediation').some((x) => x.rule === 'blocker:S1'), 'nor a security branch');
ok(matches('apps/purchasing/.env.local', '**/.env*') && !matches('apps/purchasing/src/env.ts', '**/.env*'), 'glob matching is not over-broad');
const healed = blockers.map((b) => ({ ...b }));
ok(checkChange({ paths: ['supabase/migrations/x.sql'], ref: auto }, policy, healed).some((x) => x.rule === 'blocker:S1'),
   'a blocker stays in force whatever a detector says; only a human edit to blockers.json lifts it');
for (const id of ['S1', 'MIGRATION-0016']) {
  const b = blockers.find((x) => x.id === id);
  ok(b?.status === 'HUMAN_REVIEW_REQUIRED' && b?.autonomous_action === 'OBSERVE_AND_ESCALATE_ONLY',
     `${id} is HUMAN_REVIEW_REQUIRED / OBSERVE_AND_ESCALATE_ONLY`);
  ok(b?.forbidden_paths?.includes('supabase/migrations/**'), `${id} closes supabase/migrations/**`);
}
ok(blockers.every((b) => DETECTOR_NAMES.includes(b.detector)), 'every blocker names a detector that exists');

console.log('--- detectors are pure where they decide -----------------------');

const col = findMigrationCollisions({
  'origin/pcc-production': ['0015_a.sql', '0016_purchasing_control.sql'],
  'origin/security/c1': ['0015_a.sql', '0016_drop_undeclared_client_policies.sql'],
  'origin/x': ['0016_purchasing_control.sql', '20260727_ts.sql'],
});
ok(col.length === 1 && col[0].number === '0016' && col[0].variants.length === 2, 'the 0016 collision is found, and only it');
ok(findMigrationCollisions({ a: ['0015_a.sql'], b: ['0015_a.sql'] }).length === 0, 'the same file on two branches is not a collision');

console.log('--- engineering state refuses to call the unknown safe ----------');

const green = (over = {}) => ({
  run_id: 'r', verdict: 'PASS', profile: 'ci', selection: { only: null }, finished_at: 't',
  tree: { commit: 'abc', branch: 'b', dirty: false }, registry: { errors: [], sha256: 'h' },
  summary: { pass: 1, fail: 0, blocked: 0, skipped: 0 },
  suites: [{ id: 'x', status: 'PASS', blocking: true, criticality: 'high', reason: 'exited 0' }], ...over,
});
const state = (verify, bl = blockers, head = 'abc') => deriveEngineeringState({ verify, blockers: bl, policy, head, now: 't' }).autonomy;
ok(state(null).verdict === 'NOT_SAFE', 'no verification: NOT_SAFE');
ok(state(green({ tree: { commit: 'abc', dirty: true } })).verdict === 'NOT_SAFE', 'a dirty tree: NOT_SAFE');
ok(state(green(), blockers, 'def').verdict === 'NOT_SAFE', 'verification of another commit: NOT_SAFE');
ok(state(green({ selection: { only: ['x'] } })).verdict === 'NOT_SAFE', 'a partial run: NOT_SAFE');
ok(state(green({ profile: 'local' })).verdict === 'NOT_SAFE', 'a non-CI profile: NOT_SAFE');
ok(state(green({ suites: [{ id: 'x', status: 'BLOCKED', blocking: true, reason: 'r' }] })).verdict === 'NOT_SAFE',
   'a blocking suite BLOCKED: NOT_SAFE (unknown is not good)');
ok(state(green({ suites: [{ id: 'x', status: 'FAIL', blocking: false, reason: 'r' }] }), []).verdict === 'SAFE_TO_PROCEED',
   'a non-blocking failure alone does not stop work');
ok(state(green()).verdict === 'PROCEED_WITH_RESTRICTIONS', 'green with open blockers: PROCEED_WITH_RESTRICTIONS');
ok(state(green()).closed_paths.includes('supabase/migrations/**'), 'and the closed paths are listed');
ok(state(green(), []).verdict === 'SAFE_TO_PROCEED', 'green with no blockers: SAFE_TO_PROCEED');
const many = state(green({ tree: { commit: 'abc', dirty: true }, profile: 'local' }));
ok(many.reasons.length >= 2, 'every NOT_SAFE reason is listed, not just the first');
const healedState = deriveEngineeringState({ verify: green(), blockers, policy, head: 'abc', now: 't',
  detections: { S1: { observable: true, still_present: false } } });
ok(healedState.blockers.find((b) => b.id === 'S1').status === 'HUMAN_REVIEW_REQUIRED' && healedState.autonomy.verdict === 'PROCEED_WITH_RESTRICTIONS',
   'a detector saying "resolved" changes neither the blocker nor the verdict');
ok(closedPaths(policy, blockers).length > policy.l3_paths.length, 'open blockers add to the closed paths');

console.log('--- human facts: only a person makes them true -----------------');

const catalog = load('autonomy/human-facts.json');
const rec = (over = {}) => ({ fact: BASELINE_FACT, status: 'verified', date: '2026-10-20', attested_by: 'J. Daly', via: 'awe-attest', ...over });
ok(validateRecord(rec(), catalog).length === 0, 'a complete attestation validates');
ok(validateRecord(rec({ attested_by: ' ' }), catalog).length > 0, 'an attestation with no named person is rejected');
ok(validateRecord(rec({ via: 'agent' }), catalog).length > 0, 'an attestation not written by awe-attest is rejected');
ok(validateRecord(rec({ fact: 'pcc_is_great' }), catalog).length > 0, 'an attestation of an uncatalogued fact is rejected');
ok(validateRecord(rec({ status: 'probably' }), catalog).length > 0, 'a status other than verified/refuted is rejected');
const ledger = [JSON.stringify(rec()), 'not json', JSON.stringify(rec({ fact: 's1_live_remediated', status: 'refuted' }))].join('\n');
const parsed = parseLedger(ledger, catalog);
ok(parsed.records.length === 2 && parsed.rejected.length === 1, 'a bad ledger line is reported, never silently dropped or trusted');
const resolved = resolveFacts(catalog, parsed.records, {});
ok(resolved.find((f) => f.id === BASELINE_FACT).state === 'HUMAN_VERIFIED', 'an attested fact is HUMAN_VERIFIED');
ok(resolved.find((f) => f.id === 's1_live_remediated').state === 'HUMAN_REFUTED', 'a checked-and-false fact is HUMAN_REFUTED, not UNKNOWN');
ok(resolved.find((f) => f.id === 'pcc_installed_at_lippolis').state === 'UNKNOWN', 'an unattested fact is UNKNOWN');
const machineOn = resolveFacts(catalog, [], { 'discovery-interview-records': { ok: true, detail: '1' }, 'anything': { ok: true } });
ok(machineOn.find((f) => f.id === 'stakeholder_interview_completed').state === 'MACHINE_VERIFIED', 'a fact with a machine check can be MACHINE_VERIFIED');
ok(machineOn.filter((f) => f.state === 'MACHINE_VERIFIED').length === catalog.facts.filter((f) => f.machine_check).length,
   'and ONLY a fact whose catalog entry names a machine check');
ok(catalog.facts.find((f) => f.id === BASELINE_FACT).machine_check === null, 'the baseline fact has no machine check: no record can stand in for Jack');
ok(resolveFacts(catalog, [JSON.parse(JSON.stringify(rec({ fact: 'stakeholder_interview_completed', status: 'refuted' })))],
   { 'discovery-interview-records': { ok: true } }).find((f) => f.id === 'stakeholder_interview_completed').state === 'HUMAN_REFUTED',
   'a person can refute what a record suggests');

console.log('--- the baseline gate cannot be forgotten or faked ---------------');

const none = baselineGate(resolveFacts(catalog, [], {}), { frozenBaselines: 0 });
ok(none.status === 'OPEN' && none.banner === BASELINE_BANNER, `with nothing attested: ${BASELINE_BANNER}`);
const frozenOnly = baselineGate(resolveFacts(catalog, [], {}), { frozenBaselines: 3 });
ok(frozenOnly.status === 'OPEN' && frozenOnly.warnings.length === 1,
   'frozen baseline files alone do NOT clear it: they cannot say the baseline predates the first purchase');
const attestedNoFile = baselineGate(resolveFacts(catalog, [rec()], {}), { frozenBaselines: 0 });
ok(attestedNoFile.status === 'CLEARED' && attestedNoFile.warnings.length === 1, 'attested but nothing frozen: cleared, with a warning');
ok(baselineGate(resolveFacts(catalog, [rec({ status: 'refuted' })], {})).status === 'OPEN', 'a refuted baseline keeps the gate open');
const ledgerFile = readFileSync(join(ROOT, 'autonomy/attestations.jsonl'), 'utf8');
const writers = readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs'))
  .map((f) => [f, readFileSync(join(ROOT, 'scripts', f), 'utf8')])
  .concat(readdirSync(join(ROOT, 'autonomy/lib')).map((f) => [`lib/${f}`, readFileSync(join(ROOT, 'autonomy/lib', f), 'utf8')]))
  .filter(([, src]) => /(appendFileSync|writeFileSync)\([^)]*(LEDGER|attestations\.jsonl)/.test(src)).map(([f]) => f);
ok(writers.length === 1 && writers[0] === 'awe-attest.mjs', 'awe-attest.mjs is the only code that writes the attestation ledger', writers.join(','));
ok(parseLedger(ledgerFile, catalog).rejected.length === 0, 'the committed ledger has no invalid lines');
const attestEnv = { ...process.env, CLAUDECODE: '1' };
const attest = spawnSync(process.execPath, [join(ROOT, 'scripts/awe-attest.mjs')], { encoding: 'utf8', env: attestEnv, input: '1\nverified\n\nbot\n\n\nyes\n' });
ok(attest.status === 2 && /refusing/.test(attest.stderr), 'npm run attest refuses an agent session, even with answers piped in', `exit ${attest.status}`);
const attestNoTty = spawnSync(process.execPath, [join(ROOT, 'scripts/awe-attest.mjs')], { encoding: 'utf8',
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !['CI', 'GITHUB_ACTIONS', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'].includes(k))), input: 'yes\n' });
ok(attestNoTty.status === 2, 'and refuses without an interactive terminal', `exit ${attestNoTty.status}`);
ok(readFileSync(join(ROOT, 'autonomy/attestations.jsonl'), 'utf8') === ledgerFile, 'and neither attempt wrote anything');
ok(reasons(['autonomy/attestations.jsonl']).some((x) => x.rule === 'l3'), 'the ledger is L3: no autonomous change may touch it');
ok(reasons(['autonomy/human-facts.json']).some((x) => x.rule === 'l3'), 'nor the catalog of what needs a human');

console.log('--- deployment readiness never says "production ready" -----------');

const rspec = load('autonomy/deployment-readiness.json');
const deployIds = new Set(selectSuites(registry, { profile: 'deploy' }).filter((x) => x.selected).map((x) => x.suite.id));
const evidenceIds = rspec.questions.flatMap((q) => [...q.evidence, ...(q.static_evidence ?? [])]);
ok(evidenceIds.every((id) => deployIds.has(id)), 'every readiness evidence suite runs in the deploy profile',
   evidenceIds.filter((id) => !deployIds.has(id)).join(','));
ok(['clean_install', 'install_twice', 'starts_after_install', 'persistence', 'backup_completes', 'restore_completes', 'restored_matches']
   .every((id) => rspec.questions.some((q) => q.id === id)), 'the seven deployment questions are all asked');
ok(rspec.questions.every((q) => q.does_not_prove && q.lippolis_facts.length), 'every question says what it does not prove, and which Lippolis fact closes the gap');
ok(rspec.questions.flatMap((q) => q.lippolis_facts).every((id) => catalog.facts.some((f) => f.id === id)), 'every Lippolis fact named is in the catalog');
const q0 = { evidence: ['a', 'b'] };
ok(answerQuestion(q0, new Map([['a', { status: 'PASS' }], ['b', { status: 'PASS' }]])).machine === 'VERIFIED', 'all evidence PASS: VERIFIED');
ok(answerQuestion(q0, new Map([['a', { status: 'PASS' }], ['b', { status: 'FAIL' }]])).machine === 'FAILED', 'one FAIL: FAILED');
ok(answerQuestion(q0, new Map([['a', { status: 'PASS' }], ['b', { status: 'BLOCKED' }]])).machine === 'UNVERIFIED', 'one BLOCKED: UNVERIFIED, not VERIFIED');
ok(answerQuestion(q0, new Map([['a', { status: 'PASS' }]])).machine === 'UNVERIFIED', 'a suite missing from the run: UNVERIFIED');
const allPass = { profile: 'deploy', tree: { commit: 'abc', dirty: false },
  suites: [...deployIds].map((id) => ({ id, status: 'PASS' })) };
const gateOk = { verdict: 'DEPLOY_ONLY', blockers: [{ path: 'network.hostname', owner: 'CUSTOMER_IT', phase: 'REQUIRED_BEFORE_GO_LIVE' }] };
const unknownFacts = resolveFacts(catalog, [], {});
const okRelease = { approved_commit: '585b749', signed_by: 'J', evidence_commit: 'abc', application_identical: true, application_differs: [], tooling_differs: [] };
const best = deriveReadiness({ spec: rspec, verify: allPass, gate: gateOk, facts: unknownFacts,
  baseline: baselineGate(unknownFacts), blockers, release: okRelease, now: 't' });
ok(best.install.verdict === 'READY_FOR_SUPERVISED_FIRST_INSTALL', 'everything green gives, at most, READY_FOR_SUPERVISED_FIRST_INSTALL');
ok(!JSON.stringify(best).includes('"PRODUCTION_READY"') && !/production ready/i.test(best.install.means), 'and nowhere says production ready');
ok(best.first_transaction.verdict === 'NOT_CLEARED' && best.banner === BASELINE_BANNER,
   'green machines do not clear the first real transaction while the baseline is unattested');
ok(best.questions.every((q) => q.lippolis === 'NOT_YET_PROVEN_AT_LIPPOLIS'), 'and every question still says it is not proven at Lippolis');
ok(best.preventing_deployment.some((p) => p.owner === 'CUSTOMER_IT'), 'IT-owned gate blockers are carried through with their owner');
ok(best.not_deployment_blockers.some((b) => b.id === 'S1'), 'S1 is stated as not gating the SQLite pilot, rather than silently omitted');
const oneFail = deriveReadiness({ spec: rspec, verify: { ...allPass, suites: allPass.suites.map((x) => x.id === 'restore-rehearsal' ? { ...x, status: 'FAIL', reason: 'exited 1' } : x) },
  gate: gateOk, facts: unknownFacts, baseline: baselineGate(unknownFacts), blockers, release: okRelease, now: 't' });
ok(oneFail.install.verdict === 'NOT_READY' && oneFail.questions.find((q) => q.id === 'restored_matches').machine === 'FAILED',
   'a failed restore makes the install NOT_READY and names the question');
const blockedImg = deriveReadiness({ spec: rspec, verify: { ...allPass, suites: allPass.suites.map((x) => x.id === 'clean-machine' ? { ...x, status: 'BLOCKED', reason: 'image absent' } : x) },
  gate: gateOk, facts: unknownFacts, baseline: baselineGate(unknownFacts), blockers, release: okRelease, now: 't' });
ok(blockedImg.install.verdict === 'MACHINE_EVIDENCE_INCOMPLETE', 'a blocked suite gives MACHINE_EVIDENCE_INCOMPLETE, never ready');
ok(deriveReadiness({ spec: rspec, verify: { ...allPass, tree: { commit: 'abc', dirty: true } }, gate: gateOk, facts: unknownFacts,
   baseline: baselineGate(unknownFacts), blockers, now: 't' }).install.verdict === 'NOT_READY', 'a dirty-tree run is not evidence');
ok(deriveReadiness({ spec: rspec, verify: allPass, gate: { verdict: 'BLOCKED_BEFORE_BUILD', blockers: [] }, facts: unknownFacts,
   baseline: baselineGate(unknownFacts), blockers, now: 't' }).install.verdict === 'NOT_READY', 'a gate that cannot reach deploy is NOT_READY');
ok(deriveReadiness({ spec: rspec, verify: allPass, gate: gateOk, facts: unknownFacts, baseline: baselineGate(unknownFacts), blockers,
   release: { ...okRelease, application_identical: false, application_differs: ['apps/purchasing/src/x.ts'] }, now: 't' }).install.verdict === 'NOT_READY',
   'evidence about application code that differs from the signed release does not count');
ok(deriveReadiness({ spec: rspec, verify: allPass, gate: gateOk, facts: unknownFacts, baseline: baselineGate(unknownFacts), blockers,
   release: null, now: 't' }).install.verdict === 'NOT_READY', 'and with no signed release nothing is ready to install');
const allAttested = resolveFacts(catalog, catalog.facts.map((f) => rec({ fact: f.id })), {});
ok(deriveReadiness({ spec: rspec, verify: allPass, gate: gateOk, facts: allAttested, baseline: baselineGate(allAttested, { frozenBaselines: 1 }),
   blockers, release: okRelease, now: 't' }).first_transaction.verdict === 'CLEARED', 'only with every first-transaction fact attested does it clear');
ok(preflight(suite({ requires: ['image:node:24-bookworm-slim'] }), probe({ hasImage: () => false }))[0]?.includes('not present'),
   'a missing base image is BLOCKED before the suite runs');
ok(preflight(suite({ requires: ['image:node:24-bookworm-slim'] }), probe({ dockerUp: false, hasImage: () => true })).length === 1,
   'and so is a present image with no daemon');

console.log('--- the verification layer cannot change anything --------------');

const sources = ['autonomy/lib/verify.mjs', 'autonomy/lib/state.mjs', 'autonomy/lib/guard.mjs',
  'autonomy/lib/detectors.mjs', 'autonomy/lib/git.mjs', 'scripts/awe-verify.mjs', 'scripts/awe-state.mjs', 'scripts/awe-guard.mjs',
  'autonomy/lib/attestations.mjs', 'autonomy/lib/human-evidence.mjs', 'autonomy/lib/readiness.mjs',
  'scripts/awe-readiness.mjs', 'scripts/awe-attest.mjs']
  .map((p) => [p, readFileSync(join(ROOT, p), 'utf8')]);
for (const [p, src] of sources) {
  ok(!/['"](push|commit|merge|rebase|reset|checkout|tag|fetch)['"]/.test(src), `${p} issues no mutating git command`);
  ok(!/\bfetch\(|https?:\/\/(?!localhost)/.test(src), `${p} makes no network call`);
}

console.log('');
for (const f of fails) console.log(`FAILED: ${f}`);
console.log(`autonomy checks: ${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
