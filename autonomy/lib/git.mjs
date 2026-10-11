// ---------------------------------------------------------------------------
// git.mjs — the facts about the tree a result is attached to.
//
// A verification result means something only if somebody can say which code
// produced it. So every result records the commit, whether the working tree
// was clean, and, in GitHub Actions, the commit the event was actually about
// (a pull_request checkout is a merge commit, not the head of the branch).
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';

export function git(root, args) {
  try {
    // Hooks and fsmonitor off: a Builder sharing this repository could have
    // configured either to run code on the supervisor's next read.
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

export function treeFacts(root, env = process.env) {
  const status = git(root, ['status', '--porcelain', '--untracked-files=normal']);
  const dirtyPaths = status ? status.split('\n').filter(Boolean).map((l) => l.slice(3)) : [];
  return {
    commit: git(root, ['rev-parse', 'HEAD']),
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: status === null ? null : dirtyPaths.length > 0,
    dirty_paths: dirtyPaths.slice(0, 50),
    ci: env.GITHUB_ACTIONS === 'true'
      ? {
          provider: 'github-actions',
          event: env.GITHUB_EVENT_NAME ?? null,
          sha: env.GITHUB_SHA ?? null,
          ref: env.GITHUB_REF ?? null,
          run_id: env.GITHUB_RUN_ID ?? null,
          run_attempt: env.GITHUB_RUN_ATTEMPT ?? null,
          repository: env.GITHUB_REPOSITORY ?? null,
        }
      : null,
  };
}
