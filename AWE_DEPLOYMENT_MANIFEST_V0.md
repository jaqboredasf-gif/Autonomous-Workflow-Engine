# AWE deployment manifest — v0

**Status: a proposal with one implementation behind it.** Every field below exists because PCC
needed it. Nothing has been invented for a customer AWE does not have.

**Nothing consumes this manifest yet, and nothing should be built to consume it until a second
deployment exists.** Its value today is as a *checklist with a schema*: it makes the set of
decisions explicit and reviewable, and it is the natural input if generation is ever worth
building.

**No secrets.** Secret-bearing fields hold a *reference* — where the value lives — never the value.

---

## Field markers

| Marker | Meaning |
|---|---|
| **required** | Deployment cannot proceed without it |
| **optional** | Has a working default, or is genuinely not always needed |
| **derived** | AWE computes it from the application; not asked of the customer |
| **secret-ref** | Names where a secret lives. **Never the secret.** |

---

## The manifest

```yaml
# =========================================================================
# AWE deployment manifest v0
# One file per (organization, application) deployment.
# =========================================================================

manifest_version: 0                      # required

organization:
  id: lippolis                           # required  — slug; namespaces everything
  name: Lippolis Electric, Inc.          # required  — prints on customer-facing output
  deployment_owner: jose                 # required  — installs and maintains
  restart_owner: jose                    # required  — acts when it stops at 7am

application:
  id: pcc                                # required
  name: Purchasing Control Center        # required
  repository: <git url>                  # required
  version: <tag or commit>               # required  — what is actually deployed
  runtime: node                          # derived   — from the application
  runtime_min_version: "24"              # derived   — HARD; node:sqlite is in the runtime
  build:                                 # derived
    install: npm ci --workspaces --include-workspace-root
    build: npm run build --workspace purchasing
    artifact: apps/purchasing/.next/standalone
    # A build is not finished when the build tool exits. Whatever completes the
    # artifact must run here, or deployment paths diverge.
    finalize: node scripts/stage-standalone.mjs
    provenance_check: node scripts/check-deployable.mjs
  start: node apps/purchasing/server.js  # derived
  port: 3000                             # optional  — default
  bind: 0.0.0.0                          # optional  — default

hosting:
  environment: on-prem-vm                # required  — on-prem-vm|customer-cloud|managed|awe-hosted
  os: linux                              # required  — decides the service mechanism
  os_version: <distro + version>         # required
  admin_access: true                     # required  — needed to install a service
  container_runtime: docker              # optional  — docker|podman|none
  install_path: /opt/pcc                 # optional  — AWE default policy
  cpu: 2                                 # derived   — from architecture, not availability
  memory_gb: 2                           # derived
  disk_gb: 20                            # derived   — driven by attachments + full-copy backups

storage:
  data_path: /var/lib/pcc                # required  — the ONLY thing not disposable
  filesystem: local                      # required  — local|network. network is a hazard
                                         #             for embedded stores
  backed_up_by_customer: true            # required  — is this volume already in scope?
  # Enforced by the application, not by the runbook: it refuses a relative path,
  # a missing directory, a path inside a git working tree, and creating a new
  # database without one-time authorization.
  enforced_by_app: true                  # derived

network:
  hostname: pcc.lippolis.local           # required  — becomes APP_BASE_URL
  dns_controlled_by: customer            # required
  exposure: internal                     # required  — internal|vpn|public
  reverse_proxy: nginx                   # required  — the app terminates nothing
  tls:
    owner: customer                      # required  — customer|awe|none
    # Session cookies are Secure. Without TLS, sign-in does not persist.
    required_for_sessions: true          # derived

database:
  engine: sqlite                         # required  — sqlite|postgres
  location: /var/lib/pcc/pcc.sqlite      # required
  migrations:
    mode: on-startup                     # derived   — no separate migrate step exists
    idempotent: true                     # derived
  bootstrap:
    mode: env-admin                      # optional  — env-admin|sso-mapping|none
    admin_email_var: PCC_BOOTSTRAP_ADMIN_EMAIL
    admin_password: secret-ref:first-start-only   # secret-ref
  backup:
    command: node scripts/pcc-backup.mjs # derived
    verifies_output: true                # derived   — reads back what it wrote
    destination: /var/lib/pcc/backups    # required
    schedule: nightly                    # optional  — AWE default policy
    retention_days: 30                   # optional
    offsite_owner: customer              # required

service:
  manager: systemd                       # required  — systemd|docker-compose|windows-service
  unit: deploy/pcc-node.service          # optional  — shipped, not generated
  restart_policy: on-failure             # optional  — AWE default policy
  # A supervisor that loops on a deliberate config refusal buries the one line
  # explaining it.
  restart_prevent_exit_status: [1]       # optional
  enabled_at_boot: true                  # required

auth:
  mode: local                            # required  — local|sso
  provider: null                         # optional  — entra|google|okta
  # Authentication is replaceable; authorization is the application's own.
  authorization_owner: application       # derived

integrations:
  email:
    mode: draft-only                     # required  — draft-only|smtp|graph|none
    # PCC cannot send: enforced by a database CHECK constraint, because it is a
    # business rule, not a missing feature.
    enforced_in_schema: true             # derived
  outbound_network_required: false       # derived   — a real strength; preserve it

config:
  # Names and owners only. Values live in the secret store.
  required_vars:                         # derived — fatal in production if absent
    - NODE_ENV
    - SESSION_SECRET                     # secret-ref
    - PCC_DATABASE_PATH
    - APP_BASE_URL
  secret_store: /etc/pcc.env             # required — mode 640, root:<service user>
  template: .env.example                 # derived  — committed, holds no values

operations:
  health:
    readiness: /api/health                # derived — config, database, migrations
    liveness: /api/health/live            # derived — restart supervision points here
  logging:
    format: json-stdout                   # derived
    collector: journald                   # optional — journald|docker|file
    redaction: by-field-name              # derived
  preflight: node scripts/pcc-preflight.mjs        # derived — read-only
  verify: node scripts/pcc-verify-production.mjs   # derived — row-level content
  rollback:
    application: redeploy-previous-artifact         # derived
    database: restore-backup-if-schema-changed      # derived
    # Migrations move forward only.
    forward_only_migrations: true                   # derived

lifecycle:
  state: HANDED_OFF                       # see AWE_DEPLOYMENT_MODEL / lifecycle §7
  evidence_log: PCC_PRODUCTION_READINESS.md
```

---

## What the shape teaches

**`derived` is the largest category.** Roughly two thirds of the manifest comes from the
application, not the customer. That is the argument for a manifest at all: it makes visible how
few decisions genuinely belong to the organization, and stops those few from being buried in prose.

**`required` clusters in four places** — hosting, storage, network, and who owns it. Those are
exactly the blocking questions in the discovery contract. The two documents agree, which is a weak
but real signal that the boundary is in the right place.

**Secrets appear three times and are never values.** `SESSION_SECRET`, the bootstrap admin
password, and the secret store path. Each is a reference.

**Deliberately absent:** CI/CD, orchestration, replicas, autoscaling, service mesh, log shipping,
metrics backends. PCC needs none of them, and inventing fields for a customer AWE does not have is
how a manifest becomes a form nobody fills in honestly.

## Known gaps

- **Windows** is representable (`os: windows`, `manager: windows-service`) but unproven — no
  Windows deployment has been performed.
- **Multi-instance** is not representable, and should not be until an application needs it. A
  single-writer embedded store makes it meaningless here.
- **`postgres` as `database.engine`** is representable and the code path exists, but has never been
  deployed to a customer.
- **Nothing validates this file.** A schema and a `manifest → preflight` check are the obvious
  first consumers *if* a second deployment justifies them.
