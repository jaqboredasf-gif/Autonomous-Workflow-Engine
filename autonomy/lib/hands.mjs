// ---------------------------------------------------------------------------
// hands.mjs — the only module in autonomy/ that changes git state.
//
// Everything else in autonomy/lib judges. This creates the Builder's worktree,
// commits what the Builder left there, and pushes it. Each act refuses what the
// policy refuses, before git is asked:
//
//   · a branch outside the autonomy prefix, or one an open blocker closes;
//   · a commit containing any path outside the package's allowed_files
//     (nothing is staged unless every path qualifies);
//   · a push that is not a plain fast-forward of that one autonomy branch:
//     no force, no other refspec, no tags.
//
// It never merges, rebases, resets, deletes a branch, or touches the product
// line. A merge is a person's act.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { checkChange } from './guard.mjs';

const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function refuseRef(branch, policy, blockers) {
  const v = checkChange({ paths: [], ref: branch }, policy, blockers);
  if (v.length) throw new Error(`hands: refusing ${branch}: ${v.map((x) => x.detail).join('; ')}`);
}

/** A fresh worktree at `path` on a NEW branch cut from the base COMMIT. */
export function createWorktree(root, { path, branch, base }, policy, blockers) {
  refuseRef(branch, policy, blockers);
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('hands: base must be a full commit sha');
  run(root, ['worktree', 'add', '-b', branch, path, base]);
  return run(path, ['rev-parse', 'HEAD']);
}

/** Paths the Builder changed relative to base, committed or not (untracked included). */
export function changedPaths(worktree, base) {
  const committed = run(worktree, ['diff', '--name-only', `${base}..HEAD`]).split('\n').filter(Boolean);
  const pending = run(worktree, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, ''));
  return [...new Set([...committed, ...pending])].sort();
}

/** Commit everything the Builder left, if and only if every path is allowed. */
export function commitBuild(worktree, { branch, base, allowed, message, author }, policy, blockers) {
  refuseRef(branch, policy, blockers);
  const current = run(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== branch) throw new Error(`hands: worktree is on ${current}, not ${branch}`);
  const paths = changedPaths(worktree, base);
  const outside = paths.filter((p) => !allowed.includes(p));
  if (outside.length) return { committed: false, outside, paths };
  const pending = run(worktree, ['status', '--porcelain', '--untracked-files=all']);
  if (pending) {
    run(worktree, ['add', '--', ...allowed.filter((p) => paths.includes(p))]);
    run(worktree, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '-m', message]);
  }
  return { committed: true, outside: [], paths, head: run(worktree, ['rev-parse', 'HEAD']) };
}

/** Push exactly HEAD to exactly refs/heads/<branch>. A rejected (non-fast-forward) push stays rejected. */
export function pushBranch(worktree, { branch, remote = 'origin' }, policy, blockers) {
  refuseRef(branch, policy, blockers);
  const current = run(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== branch) throw new Error(`hands: worktree is on ${current}, not ${branch}`);
  run(worktree, ['push', '--no-tags', remote, `HEAD:refs/heads/${branch}`]);
  return run(worktree, ['rev-parse', 'HEAD']);
}
