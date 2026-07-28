import {
  deepFreeze, digest, invariant,
} from '../../awe-kernel/src/index.mjs';
import {
  assertAgentManifest, defineAgentManifest, EXECUTABLE_AGENT_LIFECYCLES,
} from './manifest.mjs';

const REQUIREMENT = /^\^?\d+\.\d+\.\d+$/;

function compareVersionsDesc(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return right[i] - left[i];
  return 0;
}

function satisfies(actual, requirement) {
  if (requirement === null) return true;
  if (!requirement.startsWith('^')) return actual === requirement;
  const a = actual.split('.').map(Number);
  const r = requirement.slice(1).split('.').map(Number);
  return a[0] === r[0] && (a[1] > r[1] || (a[1] === r[1] && a[2] >= r[2]));
}

function refuse(reason, detail, extra = {}) {
  return deepFreeze({ ok: false, reason, detail, manifest: null, ...extra });
}

export function createAgentRegistry(manifests = []) {
  const byId = new Map();
  for (const candidate of manifests) {
    const manifest = candidate?.manifest_digest === undefined
      ? defineAgentManifest(candidate)
      : assertAgentManifest(candidate, { at: 'createAgentRegistry' });
    const versions = byId.get(manifest.agent_id) ?? new Map();
    invariant(!versions.has(manifest.version), 'invalid_input', `agent '${manifest.agent_id}' version '${manifest.version}' is registered twice`, {});
    versions.set(manifest.version, manifest);
    byId.set(manifest.agent_id, versions);
  }

  const versions = (id) => [...(byId.get(id)?.keys() ?? [])].sort(compareVersionsDesc);
  function resolve({ agent_id, version = null, require_executable = true } = {}) {
    invariant(typeof agent_id === 'string' && agent_id.length > 0, 'invalid_input', 'agent resolution needs agent_id', {});
    invariant(version === null || REQUIREMENT.test(version), 'invalid_input', `agent version requirement '${version}' is invalid`, {});
    if (!byId.has(agent_id)) return refuse('agent_not_registered', `no agent '${agent_id}' is registered`, { known: [...byId.keys()].sort() });
    const candidates = versions(agent_id)
      .map((v) => byId.get(agent_id).get(v))
      .filter((manifest) => satisfies(manifest.version, version));
    if (candidates.length === 0) return refuse('agent_version_unknown', `agent '${agent_id}' has no version satisfying '${version}'`, {
      known_versions: versions(agent_id),
    });
    const manifest = require_executable
      ? candidates.find((entry) => EXECUTABLE_AGENT_LIFECYCLES.includes(entry.lifecycle)) ?? candidates[0]
      : candidates[0];
    if (require_executable && !EXECUTABLE_AGENT_LIFECYCLES.includes(manifest.lifecycle)) {
      return refuse('agent_not_executable', `agent '${agent_id}' v${manifest.version} is '${manifest.lifecycle}'`, {
        lifecycle: manifest.lifecycle,
      });
    }
    return deepFreeze({ ok: true, reason: null, detail: null, manifest });
  }

  const describe = () => [...byId.keys()].sort().flatMap((id) => versions(id).map((version) => {
    const manifest = byId.get(id).get(version);
    return {
      agent_id: id,
      version,
      lifecycle: manifest.lifecycle,
      workflow: manifest.workflow,
      model_profile: manifest.model_profile,
      allowed_tools: manifest.allowed_tools,
      manifest_digest: manifest.manifest_digest,
    };
  }));

  return Object.freeze({
    ids: () => [...byId.keys()].sort(),
    versions,
    get: (id, version) => byId.get(id)?.get(version) ?? null,
    resolve,
    describe,
    registry_digest: () => digest(describe()),
  });
}
