// ---------------------------------------------------------------------------
// compile.mjs — assemble a packet from normalized records, and render it.
//
// The composition step. Everything above it is pure and testable; everything
// below it is a file write. `compile()` takes records plus an explicit clock
// value and returns { packet, manifest, warnings } — no I/O, no ambient time.
// That is what makes two runs at the same commit produce byte-identical JSON,
// which is what makes a packet usable as evidence rather than as a snapshot of
// somebody's afternoon.
//
// The Markdown rendering is for humans and for agents reading prose; the JSON is
// for machines. They are generated from the same packet object, so they cannot
// disagree.
// ---------------------------------------------------------------------------

import { digest, canonicalJson } from '../../../packages/awe-kernel/src/canonical.mjs';
import { SCHEMA_VERSION, validatePacket, warning } from './contract.mjs';
import { select } from './select.mjs';

// Prohibitions that apply to every packet regardless of task. Sourced from
// context/AGENT_OPERATING_POLICIES.md; restated here so a packet is complete
// even if an agent never opens the policy file.
export const UNIVERSAL_FORBIDDEN = [
  'push to any remote',
  'merge, rebase, reset --hard, force push, or delete a branch',
  'commit to main',
  'apply a migration in any environment',
  'contact a remote or shared Supabase database',
  'call Microsoft Graph',
  'contact or activate an n8n workflow',
  'send email to any recipient, real or synthetic',
  'print, commit, or paste a credential',
  'change repository visibility',
  'claim a test passed without running it',
];

export const UNIVERSAL_ALLOWED = [
  'read any file at this commit',
  'run credential-free offline suites (scripts/regression.sh --kinds=unit,offline,static)',
  'create or modify files inside the packet\'s allowed scope',
  'commit locally on a feature branch',
  'write generated output under ignored directories',
];

/**
 * @param records normalized context records
 * @param opts.objective  required, human-defined
 * @param opts.taskId     optional dispatch task id
 * @param opts.git        { repository, branch, commit, dirty_files, branches }
 * @param opts.generatedAt ISO instant — supplied, never read from a clock here
 */
export function compile(records, {
  objective, taskId = null, capability = null, git, generatedAt,
  limit = 40, minScore = 8, knownPaths = null, knownBranches = null,
} = {}) {
  if (!objective || !objective.trim()) throw new Error('compile() requires an objective');
  if (!git) throw new Error('compile() requires git state — repository identity is mandatory');
  if (!generatedAt) throw new Error('compile() requires generatedAt — the compiler owns no clock');

  const {
    selected, warnings: selWarnings, tokens, objectiveTags, absentTopics,
  } = select(records, objective, { limit, minScore, knownPaths, currentCommit: git.commit, knownBranches });

  const warnings = [...selWarnings];
  if ((git.dirty_files || []).length > 0) {
    warnings.push(warning('dirty_git_state',
      `working tree has ${git.dirty_files.length} uncommitted change(s); this packet describes a tree that is not fully committed`,
      { detail: { files: git.dirty_files.slice(0, 20) } }));
  }

  const by = (t) => selected.filter((s) => s.record.type === t);
  const uniq = (xs) => [...new Set(xs)].sort();

  const sources = selected.map((s) => ({
    source_path: s.record.source_path,
    section: s.record.section,
    type: s.record.type,
    evidence_status: s.record.evidence_status,
    support: s.record.support,
    last_verified: s.record.last_verified,
    ref: s.record.ref,
    score: s.score,
    included_because: s.why,
    summary: s.record.summary,
  }));

  const evidence_summary = sources.reduce((acc, s) => {
    acc[s.evidence_status] = (acc[s.evidence_status] || 0) + 1;
    return acc;
  }, {});

  const relevantFiles = uniq(selected.flatMap((s) => s.record.tags)
    .filter((t) => t.startsWith('path:')).map((t) => t.slice(5)));

  const relevantPackages = uniq(by('package').map((s) => s.record.section));

  const packetBody = {
    schema_version: SCHEMA_VERSION,
    packet_id: taskId || `PKT-${digest({ objective, commit: git.commit })}`,
    generated_at: generatedAt,
    repository: git.repository,
    branch: git.branch,
    commit: git.commit,
    objective: objective.trim(),
    task_id: taskId,
    capability,
    current_state: by('cognition')
      .filter((s) => /CURRENT_STATE/.test(s.record.source_path))
      .map((s) => ({ section: s.record.section, summary: s.record.summary, evidence_status: s.record.evidence_status })),
    relevant_files: relevantFiles,
    relevant_packages: relevantPackages,
    applicable_decisions: by('decision')
      .map((s) => ({ ref: s.record.source_path, title: s.record.section, status: s.record.evidence_status })),
    applicable_policies: by('cognition')
      .filter((s) => /AGENT_OPERATING_POLICIES/.test(s.record.source_path))
      .map((s) => ({ policy: s.record.section, summary: s.record.summary })),
    required_evidence: uniq(by('test').map((s) => s.record.source_path)),
    allowed_actions: UNIVERSAL_ALLOWED,
    forbidden_actions: UNIVERSAL_FORBIDDEN,
    known_blockers: selected
      .filter((s) => /blocker/i.test(s.record.section || ''))
      .map((s) => ({ source: s.record.source_path, section: s.record.section, summary: s.record.summary })),
    required_tests: uniq(by('test').filter((s) => s.record.evidence_status === 'VERIFIED').map((s) => s.record.source_path)),
    definition_of_done: [
      'every claim added to the repository cites a file path and an evidence status',
      'the credential-free regression suite still passes',
      'context/LATEST_AGENT_HANDOFF.md is updated with branch, commit, results and what was not executed',
      'no forbidden action in this packet was taken',
    ],
    required_handoff_format: 'context/AGENT_EXECUTION_PACKET.md — Required handoff format',
    sources,
    evidence_summary,
    warnings,
    staleness: {
      compiled_at_commit: git.commit,
      dirty: (git.dirty_files || []).length > 0,
      stale_sources: warnings.filter((w) => w.kind === 'stale_source').map((w) => w.source),
      absent_topics: absentTopics,
      newest_source_date: sources.map((s) => s.last_verified).filter(Boolean).sort().pop() || null,
    },
  };

  const errors = validatePacket(packetBody);

  const manifest = {
    schema_version: SCHEMA_VERSION,
    packet_id: packetBody.packet_id,
    generated_at: generatedAt,
    objective: packetBody.objective,
    objective_tokens: tokens,
    objective_tags: objectiveTags,
    selection: { limit, min_score: minScore, considered: records.length, selected: selected.length },
    sources,
  };

  return { packet: packetBody, manifest, warnings, errors };
}

/** Stable JSON. Same input, same bytes — canonicalJson sorts keys. */
export function toJson(value) {
  return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
}

/** Human- and agent-readable Markdown, generated from the same packet object. */
export function toMarkdown(packet) {
  const L = [];
  const list = (xs, f = (x) => `- ${x}`) => (xs && xs.length ? xs.map(f).join('\n') : '- _(none)_');

  L.push(`# Execution Packet — ${packet.packet_id}`);
  L.push('');
  L.push(`**Schema:** ${packet.schema_version} · **Generated:** ${packet.generated_at}`);
  L.push(`**Repository:** ${packet.repository} · **Branch:** \`${packet.branch}\` · **Commit:** \`${packet.commit}\``);
  if (packet.task_id) L.push(`**Task ID:** ${packet.task_id}`);
  if (packet.capability) L.push(`**Capability:** ${packet.capability}`);
  L.push('');
  L.push('## Objective');
  L.push('');
  L.push(packet.objective);
  L.push('');

  if (packet.warnings.length) {
    L.push('## ⚠ Read before acting');
    L.push('');
    L.push('This packet could not stand behind everything it contains. Each line below is a limit on what you may assume.');
    L.push('');
    for (const w of packet.warnings) L.push(`- **${w.kind}** — ${w.message}`);
    L.push('');
  }

  L.push('## Current verified state');
  L.push('');
  L.push(packet.current_state.length
    ? packet.current_state.map((s) => `- **${s.section}** \`${s.evidence_status}\` — ${s.summary}`).join('\n')
    : '- _(no current-state section matched this objective)_');
  L.push('');

  L.push('## Applicable policies — binding');
  L.push('');
  L.push(list(packet.applicable_policies, (p) => `- **${p.policy}** — ${p.summary}`));
  L.push('');

  L.push('## Forbidden actions');
  L.push('');
  L.push(list(packet.forbidden_actions));
  L.push('');

  L.push('## Allowed actions');
  L.push('');
  L.push(list(packet.allowed_actions));
  L.push('');

  L.push('## Known blockers');
  L.push('');
  L.push(list(packet.known_blockers, (b) => `- **${b.section}** (${b.source}) — ${b.summary}`));
  L.push('');

  L.push('## Relevant packages');
  L.push('');
  L.push(list(packet.relevant_packages, (p) => `- \`${p}\``));
  L.push('');

  L.push('## Relevant files');
  L.push('');
  L.push(list(packet.relevant_files, (f) => `- \`${f}\``));
  L.push('');

  L.push('## Applicable decisions');
  L.push('');
  L.push(list(packet.applicable_decisions, (d) => `- ${d.title} — \`${d.status}\` (${d.ref})`));
  L.push('');

  L.push('## Required tests');
  L.push('');
  L.push(list(packet.required_tests, (t) => `- \`${t}\``));
  L.push('');

  L.push('## Definition of done');
  L.push('');
  L.push(list(packet.definition_of_done));
  L.push('');

  L.push('## Required handoff format');
  L.push('');
  L.push(packet.required_handoff_format);
  L.push('');

  L.push('## Sources — every claim above traces to one of these');
  L.push('');
  L.push('| Source | Section | Status | Score | Included because |');
  L.push('|---|---|---|---|---|');
  for (const s of packet.sources) {
    L.push(`| \`${s.source_path}\` | ${s.section || '—'} | \`${s.evidence_status}\` | ${s.score} | ${s.included_because.join(', ')} |`);
  }
  L.push('');

  L.push('## Evidence summary');
  L.push('');
  L.push(Object.entries(packet.evidence_summary).sort()
    .map(([k, v]) => `- \`${k}\` × ${v}`).join('\n') || '- _(none)_');
  L.push('');

  L.push('## Staleness');
  L.push('');
  L.push(`- compiled at commit \`${packet.staleness.compiled_at_commit}\``);
  L.push(`- working tree dirty: **${packet.staleness.dirty ? 'yes' : 'no'}**`);
  L.push(`- newest source date: ${packet.staleness.newest_source_date || '_unknown_'}`);
  if (packet.staleness.stale_sources.length) L.push(`- stale sources: ${packet.staleness.stale_sources.join(', ')}`);
  if (packet.staleness.absent_topics.length) {
    L.push(`- **topics with no implementation in this repository:** ${packet.staleness.absent_topics.join(', ')}`);
  }
  L.push('');
  return `${L.join('\n')}`;
}
