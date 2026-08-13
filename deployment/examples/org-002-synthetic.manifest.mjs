// ---------------------------------------------------------------------------
// examples/org-002-synthetic.manifest.mjs — the abstraction test.
//
// A SYNTHETIC organization, invented for one purpose: to find out whether the
// model actually removed Lippolis's assumptions or merely renamed them. It is
// not a customer and no code should be optimized for it.
//
// It differs from Lippolis in exactly the ways that hurt:
//
//   · cloud VM, not on-prem
//   · NO internal IT person — an MSP holds infrastructure, and the application
//     owner is a non-technical founder
//   · the hosting provider owns DNS; the organization cannot edit it
//   · managed Postgres, not an embedded file
//   · a container platform supervises the process — no systemd
//   · TLS terminated by the platform, not by a proxy anybody here runs
//   · SSO from day one, so the bootstrap-administrator pattern never applies
//
// WHAT IT IS EXPECTED TO REVEAL, and does:
//
//   1. `service.manager` derives to `platform-managed`, for which NO adapter
//      exists. The model reports that as a gap instead of silently assuming
//      systemd — which is the single most Lippolis-shaped assumption in the
//      whole deployment.
//   2. Nothing is owned by CUSTOMER_IT. Every blocker is addressed to an MSP,
//      a hosting provider, or the application owner. No Jose is required
//      anywhere for the model to produce a complete answer.
//   3. MONITORING is genuinely unowned, and says so rather than defaulting to
//      somebody.
// ---------------------------------------------------------------------------

import { declared, unknown } from '../facts.mjs';

export const org002Manifest = {
  manifest_version: 0.1,

  organization: {
    id: 'org-002-synthetic',
    name: 'Synthetic Test Organization',
  },

  application: {
    id: 'example-capability',
    version: 'v1.0.0',
  },

  runtime: {
    name: declared('node', 'awe'),
    min_version: declared('24', 'application'),
  },

  hosting: {
    environment: declared('managed-platform', 'msp'),
    // Still Linux underneath, but nothing here may act on that: the platform
    // supervises the process, so the OS does not decide the service manager.
    os: declared('linux', 'hosting_provider'),
    // The interesting one. No shell, no root, no service to install.
    admin_access: declared(false, 'hosting_provider:managed platform'),
    install_path: unknown('the platform decides where the artifact lands'),
  },

  storage: {
    // No local disk at all — the assumption most likely to break first.
    data_path: declared('managed:postgres', 'hosting_provider'),
    filesystem: declared('network', 'hosting_provider:no local persistent disk'),
    backed_up_by_customer: declared(true, 'hosting_provider:automated backups'),
  },

  network: {
    hostname: declared('capability.example-org.cloud', 'hosting_provider'),
    exposure: declared('public', 'application_owner'),
    port: declared(8080, 'hosting_provider:platform convention'),
    reverse_proxy: declared('platform-ingress', 'hosting_provider'),
    tls_owner: declared('HOSTING_PROVIDER', 'hosting_provider:automatic certificates'),
  },

  database: {
    engine: declared('postgres', 'msp:managed instance'),
    location: declared('env:DATABASE_URL', 'msp'),
    migrations_mode: declared('on-startup', 'application'),
    backup_destination: declared('provider-managed', 'hosting_provider'),
  },

  service: {
    // Deliberately not declared: the derivation must reach `platform-managed`
    // from hosting.environment, NOT `systemd` from hosting.os. If it reaches
    // systemd, the model has kept a Lippolis assumption.
    restart_policy: declared('always', 'hosting_provider'),
    enabled_at_boot: declared(true, 'hosting_provider:the platform restarts it'),
  },

  authentication: {
    mode: declared('sso', 'application_owner'),
    provider: declared('entra', 'msp'),
  },

  integrations: {
    email_mode: declared('smtp', 'application_owner'),
    outbound_network_required: declared(true, 'application:sends email'),
  },

  operations: {
    health_readiness: declared('/api/health', 'awe'),
    health_liveness: declared('/api/health/live', 'awe'),
    monitoring: unknown('nobody has been asked, and no party has claimed it'),
    // There is no IT department to call. This is a real answer, not a gap.
    restart_owner: declared('HOSTING_PROVIDER', 'msp:platform auto-restarts'),
    required_env: ['NODE_ENV', 'SESSION_SECRET', 'DATABASE_URL', 'APP_BASE_URL'],
  },

  secrets: {
    store: declared('secret-ref:platform-secret-manager', 'msp'),
    session_secret: declared('secret-ref:platform/session-secret', 'msp'),
  },

  // Not one of these is CUSTOMER_IT.
  responsibilities: {
    APPLICATION: 'AWE',
    INFRASTRUCTURE: 'HOSTING_PROVIDER',
    DATABASE: 'MSP',
    DNS: 'HOSTING_PROVIDER',
    NETWORK: 'HOSTING_PROVIDER',
    TLS: 'HOSTING_PROVIDER',
    IDENTITY: 'MSP',
    BACKUPS: 'HOSTING_PROVIDER',
    MONITORING: 'UNKNOWN',
    CREDENTIALS: 'MSP',
    DEPLOYMENT_APPROVAL: 'APPLICATION_OWNER',
  },
};

export default org002Manifest;
