// ---------------------------------------------------------------------------
// predicate.mjs — the `when` condition language: a step's execution as DATA.
//
// The gap this closes: every governed workflow was a straight line. `steps` was
// an ordered array and the engine walked it start to finish, so a workflow that
// needs "if the amount is under the tenant's threshold, skip the approval step"
// could not say so. The only way to model a decision was to register two
// near-identical workflows and choose between them OUTSIDE the control plane —
// which puts the branch condition somewhere the journal never records, the
// policy engine never sees, and the manifest digest does not cover.
//
// ============================ WHY THIS IS DATA =============================
//
// The obvious implementation is a function on the step: `when: (results) => ...`.
// It is also the one that would retire four properties the control plane
// currently has, all at once:
//
//   * a manifest is DIGESTED, and a closure has no stable digest;
//   * a manifest is VERSIONED and REVIEWED, and a diff of two closures tells a
//     reviewer nothing about which runs change behaviour;
//   * a manifest is meant to live in a TABLE (ADR-0002), and code does not;
//   * the journal must be able to record WHY a branch was taken, and "a
//     function returned false" is not a reason anybody can audit.
//
// So a predicate is a small closed structure, validated when the manifest is
// built and evaluated deterministically at run time. It has no arithmetic, no
// string manipulation, no user-supplied code path, and no way to reach anything
// the evaluation scope was not handed.
//
// ============================ THE LANGUAGE =================================
//
//   leaf:      { path, op, value }
//   all:       { all: [predicate, ...] }     every one must hold
//   any:       { any: [predicate, ...] }     at least one must hold
//   not:       { not: predicate }
//
// Paths resolve against a CLOSED scope with three roots, and nothing else is
// reachable:
//
//   results.<step_id>.<field...>   the output of an EARLIER step
//   input.<field...>               this step's declared input, from the manifest
//   run.<org_id|workflow_id|workflow_version|mode>
//
// An absent path is not an error and is not `undefined` leaking into a
// comparison: it is `MISSING`, a distinct sentinel. `eq` against MISSING is
// false, `exists` is how a manifest asks the question deliberately, and a
// missing path can therefore never accidentally satisfy a gate.
//
// PURE: no clock, no randomness, no I/O. Evaluation is a function of
// (predicate, scope) and is byte-for-byte reproducible, which is what lets a
// replayed run take the same branch.
// ---------------------------------------------------------------------------

import { canonicalClone, deepFreeze, digest, invariant } from './kernel.mjs';

export const PREDICATE_ROOTS = ['results', 'input', 'run'];

/**
 * The operator set, deliberately small. Each one is a total function over
 * (actual, declared) — none can throw, and none can be given a value that makes
 * it return something other than true or false.
 */
export const PREDICATE_OPS = [
  'eq', 'ne',           // strict, canonical equality
  'in', 'not_in',       // membership in a declared array
  'lt', 'lte', 'gt', 'gte', // numeric only; a non-number is false, never a coercion
  'exists', 'not_exists',   // the presence question, asked deliberately
  'is_true', 'is_false',    // strict boolean, so a truthy string cannot open a gate
];

// Operators that take no `value`. Declaring one anyway is a mistake worth
// refusing: it reads as a comparison and is not one.
const NULLARY_OPS = ['exists', 'not_exists', 'is_true', 'is_false'];

// Operators whose `value` must be an array.
const SET_OPS = ['in', 'not_in'];

// Operators that compare numerically. A non-numeric operand makes them FALSE
// rather than coercing: `'10' > 9` being true is how a threshold gate gets
// opened by a string.
const NUMERIC_OPS = ['lt', 'lte', 'gt', 'gte'];

const LEAF_KEYS = ['path', 'op', 'value'];
const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The absent-value sentinel. A distinct object rather than `undefined` or
 * `null`, because a manifest may legitimately compare against `null` and the
 * two questions ("it is null" / "it is not there") must not collapse.
 */
export const MISSING = Object.freeze({ __awe_missing: true });

export const isMissing = (v) => v === MISSING;

// --- validation --------------------------------------------------------------

function assertPath(path, label) {
  invariant(
    typeof path === 'string' && path.length > 0,
    'invalid_input', `${label} needs a path`, { path },
  );
  const segments = path.split('.');
  invariant(
    PREDICATE_ROOTS.includes(segments[0]),
    'invalid_input',
    `${label} path '${path}' must start with one of ${JSON.stringify(PREDICATE_ROOTS)} — a predicate reaches nothing else`,
    { path, roots: PREDICATE_ROOTS },
  );
  segments.forEach((segment) => invariant(
    PATH_SEGMENT.test(segment),
    'invalid_input', `${label} path segment '${segment}' is not a plain identifier`, { path, segment },
  ));
  return segments;
}

/**
 * definePredicate(spec, { label, earlierSteps })
 *
 * Returns a frozen, canonical predicate. `earlierSteps` is what makes this a
 * GRAPH validation rather than a syntax check: a condition that reads
 * `results.some_step` where `some_step` runs later (or does not exist) can never
 * be satisfied, and a workflow whose branch can never be taken is a workflow
 * whose author meant something else. It is refused at build time rather than
 * discovered as a silently-skipped step in production.
 */
export function definePredicate(spec, { label = 'predicate', earlierSteps = null } = {}) {
  invariant(
    spec !== null && typeof spec === 'object' && !Array.isArray(spec),
    'invalid_input', `${label} must be a plain object`, {},
  );

  const keys = Object.keys(spec).sort();

  if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
    const kind = keys[0];
    const list = spec[kind];
    invariant(Array.isArray(list) && list.length > 0, 'invalid_input', `${label} '${kind}' must be a non-empty array`, {});
    return deepFreeze({
      [kind]: list.map((p, i) => definePredicate(p, { label: `${label}.${kind}[${i}]`, earlierSteps })),
    });
  }

  if (keys.length === 1 && keys[0] === 'not') {
    return deepFreeze({ not: definePredicate(spec.not, { label: `${label}.not`, earlierSteps }) });
  }

  const unknown = keys.filter((k) => !LEAF_KEYS.includes(k));
  invariant(
    unknown.length === 0,
    'invalid_input',
    `${label} has unknown key(s) ${JSON.stringify(unknown)} — a condition key that is not understood is refused, not ignored`,
    { unknown },
  );

  const segments = assertPath(spec.path, label);
  const op = spec.op;
  invariant(
    PREDICATE_OPS.includes(op),
    'invalid_input', `${label} operator '${op}' is unknown`, { op, known: PREDICATE_OPS },
  );

  // The reachability check.
  if (segments[0] === 'results' && earlierSteps !== null) {
    const step_id = segments[1];
    invariant(
      step_id !== undefined,
      'invalid_input', `${label} path '${spec.path}' must name a step under 'results'`, { path: spec.path },
    );
    invariant(
      earlierSteps.includes(step_id),
      'invalid_input',
      `${label} reads 'results.${step_id}', which is not an EARLIER step — a condition on a step that has not run yet can never be satisfied`,
      { path: spec.path, step_id, earlier: [...earlierSteps] },
    );
  }

  const nullary = NULLARY_OPS.includes(op);
  invariant(
    !nullary || spec.value === undefined,
    'invalid_input', `${label} operator '${op}' takes no value; declaring one reads as a comparison and is not`, { op },
  );
  if (!nullary) {
    invariant(
      spec.value !== undefined,
      'invalid_input', `${label} operator '${op}' needs a value`, { op },
    );
    if (SET_OPS.includes(op)) {
      invariant(
        Array.isArray(spec.value) && spec.value.length > 0,
        'invalid_input', `${label} operator '${op}' needs a non-empty array`, { op },
      );
    }
    if (NUMERIC_OPS.includes(op)) {
      invariant(
        typeof spec.value === 'number' && Number.isFinite(spec.value),
        'invalid_input', `${label} operator '${op}' compares numerically and needs a finite number`, { op, value: spec.value },
      );
    }
  }

  const leaf = nullary
    ? { path: spec.path, op }
    : { path: spec.path, op, value: canonicalClone(spec.value) };
  return deepFreeze(leaf);
}

/** A predicate's stable identity, so the journal can name WHICH condition ran. */
export const predicateDigest = (predicate) => digest(predicate);

// --- evaluation --------------------------------------------------------------

/**
 * resolvePath(scope, path) -> value | MISSING
 *
 * Own-property lookups only. A path may not walk a prototype chain, so
 * `results.x.constructor` and `input.__proto__` resolve to MISSING rather than
 * to something a manifest author did not put there.
 */
export function resolvePath(scope, path) {
  let cursor = scope;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return MISSING;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return MISSING;
    cursor = cursor[segment];
  }
  return cursor === undefined ? MISSING : cursor;
}

function sameValue(a, b) {
  if (typeof a !== 'object' || a === null) return a === b;
  // Structural equality through the canonical encoder, so `{a:1,b:2}` and
  // `{b:2,a:1}` compare equal and key order cannot decide a gate.
  try { return digest(a) === digest(b); } catch { return false; }
}

function evaluateLeaf(leaf, scope) {
  const actual = resolvePath(scope, leaf.path);

  switch (leaf.op) {
    case 'exists': return !isMissing(actual);
    case 'not_exists': return isMissing(actual);
    case 'is_true': return actual === true;
    case 'is_false': return actual === false;
    default: break;
  }

  // Every remaining operator compares against something. A value that is not
  // there compares false — never true, and never a coercion — so a typo'd path
  // closes a gate rather than opening one.
  if (isMissing(actual)) return false;

  switch (leaf.op) {
    case 'eq': return sameValue(actual, leaf.value);
    case 'ne': return !sameValue(actual, leaf.value);
    case 'in': return leaf.value.some((candidate) => sameValue(actual, candidate));
    case 'not_in': return !leaf.value.some((candidate) => sameValue(actual, candidate));
    case 'lt': case 'lte': case 'gt': case 'gte': {
      // Strictly numeric. `'10' > 9` being true is how a threshold gate gets
      // opened by a string that came from a model.
      if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
      if (leaf.op === 'lt') return actual < leaf.value;
      if (leaf.op === 'lte') return actual <= leaf.value;
      if (leaf.op === 'gt') return actual > leaf.value;
      return actual >= leaf.value;
    }
    default:
      // Unreachable: `definePredicate` refuses an unknown operator. Returning
      // false rather than throwing keeps the rule that an unrecognised
      // condition closes the gate.
      return false;
  }
}

/**
 * evaluatePredicate(predicate, scope) -> { matched, leaves }
 *
 * `leaves` is the audit trail: every comparison that was made, with the path,
 * the operator, the DECLARED value (which is manifest data — reviewed,
 * versioned and already inside the manifest digest) and whether the actual
 * value was present, but NEVER the actual value itself.
 *
 * That asymmetry is the two-store rule applied to conditions. The journal
 * records that a run skipped its approval step because
 * `results.classify_risk.band` was not `requires_owner_approval`; the band it
 * actually held is a workflow's data and lives in the result store with
 * everything else the run produced. A digest of it is carried so an
 * investigator can still prove which value was seen without the journal
 * becoming a second copy of the tenant's data.
 */
export function evaluatePredicate(predicate, scope = {}) {
  const leaves = [];

  const walk = (node) => {
    if (Object.prototype.hasOwnProperty.call(node, 'all')) {
      // Every branch is evaluated, not short-circuited: an audit trail that
      // stops at the first false tells a reviewer less than one that does not,
      // and there is nothing here that can be expensive or have an effect.
      const results = node.all.map(walk);
      return results.every(Boolean);
    }
    if (Object.prototype.hasOwnProperty.call(node, 'any')) {
      const results = node.any.map(walk);
      return results.some(Boolean);
    }
    if (Object.prototype.hasOwnProperty.call(node, 'not')) {
      return !walk(node.not);
    }

    const matched = evaluateLeaf(node, scope);
    const actual = resolvePath(scope, node.path);
    leaves.push({
      path: node.path,
      op: node.op,
      declared: node.value === undefined ? null : node.value,
      present: !isMissing(actual),
      // The value's identity, not the value. See the docblock above.
      actual_digest: isMissing(actual) ? null : digest({ v: actual }),
      matched,
    });
    return matched;
  };

  const matched = walk(predicate);
  return deepFreeze({ matched, leaves });
}

/**
 * predicateScope({ results, input, context })
 *
 * The closed evaluation scope. Built here rather than by the engine so that
 * what a condition can reach is defined in ONE place — a scope assembled at the
 * call site would drift the moment a second call site appeared.
 */
export function predicateScope({ results = {}, input = {}, context = null } = {}) {
  return {
    results,
    input,
    run: {
      org_id: context?.org_id ?? null,
      workflow_id: context?.workflow_id ?? null,
      mode: context?.mode ?? null,
      actor: context?.actor ?? null,
    },
  };
}
