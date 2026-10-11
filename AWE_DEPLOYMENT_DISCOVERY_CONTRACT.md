# AWE deployment discovery contract

**Purpose.** The smallest set of answers that materially change how an AWE application is
deployed. Ask these once, early, and a deployment stops stalling on questions nobody thought to ask.

**Not an enterprise questionnaire.** Every field below changed a real decision during the PCC
deployment, or would have prevented a real delay. If a question does not change the architecture,
it is not here.

**The rule that makes this useful:** questions are split by whether they **block installation** or
**can be answered during the pilot**. An undifferentiated list of twenty questions stalls a
deployment on items that could have waited. At Lippolis, ten questions, seven blocking.

---

## A. What AWE determines for itself — do not ask

These come from the application, not the customer. Asking wastes the customer's attention on
things they cannot usefully answer.

| Determined | From |
|---|---|
| Runtime and minimum version | The application's own dependencies |
| Build commands and artifact shape | The repository |
| CPU / RAM guidance | The architecture — e.g. a single-writer store means extra cores buy nothing |
| Disk *growth shape* | Whether attachments and backups share the data volume |
| Migration mechanism and whether a separate step exists | The application |
| Health endpoint paths and their meaning | The application |
| Required environment variables and which are fatal | The config module |
| What must be backed up | The persistence model |
| Whether outbound network access is needed at runtime | The application |
| Default port, default paths, restart policy | AWE default policy |

**State these to the customer as facts.** They are not negotiable inputs, and presenting them as
questions invites answers that cannot be honoured.

---

## B. Blocking — installation cannot start without these

| # | Field | Why it blocks | PCC's answer |
|---|---|---|---|
| B1 | **Hosting environment** — on-prem VM, customer cloud, managed platform, or AWE-hosted | Decides packaging, supervision and whether local disk exists at all | On-prem VM |
| B2 | **Operating system and version** | Decides the service mechanism. Linux and Windows are different deliverables | Linux (assumed; not formally confirmed before units were written) |
| B3 | **Node ≥24 permitted on the host** | Hard requirement while the store is `node:sqlite`. A locked host cannot run it | Yes |
| B4 | **Root / administrator access** | Installing a service and creating a data directory need it. Managed hosts may forbid it | Yes |
| B5 | **Persistent storage path**, and whether it is on backed-up storage | The one thing that is not disposable. Must be a real local filesystem — network mounts are a known SQLite hazard | `/var/lib/pcc` |
| B6 | **Hostname / subdomain**, and who controls DNS | Sets `APP_BASE_URL`; without it, links point at nothing | Customer-chosen, still pending |
| B7 | **Who terminates TLS and issues the certificate** | The app terminates nothing. Cookies are `Secure`, so no TLS means sign-in does not persist | Customer reverse proxy |
| B8 | **Network exposure** — internal only, VPN, or public | Changes TLS, session policy, MFA expectations and firewall | Internal only |
| B9 | **Inbound firewall**: may the proxy reach the app port? | One rule, but it must exist | Yes |
| B10 | **Deployment owner / IT contact**, and **who restarts it** | The question asked least and mattering most. Without a named person there is no operational owner | Jose |

## C. Non-blocking — needed before go-live, not before install

| # | Field | Why it can wait |
|---|---|---|
| C1 | **Identity model** — local accounts or existing SSO | Local accounts work on day one; SSO is an adapter behind an existing boundary |
| C2 | **Email/integration requirements** — does the app need to *send*? | PCC deliberately cannot. A customer needing sending gets an adapter, not a redesign |
| C3 | **Backup platform, schedule, retention, offsite target** | We ship a verified backup command immediately; the customer's platform can attach later |
| C4 | **Monitoring** that can poll a URL | Restart-on-failure covers the gap meanwhile |
| C5 | **Outbound network policy** | PCC needs none at runtime; matters only for build-on-server |
| C6 | **Allowed deployment windows** | Matters at the second release, not the first install |
| C7 | **Recovery expectations** — RPO/RTO in plain words | Shapes backup cadence, not architecture |
| C8 | **Data residency / retention constraints** | Usually satisfied by on-prem; ask before assuming |
| C9 | **Database preference or restrictions** | Only if the customer's policy forbids an embedded store or mandates a company DB server |
| C10 | **Who the users are, and where** — offices, external parties | Changes exposure and session policy; discovered during the pilot |

---

## D. The two questions that are not on most checklists

Both were learned at Lippolis and both are cheap to ask.

1. **"Who restarts it at 7am?"** — the operational owner. A deployment with no named person is a
   deployment that ends up owned by whoever built it.
2. **"What does this replace, and does it stay available?"** — the fallback. Every first deployment
   replaces something that already works. Keeping it is free insurance, and any state shared
   between the two (identifiers, sequences, numbering) must be reconciled on the way back. At
   Lippolis that shared state was the purchase-order number, and it could not be discovered late.

---

## E. Intake form

```yaml
organization:
  id:                     # short slug, e.g. lippolis
  name:
  deployment_owner:       # name + contact — REQUIRED, blocking
  restart_owner:          # who acts at 7am (may be the same person)

hosting:                  # BLOCKING
  environment:            # on-prem-vm | customer-cloud | managed-platform | awe-hosted
  os:                     # linux | windows
  os_version:
  runtime_permitted:      # can the required runtime version be installed?  yes | no | unknown
  admin_access:           # root/administrator available?  yes | no
  container_runtime:      # docker | podman | none | unknown

storage:                  # BLOCKING
  data_path:              # absolute path on a real local filesystem
  is_backed_up:           # is this volume already in the customer's backup scope?
  filesystem:             # local | network   (network is a hazard for embedded stores)

network:                  # BLOCKING
  hostname:               # internal FQDN
  dns_controlled_by:
  exposure:               # internal | vpn | public
  tls_owner:              # customer-proxy | awe | none-yet
  reverse_proxy:          # nginx | caddy | iis | none | unknown
  inbound_rule_possible:  # may the proxy reach the app port?

identity:                 # NON-BLOCKING
  mode:                   # local | sso
  provider:               # entra | google | okta | n/a
  external_users:         # yes | no

operations:               # NON-BLOCKING
  backup_platform:
  backup_schedule:
  offsite_target:
  monitoring:             # tool that can poll a URL, or none
  deployment_windows:
  recovery_expectation:   # plain words: "a day's work" / "nothing"

constraints:              # NON-BLOCKING
  outbound_network:       # open | restricted | none
  data_residency:
  retention_policy:
  database_restrictions:

context:                  # the two questions from §D
  replaces:               # what process/system this displaces
  fallback_retained:      # yes | no
  shared_state:           # identifiers shared with the fallback that must not collide
```

---

## F. How to use it

1. Send **§B only** to the IT contact. Ten questions, all blocking, all answerable in one sitting.
2. Fill **§A yourself** and send it as a statement of what the application needs — not a question.
3. Ask **§C** during the pilot, as each becomes relevant.
4. Record **§D** in writing. Both answers shape the go-live plan more than any technical field.

**What PCC would have gained.** B2 (OS) was never formally confirmed, so two systemd units were
written and a Windows path was left unwritten — reasonable insurance, but the answer would have
halved the work. B6 (hostname) is *still* outstanding and is now the last thing standing between
the repository and a live deployment.
