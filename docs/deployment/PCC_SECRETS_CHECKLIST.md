# PCC — secrets required on installation day

**No secret value appears in this repository, and none should ever be added to it.** This page
says which secrets must exist, who creates each one, where PCC expects to find it, and what
happens if it changes. Fill nothing in here — it is a list of names, not a store.

PCC's Phase 1 deployment needs **two** secrets. That is the whole list, and it is short because
PCC makes no outbound calls: no email transport, no API integrations, no third-party services.

---

## 1. `SESSION_SECRET` — required, and PCC will not start without it

| | |
|---|---|
| **Purpose** | Signs the session cookie. It is what makes a signed-in browser's claim to be Mike verifiable, and it is the only thing standing between a forged cookie and an administrator session. |
| **Who creates it** | **Lippolis IT / infrastructure administrator**, at install time: `openssl rand -base64 48`. Generated on the server by whoever will hold it — a secret somebody else generated and sent is a secret that has been in a message. |
| **Who stores it** | **Lippolis IT**, in whatever secret store already exists. A root-owned `/etc/pcc.env` with mode `640` is acceptable for this pilot — say so and it gets documented that way. |
| **Where PCC expects it** | The `SESSION_SECRET` environment variable, supplied at runtime. Never baked into the image; the build fails if a `.env` reaches it. |
| **Can PCC start without it?** | **No.** In production the startup preflight refuses and exits non-zero, naming the variable. This is deliberate — the fallback would be a known development value, which is worse than not starting. |
| **Minimum** | 32 characters. PCC refuses shorter in production. |
| **Effect of rotation** | **Everybody is signed out immediately.** No data is affected, nothing is lost, and everyone signs in again with the passwords they already have. Rotating it is a mild inconvenience, not an incident. |
| **Effect of loss** | Nobody can sign in until a new one is set — which is a two-minute fix, because rotating it is safe. **Losing this secret does not lose data.** |
| **Effect of disclosure** | Serious. Anyone holding it can forge a session cookie for any user, including an administrator. Rotate immediately; that is the entire remedy. |

---

## 2. `PCC_BOOTSTRAP_ADMIN_PASSWORD` — required once, then deleted

| | |
|---|---|
| **Purpose** | The password for the single administrator account created on the very first start, so that somebody can sign in and invite the real users. |
| **Who creates it** | **Lippolis IT / infrastructure administrator**, at install time — a temporary value, 12+ characters. |
| **Who stores it** | Nobody, beyond the install. It is typed into `/etc/pcc.env` for one start, used, changed at first sign-in, and **removed from the environment**. |
| **Where PCC expects it** | The `PCC_BOOTSTRAP_ADMIN_PASSWORD` environment variable, alongside `PCC_BOOTSTRAP_ADMIN_EMAIL`. |
| **Can PCC start without it?** | **Yes** — and it will come up with **nobody able to sign in**, saying so loudly in the log. That is deliberate: an installation nobody can sign into is a phone call, whereas an installation anybody can sign into is a breach. |
| **Minimum** | 12 characters. PCC refuses to create the account with less and logs why. |
| **Effect of rotation** | None after the first start — the account's real password is set by the administrator when they sign in and change it. |
| **After installation** | **Remove it from `/etc/pcc.env` and restart.** It is on the installation record as its own line for this reason. |

---

## Not secrets, and often mistaken for them

| | Why it is not a secret |
|---|---|
| `PCC_DATABASE_PATH` | A filesystem path. Wrong values are dangerous, but knowing it grants nothing. |
| `APP_BASE_URL` | The address people type into a browser. |
| `PCC_ORG_NAME` / `_PHONE` / `_ADDRESS` | Printed on every purchase order that goes to a supplier. |
| Purchase order numbering | **Not configuration at all.** The number is `job-vendor-sequence` and each pair counts from 1 on its own. The only thing anybody sets is a pair the office already has paper POs for, in Administration → PO numbering. |

## Not needed in Phase 1

Named so nobody goes looking for them, and so the list above stays honestly short:

* **No email credentials.** PCC composes vendor emails as drafts and *cannot send* — a database
  CHECK constraint pins external sending off and `EmailDraftPort` has no `send` method. A person
  sends each one from their own mailbox. There is no SMTP configuration because there is nothing
  to configure.
* **No Supabase keys.** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
  `SUPABASE_SERVICE_ROLE_KEY` exist in the configuration for the Postgres path, which Phase 1 does
  not use. Leave them empty.
* **No Microsoft/Entra credentials.** SSO is not configured. If IT later wants it, that
  conversation starts with a tenant ID and an app registration — see
  `PCC_IT_INSTALLATION_PACKET.md` §8.
* **No API keys of any kind.** PCC makes no outbound network calls.

---

## On installation day

1. `openssl rand -base64 48` → `SESSION_SECRET`, into `/etc/pcc.env` (mode `640`, root-owned).
2. Choose a temporary bootstrap password, 12+ characters → `PCC_BOOTSTRAP_ADMIN_PASSWORD`.
3. Hand `SESSION_SECRET` to IT for their secret store.
4. First start. Sign in. **Change the administrator password.**
5. Remove `PCC_BOOTSTRAP_ADMIN_PASSWORD` and `PCC_DATABASE_ALLOW_CREATE` from `/etc/pcc.env`.
6. Restart, and confirm the log says `opening the existing purchasing database`.
7. Tick both lines on the installation record.

**Never** commit `/etc/pcc.env`, paste a secret into a ticket or a chat message, or write one into
the installation record. The record has a line for *whether* a secret was set, never for what it
is.
