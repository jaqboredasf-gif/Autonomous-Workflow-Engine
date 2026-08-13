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
    version: 'main@0038-po-number-per-job-vendor',
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
    // DECLARED, not verified. Nobody has run `uname` on the machine — the VM
    // has not been provisioned. The distinction is the point of the model.
    os: declared('linux', 'organization_it'),
    admin_access: declared(true, 'organization_it'),
    install_path: declared('/opt/pcc', 'awe_default'),
    cpu: declared(2, 'awe:architecture — single-writer store, cores buy nothing'),
    memory_gb: declared(2, 'awe:architecture'),
    disk_gb: declared(20, 'awe:architecture — attachments and full-copy backups drive growth, not records'),
  },

  storage: {
    data_path: declared('/var/lib/pcc', 'awe_default'),
    filesystem: declared('local', 'awe:sqlite requires it'),
    backed_up_by_customer: unknown('the backup platform has not been named'),
  },

  network: {
    // THE OUTSTANDING BLOCKER. Left as an explicit UNKNOWN carrying its reason,
    // which is what lets it appear in a report instead of as a silence.
    hostname: unknown('not yet chosen by Lippolis IT'),
    exposure: declared('internal', 'organization_it'),
    port: declared(3000, 'awe_default'),
    reverse_proxy: unknown('depends on what Lippolis already runs'),
    tls_owner: declared('CUSTOMER_IT', 'organization_it'),
  },

  database: {
    engine: declared('sqlite', 'awe:pilot decision — removes a database server from IT'),
    location: declared('/var/lib/pcc/pcc.sqlite', 'awe_default'),
    migrations_mode: declared('on-startup', 'application'),
    backup_destination: declared('/var/lib/pcc/backups', 'awe_default'),
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

  secrets: {
    store: declared('/etc/pcc.env', 'awe_default'),
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
