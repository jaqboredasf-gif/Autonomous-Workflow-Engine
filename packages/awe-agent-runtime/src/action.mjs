import {
  canonicalClone, deepFreeze, digest, invariant, isPlainObject,
} from '../../awe-kernel/src/index.mjs';

export const AGENT_ACTION_SCHEMA = 'awe.agent_action/v1';
export const AGENT_ACTION_KINDS = ['tool', 'finish', 'request_human'];

const COMMON_KEYS = ['schema', 'kind', 'reason_code', 'action_digest'];
const KEYS = {
  tool: [...COMMON_KEYS, 'tool', 'input'],
  finish: [...COMMON_KEYS, 'result', 'summary'],
  request_human: [...COMMON_KEYS, 'prompt'],
};
const ID = /^[a-z][a-z0-9_]*$/;

function closed(value, allowed, label) {
  invariant(isPlainObject(value), 'invalid_input', `${label} must be a plain object`, { label });
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  invariant(unknown.length === 0, 'invalid_input', `${label} has unknown key(s) ${JSON.stringify(unknown.sort())}`, {
    label, unknown: unknown.sort(),
  });
}

export function defineAgentAction(spec = {}) {
  const kind = spec.kind;
  invariant(AGENT_ACTION_KINDS.includes(kind), 'invalid_input', `agent action kind '${kind}' is unknown`, {
    kind, known: AGENT_ACTION_KINDS,
  });
  closed(spec, KEYS[kind].filter((key) => key !== 'action_digest'), `${kind} agent action`);
  invariant(
    spec.schema === undefined || spec.schema === AGENT_ACTION_SCHEMA,
    'invalid_input', `agent action schema must be '${AGENT_ACTION_SCHEMA}'`, { schema: spec.schema },
  );
  invariant(
    typeof spec.reason_code === 'string' && ID.test(spec.reason_code),
    'invalid_input', 'agent actions require a short snake_case reason_code, not free-form reasoning', {
      reason_code: spec.reason_code,
    },
  );

  let fields;
  if (kind === 'tool') {
    invariant(typeof spec.tool === 'string' && ID.test(spec.tool), 'invalid_input', `tool action name '${spec.tool}' must be snake_case`, {
      tool: spec.tool,
    });
    invariant(isPlainObject(spec.input), 'invalid_input', `tool '${spec.tool}' input must be a plain object`, { tool: spec.tool });
    fields = { tool: spec.tool, input: canonicalClone(spec.input) };
  } else if (kind === 'finish') {
    invariant(spec.result !== undefined, 'invalid_input', 'finish result must be present (null is allowed)', {});
    // Cloning is also the JSON contract check: functions, undefined object
    // members, cycles, class instances and non-finite numbers are refused by
    // the kernel's canonical serializer.
    const result = canonicalClone(spec.result);
    invariant(
      typeof spec.summary === 'string' && spec.summary.length > 0 && spec.summary.length <= 1000,
      'invalid_input', 'finish summary must be 1..1000 characters', {},
    );
    fields = { result, summary: spec.summary };
  } else {
    invariant(
      typeof spec.prompt === 'string' && spec.prompt.length > 0 && spec.prompt.length <= 2000,
      'invalid_input', 'human-request prompt must be 1..2000 characters', {},
    );
    fields = { prompt: spec.prompt };
  }

  const body = {
    schema: AGENT_ACTION_SCHEMA,
    kind,
    reason_code: spec.reason_code,
    ...fields,
  };
  return deepFreeze({ ...body, action_digest: digest(body) });
}

export function assertAgentAction(action, where = {}) {
  invariant(isPlainObject(action), 'contract_violation', 'agent action must be a plain object', where);
  invariant(AGENT_ACTION_KINDS.includes(action.kind), 'contract_violation', `unknown agent action kind '${action.kind}'`, where);
  for (const key of KEYS[action.kind]) {
    invariant(Object.prototype.hasOwnProperty.call(action, key), 'contract_violation', `agent action is missing '${key}'`, {
      ...where, key,
    });
  }
  closed(action, KEYS[action.kind], `${action.kind} agent action`);
  const { action_digest, ...body } = action;
  const rebuilt = defineAgentAction(body);
  invariant(rebuilt.action_digest === action_digest, 'contract_violation', 'agent action digest does not match its content', {
    ...where, expected: rebuilt.action_digest, actual: action_digest,
  });
  return action;
}
