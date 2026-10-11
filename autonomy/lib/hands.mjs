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

// Hooks never run: a Builder that wrote a hook (or a hooksPath) must not get
// code executed by the runner's commit or push.
const run = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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

/**
 * Commit everything the Builder left, if and only if every path is allowed.
 * The Builder must not commit: a commit of its own could carry history (a file
 * added, then removed) that the final diff never shows, and it would be pushed.
 */
export function commitBuild(worktree, { branch, base, allowed, message, author }, policy, blockers) {
  refuseRef(branch, policy, blockers);
  const current = run(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== branch) throw new Error(`hands: worktree is on ${current}, not ${branch}`);
  const own = run(worktree, ['rev-list', `${base}..HEAD`]).split('\n').filter(Boolean);
  if (own.length) return { committed: false, outside: [], builder_commits: own, paths: changedPaths(worktree, base) };
  const paths = changedPaths(worktree, base);
  const outside = paths.filter((p) => !allowed.includes(p));
  if (outside.length) return { committed: false, outside, paths };
  const pending = run(worktree, ['status', '--porcelain', '--untracked-files=all']);
  if (pending) {
    run(worktree, ['add', '--', ...allowed.filter((p) => paths.includes(p))]);
    run(worktree, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '--no-verify', '-m', message]);
  }
  return { committed: true, outside: [], paths, head: run(worktree, ['rev-parse', 'HEAD']) };
}

/** Push exactly HEAD to exactly refs/heads/<branch>. A rejected (non-fast-forward) push stays rejected. */
export function pushBranch(worktree, { branch, remote = 'origin' }, policy, blockers) {
  refuseRef(branch, policy, blockers);
  const current = run(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== branch) throw new Error(`hands: worktree is on ${current}, not ${branch}`);
  run(worktree, ['push', '--no-tags', '--no-verify', remote, `HEAD:refs/heads/${branch}`]);
  return run(worktree, ['rev-parse', 'HEAD']);
}

/**
 * A clean, detached checkout of exactly `commit`, for the evaluator. The
 * Builder's worktree may hold ignored or uncommitted files that the pushed
 * commit does not; the verdict is about the commit.
 */
export function checkoutForEvaluation(root, { commit, path }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('hands: commit must be a full sha');
  run(root, ['worktree', 'add', '--detach', path, commit]);
  return run(path, ['rev-parse', 'HEAD']);
}
export function removeEvaluationCheckout(root, path) {
  if (!/[/\\]\.awe[/\\]eval[/\\]/.test(path)) throw new Error(`hands: refusing to remove ${path}: not an evaluation checkout`);
  run(root, ['worktree', 'remove', '--force', path]);
}
