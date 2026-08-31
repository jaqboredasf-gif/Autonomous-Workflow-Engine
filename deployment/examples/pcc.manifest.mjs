// ---------------------------------------------------------------------------
// examples/pcc.manifest.mjs — deployment instance #1, as the model sees it.
//
// This is the real thing, not an illustration: every value is what PCC actually
// deploys with, and the UNKNOWNs are genuinely unknown as of 2026-08-13.
//
// THE TEST THIS FILE IS. If the deployment substrate cannot describe PCC
// correctly — including surfacing the outstanding hostname as a go-live blocker
// through the model rather than through special-case code — then the substrate
// is wrong or too abstract. That check is in scripts/eval-deployment-core.mjs.
// ---------------------------------------------------------------------------

import { declared, unknown, verified } from '../facts.mjs';

export const pccManifest = {
  manifest_version: 0.1,

  organization: {
    id: 'lippolis',
    name: 'Lippolis Electric, Inc.',
  },

  application: {
    id: 'pcc',
    // UNKNOWN, and it is a real blocker rather than an omission. The runbook
    // requires a specific commit or tag to be approved and recorded — "deploy a
    // specific commit, never a moving branch" — and nobody has named one. This
    // carried a stale build tag from two schema versions ago, which reads like
    // an answer and is not one.
    version: unknown('no commit has been approved for deployment — the runbook requires a specific commit or tag, recorded in the installation record and in PCC_RELEASE'),
    repository: 'AWE-Purchasing',
  },

  // Verified, not declared: this process is running on it, which is the only
  // kind of evidence that means anything about a runtime floor.
  runtime: {
    name: verified('node', 'process.versions'),
    min_version: declared('24', 'application:node:sqlite is part of the runtime'),
  },

  hosting: {
    environment: declared('on-prem-vm', 'organization_it'),
    // WINDOWS, and this was wrong until 2026-08-27. It said `linux`, which made
    // the model derive `systemd` for a machine that has never had it — the
    // target is LIPELE-RDS02, Windows Server 2019 Standard, named in
    // docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md. Still DECLARED rather
    // than verified: nobody has run `systeminfo` on the machine, and the
    // distinction is the point of the model.
    os: declared('windows', 'organization_it:LIPELE-RDS02 · Windows Server 2019 Standard'),
    admin_access: declared(true, 'organization_it'),
    // C:\Program Files\pcc, because that is where install-production.ps1 puts
    // it: `if (-not $InstallPath) { $InstallPath = "C:\Program Files\$ServiceName" }`.
    // This said C:\pcc, which no script, document or icacls grant ever used —
    // a manifest that disagrees with the installer describes a machine nobody
    // is going to build. scripts/pcc-deployment-gate.mjs now checks the two
    // against each other rather than trusting either.
    install_path: declared('C:\\Program Files\\pcc', 'awe_default:windows — scripts/install-production.ps1 default'),
    cpu: declared(2, 'awe:architecture — single-writer store, cores buy nothing'),
    memory_gb: declared(2, 'awe:architecture'),
    disk_gb: declared(20, 'awe:architecture — attachments and full-copy backups drive growth, not records'),
  },

  storage: {
    data_path: declared('C:\\ProgramData\\pcc\\data', 'awe_default:windows — PCC_RDS02_EXECUTION_PACKAGE.md'),
    filesystem: declared('local', 'awe:sqlite requires it'),
    backed_up_by_customer: unknown('the backup platform has not been named'),
  },

  network: {
    // THE OUTSTANDING BLOCKER. Left as an explicit UNKNOWN carrying its reason,
    // which is what lets it appear in a report instead of as a silence.
    hostname: unknown('not yet chosen by Lippolis IT — the server answers on 192.168.10.152 today'),
    exposure: declared('internal', 'organization_it:LAN only'),
    port: declared(3000, 'awe_default:loopback only, IIS is the front door'),
    reverse_proxy: declared('iis', 'organization_it:IIS terminates HTTPS on 443 — PCC_RDS02_EXECUTION_PACKAGE.md'),
    tls_owner: declared('CUSTOMER_IT', 'organization_it'),
  },

  database: {
    engine: declared('sqlite', 'awe:pilot decision — removes a database server from IT'),
    location: declared('C:\\ProgramData\\pcc\\data\\pcc.sqlite', 'awe_default:windows'),
    migrations_mode: declared('on-startup', 'application'),
    backup_destination: declared('C:\\ProgramData\\pcc\\backups', 'awe_default:windows'),
  },

  service: {
    // Deliberately absent so the model DERIVES it from hosting.os. If this were
    // declared, the derivation would never be exercised.
    restart_policy: declared('on-failure', 'awe_default'),
    enabled_at_boot: unknown('nobody has enabled the unit — the VM does not exist yet'),
  },

  authentication: {
    mode: declared('local', 'awe:pilot — no SSO requirement stated'),
  },

  integrations: {
    email_mode: declared('draft-only', 'organization:business rule — a person reviews every vendor email'),
    outbound_network_required: declared(false, 'application:nothing is called at runtime'),
  },

  operations: {
    health_readiness: declared('/api/health', 'application'),
    health_liveness: declared('/api/health/live', 'application'),
    monitoring: unknown('no monitoring tool named'),
    restart_owner: declared('CUSTOMER_IT', 'organization_it:Jose'),
    // Consumed by the config.required_present preflight check.
    required_env: ['NODE_ENV', 'SESSION_SECRET', 'PCC_DATABASE_PATH', 'APP_BASE_URL'],
  },

  // The two facts that are written into the database once, when it is created,
  // and can never be corrected afterwards. Both are UNKNOWN because the first
  // start has not happened — which is exactly when they must be right.
  measurement: {
    environment: unknown('PCC_ENVIRONMENT is not yet set on the server — an install that omits it produces records that are refused as evidence'),
    org_id_declared: unknown('PCC_ORG_ID is not yet set on the server — without it the org id is a generated UUID no baseline can be written against'),
    baseline_registered: declared(true, 'awe:proof/baselines/lippolis-purchasing.mjs exists for orgId lippolis, with every duration UNAVAILABLE until measured'),
  },

  secrets: {
    store: declared('C:\\ProgramData\\pcc\\pcc.env', 'awe_default:windows'),
    session_secret: declared('env:SESSION_SECRET', 'awe:reference only'),
  },

  // Lippolis has one person for most of this. Writing it down per domain is
  // what stops "Jose" becoming an architectural assumption — the next
  // organization fills the same table in differently.
  responsibilities: {
    APPLICATION: 'AWE',
    INFRASTRUCTURE: 'CUSTOMER_IT',
    DATABASE: 'AWE',
    DNS: 'CUSTOMER_IT',
    NETWORK: 'CUSTOMER_IT',
    TLS: 'CUSTOMER_IT',
    IDENTITY: 'AWE',
    BACKUPS: 'SHARED',
    MONITORING: 'UNKNOWN',
    CREDENTIALS: 'SHARED',
    DEPLOYMENT_APPROVAL: 'APPLICATION_OWNER',
  },
};

export default pccManifest;
