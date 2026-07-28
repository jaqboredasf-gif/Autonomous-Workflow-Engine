import { deepFreeze, digest, invariant } from './kernel.mjs';
import {
  EXECUTABLE_MEMORY_LIFECYCLES, assertMemoryManifest, memoryTenantInScope,
} from './manifest.mjs';

function versionTuple(value) {
  return value.split('.').map(Number);
}

function compareVersion(a, b) {
  const aa = versionTuple(a);
  const bb = versionTuple(b);
  for (let i = 0; i < 3; i += 1) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
}

export function createMemoryRegistry(manifests = []) {
  invariant(Array.isArray(manifests), 'invalid_input', 'memory registry takes an array', {});
  const byId = new Map();
  for (const manifest of manifests) {
    assertMemoryManifest(manifest, { at: 'createMemoryRegistry' });
    const versions = byId.get(manifest.memory_id) ?? new Map();
    invariant(!versions.has(manifest.version), 'invalid_input', `duplicate memory '${manifest.memory_id}' v${manifest.version}`, {});
    versions.set(manifest.version, manifest);
    byId.set(manifest.memory_id, versions);
  }

  function resolve({ memory_id, version = null, org_id } = {}) {
    const versions = byId.get(memory_id);
    if (versions === undefined) return deepFreeze({ ok: false, reason: 'memory_not_registered', detail: `memory '${memory_id}' is not registered`, manifest: null });
    let manifest;
    if (version !== null) manifest = versions.get(version);
    else {
      manifest = [...versions.values()]
        .filter((candidate) => EXECUTABLE_MEMORY_LIFECYCLES.includes(candidate.lifecycle))
        .sort((a, b) => compareVersion(b.version, a.version))[0];
    }
    if (manifest === undefined) return deepFreeze({ ok: false, reason: 'memory_version_unknown', detail: `memory '${memory_id}' version '${version}' is not registered`, manifest: null });
    if (!EXECUTABLE_MEMORY_LIFECYCLES.includes(manifest.lifecycle)) {
      return deepFreeze({ ok: false, reason: 'memory_not_executable', detail: `memory '${memory_id}' v${manifest.version} is '${manifest.lifecycle}'`, manifest: null });
    }
    if (!memoryTenantInScope(manifest, org_id)) {
      return deepFreeze({ ok: false, reason: 'memory_tenant_mismatch', detail: `tenant '${org_id}' is outside memory '${memory_id}' scope`, manifest: null });
    }
    return deepFreeze({ ok: true, reason: null, detail: null, manifest });
  }

  const described = deepFreeze([...byId.values()].flatMap((versions) => [...versions.values()])
    .sort((a, b) => (a.memory_id === b.memory_id ? compareVersion(a.version, b.version) : a.memory_id.localeCompare(b.memory_id))));
  return Object.freeze({
    resolve,
    describe: () => described,
    registry_digest: () => digest(described),
  });
}
