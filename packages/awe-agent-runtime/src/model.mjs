import {
  assertContextBundle, assertToolDescriptor, canonicalClone, deepFreeze, digest,
  invariant, isPlainObject,
} from '../../awe-kernel/src/index.mjs';
import { assertAgentAction, defineAgentAction } from './action.mjs';

export const MODEL_REQUEST_SCHEMA = 'awe.agent_model_request/v1';
export const MODEL_RESPONSE_SCHEMA = 'awe.agent_model_response/v1';
export const MODEL_REQUEST_KEYS = [
  'schema', 'run_id', 'agent', 'turn', 'instructions', 'context_bundle',
  'tools', 'budget', 'request_digest',
];
export const MODEL_RESPONSE_KEYS = [
  'schema', 'request_digest', 'model_ref', 'action', 'usage', 'response_digest',
];

function closed(value, allowed, label, code = 'invalid_input') {
  invariant(isPlainObject(value), code, `${label} must be a plain object`, {});
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  invariant(unknown.length === 0, code, `${label} has unknown key(s) ${JSON.stringify(unknown.sort())}`, { unknown });
}

export function createModelRequest(spec = {}) {
  closed(spec, MODEL_REQUEST_KEYS.filter((key) => key !== 'request_digest'), 'model request');
  invariant(spec.schema === undefined || spec.schema === MODEL_REQUEST_SCHEMA, 'invalid_input', `model request schema must be '${MODEL_REQUEST_SCHEMA}'`, {});
  invariant(typeof spec.run_id === 'string' && spec.run_id.length > 0, 'invalid_input', 'model request needs run_id', {});
  invariant(isPlainObject(spec.agent), 'invalid_input', 'model request agent must be an object', {});
  closed(spec.agent, ['agent_id', 'version', 'manifest_digest'], 'model request agent');
  invariant(
    typeof spec.agent.agent_id === 'string'
    && typeof spec.agent.version === 'string'
    && typeof spec.agent.manifest_digest === 'string',
    'invalid_input', 'model request agent identity is incomplete', {},
  );
  invariant(Number.isInteger(spec.turn) && spec.turn >= 1, 'invalid_input', 'model request turn must be >= 1', {});
  invariant(isPlainObject(spec.instructions) && typeof spec.instructions.text === 'string', 'invalid_input', 'model request instructions are invalid', {});
  closed(spec.instructions, ['version', 'text'], 'model request instructions');
  invariant(typeof spec.instructions.version === 'string', 'invalid_input', 'model request instruction version is required', {});
  assertContextBundle(spec.context_bundle, { at: 'createModelRequest' });
  invariant(Array.isArray(spec.tools), 'invalid_input', 'model request tools must be an array', {});
  spec.tools.forEach((descriptor, index) => assertToolDescriptor(descriptor, { at: 'createModelRequest', index }));
  invariant(isPlainObject(spec.budget), 'invalid_input', 'model request budget must be an object', {});
  closed(
    spec.budget,
    ['turns_remaining', 'model_calls_remaining', 'tool_calls_remaining', 'tokens_remaining'],
    'model request budget',
  );
  for (const key of ['turns_remaining', 'model_calls_remaining', 'tool_calls_remaining', 'tokens_remaining']) {
    invariant(Number.isInteger(spec.budget[key]) && spec.budget[key] >= 0, 'invalid_input', `model request budget.${key} must be non-negative`, {});
  }
  const body = {
    schema: MODEL_REQUEST_SCHEMA,
    run_id: spec.run_id,
    agent: canonicalClone(spec.agent),
    turn: spec.turn,
    instructions: canonicalClone(spec.instructions),
    context_bundle: canonicalClone(spec.context_bundle),
    tools: canonicalClone(spec.tools),
    budget: canonicalClone(spec.budget),
  };
  return deepFreeze({ ...body, request_digest: digest(body) });
}

export function assertModelRequest(request, where = {}) {
  invariant(isPlainObject(request), 'contract_violation', 'model request must be an object', where);
  for (const key of MODEL_REQUEST_KEYS) invariant(Object.prototype.hasOwnProperty.call(request, key), 'contract_violation', `model request missing '${key}'`, where);
  closed(request, MODEL_REQUEST_KEYS, 'model request', 'contract_violation');
  const { request_digest, ...body } = request;
  const rebuilt = createModelRequest(body);
  invariant(rebuilt.request_digest === request_digest, 'contract_violation', 'model request digest does not match', {
    ...where, expected: rebuilt.request_digest, actual: request_digest,
  });
  return request;
}

export function createModelResponse(spec = {}) {
  closed(
    spec,
    ['schema', 'request_digest', 'model_ref', 'action', 'usage', 'response_digest']
      .filter((key) => key !== 'response_digest'),
    'model response',
  );
  invariant(
    spec.schema === undefined || spec.schema === MODEL_RESPONSE_SCHEMA,
    'invalid_input', `model response schema must be '${MODEL_RESPONSE_SCHEMA}'`, {},
  );
  const {
    request_digest, model_ref, action, usage,
  } = spec;
  invariant(typeof request_digest === 'string' && request_digest.length > 0, 'invalid_input', 'model response needs request_digest', {});
  invariant(typeof model_ref === 'string' && model_ref.length > 0, 'invalid_input', 'model response needs provider-neutral model_ref', {});
  const normalizedAction = action?.action_digest === undefined ? defineAgentAction(action) : assertAgentAction(action);
  closed(usage, ['input_tokens', 'output_tokens', 'total_tokens'], 'model response usage');
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    invariant(Number.isInteger(usage[key]) && usage[key] >= 0, 'invalid_input', `usage.${key} must be a non-negative integer`, {});
  }
  invariant(usage.total_tokens === usage.input_tokens + usage.output_tokens, 'invalid_input', 'usage.total_tokens must equal input_tokens + output_tokens', {});
  const body = {
    schema: MODEL_RESPONSE_SCHEMA,
    request_digest,
    model_ref,
    action: normalizedAction,
    usage: { ...usage },
  };
  return deepFreeze({ ...body, response_digest: digest(body) });
}

export function assertModelResponse(response, { request_digest = null, ...where } = {}) {
  invariant(isPlainObject(response), 'contract_violation', 'model response must be an object', where);
  for (const key of MODEL_RESPONSE_KEYS) invariant(Object.prototype.hasOwnProperty.call(response, key), 'contract_violation', `model response missing '${key}'`, where);
  closed(response, MODEL_RESPONSE_KEYS, 'model response', 'contract_violation');
  const { response_digest, ...body } = response;
  const rebuilt = createModelResponse(body);
  invariant(rebuilt.response_digest === response_digest, 'contract_violation', 'model response digest does not match', where);
  invariant(request_digest === null || response.request_digest === request_digest, 'contract_violation', 'model response is bound to a different request', {
    ...where, expected: request_digest, actual: response.request_digest,
  });
  return response;
}

export function defineModelAdapter(spec = {}) {
  closed(spec, ['profile', 'invoke'], 'model adapter');
  const { profile, invoke } = spec;
  invariant(typeof profile === 'string' && /^[a-z][a-z0-9_]*$/.test(profile), 'invalid_input', `model adapter profile '${profile}' must be snake_case`, {});
  invariant(typeof invoke === 'function', 'invalid_input', `model adapter '${profile}' needs invoke(request)`, {});
  return Object.freeze({
    profile,
    async invoke(request) {
      assertModelRequest(request, { at: `model_adapter:${profile}` });
      const produced = await invoke(request);
      return produced?.response_digest === undefined
        ? createModelResponse({ ...produced, request_digest: produced?.request_digest ?? request.request_digest })
        : assertModelResponse(produced, { request_digest: request.request_digest, at: `model_adapter:${profile}` });
    },
  });
}

export function createModelRegistry(adapters = []) {
  const index = new Map();
  for (const candidate of adapters) {
    const adapter = defineModelAdapter(candidate);
    invariant(!index.has(adapter.profile), 'invalid_input', `model profile '${adapter.profile}' is registered twice`, {});
    index.set(adapter.profile, adapter);
  }
  return Object.freeze({
    profiles: () => [...index.keys()].sort(),
    has: (profile) => index.has(profile),
    get(profile) {
      invariant(index.has(profile), 'not_supported', `model profile '${profile}' is not registered`, {
        profile, known: [...index.keys()].sort(),
      });
      return index.get(profile);
    },
  });
}

export function createReplayModelAdapter(spec = {}) {
  closed(spec, ['profile', 'records'], 'replay model adapter');
  const { profile = 'deterministic_replay', records = [] } = spec;
  invariant(Array.isArray(records), 'invalid_input', 'replay model adapter records must be an array', {});
  const byDigest = new Map();
  for (const record of records) {
    const response = assertModelResponse(record.response ?? record, { at: 'createReplayModelAdapter' });
    invariant(!byDigest.has(response.request_digest), 'invalid_input', `duplicate replay response for request '${response.request_digest}'`, {});
    byDigest.set(response.request_digest, response);
  }
  return defineModelAdapter({
    profile,
    invoke(request) {
      invariant(byDigest.has(request.request_digest), 'not_supported', `replay has no response for request '${request.request_digest}'`, {
        request_digest: request.request_digest,
      });
      return byDigest.get(request.request_digest);
    },
  });
}
