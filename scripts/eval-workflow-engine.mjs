// ---------------------------------------------------------------------------
// eval-workflow-engine.mjs — the AWE workflow engine, and the boundary it must
// not cross.
//
// Two halves:
//
//   1. THE ENGINE, tested against a workflow that has nothing to do with
//      purchasing. That is deliberate: if these tests needed a purchase order
//      to express themselves, the engine would not be reusable and the test
//      would be the first place it showed.
//
//   2. THE BOUNDARY, tested by reading the source. An engine that imports
//      Supabase, React or a vendor is not a platform capability, it is PCC code
//      in a different folder. Documentation cannot keep that true; a scan can.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ENGINE_DIR = join(ROOT, 'packages', 'workflow', 'src');
const APP = join(ROOT, 'apps', 'purchasing', 'src', 'purchasing');

const { defineWorkflow, decide, executeTransition, availableActions, REFUSAL_REASONS } =
  await import(join(ENGINE_DIR, 'index.mjs'));

let pass = 0;
const failures = [];
const check = (ok, name, detail = '') => {
  if (ok) { pass += 1; return; }
  failures.push(name);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (a, b, name) =>
  check(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const throws = (fn, name) => {
  try { fn(); check(false, name, 'it was accepted'); }
  catch { check(true, name); }
};

// ===========================================================================
console.log('--- a workflow that is not a purchase --------------------------');

// A luggage claim. Nothing here is a purchase order, a vendor or a job number,
// and the engine cannot tell the difference — which is the whole claim being
// tested.
const CLAIM = defineWorkflow({
  name: 'baggage.claim',
  states: ['OPEN', 'INVESTIGATING', 'SETTLED', 'DENIED'],
  terminal: ['SETTLED', 'DENIED'],
  actions: {
    investigate: { from: 'OPEN', to: 'INVESTIGATING', permission: 'claim.handle', event: 'claim.investigating' },
    settle: {
      from: 'INVESTIGATING', to: 'SETTLED', permission: 'claim.pay', event: 'claim.settled',
      requires: ['hasReceipt'],
      guard: (facts) => (facts.amount <= 500 ? true : { reason: 'over_limit', message: 'needs a manager' }),
    },
    deny: { from: ['OPEN', 'INVESTIGATING'], to: 'DENIED', permission: 'claim.handle', event: 'claim.denied' },
  },
});

eq(CLAIM.name, 'baggage.claim', 'a workflow keeps its name');
eq(CLAIM.actionsFrom('OPEN').map((a) => a.name), ['investigate', 'deny'], 'actions are listed per state');
eq(CLAIM.actionsFrom('SETTLED').map((a) => a.name), [], 'nothing leaves a terminal state');

console.log('--- an incomplete action cannot be written down ----------------');

// THE INVARIANT THE MODULE EXISTS FOR. Each of these is a real mistake somebody
// makes, and each must fail at definition time rather than in production.
const base = { states: ['A', 'B'], name: 'x' };
throws(() => defineWorkflow({ ...base, actions: { go: { from: 'A', to: 'B', permission: 'p' } } }),
  'an action with no event is refused — an untracked mutation is not a transition');
throws(() => defineWorkflow({ ...base, actions: { go: { from: 'A', to: 'B', event: 'e' } } }),
  'an action with no permission is refused');
throws(() => defineWorkflow({ ...base, actions: { go: { from: 'A', permission: 'p', event: 'e' } } }),
  'an action with no target state is refused');
throws(() => defineWorkflow({ ...base, actions: { go: { from: 'A', to: 'NOPE', permission: 'p', event: 'e' } } }),
  'an action landing outside the state set is refused');
throws(() => defineWorkflow({ ...base, terminal: ['B'], actions: { go: { from: 'B', to: 'A', permission: 'p', event: 'e' } } }),
  'an action leaving a terminal state is refused');
throws(() => defineWorkflow({ ...base, actions: {} }), 'a workflow with no actions is refused');
throws(() => defineWorkflow({ states: ['A'], actions: { go: { from: 'A', to: 'A', permission: 'p', event: 'e' } } }),
  'a nameless workflow is refused');

console.log('--- refusals, in the order that protects the reader -------------');

const allow = () => true;
const deny = () => false;
const facts = { hasReceipt: true, amount: 100 };

eq(decide({ workflow: CLAIM, action: 'nope', from: 'OPEN', can: allow }).reason, 'unknown_action',
  'an unknown action is refused');
eq(decide({ workflow: CLAIM, action: 'settle', from: 'NOWHERE', can: allow }).reason, 'unknown_state',
  'an unknown state is refused');
eq(decide({ workflow: CLAIM, action: 'investigate', from: 'SETTLED', can: allow }).reason, 'terminal_state',
  'nothing may leave a terminal state');
eq(decide({ workflow: CLAIM, action: 'settle', from: 'OPEN', can: allow, facts }).reason, 'illegal_transition',
  'an action unavailable from this state is refused');
eq(decide({ workflow: CLAIM, action: 'settle', from: 'INVESTIGATING', can: deny, facts }).reason, 'missing_permission',
  'an actor without the permission is refused');
eq(decide({ workflow: CLAIM, action: 'settle', from: 'INVESTIGATING', can: allow, facts: { amount: 100 } }).reason,
  'missing_evidence', 'missing evidence is refused');
eq(decide({ workflow: CLAIM, action: 'settle', from: 'INVESTIGATING', can: allow, facts: { hasReceipt: true, amount: 900 } }).reason,
  'over_limit', "a guard's own reason survives to the caller");

// PERMISSION BEFORE EVIDENCE, deliberately: somebody who may not act on a
// record should not learn which document that record is missing.
eq(decide({ workflow: CLAIM, action: 'settle', from: 'INVESTIGATING', can: deny, facts: {} }).reason,
  'missing_permission', 'permission is decided before evidence, so a stranger learns nothing about the record');

check(REFUSAL_REASONS.includes('missing_evidence') && REFUSAL_REASONS.length === 7,
  'the refusal vocabulary is closed and complete');

console.log('--- a valid transition names where it lands and what it records -');

const ok = decide({ workflow: CLAIM, action: 'settle', from: 'INVESTIGATING', can: allow, facts });
check(ok.ok && ok.to === 'SETTLED' && ok.event === 'claim.settled',
  'a permitted action reports its target state and its event');

eq(availableActions({ workflow: CLAIM, from: 'OPEN', can: allow, facts }).map((a) => a.action),
  ['investigate', 'deny'], 'the menu is what would actually succeed');
eq(availableActions({ workflow: CLAIM, from: 'OPEN', can: deny, facts }), [],
  'an actor with no permissions is offered nothing');
eq(availableActions({ workflow: CLAIM, from: 'INVESTIGATING', can: allow, facts: { amount: 900, hasReceipt: true } })
  .map((a) => a.action), ['deny'],
  'an action whose guard would refuse is not offered — the menu cannot lie');

console.log('--- the event is not optional -----------------------------------');

{
  const written = [];
  const result = await executeTransition({
    workflow: CLAIM, action: 'investigate', from: 'OPEN', can: allow, facts,
    effects: {
      applyState: async (to) => { written.push(['state', to]); return { to }; },
      recordEvent: async (e) => { written.push(['event', e.kind, e.from, e.to, e.action]); },
    },
  });
  check(result.ok, 'the transition succeeds');
  eq(written, [['state', 'INVESTIGATING'], ['event', 'claim.investigating', 'OPEN', 'INVESTIGATING', 'investigate']],
    'THE GUARANTEE: state first, then the event, both of them, every time');
}

{
  // A refused transition writes NOTHING. Not a state, not an event.
  const written = [];
  const result = await executeTransition({
    workflow: CLAIM, action: 'settle', from: 'OPEN', can: allow, facts,
    effects: { applyState: async () => written.push('state'), recordEvent: async () => written.push('event') },
  });
  check(!result.ok && result.reason === 'illegal_transition', 'the refusal is reported');
  eq(written, [], 'a refused transition writes nothing at all');
}

{
  // Wiring mistakes must NOT look like refusals. A caller that forgot its
  // effects has a bug, and swallowing it as "denied" would hide a workflow
  // that silently stopped recording anything.
  let threw = false;
  try {
    await executeTransition({ workflow: CLAIM, action: 'investigate', from: 'OPEN', can: allow, facts });
  } catch { threw = true; }
  check(threw, 'missing effects throw rather than being reported as a denial');
}

// ===========================================================================
console.log('--- the boundary: what the engine may not know -----------------');

const engineSource = readdirSync(ENGINE_DIR)
  .filter((f) => f.endsWith('.mjs') || f.endsWith('.ts'))
  .map((f) => readFileSync(join(ENGINE_DIR, f), 'utf8'))
  .join('\n');

// An engine that imports anything at all is on its way to importing the wrong
// thing. It currently imports nothing, and that is worth pinning.
const imports = [...engineSource.matchAll(/^\s*import\s.+?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
eq(imports, [], 'the engine imports nothing — no framework, no product, no platform');

for (const forbidden of ['supabase', 'next/', 'react', 'node:fs', 'node:sqlite', 'postgres', '@exattime']) {
  check(!engineSource.toLowerCase().includes(forbidden),
    `the engine does not mention ${forbidden}`);
}

// Product vocabulary. The engine may say "state" and "evidence"; the moment it
// says "vendor" it has stopped being reusable.
// Checked against the CODE, not the prose: the header comment is where the
// engine explains which nouns it must never learn, and it has to be able to
// name them to do that.
const engineCode = engineSource
  .split('\n')
  .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
  .join('\n');
for (const word of ['vendor', 'purchase', 'invoice', 'job number', 'jobnumber',
                    'workshop', 'lippolis', 'po_number']) {
  check(!engineCode.toLowerCase().includes(word),
    `no product noun in engine code: ${word}`);
}

console.log('--- the boundary: PCC uses the authoritative path ---------------');

const contextSource = readFileSync(join(APP, 'application', 'context.ts'), 'utf8');
check(/from '@awe\/workflow'/.test(contextSource),
  'the transition chokepoint imports the engine by package name, not by a relative path into it');
check(/executeTransition\(/.test(contextSource), 'and calls executeTransition');
check(!/transitionGuard/.test(contextSource),
  'the superseded guard is gone from the chokepoint — there is one workflow system, not two');

// Every state change goes through transitionTo(). A use case writing `status`
// directly would bypass the engine, its permission check and its event.
for (const file of ['requests.ts', 'decisions.ts', 'fulfilment.ts', 'review.ts', 'administration.ts']) {
  const src = readFileSync(join(APP, 'application', file), 'utf8');
  const direct = [...src.matchAll(/\.update\([^)]*status:/gs)].length;
  check(direct === 0, `${file} never writes a status directly — every change goes through the engine`,
    `${direct} direct status write(s)`);
}

// The definition is PCC's, and it must not have drifted from the status graph
// the database's CHECK constraints are written against.
const { PURCHASING_WORKFLOW, actionForTargetState } = await import(join(APP, 'domain', 'purchasing-workflow.mjs'));
const { REQUEST_STATUSES, TRANSITIONS, TERMINAL_STATUSES } = await import(join(APP, 'domain', 'status.mjs'));

eq([...PURCHASING_WORKFLOW.states], [...REQUEST_STATUSES],
  'the workflow definition uses the same states as status.mjs — one list, not two');
eq([...PURCHASING_WORKFLOW.terminal], [...TERMINAL_STATUSES], 'and the same terminal states');

// Every edge the definition can take must be an edge the old graph allowed.
// This is what makes "no behaviour changed" a checked claim rather than a hope.
for (const action of Object.values(PURCHASING_WORKFLOW.actions)) {
  for (const from of action.from) {
    check((TRANSITIONS[from] ?? []).includes(action.to),
      `${action.name}: ${from} -> ${action.to} is an edge the status graph already allowed`);
  }
}

// And every edge the graph allows is reachable by some action, so the migration
// did not quietly drop a transition the product still needs.
for (const [from, targets] of Object.entries(TRANSITIONS)) {
  for (const to of targets) {
    const covered = Object.values(PURCHASING_WORKFLOW.actions)
      .some((a) => a.from.includes(from) && a.to === to);
    check(covered, `the graph edge ${from} -> ${to} is reachable by an action`);
  }
}

check(actionForTargetState('APPROVED') === 'approve', 'the target-state bridge resolves an unambiguous state');
check(actionForTargetState('PARTIALLY_RECEIVED') === 'recordPartialReceipt'
  || actionForTargetState('PARTIALLY_RECEIVED') === null,
  'and refuses to guess when a state has more than one route in');

// Every permission the workflow names must be a real permission, or the policy
// boundary is being asked a question authorize() cannot answer.
const { PERMISSIONS } = await import(join(APP, 'domain', 'roles.mjs'));
for (const action of Object.values(PURCHASING_WORKFLOW.actions)) {
  if (action.permission === null) continue;            // a system transition
  // A requirement that depends on the record is resolved both ways, so BOTH
  // branches are checked against the real permission list rather than only the
  // one that happens to be taken first.
  const required = typeof action.permission === 'function'
    ? [action.permission({ isOwner: true }), action.permission({ isOwner: false })]
    : [action.permission];
  for (const permission of required) {
    check(PERMISSIONS.includes(permission),
      `${action.name} requires a real permission (${permission})`);
  }
}

// Exactly one action may be systemic, and it must be the queueing step. A
// second permissionless action is how a workflow quietly stops being governed.
const systemic = Object.values(PURCHASING_WORKFLOW.actions).filter((a) => a.permission === null).map((a) => a.name);
eq(systemic, ['queue'], 'only the automatic queueing step runs without actor authority');

// Every event kind must be one the activity log knows how to describe.
const { ACTIVITY_ACTIONS } = await import(join(APP, 'domain', 'activity.mjs'));
for (const action of Object.values(PURCHASING_WORKFLOW.actions)) {
  check(ACTIVITY_ACTIONS.includes(action.event),
    `${action.name} records a known activity action (${action.event})`);
}

console.log('');
console.log(`workflow engine checks: ${pass} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
