// ---------------------------------------------------------------------------
// tools.mjs — the neutral Tool Descriptor and Tool Catalog.
//
// A tool today is a closure registered against one transport: the MCP server
// hard-codes ten of them, each carrying its own schema, its own error shape and
// its own idea of which tenant it is acting for. Nothing else in the platform
// can enumerate them, and a second surface (a CLI worker, a scheduled job, an
// app-server route) would have to re-declare all ten.
//
// A Tool Descriptor is the transport-independent statement of what a tool IS:
//
//   { name, version, title, description, workflow_id, input_schema,
//     output_schema, side_effect, requires_tenant, lifecycle, adapter,
//     metadata, descriptor_digest }
//
// ============================ WHAT IS NOT HERE ============================
//
// **ADR-0002 is unratified, so this module decides no authorization, and the
// omission is deliberate rather than an oversight.** There is no field, and no
// code path, for:
//
//   * who may invoke a tool (no capability list, no role, no actor check)
//   * tenant authorization policy (no per-org allow-list, no grant semantics)
//   * approval thresholds or approval requirements
//   * production enablement or a kill-switch policy
//   * timeout, retry or budget policy
//
// The two fields that look adjacent to policy are not policy, and the
// distinction is load-bearing:
//
//   `side_effect`     CLASSIFIES what the tool does to the world. It is a
//                     description, not a permission. Nothing here consults it;
//                     a future dispatcher will, once there is a ratified
//                     decision about what to do with it.
//   `requires_tenant` DECLARES that the tool reads or writes tenant-scoped
//                     data, so a caller knows an `org_id` is structurally
//                     necessary. It says a run must NAME its tenant. It does
//                     not say which tenants an actor may name — that is
//                     authorization, and it stays blocked.
//
// PURE: no clock, no randomness, no I/O. A descriptor is data; the adapter it
// names is a function the catalog stores and never calls.
// ---------------------------------------------------------------------------

import { deepFreeze, digest } from './canonical.mjs';
import { invariant } from './errors.mjs';

// What a tool does to the world, ordered least → most consequential. A
// classification, not a permission (see the header).
export const SIDE_EFFECTS = ['read', 'write_internal', 'human_visible', 'external'];

export const SIDE_EFFECT_RANK = Object.freeze(
  Object.fromEntries(SIDE_EFFECTS.map((s, i) => [s, i])),
);

// Where a tool is in its life, so a catalog can carry a replacement and its
// predecessor at once without a caller guessing which to use.
export const LIFECYCLE_STATES = ['draft', 'active', 'deprecated', 'retired'];

export const TOOL_DESCRIPTOR_KEYS = [
  'name', 'version', 'title', 'description', 'workflow_id', 'input_schema',
  'output_schema', 'side_effect', 'requires_tenant', 'lifecycle', 'metadata',
  'descriptor_digest',
];

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function compareSideEffect(a, b) {
  const ra = SIDE_EFFECT_RANK[a];
  const rb = SIDE_EFFECT_RANK[b];
  invariant(ra !== undefined && rb !== undefined, 'invalid_input', `unknown side effect '${ra === undefined ? a : b}'`, { a, b });
  return ra === rb ? 0 : ra < rb ? -1 : 1;
}

/**
 * defineTool(spec) -> frozen Tool Descriptor
 *
 * `input_schema` / `output_schema` are REFERENCES, not schema objects: a name,
 * a URI or a digest that some other layer resolves. Keeping them opaque is what
 * stops this module acquiring a dependency on zod, JSON Schema or any other
 * validator, and lets the MCP server keep using zod while a future app-server
 * route uses something else for the same tool.
 *
 * `adapter` is the implementation — `(input, context) -> outcome envelope`. It
 * is stored on the catalog ENTRY, never on the descriptor, so a descriptor
 * stays serializable and its digest stays stable across implementations.
 */
export function defineTool({
  name,
  version = '1.0.0',
  title = null,
  description,
  workflow_id,
  input_schema = null,
  output_schema = null,
  side_effect,
  requires_tenant = true,
  lifecycle = 'active',
  metadata = {},
} = {}) {
  invariant(
    typeof name === 'string' && NAME_PATTERN.test(name),
    'invalid_input', `tool name '${name}' must be snake_case`, { name },
  );
  invariant(
    typeof version === 'string' && VERSION_PATTERN.test(version),
    'invalid_input', `tool '${name}' version '${version}' must be semver major.minor.patch`, { name, version },
  );
  invariant(
    typeof description === 'string' && description.length > 0,
    'invalid_input', `tool '${name}' needs a description`, { name },
  );
  invariant(
    typeof workflow_id === 'string' && NAME_PATTERN.test(workflow_id),
    'invalid_input', `tool '${name}' workflow_id '${workflow_id}' must be snake_case`, { name, workflow_id },
  );
  invariant(
    SIDE_EFFECTS.includes(side_effect),
    'invalid_input', `tool '${name}' has unknown side_effect '${side_effect}'`,
    { name, side_effect, known: SIDE_EFFECTS },
  );
  // Not defaulted by inference and not optional: a tool that does not say
  // whether it touches tenant data is a tool nobody can safely route.
  invariant(
    typeof requires_tenant === 'boolean',
    'invalid_input', `tool '${name}' must declare requires_tenant: true|false`, { name },
  );
  invariant(
    LIFECYCLE_STATES.includes(lifecycle),
    'invalid_input', `tool '${name}' has unknown lifecycle '${lifecycle}'`,
    { name, lifecycle, known: LIFECYCLE_STATES },
  );
  invariant(
    input_schema === null || typeof input_schema === 'string',
    'invalid_input', `tool '${name}' input_schema must be a reference string or null`, { name },
  );
  invariant(
    output_schema === null || typeof output_schema === 'string',
    'invalid_input', `tool '${name}' output_schema must be a reference string or null`, { name },
  );
  invariant(
    metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata),
    'invalid_input', `tool '${name}' metadata must be a plain object`, { name },
  );

  const body = {
    name,
    version,
    title: title ?? name,
    description,
    workflow_id,
    input_schema,
    output_schema,
    side_effect,
    requires_tenant,
    lifecycle,
    metadata: { ...metadata },
  };

  // Stable across key order and across implementation changes: this is the
  // value a future registry-drift check compares against a stored row.
  return deepFreeze({ ...body, descriptor_digest: digest(body) });
}

export function assertToolDescriptor(descriptor, where = {}) {
  invariant(
    descriptor !== null && typeof descriptor === 'object' && !Array.isArray(descriptor),
    'contract_violation', 'tool descriptor must be an object', { ...where },
  );
  for (const key of TOOL_DESCRIPTOR_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(descriptor, key),
      'contract_violation', `tool descriptor is missing '${key}'`, { ...where, key, name: descriptor.name },
    );
  }
  const { descriptor_digest, ...rest } = descriptor;
  invariant(
    digest(rest) === descriptor_digest,
    'contract_violation', `tool '${descriptor.name}' descriptor_digest does not match its content`,
    { ...where, expected: digest(rest), actual: descriptor_digest },
  );
  return descriptor;
}

/**
 * createToolCatalog(entries) -> frozen catalog
 *
 * Each entry is `{ descriptor, adapter }`. The catalog answers "what tools
 * exist and what do they do"; it answers nothing about who may call them, and
 * `invoke()` deliberately does not exist here — dispatch belongs to whatever
 * builds an execution context and calls `runWorkflow`, so that no tool can be
 * executed outside the run scaffolding.
 */
export function createToolCatalog(entries = []) {
  const byName = new Map();

  for (const entry of entries) {
    const descriptor = assertToolDescriptor(entry.descriptor ?? entry, { at: 'createToolCatalog' });
    const adapter = entry.adapter ?? null;
    invariant(
      adapter === null || typeof adapter === 'function',
      'invalid_input', `tool '${descriptor.name}' adapter must be a function`, { name: descriptor.name },
    );
    invariant(
      !byName.has(descriptor.name),
      'invalid_input', `duplicate tool name '${descriptor.name}'`, { name: descriptor.name },
    );
    byName.set(descriptor.name, Object.freeze({ descriptor, adapter }));
  }

  const sorted = [...byName.values()].sort((a, b) => (a.descriptor.name < b.descriptor.name ? -1 : 1));

  return Object.freeze({
    names() { return sorted.map((e) => e.descriptor.name); },
    has(name) { return byName.has(name); },
    get(name) {
      const entry = byName.get(name);
      // Fail closed: an unknown tool name is a refusal, never a silent no-op.
      invariant(entry !== undefined, 'not_supported', `no tool named '${name}'`, { name, known: [...byName.keys()] });
      return entry;
    },
    descriptor(name) { return this.get(name).descriptor; },
    adapter(name) { return this.get(name).adapter; },
    // The serializable catalog: what a discovery endpoint or an app-server
    // route returns. Adapters are omitted because a function is not data.
    describe() { return sorted.map((e) => e.descriptor); },
    ofSideEffect(side_effect) { return sorted.filter((e) => e.descriptor.side_effect === side_effect).map((e) => e.descriptor); },
    active() { return sorted.filter((e) => e.descriptor.lifecycle === 'active').map((e) => e.descriptor); },
    catalog_digest() { return digest(sorted.map((e) => e.descriptor)); },
  });
}
