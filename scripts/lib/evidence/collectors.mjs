// ---------------------------------------------------------------------------
// collectors.mjs — the six evidence collectors.
//
// Each collector is split in two: a PURE analysis function that takes raw text
// (git porcelain output, a package.json, a .sql file) and returns findings, and
// a `collect*` function that gathers the raw text through an injected context.
//
// That split is the whole testability story. The parsers can be driven with
// synthetic input — a fabricated `git status --porcelain -uall`, a migration
// with a deliberate slot collision — without creating a temporary repository on
// disk for every case.
//
// The injected context is `{ run, read, list, exists }`. Nothing here imports
// node:fs or node:child_process directly.
// ---------------------------------------------------------------------------

import { record, warn, stripCredentials } from './schema.mjs';
import { SEP } from './sep.mjs';

const D = { origin: 'DIRECT_INSPECTION' };
const N = { origin: 'NARRATIVE_CLAIM' };

// ===========================================================================
// GIT
// ===========================================================================

/** Parse `git status --porcelain -uall` into staged / dirty / untracked. */
export function parseStatus(porcelain) {
  const staged = []; const dirty = []; const untracked = [];
  for (const line of (porcelain || '').split('\n')) {
    if (!line.trim()) continue;
    const x = line[0]; const y = line[1];
    const path = line.slice(3).trim();
    if (x === '?' && y === '?') { untracked.push(path); continue; }
    if (x !== ' ' && x !== '?') staged.push(path);
    if (y !== ' ' && y !== '?') dirty.push(path);
  }
  return { staged, dirty, untracked };
}

/** Parse `git branch -vv --format=...` style upstream info. */
export function parseBranches(raw) {
  return (raw || '').split('\n').filter(Boolean).map((line) => {
    const [name, upstream, sha] = line.split(SEP);
    return { name, upstream: upstream || null, sha: sha || null };
  });
}

export function collectGit(ctx) {
  const warnings = []; const errors = [];
  const g = (args, fallback = '') => {
    const out = ctx.run('git', args);
    return out === null ? fallback : out;
  };

  const remoteRaw = g(['remote', 'get-url', 'origin'], '');
  const remote = stripCredentials(remoteRaw);
  const commit = g(['rev-parse', 'HEAD'], 'unknown');
  const branch = g(['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown');
  const status = parseStatus(g(['status', '--porcelain', '-uall']));
  const branches = parseBranches(g(['branch', `--format=%(refname:short)${SEP}%(upstream:short)${SEP}%(objectname)`]));
  const remoteBranches = g(['branch', '-r', '--format=%(refname:short)'])
    .split('\n').filter((b) => b && !b.includes('->'));
  const tags = g(['tag']).split('\n').filter(Boolean);
  const stashRaw = g(['stash', 'list']);
  // Count only. Stash contents can hold anything, including secrets a developer
  // shelved rather than committed; an evidence artifact must not carry them.
  const stashCount = stashRaw ? stashRaw.split('\n').filter(Boolean).length : 0;
  const worktrees = g(['worktree', 'list']).split('\n').filter(Boolean);
  const recent = g(['log', '-20', `--format=%h${SEP}%an${SEP}%aI${SEP}%s`])
    .split('\n').filter(Boolean)
    .map((l) => { const [sha, author, date, subject] = l.split(SEP); return { sha, author, date, subject }; });

  const noUpstream = branches.filter((b) => !b.upstream).map((b) => b.name);
  for (const b of noUpstream) {
    warnings.push(warn('unpushed_branch', `local branch "${b}" has no upstream — its commits exist only on this machine`, { detail: { branch: b } }));
  }

  const localOnly = [];
  for (const b of branches) {
    if (!b.upstream) continue;
    const ahead = g(['rev-list', '--count', `${b.upstream}..${b.name}`], '0');
    if (Number(ahead) > 0) {
      localOnly.push({ branch: b.name, ahead: Number(ahead), upstream: b.upstream });
      warnings.push(warn('local_only_commit', `"${b.name}" is ${ahead} commit(s) ahead of ${b.upstream}`, { detail: { branch: b.name, ahead: Number(ahead) } }));
    }
  }

  if (status.dirty.length || status.staged.length) {
    warnings.push(warn('dirty_worktree', `${status.dirty.length} modified and ${status.staged.length} staged file(s)`, { detail: status }));
  }

  // Ancestry against the branches the cognition layer treats as the stack.
  const ancestry = {};
  for (const candidate of remoteBranches) {
    const isAnc = ctx.run('git', ['merge-base', '--is-ancestor', candidate, 'HEAD']) !== null;
    if (isAnc) ancestry[candidate] = 'ancestor';
  }
  const divergence = {};
  for (const candidate of remoteBranches) {
    const counts = g(['rev-list', '--left-right', '--count', `${candidate}...HEAD`], '');
    if (!counts) continue;
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    divergence[candidate] = { behind, ahead };
  }

  return {
    records: [
      record('git', 'remote', remote, D),
      record('git', 'branch', branch, D),
      record('git', 'commit', commit, D),
      record('git', 'clean', status.dirty.length === 0 && status.staged.length === 0 && status.untracked.length === 0, D),
      record('git', 'stash_count', stashCount, D),
    ],
    payload: {
      repository_root: ctx.root,
      remote,
      branch,
      commit,
      status,
      local_branches: branches,
      remote_branches: remoteBranches,
      branches_without_upstream: noUpstream,
      local_only_commits: localOnly,
      ancestry,
      divergence,
      tags,
      stash_count: stashCount,
      worktrees,
      recent_commits: recent,
    },
    warnings,
    errors,
  };
}

// ===========================================================================
// PACKAGES
// ===========================================================================

/** Extract relative cross-package imports from source text. */
export function parseRelativeImports(text) {
  const out = new Set();
  for (const m of (text || '').matchAll(/from\s+['"](?:\.\.\/)+([a-z0-9@._-]+)\/src/gi)) out.add(m[1]);
  for (const m of (text || '').matchAll(/from\s+['"](@exattime\/[a-z0-9-]+)['"]/gi)) out.add(m[1].split('/')[1]);
  return [...out];
}

export function collectPackages(ctx) {
  const warnings = []; const errors = [];
  const rootPkgRaw = ctx.read('package.json');
  let rootPkg = {};
  try { rootPkg = JSON.parse(rootPkgRaw || '{}'); } catch (e) {
    errors.push(warn('collector_error', `root package.json is not valid JSON: ${e.message}`, { sourcePath: 'package.json' }));
  }

  const packages = [];
  for (const dir of ctx.list('packages')) {
    const pkgPath = `packages/${dir}/package.json`;
    if (!ctx.exists(pkgPath)) continue;
    let meta = {};
    try { meta = JSON.parse(ctx.read(pkgPath) || '{}'); } catch (e) {
      errors.push(warn('collector_error', `${pkgPath} is not valid JSON: ${e.message}`, { sourcePath: pkgPath }));
      continue;
    }
    const srcDir = `packages/${dir}/src`;
    const modules = ctx.exists(srcDir) ? ctx.list(srcDir).filter((f) => /\.(mjs|js|ts|tsx)$/.test(f)) : [];
    const imports = new Set();
    for (const m of modules) {
      for (const dep of parseRelativeImports(ctx.read(`${srcDir}/${m}`))) imports.add(dep);
    }
    imports.delete(dir);
    const declared = Object.keys({ ...(meta.dependencies || {}), ...(meta.peerDependencies || {}) })
      .map((d) => d.replace(/^@exattime\//, ''));
    packages.push({
      dir,
      name: meta.name || dir,
      version: meta.version || null,
      path: pkgPath,
      main: meta.main || null,
      scripts: Object.keys(meta.scripts || {}),
      dependencies: meta.dependencies || {},
      modules,
      internal_imports: [...imports].sort(),
      declared_internal: declared.filter((d) => d.startsWith('awe-') || d === 'shared' || d === 'mcp-server'),
    });
  }

  const known = new Set(packages.map((p) => p.dir));
  const undeclared = [];
  for (const p of packages) {
    for (const dep of p.internal_imports) {
      if (!known.has(dep)) continue;
      if (p.declared_internal.includes(dep)) continue;
      undeclared.push({ from: p.dir, to: dep });
    }
  }
  if (undeclared.length) {
    warnings.push(warn('undeclared_dependency',
      `${undeclared.length} cross-package import(s) resolve by relative path and are not declared as dependencies — the layering is convention, not enforcement`,
      { detail: undeclared }));
  }

  return {
    records: [
      record('package', 'count', packages.length, D),
      record('package', 'workspaces', rootPkg.workspaces || [], D, { sourcePath: 'package.json' }),
      record('package', 'node_engine', (rootPkg.engines || {}).node || null, D, { sourcePath: 'package.json' }),
      record('package', 'package_manager',
        ctx.exists('pnpm-lock.yaml') ? 'pnpm' : ctx.exists('package-lock.json') ? 'npm' : 'unknown', D),
    ],
    payload: {
      root: {
        name: rootPkg.name || null,
        workspaces: rootPkg.workspaces || [],
        engines: rootPkg.engines || {},
        scripts: Object.keys(rootPkg.scripts || {}),
        package_manager: ctx.exists('pnpm-lock.yaml') ? 'pnpm' : ctx.exists('package-lock.json') ? 'npm' : 'unknown',
      },
      packages,
      dependency_graph: packages.map((p) => ({ from: p.dir, to: p.internal_imports })),
      undeclared_dependencies: undeclared,
    },
    warnings,
    errors,
  };
}

// ===========================================================================
// MIGRATIONS
// ===========================================================================

/** Identify a migration's naming scheme and identifier. */
export function parseMigrationName(filename) {
  const ordinal = /^(\d{4})_/.exec(filename);
  if (ordinal) return { scheme: 'ordinal', identifier: ordinal[1] };
  const ts = /^(\d{14})_/.exec(filename);
  if (ts) return { scheme: 'timestamp', identifier: ts[1] };
  return { scheme: 'unknown', identifier: filename.replace(/\.sql$/, '') };
}

/** Extract table and policy ownership from migration SQL. */
export function parseMigrationSql(sql) {
  const lower = (sql || '').toLowerCase();
  const creates = [...lower.matchAll(/create table (?:if not exists )?([a-z_.]+)/g)].map((m) => m[1]);
  const alters = [...lower.matchAll(/alter table (?:if exists )?([a-z_.]+)/g)].map((m) => m[1]);
  const policies = [...lower.matchAll(/create policy\s+"?([a-z0-9_ -]+)"?/g)].map((m) => m[1].trim());
  const drops = [...lower.matchAll(/drop policy\s+(?:if exists\s+)?"?([a-z0-9_ -]+)"?/g)].map((m) => m[1].trim());
  const rls = /enable row level security/.test(lower);
  return {
    creates: [...new Set(creates)],
    alters: [...new Set(alters)],
    policies_created: [...new Set(policies)],
    policies_dropped: [...new Set(drops)],
    enables_rls: rls,
  };
}

/** Find identifiers claimed by more than one file. */
export function findSlotCollisions(migrations) {
  const byId = new Map();
  for (const m of migrations) {
    if (!byId.has(m.identifier)) byId.set(m.identifier, []);
    byId.get(m.identifier).push(m.file);
  }
  return [...byId.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([identifier, files]) => ({ identifier, files }));
}

export function collectMigrations(ctx) {
  const warnings = []; const errors = [];
  const dir = 'supabase/migrations';
  const files = ctx.exists(dir) ? ctx.list(dir).filter((f) => f.endsWith('.sql')) : [];
  const migrations = files.map((f) => {
    const sql = ctx.read(`${dir}/${f}`) || '';
    return {
      file: f,
      path: `${dir}/${f}`,
      lines: sql.split('\n').length,
      ...parseMigrationName(f),
      ...parseMigrationSql(sql),
    };
  });

  const collisions = findSlotCollisions(migrations);
  for (const c of collisions) {
    warnings.push(warn('migration_slot_collision',
      `identifier ${c.identifier} is claimed by ${c.files.length} files: ${c.files.join(', ')}`,
      { detail: c }));
  }

  const schemes = [...new Set(migrations.map((m) => m.scheme))].filter((s) => s !== 'unknown');
  if (schemes.length > 1) {
    warnings.push(warn('mixed_migration_scheme',
      `this branch mixes migration identity schemes: ${schemes.join(' and ')} — one of them must be ratified`,
      { detail: { schemes } }));
  }

  const ownership = {};
  for (const m of migrations) {
    for (const t of m.creates) ownership[t] = { created_by: m.file, altered_by: ownership[t]?.altered_by || [] };
    for (const t of m.alters) {
      ownership[t] = ownership[t] || { created_by: null, altered_by: [] };
      ownership[t].altered_by.push(m.file);
    }
  }

  return {
    records: [
      record('migration', 'count', migrations.length, D),
      record('migration', 'schemes', schemes, D),
      record('migration', 'applied_state', 'UNKNOWN — no database was contacted', D),
    ],
    payload: {
      migrations,
      identifiers: migrations.map((m) => m.identifier),
      collisions,
      schemes,
      table_ownership: ownership,
      rls_migrations: migrations.filter((m) => m.enables_rls || m.policies_created.length || m.policies_dropped.length)
        .map((m) => m.file),
      // Explicitly not knowable from the repository. Recorded so nothing
      // downstream mistakes silence for "applied".
      applied_state: 'UNKNOWN',
      applied_state_reason: 'the collector never contacts a database',
    },
    warnings,
    errors,
  };
}

// ===========================================================================
// TESTS
// ===========================================================================

/** Classify a test script from its own header and body. */
export function classifyScript(name, text) {
  const runner = (/Runner ([A-Z0-9-]+)/.exec(text || '') || [null, null])[1];
  const declaresFree = /CREDENTIAL[- ]FREE|credential-free|no credentials|Pure deterministic|pure, deterministic/i.test(text || '');
  const needsEnv = [...(text || '').matchAll(/\b(SUPABASE_[A-Z_]+|AWE_ORG_ID|EMAIL|PASSWORD)\b/g)].map((m) => m[1]);
  const needsDocker = /docker/i.test(text || '');
  const sideEffects = /curl|wget|npm publish|git push|rm -rf|sendmail|smtp/i.test(text || '');
  const kind = declaresFree ? 'offline' : (needsEnv.length ? 'db' : 'offline');
  return {
    name,
    runner,
    kind,
    requires_env: [...new Set(needsEnv)],
    requires_docker: needsDocker,
    side_effect_capable: sideEffects,
  };
}

export function collectTests(ctx, { cognitionClaims = [] } = {}) {
  const warnings = []; const errors = [];
  const files = ctx.exists('scripts') ? ctx.list('scripts').filter((f) => /\.(sh|mjs)$/.test(f)) : [];
  const suites = files
    .filter((f) => /^(eval|acceptance|regression|validate|smoke|context|evidence|dispatch|cognition)/.test(f))
    .map((f) => {
      const text = ctx.read(`scripts/${f}`) || '';
      const c = classifyScript(f.replace(/\.(sh|mjs)$/, ''), text);
      return { ...c, path: `scripts/${f}` };
    });

  for (const s of suites) {
    if (s.side_effect_capable) {
      warnings.push(warn('side_effect_capable_script',
        `${s.path} contains a command capable of an external side effect — inspect before running`,
        { sourcePath: s.path }));
    }
  }

  // A number asserted in cognition with no suite that could produce it.
  const runners = new Set(suites.map((s) => s.runner).filter(Boolean));
  const unreproducible = cognitionClaims.filter((c) => c.runner && !runners.has(c.runner));
  for (const c of unreproducible) {
    warnings.push(warn('unreproducible_claim',
      `cognition cites Runner ${c.runner} but no script declares it`,
      { sourcePath: c.source }));
  }

  return {
    records: [
      record('test', 'suite_count', suites.length, D),
      record('test', 'offline_count', suites.filter((s) => s.kind === 'offline').length, D),
      record('test', 'credential_gated_count', suites.filter((s) => s.kind === 'db').length, D),
    ],
    payload: {
      suites,
      runners: [...runners].sort(),
      credential_gated: suites.filter((s) => s.kind === 'db').map((s) => s.path),
      docker_required: suites.filter((s) => s.requires_docker).map((s) => s.path),
      side_effect_capable: suites.filter((s) => s.side_effect_capable).map((s) => s.path),
      unreproducible_claims: unreproducible,
    },
    warnings,
    errors,
  };
}

// ===========================================================================
// DOCUMENTATION
// ===========================================================================

export function extractReferences(text) {
  const paths = new Set(); const branches = new Set(); const commits = new Set();
  const migrations = new Set(); const packages = new Set();
  for (const m of (text || '').matchAll(/`([A-Za-z0-9_@./-]+\.(?:mjs|js|ts|tsx|sql|md|json|toml|sh|yml|yaml))`/g)) {
    if (m[1].includes('/')) paths.add(m[1]);
  }
  for (const m of (text || '').matchAll(/`((?:codex|feat|claude|security|chore)\/[a-z0-9-]+)`/g)) branches.add(m[1]);
  for (const m of (text || '').matchAll(/(?:commit|HEAD is|@)[\s*:`]{0,6}\b([0-9a-f]{7,40})\b/gi)) commits.add(m[1]);
  for (const m of (text || '').matchAll(/\b(\d{4})_[a-z_]+\.sql\b/g)) migrations.add(m[1]);
  for (const m of (text || '').matchAll(/\b(awe-[a-z-]+|mcp-server)\b/g)) packages.add(m[1]);
  return {
    paths: [...paths], branches: [...branches], commits: [...commits],
    migrations: [...migrations], packages: [...packages],
  };
}

export function collectDocumentation(ctx) {
  const warnings = []; const errors = [];
  const dirs = ['context', 'docs/integration', 'docs/architecture', 'docs/architecture/decisions', 'docs/planning', 'docs/guides', 'docs/testing'];
  const docs = [];
  for (const d of dirs) {
    if (!ctx.exists(d)) continue;
    for (const f of ctx.list(d).filter((x) => x.endsWith('.md'))) {
      const p = `${d}/${f}`;
      const text = ctx.read(p) || '';
      const refs = extractReferences(text);
      const statusLine = (text.split('\n').find((l) => /^\*?\*?status/i.test(l.trim())) || '').trim();
      docs.push({
        path: p,
        kind: d.includes('decisions') ? 'adr' : d === 'context' ? 'cognition' : d.includes('integration') ? 'integration' : 'doc',
        bytes: text.length,
        decision_status: statusLine || null,
        references: refs,
        last_commit: ctx.run('git', ['log', '-1', '--format=%h', '--', p]) || null,
      });
    }
  }

  const knownPaths = new Set((ctx.run('git', ['ls-files']) || '').split('\n').map((s) => s.trim()).filter(Boolean));
  const broken = [];
  for (const d of docs) {
    for (const p of d.references.paths) {
      if (!knownPaths.has(p) && !ctx.exists(p)) broken.push({ from: d.path, missing: p });
    }
  }
  if (broken.length) {
    warnings.push(warn('broken_reference', `${broken.length} documentation reference(s) point at files that do not exist at this commit`, { detail: broken.slice(0, 30) }));
  }

  const adrs = docs.filter((d) => d.kind === 'adr');
  const unratified = adrs.filter((d) => d.decision_status && /proposed/i.test(d.decision_status));

  return {
    records: [
      record('documentation', 'doc_count', docs.length, D),
      record('documentation', 'adr_count', adrs.length, D),
      record('documentation', 'unratified_adr_count', unratified.length, D),
    ],
    payload: {
      documents: docs,
      adrs: adrs.map((a) => ({ path: a.path, status: a.decision_status })),
      unratified_adrs: unratified.map((a) => a.path),
      broken_references: broken,
    },
    warnings,
    errors,
  };
}

// ===========================================================================
// SECURITY / EXPOSURE
// ===========================================================================

export const SENSITIVE_PATTERNS = [
  { tag: 'payroll', re: /payroll|pay[_-]?period|wage|salary|rate[_-]?sheet/i },
  { tag: 'employee', re: /employee|timecard|timesheet|crew[_-]?member/i },
  { tag: 'stakeholder', re: /stakeholder|boss[_-]?interview|permission/i },
  { tag: 'customer', re: /customer|client[_-]?list|lead/i },
  { tag: 'credential', re: /credential|secret|token|password|\.pem$|\.key$/i },
  { tag: 'email_fixture', re: /fixtures?\/emails?\//i },
  { tag: 'internal_planning', re: /docs\/planning\//i },
];

// Deliberately conservative: assigned values and known token prefixes only, so
// a document that discusses secrets does not trip its own scanner.
export const SECRET_PATTERNS = [
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'assigned_secret', re: /\b(?:api[_-]?key|secret|service[_-]?role[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\s]{12,}["']/i },
];

// A value that is a reference or a placeholder is not a secret. Without this the
// scanner flags every `key = env(SUPABASE_KEY)` in a config template, and a
// scanner that cries wolf on templates is one people stop reading.
// No leading \b: several alternatives begin with a non-word character (`${`,
// `<`), and a word boundary before them can never match — which silently turned
// half this list off.
export const PLACEHOLDER_VALUE = /(?:env\(|process\.env|\$\{|<[A-Z_]+>|your[-_]|example|placeholder|REDACTED|xxx+|\.\.\.)/i;

// Files whose job is to contain secret-shaped strings: the scanners themselves
// and the suites that prove they work. A match here is almost certainly a
// fixture — but it is still reported, because "almost certainly" is not
// "certainly", and a real key pasted into a test file is still a real key.
export const FIXTURE_PATHS = /^(scripts\/eval-|scripts\/lib\/(evidence|context-validator|context-compiler)\/|scripts\/lib\/context-validator\.mjs)/;

export function classifyFilename(path) {
  return SENSITIVE_PATTERNS.filter((p) => p.re.test(path)).map((p) => p.tag);
}

/**
 * Decide how much a secret-scan hit should alarm a reader.
 *   likely_fixture   — the file exists to contain such strings
 *   placeholder      — the matched line is a reference or template value
 *   review_required  — everything else; a human should look
 */
export function classifyFinding(path, line) {
  if (PLACEHOLDER_VALUE.test(line || '')) return 'placeholder';
  if (FIXTURE_PATHS.test(path)) return 'likely_fixture';
  return 'review_required';
}

export function collectSecurity(ctx, { isPublic = null } = {}) {
  const warnings = []; const errors = [];
  const tracked = (ctx.run('git', ['ls-files']) || '').split('\n').map((s) => s.trim()).filter(Boolean);

  const sensitive = tracked
    .map((p) => ({ path: p, tags: classifyFilename(p) }))
    .filter((f) => f.tags.length > 0);

  if (sensitive.length) {
    warnings.push(warn('sensitive_filename',
      `${sensitive.length} tracked file(s) have names suggesting internal or personal material`,
      { detail: sensitive.slice(0, 40) }));
  }

  const envExamples = tracked.filter((p) => p.endsWith('.env.example'));
  const componentsNeedingConfig = ['apps/web', 'apps/mobile', 'packages/mcp-server', 'packages/m365']
    .filter((c) => tracked.some((p) => p.startsWith(`${c}/`)));
  const missingEnvExample = componentsNeedingConfig
    .filter((c) => !envExamples.some((e) => e.startsWith(`${c}/`)));
  for (const c of missingEnvExample) {
    warnings.push(warn('missing_env_example',
      `${c} requires configuration but tracks no .env.example — the shape of its config exists only on a developer's machine`,
      { detail: { component: c } }));
  }

  // Redacted secret scan over tracked text files. Reports the finding and the
  // file; never the value.
  const findings = [];
  for (const p of tracked) {
    if (!/\.(md|mjs|js|ts|tsx|json|sql|sh|yml|yaml|toml|env\.example)$/.test(p)) continue;
    const text = ctx.read(p);
    if (!text) continue;
    for (const s of SECRET_PATTERNS) {
      // Match per line so a placeholder on one line does not excuse a real key
      // on another, and so the classification has a line to judge.
      for (const line of text.split('\n')) {
        if (!s.re.test(line)) continue;
        const classification = classifyFinding(p, line);
        findings.push({ path: p, pattern: s.name, classification, value: '[REDACTED]' });
        break;
      }
    }
  }
  const needsReview = findings.filter((f) => f.classification === 'review_required');

  if (isPublic === true && sensitive.length) {
    warnings.push(warn('public_repository_exposure',
      `the repository is PUBLIC and tracks ${sensitive.length} file(s) with internal or personal-sounding names — this needs a human decision`,
      { detail: { visibility: 'PUBLIC', count: sensitive.length } }));
  }

  return {
    records: [
      record('security', 'tracked_file_count', tracked.length, D),
      record('security', 'sensitive_filename_count', sensitive.length, D),
      record('security', 'secret_scan_findings', findings.length, D),
      record('security', 'secret_scan_needs_review', needsReview.length, D),
      // Visibility is not knowable offline. If a caller supplies it, it came
      // from a document or a prior gh call — a narrative claim, not inspection.
      record('security', 'repository_visibility', isPublic === null ? 'UNKNOWN' : (isPublic ? 'PUBLIC' : 'PRIVATE'),
        isPublic === null ? D : N),
    ],
    payload: {
      tracked_file_count: tracked.length,
      sensitive_files: sensitive,
      env_examples: envExamples,
      missing_env_examples: missingEnvExample,
      secret_scan: {
        findings,
        needs_review: needsReview,
        note: 'values are never recorded; only the file, the pattern name and a classification',
      },
      repository_visibility: isPublic === null ? 'UNKNOWN' : (isPublic ? 'PUBLIC' : 'PRIVATE'),
    },
    warnings,
    errors,
  };
}
