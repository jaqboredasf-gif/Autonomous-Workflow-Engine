// ---------------------------------------------------------------------------
// examples/northgate.manifest.mjs — where COMPANY #2 would actually run.
//
// A FICTIONAL CONTRACTOR, used for the second-customer rehearsal. Not Lippolis,
// and not a customer: see scripts/eval-second-customer.mjs, which provisions it
// from scratch and drives real purchasing work through it.
//
// NOT THE SAME FILE AS org-002-synthetic.manifest.mjs, and the distinction is
// worth keeping. That one is an ABSTRACTION TEST: it exists to prove the model
// derives `platform-managed` instead of assuming systemd, and that nothing
// requires a CUSTOMER_IT to exist. This one is a PLAUSIBLE SECOND DEPLOYMENT —
// the shape of thing a small mechanical contractor would really have — and its
// job is to be provisioned end to end rather than to break a derivation.
//
// HOW IT DIFFERS FROM LIPPOLIS, chosen so the differences are the ones that
// cost money to discover late:
//
//   · Windows Server rather than the Lippolis RDS host, but a different
//     service account and install path — so nothing may be positional
//   · an MSP holds infrastructure; there is no Jose. CUSTOMER_IT does not exist
//     as a party, and the restart owner is a company under contract
//   · SSO is what they WANT and local accounts are what the pilot gets. The
//     manifest records both, because the gap is a real conversation and
//     pretending it is settled is how a go-live slips a week
//   · email is drafted, not sent — the same pilot boundary Lippolis has, chosen
//     deliberately for a second time rather than inherited
//   · nobody has claimed monitoring, and it says so
// ---------------------------------------------------------------------------

import { declared, unknown } from '../facts.mjs';

export const northgateManifest = {
  manifest_version: 0.1,

  organization: {
    id: 'org-002-trades',
    name: 'Northgate Mechanical Ltd.',
  },

  application: {
    id: 'purchasing',
    version: 'v1.0.0',
  },

  runtime: {
    name: declared('node', 'awe'),
    min_version: declared('24', 'application'),
  },

  hosting: {
    environment: declared('on-prem-vm', 'msp'),
    os: declared('windows', 'msp'),
    admin_access: declared(true, 'msp:domain administrator under contract'),
    // Deliberately NOT the Lippolis path. Anything that only worked because of
    // C:\PCC would surface here.
    install_path: declared('D:\\Apps\\Purchasing', 'msp'),
  },

  storage: {
    data_path: declared('D:\\AppData\\Purchasing', 'msp'),
    filesystem: declared('local', 'msp:local volume, not the file share'),
    backed_up_by_customer: declared(true, 'msp:nightly image of the D: volume'),
  },

  network: {
    hostname: declared('purchasing.northgate.internal', 'msp'),
    exposure: declared('internal', 'application_owner:office and yard only'),
    port: declared(3000, 'awe'),
    reverse_proxy: declared('iis', 'msp'),
    tls_owner: declared('MSP', 'msp:internal certificate authority'),
  },

  database: {
    engine: declared('sqlite', 'application:node:sqlite, part of the runtime'),
    location: declared('D:\\AppData\\Purchasing\\purchasing.db', 'awe'),
    migrations_mode: declared('on-startup', 'application'),
    backup_destination: declared('D:\\AppData\\Purchasing\\backups', 'msp'),
  },

  authentication: {
    // WHAT THE PILOT GETS. Local accounts, because that is what is built.
    mode: declared('local', 'application_owner:accepted for the pilot'),
    // WHAT THEY ASKED FOR, recorded as a known gap rather than a promise. The
    // readiness gate reports it as an external dependency owned by the customer.
    provider: unknown('they use Microsoft 365 and expect single sign-on eventually; not built, not promised, and explicitly out of the pilot'),
  },

  integrations: {
    email_mode: declared('draft-only', 'application_owner:a person reviews every vendor email'),
    outbound_network_required: declared(false, 'application:nothing is sent during the pilot'),
  },

  operations: {
    health_readiness: declared('/api/health', 'awe'),
    health_liveness: declared('/api/health/live', 'awe'),
    monitoring: unknown('the MSP monitors the VM but has not agreed to poll the application URL'),
    restart_owner: declared('MSP', 'msp:service desk, business hours'),
    required_env: ['NODE_ENV', 'PCC_ENVIRONMENT', 'SESSION_SECRET', 'APP_BASE_URL', 'PCC_ORG_ID', 'PCC_PO_NUMBERING'],
  },

  secrets: {
    store: declared('secret-ref:msp-password-manager', 'msp'),
    session_secret: declared('secret-ref:msp/northgate/pcc-session-secret', 'msp'),
  },

  // No CUSTOMER_IT anywhere. An MSP and a non-technical application owner is
  // the ordinary case for a business this size, and the model has to produce a
  // complete answer without a Jose.
  responsibilities: {
    APPLICATION: 'AWE',
    INFRASTRUCTURE: 'MSP',
    DATABASE: 'MSP',
    DNS: 'MSP',
    NETWORK: 'MSP',
    TLS: 'MSP',
    IDENTITY: 'MSP',
    BACKUPS: 'MSP',
    MONITORING: 'UNKNOWN',
    CREDENTIALS: 'MSP',
    DEPLOYMENT_APPROVAL: 'APPLICATION_OWNER',
  },
};

export default northgateManifest;
