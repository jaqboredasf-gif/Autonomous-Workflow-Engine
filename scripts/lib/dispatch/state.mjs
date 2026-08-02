// ---------------------------------------------------------------------------
// state.mjs — the dispatch task lifecycle.
//
// The whole point of this module is one rule:
//
//   A worker saying "done" does not make a task done.
//
// COMPLETE moves a task to AWAITING_VERIFICATION and no further. Only
// `dispatch:verify`, which checks tests, files, Git state and forbidden paths
// against the repository, can reach VERIFIED. There is deliberately no
// transition from CLAIMED or IN_PROGRESS straight to VERIFIED — not as a policy
// anyone must remember, but as a shape the state machine cannot express.
//
// PURE: no clock, no I/O. Transitions are data.
// ---------------------------------------------------------------------------

export const TASK_SCHEMA_VERSION = '1.0.0';

export const STATES = [
  'DRAFT',
  'READY',
  'CLAIMED',
  'IN_PROGRESS',
  'BLOCKED',
  'AWAITING_VERIFICATION',
  'VERIFIED',
  'REJECTED',
  'SUPERSEDED',
];

// from → allowed next states. Anything absent is refused.
export const TRANSITIONS = {
  DRAFT: ['READY', 'BLOCKED', 'SUPERSEDED'],
  READY: ['CLAIMED', 'BLOCKED', 'DRAFT', 'SUPERSEDED'],
  CLAIMED: ['IN_PROGRESS', 'AWAITING_VERIFICATION', 'BLOCKED', 'READY', 'SUPERSEDED'],
  IN_PROGRESS: ['AWAITING_VERIFICATION', 'BLOCKED', 'SUPERSEDED'],
  BLOCKED: ['READY', 'DRAFT', 'SUPERSEDED'],
  AWAITING_VERIFICATION: ['VERIFIED', 'REJECTED', 'BLOCKED'],
  // Terminal-ish. A rejected task goes back to READY for another attempt; a
  // verified one is only ever superseded, never quietly re-opened.
  VERIFIED: ['SUPERSEDED'],
  REJECTED: ['READY', 'SUPERSEDED'],
  SUPERSEDED: [],
};

export const REQUIRED_FIELDS = [
  'task_id', 'objective', 'capability', 'priority', 'status',
  'depends_on', 'requested_role', 'allowed_scope', 'forbidden_actions',
  'required_branch', 'required_tests', 'definition_of_done',
];

export const ROLES = ['Scout', 'Builder', 'Verifier', 'Integrator', 'Documentarian'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

export function isState(s) { return STATES.includes(s); }

export function canTransition(from, to) {
  if (!isState(from) || !isState(to)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

/**
 * Why a transition is refused, in words a human can act on. Returns null when
 * the transition is allowed.
 */
export function transitionError(from, to) {
  if (!isState(from)) return `"${from}" is not a valid state`;
  if (!isState(to)) return `"${to}" is not a valid state`;
  if (canTransition(from, to)) return null;
  if (to === 'VERIFIED' && from !== 'AWAITING_VERIFICATION') {
    return `a task cannot move ${from} → VERIFIED. Verification is earned by dispatch:verify, not asserted by a worker`;
  }
  return `${from} → ${to} is not an allowed transition (from ${from} you may go to: ${(TRANSITIONS[from] || []).join(', ') || 'nowhere'})`;
}

export function validateTask(task) {
  const errors = [];
  for (const f of REQUIRED_FIELDS) {
    if (task[f] === undefined || task[f] === null || task[f] === '') errors.push(`missing required field: ${f}`);
  }
  if (task.task_id && !/^[A-Z]+-[A-Z]+-\d{3}$/.test(task.task_id)) {
    errors.push(`task_id "${task.task_id}" must look like AWE-INT-101`);
  }
  if (task.status && !isState(task.status)) errors.push(`invalid status: ${task.status}`);
  if (task.priority && !PRIORITIES.includes(task.priority)) errors.push(`invalid priority: ${task.priority}`);
  if (task.requested_role && !ROLES.includes(task.requested_role)) errors.push(`invalid role: ${task.requested_role}`);
  if (task.allowed_scope && !Array.isArray(task.allowed_scope)) errors.push('allowed_scope must be an array of paths');
  if (task.forbidden_actions && !Array.isArray(task.forbidden_actions)) errors.push('forbidden_actions must be an array');
  if (Array.isArray(task.forbidden_actions) && task.forbidden_actions.length === 0) {
    errors.push('forbidden_actions is empty — a task with no stated prohibitions is not bounded');
  }
  return errors;
}

/** A task with every field present, so callers never guess a shape. */
export function newTask(fields = {}) {
  return {
    schema_version: TASK_SCHEMA_VERSION,
    task_id: null,
    objective: null,
    capability: null,
    priority: 'P2',
    status: 'DRAFT',
    depends_on: [],
    blocked_by: null,
    requested_role: 'Builder',
    allowed_scope: [],
    forbidden_actions: [],
    required_branch: null,
    required_starting_commit: null,
    required_evidence: [],
    required_tests: [],
    definition_of_done: [],
    packet_id: null,
    packet_path: null,
    claim_owner: null,
    claim_timestamp: null,
    result_handoff: null,
    verification: null,
    related_commits: [],
    blockers: [],
    history: [],
    ...fields,
  };
}

/** Append a transition to the task's own history. Time is supplied, not read. */
export function applyTransition(task, to, { at, by = null, note = null } = {}) {
  const err = transitionError(task.status, to);
  if (err) throw new Error(err);
  if (!at) throw new Error('applyTransition requires an explicit timestamp');
  return {
    ...task,
    status: to,
    history: [...(task.history || []), { from: task.status, to, at, by, note }],
  };
}

/**
 * Are this task's dependencies satisfied?
 * A dependency is satisfied only when it is VERIFIED — not merely finished, not
 * merely claimed. Depending on an unverified result is how a chain of tasks
 * inherits a mistake.
 */
export function dependencyErrors(task, byId) {
  const errs = [];
  for (const dep of task.depends_on || []) {
    const d = byId[dep];
    if (!d) { errs.push(`depends on ${dep}, which does not exist`); continue; }
    if (d.status !== 'VERIFIED') errs.push(`depends on ${dep}, which is ${d.status} (must be VERIFIED)`);
  }
  return errs;
}
