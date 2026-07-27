// ---------------------------------------------------------------------------
// tenant.mjs — explicit tenant and mode resolution for the MCP surface.
//
// The behaviour this module replaces, verbatim from the old server:
//
//     const { data: org } = await db.from('orgs').select('id').limit(1).single();
//     await db.from('leads').insert({ org_id: org.id, ...args });
//
// "Whichever org the database returns first" is not a tenant binding. It is
// correct on a single-tenant project and silently writes another business's
// data on a multi-tenant one, with no error, no audit trail and no way to tell
// afterwards. ADR-0002 names it as a defect to be fixed separately; this is that
// fix.
//
// The replacement has one rule: **a tenant is stated, never discovered.** There
// is no query, no default, no "first", no cache of the last one used. It comes
// from the tool call or from the operator's declared binding for the server
// process, the two disagree loudly, and neither present means refusal.
//
// Mode follows the same fail-closed default as the rest of the repo
// (`resolveMode` in approval-matrix.mjs, `resolveQueueMode` in the queue): a
// process that does not say it is LIVE is in TEST.
//
// PURE: no clock, no randomness, no I/O. `env` is passed in.
// ---------------------------------------------------------------------------

import { invariant } from '../../awe-kernel/src/index.mjs';

// The MCP surface's fail-closed vocabulary. Registered into the platform union
// (scripts/lib/awe-reasons.mjs) so that a reason this surface emits is checked
// against every other surface's.
export const MCP_BLOCKED_REASONS = [
  'tenant_required',        // no org_id was stated, and none may be inferred
  'tenant_mismatch',        // the call names a tenant this process is not bound to
  'ambiguous_match',        // a name matched zero, or more than one, record
  'live_execution_unavailable', // LIVE was requested without a configured data port
];

export const MODES = ['TEST', 'LIVE'];

// TEST unless the operator explicitly said LIVE. Identical rule and identical
// spelling to approval-matrix.mjs:resolveMode — duplicated rather than imported
// because a deployable package must not depend on `scripts/`, and pinned
// against it by the offline suite so the two cannot drift.
export function resolveMode(env = {}) {
  return env.AWE_MODE === 'LIVE' ? 'LIVE' : 'TEST';
}

/**
 * resolveTenant({ requested, env, mode })
 *   -> { ok: true, org_id } | { ok: false, reason, detail }
 *
 * Precedence, and why:
 *
 *   `requested`  — an `org_id` argument on the tool call. Most specific, and
 *                  the only form a multi-tenant caller can use.
 *   `AWE_ORG_ID` — the operator's declared binding for this server process. An
 *                  MCP server is usually launched by one business's operator
 *                  for that business; stating it once at launch is the ordinary
 *                  case and is still explicit.
 *   neither      — refusal. This is the branch that used to be `orgs limit 1`.
 *
 * When both are present they must AGREE. A call naming org B against a process
 * bound to org A is either a mistake or an attempt, and both deserve the same
 * answer: refuse, and say which two values disagreed.
 */
export function resolveTenant({ requested = null, env = {} } = {}) {
  const bound = typeof env.AWE_ORG_ID === 'string' && env.AWE_ORG_ID.length > 0 ? env.AWE_ORG_ID : null;
  const asked = typeof requested === 'string' && requested.length > 0 ? requested : null;

  if (asked !== null && bound !== null && asked !== bound) {
    return {
      ok: false,
      reason: 'tenant_mismatch',
      detail: 'the requested org_id is not the org this server is bound to',
    };
  }
  const org_id = asked ?? bound;
  if (org_id === null) {
    return {
      ok: false,
      reason: 'tenant_required',
      detail: 'pass org_id on the call, or set AWE_ORG_ID for this server process',
    };
  }
  return { ok: true, org_id };
}

/**
 * resolveExecution({ requested, env, port })
 *   -> { ok: true, mode, org_id, is_fixture } | { ok: false, reason, detail }
 *
 * The whole entry gate in one call, because the two decisions are coupled: a
 * LIVE run with no tenant is refused by the kernel's execution context anyway
 * (`context.mjs` forbids it), and refusing here means the refusal carries a
 * registered reason instead of an exception.
 */
export function resolveExecution({ requested = null, env = {}, port = null } = {}) {
  const mode = resolveMode(env);
  invariant(MODES.includes(mode), 'invalid_input', `unknown mode '${mode}'`, { mode });

  const tenant = resolveTenant({ requested, env });
  if (!tenant.ok) return tenant;

  if (mode === 'LIVE' && (port === null || port.live !== true)) {
    return {
      ok: false,
      reason: 'live_execution_unavailable',
      detail: 'LIVE was requested but this process has no live data port configured',
    };
  }

  // `is_fixture` is the inverse of LIVE and is not independently settable: a
  // LIVE run marked as a fixture would let fixture-only guards wave through
  // real data, and the kernel refuses that combination anyway.
  return { ok: true, mode, org_id: tenant.org_id, is_fixture: mode !== 'LIVE' };
}
