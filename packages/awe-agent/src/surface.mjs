// ---------------------------------------------------------------------------
// surface.mjs — the Agent Execution Surface.
//
// THE PROBLEM. The control plane's authorization machinery — the deny-by-default
// policy engine, the three-way side-effect ceiling, the tenant grant index, the
// controlled tool-invocation boundary with its nine refusals — is written
// against a WORKFLOW MANIFEST. An agent has no manifest: its steps are proposed
// at runtime, not declared.
//
// The wrong fix is a second authorization implementation for agents. Two
// implementations of "may this run?" drift, and the day they disagree is the day
// one of them is wrong in production.
//
// THE FIX. An agent definition COMPILES to a real, validated workflow manifest —
// its Execution Surface — whose steps are the enumerated (capability, operation,
// tool) bindings the definition permits. This is not a fabricated graph: an
// agent's action space is finite and declared, and the surface is exactly that
// space written in the vocabulary the control plane already checks.
//
//   agent definition ─┐
//                     ├─ compileAgentSurface ─▶ workflow manifest ─▶ policy.evaluate
//   capability registry┘                        (+ the binding index)   dispatch.invoke
//
// WHAT THE SURFACE IS NOT: an execution ORDER. Nothing walks these steps in
// sequence — `createRunEngine` is not used by the agent harness at all. The
// steps exist so that (a) the manifest is valid, (b) `required_tools` is the
// complete tool surface the policy engine will admit, and (c) an operator can
// read one document and see every action this agent version can ever take.
//
// NARROWING, NEVER WIDENING. The compiled manifest is the COARSE ceiling. Every
// finer rule the capability declares — the per-binding side-effect ceiling, the
// per-capability approval threshold, the data-classification ceiling, the
// idempotency and evidence obligations — is enforced separately in
// authorization.mjs, ON TOP of whatever the policy engine says. Compiling can
// therefore only ever refuse more, never permit more.
//
// PURE: no clock, no randomness, no I/O. Deterministic in its inputs, so the
// surface digest recorded in a run journal is reproducible.
// ---------------------------------------------------------------------------

import {
  SIDE_EFFECT_RANK, deepFreeze, digest, invariant, satisfiesVersion, defineWorkflowManifest,
} from './kernel.mjs';
import { CAPABILITY_RISKS } from './capability.mjs';
import { declaredTool } from './agent-definition.mjs';

export const SURFACE_COMPILE_REASONS = [
  'capability_not_registered',
  'capability_version_incompatible',
  'capability_tool_not_bound',
  'agent_definition_invalid',
];

// `invoice.route` + `route` + `route_invoice_queue`
//   -> `cap_invoice_route__route__route_invoice_queue`
// Deterministic, collision-free (the parts are all snake_case and the separators
// are not legal inside them) and readable in a journal without a lookup.
export function bindingStepId({ capability_key, operation, tool }) {
  return `cap_${capability_key.replace(/\./g, '_')}__${operation}__${tool}`;
}

function refuse(reason, detail, extra = {}) {
  return deepFreeze({ ok: false, reason, detail, manifest: null, bindings: [], ...extra });
}

function riskRank(risk) {
  return CAPABILITY_RISKS.indexOf(risk);
}

/**
 * compileAgentSurface({ definition, capabilities })
 *   -> { ok, reason, detail, manifest, bindings, capabilities, surface_digest }
 *
 *   definition   — a validated Agent Definition
 *   capabilities — a Capability Registry
 *
 * Tenant and actor are deliberately NOT parameters. The surface is a property of
 * the agent VERSION, so it is identical for every tenant and every actor and its
 * digest is stable across runs; the tenant and actor gates are applied where
 * they belong — at resolution and at authorization, per proposal.
 */
export function compileAgentSurface({ definition, capabilities } = {}) {
  invariant(definition !== null && definition !== undefined, 'invalid_input', 'compileAgentSurface needs an agent definition', {});
  invariant(capabilities !== null && capabilities !== undefined, 'invalid_input', 'compileAgentSurface needs a capability registry', {});

  const resolved = [];

  // 1. Resolve every DECLARED capability to an exact version. Tenant and actor
  //    gates are not applied here (see the header); this asks only "does a
  //    version satisfying what the agent pinned exist at all?".
  for (const ref of definition.capabilities) {
    if (!capabilities.has(ref.key)) {
      return refuse(
        'capability_not_registered',
        `agent '${definition.agent_id}' declares capability '${ref.key}', which is not registered`,
        { capability_key: ref.key },
      );
    }
    const available = capabilities.versionsOf(ref.key);
    const match = available
      .map((v) => capabilities.get(ref.key, v))
      .find((c) => satisfiesVersion(c.version, ref.version));
    if (match === undefined) {
      return refuse(
        'capability_version_incompatible',
        `agent '${definition.agent_id}' requires capability '${ref.key}' '${ref.version}'; available: ${JSON.stringify(available)}`,
        { capability_key: ref.key },
      );
    }
    resolved.push(match);
  }

  // 2. Enumerate the action space: one binding per (capability, operation, tool)
  //    the agent ALSO declares as a tool. A capability may bind tools this agent
  //    was never given — capabilities are reusable across agents — and those
  //    bindings are simply not part of this agent's surface.
  const bindings = [];
  for (const capability of resolved) {
    let usable = 0;
    for (const binding of capability.tool_bindings) {
      const agentTool = declaredTool(definition, binding.tool);
      if (agentTool === null) continue;
      usable += 1;
      for (const operation of binding.operations) {
        bindings.push(deepFreeze({
          step_id: bindingStepId({ capability_key: capability.key, operation, tool: binding.tool }),
          capability_key: capability.key,
          capability_version: capability.version,
          capability_digest: capability.capability_digest,
          operation,
          tool: binding.tool,
          // Two independent version requirements, both of which a proposal must
          // satisfy: what the CAPABILITY binds, and what the AGENT declared.
          capability_tool_version: binding.version,
          agent_tool_version: agentTool.version,
          max_side_effect: binding.max_side_effect,
          requires_approval_at_or_above: capability.requires_approval_at_or_above,
          max_data_classification: capability.max_data_classification,
          idempotency: capability.idempotency,
          audit: capability.audit,
          risk: capability.risk,
        }));
      }
    }
    if (usable === 0) {
      return refuse(
        'capability_tool_not_bound',
        `agent '${definition.agent_id}' declares capability '${capability.key}' but none of the tools that capability binds (${JSON.stringify(capability.tool_bindings.map((b) => b.tool))}) is in the agent's tool list`,
        { capability_key: capability.key },
      );
    }
  }

  // A declared tool that no declared capability binds is a hole in the review:
  // somebody granted a mechanism without granting a business permission for it.
  // Refused at compile time rather than quietly ignored, because the tool would
  // otherwise sit in `required_tools` — visible to the policy engine — with
  // nothing in the agent's action space able to reach it.
  const unbound = definition.tools
    .map((t) => t.name)
    .filter((name) => !bindings.some((b) => b.tool === name));
  if (unbound.length > 0) {
    return refuse(
      'capability_tool_not_bound',
      `agent '${definition.agent_id}' declares tool(s) ${JSON.stringify(unbound.sort())} that no declared capability binds — a mechanism with no business permission behind it`,
      { tools: unbound.sort() },
    );
  }

  // 3. `required_tools`: the union. The manifest ceiling for a tool is the
  //    HIGHEST any binding allows, because it is the coarse gate; the per-binding
  //    ceiling is enforced against the specific proposal in authorization.mjs,
  //    where the capability being exercised is known.
  const toolCeilings = new Map();
  for (const binding of bindings) {
    const current = toolCeilings.get(binding.tool) ?? null;
    if (current === null || SIDE_EFFECT_RANK[binding.max_side_effect] > SIDE_EFFECT_RANK[current]) {
      toolCeilings.set(binding.tool, binding.max_side_effect);
    }
  }
  const required_tools = definition.tools.map((t) => ({
    name: t.name,
    version: t.version,
    max_side_effect: toolCeilings.get(t.name) ?? 'read',
  }));

  // 4. Risk is the MAXIMUM across the declared capabilities. An agent is exactly
  //    as dangerous as the most dangerous thing it may do, and the manifest's own
  //    rule then obliges a high-risk surface to carry an approval threshold and
  //    named approver roles — which is how a definition is stopped from declaring
  //    dangerous capabilities and an ungated approval profile.
  const risk = resolved.reduce(
    (worst, capability) => (riskRank(capability.risk) > riskRank(worst) ? capability.risk : worst),
    'low',
  );

  const provenance = definition.provenance;
  const promoted = definition.status === 'active' || definition.status === 'deprecated';

  let manifest;
  try {
    manifest = defineWorkflowManifest({
      workflow_id: definition.agent_id,
      version: definition.version,
      title: `${definition.title} (agent execution surface)`,
      description: `Compiled execution surface for agent '${definition.agent_id}' v${definition.version}. Every step is one permitted (capability, operation, tool) binding; the harness selects one per authorized proposal and never walks them in order.`,
      tenant_scope: definition.tenant_scope,
      required_tools,
      required_context: definition.context_requirements,
      approval_policy: {
        requires_approval_at_or_above: definition.approval_profile.requires_approval_at_or_above,
        approver_roles: definition.approval_profile.approver_roles,
        quorum: definition.approval_profile.quorum,
      },
      limits: {
        step_timeout_ms: definition.budget.step_timeout_ms,
        run_timeout_ms: definition.budget.run_timeout_ms,
        // Deliberately 1. A failed agent step is not retried by the machinery:
        // it becomes an OBSERVATION the planner sees on the next turn, so a
        // retry is a decision the plane records rather than a loop it hides.
        max_attempts: 1,
        retry_backoff_ms: 0,
      },
      dependencies: [],
      risk,
      promotion: promoted
        ? { status: 'promoted', promoted_at: provenance.activated_at, promoted_by: provenance.activated_by }
        : { status: 'draft' },
      steps: bindings.map((binding) => ({
        id: binding.step_id,
        tool: binding.tool,
        description: `capability '${binding.capability_key}' v${binding.capability_version}, operation '${binding.operation}'`,
      })),
      metadata: {
        surface_of: definition.agent_id,
        agent_version: definition.version,
        definition_digest: definition.definition_digest,
        capability_versions: resolved.map((c) => `${c.key}@${c.version}`),
      },
    });
  } catch (e) {
    // A manifest rule that the compiled surface violates is a fact about the
    // DEFINITION — most often "declares a high-risk capability with no approver
    // role" — so it is reported as an invalid definition rather than as an
    // internal error.
    return refuse(
      'agent_definition_invalid',
      `agent '${definition.agent_id}' v${definition.version} does not compile to a valid execution surface: ${e?.message ?? e}`,
      { cause: e?.code ?? null },
    );
  }

  const index = new Map(bindings.map((b) => [`${b.capability_key} ${b.operation} ${b.tool}`, b]));

  return deepFreeze({
    ok: true,
    reason: null,
    detail: null,
    manifest,
    bindings,
    capabilities: resolved,
    /** The binding for one (capability, operation, tool), or null. */
    bindingFor({ capability_key, operation, tool }) {
      return index.get(`${capability_key} ${operation} ${tool}`) ?? null;
    },
    /** Every binding a capability contributes, for a planning view. */
    bindingsOf(capability_key) {
      return bindings.filter((b) => b.capability_key === capability_key);
    },
    surface_digest: digest({
      definition_digest: definition.definition_digest,
      manifest_digest: manifest.manifest_digest,
      bindings,
    }),
  });
}
