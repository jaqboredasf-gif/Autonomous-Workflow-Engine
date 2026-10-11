// ---------------------------------------------------------------------------
// diff.mjs — what a build changed, read by sha in the supervisor's repository.
//
// Never through the Builder's worktree (whose .git file it could rewrite), never
// with external diff drivers or textconv, renames split into delete + add, and
// each file's new mode kept (120000 symlink, 160000 submodule) so the
// evaluator can refuse them. Read-only.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { SAFE } from './hands.mjs';

/** -U0 diff of one path, as removed/added lines: hunk bodies only, never headers. */
function lineDiff(root, base, head, path) {
  const out = spawnSync('git', [...SAFE, 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', `${base}..${head}`, '--', path], { cwd: root, encoding: 'utf8' }).stdout;
  const removed = []; const added = [];
  let inHunk = false;
  for (const l of out.split('\n')) {
    if (l.startsWith('diff --git ')) { inHunk = false; continue; }
    if (l.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (l.startsWith('-')) removed.push(l.slice(1)); else if (l.startsWith('+')) added.push(l.slice(1));
  }
  return { removed, added };
}
/** Computed in the supervisor's repository by sha, never through the Builder's worktree. */
export function changesOf(root, base, head) {
  // --raw gives the new mode too: 120000 is a symlink, 160000 a submodule.
  const raw = spawnSync('git', [...SAFE, 'diff', '--raw', '-z', '--no-renames', '--no-ext-diff', `${base}..${head}`], { cwd: root, encoding: 'utf8' }).stdout;
  const parts = raw.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // ":<old mode> <new mode> <old sha> <new sha> <status>"
    const [, newMode, , , status] = parts[i].split(' ');
    const path = parts[i + 1];
    out.push({ status, path, mode: newMode, ...lineDiff(root, base, head, path) });
  }
  return out;
}
