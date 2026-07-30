# Microsoft 365 / Entra configuration required from IT

Everything an administrator must create before AWE can touch the tenant. Nothing
here is optional, and nothing here can be self-served by the development account:
each item needs Global Administrator or Application Administrator rights.

Hand this document to IT as-is. The code is already written and tested against a
deterministic fake (`bash scripts/eval-m365.sh`); the items below are the only
things standing between that and a live proof.

## 1. App registration (Microsoft Entra ID)

| Setting | Value | Notes |
|---|---|---|
| Name | `AWE Integration Plane (development)` | one registration per environment; do not share with production |
| Supported account types | **Single tenant** (this organization only) | multi-tenant is never appropriate here |
| Redirect URI | none | app-only; there is no interactive sign-in |
| Client credential | client secret (24 months) **or** certificate | certificate preferred; secret is acceptable for the development slice |

What AWE needs back: **Directory (tenant) ID**, **Application (client) ID**, and
the **secret value** (shown once). The secret goes into the environment only —
never into Git, never into a ticket, never into a chat message. AWE stores no
credential in the database (migration 0016 has no credential column, only a
sha256 of the subscription `clientState`).

## 2. Microsoft Graph **application** permissions + admin consent

Grant exactly these, and nothing else:

| Permission | Type | Why AWE needs it | Capability |
|---|---|---|---|
| `User.ReadBasic.All` | Application | resolve a principal to a stable directory id for the audit trail | `m365.identity.resolve` |
| `Mail.Read` | Application | read one message and its attachments in the authorized mailbox | `m365.mail.message.read`, `m365.mail.attachment.read` |
| `Mail.ReadWrite` | Application | create an **unsent draft** in the authorized mailbox | `m365.mail.draft.create` |
| `ChannelMessage.Send` | Application | post notifications / approval requests to one development channel | `m365.teams.notification.create`, `m365.teams.approval.request` |
| `Sites.Selected` | Application | write to the specific SharePoint sites an admin grants, and no others | `m365.document.store` |

**Admin consent must be granted** for each (the "Grant admin consent for
<tenant>" button). Application permissions do nothing until consented.

### Permissions AWE must NOT be granted

These are refused in code (`packages/m365/src/scopes.ts` — the configuration
audit fails if any is present in the granted set), so requesting them will break
the integration rather than enable anything:

`Mail.Send` · `Mail.Read.All` · `Mail.ReadWrite.All` · `Sites.ReadWrite.All` ·
`Sites.FullControl.All` · `Files.ReadWrite.All` · `Directory.Read.All` ·
`Directory.ReadWrite.All` · `ChannelMessage.Read.All` · `Chat.ReadWrite.All` ·
`User.ReadWrite.All`

`Mail.Send` in particular is not an oversight: this integration has no capability
to send mail at any version, and a granted `Mail.Send` would be authority nobody
asked for.

## 3. Mailbox scoping — ApplicationAccessPolicy (mandatory)

`Mail.Read` and `Mail.ReadWrite` as *application* permissions are tenant-wide by
default: they would let the app read every mailbox in the organization. That is
unacceptable and AWE will not be operated that way. IT must restrict the app to
a mail-enabled security group containing **only the authorized development
mailbox**:

```powershell
# Exchange Online PowerShell, as an Exchange Administrator
New-DistributionGroup -Name "AWE-Authorized-Mailboxes" -Type Security `
  -Members "dev-intake@<tenant>.onmicrosoft.com"

New-ApplicationAccessPolicy `
  -AppId <APPLICATION_CLIENT_ID> `
  -PolicyScopeGroupId "AWE-Authorized-Mailboxes@<tenant>.onmicrosoft.com" `
  -AccessRight RestrictAccess `
  -Description "AWE Integration Plane: development intake mailbox only"

# Verify — this must return AccessCheckResult: Granted for the dev mailbox
Test-ApplicationAccessPolicy -Identity "dev-intake@<tenant>.onmicrosoft.com" -AppId <APPLICATION_CLIENT_ID>
# ...and Denied for anyone else
Test-ApplicationAccessPolicy -Identity "<any other user>" -AppId <APPLICATION_CLIENT_ID>
```

AWE's own allowlist enforces the same restriction independently, so both sides
have to agree before a mailbox is reachable. Belt and braces on purpose: an
allowlist edit alone cannot widen Microsoft-side access, and an
ApplicationAccessPolicy change alone cannot widen AWE-side access.

## 4. Resources to create (development only)

| Resource | What to create | What AWE needs back |
|---|---|---|
| Mailbox | a dedicated **shared mailbox** `dev-intake@<tenant>.onmicrosoft.com` — never a person's inbox | the UPN |
| Teams channel | a private channel in a development team, e.g. `AWE Development / Notifications` | team id + channel id |
| SharePoint site | a development site with one document library, e.g. `AWE Development / Documents` | site id + drive id, plus a `Sites.Selected` grant for the app on that site |

The `Sites.Selected` grant is a separate step from consent — an admin grants the
app `read`/`write` on the specific site:

```
POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions
{ "roles": ["write"],
  "grantedToIdentities": [{ "application": { "id": "<APPLICATION_CLIENT_ID>", "displayName": "AWE Integration Plane" } }] }
```

## 5. Webhook endpoint for change notifications

Microsoft Graph pushes change notifications to a **public HTTPS** endpoint and
validates it before creating the subscription:

- The URL must be publicly reachable (no VPN, no basic auth) and serve a valid
  TLS certificate.
- On subscription creation Graph POSTs a `validationToken` query parameter; the
  endpoint must echo it back as `text/plain` within **10 seconds**.
- Every notification must be acknowledged with `2xx` quickly; Graph retries
  otherwise, which is why processing is idempotent on the AWE side.
- Mail subscriptions expire after ~3 days (4230 minutes) and must be renewed
  before expiry.

AWE has no such endpoint today. See BLOCKED_LIVE_PROOF item 4.

## 6. Environment variables (never committed)

```
M365_TENANT_ID=<directory (tenant) id>
M365_CLIENT_ID=<application (client) id>
M365_CLIENT_SECRET=<secret value>          # or a certificate assertion
M365_ALLOWLIST_PATH=<path to the live allowlist config, same shape as fixtures/m365/allowlist.json>

# The live smoke test additionally requires an explicit opt-in:
M365_LIVE_SMOKE=1
M365_SMOKE_MAILBOX=dev-intake@<tenant>.onmicrosoft.com
M365_SMOKE_MESSAGE_ID=<a Graph message id in that mailbox>

# Draft creation during the smoke test is a second opt-in and needs a recorded decision:
M365_LIVE_ALLOW_DRAFT=1
M365_LIVE_APPROVAL_ID=<approval reference>
M365_LIVE_APPROVER_ID=<the human who approved>
```

`.env*` is gitignored except `.env.example`. The repo contains no secret and no
real tenant identifier; every fixture address is in the RFC 6761 `.invalid` TLD.

## 7. Verification, once IT has finished

```bash
bash scripts/eval-m365.sh          # offline plane, must stay green
bash scripts/m365-live-smoke.sh    # reads ONE message; prints BLOCKED_LIVE_PROOF if anything is missing
```

The smoke test is read-only unless `M365_LIVE_ALLOW_DRAFT=1`, and even then can
only produce an unsent draft in the configured development mailbox.

## 8. What IT is NOT being asked for

- No tenant-wide mailbox access (the ApplicationAccessPolicy prevents it).
- No permission to send mail.
- No access to any production mailbox, site or channel.
- No delegated/user sign-in flow, so no user consent prompts.
- No changes to any existing mailbox, site or Teams channel.
