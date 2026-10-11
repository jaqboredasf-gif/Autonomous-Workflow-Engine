// ---------------------------------------------------------------------------
// verify.mjs — what ran, and what happened, as a file nobody had to believe.
//
// Before this, "the tests pass" in this repository meant a session said so.
// Nothing re-ran anything on a push, and the session that wrote the code was
// the session that reported on it. This module turns the registry
// (autonomy/suites.json) into a result file that records, per suite, the
// command, the times, the exit code and a verdict a reader can audit.
//
// FOUR VERDICTS, and the line between FAIL and BLOCKED is the whole design:
//
//   PASS     the suite ran and exited 0.
//   FAIL     the suite ran and did not pass. Includes timeouts and crashes.
//   BLOCKED  the suite could not be run meaningfully HERE: a declared
//            requirement is unmet, a prerequisite suite did not pass, or the
//            suite itself exited with an exit code it documents as "my
//            environment is missing" (this repository's convention is 2).
//   SKIPPED  not selected for this run (profile or --only). Always listed
//            with the reason. Never silent.
//
// BLOCKED IS DECIDED BEFORE THE SUITE RUNS, or by the suite's own declared
// exit code. It is never decided by reading a log. A log heuristic that turns
// "Cannot find module" into BLOCKED would also turn a genuinely broken import
// into BLOCKED, which is converting a failure into something softer. That is
// exactly the lie this file exists to prevent. So a crash after every
// requirement checked out is a FAIL, whatever the crash says.
//
// The classification rules are pure (`classify`, `preflight`) and tested
// directly by scripts/eval-autonomy.mjs. Only `runSuite` touches processes.
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const STATUSES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'SKIPPED']);
const CATEGORIES = new Set(['unit', 'integration', 'security', 'typecheck', 'lint', 'build',
  'deployment', 'evidence', 'measurement', 'rehearsal', 'live']);
const CRITICALITY = new Set(['critical', 'high', 'normal', 'low']);
const AUTHORITY = new Set(['authoritative', 'advisory', 'measurement']);
const REQUIREMENT = /^(deps|nonroot|docker-daemon|tool:[a-z0-9._-]+|env:[A-Z0-9_]+|image:[a-z0-9./_-]+:[A-Za-z0-9._-]+)$/;

/** The suite whose artifact every requires_build suite depends on. */
export const BUILD_SUITE = 'purchasing-build';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every problem with a registry, as strings. An invalid registry is a FAIL of
 * the whole run: a run against a registry nobody can trust proves nothing.
 */
export function validateRegistry(reg, { root, exists = existsSync } = {}) {
  const errors = [];
  if (!reg || !Array.isArray(reg.suites)) return ['registry has no suites array'];
  const ids = new Set();
  for (const [i, s] of reg.suites.entries()) {
    const at = `suites[${i}]${s?.id ? ` (${s.id})` : ''}`;
    for (const f of ['id', 'name', 'entry', 'command', 'category', 'area', 'requires', 'offline',
      'requires_build', 'timeout_s', 'criticality', 'blocking', 'authority', 'profiles']) {
      if (s[f] === undefined) errors.push(`${at}: missing ${f}`);
    }
    if (ids.has(s.id)) errors.push(`${at}: duplicate id`);
    ids.add(s.id);
    if (!Array.isArray(s.command) || s.command.length === 0) errors.push(`${at}: command must be a non-empty array`);
    if (s.category && !CATEGORIES.has(s.category)) errors.push(`${at}: unknown category ${s.category}`);
    if (s.criticality && !CRITICALITY.has(s.criticality)) errors.push(`${at}: unknown criticality ${s.criticality}`);
    if (s.authority && !AUTHORITY.has(s.authority)) errors.push(`${at}: unknown authority ${s.authority}`);
    if (!(Number.isFinite(s.timeout_s) && s.timeout_s > 0)) errors.push(`${at}: timeout_s must be positive`);
    for (const r of s.requires ?? []) if (!REQUIREMENT.test(r)) errors.push(`${at}: unknown requirement ${r}`);
    if (typeof s.blocking !== 'boolean') errors.push(`${at}: blocking must be boolean`);
    if (s.live_writes && s.profiles?.some((p) => p !== 'live-human-only')) {
      errors.push(`${at}: a suite that writes to a live system may only be in profile live-human-only`);
    }
    if (s.blocking && !(s.profiles ?? []).includes('ci')) {
      errors.push(`${at}: blocking suites must run in CI, or "blocking" means nothing`);
    }
    if (!(s.profiles ?? []).includes('ci') && !s.ci_excluded_because) {
      errors.push(`${at}: excluded from CI without ci_excluded_because`);
    }
    if (root) {
      for (const p of [s.entry, ...(s.components ?? [])]) {
        if (p && !exists(join(root, p))) errors.push(`${at}: ${p} does not exist`);
      }
    }
  }
  if (root && reg.suites.some((s) => s.requires_build) && !ids.has(BUILD_SUITE)) {
    errors.push(`suites require a build but no ${BUILD_SUITE} suite is registered`);
  }
  return errors;
}

/**
 * Which suites this run includes, and an explicit reason for each it does not.
 * Registry order is execution order; the build suite precedes its dependants.
 */
export function selectSuites(reg, { profile = 'ci', only = null } = {}) {
  return reg.suites.map((s) => {
    if (only && only.length) {
      return only.includes(s.id)
        ? { suite: s, selected: true }
        : { suite: s, selected: false, reason: `not named by --only (${only.join(', ')})` };
    }
    if (profile === 'all') return { suite: s, selected: !s.live_writes, reason: s.live_writes ? 'writes to a live system; never run by awe-verify --profile all' : undefined };
    return s.profiles.includes(profile)
      ? { suite: s, selected: true }
      : { suite: s, selected: false,
          reason: `not in profile "${profile}" (profiles: ${s.profiles.join(', ')})${s.ci_excluded_because ? ` — ${s.ci_excluded_because}` : ''}` };
  });
}

// ---------------------------------------------------------------------------
// Preflight: the only way a suite becomes BLOCKED before it runs
// ---------------------------------------------------------------------------

/** Node version check against a ">=N" range. Only the major is compared. */
export function nodeSatisfies(range, version) {
  const m = /^>=\s*(\d+)/.exec(range ?? '');
  if (!m) return true;
  return Number(/^v?(\d+)/.exec(version)?.[1] ?? 0) >= Number(m[1]);
}

/**
 * Unmet requirements for one suite, given an environment probe. The probe is
 * injected so the rules are testable without the environment they describe.
 *
 * probe: { node, nodeRange, env, isRoot, depsInstalled, hasTool(name), dockerUp, hasImage(ref),
 *          buildStatus /* status of BUILD_SUITE in this run, or null *\/, artifactExists }
 */
export function preflight(suite, probe) {
  const unmet = [];
  if (!nodeSatisfies(probe.nodeRange, probe.node)) unmet.push(`node ${probe.nodeRange} required, found ${probe.node}`);
  for (const r of suite.requires) {
    if (r === 'deps' && !probe.depsInstalled) unmet.push('dependencies not installed (run npm ci)');
    else if (r === 'nonroot' && probe.isRoot) unmet.push('must run as a non-root user');
    else if (r === 'docker-daemon' && !probe.dockerUp) unmet.push('no reachable Docker daemon');
    else if (r.startsWith('tool:') && !probe.hasTool(r.slice(5))) unmet.push(`${r.slice(5)} not on PATH`);
    else if (r.startsWith('env:') && !probe.env[r.slice(4)]) unmet.push(`${r.slice(4)} not set`);
    // A base image must already be on the machine. Whether it can be PULLED is
    // a network question with a rate limit attached; asking it here would make
    // BLOCKED depend on the weather. CI pulls first, as its own visible step.
    else if (r.startsWith('image:') && !(probe.dockerUp && probe.hasImage(r.slice(6)))) unmet.push(`image ${r.slice(6)} not present locally`);
  }
  if (suite.requires_build) {
    if (probe.buildStatus && probe.buildStatus !== 'PASS') {
      unmet.push(`prerequisite ${BUILD_SUITE} is ${probe.buildStatus} in this run`);
    } else if (!probe.buildStatus && !probe.artifactExists) {
      unmet.push(`no production build present and ${BUILD_SUITE} is not part of this run`);
    }
  }
  return unmet;
}

/**
 * The verdict for a suite that was started. Pure.
 *   outcome: { exitCode, signal, timedOut, spawnError }
 */
export function classify(suite, outcome) {
  if (outcome.spawnError) {
    return { status: 'BLOCKED', reason: `could not start ${suite.command[0]}: ${outcome.spawnError}` };
  }
  if (outcome.timedOut) {
    return { status: 'FAIL', reason: `timed out after ${suite.timeout_s}s; killed` };
  }
  if (outcome.exitCode === 0) return { status: 'PASS', reason: 'exited 0' };
  if (outcome.exitCode !== null && (suite.env_exit_codes ?? []).includes(outcome.exitCode)) {
    return { status: 'BLOCKED', reason: `suite reported its environment unavailable (declared exit ${outcome.exitCode})` };
  }
  if (outcome.signal) return { status: 'FAIL', reason: `killed by ${outcome.signal}` };
  return { status: 'FAIL', reason: `exited ${outcome.exitCode}` };
}

/** Run-level verdict and exit code. A non-blocking suite never changes either. */
export function summarize(results) {
  const summary = { pass: 0, fail: 0, blocked: 0, skipped: 0, blocking_fail: 0, blocking_blocked: 0 };
  for (const r of results) {
    summary[r.status.toLowerCase()]++;
    if (r.blocking && r.status === 'FAIL') summary.blocking_fail++;
    if (r.blocking && r.status === 'BLOCKED') summary.blocking_blocked++;
  }
  const verdict = summary.blocking_fail ? 'FAIL' : summary.blocking_blocked ? 'BLOCKED' : 'PASS';
  return { summary, verdict, exitCode: verdict === 'FAIL' ? 1 : verdict === 'BLOCKED' ? 3 : 0 };
}

// ---------------------------------------------------------------------------
// The environment probe and the process runner (I/O)
// ---------------------------------------------------------------------------

/** True when every workspace link in package-lock.json is installed. */
export function depsInstalled(root) {
  if (!existsSync(join(root, 'node_modules', '.package-lock.json'))) return false;
  try {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    return Object.entries(lock.packages ?? {})
      .filter(([k, v]) => k.startsWith('node_modules/') && v.link)
      .every(([k]) => existsSync(join(root, k)));
  } catch { return false; }
}

export function probeEnvironment(root, nodeRange) {
  const toolCache = new Map();
  let dockerCache = null;
  return {
    node: process.version,
    nodeRange,
    env: process.env,
    isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
    depsInstalled: depsInstalled(root),
    hasTool: (t) => {
      if (!toolCache.has(t)) toolCache.set(t, spawnSync('sh', ['-c', `command -v ${t}`], { stdio: 'ignore' }).status === 0);
      return toolCache.get(t);
    },
    get dockerUp() {
      // Asked at most once per run; `docker info` can take seconds to refuse.
      if (dockerCache === null) dockerCache = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20000 }).status === 0;
      return dockerCache;
    },
    hasImage: (ref) => spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore', timeout: 20000 }).status === 0,
    artifactExists: existsSync(join(root, 'apps/purchasing/.next/standalone/apps/purchasing/server.js')),
  };
}

/**
 * Run one suite in its own process group, so a timeout kills everything it
 * started (servers included). Output goes to a log file; the last lines are
 * kept for the result.
 */
export function runSuite(suite, { root, logDir }) {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${suite.id}.log`);
  const log = createWriteStream(logPath);
  const tail = [];
  const keep = (buf) => {
    for (const line of buf.toString().split('\n')) if (line.trim()) tail.push(line);
    if (tail.length > 40) tail.splice(0, tail.length - 40);
  };
  const started = new Date();
  return new Promise((resolve) => {
    let timedOut = false;
    let child;
    try {
      child = spawn(suite.command[0], suite.command.slice(1), {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
    } catch (e) {
      log.end();
      return resolve({ started, finished: new Date(), logPath, tail, outcome: { spawnError: e.message } });
    }
    let spawnError = null;
    child.on('error', (e) => { spawnError = e.message; });
    child.stdout.on('data', (b) => { log.write(b); keep(b); });
    child.stderr.on('data', (b) => { log.write(b); keep(b); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, suite.timeout_s * 1000);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      // Reap anything the suite left running (a server it forgot to stop).
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already empty */ }
      log.end();
      resolve({ started, finished: new Date(), logPath, tail,
        outcome: { exitCode, signal, timedOut, spawnError } });
    });
  });
}
