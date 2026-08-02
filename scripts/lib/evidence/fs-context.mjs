// ---------------------------------------------------------------------------
// fs-context.mjs — the injected context the collectors run against.
//
// One small module holds every filesystem read and every child process. The
// collectors receive `{ root, run, read, list, exists }` and can therefore be
// driven in tests by an object literal — which is why the collector suite needs
// no temporary repository for most of its cases.
//
// READ-ONLY. `run` shells out only to `git`, and only to query commands; it
// returns null rather than throwing so a collector degrades to "unknown"
// instead of aborting the whole collection.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, sep } from 'node:path';

// Commands the collector is permitted to run. An allowlist rather than a
// denylist: a collector must never be the thing that mutates a repository.
const ALLOWED_GIT = new Set([
  'rev-parse', 'status', 'branch', 'tag', 'stash', 'worktree', 'log',
  'ls-files', 'remote', 'merge-base', 'rev-list', 'cat-file', 'diff',
]);

export function createFsContext(root) {
  return {
    root,
    run(cmd, args) {
      if (cmd !== 'git') throw new Error(`the evidence collector may only run git, not "${cmd}"`);
      if (!ALLOWED_GIT.has(args[0])) throw new Error(`git ${args[0]} is not an allowed query command`);
      try {
        return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        return null;
      }
    },
    read(rel) {
      try { return readFileSync(join(root, rel), 'utf8'); } catch { return null; }
    },
    list(rel) {
      try { return readdirSync(join(root, rel)); } catch { return []; }
    },
    exists(rel) { return existsSync(join(root, rel)); },
  };
}

export function writeJson(path, value) {
  mkdirSync(path.split(sep).slice(0, -1).join(sep) || '.', { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
