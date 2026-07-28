// ---------------------------------------------------------------------------
// workflow-registry.mjs — the Workflow Registry.
//
// NAMING, deliberately: `packages/awe-kernel/src/registry.mjs` already exists
// and is the SUITE registry — the list of regression suites. It is not a
// workflow registry and never was. Rather than overload the word (or, worse,
// create a second `registry.mjs` in a sibling package and leave every future
// reader guessing which one an import means), this module is named for what it
// holds.
//
// What it is for: making the registry the ONLY way to obtain something
// executable. `runWorkflow` will happily execute any body a caller hands it —
// that is correct for a kernel and unacceptable for a control plane. Here, a
// caller states an id, a version requirement and a tenant, and gets back a
// RESOLUTION: either a registered, promoted, in-scope, dependency-satisfied
// manifest, or a refusal with a registered reason. There is no path that turns
// an arbitrary object into an executable workflow, because `resolve()` only
// ever returns manifests this registry already validated.
//
// Resolution returns DATA rather than throwing. A refusal to execute a
// workflow is a normal, expected, fail-closed outcome that the engine turns
// into a `blocked` envelope — not an exception. Genuine caller bugs (handing
// the registry a non-manifest) still throw.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { deepFreeze, digest, invariant } from './kernel.mjs';
import {
  assertWorkflowManifest, compareVersionsDesc, defineWorkflowManifest,
  satisfiesVersion, tenantInScope,
} from './manifest.mjs';

// Why a resolution failed. Each one is a member of the control plane's
// blocked-reason vocabulary (policy.mjs) so it can travel all the way out to a
// run report unchanged.
export const RESOLUTION_REASONS = [
  'workflow_not_registered',
  'workflow_version_unknown',
  'workflow_version_incompatible',
  'workflow_not_promoted',
  'tenant_out_of_scope',
  'dependency_unsatisfied',
];

const REQUIREMENT_PATTERN = /^\^?\d+\.\d+\.\d+$/;

function refuse(reason, detail, extra = {}) {
  return deepFreeze({ ok: false, reason, detail, manifest: null, dependencies: [], ...extra });
}

/**
 * createWorkflowRegistry(manifests) -> frozen registry
 *
 * `manifests` are manifest objects (already built by `defineWorkflowManifest`)
 * or plain specs, which are built here. Building here is what makes it
 * impossible to register something that never passed validation.
 */
export function createWorkflowRegistry(manifests = []) {
  // workflow_id -> Map(version -> manifest)
  const byId = new Map();

  for (const candidate of manifests) {
    const manifest = candidate?.manifest_digest === undefined
      ? defineWorkflowManifest(candidate)
      : assertWorkflowManifest(candidate, { at: 'createWorkflowRegistry' });

    const versions = byId.get(manifest.workflow_id) ?? new Map();
    invariant(
      !versions.has(manifest.version),
      'invalid_input',
      `workflow '${manifest.workflow_id}' version '${manifest.version}' is registered twice`,
      { workflow_id: manifest.workflow_id, version: manifest.version },
    );
    versions.set(manifest.version, manifest);
    byId.set(manifest.workflow_id, versions);
  }

  function versionsOf(workflow_id) {
    return [...(byId.get(workflow_id)?.keys() ?? [])].sort(compareVersionsDesc);
  }

  function get(workflow_id, version) {
    return byId.get(workflow_id)?.get(version) ?? null;
  }

  // The newest registered version satisfying a requirement, promoted first.
  // Promotion beats recency deliberately: a newer draft must never be picked up
  // by a caller that asked for "whatever is current".
  function best(workflow_id, requirement, { require_promoted }) {
    const candidates = versionsOf(workflow_id)
      .map((v) => get(workflow_id, v))
      .filter((m) => requirement === null || satisfiesVersion(m.version, requirement));
    if (!require_promoted) return candidates[0] ?? null;
    return candidates.find((m) => m.promotion.status === 'promoted') ?? candidates[0] ?? null;
  }

  /**
   * resolve({ workflow_id, version, org_id, require_promoted })
   *   -> { ok, reason, detail, manifest, dependencies }
   *
   * The four gates, in this order, because each one is only meaningful if the
   * ones before it passed:
   *   1. the workflow exists at all
   *   2. a version satisfying the requirement exists
   *   3. that version is promoted (unless the caller explicitly says otherwise)
   *   4. the tenant is in the manifest's scope
   *   5. every declared dependency resolves to a promoted, in-scope manifest
   */
  function resolve({ workflow_id, version = null, org_id = null, require_promoted = true, _seen = new Set() } = {}) {
    invariant(
      typeof workflow_id === 'string' && workflow_id.length > 0,
      'invalid_input', 'resolve() needs a workflow_id', { workflow_id },
    );
    invariant(
      version === null || (typeof version === 'string' && REQUIREMENT_PATTERN.test(version)),
      'invalid_input', `version requirement '${version}' must be 'x.y.z', '^x.y.z' or null`, { version },
    );

    if (!byId.has(workflow_id)) {
      return refuse('workflow_not_registered', `no workflow '${workflow_id}' is registered`, {
        known: [...byId.keys()].sort(),
      });
    }

    const known = versionsOf(workflow_id);
    const manifest = best(workflow_id, version, { require_promoted });

    if (manifest === null) {
      // Distinguish "that exact version does not exist" from "versions exist
      // but none is compatible with the caret requirement". Both are refusals;
      // they need different fixes.
      const reason = version !== null && version[0] === '^'
        ? 'workflow_version_incompatible'
        : 'workflow_version_unknown';
      return refuse(reason, `workflow '${workflow_id}' has no version satisfying '${version}'`, {
        known_versions: known,
      });
    }

    if (require_promoted && manifest.promotion.status !== 'promoted') {
      return refuse(
        'workflow_not_promoted',
        `workflow '${workflow_id}' v${manifest.version} is '${manifest.promotion.status}', not promoted`,
        { known_versions: known, promotion: manifest.promotion },
      );
    }

    if (!tenantInScope(manifest, org_id)) {
      return refuse(
        'tenant_out_of_scope',
        `tenant '${org_id}' is not in the scope of workflow '${workflow_id}' v${manifest.version}`,
        { tenant_scope: manifest.tenant_scope },
      );
    }

    // Dependencies. A cycle is a registration bug rather than a resolution
    // outcome, so it throws; everything else fails closed as data.
    invariant(
      !_seen.has(workflow_id),
      'contract_violation', `dependency cycle through workflow '${workflow_id}'`,
      { cycle: [..._seen, workflow_id] },
    );
    const seen = new Set([..._seen, workflow_id]);

    const dependencies = [];
    for (const dependency of manifest.dependencies) {
      const resolved = resolve({
        workflow_id: dependency.workflow_id,
        version: dependency.version,
        org_id,
        require_promoted: true,
        _seen: seen,
      });
      if (!resolved.ok) {
        return refuse(
          'dependency_unsatisfied',
          `workflow '${workflow_id}' v${manifest.version} depends on '${dependency.workflow_id}@${dependency.version}', which did not resolve: ${resolved.reason}`,
          { dependency, dependency_reason: resolved.reason, dependency_detail: resolved.detail },
        );
      }
      dependencies.push({
        workflow_id: resolved.manifest.workflow_id,
        version: resolved.manifest.version,
        manifest_digest: resolved.manifest.manifest_digest,
      });
    }

    return deepFreeze({
      ok: true,
      reason: null,
      detail: null,
      manifest,
      dependencies: dependencies.sort((a, b) => (a.workflow_id < b.workflow_id ? -1 : 1)),
    });
  }

  const describe = () => [...byId.keys()].sort().flatMap((id) => versionsOf(id).map((v) => {
    const m = get(id, v);
    return {
      workflow_id: m.workflow_id,
      version: m.version,
      title: m.title,
      risk: m.risk,
      promotion_status: m.promotion.status,
      tenant_scope: m.tenant_scope,
      required_tools: m.required_tools.map((t) => `${t.name}@${t.version}`),
      dependencies: m.dependencies.map((d) => `${d.workflow_id}@${d.version}`),
      step_count: m.steps.length,
      manifest_digest: m.manifest_digest,
    };
  }));

  return Object.freeze({
    ids() { return [...byId.keys()].sort(); },
    has(workflow_id) { return byId.has(workflow_id); },
    versions(workflow_id) { return versionsOf(workflow_id); },
    get(workflow_id, version) { return get(workflow_id, version); },
    resolve,
    describe,
    // The registry's own identity, so a run report can pin which catalogue of
    // workflows it was executed against.
    registry_digest() { return digest(describe()); },
  });
}
