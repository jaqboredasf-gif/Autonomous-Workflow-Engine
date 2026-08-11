// ---------------------------------------------------------------------------
// @awe/workflow — the AWE workflow engine.
//
// PURE. No I/O, no clock, no storage, no framework. It does not know what a
// purchase order is, what a vendor is, or what database anything lives in. It
// knows six words: state, action, guard, permission, evidence, event.
//
// WHY THIS EXISTS, stated as the defect it removes.
//
// In the application it was extracted from, "approve" existed as three
// unrelated fragments in three files: a permission checked in a use case, a
// precondition buried in a chain of `if (to === 'APPROVED' && !facts.hasReview)`
// inside a guard, and an event the caller passed to an emitter afterwards.
// Nothing bound them. An action could be added with a permission and no event,
// or a precondition and no permission, and nothing would notice — the knowledge
// of what a transition REQUIRES was spread across the callers rather than held
// in one place.
//
// So the unit here is the ACTION, and an action is only definable as all four
// things at once: what it needs, who may do it, where it lands, and what it
// records. defineWorkflow() refuses anything less at definition time, which is
// the point — an incomplete action is not a run-time failure to be caught by a
// test, it is a shape that cannot be written down.
//
// WHAT THE CALLER STILL OWNS, and must:
//   * the FACTS. The engine never reads a repository. It is handed a plain
//     object and evaluates named predicates against it.
//   * the POLICY. The engine never decides who somebody is. It calls an
//     injected function and believes the answer.
//   * the EFFECTS. The engine never writes. It calls the two functions it was
//     given, in the order the guarantee requires.
// Each of those is a boundary rather than a dependency, which is what lets this
// be reused by an application that stores nothing the way the first one did.
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary of refusals. Callers may switch on these; anything not
 * in this list is a bug in the engine rather than a decision about a workflow.
 */
export const REFUSAL_REASONS = Object.freeze([
  'unknown_action',
  'unknown_state',
  'terminal_state',
  'illegal_transition',
  'missing_permission',
  'missing_evidence',
  'guard_failed',
]);

const isPlainString = (v) => typeof v === 'string' && v.length > 0;

/**
 * Compile a workflow definition, or refuse it.
 *
 * Throws — deliberately, at module load rather than at run time. A malformed
 * workflow is a programming error that should stop the process starting, not a
 * request that fails in front of a user six weeks later.
 *
 * @param {object} spec
 * @param {string} spec.name
 * @param {string[]} spec.states          every legal state
 * @param {string[]} [spec.terminal]      states nothing may leave
 * @param {object} spec.actions           actionName -> {
 *     from: string|string[],   which states the action may be taken in
 *     to: string,              the resulting state
 *     permission: string,      the requirement handed to the policy function
 *     event: string,           the event kind this transition MUST record
 *     requires?: string[],     named facts that must be truthy
 *     guard?: (facts) => true | {reason, message}   arbitrary extra condition
 *     description?: string,
 *   }
 */
export function defineWorkflow(spec) {
  const name = spec?.name;
  if (!isPlainString(name)) throw new Error('a workflow needs a name');

  const states = Object.freeze([...(spec.states ?? [])]);
  if (!states.length) throw new Error(`${name}: a workflow needs states`);
  const terminal = Object.freeze([...(spec.terminal ?? [])]);
  for (const t of terminal) {
    if (!states.includes(t)) throw new Error(`${name}: terminal state ${t} is not a state`);
  }

  const actions = {};
  for (const [action, def] of Object.entries(spec.actions ?? {})) {
    // FOUR THINGS OR NOTHING. This is the invariant the whole module exists for:
    // an action that cannot say what it records is not a transition, it is an
    // untracked mutation wearing one's clothes.
    if (!isPlainString(def?.to)) throw new Error(`${name}.${action}: needs a target state`);
    // The permission may be a string, a function of the facts, or an explicit
    // null. Null means "no actor authority is required" — a SYSTEM transition,
    // one the application takes on its own behalf as a consequence of another.
    // It has to be written down as null rather than omitted: forgetting a
    // permission and deciding a step needs none are different acts, and only
    // one of them should be silent.
    if (!('permission' in (def ?? {}))) throw new Error(`${name}.${action}: needs a permission (or an explicit null)`);
    if (def.permission !== null && !isPlainString(def.permission) && typeof def.permission !== 'function') {
      throw new Error(`${name}.${action}: permission must be a string, a function of the facts, or null`);
    }
    if (!isPlainString(def?.event)) throw new Error(`${name}.${action}: needs an event kind`);

    const from = Object.freeze(Array.isArray(def.from) ? [...def.from] : [def.from]);
    if (!from.length || from.some((s) => !isPlainString(s))) {
      throw new Error(`${name}.${action}: needs at least one source state`);
    }
    for (const s of [...from, def.to]) {
      if (!states.includes(s)) throw new Error(`${name}.${action}: ${s} is not a state of this workflow`);
    }
    for (const s of from) {
      if (terminal.includes(s)) throw new Error(`${name}.${action}: ${s} is terminal and cannot be left`);
    }
    if (def.guard !== undefined && typeof def.guard !== 'function') {
      throw new Error(`${name}.${action}: guard must be a function`);
    }

    actions[action] = Object.freeze({
      name: action,
      from,
      to: def.to,
      permission: def.permission,
      event: def.event,
      requires: Object.freeze([...(def.requires ?? [])]),
      guard: def.guard ?? null,
      description: def.description ?? null,
    });
  }
  if (!Object.keys(actions).length) throw new Error(`${name}: a workflow needs at least one action`);

  return Object.freeze({
    name,
    states,
    terminal,
    actions: Object.freeze(actions),
    /** The actions legal FROM a state, ignoring facts and permissions. */
    actionsFrom(state) {
      return Object.values(actions).filter((a) => a.from.includes(state));
    },
  });
}

const refuse = (reason, message) => Object.freeze({ ok: false, reason, message, to: null, event: null });

/**
 * DECIDE whether an action may be taken, without doing it.
 *
 * Pure and side-effect free, so a user interface can ask "may I offer this
 * button" with exactly the rule the server will apply — the offered action
 * always succeeds and the unoffered one always fails, which is the property
 * that stops a screen lying to somebody.
 *
 * ORDER MATTERS AND IS FIXED. Existence, then legality, then permission, then
 * evidence. Permission is checked before evidence on purpose: a person who may
 * not do a thing should be told that, not told which document is missing from a
 * record they were never entitled to act on.
 *
 * Input: `{workflow, action, from, facts, can}`, where `can` is the policy
 * boundary — `(permission: string) => boolean`.
 *
 * @param {Record<string, any>} input
 */
export function decide(input) {
  const { workflow, action, from, facts = {}, can = () => true } = input ?? {};
  const definition = workflow?.actions?.[action];
  if (!definition) return refuse('unknown_action', `${workflow?.name}: no action ${action}`);
  if (!workflow.states.includes(from)) return refuse('unknown_state', `unknown state ${from}`);
  if (workflow.terminal.includes(from)) {
    return refuse('terminal_state', `${from} is terminal; a correction is a new record`);
  }
  if (!definition.from.includes(from)) {
    return refuse('illegal_transition', `${action} is not available from ${from}`);
  }
  // A requirement that depends on the record — "cancel your own with the
  // cheaper permission, anybody's with the dearer one" — is a function of the
  // facts rather than a second action. Resolved here so the policy boundary
  // still receives one plain permission name and knows nothing about why.
  const required = typeof definition.permission === 'function'
    ? definition.permission(facts)
    : definition.permission;
  if (required !== null && required !== undefined && !can(required)) {
    return refuse('missing_permission', `${action} requires ${required}`);
  }
  for (const fact of definition.requires) {
    if (!facts[fact]) return refuse('missing_evidence', `${action} requires ${fact}`);
  }
  if (definition.guard) {
    const verdict = definition.guard(facts);
    if (verdict !== true) {
      return refuse(verdict?.reason ?? 'guard_failed', verdict?.message ?? `${action} was refused`);
    }
  }
  return Object.freeze({ ok: true, reason: null, message: null, to: definition.to, event: definition.event });
}

/**
 * Take the action: decide, then apply the state and record the event.
 *
 * THE GUARANTEE, and the reason this is not simply `decide()` plus two calls at
 * the call site: **a successful transition cannot happen without its event.**
 * Both effects are invoked here, in this order, and the state write is awaited
 * before the event so a crash between them leaves a recorded state with a
 * missing event rather than an event describing something that never happened.
 * The caller cannot obtain the new state by any other path through this module,
 * so it cannot forget the second half.
 *
 * The two effects should be inside one transaction where the persistence layer
 * offers one. The engine cannot open a transaction — it has no idea what is
 * storing anything — so this is stated rather than enforced, and it is the one
 * guarantee that lives at the boundary instead of inside it.
 *
 * Takes everything decide() takes, plus `effects`:
 *
 *     effects.applyState(to)      persist the new state
 *     effects.recordEvent(event)  persist {kind, action, from, to}
 *
 * @param {Record<string, any>} input
 */
export async function executeTransition(input) {
  const verdict = decide(input);
  if (!verdict.ok) return verdict;

  const { effects } = input;
  if (typeof effects?.applyState !== 'function' || typeof effects?.recordEvent !== 'function') {
    // Not a refusal: a refusal is a statement about the workflow, and this is a
    // wiring mistake. It must not be catchable as "the transition was denied".
    throw new Error('executeTransition needs effects.applyState and effects.recordEvent');
  }

  const applied = await effects.applyState(verdict.to);
  await effects.recordEvent({
    kind: verdict.event,
    action: input.action,
    from: input.from,
    to: verdict.to,
  });

  return Object.freeze({ ...verdict, applied });
}

/**
 * Every action available to this actor on this record, right now.
 *
 * What a menu should be built from: it applies the same rule executeTransition
 * will, so an offered action cannot fail for a reason the screen could have
 * known.
 */
export function availableActions(input) {
  const { workflow, from, facts = {}, can = () => true } = input ?? {};
  return workflow
    .actionsFrom(from)
    .map((definition) => ({ action: definition.name, ...decide({ workflow, action: definition.name, from, facts, can }) }))
    .filter((result) => result.ok)
    .map((result) => ({ action: result.action, to: result.to, event: result.event }));
}
