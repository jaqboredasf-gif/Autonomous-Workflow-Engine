// ---------------------------------------------------------------------------
// handoff.mjs — the structured agent handoff contract.
//
// A handoff is a worker's account of what it did. It is testimony, not proof.
// This module's job is to make the testimony checkable: a fixed shape, a
// declared commit range, a declared side-effect list, and a completion assertion
// that cannot be made without the fields that would let someone falsify it.
//
// `validateHandoff` deliberately refuses a completion claim that lacks a commit
// range, test evidence when tests were required, a Git status, or an explicit
// side-effect declaration. A worker may still lie — but it cannot claim
// completion vaguely, and vagueness is the failure mode that actually happens.
//
// PURE: no I/O, no clock.
// ---------------------------------------------------------------------------

export const HANDOFF_SCHEMA_VERSION = '1.0.0';

export const REQUIRED_FIELDS = [
  'schema_version', 'task_id', 'packet_id', 'worker',
  'starting_branch', 'starting_commit', 'ending_branch', 'ending_commit',
  'files_created', 'files_modified', 'files_deleted',
  'commands_run', 'tests_run', 'results',
  'evidence_produced', 'claims_verified', 'claims_unverified',
  'blockers', 'side_effects_performed', 'side_effects_not_performed',
  'suggested_next_task', 'git_status', 'diff_summary', 'completion_assertion',
];

export const COMPLETION_ASSERTIONS = ['COMPLETE', 'PARTIAL', 'BLOCKED', 'NO_CODE_CHANGE'];

export function newHandoff(fields = {}) {
  return {
    schema_version: HANDOFF_SCHEMA_VERSION,
    task_id: null,
    packet_id: null,
    worker: null,
    starting_branch: null,
    starting_commit: null,
    ending_branch: null,
    ending_commit: null,
    files_created: [],
    files_modified: [],
    files_deleted: [],
    commands_run: [],
    tests_run: [],
    results: [],
    evidence_produced: [],
    claims_verified: [],
    claims_unverified: [],
    blockers: [],
    side_effects_performed: [],
    side_effects_not_performed: [],
    suggested_next_task: null,
    git_status: null,
    diff_summary: null,
    completion_assertion: null,
    ...fields,
  };
}

/**
 * @param handoff the submitted handoff
 * @param opts.requiredTests tests the task demanded, if any
 */
export function validateHandoff(handoff, { requiredTests = [] } = {}) {
  const errors = [];
  for (const f of REQUIRED_FIELDS) {
    if (!(f in handoff)) errors.push(`missing field: ${f}`);
  }
  if (handoff.schema_version !== HANDOFF_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${HANDOFF_SCHEMA_VERSION}, got ${handoff.schema_version}`);
  }
  if (!handoff.task_id) errors.push('a handoff without a task_id cannot be attributed to any work');
  if (!handoff.packet_id) errors.push('a handoff without a packet_id cannot be tied to the context it was given');
  if (!COMPLETION_ASSERTIONS.includes(handoff.completion_assertion)) {
    errors.push(`completion_assertion must be one of ${COMPLETION_ASSERTIONS.join(', ')}`);
  }

  const claimsCompletion = handoff.completion_assertion === 'COMPLETE';

  if (claimsCompletion) {
    // A completion claim must be falsifiable. Each of these is something a
    // reviewer could check and find wrong.
    const hasRange = handoff.starting_commit && handoff.ending_commit;
    const noCode = handoff.completion_assertion === 'NO_CODE_CHANGE';
    if (!hasRange && !noCode) {
      errors.push('a COMPLETE handoff needs a starting_commit and an ending_commit, or an explicit NO_CODE_CHANGE assertion');
    }
    if (requiredTests.length && (!handoff.tests_run || handoff.tests_run.length === 0)) {
      errors.push(`the task required tests (${requiredTests.join(', ')}) but the handoff records none`);
    }
    if (requiredTests.length && (!handoff.results || handoff.results.length === 0)) {
      errors.push('tests were required but no results are recorded — a test name without an outcome proves nothing');
    }
    if (!handoff.git_status) errors.push('a COMPLETE handoff must record git status');
    if (!Array.isArray(handoff.side_effects_not_performed) || handoff.side_effects_not_performed.length === 0) {
      errors.push('a COMPLETE handoff must declare which side effects were NOT performed — silence is not a declaration');
    }
    if (!Array.isArray(handoff.blockers)) {
      errors.push('a COMPLETE handoff must declare remaining blockers, even if the list is empty');
    }
  }

  return errors;
}

export function handoffToMarkdown(h) {
  const L = [];
  const list = (xs) => (xs && xs.length ? xs.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n') : '- _(none)_');
  L.push(`# Handoff — ${h.task_id}`);
  L.push('');
  L.push(`**Schema:** ${h.schema_version} · **Packet:** ${h.packet_id} · **Worker:** ${h.worker}`);
  L.push(`**Branch:** \`${h.starting_branch}\` → \`${h.ending_branch}\``);
  L.push(`**Commit:** \`${h.starting_commit}\` → \`${h.ending_commit}\``);
  L.push(`**Assertion:** \`${h.completion_assertion}\``);
  L.push('');
  const sec = (title, body) => { L.push(`## ${title}`); L.push(''); L.push(body); L.push(''); };
  sec('Files created', list(h.files_created));
  sec('Files modified', list(h.files_modified));
  sec('Files deleted', list(h.files_deleted));
  sec('Commands run', list(h.commands_run));
  sec('Tests run', list(h.tests_run));
  sec('Results', list(h.results));
  sec('Evidence produced', list(h.evidence_produced));
  sec('Claims verified', list(h.claims_verified));
  sec('Claims NOT verified', list(h.claims_unverified));
  sec('Blockers', list(h.blockers));
  sec('Side effects performed', list(h.side_effects_performed));
  sec('Side effects explicitly NOT performed', list(h.side_effects_not_performed));
  sec('Git status', `\`\`\`\n${h.git_status || '(none)'}\n\`\`\``);
  sec('Diff summary', `\`\`\`\n${h.diff_summary || '(none)'}\n\`\`\``);
  sec('Suggested next task', h.suggested_next_task || '_(none)_');
  return L.join('\n');
}
