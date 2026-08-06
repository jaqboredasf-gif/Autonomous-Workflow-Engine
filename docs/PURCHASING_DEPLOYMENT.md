# Purchasing — deployment

Nothing here has been executed. This environment has no Supabase project, CLI, Docker or
credentials, so every command below is written to be run by someone who has them, and the
result is unverified until they do. See `PURCHASING_PRODUCTION_GAPS.md` §1.

**Read this first:** shared multi-user deployment needs the Supabase repositories, which do not
exist yet. The async boundary they plug into now does (`PURCHASING_ASYNC_REFACTOR_HANDOFF.md`),
so writing them no longer requires changing the application. What you can deploy today is the
*local-provider* application — one server, one file-backed database. That is a demonstration
host, not a shared system of record.

---

## 1. Local, right now

```bash
npm install
npm run dev -w purchasing        # http://localhost:3000
```

Demo accounts and the walkthrough are in `apps/purchasing/README.md`. Password: `Purchasing!2026`.

Verification:

```bash
npm run test -w purchasing       # typecheck + 165 unit + 158 integration + 88 web
npm run build -w purchasing
```

## 2. Supabase project

```bash
# with the Supabase CLI installed and logged in
supabase link --project-ref <PROJECT_REF>
supabase db push                 # applies 0001 … 0017
```

Confirm afterwards, because a partial apply is silent:

```sql
select id from supabase_migrations.schema_migrations order by id;
-- expect 0001 … 0017
select unnest(enum_range(null::purchasing_role));
-- expect REQUESTOR FOREMAN OFFICE ACCOUNTING WORKSHOP_APPROVER ADMIN
select count(*) from purchasing_role_permissions;
```

Offline parity check (runs here, proves the SQL and the app agree — not that the SQL runs):

```bash
node scripts/lib/validate-migration-0016.mjs
```

## 3. Environment

Copy `apps/purchasing/.env.example` to the host's secret store. Required for production:

| Variable | Why |
| --- | --- |
| `SESSION_SECRET` | signs the session cookie; 32+ random chars (`openssl rand -base64 48`). Changing it signs everyone out. |
| `APP_BASE_URL` | absolute URL; used in reset links |
| `AUTH_PROVIDER=supabase` | selects Supabase Auth over the local credential store |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public by design |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret.** Invite, disable, force-reset only. Never sent to a browser. |
| `AUTH_REDIRECT_URL` | must be on Supabase's allow-list |
| `STORAGE_DRIVER=supabase`, `STORAGE_BUCKET` | once storage is implemented (not yet) |
| `NODE_ENV=production` | refuses demo mode, requires a real session secret |

`PURCHASING_DEMO_MODE` must be unset or `0`. `validateEnvironment()` refuses it in production
and `/api/health` reports the refusal.

## 4. Storage (not implemented)

Attachments are currently stored inline in the pilot database. When implemented: a private
bucket, no public access, tenant-prefixed paths (`<org>/<entity>/<id>/<generated-name>`), signed
URLs on read, type and size validation on write.

## 5. Build and run

Node 24+ (the pilot store uses `node:sqlite`).

```bash
npm ci
npm run build -w purchasing
npm run start -w purchasing -- --port 3000
```

Behind TLS on a private hostname. Point the platform's health check at `/api/health`, which
returns 200 `ok` or 503 `degraded` and reveals no configuration values.

## 6. First administrator

There is no self-service signup, by design. On the local provider the seed creates the demo
cast; on Supabase, bootstrap once:

```sql
-- 1. create the auth user (Supabase dashboard, or admin.createUser via the service role)
-- 2. bind it to an application user and give it the ADMIN role
insert into users (id, org_id, full_name, email, is_active, auth_user_id)
values (gen_random_uuid(), '<ORG_ID>', 'First Administrator', 'admin@<company-domain>', true, '<AUTH_USER_ID>')
returning id;

insert into purchasing_user_roles (user_id, role) values ('<USER_ID>', 'ADMIN');
```

Then invite everyone else through `/admin` and disable the demo accounts.

## 7. Backup and restore

- **Supabase**: enable point-in-time recovery; take a manual snapshot before each migration.
- **Local provider**: the database is one file (`apps/purchasing/.data/purchasing.db`) plus its
  WAL. Copy with the server stopped, or `sqlite3 purchasing.db ".backup out.db"` while running.
  Attachments and PO PDFs live inside it, so the file is the whole record.

Restore is the reverse; there is no partial restore of purchasing data alone, because a receipt
without its request is not evidence of anything.

## 8. Rollback

1. Keep the previous build artifact; redeploy it.
2. Migrations 0016/0017 are additive — a rollback of the application does not require a
   database rollback, and rolling *back* a migration that has issued PO numbers is refused by
   design (the sequence only moves forward).
3. If a migration must be reversed, restore from the pre-migration snapshot instead.

## 9. Operational logging

Structured JSON on stdout (`src/purchasing/infrastructure/logging.ts`), redacting passwords,
tokens, secrets and cookies, and masking email local parts. Sign-in successes and failures are
logged with the reason. Collect stdout; there is no log shipping in the app.
