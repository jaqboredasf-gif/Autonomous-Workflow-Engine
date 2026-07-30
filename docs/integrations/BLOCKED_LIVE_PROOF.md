# BLOCKED_LIVE_PROOF — Microsoft 365 Integration Plane (Task I1)

**Status: architecture complete and verified against a deterministic fake. Live
proof BLOCKED. Zero live Microsoft calls have been made from this repository.**

Nothing in this slice fabricates a Graph result. Both gateways report their
fidelity as a literal (`'synthetic'` / `'live'`), the live gateway throws
`BlockedLiveProofError` unless every prerequisite is present, and the executor
records outcome `blocked_live_proof` with failure reason `live_access_blocked`
rather than inventing a response. Runner 6 asserts all three.

Generated evidence of the blockage: `bash scripts/m365-live-smoke.sh` exits 2 and
prints the missing prerequisites (nothing is attempted).

## Missing prerequisites, exactly

| # | Prerequisite | Who provides it | Blocks |
|---|---|---|---|
| 1 | Entra app registration (single tenant) — Directory (tenant) ID, Application (client) ID, client secret or certificate | IT / Global or Application Administrator | everything |
| 2 | Admin consent for the five application permissions: `User.ReadBasic.All`, `Mail.Read`, `Mail.ReadWrite`, `ChannelMessage.Send`, `Sites.Selected` | IT / Global Administrator | everything |
| 3 | `New-ApplicationAccessPolicy` restricting the app to a security group containing only the development mailbox | IT / Exchange Administrator | all mail capabilities (and required before any consent is safe to use) |
| 4 | A public HTTPS webhook endpoint that echoes Graph's `validationToken` within 10s and returns 2xx per notification | AWE hosting (not yet built — no deployed HTTP surface exists in this repo) | live change notifications; live subscription creation |
| 5 | A dedicated development **shared mailbox** (`dev-intake@<tenant>.onmicrosoft.com`) and its UPN | IT | mail read, attachment read, draft create |
| 6 | A development Teams team + channel, and their ids | IT | Teams notification, Teams approval request |
| 7 | A development SharePoint site + document library, their site/drive ids, and a `Sites.Selected` permission grant on that site | IT | document store |
| 8 | The environment variables in docs/integrations/M365_ENTRA_CONFIGURATION.md §6, populated outside Git | operator | the live smoke test |
| 9 | A live allowlist config file (same shape as `fixtures/m365/allowlist.json`) naming the real ids from 5–7 | operator, reviewed | the live smoke test |
| 10 | Migration `0016_m365_integration_plane.sql` applied to the Supabase project | human approval (AGENTS.md) | persistence of subscriptions, notifications, executions and evidence |

Items 1–3 are the same blockers recorded in `docs/planning/INTEGRATIONS.md` since
the project began. The company now has an operational Microsoft 365 tenant and a
company Microsoft account, which unblocks *requesting* them — none of them has
been performed, and no credential is present in this environment.

## What was proved without them

Verified deterministically (`bash scripts/eval-m365.sh`, 1593+ assertions, 22
fixtures, two identical full runs):

- the complete controlled execution path, notification → evidence;
- every one of the 19 denial reasons and 6 failure reasons;
- cross-tenant refusal in both directions;
- unauthorized resource and unauthorized-capability-on-authorized-resource refusal;
- duplicate delivery creating no second execution, draft, Teams post or email row;
- expired and revoked subscriptions refused before any retrieval;
- missing, pending, rejected, expired and service-principal approvals all refused;
- bounded retry: recovery after throttling, and clean failure at exhaustion;
- partial failure: message read, attachment bytes lost, ContextItem records it;
- hash-chained evidence for every attempted side effect, tamper detected;
- no send path anywhere in the package (source-scanned), no send capability, no
  send route in the fake, transmit paths refused by the live transport;
- vocabulary parity between the engine and migration 0016.

## What cannot be claimed

- That the Entra app registration, consent or ApplicationAccessPolicy work as
  documented — they do not exist yet.
- That a real Graph message, attachment, Teams post, draft or SharePoint upload
  round-trips. The fake implements the routes the catalog uses; real Graph will
  differ in details (throttling behaviour, attachment `$select` support on some
  attachment types, immutable id formats, channel message shape).
- That the webhook validation handshake works end to end — no endpoint exists.
- That migration 0016 applies cleanly. It has been structurally linted offline
  (51 checks) but never executed against Postgres.

## Next action

Send `docs/integrations/M365_ENTRA_CONFIGURATION.md` to IT unchanged. When items
1–3 and 5–7 land, populate item 8, write item 9, and run:

```bash
bash scripts/eval-m365.sh          # must stay green
bash scripts/m365-live-smoke.sh    # read-only live proof
```

Then, separately and with explicit approval, apply migration 0016.
