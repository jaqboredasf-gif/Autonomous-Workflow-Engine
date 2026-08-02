// ---------------------------------------------------------------------------
// context-check.mjs — freshness check for the Persistent Cognition Layer.
//
//   npm run context:check
//
// validate-context.mjs asks "is this layer well-formed?". This asks the harder
// question: "is it still TRUE?". A cognition layer that is structurally perfect
// and describes last week's commit is worse than no layer, because an agent will
// believe it.
//
// This version REPORTS ONLY. It rewrites nothing. Automatic refresh is a
// deliberate non-goal in v1: a document that silently updates itself cannot be
// used as evidence of what was verified, and by whom, and when.
//
// OFFLINE and READ-ONLY. Exits 1 on a staleness error, 0 on warnings alone.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';

import { readGitState, collectKnownPaths } from './lib/context-compiler/fs-sources.mjs';
import { detectCommit, detectDate } from './lib/context-compiler/records.mjs';
import { EVIDENCE_STATUSES } from './lib/context-compiler/contract.mjs';
import { REQUIRED_FILES } from './lib/context-validator.mjs';

const root = process.cwd();
const posix = (p) => p.split(sep).join('/');
const findings = [];
const add = (level, file, message) => findings.push({ level, file, message });

const git = readGitState(root);
const knownPaths = collectKnownPaths(root);
const knownBranches = new Set(git.branches);
const contextDir = join(root, 'context');

// Paths whose change invalidates a verification claim. A cognition file that was
// verified at an ancestor commit is NOT stale merely because HEAD moved — if
// only documentation advanced since, every statement it makes about the code is
// still true. Flagging that would train readers to ignore the check, which is
// worse than not running it. What matters is whether the *evidence surface*
// moved underneath the claim.
const EVIDENCE_PATHS = /^(packages|supabase|scripts|apps)\//;

const sh = (args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
};

/**
 * Classify a referenced commit.
 *   'current'  — it is HEAD
 *   'fresh'    — an ancestor of HEAD, and no evidence path changed since
 *   'stale'    — an ancestor, but code/migrations/scripts changed since
 *   'unknown'  — not an ancestor of HEAD (another branch, or rewritten history)
 */
function classifyRef(ref) {
  if (git.commit.startsWith(ref)) return { kind: 'current', changed: [] };
  const isAncestor = sh(['merge-base', '--is-ancestor', ref, 'HEAD']) !== null;
  if (!isAncestor) {
    // Not on this branch — but that is not automatically wrong. Cognition files
    // legitimately cite the tip of another branch (the M365 branch, say) and
    // blob hashes when documenting a CRLF-only diff. Distinguish "a real object
    // this branch does not contain" from "a hash that names nothing at all".
    const type = sh(['cat-file', '-t', ref]);
    if (type === 'commit') return { kind: 'other_branch', changed: [] };
    if (type) return { kind: 'not_a_commit', changed: [], type };
    return { kind: 'unknown', changed: [] };
  }
  // --name-status, not --name-only: an ADDED file cannot invalidate a claim
  // about files that already existed. Only modification, deletion and rename
  // move the ground under a verification claim. Counting additions would mark
  // the layer stale every time anyone adds a script, which is how a freshness
  // check becomes noise people mute.
  const diff = sh(['diff', '--name-status', `${ref}..HEAD`]) || '';
  const changed = diff.split('\n')
    .map((l) => l.split('\t'))
    .filter(([status, p]) => status && p && /^[MDR]/.test(status) && EVIDENCE_PATHS.test(p))
    .map(([, p]) => p);
  return { kind: changed.length ? 'stale' : 'fresh', changed };
}

// --- required files ---------------------------------------------------------
for (const f of REQUIRED_FILES) {
  if (!existsSync(join(contextDir, f))) add('error', f, 'required cognition file is missing');
}

const files = existsSync(contextDir)
  ? readdirSync(contextDir).filter((f) => f.endsWith('.md'))
  : [];

const packetIds = new Map();

for (const f of files) {
  const path = posix(relative(root, join(contextDir, f)));
  const text = readFileSync(join(contextDir, f), 'utf8');

  // --- commit staleness -----------------------------------------------------
  // A cognition file that names a commit is asserting "this was true there".
  // See classifyRef: an ancestor commit with no evidence-path changes since is
  // still a true statement, and is reported as such rather than as an error.
  for (const m of text.matchAll(/`([0-9a-f]{7,40})`/g)) {
    const ref = m[1];
    const { kind, changed, type } = classifyRef(ref);
    if (kind === 'current' || kind === 'fresh') continue;
    if (kind === 'other_branch') {
      add('warn', path, `cites commit ${ref.slice(0, 7)}, which exists but is not in this branch's history — fine as a cross-branch reference, misleading if read as current state`);
      continue;
    } else if (kind === 'not_a_commit') {
      add('warn', path, `cites ${ref.slice(0, 7)}, which is a ${type}, not a commit`);
      continue;
    } else if (kind === 'unknown') {
      // A hex token that names no Git object. This repository's docs are full of
      // n8n workflow ids (`e0d2b551`) that look exactly like short SHAs, so this
      // cannot be an error without producing confident nonsense — the failure
      // mode the whole cognition layer exists to prevent. Warn and move on.
      add('warn', path, `cites ${ref}, which names no Git object — if this is meant to be a commit it is wrong; if it is an external id (an n8n workflow, say) it is fine`);
      continue;
    } else {
      const sample = changed.slice(0, 3).join(', ');
      add('error', path, `verified at ${ref.slice(0, 7)}, but ${changed.length} evidence path(s) changed since (${sample}${changed.length > 3 ? ', …' : ''}) — re-verify`);
    }
    break; // one finding per file is enough to act on
  }

  // --- branch existence -----------------------------------------------------
  for (const m of text.matchAll(/`((?:codex|feat|claude|security|chore)\/[a-z0-9-]+)`/g)) {
    if (!knownBranches.has(m[1])) add('warn', path, `references branch "${m[1]}" which does not exist locally or on origin`);
  }

  // --- source paths ---------------------------------------------------------
  for (const m of text.matchAll(/`([A-Za-z0-9_@./-]+\.(?:mjs|js|ts|tsx|sql|md|json|toml|sh|yml|yaml))`/g)) {
    const p = m[1];
    if (!p.includes('/') || p.startsWith('http')) continue;
    if (!knownPaths.has(p) && !existsSync(join(root, p))) {
      add('warn', path, `references ${p}, which does not exist at this commit`);
    }
  }

  // --- dates ----------------------------------------------------------------
  if (!detectDate(text)) add('error', path, 'no explicit YYYY-MM-DD date');
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [, y, mo, d] = m;
    const n = Number(mo);
    const day = Number(d);
    if (n < 1 || n > 12 || day < 1 || day > 31 || Number(y) < 2000) {
      add('error', path, `invalid date: ${m[0]}`);
    }
  }

  // --- evidence status hygiene ---------------------------------------------
  // A row that claims VERIFIED must point at something. "Verified" with no
  // source is the exact failure mode the evidence hierarchy exists to stop.
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('VERIFIED')) continue;
    if (!/`VERIFIED`|\bVERIFIED\b/.test(line)) continue;
    if (/REPORTED_NOT_VERIFIED|PARTIALLY_VERIFIED/.test(line)) continue;
    const hasSource = /`[^`]*[./][^`]*`/.test(line) || /Runner\s+[A-Z0-9]/.test(line) || /scripts\//.test(line);
    if (!hasSource && line.trim().startsWith('|')) {
      add('warn', path, `a row claims VERIFIED without naming a source: ${line.trim().slice(0, 100)}`);
    }
  }

  // --- unknown status tokens ------------------------------------------------
  for (const m of text.matchAll(/`([A-Z][A-Z_]{4,})`/g)) {
    const tok = m[1];
    if (EVIDENCE_STATUSES.includes(tok)) continue;
    if (/^(AWE|TEGG|LIPPOLIS|TRANSCEND|SUPABASE|AWE_ORG_ID|AWE_MODE|EMAIL|PASSWORD|BEGIN|PROMPT|END|CRLF|GREEN|FAIL|PASS|SKIP|HEAD|MIGRATION_IDENTITY_RESOLUTION|AWE_INT|MODULE_TYPELESS_PACKAGE_JSON|AI_EGRESS)/.test(tok)) continue;
    if (/^SUPABASE_/.test(tok)) continue;
    add('error', path, `"${tok}" looks like an evidence status but is not in the allowed set`);
  }

  // --- handoff anchors ------------------------------------------------------
  if (f === 'LATEST_AGENT_HANDOFF.md') {
    if (!detectCommit(text)) add('error', path, 'handoff names no commit');
    if (!/branch/i.test(text)) add('error', path, 'handoff names no branch');
  }

  // --- current state vs HEAD ------------------------------------------------
  // Held to the same ancestry rule as everything else: current-state verified at
  // an ancestor with no evidence-path movement since is still current.
  if (f === 'AWE_CURRENT_STATE.md') {
    const ref = detectCommit(text);
    if (ref) {
      const { kind, changed } = classifyRef(ref);
      if (kind === 'stale') {
        add('error', path, `current-state was verified at ${ref.slice(0, 7)}; ${changed.length} evidence path(s) have changed since — re-run the suites and update`);
      } else if (kind === 'unknown') {
        add('error', path, `current-state describes commit ${ref}, which is not in this branch's history`);
      }
    }
  }

  // --- empty required sections ---------------------------------------------
  const body = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('');
  if (body.length < 200) add('error', path, 'file has no substantive content');

  // --- duplicate packet ids -------------------------------------------------
  for (const m of text.matchAll(/\b(AWE-INT-\d{3}|PKT-[0-9a-f]{8,})\b/g)) {
    const id = m[1];
    if (!packetIds.has(id)) packetIds.set(id, new Set());
    packetIds.get(id).add(path);
  }
}

// A packet id defined as the *subject* of two different cognition files is a
// duplicate-definition smell. Mentions across files are normal, so this only
// fires for AGENT_EXECUTION_PACKET.md declaring more than one populated packet.
const packetFile = join(contextDir, 'AGENT_EXECUTION_PACKET.md');
if (existsSync(packetFile)) {
  const text = readFileSync(packetFile, 'utf8');
  const declared = [...text.matchAll(/^##\s*Task ID\s*\n+\s*(\S+)/gm)].map((m) => m[1]);
  const dupes = declared.filter((id, i) => declared.indexOf(id) !== i);
  for (const d of new Set(dupes)) add('error', 'AGENT_EXECUTION_PACKET.md', `duplicate packet id declared: ${d}`);
}

// --- report -----------------------------------------------------------------
const errors = findings.filter((f) => f.level === 'error');
const warns = findings.filter((f) => f.level === 'warn');

for (const f of findings) console.log(`${f.level === 'error' ? 'STALE' : 'warn '}  ${f.file}: ${f.message}`);

console.log(`\ncontext:check — repo ${git.repository} @ ${git.branch} ${git.commit.slice(0, 7)}${git.dirty_files.length ? ` (${git.dirty_files.length} dirty)` : ''}`);
console.log(`context:check: ${files.length} files, ${errors.length} staleness errors, ${warns.length} warnings`);
if (errors.length) {
  console.log('context:check: ACTION REQUIRED — the layer describes a state that is no longer current.');
  console.log('This command reports only; it does not rewrite context. Update the named files, then re-run.');
}
console.log(errors.length === 0 ? 'context:check: PASS' : 'context:check: FAIL');
process.exit(errors.length === 0 ? 0 : 1);
