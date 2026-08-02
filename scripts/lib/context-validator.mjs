// ---------------------------------------------------------------------------
// context-validator.mjs — pure validation logic for the Persistent Cognition
// Layer under context/.
//
// Deliberately dependency-free and side-effect-free: every function takes the
// text it validates and returns findings. The CLI (scripts/validate-context.mjs)
// does the file I/O; the eval (scripts/eval-context-validator.mjs) drives these
// functions with synthetic inputs. That split is what makes the validator
// testable without writing fixture files to disk.
//
// A finding is { level: 'error' | 'warn', file, message }.
// ---------------------------------------------------------------------------

import { ORIGINS } from './evidence/schema.mjs';
import { STATES as TASK_STATES } from './dispatch/state.mjs';
import { CLASSIFICATIONS as INGEST_CLASSES } from './cognition/ingest.mjs';

export const REQUIRED_FILES = [
  'AWE_IDENTITY.md',
  'AWE_CURRENT_STATE.md',
  'AWE_SYSTEM_MAP.md',
  'ACTIVE_CAPABILITY_SPECIFICATION.md',
  'AGENT_OPERATING_POLICIES.md',
  'CRITICAL_DECISIONS.md',
  'VERIFIED_EVIDENCE.md',
  'LATEST_AGENT_HANDOFF.md',
  'AGENT_EXECUTION_PACKET.md',
  'AWE_UBIQUITOUS_LANGUAGE.md',
];

// Sections each file must contain, matched case-insensitively as substrings of
// the document. Kept deliberately small: the validator checks that a document
// still answers its question, not that it has a particular outline.
export const REQUIRED_SECTIONS = {
  'AWE_IDENTITY.md': ['What AWE is', 'What AWE is not', 'Constitutional principles'],
  'AWE_CURRENT_STATE.md': ['Canonical repository', 'Packages', 'migrations', 'branches', 'blockers'],
  'AWE_SYSTEM_MAP.md': ['Package map', 'Database ownership', 'External adapters'],
  'ACTIVE_CAPABILITY_SPECIFICATION.md': ['Objective', 'Scope', 'Non-scope', 'Dependencies', 'Completion conditions', 'Required evidence', 'Forbidden actions', 'Known blockers'],
  'AGENT_OPERATING_POLICIES.md': ['Inspect before editing', 'No live side effects', 'durable handoff'],
  'CRITICAL_DECISIONS.md': ['Decision', 'Status', 'Consequence'],
  'VERIFIED_EVIDENCE.md': ['Capability', 'Status', 'Limitations'],
  'LATEST_AGENT_HANDOFF.md': ['Branch', 'Commit', 'Next safest bounded task', 'intentionally not executed'],
  'AGENT_EXECUTION_PACKET.md': ['Task ID', 'Objective', 'Allowed scope', 'Forbidden actions', 'Required tests', 'Required evidence', 'Definition of done', 'Required handoff format'],
  'AWE_UBIQUITOUS_LANGUAGE.md': ['Code-backed terms', 'DO NOT EXIST'],
};

export const ALLOWED_STATUSES = [
  'VERIFIED', 'PARTIALLY_VERIFIED', 'REPORTED_NOT_VERIFIED', 'GENERATED_NOT_APPLIED',
  'MOCK_ONLY', 'LIVE_BLOCKED', 'FAILED', 'SUPERSEDED', 'UNKNOWN',
];

// A bare uppercase token that looks like a status word. Anchored on word
// boundaries so ALLOWED_STATUSES listed in prose are matched too.
const STATUS_SHAPED = /\b[A-Z][A-Z_]{4,}\b/g;

// Other closed vocabularies the cognition layer legitimately writes about. They
// are IMPORTED rather than restated so a new dispatch state or ingestion
// classification cannot silently start failing validation — and so nobody is
// tempted to "fix" a failure by adding a one-off exemption.
const ADJACENT_VOCABULARIES = [
  ...ORIGINS,          // evidence provenance
  ...TASK_STATES,      // dispatch lifecycle
  ...INGEST_CLASSES,   // handoff ingestion
];

// Words that are uppercase-shaped but are not status claims. Without this the
// validator would flag ordinary prose (package names, SQL, file names).
const STATUS_EXEMPT = new Set([
  ...ADJACENT_VOCABULARIES,
  'AWE', 'TEGG', 'ADR', 'RLS', 'SQL', 'JSON', 'HTTP', 'HTTPS', 'YAML', 'TODO', 'NOTE',
  'README', 'LICENSE', 'MCP', 'API', 'CLI', 'PR', 'SHA', 'UTC', 'PC', 'OS', 'ID',
  'AI_EGRESS', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'AWE_ORG_ID', 'AWE_MODE', 'EMAIL', 'PASSWORD', 'NNN', 'MODULE_TYPELESS_PACKAGE_JSON',
  'BEGIN', 'PROMPT', 'END', 'CRLF', 'WSL', 'GREEN', 'FAIL', 'PASS', 'SKIP', 'HEAD',
  // Repository and directory names that legitimately appear in backticks.
  'TRANSCEND', 'LIPPOLIS', 'AWE_INT', 'MIGRATION_IDENTITY_RESOLUTION',
]);

// Secret-shaped literals. Deliberately conservative: we look for assigned values
// and known token prefixes, not for the mere word "password", so that policy
// documents can talk about secrets without tripping their own validator.
const SECRET_PATTERNS = [
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'assigned secret value', re: /\b(?:api[_-]?key|secret|service[_-]?role[_-]?key|access[_-]?token|password)\s*[:=]\s*["'][^"'\s]{8,}["']/i },
  { name: 'supabase url', re: /https:\/\/[a-z0-9]{16,}\.supabase\.co/i },
];

// ISO date, the only date format context files may use.
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

export function checkRequiredSections(file, text) {
  const wanted = REQUIRED_SECTIONS[file] || [];
  const hay = text.toLowerCase();
  return wanted
    .filter((s) => !hay.includes(s.toLowerCase()))
    .map((s) => ({ level: 'error', file, message: `missing required section or phrase: "${s}"` }));
}

export function checkNotEmpty(file, text) {
  // "Empty" means no substantive body, not literally zero bytes: a file holding
  // only a title would pass a length check but orient nobody.
  const body = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('');
  return body.length < 200
    ? [{ level: 'error', file, message: `file has no substantive content (${body.length} non-heading chars, need >= 200)` }]
    : [];
}

export function checkStatusVocabulary(file, text) {
  const allowed = new Set(ALLOWED_STATUSES);
  const bad = new Set();
  for (const tok of text.match(STATUS_SHAPED) || []) {
    if (allowed.has(tok) || STATUS_EXEMPT.has(tok)) continue;
    // Only complain about tokens that look like a status claim: they appear
    // inside backticks or a table cell, which is how this repo writes them.
    const quoted = new RegExp('[`|]\\s*' + tok + '\\s*[`|]').test(text);
    if (quoted) bad.add(tok);
  }
  return [...bad].map((t) => ({
    level: 'error',
    file,
    message: `"${t}" is used as a status but is not in the allowed set (${ALLOWED_STATUSES.join(', ')})`,
  }));
}

export function checkDates(file, text) {
  return ISO_DATE.test(text)
    ? []
    : [{ level: 'error', file, message: 'no explicit YYYY-MM-DD date found; every context file must be dated' }];
}

export function checkSecrets(file, text) {
  return SECRET_PATTERNS
    .filter((p) => p.re.test(text))
    .map((p) => ({ level: 'error', file, message: `possible secret detected (${p.name}) — remove it before committing` }));
}

// The handoff must name where it was taken from, or it cannot be trusted.
export function checkHandoffAnchors(file, text) {
  const findings = [];
  if (!/\b[0-9a-f]{7,40}\b/.test(text)) {
    findings.push({ level: 'error', file, message: 'no commit SHA found; the handoff must record the commit it describes' });
  }
  if (!/(branch)/i.test(text)) {
    findings.push({ level: 'error', file, message: 'no branch named; the handoff must record its branch' });
  }
  return findings;
}

export function checkPacketFields(file, text) {
  const required = [
    'Task ID', 'Objective', 'Current verified state', 'Relevant files',
    'Applicable decisions', 'Applicable policies', 'Allowed scope', 'Forbidden actions',
    'Required tests', 'Required evidence', 'Definition of done', 'Required handoff format',
  ];
  const hay = text.toLowerCase();
  return required
    .filter((f) => !hay.includes(f.toLowerCase()))
    .map((f) => ({ level: 'error', file, message: `execution packet is missing required field: "${f}"` }));
}

// Repo-relative paths referenced in backticks. Only paths that look like real
// source references are returned — prose in backticks is ignored.
export function extractRepoPaths(text) {
  const out = new Set();
  for (const m of text.matchAll(/`([A-Za-z0-9_@./-]+\.(?:mjs|js|ts|tsx|sql|md|json|toml|sh|yml|yaml))`/g)) {
    const p = m[1];
    if (p.startsWith('http') || p.startsWith('@')) continue;
    if (!p.includes('/')) continue; // bare filenames are ambiguous; skip
    out.add(p);
  }
  return [...out];
}

export function validateDocument(file, text) {
  const findings = [
    ...checkNotEmpty(file, text),
    ...checkRequiredSections(file, text),
    ...checkStatusVocabulary(file, text),
    ...checkDates(file, text),
    ...checkSecrets(file, text),
  ];
  if (file === 'LATEST_AGENT_HANDOFF.md') findings.push(...checkHandoffAnchors(file, text));
  if (file === 'AGENT_EXECUTION_PACKET.md') findings.push(...checkPacketFields(file, text));
  return findings;
}
