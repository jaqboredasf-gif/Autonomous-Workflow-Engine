import {
  deepFreeze, digest, invariant, isPlainObject,
} from '../../awe-kernel/src/index.mjs';

export const AGENT_MANIFEST_SCHEMA = 'awe.agent_manifest/v1';
export const AGENT_LIFECYCLES = ['draft', 'active', 'deprecated', 'retired'];
export const EXECUTABLE_AGENT_LIFECYCLES = ['active', 'deprecated'];
export const AGENT_MANIFEST_KEYS = [
  'schema', 'agent_id', 'version', 'title', 'description', 'lifecycle',
  'workflow', 'model_profile', 'instructions', 'allowed_tools',
  'context', 'limits', 'metadata', 'manifest_digest',
];

const ID = /^[a-z][a-z0-9_]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const REQUIREMENT = /^\^?\d+\.\d+\.\d+$/;
const WORKFLOW_KEYS = ['workflow_id', 'version'];
const INSTRUCTION_KEYS = ['version', 'text'];
const CONTEXT_KEYS = ['max_tokens', 'max_items', 'max_sensitivity'];
const LIMIT_KEYS = ['max_turns', 'max_model_calls', 'max_tool_calls', 'max_total_tokens'];
const SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted'];

function closed(value, allowed, label) {
  invariant(isPlainObject(value), 'invalid_input', `${label} must be a plain object`, { label });
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  invariant(unknown.length === 0, 'invalid_input', `${label} has unknown key(s) ${JSON.stringify(unknown.sort())}`, {
    label, unknown: unknown.sort(), allowed,
  });
}

function positive(value, label, { min = 1 } = {}) {
  invariant(Number.isInteger(value) && value >= min, 'invalid_input', `${label} must be an integer >= ${min}`, {
    label, value,
  });
  return value;
}

export function defineAgentManifest(spec = {}) {
  closed(spec, AGENT_MANIFEST_KEYS.filter((key) => key !== 'manifest_digest'), 'agent manifest');
  invariant(
    spec.schema === undefined || spec.schema === AGENT_MANIFEST_SCHEMA,
    'invalid_input', `agent manifest schema must be '${AGENT_MANIFEST_SCHEMA}'`, { schema: spec.schema },
  );
  invariant(typeof spec.agent_id === 'string' && ID.test(spec.agent_id), 'invalid_input', `agent_id '${spec.agent_id}' must be snake_case`, {
    agent_id: spec.agent_id,
  });
  invariant(typeof spec.version === 'string' && SEMVER.test(spec.version), 'invalid_input', `agent '${spec.agent_id}' version must be pinned semver`, {
    version: spec.version,
  });
  invariant(typeof spec.description === 'string' && spec.description.length > 0, 'invalid_input', `agent '${spec.agent_id}' needs a description`, {});
  invariant(AGENT_LIFECYCLES.includes(spec.lifecycle), 'invalid_input', `agent '${spec.agent_id}' lifecycle '${spec.lifecycle}' is unknown`, {
    known: AGENT_LIFECYCLES,
  });

  closed(spec.workflow, WORKFLOW_KEYS, `agent '${spec.agent_id}' workflow`);
  invariant(typeof spec.workflow.workflow_id === 'string' && ID.test(spec.workflow.workflow_id), 'invalid_input', 'agent workflow_id must be snake_case', {});
  invariant(typeof spec.workflow.version === 'string' && REQUIREMENT.test(spec.workflow.version), 'invalid_input', 'agent workflow version must be semver or a caret requirement', {});
  invariant(typeof spec.model_profile === 'string' && ID.test(spec.model_profile), 'invalid_input', 'model_profile must be snake_case', {});

  closed(spec.instructions, INSTRUCTION_KEYS, `agent '${spec.agent_id}' instructions`);
  invariant(typeof spec.instructions.version === 'string' && SEMVER.test(spec.instructions.version), 'invalid_input', 'instruction version must be pinned semver', {});
  invariant(
    typeof spec.instructions.text === 'string' && spec.instructions.text.trim().length > 0,
    'invalid_input', 'agent instructions must contain text', {},
  );

  invariant(Array.isArray(spec.allowed_tools) && spec.allowed_tools.length > 0, 'invalid_input', 'agent allowed_tools must be a non-empty array', {});
  const allowed_tools = [...spec.allowed_tools];
  allowed_tools.forEach((tool) => invariant(typeof tool === 'string' && ID.test(tool), 'invalid_input', `allowed tool '${tool}' must be snake_case`, { tool }));
  invariant(new Set(allowed_tools).size === allowed_tools.length, 'invalid_input', 'agent allowed_tools contains a duplicate', {});

  const contextSource = spec.context ?? {};
  closed(contextSource, CONTEXT_KEYS, `agent '${spec.agent_id}' context`);
  const context = {
    max_tokens: positive(contextSource.max_tokens ?? 8000, 'context.max_tokens'),
    max_items: positive(contextSource.max_items ?? 200, 'context.max_items'),
    max_sensitivity: contextSource.max_sensitivity ?? 'restricted',
  };
  invariant(SENSITIVITIES.includes(context.max_sensitivity), 'invalid_input', `unknown context max_sensitivity '${context.max_sensitivity}'`, {});

  const limitSource = spec.limits ?? {};
  closed(limitSource, LIMIT_KEYS, `agent '${spec.agent_id}' limits`);
  const limits = {
    max_turns: positive(limitSource.max_turns ?? 12, 'limits.max_turns'),
    max_model_calls: positive(limitSource.max_model_calls ?? 12, 'limits.max_model_calls'),
    max_tool_calls: positive(limitSource.max_tool_calls ?? 8, 'limits.max_tool_calls', { min: 0 }),
    max_total_tokens: positive(limitSource.max_total_tokens ?? 50000, 'limits.max_total_tokens'),
  };
  invariant(limits.max_model_calls <= limits.max_turns, 'invalid_input', 'max_model_calls cannot exceed max_turns', {});
  invariant(limits.max_tool_calls <= limits.max_turns, 'invalid_input', 'max_tool_calls cannot exceed max_turns', {});

  const metadata = spec.metadata ?? {};
  invariant(isPlainObject(metadata), 'invalid_input', 'agent metadata must be a plain object', {});
  const body = {
    schema: AGENT_MANIFEST_SCHEMA,
    agent_id: spec.agent_id,
    version: spec.version,
    title: typeof spec.title === 'string' && spec.title.length > 0 ? spec.title : spec.agent_id,
    description: spec.description,
    lifecycle: spec.lifecycle,
    workflow: { ...spec.workflow },
    model_profile: spec.model_profile,
    instructions: { ...spec.instructions },
    allowed_tools: allowed_tools.sort(),
    context,
    limits,
    metadata: { ...metadata },
  };
  return deepFreeze({ ...body, manifest_digest: digest(body) });
}

export function assertAgentManifest(manifest, where = {}) {
  invariant(isPlainObject(manifest), 'contract_violation', 'agent manifest must be a plain object', where);
  for (const key of AGENT_MANIFEST_KEYS) {
    invariant(Object.prototype.hasOwnProperty.call(manifest, key), 'contract_violation', `agent manifest is missing '${key}'`, {
      ...where, key,
    });
  }
  closed(manifest, AGENT_MANIFEST_KEYS, 'agent manifest');
  const { manifest_digest, ...body } = manifest;
  const rebuilt = defineAgentManifest(body);
  invariant(rebuilt.manifest_digest === manifest_digest, 'contract_violation', `agent '${manifest.agent_id}' manifest digest does not match`, {
    ...where, expected: rebuilt.manifest_digest, actual: manifest_digest,
  });
  return manifest;
}
