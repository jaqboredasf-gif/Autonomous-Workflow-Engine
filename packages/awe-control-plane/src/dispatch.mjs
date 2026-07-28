// ---------------------------------------------------------------------------
// dispatch.mjs — the controlled tool-invocation boundary.
//
// `createToolCatalog()` in the kernel deliberately has no `invoke()`. Its header
// says why: "dispatch belongs to whatever builds an execution context and calls
// runWorkflow, so that no tool can be executed outside the run scaffolding."
// This is that thing. It is the ONLY place in the control plane that calls a
// tool adapter, and it refuses in nine ways before it does:
//
//    1. the tool is registered in the catalog          -> tool_not_registered
//    2. its lifecycle admits execution                 -> tool_lifecycle_ineligible
//    3. the descriptor still matches its own digest    -> contract_violation
//    4. the policy engine allows it                    -> tool_not_authorized /
//                                                         tenant_binding_required /
//                                                         tool_version_incompatible /
//                                                         live_mode_unratified
//    5. approval, when the policy demands one          -> approval_required
//    6. the input validates                            -> tool_input_invalid
//    7. the effect identity is not already claimed
//       by a DIFFERENT input                           -> idempotency_conflict
//    8. the step's time budget is not exceeded         -> step_timeout
//    9. the output validates                           -> tool_output_invalid
//
// Idempotency is the interesting one. Every invocation computes an effect
// identity — by default `digest(run, step, tool, version, input)` — and the
// dispatcher remembers it. Invoking the same identity again with the same input
// REPLAYS the recorded result without calling the adapter, so a resumed run
// cannot double-charge a supplier. Invoking it with a different input is an
// `idempotency_conflict` and is refused, because two different effects claiming
// one identity is precisely the bug an idempotency key exists to catch.
//
// Time is INJECTED. `clock()` returns an ISO instant and the dispatcher reads it
// either side of the adapter; a simulator supplies a clock it controls, so a
// timeout is a deterministic test rather than a flaky sleep.
//
// PURE apart from calling the injected adapter and the injected clock: no
// network, no filesystem, no ambient environment. Every concrete adapter lives
// outside this package.
// ---------------------------------------------------------------------------

import {
  assertToolDescriptor, canonicalClone, deepFreeze, digest, instantEpochSeconds, invariant, isInstant, redact,
} from './kernel.mjs';

export const INVOCATION_STATUSES = ['ok', 'blocked', 'failed'];

// Lifecycle states a run may execute. `draft` and `retired` are refused: a
// draft tool has not been reviewed, and a retired one has been withdrawn.
export const EXECUTABLE_LIFECYCLES = ['active', 'deprecated'];

function result(status, extra = {}) {
  invariant(INVOCATION_STATUSES.includes(status), 'invalid_input', `unknown invocation status '${status}'`, { status });
  return deepFreeze({
    status,
    ok: status === 'ok',
    reason: null,
    detail: null,
    data: null,
    idempotency_key: null,
    replayed: false,
    elapsed_ms: 0,
    descriptor: null,
    obligations: null,
    ...extra,
  });
}

// Milliseconds between two instants, using the kernel's clock-free parser.
function elapsedMs(from, to) {
  if (!isInstant(from) || !isInstant(to)) return 0;
  return Math.max(0, (instantEpochSeconds(to) - instantEpochSeconds(from)) * 1000
    + (fractionalMs(to) - fractionalMs(from)));
}

// The sub-second part of an instant, so a simulator can advance by 250ms and
// have the step budget notice.
function fractionalMs(instant) {
  const match = /\.(\d{1,6})/.exec(instant);
  if (match === null) return 0;
  return Math.round(Number(`0.${match[1]}`) * 1000);
}

/**
 * createToolDispatcher({ catalog, policy, validators, clock })
 *
 *   catalog    — kernel tool catalog: `{ descriptor, adapter }` per name
 *   policy     — policy engine (policy.mjs)
 *   validators — schema-reference -> `(value) -> { ok, errors }`. The kernel
 *                keeps `input_schema`/`output_schema` as opaque REFERENCES so
 *                it never depends on a validator library; this is where a
 *                composition binds those references to actual checks. A
 *                descriptor naming a schema with no registered validator is
 *                refused rather than waved through.
 *   clock      — `() => ISO instant`
 */
export function createToolDispatcher({ catalog, policy, validators = {}, clock = null } = {}) {
  invariant(catalog !== null && catalog !== undefined, 'invalid_input', 'a dispatcher needs a tool catalog', {});
  invariant(policy !== null && policy !== undefined, 'invalid_input', 'a dispatcher needs a policy engine', {});
  invariant(clock === null || typeof clock === 'function', 'invalid_input', 'clock must be a function or null', {});

  // effect identity -> { input_digest, data, step_id, tool }
  const effects = new Map();

  function validate(reference, value, label, toolName) {
    if (reference === null || reference === undefined) return { ok: true, errors: [] };
    const validator = validators[reference];
    // Fail closed. A declared schema with no validator is an unchecked boundary,
    // and an unchecked boundary that reports "valid" is worse than no boundary.
    if (typeof validator !== 'function') {
      return { ok: false, errors: [`tool '${toolName}' declares ${label} schema '${reference}' but no validator is registered for it`] };
    }
    const verdict = validator(value);
    if (verdict === true) return { ok: true, errors: [] };
    if (verdict === false) return { ok: false, errors: [`${label} failed validation`] };
    return { ok: verdict?.ok === true, errors: verdict?.errors ?? [] };
  }

  /**
   * Rebuild the idempotency memory from a run's journal. This is what makes a
   * resume safe across processes: the second process has never called an
   * adapter, but it knows which effects the first one already committed.
   */
  function rehydrate(executed_tools = []) {
    for (const record of executed_tools) {
      if (record.idempotency_key === null || record.idempotency_key === undefined) continue;
      if (effects.has(record.idempotency_key)) continue;
      effects.set(record.idempotency_key, {
        input_digest: record.input_digest ?? null,
        data: null,           // results are not replayed across processes …
        recorded_only: true,  // … but the effect is known to have happened
        step_id: record.step_id ?? null,
        tool: record.tool ?? null,
      });
    }
  }

  function effectIdentity({ context, step, descriptor, input }) {
    if (step?.idempotency_key) return step.idempotency_key;
    return digest({
      run_id: context.run_id,
      step_id: step?.id ?? null,
      tool: descriptor.name,
      tool_version: descriptor.version,
      input,
    });
  }

  /**
   * invoke({ manifest, step, tool, input, context, deps, approved })
   *   -> invocation result (never throws for a tool's own failure)
   *
   * `approved` is the projected approval for this step, supplied by the engine.
   * The dispatcher does not read a journal and does not decide who may approve;
   * it only refuses to proceed when the policy demanded an approval and the
   * engine did not present one.
   */
  async function invoke({
    manifest, step = null, tool, input = {}, context, deps = {}, approved = false, compensating = false,
  } = {}) {
    invariant(manifest !== null && manifest !== undefined, 'invalid_input', 'invoke() needs a manifest', {});
    invariant(context !== null && context !== undefined, 'invalid_input', 'invoke() needs an execution context', {});
    const toolName = tool ?? step?.tool ?? null;
    invariant(typeof toolName === 'string' && toolName.length > 0, 'invalid_input', 'invoke() needs a tool name', {});

    // 1. registered?
    if (!catalog.has(toolName)) {
      return result('blocked', {
        reason: 'tool_not_registered',
        detail: `no tool named '${toolName}' is in the tool registry`,
      });
    }
    const entry = catalog.get(toolName);
    const descriptor = entry.descriptor;

    // 2. lifecycle
    if (!EXECUTABLE_LIFECYCLES.includes(descriptor.lifecycle)) {
      return result('blocked', {
        reason: 'tool_lifecycle_ineligible',
        detail: `tool '${toolName}' is '${descriptor.lifecycle}' and may not be executed`,
        descriptor,
      });
    }

    // 3. the descriptor still is what it says it is. A catalog entry mutated in
    //    memory would otherwise carry a side-effect class the policy engine
    //    then trusts.
    assertToolDescriptor(descriptor, { at: 'dispatch.invoke' });

    // 4. policy
    const verdict = policy.evaluate({ manifest, descriptor, context, step });
    if (verdict.decision === 'deny') {
      return result('blocked', { reason: verdict.reason, detail: verdict.detail, descriptor });
    }

    // 5. approval
    if (verdict.decision === 'require_approval' && approved !== true) {
      return result('blocked', {
        reason: 'approval_required',
        detail: verdict.detail,
        descriptor,
        obligations: verdict.obligations,
      });
    }

    // 6. input validation
    const inputCheck = validate(descriptor.input_schema, input, 'input', toolName);
    if (!inputCheck.ok) {
      return result('blocked', {
        reason: 'tool_input_invalid',
        detail: inputCheck.errors.join('; '),
        descriptor,
      });
    }

    // 7. idempotency
    const idempotency_key = effectIdentity({ context, step, descriptor, input });
    const input_digest = digest(canonicalClone(input));
    const known = effects.get(idempotency_key);
    if (known !== undefined) {
      if (known.input_digest !== null && known.input_digest !== input_digest) {
        return result('blocked', {
          reason: 'idempotency_conflict',
          detail: `effect identity '${idempotency_key}' was already claimed by a different input (step '${known.step_id}', tool '${known.tool}')`,
          descriptor,
          idempotency_key,
        });
      }
      // Same identity, same input: the effect already happened. Replay the
      // recorded result and do NOT call the adapter again.
      return result('ok', {
        data: known.data,
        descriptor,
        idempotency_key,
        replayed: true,
        detail: known.recorded_only
          ? 'effect already committed by an earlier process; not re-executed'
          : 'replayed a previously recorded effect',
      });
    }

    // 8. execute, with the step's time budget measured across the call
    const startedAt = clock === null ? null : clock();
    let produced;
    try {
      produced = await entry.adapter(input, {
        context,
        deps,
        descriptor,
        step,
        manifest,
        compensating,
      });
    } catch (e) {
      // An adapter that throws is a failed STEP, never an escaped exception.
      // The message is redacted and bounded: an adapter's error is the most
      // likely place for a provider's connection string to surface.
      const message = String(redact(String(e?.message ?? e)));
      return result('failed', {
        reason: 'step_failed',
        detail: message.length > 300 ? `${message.slice(0, 300)}…` : message,
        descriptor,
        idempotency_key,
      });
    }
    const finishedAt = clock === null ? null : clock();
    const elapsed_ms = elapsedMs(startedAt, finishedAt);

    const budget = manifest.limits.step_timeout_ms;
    if (startedAt !== null && elapsed_ms > budget) {
      // The effect is NOT recorded: a step that blew its budget has an unknown
      // outcome, and recording it as committed would make a retry silently
      // replay a result nobody trusts.
      return result('blocked', {
        reason: 'step_timeout',
        detail: `step '${step?.id ?? toolName}' took ${elapsed_ms}ms, over the ${budget}ms budget`,
        descriptor,
        idempotency_key,
        elapsed_ms,
      });
    }

    // 9. output validation
    const outputCheck = validate(descriptor.output_schema, produced, 'output', toolName);
    if (!outputCheck.ok) {
      return result('blocked', {
        reason: 'tool_output_invalid',
        detail: outputCheck.errors.join('; '),
        descriptor,
        idempotency_key,
        elapsed_ms,
      });
    }

    effects.set(idempotency_key, {
      input_digest,
      data: canonicalClone(produced ?? null),
      recorded_only: false,
      step_id: step?.id ?? null,
      tool: toolName,
    });

    return result('ok', {
      data: canonicalClone(produced ?? null),
      descriptor,
      idempotency_key,
      elapsed_ms,
    });
  }

  return Object.freeze({
    invoke,
    rehydrate,
    knownEffects() { return [...effects.keys()].sort(); },
    catalog,
  });
}
