// ---------------------------------------------------------------------------
// fs-sources.mjs — the I/O boundary.
//
// Everything else in this directory is pure. This file is the only place that
// reads the filesystem or shells out to Git, which is why it is small and dull
// on purpose: when the compiler eventually moves behind a service boundary, this
// is the module that gets replaced, and nothing above it has to change.
//
// Precedent: scripts/lib/artifact-store.mjs did exactly this move when the MCP
// server needed the sinks — the pure part relocated into a package, the entry
// point stayed. Same shape, deliberately.
//
// READ-ONLY. Every git invocation here is a query. No fetch, no write, no ref
// mutation. `collectAll()` never contacts a network.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';

import {
  fromCognition, fromEvidenceDoc, fromGit, fromPackages, fromDecision,
  fromMigrations, fromTests, fromDispatch, fromObjective,
} from './adapters.mjs';

const git = (root, args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const posix = (p) => p.split(sep).join('/');

export function readGitState(root) {
  const remote = git(root, ['remote', 'get-url', 'origin']);
  const repository = remote
    ? remote.replace(/^.*[/:]([^/]+\/[^/]+?)(?:\.git)?$/, '$1')
    : 'unknown';
  const porcelain = git(root, ['status', '--porcelain']);
  const dirty_files = porcelain ? porcelain.split('\n').map((l) => l.slice(3).trim()).filter(Boolean) : [];
  const branchList = git(root, ['branch', '-a', '--format=%(refname:short)']);
  const branches = branchList
    ? branchList.split('\n').map((b) => b.replace(/^origin\//, '').trim()).filter((b) => b && !b.includes('->'))
    : [];
  return {
    repository,
    branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
    commit: git(root, ['rev-parse', 'HEAD']) || 'unknown',
    dirty_files,
    branches: [...new Set(branches)].sort(),
  };
}

function listMarkdown(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile());
}

/** Every tracked-ish path in the repo, for missing-reference detection. */
export function collectKnownPaths(root) {
  const out = new Set();
  const listed = git(root, ['ls-files']);
  if (listed) for (const p of listed.split('\n')) out.add(p.trim());
  return out;
}

export function collectPackages(root) {
  const dir = join(root, 'packages');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((d) => {
    const pkgJson = join(dir, d, 'package.json');
    if (!existsSync(pkgJson)) return [];
    const meta = JSON.parse(readFileSync(pkgJson, 'utf8'));
    const srcDir = join(dir, d, 'src');
    const modules = existsSync(srcDir) ? readdirSync(srcDir).filter((f) => /\.(mjs|js|ts)$/.test(f)) : [];
    return [{
      dir: d,
      name: meta.name || d,
      version: meta.version || '0.0.0',
      path: posix(relative(root, pkgJson)),
      modules,
      module_count: modules.length,
    }];
  });
}

export function collectMigrations(root) {
  const dir = join(root, 'supabase', 'migrations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => {
    const p = join(dir, f);
    const text = readFileSync(p, 'utf8');
    return {
      name: f.replace(/\.sql$/, ''),
      ordinal: (/^(\d+)/.exec(f) || [null, 'n/a'])[1],
      path: posix(relative(root, p)),
      lines: text.split('\n').length,
    };
  });
}

/**
 * Suite inventory. Read from the kernel registry when it is available so the
 * compiler and scripts/regression.sh agree on one list; falls back to a
 * filesystem scan so the compiler still works on a branch without the registry.
 */
export async function collectSuites(root) {
  const registryPath = join(root, 'packages', 'awe-kernel', 'src', 'registry.mjs');
  if (existsSync(registryPath)) {
    try {
      const mod = await import(`file://${registryPath.split(sep).join('/')}`);
      const suites = mod.SUITES || (mod.registry && mod.registry.list && mod.registry.list()) || [];
      if (Array.isArray(suites) && suites.length) {
        return suites.map((s) => ({
          name: s.name || s.id || 'unnamed',
          kind: s.kind || 'unknown',
          runner: s.runner || null,
          path: s.script ? posix(s.script) : `packages/awe-kernel/src/registry.mjs#${s.name || s.id}`,
        }));
      }
    } catch {
      // fall through to the scan — a registry we cannot import is not fatal
    }
  }
  const dir = join(root, 'scripts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^(eval|acceptance)-.*\.sh$/.test(f)).map((f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    const runner = (/Runner ([A-Z0-9-]+)/.exec(text) || [null, null])[1];
    const live = /SUPABASE|credential-gated|LIVE/.test(text) && !/CREDENTIAL-FREE|credential-free/.test(text);
    return { name: f.replace(/\.sh$/, ''), kind: live ? 'db' : 'offline', runner, path: `scripts/${f}` };
  });
}

/**
 * Read every context source and return normalized records.
 * The only function in the compiler that touches disk on the caller's behalf.
 */
export async function collectAll(root, { objective, taskId = null }) {
  const records = [];

  records.push(...fromObjective(objective, taskId));

  const gitState = readGitState(root);
  records.push(...fromGit({ ...gitState, observed_at: null }));

  for (const p of listMarkdown(join(root, 'context'))) {
    records.push(...fromCognition(posix(relative(root, p)), readFileSync(p, 'utf8')));
  }
  for (const p of listMarkdown(join(root, 'docs', 'integration'))) {
    records.push(...fromEvidenceDoc(posix(relative(root, p)), readFileSync(p, 'utf8')));
  }
  for (const p of listMarkdown(join(root, 'docs', 'architecture', 'decisions'))) {
    if (/README/.test(p)) continue;
    records.push(...fromDecision(posix(relative(root, p)), readFileSync(p, 'utf8')));
  }
  const queue = join(root, 'docs', 'integration', 'dispatch', 'QUEUE.md');
  if (existsSync(queue)) {
    records.push(...fromDispatch(posix(relative(root, queue)), readFileSync(queue, 'utf8')));
  }

  records.push(...fromPackages(collectPackages(root)));
  records.push(...fromMigrations(collectMigrations(root)));
  records.push(...fromTests(await collectSuites(root)));

  return { records, git: gitState };
}
