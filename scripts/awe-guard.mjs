// ---------------------------------------------------------------------------
// awe-guard.mjs — refuse an autonomous change that touches what it may not.
//
//   node scripts/awe-guard.mjs --base origin/pcc-production     # diff base...HEAD
//   node scripts/awe-guard.mjs --paths supabase/x.sql --ref autonomy/test
//
// Checks every changed path and the branch against autonomy/policy.json (L3)
// and every open blocker in autonomy/blockers.json. Exit 1 with one line per
// violation, 0 when clean, 64 on usage error.
//
// It applies to AUTONOMOUS changes. A human-authored PR is not subject to it,
// because the humans are who the blockers escalate to. CI runs it only for
// branches with the autonomy prefix.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkChange } from '../autonomy/lib/guard.mjs';
import { git } from '../autonomy/lib/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);

const policy = JSON.parse(readFileSync(join(ROOT, 'autonomy/policy.json'), 'utf8'));
const { blockers } = JSON.parse(readFileSync(join(ROOT, 'autonomy/blockers.json'), 'utf8'));

let paths;
if (arg('paths')) paths = arg('paths').split(',').filter(Boolean);
else if (arg('base')) {
  const out = git(ROOT, ['diff', '--name-only', `${arg('base')}...HEAD`]);
  if (out === null) { console.error(`awe-guard: cannot diff ${arg('base')}...HEAD`); process.exit(64); }
  paths = out.split('\n').filter(Boolean);
} else {
  console.error('usage: awe-guard --base <ref> | --paths a,b [--ref <branch>]');
  process.exit(64);
}
// `||`, not `??`: on a push event GitHub sets GITHUB_HEAD_REF to the EMPTY
// string (it names a PR's head only on pull_request events), and `??` would
// keep that "" and refuse every autonomy branch. GITHUB_REF_NAME is the pushed
// branch. Found by the first autonomous cycle's CI run (2026-10-11).
const ref = arg('ref') || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || git(ROOT, ['rev-parse', '--abbrev-ref', 'HEAD']);

const violations = checkChange({ paths, ref }, policy, blockers);
for (const v of violations) console.log(`REFUSED  [${v.rule}] ${v.detail}`);
console.log(violations.length
  ? `awe-guard: ${violations.length} violation(s) across ${paths.length} changed path(s) on ${ref}`
  : `awe-guard: clean — ${paths.length} changed path(s) on ${ref}`);
process.exit(violations.length ? 1 : 0);
