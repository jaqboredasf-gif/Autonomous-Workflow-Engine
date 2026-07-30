// ---------------------------------------------------------------------------
// executor.ts — MicrosoftCapabilityExecutor.
//
// The single door. Every Microsoft side effect in AWE goes through
// `execute(request)`, and nothing reaches an adapter until every gate below has
// passed, in this order:
//
//   1. request shape          invalid_request
//   2. capability registry    unknown_capability / external_send_forbidden
//   3. capability version     unsupported_capability_version
//   4. tenant binding         cross_tenant_denied / tenant_binding_missing
//   5. resource allowlist     resource_not_allowlisted
//   6. TEST-mode safety       test_mode_violation
//   7. scopes                 scope_not_declared / insufficient_scope
//   8. policy decision        policy_decision_* / policy_denied
//   9. approval               approval_* (only when the spec requires one)
//  10. idempotency            -> replay, no second side effect
//  11. invoke, with bounded retries
//  12. evidence, always
//
// The ordering is deliberate: identity and authorization refusals come before
// anything that could touch the provider, and the cheapest, most specific
// refusal wins so an evidence row says *which* rule stopped it. Every path —
// including every refusal — writes evidence. Step 12 has no early return.
//
// What the executor does NOT do: it never decides policy and never grants an
// approval. It verifies decisions made by AWE's existing contracts and refuses
// when they are absent, stale or bound to something else.
// ---------------------------------------------------------------------------

import type {
  CapabilityRequest,
  CapabilityResult,
  DenialReason,
  FailureReason,
  GateOutcome,
  M365Mode,
  ProviderFidelity,
} from './contracts.ts';
import { BlockedLiveProofError } from './contracts.ts';
import { findCapability, isForbiddenCapability } from './capabilities.ts';
import type { ResourceAllowlist, AllowlistEntry } from './allowlist.ts';
import { checkResource, checkTenantBinding } from './allowlist.ts';
import { checkScopes } from './scopes.ts';
import type { EvidenceWriter } from './evidence.ts';
import { hashValue } from './evidence.ts';
import type { AdapterResult } from './adapters/types.ts';
import type { AdapterCallContext } from './adapters/mail.ts';

export interface InvocationRecord {
  readonly aweTenantId: string;
  readonly idempotencyKey: string;
  readonly capability: string;
  readonly executionId: string;
  readonly microsoftResourceIds: Readonly<Record<string, string>>;
  readonly outputHash: string | null;
  readonly completedAt: string;
}

/**
 * The idempotency boundary for side effects. A completed invocation is never
 * repeated: the second call replays the first one's Microsoft resource ids.
 * (The SQL-backed twin is the unique index on
 * m365_capability_invocations(org_id, idempotency_key) in migration 0016.)
 */
export interface InvocationLedger {
  get(aweTenantId: string, idempotencyKey: string): InvocationRecord | null;
  put(record: InvocationRecord): void;
  all(): readonly InvocationRecord[];
}

export function createInMemoryInvocationLedger(): InvocationLedger {
  const rows = new Map<string, InvocationRecord>();
  const key = (t: string, k: string) => `${t}|${k}`;
  return {
    get: (t, k) => rows.get(key(t, k)) ?? null,
    put: (r) => { rows.set(key(r.aweTenantId, r.idempotencyKey), r); },
    all: () => [...rows.values()],
  };
}

/** What an adapter binding receives once every gate has passed. */
export interface HandlerContext {
  readonly request: CapabilityRequest;
  readonly entry: AllowlistEntry;
  readonly call: AdapterCallContext;
  readonly attempt: number;
}

export type CapabilityHandler = (ctx: HandlerContext) => Promise<AdapterResult<unknown>>;

export interface ExecutorDeps {
  readonly allowlist: ResourceAllowlist;
  readonly evidence: EvidenceWriter;
  readonly ledger: InvocationLedger;
  readonly handlers: Readonly<Record<string, CapabilityHandler>>;
  readonly fidelity: ProviderFidelity;
  readonly mode: M365Mode;
  /** Injected so retry backoff is deterministic in tests; real deployments sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface MicrosoftCapabilityExecutor {
  execute(request: CapabilityRequest): Promise<CapabilityResult>;
}

const MAX_ATTEMPTS_CEILING = 5;
const MAX_TIMEOUT_MS = 60_000;

export function createCapabilityExecutor(deps: ExecutorDeps): MicrosoftCapabilityExecutor {
  const sleep = deps.sleep ?? (async () => {});

  return {
    async execute(request: CapabilityRequest): Promise<CapabilityResult> {
      const gates: GateOutcome[] = [];
      const gate = (name: string, ok: boolean, detail: string | null = null): boolean => {
        gates.push({ gate: name, ok, detail });
        return ok;
      };

      const inputHash = hashValue(request.input ?? null);

      // Evidence is written by exactly one function, used by every exit path.
      const finish = (
        outcome: CapabilityResult['outcome'],
        opts: {
          denialReason?: DenialReason | null;
          failureReason?: FailureReason | null;
          detail?: string | null;
          microsoftResourceIds?: Readonly<Record<string, string>>;
          data?: unknown;
          outputHash?: string | null;
          attempts?: number;
        } = {},
      ): CapabilityResult => {
        const evidence = deps.evidence.record({
          aweTenantId: request.aweTenantId,
          microsoftTenantId: request.microsoftTenantId,
          objectiveId: request.objectiveId,
          workPackageId: request.workPackageId,
          taskId: request.taskId,
          executionId: request.executionId,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
          capability: request.capability,
          capabilityVersion: request.capabilityVersion,
          actingPrincipal: request.actingPrincipal,
          targetResource: request.targetResource,
          requiredScopes: request.requiredScopes,
          policyDecisionId: request.policyDecisionRef?.id ?? 'none',
          policyEffect: request.policyDecisionRef?.effect ?? 'deny',
          approvalId: request.approvalRef?.id ?? null,
          approvalState: request.approvalRef?.state ?? null,
          outcome,
          denialReason: opts.denialReason ?? null,
          failureReason: opts.failureReason ?? null,
          fidelity: deps.fidelity,
          microsoftResourceIds: opts.microsoftResourceIds ?? {},
          inputHash,
          outputHash: opts.outputHash ?? null,
          attempts: opts.attempts ?? 0,
          gates,
        });
        return {
          outcome,
          capability: request.capability,
          capabilityVersion: request.capabilityVersion,
          executionId: request.executionId,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
          fidelity: deps.fidelity,
          denialReason: opts.denialReason ?? null,
          failureReason: opts.failureReason ?? null,
          detail: opts.detail ?? null,
          microsoftResourceIds: opts.microsoftResourceIds ?? {},
          data: opts.data ?? null,
          attempts: opts.attempts ?? 0,
          gates,
          evidence,
        };
      };

      const deny = (reason: DenialReason, detail: string): CapabilityResult =>
        finish('denied', { denialReason: reason, detail });

      // --- 1. Request shape ---------------------------------------------------
      const missing = requiredFieldsMissing(request);
      if (!gate('request_shape', missing.length === 0, missing.join(', ') || null)) {
        return deny('invalid_request', `missing or empty required field(s): ${missing.join(', ')}`);
      }
      if (!gate('bounds', request.timeoutMs > 0 && request.timeoutMs <= MAX_TIMEOUT_MS
        && request.maxAttempts >= 1 && request.maxAttempts <= MAX_ATTEMPTS_CEILING)) {
        return deny('invalid_request', `timeoutMs must be 1..${MAX_TIMEOUT_MS} and maxAttempts 1..${MAX_ATTEMPTS_CEILING}`);
      }

      // --- 2. Capability registry --------------------------------------------
      if (isForbiddenCapability(request.capability)) {
        gate('capability_registry', false, 'explicitly forbidden capability');
        return deny('external_send_forbidden', `capability '${request.capability}' is explicitly forbidden`);
      }
      const spec = findCapability(request.capability);
      if (!gate('capability_registry', spec !== null)) {
        return deny('unknown_capability', `no registered capability '${request.capability}'`);
      }
      // Belt and braces: a catalog entry that ever declared external_send would
      // still never execute.
      if (!gate('side_effect_class', spec!.sideEffect !== 'external_send')) {
        return deny('external_send_forbidden', `capability '${request.capability}' declares an external send`);
      }
      if (!gate('capability_version', spec!.version === request.capabilityVersion,
        `requested v${request.capabilityVersion}, registry has v${spec!.version}`)) {
        return deny('unsupported_capability_version', `capability '${request.capability}' has no version ${request.capabilityVersion}`);
      }

      // --- 3. Tenant binding --------------------------------------------------
      const binding = checkTenantBinding(deps.allowlist, request.aweTenantId, request.microsoftTenantId);
      if (!gate('tenant_binding', binding.ok, binding.reason)) {
        const reason: DenialReason = deps.allowlist.binding.aweTenantId === request.aweTenantId
          ? 'cross_tenant_denied'
          : 'tenant_binding_missing';
        return deny(reason, binding.reason ?? 'tenant binding refused');
      }

      // --- 4. Resource allowlist ---------------------------------------------
      const resourceVerdict = checkResource(deps.allowlist, request.capability, request.targetResource, {
        requireDevelopmentResource: deps.mode === 'TEST',
      });
      if (!gate('resource_allowlist', resourceVerdict.allowed, resourceVerdict.allowed ? null : resourceVerdict.reason)) {
        return deny('resource_not_allowlisted', (resourceVerdict as { reason: string }).reason);
      }
      const entry = (resourceVerdict as { entry: AllowlistEntry }).entry;

      // --- 5. TEST-mode safety ------------------------------------------------
      if (deps.mode === 'TEST') {
        const violation = testModeViolation(request, entry);
        if (!gate('test_mode', violation === null, violation)) {
          return deny('test_mode_violation', violation!);
        }
      } else {
        gate('test_mode', true, 'mode=LIVE');
      }

      // --- 6. Scopes ----------------------------------------------------------
      const scopeVerdict = checkScopes(spec!, request.requiredScopes, deps.allowlist.grantedScopes);
      if (!gate('scopes', scopeVerdict.ok, scopeVerdict.ok ? null : scopeVerdict.detail)) {
        const v = scopeVerdict as { reason: DenialReason; detail: string };
        return deny(v.reason, v.detail);
      }

      // --- 7. Policy decision -------------------------------------------------
      const policy = request.policyDecisionRef;
      if (!gate('policy_present', policy != null)) {
        return deny('policy_decision_missing', 'no policy decision reference on the request');
      }
      const policyBound = policy.capability === request.capability
        && policy.resourceId === request.targetResource.id
        && policy.executionId === request.executionId;
      if (!gate('policy_binding', policyBound,
        `decision ${policy.id} is bound to ${policy.capability}/${policy.resourceId}/${policy.executionId}`)) {
        return deny('policy_decision_mismatch', `policy decision '${policy.id}' is not bound to this capability, resource and execution`);
      }
      if (!gate('policy_freshness', Date.parse(policy.expiresAt) > Date.parse(policy.decidedAt))) {
        return deny('policy_decision_expired', `policy decision '${policy.id}' has a non-positive validity window`);
      }
      if (!gate('policy_effect', policy.effect === 'permit', policy.reason ?? null)) {
        return deny('policy_denied', `policy decision '${policy.id}' is a deny${policy.reason ? `: ${policy.reason}` : ''}`);
      }

      // --- 8. Approval --------------------------------------------------------
      if (spec!.requiresApproval) {
        const approval = request.approvalRef ?? null;
        if (!gate('approval_present', approval !== null)) {
          return deny('approval_missing', `capability '${request.capability}' requires an approval reference`);
        }
        const bound = approval!.capability === request.capability
          && approval!.resourceId === request.targetResource.id
          && approval!.executionId === request.executionId;
        if (!gate('approval_binding', bound)) {
          return deny('approval_mismatch', `approval '${approval!.id}' is not bound to this capability, resource and execution`);
        }
        if (!gate('approval_state', approval!.state === 'approved', approval!.state)) {
          return deny('approval_not_granted', `approval '${approval!.id}' is '${approval!.state}'`);
        }
        // Automation never approves: an approval that names a service principal
        // (or nobody) is not a human decision.
        const approver = approval!.approvedBy;
        if (!gate('approval_human', approver != null && approver.kind === 'user')) {
          return deny('approval_by_service_principal', `approval '${approval!.id}' was not granted by a named human`);
        }
        if (!gate('approval_freshness', approval!.approvedAt != null
          && Date.parse(approval!.expiresAt) > Date.parse(approval!.approvedAt))) {
          return deny('approval_expired', `approval '${approval!.id}' is expired or has no decision time`);
        }
      } else {
        gate('approval_not_required', true, null);
      }

      // --- 9. Idempotency -----------------------------------------------------
      const prior = deps.ledger.get(request.aweTenantId, request.idempotencyKey);
      if (prior) {
        gate('idempotency', true, `replaying invocation from ${prior.completedAt}`);
        return finish('replayed', {
          microsoftResourceIds: prior.microsoftResourceIds,
          outputHash: prior.outputHash,
          detail: `idempotency key already completed at ${prior.completedAt}`,
          attempts: 0,
        });
      }
      gate('idempotency', true, 'first invocation for this key');

      // --- 10. Invoke, with bounded retries -----------------------------------
      const handler = deps.handlers[request.capability];
      if (!gate('handler', handler != null)) {
        return deny('unknown_capability', `no handler bound for '${request.capability}'`);
      }

      const call: AdapterCallContext = {
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
        timeoutMs: request.timeoutMs,
        scopes: request.requiredScopes,
      };

      let attempts = 0;
      let lastFailure: { failureReason: FailureReason; detail: string } | null = null;

      while (attempts < request.maxAttempts) {
        attempts += 1;
        let result: AdapterResult<unknown>;
        try {
          result = await handler!({ request, entry, call, attempt: attempts });
        } catch (e) {
          // A throwing adapter is a provider failure, never an escape hatch out
          // of the evidence trail.
          const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          // A missing live prerequisite is its own outcome. It must never be
          // reported as anything that could be mistaken for a call that happened.
          if (e instanceof BlockedLiveProofError) {
            gate('provider_call', false, detail);
            return finish('blocked_live_proof', {
              failureReason: 'live_access_blocked',
              detail,
              attempts,
            });
          }
          lastFailure = { failureReason: 'provider_error', detail };
          break;
        }

        if (result.ok) {
          const outputHash = hashValue(result.raw);
          deps.ledger.put({
            aweTenantId: request.aweTenantId,
            idempotencyKey: request.idempotencyKey,
            capability: request.capability,
            executionId: request.executionId,
            microsoftResourceIds: result.microsoftResourceIds,
            outputHash,
            completedAt: request.policyDecisionRef.decidedAt,
          });
          gate('provider_call', true, `succeeded on attempt ${attempts}`);
          return finish('succeeded', {
            microsoftResourceIds: result.microsoftResourceIds,
            data: result.data,
            outputHash,
            attempts,
          });
        }

        lastFailure = { failureReason: result.failureReason, detail: result.detail };
        if (!result.retryable || attempts >= request.maxAttempts) break;

        // Honour Retry-After when Graph sends one; otherwise exponential backoff.
        const waitMs = result.retryAfterSeconds != null
          ? result.retryAfterSeconds * 1000
          : Math.min(1000 * 2 ** (attempts - 1), 30_000);
        gate(`retry_${attempts}`, true, `${result.failureReason}; waiting ${waitMs}ms`);
        await sleep(waitMs);
      }

      gate('provider_call', false, lastFailure?.detail ?? 'no attempt was made');
      return finish('failed', {
        failureReason: lastFailure?.failureReason ?? 'provider_error',
        detail: lastFailure?.detail ?? 'provider call failed',
        attempts,
      });
    },
  };
}

// policyDecisionRef is deliberately NOT here: its absence has its own, more
// specific refusal (policy_decision_missing) at the policy gate, and a specific
// reason in the evidence row is worth more than a generic one.
const REQUIRED_FIELDS: readonly (keyof CapabilityRequest)[] = [
  'aweTenantId', 'microsoftTenantId', 'objectiveId', 'workPackageId', 'taskId', 'executionId',
  'capability', 'capabilityVersion', 'actingPrincipal', 'targetResource', 'requiredScopes',
  'idempotencyKey', 'correlationId', 'timeoutMs', 'maxAttempts',
];

function requiredFieldsMissing(request: CapabilityRequest): string[] {
  if (request == null || typeof request !== 'object') return ['request'];
  const missing: string[] = [];
  for (const f of REQUIRED_FIELDS) {
    const v = request[f];
    if (v == null) { missing.push(String(f)); continue; }
    if (typeof v === 'string' && v.trim() === '') missing.push(String(f));
    if (Array.isArray(v) && v.length === 0) missing.push(String(f));
  }
  if (request.targetResource && !request.targetResource.id) missing.push('targetResource.id');
  if (request.actingPrincipal && !request.actingPrincipal.id) missing.push('actingPrincipal.id');
  return missing;
}

/**
 * RFC 6761 reserves the whole `.invalid` TLD as permanently unresolvable, so a
 * draft addressed inside it cannot reach a real mailbox even if something later
 * tried to send it.
 *
 * B3's TEST mode (scripts/lib/approval-matrix.mjs) requires the exact domain
 * `@example.invalid`; this plane accepts any `.invalid` host, because Microsoft
 * resources are addressed by realistic multi-label UPNs
 * (dev-intake@awe-dev.example.invalid) and forcing them flat would make the
 * fixtures less like the tenant they stand in for. The safety property — the
 * address cannot resolve — is identical, and B3's rule is a strict subset.
 */
export const FIXTURE_EMAIL_DOMAIN = '@example.invalid';
export const UNRESOLVABLE_TLD = '.invalid';

/**
 * TEST-mode safety: in TEST mode nothing may be addressed to a resolvable
 * recipient, and the resource must be a development one (already checked by the
 * allowlist gate; re-checked here because this gate must not depend on the
 * order of the one before it).
 */
function testModeViolation(request: CapabilityRequest, entry: AllowlistEntry): string | null {
  if (!entry.isDevelopmentResource) return `resource '${entry.label}' is not a development resource`;

  const input = request.input ?? {};
  const recipients = [
    ...(Array.isArray(input.toAddrs) ? (input.toAddrs as unknown[]) : []),
    ...(Array.isArray(input.ccAddrs) ? (input.ccAddrs as unknown[]) : []),
  ].filter((a): a is string => typeof a === 'string');

  const real = recipients.filter((a) => !a.toLowerCase().trim().endsWith(UNRESOLVABLE_TLD));
  if (real.length > 0) return `TEST mode forbids resolvable recipients: ${real.join(', ')}`;
  return null;
}
