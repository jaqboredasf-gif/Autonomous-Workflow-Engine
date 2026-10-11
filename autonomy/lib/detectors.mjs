// ---------------------------------------------------------------------------
// detectors.mjs — observe a known blocker; never act on it.
//
// Each detector reports what this environment can SEE about a blocker in
// autonomy/blockers.json. A detector can say a blocker looks resolved. It
// cannot resolve one: `status` changes only when a human edits the record, so
// a detector that is wrong in the optimistic direction costs a line in a
// report, not a repaired database.
//
// "UNOBSERVABLE" is a first-class answer. The hosted Supabase project is
// unreachable from here, and a detector that guessed would be worse than one
// that says so.
//
// The decision functions are pure (`findMigrationCollisions`); the I/O is
// git reads only.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.mjs';

/**
 * Given { ref: [migration filenames] }, every migration number used for more
 * than one distinct file name across refs. Pure.
 */
export function findMigrationCollisions(byRef) {
  const byNumber = new Map();
  for (const [ref, files] of Object.entries(byRef)) {
    for (const f of files) {
      const m = /^(\d{4})_(.+)\.sql$/.exec(f);
      if (!m) continue;
      if (!byNumber.has(m[1])) byNumber.set(m[1], new Map());
      const names = byNumber.get(m[1]);
      if (!names.has(m[2])) names.set(m[2], []);
      names.get(m[2]).push(ref);
    }
  }
  return [...byNumber.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([number, names]) => ({ number, variants: [...names.entries()].map(([name, refs]) => ({ name, refs })) }))
    .sort((a, b) => a.number.localeCompare(b.number));
}

function remoteRefs(root) {
  const out = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']);
  return out ? out.split('\n').filter((r) => r && r !== 'origin/HEAD' && r !== 'origin') : [];
}

const DETECTORS = {
  'migration-number-collision'(root) {
    const refs = remoteRefs(root);
    if (refs.length < 2) {
      return { observable: false, reason: `only ${refs.length} remote branch(es) fetched; fetch all branches to observe` };
    }
    const byRef = {};
    for (const ref of refs) {
      const out = git(root, ['ls-tree', '--name-only', `${ref}:supabase/migrations`]);
      if (out) byRef[ref] = out.split('\n').filter(Boolean);
    }
    const collisions = findMigrationCollisions(byRef);
    return {
      observable: true,
      still_present: collisions.length > 0,
      refs_examined: Object.keys(byRef).length,
      collisions,
      unobservable_part: 'which migrations the hosted project has applied (no credentials here)',
    };
  },

  's1-fix-on-product-line'(root) {
    const dir = join(root, 'supabase/migrations');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')) : [];
    const fixing = files.filter((f) =>
      /drop\s+policy\s+(if\s+exists\s+)?integration_events_org_delete/i.test(readFileSync(join(dir, f), 'utf8')));
    return {
      observable: true,
      still_present: fixing.length === 0,
      fix_on_this_tree: fixing,
      unobservable_part: 'whether the HOSTED project still carries the 16 policies (no credentials; api.supabase.com blocked)',
    };
  },

  'default-branch-divergence'(root) {
    const main = git(root, ['rev-parse', '--verify', '-q', 'origin/main']);
    if (!main) return { observable: false, reason: 'origin/main not fetched' };
    const counts = git(root, ['rev-list', '--left-right', '--count', 'origin/main...HEAD']);
    const [behind, ahead] = (counts ?? '0 0').split(/\s+/).map(Number);
    return {
      observable: true,
      still_present: ahead > 0 || behind > 0,
      head_ahead_of_main: ahead,
      head_behind_main: behind,
    };
  },
};

export function runDetectors(root, blockers) {
  return Object.fromEntries(blockers.map((b) => {
    const fn = DETECTORS[b.detector];
    if (!fn) return [b.id, { observable: false, reason: `no detector named ${b.detector}` }];
    try { return [b.id, { detector: b.detector, ...fn(root) }]; }
    catch (e) { return [b.id, { detector: b.detector, observable: false, reason: `detector error: ${e.message}` }]; }
  }));
}

export const DETECTOR_NAMES = Object.freeze(Object.keys(DETECTORS));
