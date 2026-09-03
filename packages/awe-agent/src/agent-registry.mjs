// ---------------------------------------------------------------------------
// agent-registry.mjs — the versioned Agent Registry.
//
// The same promise the Workflow Registry makes, for agents: this is the ONLY
// way to obtain something runnable. A caller states an agent id, a version
// requirement and a tenant, and gets back a RESOLUTION — either a registered,
// active, in-scope definition, or a refusal with a registered reason.
//
// There is no parameter, anywhere in this package, through which a caller can
// supply an agent DEFINITION to be executed. That is what makes bypassing the
// registry impossible rather than merely discouraged, and it is asserted
// structurally by Runner G.
//
// FAIL-CLOSED RESOLUTION RULES, in the order they are checked:
//
//   1. the agent exists at all                     -> agent_not_registered
//   2. the caller stated a version                 -> agent_version_unknown
//      (an agent is NEVER resolved to "whatever is current": a run that cannot
//       name the version it executed cannot be replayed, and an approval
//       recorded against it cannot be re-bound)
//   3. a version satisfying the requirement exists  -> agent_version_incompatible
//   4. that version's status admits execution:
//        draft       -> agent_not_active   (never executable)
//        disabled    -> agent_disabled     (never executable, not overridable)
//        deprecated  -> agent_deprecated   unless the caller PINNED this exact
//                       version and passed allow_deprecated: true
//   5. the tenant is in the definition's scope      -> agent_tenant_out_of_scope
//
// AN AGENT CANNOT ALTER ITS OWN ENTRY. This registry has no `register`, no
// `update`, no `remove` and no `activate` after construction; the set of
// definitions is fixed when the registry is built, and every returned object is
// deep-frozen. The harness is handed the registry's `resolve` result, never the
// registry's internals.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { compareVersionsDesc, deepFreeze, digest, invariant, satisfiesVersion } from './kernel.mjs';
import {
  agentTenantInScope, assertAgentDefinition, defineAgentDefinition,
} from './agent-definition.mjs';

export const AGENT_RESOLUTION_REASONS = [
  'agent_not_registered',
  'agent_version_unknown',
  'agent_version_incompatible',
  'agent_not_active',
  'agent_disabled',
  'agent_deprecated',
  'agent_tenant_out_of_scope',
];

const REQUIREMENT_PATTERN = /^\^?\d+\.\d+\.\d+$/;
const PINNED_PATTERN = /^\d+\.\d+\.\d+$/;

function refuse(reason, detail, extra = {}) {
  return deepFreeze({ ok: false, reason, detail, definition: null, ...extra });
}

export function createAgentRegistry(definitions = []) {
  // agent_id -> Map(version -> definition)
  const byId = new Map();

  for (const candidate of definitions) {
    const definition = candidate?.definition_digest === undefined
      ? defineAgentDefinition(candidate)
      : assertAgentDefinition(candidate, { at: 'createAgentRegistry' });

    const versions = byId.get(definition.agent_id) ?? new Map();
    invariant(
      !versions.has(definition.version),
      'invalid_input',
      `agent '${definition.agent_id}' version '${definition.version}' is registered twice`,
      { agent_id: definition.agent_id, version: definition.version },
    );
    versions.set(definition.version, definition);
    byId.set(definition.agent_id, versions);
  }

  // A registered version is IMMUTABLE. Two documents claiming the same
  // (agent_id, version) with different content is the shape of "somebody edited
  // an active agent in place", and it is refused at construction rather than
  // discovered when a paused run resumes into different behaviour.
  for (const [agent_id, versions] of byId.entries()) {
    const digests = new Set([...versions.values()].map((d) => d.definition_digest));
    invariant(
      digests.size === versions.size,
      'invalid_input', `agent '${agent_id}' has two versions with the same content digest`, { agent_id },
    );
  }

  function versionsOf(agent_id) {
    return [...(byId.get(agent_id)?.keys() ?? [])].sort(compareVersionsDesc);
  }

  function get(agent_id, version) {
    return byId.get(agent_id)?.get(version) ?? null;
  }

  /**
   * resolve({ agent_id, version, org_id, allow_deprecated })
   *   -> { ok, reason, detail, definition, resolved_version }
   *
   * Returns DATA rather than throwing: a refusal to run an agent is a normal,
   * expected, fail-closed outcome that the harness turns into a `blocked`
   * envelope. Genuine caller bugs (no agent id at all) still throw.
   */
  function resolve({ agent_id, version = null, org_id = null, allow_deprecated = false } = {}) {
    invariant(
      typeof agent_id === 'string' && agent_id.length > 0,
      'invalid_input', 'resolve() needs an agent_id', { agent_id },
    );
    invariant(
      version === null || (typeof version === 'string' && REQUIREMENT_PATTERN.test(version)),
      'invalid_input', `agent version requirement '${version}' must be 'x.y.z', '^x.y.z' or null`, { version },
    );

    if (!byId.has(agent_id)) {
      return refuse('agent_not_registered', `no agent '${agent_id}' is registered`, { agent_id });
    }
    const available = versionsOf(agent_id);
    if (version === null) {
      return refuse(
        'agent_version_unknown',
        `agent '${agent_id}' must be requested at an explicit version; available: ${JSON.stringify(available)}`,
        { agent_id, available },
      );
    }

    const match = available.map((v) => get(agent_id, v)).find((d) => satisfiesVersion(d.version, version));
    if (match === undefined) {
      return refuse(
        'agent_version_incompatible',
        `no version of agent '${agent_id}' satisfies '${version}'; available: ${JSON.stringify(available)}`,
        { agent_id, available },
      );
    }

    if (match.status === 'disabled') {
      // Deliberately checked before `allow_deprecated` can be consulted and with
      // no override of its own: `disabled` is the kill switch, and a kill switch
      // an argument can turn off is not one.
      return refuse(
        'agent_disabled',
        `agent '${agent_id}' v${match.version} is disabled`,
        { agent_id, resolved_version: match.version },
      );
    }
    if (match.status === 'draft') {
      return refuse(
        'agent_not_active',
        `agent '${agent_id}' v${match.version} is a draft and is not executable`,
        { agent_id, resolved_version: match.version },
      );
    }
    if (match.status === 'deprecated') {
      const pinned = PINNED_PATTERN.test(version) && version === match.version;
      if (!(pinned && allow_deprecated === true)) {
        return refuse(
          'agent_deprecated',
          `agent '${agent_id}' v${match.version} is deprecated; it runs only when a caller pins this exact version AND opts in`,
          { agent_id, resolved_version: match.version },
        );
      }
    }
    if (!agentTenantInScope(match, org_id)) {
      return refuse(
        'agent_tenant_out_of_scope',
        `tenant '${org_id}' is not in the scope of agent '${agent_id}'`,
        { agent_id, resolved_version: match.version },
      );
    }

    return deepFreeze({
      ok: true,
      reason: null,
      detail: null,
      definition: match,
      resolved_version: match.version,
      definition_digest: match.definition_digest,
    });
  }

  /**
   * verifyPinned({ agent_id, version, definition_digest })
   *
   * The DRIFT check a resume runs. A paused run recorded exactly which
   * definition it started under; if the registry now answers with a different
   * document at that same version, the two disagree and the run must not
   * silently continue under new rules.
   */
  function verifyPinned({ agent_id, version, definition_digest } = {}) {
    const definition = get(agent_id, version);
    if (definition === null) {
      return deepFreeze({
        ok: false,
        reason: 'agent_version_unknown',
        detail: `agent '${agent_id}' v${version} is no longer registered`,
        definition: null,
      });
    }
    if (definition.definition_digest !== definition_digest) {
      return deepFreeze({
        ok: false,
        reason: 'agent_definition_drift',
        detail: `agent '${agent_id}' v${version} no longer matches the definition this run started under`,
        definition: null,
        expected: definition_digest,
        actual: definition.definition_digest,
      });
    }
    return deepFreeze({ ok: true, reason: null, detail: null, definition });
  }

  const all = () => [...byId.values()]
    .flatMap((versions) => [...versions.values()])
    .sort((a, b) => (`${a.agent_id}@${a.version}` < `${b.agent_id}@${b.version}` ? -1 : 1));

  return Object.freeze({
    resolve,
    verifyPinned,
    get,
    has(agent_id) { return byId.has(agent_id); },
    ids() { return [...byId.keys()].sort(); },
    versionsOf,
    /**
     * describe({ org_id }) — with no tenant this is the OPERATOR view. Naming a
     * tenant filters to what that tenant may run AND removes `tenant_scope`
     * from the result, for the same reason `listWorkflows` does: a catalogue
     * that told tenant A which orgs are in tenant B's allow-list would be a
     * customer list handed out by a discovery call.
     */
    describe({ org_id = null } = {}) {
      return all()
        .filter((d) => org_id === null || agentTenantInScope(d, org_id))
        .map((d) => {
          const row = {
            agent_id: d.agent_id,
            version: d.version,
            title: d.title,
            purpose: d.purpose,
            business_responsibility: d.business_responsibility,
            status: d.status,
            capabilities: d.capabilities.map((c) => `${c.key}@${c.version}`),
            denied_capabilities: d.denied_capabilities.map((c) => `${c.key}@${c.version ?? '*'}`),
            tools: d.tools.map((t) => `${t.name}@${t.version}`),
            planner: d.model_profile.planner,
            budget: d.budget,
            definition_digest: d.definition_digest,
            tenant_scope: d.tenant_scope,
          };
          if (org_id === null) return row;
          const { tenant_scope, ...rest } = row;
          return { ...rest, tenant_scope: tenant_scope.mode };
        });
    },
    registry_digest() { return digest(all()); },
  });
}
