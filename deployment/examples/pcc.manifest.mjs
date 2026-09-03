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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { declared, unknown, verified } from '../facts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The approved release, READ FROM THE APPROVAL RECORD rather than typed here.
 *
 * The runbook requires a specific approved commit, and approval is a person's
 * signature — not something this file, or any code, can grant itself. So
 * deployment/APPROVED_RELEASE.md is the source of truth: it names a candidate
 * and carries an unsigned approval block, and the moment a person fills that
 * block in, this fact becomes known and the deployment gate moves past
 * BUILD_ONLY with no code change at all.
 *
 * An unsigned record is not an approval, and is reported as one would hope: a
 * candidate exists, nobody has signed it.
 */
function approvedVersion() {
  // See approvedCommit() in programs/iic-2027/derive.mjs: overridable only so
  // the unsigned direction stays testable. It cannot fabricate a signature.
  const path = join(ROOT, process.env.PCC_APPROVAL_RECORD ?? 'deployment/APPROVED_RELEASE.md');
  if (!existsSync(path)) {
    return unknown('no approval record exists — deployment/APPROVED_RELEASE.md names the candidate and carries the signature block');
  }
  const text = readFileSync(path, 'utf8');
  const commit = /^-\s*\*\*Commit\*\*:\s*`([0-9a-f]{7,40})`/m.exec(text)?.[1] ?? null;
  const rawSigner = /^-\s*\*\*Approved by\*\*:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? '';
  const signedBy = rawSigner && !/^_+$/.test(rawSigner) ? rawSigner : null;

  if (!commit) return unknown('deployment/APPROVED_RELEASE.md exists and names no candidate commit');
  if (!signedBy) {
    return unknown(
      `${commit} is proposed in deployment/APPROVED_RELEASE.md and nobody has signed it — ` +
      'approval is a person\'s decision, and the runbook requires a specific approved commit');
  }
  return declared(commit, `approval:deployment/APPROVED_RELEASE.md, signed by ${signedBy}`);
}

export const pccManifest = {
  manifest_version: 0.1,

  organization: {
    id: 'lippolis',
    name: 'Lippolis Electric, Inc.',
  },

  application: {
    id: 'pcc',
    // Read from the approval record. Writing a version here before the
    // signature exists would be the code approving its own release.
    version: approvedVersion(),
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
    // VERIFIED, and the word is exact: not "we will remember", but "the
    // application refuses". A first production start without either variable
    // throws before the transaction that creates the organization, so the
    // outcome these fields existed to prevent — an installation that quietly
    // stamps itself `unstamped`, or mints a UUID no baseline can be written
    // against, and says nothing until somebody asks for the first month's
    // figures — is no longer reachable.
    //
    // They were UNKNOWN while the only protection was somebody reading the
    // template. That was the right answer then. What changed is the mechanism,
    // not the confidence.
    //
    // The residual — whether the VALUE in the server's file is the right one —
    // is an install-time check, not a build-time fact. pcc-verify-deployment
    // answers it on the machine, and the deployment gate reports it as
    // "not checkable from here" rather than pretending otherwise.
    environment: verified('production',
      'application:bootstrap.ts refuses a first production start without PCC_ENVIRONMENT — scripts/eval-evidence-provenance.mjs'),
    org_id_declared: verified(true,
      'application:bootstrap.ts refuses a first production start without PCC_ORG_ID — scripts/eval-evidence-provenance.mjs'),
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
