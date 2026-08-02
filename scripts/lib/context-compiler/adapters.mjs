// ---------------------------------------------------------------------------
// adapters.mjs — one adapter per context source.
//
// Eight sources, eight small functions, one output shape. Each adapter receives
// already-read material (text, or a plain state object) and returns normalized
// records. None of them touch the filesystem: that boundary lives in
// fs-sources.mjs, so the whole selection pipeline can be tested with synthetic
// input and stays replayable.
//
// The adapters are deliberately shallow. They classify and tag; they do not
// interpret. An adapter that "understood" a document would be a place for a
// claim to gain confidence it did not earn.
// ---------------------------------------------------------------------------

import {
  makeRecord, splitSections, detectStatus, detectDate, detectCommit,
  deriveTags, derivePaths, summarize,
} from './records.mjs';

/** 1. Persistent Cognition markdown — context/*.md */
export function fromCognition(sourcePath, text) {
  const fileDate = detectDate(text);
  const fileCommit = detectCommit(text);
  return splitSections(text)
    .filter((s) => s.heading && s.body.length > 40)
    .map((s) => makeRecord({
      type: 'cognition',
      source_path: sourcePath,
      section: s.heading,
      summary: summarize(s.body),
      evidence_status: detectStatus(s.body) || detectStatus(s.heading) || 'VERIFIED',
      tags: [...deriveTags(`${s.heading} ${s.body}`), ...derivePaths(s.body).map((p) => `path:${p}`)],
      last_verified: detectDate(s.body) || fileDate,
      ref: detectCommit(s.body) || fileCommit,
      body: s.body,
    }));
}

/** 2. Integration evidence documents — docs/integration/*.md */
export function fromEvidenceDoc(sourcePath, text) {
  const fileDate = detectDate(text);
  return splitSections(text)
    .filter((s) => s.heading && s.body.length > 40)
    .map((s) => makeRecord({
      type: 'evidence',
      source_path: sourcePath,
      section: s.heading,
      summary: summarize(s.body),
      // Evidence documents must declare a status. Absent one, the safe default
      // is UNKNOWN — never VERIFIED.
      evidence_status: detectStatus(s.body) || 'UNKNOWN',
      tags: [...deriveTags(`${s.heading} ${s.body}`), ...derivePaths(s.body).map((p) => `path:${p}`)],
      last_verified: detectDate(s.body) || fileDate,
      ref: detectCommit(s.body),
      body: s.body,
    }));
}

/** 3. Git state — supplied by fs-sources.mjs, never read here. */
export function fromGit(git) {
  const dirty = (git.dirty_files || []).length > 0;
  return [makeRecord({
    type: 'git',
    source_path: '.git',
    section: 'repository state',
    summary: `${git.repository} on ${git.branch} @ ${git.commit}${dirty ? ` — ${git.dirty_files.length} dirty file(s)` : ' — clean'}`,
    evidence_status: 'VERIFIED',
    tags: ['git', `branch:${git.branch}`, ...(git.branches || []).map((b) => `branch:${b}`)],
    last_verified: git.observed_at ? git.observed_at.slice(0, 10) : null,
    ref: git.commit,
    body: JSON.stringify({ ...git }, null, 2),
  })];
}

/** 4. Workspace package metadata. */
export function fromPackages(pkgs) {
  return pkgs.map((p) => makeRecord({
    type: 'package',
    source_path: p.path,
    section: p.name,
    summary: `${p.name}@${p.version} — ${p.module_count} module(s)`,
    evidence_status: 'VERIFIED',
    tags: [p.dir, ...deriveTags(p.name)],
    ref: null,
    body: `${p.name}@${p.version}\nmodules: ${(p.modules || []).join(', ')}`,
  }));
}

/** 5. Decisions and ADRs — docs/architecture/decisions/*.md */
export function fromDecision(sourcePath, text) {
  const title = (text.split(/\r?\n/).find((l) => l.startsWith('#')) || '').replace(/^#+\s*/, '').trim();
  const statusLine = (text.split(/\r?\n/).find((l) => /status/i.test(l)) || '').trim();
  const accepted = /accepted|ratified/i.test(statusLine);
  return [makeRecord({
    type: 'decision',
    source_path: sourcePath,
    section: title || sourcePath,
    summary: title,
    // A Proposed ADR is a strategic decision that nobody ratified. That is
    // exactly PARTIALLY_VERIFIED: real, recorded, not agreed.
    evidence_status: accepted ? 'VERIFIED' : 'PARTIALLY_VERIFIED',
    tags: [...deriveTags(`${title} ${text}`), accepted ? 'adr:accepted' : 'adr:proposed'],
    last_verified: detectDate(statusLine) || detectDate(text),
    body: `${title}\n${statusLine}`,
  })];
}

/** 6. Migration inventory. */
export function fromMigrations(migrations) {
  return migrations.map((m) => makeRecord({
    type: 'migration',
    source_path: m.path,
    section: m.name,
    summary: `migration ${m.ordinal} — ${m.name} (${m.lines} lines)`,
    // Files exist; whether they were applied is not knowable from the repo.
    evidence_status: 'PARTIALLY_VERIFIED',
    tags: [`migration:${m.ordinal}`, 'migration', ...deriveTags(m.name)],
    body: `${m.name}\nordinal ${m.ordinal}, ${m.lines} lines`,
  }));
}

/** 7. Test and evaluator inventory. */
export function fromTests(suites) {
  return suites.map((s) => makeRecord({
    type: 'test',
    source_path: s.path,
    section: s.runner ? `Runner ${s.runner}` : s.name,
    summary: `${s.name}${s.runner ? ` (Runner ${s.runner})` : ''} — ${s.kind}`,
    // A suite that needs a credential we do not have is LIVE_BLOCKED, and the
    // packet should say so rather than list it as an available check.
    evidence_status: s.kind === 'db' ? 'LIVE_BLOCKED' : 'VERIFIED',
    tags: [s.kind, ...deriveTags(`${s.name} ${s.path}`)],
    body: `${s.path}\nkind: ${s.kind}`,
  }));
}

/** 8. Dispatch queue entries. */
export function fromDispatch(sourcePath, text) {
  return splitSections(text)
    .filter((s) => s.heading && /^AWE-INT-\d{3}/.test(s.heading))
    .map((s) => makeRecord({
      type: 'dispatch',
      source_path: sourcePath,
      section: s.heading,
      summary: summarize(s.body),
      evidence_status: 'PARTIALLY_VERIFIED',
      tags: deriveTags(`${s.heading} ${s.body}`),
      last_verified: detectDate(text),
      body: s.body,
    }));
}

/** 9. The human-supplied objective. Always present, always first-class. */
export function fromObjective(objective, taskId = null) {
  return [makeRecord({
    type: 'objective',
    source_path: '<user>',
    section: taskId || 'objective',
    summary: objective,
    // The objective is a given, not a claim about the repository.
    evidence_status: 'VERIFIED',
    tags: deriveTags(objective),
    body: objective,
  })];
}
