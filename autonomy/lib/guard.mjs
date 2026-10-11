// ---------------------------------------------------------------------------
// guard.mjs — what an autonomous change may not touch.
//
// Two sources close paths: the standing L3 list in autonomy/policy.json, and
// every open blocker in autonomy/blockers.json. Blockers only ever ADD closed
// paths. Finding S1 in the logs does not make supabase/ editable, and that is
// the point: a Builder that discovers a problem is the last agent that should
// be trusted to decide it is allowed to fix it.
//
// Pure. The CLI (scripts/awe-guard.mjs) supplies the changed paths and the
// ref; this decides.
// ---------------------------------------------------------------------------

/** A minimal glob: `**` crosses directories, `*` and `?` do not. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const matches = (path, glob) => globToRegExp(glob).test(path);

/** Blockers still in force. Anything not explicitly RESOLVED by a human stays in force. */
export const openBlockers = (blockers) => blockers.filter((b) => b.status !== 'RESOLVED');

/**
 * Every reason this change is not allowed for an autonomous actor.
 *   change: { paths: string[], ref: string }
 */
export function checkChange(change, policy, blockers) {
  const violations = [];
  const prefix = policy.autonomy_branch_prefix;
  if (!change.ref || !change.ref.startsWith(prefix)) {
    violations.push({ rule: 'autonomy-branch', detail: `autonomous changes must be on a ${prefix}* branch, not "${change.ref}"` });
  }
  for (const b of openBlockers(blockers)) {
    for (const r of b.forbidden_refs ?? []) {
      if (change.ref && matches(change.ref, r)) {
        violations.push({ rule: `blocker:${b.id}`, detail: `ref ${change.ref} is closed by ${b.id} (${b.autonomous_action})` });
      }
    }
  }
  for (const path of change.paths) {
    for (const g of policy.l3_paths) {
      if (matches(path, g)) violations.push({ rule: 'l3', path, detail: `${path} matches L3 path ${g}; human approval required` });
    }
    for (const b of openBlockers(blockers)) {
      for (const g of b.forbidden_paths ?? []) {
        if (matches(path, g)) {
          violations.push({ rule: `blocker:${b.id}`, path, detail: `${path} is closed by ${b.id} (${b.autonomous_action}): ${b.title}` });
        }
      }
    }
  }
  return violations;
}

/** Union of every path an autonomous change may not touch right now. */
export function closedPaths(policy, blockers) {
  const set = new Set(policy.l3_paths);
  for (const b of openBlockers(blockers)) for (const g of b.forbidden_paths ?? []) set.add(g);
  return [...set].sort();
}
