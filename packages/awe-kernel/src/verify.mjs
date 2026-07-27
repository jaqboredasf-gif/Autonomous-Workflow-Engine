// ---------------------------------------------------------------------------
// verify.mjs — the Verify Step library.
//
// Doctrine (MVP_SPEC §Verify Steps): a workflow's own claim that it did
// something counts for nothing. A step is complete only when a deterministic
// re-read of real state says so. That rule was implemented once, by hand, for
// one entity (`db.verify()` for classification write-back). Every future
// workflow needs the same thing against different state.
//
// A Verify Step here is DATA — a named spec of typed checks over named sources —
// and the evaluator is pure. Fetching is the caller's job, through a `probe`
// function, which is what makes the same spec runnable against a live database,
// a recorded fixture, or an in-memory double with no code change.
//
//   const spec = defineVerify({ name, sources: [...], checks: [...] });
//   const result = await runVerify(spec, { probe, context });
//   if (!result.ok) -> the step did NOT happen, whatever the workflow reported.
//
// PURE: no clock, no randomness, no I/O, no network. Only `probe` touches the
// world, and the caller supplies it.
// ---------------------------------------------------------------------------

import { canonicalJson, digest, get, stableEqual } from './canonical.mjs';
import { invariant } from './errors.mjs';

export const CHECK_KINDS = [
  'exists',          // source (or path within it) is neither null nor undefined
  'absent',          // source (or path within it) is null or undefined
  'equals',          // strict-by-value equality against expected
  'not_equals',
  'one_of',          // value is a member of `expected` (an array)
  'fields_equal',    // every path in `fields` equals its expectation — one check, many fields
  'count_equals',    // numeric value === expected
  'count_at_least',  // numeric value >= expected
  'non_empty',       // array/string/object with at least one element
  'matches',         // string matches the `pattern` regex source
];

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

// --- Spec construction -------------------------------------------------------

export function defineVerify({ name, sources, checks, description = null }) {
  invariant(typeof name === 'string' && name.length > 0, 'invalid_input', 'verify spec needs a name', { name });
  invariant(Array.isArray(checks) && checks.length > 0, 'invalid_input', `verify spec '${name}' needs at least one check`, { name });

  const seen = new Set();
  const normalized = checks.map((check, i) => {
    const where = `${name}.checks[${i}]`;
    invariant(
      typeof check.id === 'string' && ID_PATTERN.test(check.id),
      'invalid_input', `${where}.id must be snake_case`, { id: check.id },
    );
    invariant(!seen.has(check.id), 'invalid_input', `${where}.id '${check.id}' is duplicated`, { id: check.id });
    seen.add(check.id);
    invariant(
      CHECK_KINDS.includes(check.kind),
      'invalid_input', `${where}.kind '${check.kind}' is not one of ${CHECK_KINDS.join(', ')}`, { kind: check.kind },
    );
    invariant(
      typeof check.source === 'string' && check.source.length > 0,
      'invalid_input', `${where}.source must name a probe source`, { source: check.source },
    );
    if (check.kind === 'one_of') {
      invariant(Array.isArray(check.expected), 'invalid_input', `${where}.expected must be an array for one_of`, {});
    }
    if (check.kind === 'fields_equal') {
      invariant(
        check.fields !== null && typeof check.fields === 'object' && Object.keys(check.fields).length > 0,
        'invalid_input', `${where}.fields must be a non-empty object for fields_equal`, {},
      );
    }
    if (check.kind === 'matches') {
      invariant(typeof check.pattern === 'string', 'invalid_input', `${where}.pattern must be a regex source string`, {});
    }
    if (check.kind === 'count_equals' || check.kind === 'count_at_least') {
      invariant(
        typeof check.expected === 'number' && Number.isFinite(check.expected),
        'invalid_input', `${where}.expected must be a finite number`, {},
      );
    }
    return Object.freeze({
      id: check.id,
      kind: check.kind,
      source: check.source,
      path: check.path ?? null,
      expected: check.expected ?? null,
      expectedPath: check.expectedPath ?? null,   // dotted path into `context`
      fields: check.fields ? Object.freeze({ ...check.fields }) : null,
      pattern: check.pattern ?? null,
      describe: check.describe ?? null,
    });
  });

  const declared = sources ? [...sources] : [...new Set(normalized.map((c) => c.source))];
  for (const c of normalized) {
    invariant(
      declared.includes(c.source),
      'invalid_input', `${name}.checks '${c.id}' uses undeclared source '${c.source}'`,
      { source: c.source, declared },
    );
  }

  return Object.freeze({
    name,
    description,
    sources: Object.freeze([...declared].sort()),
    checks: Object.freeze(normalized),
  });
}

// --- Evaluation --------------------------------------------------------------

// `expected` may be a literal on the check, or a dotted path into `context`.
// A `fields_equal` map's values are treated the same way: a `{ $ctx: 'path' }`
// wrapper resolves from context, anything else is a literal.
function resolveExpectation(check, context) {
  if (check.expectedPath !== null) return get(context, check.expectedPath, undefined);
  return check.expected;
}

function resolveFieldExpectation(value, context) {
  if (value !== null && typeof value === 'object' && typeof value.$ctx === 'string') {
    return get(context, value.$ctx, undefined);
  }
  return value;
}

function evaluate(check, sourceValue, context) {
  const value = check.path ? get(sourceValue, check.path, undefined) : sourceValue;

  switch (check.kind) {
    case 'exists':
      return { passed: value !== null && value !== undefined, actual: value };
    case 'absent':
      return { passed: value === null || value === undefined, actual: value };
    case 'equals': {
      const expected = resolveExpectation(check, context);
      return { passed: stableEqualSafe(value, expected), actual: value, expected };
    }
    case 'not_equals': {
      const expected = resolveExpectation(check, context);
      return { passed: !stableEqualSafe(value, expected), actual: value, expected };
    }
    case 'one_of': {
      const expected = resolveExpectation(check, context) ?? [];
      return { passed: expected.some((e) => stableEqualSafe(value, e)), actual: value, expected };
    }
    case 'fields_equal': {
      const mismatched = [];
      for (const [path, rawExpected] of Object.entries(check.fields)) {
        const expected = resolveFieldExpectation(rawExpected, context);
        const actual = get(sourceValue, path, undefined);
        if (!stableEqualSafe(actual, expected)) mismatched.push({ path, expected, actual });
      }
      return { passed: mismatched.length === 0, actual: mismatched.length ? mismatched : null };
    }
    case 'count_equals':
      return { passed: toCount(value) === check.expected, actual: toCount(value), expected: check.expected };
    case 'count_at_least':
      return { passed: toCount(value) >= check.expected, actual: toCount(value), expected: check.expected };
    case 'non_empty': {
      const size = value === null || value === undefined ? 0
        : Array.isArray(value) || typeof value === 'string' ? value.length
          : typeof value === 'object' ? Object.keys(value).length : 0;
      return { passed: size > 0, actual: size };
    }
    case 'matches': {
      const passed = typeof value === 'string' && new RegExp(check.pattern).test(value);
      return { passed, actual: value, expected: check.pattern };
    }
    /* c8 ignore next 2 -- unreachable: defineVerify rejects unknown kinds */
    default:
      return { passed: false, actual: value };
  }
}

// A count source may arrive as a bare number or as the single-row shape the
// management query API returns (`[{ n: 1 }]` / `{ n: 1 }`). Normalize all three
// rather than making every spec know which flavour its probe produces.
function toCount(value) {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return 0;
    if (value.length === 1 && typeof value[0] === 'object' && value[0] !== null) return toCount(value[0]);
    return value.length;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value[keys[0]] === 'number') return value[keys[0]];
  }
  return Number.NaN;
}

// Values coming back from a probe can be anything, including shapes
// canonicalJson refuses. Fall back to reference/primitive equality rather than
// letting a verify step throw on an exotic value.
function stableEqualSafe(a, b) {
  if (a === b) return true;
  try { return stableEqual(a, b); } catch { return false; }
}

// Run a spec. `probe(sourceName)` is called at most once per declared source
// (memoized) and may be async. A probe that throws fails its checks rather than
// aborting the run — an unreachable database is a failed Verify Step, not a
// crash mid-workflow.
export async function runVerify(spec, { probe, context = {} } = {}) {
  invariant(typeof probe === 'function', 'invalid_input', `runVerify('${spec?.name}') needs a probe function`, {});

  const values = new Map();
  const probeErrors = new Map();
  for (const source of spec.sources) {
    try {
      values.set(source, await probe(source));
    } catch (e) {
      probeErrors.set(source, String(e?.message ?? e));
      values.set(source, undefined);
    }
  }

  const checks = {};
  const failures = [];
  for (const check of spec.checks) {
    let outcome;
    if (probeErrors.has(check.source)) {
      outcome = { passed: false, actual: undefined, probe_error: probeErrors.get(check.source) };
    } else {
      outcome = evaluate(check, values.get(check.source), context);
    }
    checks[check.id] = outcome.passed;
    if (!outcome.passed) {
      failures.push({
        id: check.id,
        kind: check.kind,
        source: check.source,
        path: check.path,
        expected: outcome.expected ?? check.expected,
        actual: outcome.actual,
        probe_error: outcome.probe_error ?? null,
        describe: check.describe,
      });
    }
  }

  const ok = failures.length === 0;
  return Object.freeze({
    ok,
    name: spec.name,
    checks,
    failures: Object.freeze(failures),
    // Fingerprint of the verdict — stable across runs, safe to log, useful for
    // proving two runs verified identically.
    digest: digest({ name: spec.name, checks }),
  });
}

// One-line human rendering for runner output and error messages.
export function explain(result) {
  if (result.ok) return `${result.name}: OK (${Object.keys(result.checks).length} checks)`;
  const detail = result.failures.map((f) => {
    if (f.probe_error) return `${f.id} (probe error: ${f.probe_error})`;
    const exp = f.expected === undefined ? '' : ` expected=${canonicalJson(f.expected ?? null)}`;
    const act = f.actual === undefined ? '' : ` actual=${canonicalJson(f.actual ?? null)}`;
    return `${f.id}[${f.kind}]${exp}${act}`;
  });
  return `${result.name}: FAILED — ${detail.join('; ')}`;
}
