# Purchasing — hosted deployment runbook

**Status: the application is ready to host. Nothing here has been executed** — this
environment has no hosted Supabase project, no hosting-provider account and no
Supabase CLI, so every command below needs somebody with those credentials.
Everything that could be done without them has been (see §6).

Supersedes the previous version of this file, which was wrong in two ways worth
naming: it said migrations ended at `0017` (they end at **0034**) and that the
Supabase repositories "do not exist yet" (they do, and every offline suite runs
against them).

---

## 1. The stack, and why it is this small

| Piece | Choice | Why not something else |
|---|---|---|
| App | **Vercel** | It is a Next.js 16 app with server actions and server components. Vercel runs that with no adapter, no Dockerfile and no build configuration. A container on a VM would work and would mean owning TLS, restarts and deploys by hand. |
| Database + auth | **Supabase hosted** | Already the production provider: RLS policies, `auth.uid()`, and the migrations are Supabase-shaped. Moving to bare Postgres would mean replacing the auth adapter. |
| Files | **stays in the database** | `STORAGE_DRIVER=inline`. Supabase Storage is designed for (gap register §4) and not needed for a pilot's few megabytes. |
| TLS / domain | **Vercel's** | `*.vercel.app` is HTTPS out of the box. A custom domain is a later, cosmetic step. |

No Kubernetes, no containers, no queue, no CDN configuration. Two managed
services and an environment file.

## 2. Hosted Supabase — needs your account

```bash
# 1. Create the project (dashboard or CLI) and note its ref.
npx supabase login
npx supabase link --project-ref <PROJECT_REF>

# 2. What is already there? A brand-new project has nothing.
npx supabase migration list

# 3. Apply. Migrations are append-only and ordered; push applies 0001 … 0034.
npx supabase db push
```

**Verify before trusting it** — a partial apply is silent:

```sql
select max(version) from supabase_migrations.schema_migrations;   -- expect 0034
select count(*) from purchasing_role_permissions;                 -- expect > 0
select unnest(enum_range(null::purchasing_role));
-- REQUESTOR FOREMAN OFFICE ACCOUNTING WORKSHOP_APPROVER ADMIN
select prosrc like '%v_kind%' from pg_proc where proname = 'purchasing_may_receive';
-- t  — proves 0034 (the workshop-as-a-location rule) actually landed
```

**Then prove the security, do not assume it.** Both suites roll back and leave
nothing behind:

```bash
psql "$HOSTED_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/tenant_isolation.sql
psql "$HOSTED_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/membership_and_provisioning.sql
```

Both pass against local Postgres today, including the negative control (disable
RLS and the suite reports leaks). Until they have run against the hosted
project, tenant isolation there is **reviewed, not proven**.

## 3. Application — needs your account

```bash
npx vercel link
npx vercel --prod
```

Environment variables, set in the Vercel project (never in the repository):

| Variable | Value |
|---|---|
| `AUTH_PROVIDER` | `supabase` |
| `PURCHASING_PERSISTENCE` | `supabase` |
| `NEXT_PUBLIC_SUPABASE_URL` | the hosted project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the hosted anon key (public by design) |
| `SUPABASE_SERVICE_ROLE_KEY` | the hosted service-role key — **secret**, server only |
| `SESSION_SECRET` | `openssl rand -base64 48`. Changing it signs everyone out. |
| `APP_BASE_URL` | `https://<your-deployment>` |
| `AUTH_REDIRECT_URL` | `https://<your-deployment>/reset-password`, and add it to Supabase's redirect allow-list |
| `STORAGE_DRIVER` | `inline` |
| `PURCHASING_DEMO_MODE` | `0` — `validateEnvironment()` refuses `1` in production |

`/api/health` reports on all of this. Open it first: it names a misconfiguration
instead of failing at somebody's first sign-in.

## 4. People — the supported mechanism

`scripts/provision-local-tenants.mjs` is a **fixture script and refuses to run
against anything but 127.0.0.1**, deliberately. Do not point it at the hosted
project.

Real users are created through the product: sign in as an administrator →
**/admin → Invite someone** → name, company email, roles, a temporary password
of 10+ characters, handed over in person. There is no invitation email yet (gap
register, Phase 4).

Who to create, and nothing wider:

| Person | Preset | Notes |
|---|---|---|
| Mike | `PURCHASING_MANAGER` | Workshop role + approval authority. No job assignment needed — shop-counter roles are unscoped for receiving. |
| A foreman | `FIELD_FOREMAN` | Assign their job numbers, and `WORKSHOP` if they also sign at the counter. |
| Office staff | `OFFICE_COORDINATOR` | Sees everything, cannot approve. Use `APPROVER` only if they should. |
| You | `ORGANIZATION_ADMIN` | |

The first administrator is the bootstrap problem: create that one user in the
Supabase dashboard, then insert the matching `users` and `purchasing_user_roles`
rows, and do everything else through the screens.

## 5. After it is up — the smoke test that matters

```bash
ACCEPTANCE_BASE_URL=https://<your-deployment> PILOT_PASSWORD=<temporary> \
  node scripts/eval-pcc-operability.mjs
```

84 checks, driving the real workflow as a purchaser and as a worker: every route
answers, a worker raises a request without meeting a purchasing status, the
purchaser goes from queue to printed PO, and repeated wrong passwords are
refused. It needs a running server and nothing else, so it works against a
hosted URL exactly as it does locally.

## 6. What is already done, and needs nothing from you

- **Sign-in throttling is live** (§7). It was the one thing that genuinely had
  to change before this application faced the internet.
- Session cookies are already `httpOnly`, `SameSite=Lax`, and `Secure` whenever
  `NODE_ENV=production`. Supabase's access and refresh tokens ride in their own
  httpOnly cookies and are never rendered or returned in a body.
- `validateEnvironment()` refuses demo mode in production and refuses Supabase
  persistence without Supabase auth.
- The migrations replay from an empty database; `npm test -w purchasing` and the
  live SQL suites pass against local Postgres.

## 7. Sign-in throttling

Five failed attempts against one address in fifteen minutes locks that address
for fifteen minutes; thirty from one source address does the same to the source.
The lock measures from the newest failure, so guessing while locked extends it.
A success clears the address's count and deliberately **not** the source's — one
correct password among fifty wrong ones is what a successful spray looks like.

The rule is pure (`domain/throttle.mjs`, 20 checks); the memory is a Map in the
server process (`server/sign-in-throttle.ts`).

**The honest limitation:** counters are per instance. On Vercel that means per
serverless instance, so the effective limit multiplies by however many are warm.
That still turns unlimited guessing into a handful of guesses per instance per
fifteen minutes, which is the difference that matters for a weak password — but
it is not a strict global limit, and a shared store (a Postgres table, or the
platform's KV) is what would make it one. The interface is one file; nothing
above it would change.

## 8. Rollback

Vercel keeps every deployment: promote the previous one. Migrations do not roll
back — they are append-only by design, and a correction is a new migration.
Nothing in `0001`–`0034` drops a column or rewrites a row.
