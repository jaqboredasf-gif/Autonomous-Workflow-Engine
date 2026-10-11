// ---------------------------------------------------------------------------
// hands.mjs — the only module in autonomy/ that changes git state.
//
// Everything else in autonomy/lib judges. This creates the Builder's worktree,
// commits what the Builder left there, and pushes it. Each act refuses what the
// policy refuses, before git is asked:
//
//   · a branch outside the autonomy prefix, or one an open blocker closes;
//   · a commit containing any path outside the package's allowed_files,
//     including either side of a rename (nothing is committed unless every
//     path qualifies, and the index is re-checked after staging);
//   · a push that is not a plain fast-forward of that one autonomy branch, to
//     the URL recorded when the cycle started: no force, no other refspec.
//
// THE BUILDER SHARES A REPOSITORY WITH THE SUPERVISOR, so it could write git
// config (core.fsmonitor, diff.external, a pushurl) or rewrite its worktree's
// `.git` file to point somewhere else, and have the supervisor's next git
// command run its code or report its numbers. So every command here names its
// git dir and work tree explicitly, disables hooks, fsmonitor, external diff
// and textconv, and the cycle refuses to continue if the shared config or the
// worktree's admin files changed since it started (configFingerprint).
//
// It never merges, rebases, resets, deletes a branch, or touches the product
// line. A merge is a person's act.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkChange } from './guard.mjs';

export const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const exec = (cwd, args) => execFileSync('git', [...SAFE, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const run = (cwd, args) => exec(cwd, args).trim();
/** A command against the Builder's worktree, never trusting its `.git` file. */
const inTree = (wt, args) => exec(wt.path, [`--git-dir=${wt.gitDir}`, `--work-tree=${wt.path}`, ...args]);

function refuseRef(branch, policy, blockers) {
  const v = checkChange({ paths: [], ref: branch }, policy, blockers);
  if (v.length) throw new Error(`hands: refusing ${branch}: ${v.map((x) => x.detail).join('; ')}`);
}

/**
 * The files whose change would let the Builder steer git: the shared config
 * and the worktree's admin files. Hashed at start, compared before every act.
 */
export function configFingerprint(root, gitDir) {
  const common = run(root, ['rev-parse', '--git-common-dir']);
  const abs = resolve(root, common);
  const files = [join(abs, 'config'), join(abs, 'info', 'attributes'), join(abs, 'commondir'),
    ...(gitDir ? ['config', 'config.worktree', 'commondir', 'gitdir'].map((f) => join(gitDir, f)) : [])];
  const h = createHash('sha256');
  for (const f of files) h.update(`${f}\0${existsSync(f) ? readFileSync(f, 'utf8') : '<absent>'}\0`);
  return h.digest('hex');
}

/** A fresh worktree at `path` on a NEW branch cut from the base COMMIT. Returns its identity. */
export function createWorktree(root, { path, branch, base }, policy, blockers) {
  refuseRef(branch, policy, blockers);
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('hands: base must be a full commit sha');
  run(root, ['worktree', 'add', '-b', branch, path, base]);
  const gitDir = resolve(path, run(path, ['rev-parse', '--git-dir']));
  return { path, gitDir, head: run(path, ['rev-parse', 'HEAD']), dotgit: readFileSync(join(path, '.git'), 'utf8') };
}

/** Raises if the worktree's `.git` file no longer says what createWorktree wrote. */
export function checkWorktreeIdentity(wt) {
  const now = existsSync(join(wt.path, '.git')) ? readFileSync(join(wt.path, '.git'), 'utf8') : '<absent>';
  if (now !== wt.dotgit) throw new Error(`hands: ${wt.path}/.git was rewritten; refusing to act on that worktree`);
}

/** NUL-separated porcelain, renames split into delete + add, nothing trimmed. */
function statusPaths(wt) {
  const out = inTree(wt, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']);
  return out.split('\0').filter(Boolean).map((e) => e.slice(3));
}

/** Paths the Builder changed since `since` (committed or not, untracked included, both sides of renames). */
export function changedPaths(wt, since) {
  const committed = inTree(wt, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', `${since}..HEAD`]).split('\0').filter(Boolean);
  return [...new Set([...committed, ...statusPaths(wt)])].sort();
}

/**
 * Commit everything the Builder left, if and only if every path is allowed.
 * The Builder must not commit: a commit of its own could carry history (a file
 * added, then removed) that the final diff never shows, and it would be
 * pushed. `since` is the last commit the RUNNER made (the base on attempt 1).
 */
export function commitBuild(wt, { branch, since, allowed, message, author }, policy, blockers) {
  refuseRef(branch, policy, blockers);
  checkWorktreeIdentity(wt);
  const current = inTree(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (current !== branch) throw new Error(`hands: worktree is on ${current}, not ${branch}`);
  const own = inTree(wt, ['rev-list', `${since}..HEAD`]).split('\n').filter(Boolean);
  if (own.length) return { committed: false, outside: [], builder_commits: own, paths: changedPaths(wt, since) };
  const paths = changedPaths(wt, since);
  const outside = paths.filter((p) => !allowed.includes(p));
  if (outside.length) return { committed: false, outside, paths };
  if (paths.length) {
    inTree(wt, ['add', '-A', '--', ...paths]);
    // Re-check what is actually staged, by both sides of any rename.
    const staged = inTree(wt, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--no-ext-diff', since]).split('\0').filter(Boolean);
    const stagedOutside = staged.filter((p) => !allowed.includes(p));
    if (stagedOutside.length) return { committed: false, outside: stagedOutside, paths: staged };
    inTree(wt, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '--no-verify', '-m', message]);
  }
  return { committed: true, outside: [], paths, head: inTree(wt, ['rev-parse', 'HEAD']).trim() };
}

/** Push exactly HEAD to exactly refs/heads/<branch> at `url`. A non-fast-forward push stays rejected. */
export function pushBranch(wt, { branch, url }, policy, blockers) {
  refuseRef(branch, policy, blockers);
  checkWorktreeIdentity(wt);
  if (!url || /^-/.test(url)) throw new Error('hands: a push needs the remote URL recorded at the start of the cycle');
  const current = inTree(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (current !== branch) throw new Error(`hands: worktree is on ${current}, not ${branch}`);
  inTree(wt, ['push', '--no-tags', '--no-verify', url, `HEAD:refs/heads/${branch}`]);
  return inTree(wt, ['rev-parse', 'HEAD']).trim();
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
