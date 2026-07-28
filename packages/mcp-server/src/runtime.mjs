// ---------------------------------------------------------------------------
// runtime.mjs — MCP tool execution on the shared AWE kernel.
//
// This is the whole of what used to be duplicated ten times, once per tool:
// resolve the tenant, decide the mode, build an execution context, assemble the
// run's context bundle, execute, standardize the outcome, emit sanitized audit
// events, persist a durable run report, terminate with an explicit final state,
// and translate all of that into an MCP protocol response.
//
// Every MCP call is therefore a first-class AWE run: it has a `run_id`, an
// `org_id`, a mode, an audit trail, an artifact and a final state, exactly like
// a Runner 4 execution. The MCP transport becomes what it should be — a
// transport — and the tool bodies contain business logic and nothing else.
//
// The two things this module refuses to do:
//
//   * infer a tenant. `orgs limit 1` is gone; there is no query for "the org",
//     no default, no last-used value. A call that does not state a tenant is
//     refused with `tenant_required` before any port method is reachable.
//   * leak. Responses carry a machine-readable `code`, a bounded human
//     `message`, and the run's correlation ids. Provider error text, stack
//     traces, connection strings and credentials do not cross this boundary.
//
// Protocol compatibility is preserved: a successful call returns the same
// `{ content: [{ type: 'text', text: <json> }] }` shape it always did, with the
// run envelope alongside the data rather than replacing it.
// ---------------------------------------------------------------------------

import {
  blocked, createContextItem, createExecutionContext, defineContextProvider, deriveRunId,
  failed, redact, runWorkflow,
} from '../../awe-kernel/src/index.mjs';

import { assertDataPort } from './data-port.mjs';
import { resolveExecution } from './tenant.mjs';

// Arguments a model or a customer supplied as free text. They are context, and
// they are UNTRUSTED context: a "job site name" is whatever the caller typed,
// and labelling it as data rather than instruction is the whole of G10. Listed
// explicitly rather than inferred from types, because the point is that someone
// decided.
const FREE_TEXT_ARGS = ['employee', 'job_site', 'skill', 'county', 'zip', 'summary', 'subject', 'notes', 'address', 'trade', 'from_contact'];

// Longer than this and a message has stopped being an explanation and started
// being a dump — a stack trace, a query, a response body.
const MAX_MESSAGE = 300;

// The display message, made safe to hand to a model and to a log.
//
// A blocked run's message was written here, so it is already safe. A failed
// run's message may have come from anywhere — `fromError` stringifies whatever
// was thrown, and what was thrown may be a driver error containing a
// connection string, a bearer token or a password. Redact it, bound it, and
// never let its length be a channel either.
function safeMessage(outcome) {
  if (outcome.blocked_reason !== null) {
    return outcome.meta?.detail ?? `refused: ${outcome.blocked_reason}`;
  }
  const raw = redact(String(outcome.error?.message ?? 'the run failed'));
  return raw.length > MAX_MESSAGE ? `${raw.slice(0, MAX_MESSAGE)}…` : raw;
}

// How much of the run report the response carries. Enough to find the artifact
// and the audit trail; never the report itself.
function runEnvelope(result, { tool }) {
  return {
    tool,
    run_id: result.outcome.meta.run_id,
    org_id: result.outcome.meta.org_id,
    mode: result.outcome.meta.mode,
    is_fixture: result.outcome.meta.is_fixture,
    final_state: result.final_state,
    status: result.outcome.status,
    report_digest: result.report.report_digest,
    artifact_ref: result.artifact?.ok ? result.artifact.ref : null,
  };
}

/**
 * toolContextProvider(tool, input) -> ContextProvider
 *
 * The MCP surface's context, built through the shared boundary rather than as
 * an ad-hoc metadata object. Three kinds of item, and the distinction between
 * them is the point:
 *
 *   policy            — the tenant binding and mode this run operates under.
 *                       Trusted, because the platform stated it.
 *   workflow_state    — which tool, which version, what it does to the world.
 *                       Trusted, because it is the descriptor.
 *   untrusted_content — the free-text arguments. NOT trusted, because a model
 *                       or a customer wrote them.
 *
 * A later model-assisted tool gets this bundle instead of a hand-built prompt,
 * and cannot lose the labelling on the way.
 */
export function toolContextProvider(tool, input) {
  return defineContextProvider({
    name: 'mcp_tool_call',
    kind: 'workflow_state',
    trusted: true,
    load(context) {
      const items = [
        createContextItem({
          id: `${context.run_id}-binding`,
          kind: 'policy',
          source: 'mcp_runtime',
          org_id: context.org_id,
          sensitivity: 'internal',
          trusted: true,
          priority: 900,
          occurred_at: context.started_at,
          content: `This run is bound to tenant ${context.org_id} in ${context.mode} mode. `
            + 'Every read and write is scoped to that tenant. No other tenant\'s data is reachable.',
          provenance: { resolved_by: 'resolveExecution' },
        }),
        createContextItem({
          id: `${context.run_id}-tool`,
          kind: 'workflow_state',
          source: 'mcp_runtime',
          org_id: context.org_id,
          sensitivity: 'internal',
          trusted: true,
          priority: 800,
          occurred_at: context.started_at,
          content: `Tool ${tool.descriptor.name} v${tool.descriptor.version} (${tool.descriptor.side_effect}): ${tool.descriptor.description}`,
          provenance: { descriptor_digest: tool.descriptor.descriptor_digest },
          metadata: { side_effect: tool.descriptor.side_effect },
        }),
      ];

      for (const key of FREE_TEXT_ARGS) {
        const value = input?.[key];
        if (typeof value !== 'string' || value.length === 0) continue;
        items.push(createContextItem({
          id: `${context.run_id}-arg-${key}`,
          kind: 'untrusted_content',
          source: 'mcp_caller',
          org_id: context.org_id,
          // Caller-supplied free text about a customer: a name, an address, a
          // phone number. Confidential by default rather than by review.
          sensitivity: 'confidential',
          trusted: false,
          priority: 500,
          occurred_at: context.started_at,
          content: value,
          provenance: { argument: key },
          metadata: { argument: key },
        }));
      }

      return items;
    },
  });
}

/**
 * executeTool({ tool, input, deps }) -> { outcome, report, final_state, response }
 *
 * `deps`:
 *   port        DataPort  — required; the tenant-scoped data boundary
 *   env         object    — AWE_MODE / AWE_ORG_ID, passed in, never read here
 *   now         instant   — the caller's clock reading. Required for a durable
 *                           report; the kernel has none and will not invent one.
 *   artifacts   ArtifactSink | null
 *   audit       AuditSink | null
 *   run_id      string | null — supplied for replay; derived otherwise
 */
export async function executeTool({ tool, input = {}, deps = {} } = {}) {
  const { port, control = null, env = {}, now = null, artifacts = null, audit = null, run_id = null } = deps;
  const name = tool?.descriptor?.name ?? 'unknown';
  // Which boundary this tool's body needs. A discriminator rather than a second
  // execute function: the tenant gate, the mode rule, the audit emission and
  // the response mapping below are the parts that must not be re-implemented,
  // and a parallel runtime is exactly how one of them ends up subtly different.
  const needs = tool?.needs ?? 'data_port';

  // --- entry gate: tenant and mode, before anything else ---------------------
  // Deliberately ahead of context construction: a refusal here must not need a
  // tenant to describe itself, and must not touch the data port.
  const gate = resolveExecution({ requested: input?.org_id ?? null, env, port });
  if (!gate.ok) {
    return refusal({ tool: name, reason: gate.reason, detail: gate.detail, now });
  }

  let context;
  try {
    if (needs === 'control_plane') {
      if (control === null || typeof control.startRun !== 'function') {
        throw new Error(`tool '${name}' needs a control-plane service and this process has none`);
      }
    } else {
      assertDataPort(port, { at: 'executeTool' });
    }
    context = createExecutionContext({
      run_id: run_id ?? deriveRunId({
        workflow_id: tool.descriptor.workflow_id,
        inputs: input,
        // Two identical calls on different days are different runs, so their
        // artifacts do not overwrite each other. Same call, same instant, same
        // run — which is what makes a replay a replay.
        salt: now,
      }),
      workflow_id: tool.descriptor.workflow_id,
      org_id: gate.org_id,
      actor: 'service',
      mode: gate.mode,
      is_fixture: gate.is_fixture,
      started_at: now,
      attributes: { tool: tool.descriptor.name, tool_version: tool.descriptor.version },
    });
  } catch (e) {
    // A wiring failure — a bad instant, a missing port. Reported as an outcome
    // like everything else, so the caller has one shape on every path.
    return refusal({ tool: name, code: 'invalid_input', detail: String(e?.message ?? e), now });
  }

  const result = await runWorkflow({
    context,
    contextProviders: [toolContextProvider(tool, input)],
    contextRequest: { assembled_at: now },
    body: (ctx, { bundle }) => tool.body(input, { context: ctx, port, control, now, bundle, deps }),
    artifacts,
    audit,
    finished_at: now,
    // The report records WHICH context the run was given, by digest, without
    // republishing the customer text inside it.
    summary: {
      tool: tool.descriptor.name,
      tool_version: tool.descriptor.version,
      side_effect: tool.descriptor.side_effect,
      descriptor_digest: tool.descriptor.descriptor_digest,
    },
    requireArtifact: artifacts !== null,
  });

  return { ...result, response: toMcpResponse(result, { tool: name }) };
}

// A refusal that never reached the run scaffolding: no context, therefore no
// report and no artifact. Still an outcome envelope and still an MCP response,
// so a caller cannot tell the difference structurally.
function refusal({ tool, reason = null, code = null, detail, now }) {
  const trail = [{ step: 'resolve_execution', ok: false, detail }];
  const outcome = reason !== null
    ? blocked(reason, { audit: trail, meta: { detail, tool } })
    : failed(code ?? 'invalid_input', detail, { audit: trail, meta: { detail, tool } });

  const payload = {
    status: outcome.status,
    code: reason ?? outcome.error?.code ?? 'invalid_input',
    message: detail,
    tool,
    final_state: outcome.status === 'blocked' ? 'blocked' : 'failed',
    run_id: null,
    occurred_at: now,
  };

  return {
    outcome,
    report: null,
    artifact: null,
    audit_result: null,
    final_state: payload.final_state,
    context_bundle: null,
    response: {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError: true,
    },
  };
}

/**
 * toMcpResponse(result, { tool }) -> MCP CallToolResult
 *
 * The mapping, and the reasoning behind the one judgement call in it:
 *
 *   ok      -> the data, plus a `run` envelope.        isError: false
 *   blocked -> the registered reason as `code`.        isError: true
 *   failed  -> the kernel error code as `code`.        isError: true
 *
 * A blocked run is a CORRECT run — the workflow refused on purpose — so calling
 * it an error is a slight abuse of the field. It is deliberate: `isError` is
 * how MCP tells a model "this did not give you what you asked for, read the
 * body". A refusal returned as a success is a refusal a model will summarize as
 * a result, which is precisely how a fail-closed system ends up reporting
 * fictional outcomes. The distinction is preserved where it matters, in the
 * machine-readable `status` and `code` fields.
 */
export function toMcpResponse(result, { tool }) {
  const { outcome } = result;
  const envelope = runEnvelope(result, { tool });

  if (outcome.status === 'ok') {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...outcome.data, run: envelope }, null, 2) }],
      isError: false,
    };
  }

  const payload = {
    status: outcome.status,
    // The machine contract. A caller branches on this and never on `message`.
    code: outcome.blocked_reason ?? outcome.error?.code ?? 'unknown',
    // For a person — and the one field on this boundary whose content did not
    // originate here. A failure message can be a raw provider error carrying a
    // connection string, a credential or a stack frame, so it is redacted and
    // bounded before it crosses. The `code` above is what a caller acts on.
    message: safeMessage(outcome),
    run: envelope,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

// The discovery view an app server or a catalog endpoint returns. Descriptors
// only: schema references, side-effect classification, lifecycle. No adapter,
// no capability, no permission — those are Tool Registry questions and stay
// blocked on ADR-0002.
export function describeTools(tools) {
  return tools.map((t) => t.descriptor);
}
