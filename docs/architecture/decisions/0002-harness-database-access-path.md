# ADR-0002 — Harness runtime uses the service-role Supabase client (open question O1)

**Status:** Proposed (2026-07-27) — awaiting Jack's ratification.

## Context

The repository has two live DB access paths and they disagree about almost
everything:

**Path A — Supabase management query API** (`scripts/lib/db.mjs`, all acceptance
slices, all migration applies):
- endpoint `https://api.supabase.com/v1/projects/<ref>/database/query`, raw SQL in,
  JSON rows out;
- credential `SUPABASE_ACCESS_TOKEN` — an `sbp_` **management** token that can
  execute DDL, read every project secret surface, and administer the project;
- `db.mjs:9-11` hard-codes `PROJECT_REF = 'qgoiacwdntaqeghcyjlw'` and
  `ORG_ID = '2b219aa5-…'` as module constants;
- rate-limited per minute. This is not theoretical: `regression.sh` sleeps 45s
  after slice 4 to let the window drain, and `db.mjs:37-66` retries 429/5xx with
  exponential backoff up to 30s because "a 429 here is a harness throttle, NOT a
  test result";
- SQL is assembled by string interpolation through `lit()`/`jsonb()`/`textArray()`
  escape helpers;
- **the token is scheduled for revocation** — SECURITY_FINDINGS § Standing
  security debt: "Revoke the `sbp_` management token when the setup phase ends."

**Path B — service-role `supabase-js` client** (`packages/mcp-server/src/index.js`):
- PostgREST over HTTPS, parameterized query builder, no SQL string assembly;
- credential `SUPABASE_SERVICE_ROLE_KEY` — full data-plane access, **bypasses RLS**,
  but cannot execute DDL or administer the project;
- `@supabase/supabase-js` is already a dependency; `.mcp.json` already wires the
  env;
- no per-minute management rate limit (subject to ordinary project API limits);
- tenant binding is currently **wrong** there: `index.js:396` does
  `from('orgs').select('id').limit(1).single()` — "whichever org comes first" is a
  single-tenant assumption, not a binding.

**Path C — direct PostgreSQL connection** (`pg` driver): not currently possible.
CONTEXT.md states no DB password is available in this environment, no `psql`, no
Supabase CLI, no Docker. It is also the only path that could run as a
*least-privilege role with RLS applied to the harness itself*.

## Decision

**The harness runtime uses Path B — the service-role `supabase-js` client — with
four mandatory conditions.**

1. **Explicit tenant binding, never inferred.** `org_id` is a required argument of
   session creation and is carried in `ToolContext`. The harness never queries for
   "the org". Every read filters `org_id`; every write sets it; every Verify Step
   asserts the returned row's `org_id` equals the session's (G1). The MCP
   "first org" pattern is prohibited and is called out as a defect to fix
   separately (it is pre-existing, out of harness scope, and is logged in the AR
   backlog by this ADR).
2. **No hard-coded project ref or org id.** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   and the operating `org_id` come from env/arguments. `db.mjs`'s constants stay
   where they are (acceptance tooling) and are logged as an AR cleanup item.
3. **Path A keeps exactly two jobs:** applying migrations, and acceptance/eval
   scripts that need raw SQL or `set local role` RLS probing (slice 4's `as_user()`
   idiom cannot be expressed through PostgREST). No harness *runtime* code path may
   import `scripts/lib/db.mjs`.
4. **Path C is the documented successor.** When a DB password and a dedicated
   least-privilege role exist, the harness swaps `db/client.mjs` — one module,
   behind the `DbClient` interface — and gains RLS-applied, least-privilege
   access. Designing to that interface now is the cost of keeping the door open.

## Comparison

| Criterion | A: management API | **B: service-role client** | C: direct Postgres |
|---|---|---|---|
| Security — credential blast radius | **Worst.** Full project admin: DDL, drops, project config | Bad but bounded: data-plane only, no DDL, no project admin | **Best available.** Can be a role with table-level grants |
| Security — RLS | Bypassed (superuser-equivalent) | **Bypassed** — service role ignores RLS; tenant safety is code-enforced | RLS can apply to the harness role itself |
| Security — injection surface | SQL string interpolation via escape helpers | Parameterized query builder | Parameterized |
| Reliability | Per-minute rate limit already causes false failures; needs 45s sleeps and 5-retry backoff | No management limit; ordinary API limits | Best; connection-pool limits instead |
| Operational complexity | Low to start, high to keep green (throttle management) | Low; already proven by the MCP server | Highest: pooling, PgBouncer semantics, serverless connection churn |
| Portability | Supabase-proprietary | Supabase-proprietary (PostgREST) | **Portable** — any Postgres |
| Cost | Free; costs test time (45s+ sleeps) | Free | Free |
| Maintainability | Escape helpers are a permanent hazard class | Query builder; less bespoke code | Most code (SQL by hand), most control |
| Availability today | Yes | **Yes** | **No** — no password in environment |
| Local dev vs deployed | Same token both places; token slated for revocation | Same key both places; already in `.env.acceptance` and `apps/web/.env.local` | N/A |

## Alternatives considered

- **Path A for the harness too** (consistency with existing runners). Rejected on
  three counts: it builds a runtime on a credential that is scheduled to be
  revoked; the per-minute limit turns harness sessions into flaky tests exactly
  the way it already does for slice 4; and it gives an agent loop a credential that
  can drop tables. That last point is disqualifying on its own — the dispatcher's
  effect-class ceiling means nothing if the connection underneath can run DDL.
- **Path C now.** Rejected as unavailable, not as wrong. It is the recommended
  end state (condition 4).
- **Anon key + real user JWT** (harness runs as a service user, RLS applies).
  Genuinely attractive — it would make G1 database-enforced instead of
  code-enforced. Rejected for v1 because the harness must write service-role-only
  tables (`agent_*`, `integration_events`) that intentionally have **zero** client
  policies (G2, the S1 lesson). Granting the harness user policies on those tables
  would recreate the S1 shape. Revisit only together with Path C, where
  table-level grants can be scoped without adding RLS policies.

## Consequences

**Operational, exactly:**
- New runtime requirements: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in env for
  any harness run. Already present in `.env.acceptance` and `apps/web/.env.local`;
  `.mcp.json` already passes them to the MCP server. No new secret is created.
- The service-role key must **never** reach a client bundle. Harness imports are
  server-only; `apps/web` routes under `/api/agent/*` are server handlers, and H15
  adds a build-time check that no client component imports `packages/harness`.
- Harness runtime code cannot import `scripts/lib/db.mjs`; an import-lint rule
  (extended from H1's layering lint) enforces it.
- Because the service role bypasses RLS, **tenant safety for harness code is code-
  enforced, not DB-enforced.** That makes G1's dispatcher assertion and the
  Verify Step's `org_scoped` check load-bearing, not decorative. Both get explicit
  regression tests: a cross-org input must be refused before any write.
- Harness sessions add no management-API traffic, so they do not worsen the
  existing 429 pressure and do not need the 45s cooldown pattern.
- Two credentials now have distinct, documented jobs: management token = schema
  changes and test probing; service-role key = runtime. When the management token
  is revoked (standing debt), the harness is unaffected.

**On the key rotation debt:** rotating the service-role key (standing debt: "before
real employee data lands") now also rotates the harness credential. One env var,
three consumers (MCP server, web routes, harness). Document it in the runbook at
H17.

## Security impact

- Reduces the number of components holding a management token to zero at runtime.
- Concentrates data-plane authority in one client, so redaction and tenant
  assertion have one place to live.
- Does **not** achieve least privilege — the service role is a large credential.
  This is a knowing, documented acceptance with a named successor (Path C).
- Leaves the pre-existing MCP tenant-binding defect untouched; it is logged, not
  fixed here, to keep this task's scope honest.

## Reversal strategy

`packages/harness/src/db/client.mjs` is the only module that touches a driver, and
`DbClient` is the only interface the rest of the harness sees. Reversal to Path A
or advance to Path C is one module swap plus its unit tests. No table, no
descriptor, no session type changes.

## Related tasks and guardrails

O1 · Tasks H2, H6, H11, H15, H16 · Guardrails G1 (tenant), G2 (service-role-only
tables), G17 (secrets) · Creates AR items: `db.mjs` hard-coded `PROJECT_REF`/`ORG_ID`;
MCP `orgs limit 1` tenant binding.
