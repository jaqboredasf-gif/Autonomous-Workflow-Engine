// ---------------------------------------------------------------------------
// registry.mjs — THE list of everything the platform verifies.
//
// This is the single source of truth that `scripts/regression.sh` executes and
// that anything else (CI, a coverage question, a runner asserting it is
// registered) can read. Order is execution order and is significant: builds and
// pure suites first because they are fast and free, then the management-API
// suites, with the documented rate-limit cooldown after slice 4.
//
// Adding a suite means adding a descriptor here — not editing bash.
//
// Kind is a safety statement, enforced by `defineSuite`: 'unit'/'offline'/
// 'static' suites may not declare required credentials, so a suite cannot claim
// to be key-free while quietly depending on a token.
//
// PURE: data only. No clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { createSuiteRegistry } from './suite.mjs';

// Credentials the management-API suites read from `.env.acceptance`. Declared
// for reporting only: a missing token still runs the suite and fails it loudly,
// which is the behaviour the regression harness has always had.
const MGMT = ['SUPABASE_ACCESS_TOKEN'];
const MCP_LIVE = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AWE_ORG_ID'];

export const SUITES = [
  {
    id: 'kernel-unit',
    name: 'awe-kernel unit suite (Runner K, pure — no fixtures, no DB, no network)',
    kind: 'unit',
    command: 'bash scripts/eval-kernel.sh',
    description: 'Contract, determinism and fail-closed behaviour of packages/awe-kernel, plus its layering lint.',
    skipIfMissing: ['scripts/eval-kernel.sh'],
    tags: ['kernel', 'fast'],
  },
  {
    id: 'context-unit',
    name: 'context primitives (Runner C, pure — assembly, compaction, checkpoints)',
    kind: 'unit',
    command: 'bash scripts/eval-context.sh',
    description: 'Deterministic context assembly with full exclusion accounting, model-independent compaction, and resumable tenant-bound checkpoints.',
    skipIfMissing: ['scripts/eval-context.sh'],
    tags: ['kernel', 'context', 'fast'],
  },
  {
    id: 'mobile-typecheck',
    name: 'mobile typecheck',
    kind: 'build',
    command: '(cd apps/mobile && npx tsc --noEmit)',
    echoOk: true,
    tags: ['mobile'],
  },
  {
    id: 'web-build',
    name: 'web production build',
    kind: 'build',
    command: '(cd apps/web && npm run build >/dev/null 2>&1)',
    echoOk: true,
    tags: ['web'],
  },
  {
    id: 'mcp-smoke',
    name: 'MCP server smoke (initialize + tools/list, TEST mode — no credentials)',
    kind: 'build',
    command: 'bash scripts/smoke-mcp.sh',
    // No longer declares required credentials. The server now starts in TEST
    // mode with a fixture data port and holds no credential at all, so the tool
    // surface is listable — and therefore verifiable — in a credential-free
    // environment. LIVE still requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
    // and an explicit tenant, and refuses without them.
    skipIfMissing: ['scripts/smoke-mcp.sh'],
    tags: ['mcp'],
  },
  {
    id: 'acceptance-slice1',
    name: 'acceptance slice 1',
    kind: 'db',
    command: 'bash scripts/acceptance-slice1.sh',
    requires: MGMT,
    tags: ['acceptance'],
  },
  {
    id: 'acceptance-slice2',
    name: 'acceptance slice 2',
    kind: 'db',
    command: 'bash scripts/acceptance-slice2.sh',
    requires: MGMT,
    skipIfMissing: ['scripts/acceptance-slice2.sh'],
    tags: ['acceptance'],
  },
  {
    id: 'acceptance-slice3',
    name: 'acceptance slice 3',
    kind: 'db',
    command: 'bash scripts/acceptance-slice3.sh',
    requires: MGMT,
    skipIfMissing: ['scripts/acceptance-slice3.sh'],
    tags: ['acceptance'],
  },
  {
    id: 'acceptance-slice4',
    name: 'acceptance slice 4 (B3 live DB gates: RLS, approval events, send gate, parity)',
    kind: 'db',
    command: 'bash scripts/acceptance-slice4.sh',
    requires: MGMT,
    skipIfMissing: ['scripts/acceptance-slice4.sh'],
    // Slices 1-4 together burn most of the management-API per-minute budget and
    // the suites that follow are also mgmt-heavy. A 429 there reports as a fake
    // test failure, so let the window drain first.
    cooldownAfterSeconds: 45,
    tags: ['acceptance'],
  },
  {
    id: 'acceptance-slice5',
    name: 'acceptance slice 5 (B5 approval queue: browser-path RLS, RPC gates, embeds)',
    kind: 'db',
    command: 'bash scripts/acceptance-slice5.sh',
    requires: MGMT,
    skipIfMissing: ['scripts/acceptance-slice5.sh'],
    tags: ['acceptance'],
  },
  {
    id: 'acceptance-s1-security',
    name: 'S1 security (service-role-only tables: worker-JWT reads, audit-trail exposure, policy drift)',
    kind: 'db',
    command: 'bash scripts/acceptance-s1-security.sh',
    requires: MGMT,
    skipIfMissing: ['scripts/acceptance-s1-security.sh'],
    tags: ['acceptance', 'security'],
  },
  {
    id: 'eval-intake',
    name: 'intake eval (baseline, deterministic)',
    kind: 'db',
    command: 'bash scripts/eval-intake.sh',
    requires: MGMT,
    skipIfMissing: ['scripts/eval-intake.sh'],
    tags: ['eval', 'runner-1'],
  },
  {
    id: 'eval-classification',
    name: 'classification eval (Runner 2A, deterministic — no model key)',
    kind: 'db',
    command: 'bash scripts/eval-classification.sh',
    requires: MGMT,
    skipIfMissing: ['scripts/eval-classification.sh'],
    tags: ['eval', 'runner-2a'],
  },
  {
    id: 'validate-migration-0014',
    name: 'migration 0014 structural validation (offline lint — no DB)',
    kind: 'static',
    command: 'node scripts/lib/validate-migration-0014.mjs',
    skipIfMissing: ['scripts/lib/validate-migration-0014.mjs'],
    quietOnSuccess: true,
    echoOk: true,
    tags: ['migration'],
  },
  {
    id: 'eval-approval-diff',
    name: 'approval-diff eval (Runner 3, offline deterministic — no keys, no DB, no network)',
    kind: 'offline',
    command: 'bash scripts/eval-approval-diff.sh',
    skipIfMissing: ['scripts/eval-approval-diff.sh'],
    tags: ['eval', 'runner-3'],
  },
  {
    id: 'validate-migration-0015',
    name: 'migration 0015 structural validation (offline lint + engine/SQL parity — no DB)',
    kind: 'static',
    command: 'node scripts/lib/validate-migration-0015.mjs',
    skipIfMissing: ['scripts/lib/validate-migration-0015.mjs'],
    quietOnSuccess: true,
    echoOk: true,
    tags: ['migration'],
  },
  {
    id: 'eval-approval-matrix',
    name: 'approval-matrix + outbound-draft eval (Runner 4, offline deterministic — no keys, no DB, no network)',
    kind: 'offline',
    command: 'bash scripts/eval-approval-matrix.sh',
    skipIfMissing: ['scripts/eval-approval-matrix.sh'],
    tags: ['eval', 'runner-4'],
  },
  {
    id: 'eval-approval-queue',
    name: 'approval-queue eval (Runner 5, offline deterministic — no keys, no DB, no network)',
    kind: 'offline',
    command: 'bash scripts/eval-approval-queue.sh',
    skipIfMissing: ['scripts/eval-approval-queue.sh'],
    tags: ['eval', 'runner-5'],
  },
  {
    id: 'eval-mcp',
    name: 'kernelized MCP surface eval (Runner M, offline deterministic — no keys, no DB, no network)',
    kind: 'offline',
    command: 'bash scripts/eval-mcp.sh',
    description: 'MCP tools on the shared kernel: explicit tenant binding, cross-tenant confinement, outcome-to-response mapping, sanitized audit and artifacts, and the neutral tool-descriptor and platform-service boundaries.',
    skipIfMissing: ['scripts/eval-mcp.sh'],
    tags: ['eval', 'runner-m', 'mcp', 'security'],
  },
  {
    id: 'eval-mcp-live',
    name: 'kernelized MCP LIVE data-boundary proof (Runner M-LIVE, read-only, explicit opt-in)',
    kind: 'db',
    command: 'bash scripts/eval-mcp-live.sh',
    description: 'Runs every read-only MCP tool through the shared kernel against the Supabase data port, asserts every source row is tenant-labelled and confined, and proves a real second-tenant sentinel is unreachable.',
    requires: MCP_LIVE,
    skipIfMissing: ['scripts/eval-mcp-live.sh'],
    skipIfEnvMissing: true,
    optInEnv: 'AWE_RUN_LIVE_MCP',
    tags: ['eval', 'runner-m', 'mcp', 'security', 'live-proof'],
  },
  {
    id: 'eval-control-plane',
    name: 'execution control plane eval (Runner P, offline deterministic — no keys, no DB, no network)',
    kind: 'offline',
    command: 'bash scripts/eval-control-plane.sh',
    description: 'Registry-backed execution on the synthetic invoice-intake reference workflow: versioned workflow manifests, promotion and dependency gates, deny-by-default tenant policy, the controlled tool-invocation boundary with idempotency, the human approval gate with pause/resume across a cold store, denial, compensation, retry, timeout, cancellation, and refusal of a corrupted run journal.',
    skipIfMissing: ['scripts/eval-control-plane.sh'],
    tags: ['eval', 'runner-p', 'control-plane', 'security'],
  },
  {
    id: 'eval-execution',
    name: 'execution-outcome + durable-artifact eval (Runner E, offline deterministic — no keys, no DB, no network)',
    kind: 'offline',
    command: 'bash scripts/eval-execution.sh',
    description: 'Standardized outcome envelopes and audit events for prepareOutbound and classify, and the durable run-report artifact writer.',
    skipIfMissing: ['scripts/eval-execution.sh'],
    tags: ['eval', 'runner-e', 'kernel'],
  },
];

export const registry = createSuiteRegistry(SUITES);

export default registry;
