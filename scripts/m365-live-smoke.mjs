// ---------------------------------------------------------------------------
// m365-live-smoke.mjs — the ONLY code path in this repo that can talk to a real
// Microsoft 365 tenant. Disabled by default; read-only by default.
//
// It runs nothing unless ALL of these are true:
//   M365_LIVE_SMOKE=1                     explicit opt-in
//   M365_TENANT_ID / M365_CLIENT_ID / M365_CLIENT_SECRET   complete credentials
//   M365_ALLOWLIST_PATH                   a config file naming the exact test
//                                         resources (same shape as
//                                         fixtures/m365/allowlist.json)
//   M365_SMOKE_MAILBOX / M365_SMOKE_MESSAGE_ID             what to read
//
// When any prerequisite is missing it prints a BLOCKED_LIVE_PROOF report naming
// exactly what is absent and exits non-zero. It NEVER falls back to the fake
// provider, and it never prints a result it did not receive.
//
// Draft creation is a second opt-in (M365_LIVE_ALLOW_DRAFT=1) and still goes
// through the executor, so it needs a policy permit and a human approval
// reference like every other side effect. There is no send path, here or
// anywhere else in the package.
//
// Usage: bash scripts/m365-live-smoke.sh
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import {
  createEnvCredentialProvider, createHttpGraphGateway, createCapabilityExecutor,
  createInMemoryInvocationLedger, createInMemoryEvidenceLog, createEvidenceWriter,
  createCapabilityHandlers, createIdentityAdapter, createMailAdapter, createTeamsAdapter,
  createDocumentAdapter, auditGrantedScopes, findCapability, BlockedLiveProofError,
} from '../packages/m365/src/index.ts';

const env = process.env;
const missing = [];

const need = (name, why) => {
  const v = env[name];
  if (v == null || v.trim() === '') missing.push(`${name} — ${why}`);
  return v ?? null;
};

if (env.M365_LIVE_SMOKE !== '1') missing.push('M365_LIVE_SMOKE=1 — explicit opt-in to touch a live tenant');
need('M365_TENANT_ID', 'Entra directory (tenant) id of the development tenant');
need('M365_CLIENT_ID', 'application (client) id of the AWE app registration');
need('M365_CLIENT_SECRET', 'client secret or certificate assertion (never committed)');
const allowlistPath = need('M365_ALLOWLIST_PATH', 'path to the live resource allowlist config');
const mailbox = need('M365_SMOKE_MAILBOX', 'UPN of the authorized development mailbox to read');
const messageId = need('M365_SMOKE_MESSAGE_ID', 'Graph id of one message in that mailbox to read');

if (missing.length > 0) {
  console.log('BLOCKED_LIVE_PROOF');
  console.log('==================');
  console.log('The live smoke test did not run. No Microsoft call was attempted, and no result');
  console.log('below this line is simulated — there is nothing below this line.\n');
  console.log('Missing prerequisites:');
  for (const m of missing) console.log(`  - ${m}`);
  console.log('\nSee docs/integrations/M365_ENTRA_CONFIGURATION.md for the exact app registration');
  console.log('and Microsoft Graph permissions an administrator must provide.');
  process.exit(2);
}

const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));

const scopeAudit = auditGrantedScopes(allowlist.grantedScopes ?? []);
if (!scopeAudit.ok) {
  console.log('BLOCKED_LIVE_PROOF');
  console.log('==================');
  console.log('The configured granted scopes are broader than this integration may ever hold:');
  for (const p of scopeAudit.problems) console.log(`  - ${p}`);
  process.exit(2);
}

const credentials = createEnvCredentialProvider(env);
let gateway;
try {
  gateway = createHttpGraphGateway({ credentials, grantedScopes: allowlist.grantedScopes, env });
} catch (e) {
  if (e instanceof BlockedLiveProofError) {
    console.log('BLOCKED_LIVE_PROOF');
    console.log('==================');
    for (const m of e.missing) console.log(`  - ${m}`);
    process.exit(2);
  }
  throw e;
}

const clock = { now: () => new Date().toISOString() };
const evidenceLog = createInMemoryEvidenceLog();
const evidence = createEvidenceWriter(evidenceLog, clock);
const adapters = {
  identity: createIdentityAdapter(gateway),
  mail: createMailAdapter(gateway),
  teams: createTeamsAdapter(gateway),
  document: createDocumentAdapter(gateway),
};
const executor = createCapabilityExecutor({
  allowlist,
  evidence,
  ledger: createInMemoryInvocationLedger(),
  handlers: createCapabilityHandlers(adapters),
  fidelity: gateway.fidelity,
  // LIVE mode still cannot send: no send capability exists at any version.
  mode: 'LIVE',
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

const executionId = `exec_live_smoke_${Date.now()}`;
const buildRequest = (capability, targetResource, input = {}, approvalRef = null) => {
  const spec = findCapability(capability);
  const at = clock.now();
  return {
    aweTenantId: allowlist.binding.aweTenantId,
    microsoftTenantId: allowlist.binding.microsoftTenantId,
    objectiveId: 'obj_live_smoke',
    workPackageId: 'wp.live_smoke',
    taskId: `task_${capability}`,
    executionId,
    capability,
    capabilityVersion: spec.version,
    actingPrincipal: { kind: 'service', id: env.M365_CLIENT_ID },
    targetResource,
    requiredScopes: spec.requiredScopes,
    policyDecisionRef: {
      id: `pol_live_smoke_${capability}`,
      effect: 'permit',
      capability,
      resourceId: targetResource.id,
      executionId,
      decidedAt: at,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      reason: 'operator-run live smoke test against explicitly configured development resources',
      engine: 'live-smoke-operator',
    },
    approvalRef,
    idempotencyKey: `idem_${executionId}_${capability}`,
    correlationId: executionId,
    timeoutMs: 20000,
    maxAttempts: 3,
    input,
  };
};

const report = [];
const run = async (label, request) => {
  const result = await executor.execute(request);
  report.push({
    label,
    capability: result.capability,
    outcome: result.outcome,
    fidelity: result.fidelity,
    denial: result.denialReason,
    failure: result.failureReason,
    detail: result.detail,
    microsoftResourceIds: result.microsoftResourceIds,
    attempts: result.attempts,
    evidenceId: result.evidence.evidenceId,
  });
  return result;
};

console.log(`M365 live smoke — tenant ${allowlist.binding.microsoftTenantId}, execution ${executionId}`);
console.log('Read-only unless M365_LIVE_ALLOW_DRAFT=1. No send path exists.\n');

await run('resolve the smoke mailbox identity',
  buildRequest('m365.identity.resolve', { kind: 'directory_user', id: mailbox }));

const read = await run('read one message',
  buildRequest('m365.mail.message.read', { kind: 'message', id: messageId, parent: mailbox }));

if (env.M365_LIVE_ALLOW_DRAFT === '1') {
  const approvalId = env.M365_LIVE_APPROVAL_ID;
  const approverId = env.M365_LIVE_APPROVER_ID;
  if (!approvalId || !approverId) {
    console.log('\nDraft skipped: M365_LIVE_ALLOW_DRAFT=1 requires M365_LIVE_APPROVAL_ID and');
    console.log('M365_LIVE_APPROVER_ID — a draft is a side effect and needs a recorded human decision.');
  } else {
    const at = clock.now();
    await run('create ONE draft (never sent)', buildRequest(
      'm365.mail.draft.create',
      { kind: 'mailbox', id: mailbox },
      {
        subject: `[AWE live smoke ${executionId}]`,
        bodyText: 'Automated AWE integration smoke test. This draft is never sent.',
        toAddrs: [env.M365_SMOKE_DRAFT_RECIPIENT ?? 'awe-smoke@example.invalid'],
      },
      {
        id: approvalId,
        state: 'approved',
        capability: 'm365.mail.draft.create',
        resourceId: mailbox,
        executionId,
        approvedBy: { kind: 'user', id: approverId },
        approvedAt: at,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
    ));
  }
}

console.log(JSON.stringify(report, null, 2));
const failed = report.filter((r) => r.outcome !== 'succeeded');
console.log(`\nlive smoke: ${report.length} capability call(s), ${failed.length} not succeeded`);
console.log(`evidence rows: ${evidenceLog.all().length} (fidelity ${gateway.fidelity})`);
process.exit(failed.length === 0 && read.outcome === 'succeeded' ? 0 : 1);
