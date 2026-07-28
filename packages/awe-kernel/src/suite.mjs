// ---------------------------------------------------------------------------
// suite.mjs — suite descriptors and regression planning.
//
// `scripts/regression.sh` grew one hand-written `if [ -f ... ]` block per suite:
// the list of what the platform verifies lives only inside a bash script, in
// execution order, with its skip rules, its output handling and its rate-limit
// cooldown all inlined. Nothing else can read that list — not a CI matrix, not
// a "what covers this file?" query, not a runner that wants to check it is
// registered.
//
// A suite is now a descriptor, and the plan (what runs, in what order, what is
// skipped and why) is computed here as data. `regression.sh` becomes a loop
// over the plan; the plan itself is testable without executing anything.
//
// PURE: no clock, no randomness, no network. Filesystem existence is injected
// (`exists`) so a plan can be computed against a hypothetical tree.
// ---------------------------------------------------------------------------

import { invariant } from './errors.mjs';

export const SUITE_KINDS = [
  'unit',       // pure in-process assertions, no external state at all
  'offline',    // deterministic engine + fixtures; no keys, no DB, no network
  'static',     // structural validation of files (migrations, layering)
  'build',      // typecheck / compile / smoke
  'db',         // requires live database credentials
  'live',       // requires a paid external API key
];

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function defineSuite({
  id,
  name,
  kind,
  command,
  description = null,
  requires = [],
  skipIfMissing = [],
  skipIfEnvMissing = false,
  optInEnv = null,
  cooldownAfterSeconds = 0,
  echoOk = false,
  quietOnSuccess = false,
  tags = [],
}) {
  invariant(typeof id === 'string' && ID_PATTERN.test(id), 'invalid_input', `suite id '${id}' must be kebab-case`, { id });
  invariant(typeof name === 'string' && name.length > 0, 'invalid_input', `suite '${id}' needs a name`, { id });
  invariant(SUITE_KINDS.includes(kind), 'invalid_input', `suite '${id}' has unknown kind '${kind}'`, { id, kind, known: SUITE_KINDS });
  invariant(typeof command === 'string' && command.length > 0, 'invalid_input', `suite '${id}' needs a command`, { id });
  invariant(!command.includes('\t') && !command.includes('\n'), 'invalid_input', `suite '${id}' command must be a single line without tabs`, { id });
  invariant(Array.isArray(requires), 'invalid_input', `suite '${id}' requires must be an array`, { id });
  invariant(Array.isArray(skipIfMissing), 'invalid_input', `suite '${id}' skipIfMissing must be an array`, { id });
  invariant(
    optInEnv === null || (typeof optInEnv === 'string' && ENV_PATTERN.test(optInEnv)),
    'invalid_input', `suite '${id}' optInEnv must be null or an uppercase environment variable name`,
    { id, optInEnv },
  );
  invariant(
    Number.isInteger(cooldownAfterSeconds) && cooldownAfterSeconds >= 0,
    'invalid_input', `suite '${id}' cooldownAfterSeconds must be a non-negative integer`, { id },
  );
  // A suite that needs credentials but claims to be offline is exactly the
  // mistake this registry exists to make impossible.
  invariant(
    !(requires.length > 0 && (kind === 'offline' || kind === 'unit' || kind === 'static')),
    'invalid_input', `suite '${id}' is kind '${kind}' but declares required env ${JSON.stringify(requires)}`,
    { id, kind, requires },
  );

  return Object.freeze({
    id,
    name,
    kind,
    command,
    description,
    requires: Object.freeze([...requires]),
    skipIfMissing: Object.freeze([...skipIfMissing]),
    skipIfEnvMissing,
    optInEnv,
    cooldownAfterSeconds,
    echoOk,
    quietOnSuccess,
    tags: Object.freeze([...tags]),
  });
}

export function createSuiteRegistry(suites) {
  const list = suites.map((s) => (Object.isFrozen(s) && s.id ? s : defineSuite(s)));
  const byId = new Map();
  for (const s of list) {
    invariant(!byId.has(s.id), 'invalid_input', `duplicate suite id '${s.id}'`, { id: s.id });
    byId.set(s.id, s);
  }

  return Object.freeze({
    all() { return Object.freeze([...list]); },
    ids() { return list.map((s) => s.id); },
    get(id) {
      const s = byId.get(id);
      invariant(s !== undefined, 'unregistered_suite', `no suite with id '${id}'`, { id, known: [...byId.keys()] });
      return s;
    },
    has(id) { return byId.has(id); },
    ofKind(kind) { return list.filter((s) => s.kind === kind); },
    tagged(tag) { return list.filter((s) => s.tags.includes(tag)); },
    plan(options) { return planRegression(list, options); },
  });
}

// Resolve the ordered execution plan. Every suite appears in the result — a
// skipped suite is reported with its reason, never silently dropped, because
// "the suite that would have caught it never ran" is the failure mode.
export function planRegression(suites, {
  env = {},
  exists = () => true,
  only = null,
  kinds = null,
  excludeKinds = null,
} = {}) {
  const selected = new Set(only ?? []);
  const included = new Set(kinds ?? []);
  const excluded = new Set(excludeKinds ?? []);

  return Object.freeze(suites.map((suite) => {
    let status = 'run';
    let skipReason = null;

    const missingFiles = suite.skipIfMissing.filter((p) => !exists(p));
    const missingEnv = suite.requires.filter((k) => !env[k]);

    if (only && !selected.has(suite.id)) {
      status = 'skipped';
      skipReason = 'not selected';
    } else if (kinds && !included.has(suite.kind)) {
      status = 'skipped';
      skipReason = `kind '${suite.kind}' not selected`;
    } else if (excluded.has(suite.kind)) {
      status = 'skipped';
      skipReason = `kind '${suite.kind}' excluded`;
    } else if (suite.optInEnv !== null && env[suite.optInEnv] !== '1') {
      status = 'skipped';
      skipReason = `requires explicit opt-in: ${suite.optInEnv}=1`;
    } else if (missingFiles.length > 0) {
      status = 'skipped';
      skipReason = `missing file(s): ${missingFiles.join(', ')}`;
    } else if (suite.skipIfEnvMissing && missingEnv.length > 0) {
      status = 'skipped';
      skipReason = `missing env: ${missingEnv.join(', ')}`;
    }

    return Object.freeze({
      id: suite.id,
      name: suite.name,
      kind: suite.kind,
      command: suite.command,
      status,
      skip_reason: skipReason,
      missing_env: Object.freeze(missingEnv),
      cooldown_after_seconds: suite.cooldownAfterSeconds,
      echo_ok: suite.echoOk,
      quiet_on_success: suite.quietOnSuccess,
    });
  }));
}
