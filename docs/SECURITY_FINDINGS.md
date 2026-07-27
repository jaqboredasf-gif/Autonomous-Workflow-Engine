# SECURITY_FINDINGS.md

Live security findings against the Supabase project, their evidence, and their
remediation state. One section per finding. A finding is only `CLOSED` when a
committed migration is applied live AND a regression check pins the fixed state
so it cannot silently return.

Standing constraints that apply to every remediation here: no external sends, no
production workflow activation, no weakening of RLS, no deletion of legitimate
audit history, no service-role credential in a committed file or a client
bundle, fail closed on uncertainty.

---

## S1 — 16 undeclared client RLS policies on service-role-only tables

- **State**: `MIGRATION 0016 PROMOTED + DRY-RUN VERIFIED — awaiting explicit
  approval for permanent apply` (rehearsed 2026-07-26; independently re-verified,
  baselined, and promoted on `security/c1-policy-cleanup` 2026-07-27)
- **Severity**: high — the approval/integration audit trail is destructible and
  forgeable by any authenticated org member.
- **Found**: 2026-07-26 by `scripts/acceptance-slice5.sh` while checking whether
  a browser session could read the event log.

### What is wrong

Four tables carry client RLS policies that **no migration in this repo creates**:

| table | repo intent | live reality |
|---|---|---|
| `integration_events` | 0009: *"Service-role only: RLS on, no client policies."* | 4 policies, `TO authenticated` |
| `time_entry_audits` | 0002 enables RLS, declares no policy → service-role only | 4 policies, `TO authenticated` |
| `crews` | 0002 enables RLS, declares no policy → service-role only | 4 policies, `TO authenticated` |
| `crew_members` | 0002 enables RLS, declares no policy → service-role only | 4 policies, `TO authenticated` |

All 16 are named `<table>_org_{select,insert,update,delete}` and target the
`authenticated` role. **Every repo-declared policy uses `TO public`** (no `TO`
clause) — the `TO authenticated` grant is a fingerprint of the orphan schema an
external session created on the live DB (DECISION_LOG 2026-07-17 B1). Migration
`0012` dropped the orphan tables, the `ensure_rls` event trigger and the orphan
helpers, but not these policies.

They gate on `current_org_id()` with **no role check**, so every authenticated
member of the org qualifies.

### Full inventory (all 16, verified live 2026-07-26)

| # | policy | table | cmd | roles | current access granted | why undeclared / unsafe | evidence nothing legitimate depends on it |
|---|---|---|---|---|---|---|---|
| 1 | `integration_events_org_select` | `integration_events` | SELECT | `authenticated` | `using (org_id = current_org_id())` — any org member reads the whole event log | 0009 states the table is service-role only; no `create policy` for it anywhere in `supabase/migrations/` | No client code reads it: `grep -rn "integration_events" apps/ packages/` matches only comments in `approval-queue.ts` (which documents the exclusion). Runner 5 `SERVICE_ROLE_ONLY` gate + slice 5 check 4 already forbid the queue from touching it. Every script read goes through the management API (superuser), not a client JWT. |
| 2 | `integration_events_org_insert` | `integration_events` | INSERT | `authenticated` | `with check (org_id = current_org_id())` — any org member forges events | same | Writes go through `emit_event()` (`security definer`, owner `postgres`) and triggers; no client insert path exists. |
| 3 | `integration_events_org_update` | `integration_events` | UPDATE | `authenticated` | full row rewrite within the org | same | Nothing updates events; the contract is append-only. |
| 4 | `integration_events_org_delete` | `integration_events` | DELETE | `authenticated` | **deletes audit/approval events** | same; breaks "audit everything" + "no hard deletes" (STAKEHOLDERS) | Nothing deletes events. Slice 4 check 12 asserts hard deletes are refused on the sibling tables; the event log has no such guard, only this policy standing open. |
| 5 | `time_entry_audits_org_select` | `time_entry_audits` | SELECT | `authenticated` | `using (exists(time_entries te where te.id=… and te.org_id=current_org_id()))` — visible for any time entry the caller can see | 0002 enables RLS and declares no policy | No client code references the table at all. |
| 6 | `time_entry_audits_org_insert` | `time_entry_audits` | INSERT | `authenticated` | forges audit rows | same | Only writer is `audit_time_entry_edit()` (`security definer`, owner `postgres`) on the `time_entries_audit` trigger — it bypasses RLS and is unaffected by the drop (rehearsal assertion C1). |
| 7 | `time_entry_audits_org_update` | `time_entry_audits` | UPDATE | `authenticated` | rewrites `old_values`/`new_values` | same | Nothing updates audits. |
| 8 | `time_entry_audits_org_delete` | `time_entry_audits` | DELETE | `authenticated` | **deletes the tamper-evidence for the caller's own edited entries** | same | Nothing deletes audits. |
| 9 | `crews_org_select` | `crews` | SELECT | `authenticated` | any org member lists crews | 0002 enables RLS and declares no policy | Table is **empty (0 rows)**. Mobile "crew mode" reads `users`, not `crews` (`App.tsx:171–184`); no `from('crews')` exists in `apps/mobile`, `apps/web/src` or `packages/mcp-server`. |
| 10 | `crews_org_insert` | `crews` | INSERT | `authenticated` | any worker creates crews | same | same |
| 11 | `crews_org_update` | `crews` | UPDATE | `authenticated` | any worker renames/reassigns crews | same | same |
| 12 | `crews_org_delete` | `crews` | DELETE | `authenticated` | any worker deletes crews | same | same |
| 13 | `crew_members_org_select` | `crew_members` | SELECT | `authenticated` | membership visible via the parent crew | same | Table is **empty (0 rows)**; no code path. |
| 14 | `crew_members_org_insert` | `crew_members` | INSERT | `authenticated` | any worker adds themselves to a crew | same | same |
| 15 | `crew_members_org_update` | `crew_members` | UPDATE | `authenticated` | any worker reassigns membership | same | same |
| 16 | `crew_members_org_delete` | `crew_members` | DELETE | `authenticated` | any worker removes members | same | same |

### Exploit evidence (executed live 2026-07-26, inside aborted transactions, zero residue)

As the fixture worker `f1000000-0000-4000-8000-000000000001` (role `worker`),
via `set local role authenticated` + a forged `request.jwt.claims`:

```
S1-EXPOSURE-PROBE read_events=377 read_audits=0 read_crews=0 read_crew_members=0
                  deleted_approved_events=16 forged_event_inserted=1
                  audits_tampered=0 crew_inserted=1
```

A plain worker read **377** integration events, **deleted all 16
`message.approved` events**, inserted a forged event, and created a crew.

`time_entry_audits` is **not** vacuous, contrary to the original backlog note.
The audit policy's `EXISTS` subquery is itself filtered by `time_entries` RLS,
so a caller sees audits only for entries they can see — which is exactly the
wrong set. Probing as the owner of the one audited entry
(`22f34395-…`, entry `5edfd051-…`):

```
S1-AUDIT-PROBE(owner) read=1 deleted=1 forged_inserted=1
```

**The person whose approved/locked time entry was edited can read, delete and
forge that entry's own audit trail.**

Residue check immediately after both probes: events 377, `message.approved` 16,
audits 1, crews 0, `S1.*` probe rows 0 — unchanged.

### Blast-radius analysis — where removal could break something

| risk | verdict | evidence |
|---|---|---|
| Approval flow (`record_approval`, `/approvals`) | **no impact** | The queue reads `outbound_messages` + embeds only; `integration_events` is on Runner 5's forbidden list and slice 5 check 4 already asserts its absence. |
| Audit writes (`time_entries_audit` trigger) | **no impact** | `audit_time_entry_edit()` is `security definer` owned by `postgres`; tables are `postgres`-owned with `relforcerowsecurity=false`, so the definer bypasses RLS. Rehearsal assertion C1 executed a real approved-entry update after the drops and observed exactly +1 audit row. |
| Event emission (`emit_event`) | **no impact** | Same definer/ownership argument; rehearsal assertions B5/B6 called `emit_event()` **from an `authenticated` session after the drops** and confirmed the row landed. |
| Service-role / MCP server behaviour | **no impact** | The service role bypasses RLS entirely; `packages/mcp-server` never touches the four tables. |
| n8n / integration consumers | **no impact** | B12 is `BLOCKED`; no consumer exists yet, and any future one uses the service role per the 0009 contract. |
| Workflow / scheduling (B6, crews) | **no impact today** | `crews`/`crew_members` are empty and referenced by no code. If B6 later needs client crew access it must declare policies in a migration — which is the correct direction, not a regression. |
| Admin visibility of audits | **accepted consequence** | After the drop, `time_entry_audits` is readable only by the service role. That is the state migration 0002 declares. No page reads it today. If an admin audit view is wanted, it gets an explicit `current_role_is('admin')` policy in a migration. |
| Anon (logged-out) access | **unchanged** | The 16 policies target `authenticated`, never `anon`. Slice 1 check 5 ("anon blocked from integration_events") passes before and after. |
| Data loss | **none possible** | `DROP POLICY` removes no rows. Rehearsal assertion A4 compares all five row counts across the change. |

### Rehearsal results (2026-07-26)

Script: **`scripts/s1-policy-cleanup-rehearsal.sql`** — the drop set wrapped in
`begin; … rollback;` with 7 pre-assertions (P1–P7), 5 structural post-assertions
(A1–A5), 8 behavioural post-assertions under real `authenticated` and `anon`
sessions (B1–B8), and a live audit-trigger test (C1). Rollback script:
**`scripts/s1-policy-cleanup-rollback.sql`**. **Neither file is a migration and
neither may be applied to production.** The rehearsal in particular writes probe
data that only its trailing `rollback;` discards. The migration is the separate
`supabase/migrations/0016_drop_undeclared_client_policies.sql` (see "The only
supported apply path").

- **Rehearsal: PASS** — management API returned `[]` (clean execution, nothing left behind).
- **Non-vacuity 1**: drops commented out → `POST A1 FAIL: 16 policies remain`.
- **Non-vacuity 2**: drops commented out + structural asserts disarmed →
  `POST B1 FAIL: worker still reads 377 events`.
- **Rollback round-trip**: snapshot → drop 16 → run the rollback script → all 16
  restored and **byte-identical** on `(policyname, tablename, cmd, roles,
  permissive, qual, with_check)` → rolled back. PASS.
- **Post-rehearsal drift check**: 55 public policies, 16 on the target tables,
  24 base tables, 1 audit, 0 crews, **0 `S1.*` probe rows**. Identical to
  pre-rehearsal. (Absolute event counts move between runs — 377 → 407,
  `message.approved` 16 → 18 — because acceptance slices 3/4/5 seed fixture rows
  each regression run. That growth is the test harness, not this change; the
  rehearsal's A4 assertion compares counts *within* its own transaction.)
- **Full regression baseline before any change: ALL GREEN.** mobile tsc, web
  build, MCP smoke 10 tools, slices 1–5 `9 / 10 / 20 / 49 / 27` all
  `failed=0`, Runner 1 `24/0`, Runner 2A `20/0` (accuracy 12/12), Runner 3
  `120/0`, Runner 4 `314/0`, Runner 5 `325/0`, both migration lints PASS.
- **Why the acceptance suites cannot themselves run "inside" the rolled-back
  transaction**: they reach the DB over separate HTTP connections (management
  API for `sql()`, PostgREST for the JWT checks), so no transaction can span
  them. The equivalent coverage is provided two ways instead — (a) the
  behavioural assertions B1–B8 execute the same access patterns the suites test,
  under the same principals, *inside* the transaction; (b) statically, every
  `sql()` call in `scripts/acceptance-slice*.sh` authenticates with
  `SUPABASE_ACCESS_TOKEN` against the management API, which bypasses RLS, and no
  suite issues a client-JWT request against any of the four tables.

### The only supported apply path

> **The rehearsal script is never the thing that gets applied.**
> `scripts/s1-policy-cleanup-rehearsal.sql` is a dry-run instrument. Beyond the
> 16 drops it deliberately mutates live data to prove the surviving paths still
> work — it emits an `S1.DEFINER_PROBE` event (B5), appends ` s1-probe` to the
> `notes` of every `approved` time entry and writes an audit row (C1), and
> issues probe `delete`/`insert` statements against `integration_events`,
> `crews` and `time_entry_audits` (B2–B4, B7). Those are safe **only** because
> the file ends in `rollback;`. Changing that `rollback;` to `commit;` — or
> running the file with a `commit;` appended — writes every one of those probes
> permanently into the production audit log. Do not do it, and do not describe
> it as an apply procedure.

The single supported production apply path for S1 is:

1. Get Jack's explicit go-ahead (dropping objects on live is destructive and
   human-gated — CONTEXT.md standing rule).
2. Use only `supabase/migrations/0016_drop_undeclared_client_policies.sql`. It
   was promoted on 2026-07-27 after the exact live inventory matched, the full
   regression passed, and both the rehearsal and migration dry-run returned
   `[]`. The file contains the 16 drops plus self-guarding post-conditions, no
   probes, and no row writes.
3. Re-check the exact 16-policy live inventory immediately before apply, then
   dry-run the migration again if the approval occurs in a fresh session, using
   the CONTEXT.md rolled-back-transaction recipe
   (`{ echo "begin;"; cat supabase/migrations/0016_…sql; echo "rollback;"; } | …`);
   an empty `[]` means it executes cleanly and left nothing behind.
4. Apply it with the CONTEXT.md management-API recipe
   (`jq -Rs '{query: .}' < supabase/migrations/0016_…sql | curl … /database/query`).
5. Re-run full regression and confirm `acceptance-s1-security.sh` reads
   `S1 state: APPLIED`; update the committed approval-checkpoint documentation
   with permanent-apply evidence.

### Exact remediation SQL (ready; NOT applied)

`supabase/migrations/0016_drop_undeclared_client_policies.sql` is the
authoritative copy of this SQL — if this review-only reproduction disagrees,
the migration file wins:

```sql
-- Cleanup: drop the 16 client RLS policies found on the live project 2026-07-26.
-- No repo migration creates them; they are residue of the orphan schema (0012).
-- They gate on current_org_id() with no role check, so any authenticated org
-- member could read, forge and DELETE integration_events and time_entry_audits.
-- Repo intent for all four tables is service-role only: RLS on, no client policy
-- (0002 for crews/crew_members/time_entry_audits, 0009 for integration_events).
-- RLS stays ENABLED on every table; this removes access, it never grants any.

drop policy if exists integration_events_org_select  on public.integration_events;
drop policy if exists integration_events_org_insert  on public.integration_events;
drop policy if exists integration_events_org_update  on public.integration_events;
drop policy if exists integration_events_org_delete  on public.integration_events;

drop policy if exists time_entry_audits_org_select   on public.time_entry_audits;
drop policy if exists time_entry_audits_org_insert   on public.time_entry_audits;
drop policy if exists time_entry_audits_org_update   on public.time_entry_audits;
drop policy if exists time_entry_audits_org_delete   on public.time_entry_audits;

drop policy if exists crews_org_select               on public.crews;
drop policy if exists crews_org_insert               on public.crews;
drop policy if exists crews_org_update               on public.crews;
drop policy if exists crews_org_delete               on public.crews;

drop policy if exists crew_members_org_select        on public.crew_members;
drop policy if exists crew_members_org_insert        on public.crew_members;
drop policy if exists crew_members_org_update        on public.crew_members;
drop policy if exists crew_members_org_delete        on public.crew_members;
```

Applied only as `supabase/migrations/0016_drop_undeclared_client_policies.sql`
via the CONTEXT.md management-API recipe — see "The only supported apply path"
above. **The rehearsal file is not this file and must not be converted into it**:
it carries live-data probes that are harmless solely because it rolls back.

### Exact rollback procedure

`DROP POLICY` is not transactionally recoverable after commit, so rollback =
re-create. The statements below were generated from `pg_policies` **before** the
drop and verified in a rehearsal to restore all 16 byte-identically.

```sql
begin;
create policy crews_org_select on public.crews as permissive for select to authenticated
  using ((org_id = current_org_id()));
create policy crews_org_insert on public.crews as permissive for insert to authenticated
  with check ((org_id = current_org_id()));
create policy crews_org_update on public.crews as permissive for update to authenticated
  using ((org_id = current_org_id()))
  with check ((org_id = current_org_id()));
create policy crews_org_delete on public.crews as permissive for delete to authenticated
  using ((org_id = current_org_id()));

create policy crew_members_org_select on public.crew_members as permissive for select to authenticated
  using ((exists (select 1 from crews c where c.id = crew_members.crew_id and c.org_id = current_org_id())));
create policy crew_members_org_insert on public.crew_members as permissive for insert to authenticated
  with check ((exists (select 1 from crews c where c.id = crew_members.crew_id and c.org_id = current_org_id())));
create policy crew_members_org_update on public.crew_members as permissive for update to authenticated
  using ((exists (select 1 from crews c where c.id = crew_members.crew_id and c.org_id = current_org_id())))
  with check ((exists (select 1 from crews c where c.id = crew_members.crew_id and c.org_id = current_org_id())));
create policy crew_members_org_delete on public.crew_members as permissive for delete to authenticated
  using ((exists (select 1 from crews c where c.id = crew_members.crew_id and c.org_id = current_org_id())));

create policy integration_events_org_select on public.integration_events as permissive for select to authenticated
  using ((org_id = current_org_id()));
create policy integration_events_org_insert on public.integration_events as permissive for insert to authenticated
  with check ((org_id = current_org_id()));
create policy integration_events_org_update on public.integration_events as permissive for update to authenticated
  using ((org_id = current_org_id()))
  with check ((org_id = current_org_id()));
create policy integration_events_org_delete on public.integration_events as permissive for delete to authenticated
  using ((org_id = current_org_id()));

create policy time_entry_audits_org_select on public.time_entry_audits as permissive for select to authenticated
  using ((exists (select 1 from time_entries te where te.id = time_entry_audits.time_entry_id and te.org_id = current_org_id())));
create policy time_entry_audits_org_insert on public.time_entry_audits as permissive for insert to authenticated
  with check ((exists (select 1 from time_entries te where te.id = time_entry_audits.time_entry_id and te.org_id = current_org_id())));
create policy time_entry_audits_org_update on public.time_entry_audits as permissive for update to authenticated
  using ((exists (select 1 from time_entries te where te.id = time_entry_audits.time_entry_id and te.org_id = current_org_id())))
  with check ((exists (select 1 from time_entries te where te.id = time_entry_audits.time_entry_id and te.org_id = current_org_id())));
create policy time_entry_audits_org_delete on public.time_entry_audits as permissive for delete to authenticated
  using ((exists (select 1 from time_entries te where te.id = time_entry_audits.time_entry_id and te.org_id = current_org_id())));
commit;
```

Rolling back **re-opens the vulnerability**. It exists only as a
break-glass step if an unforeseen consumer turns out to need client access; the
correct response to that discovery is a narrow, role-gated policy in a new
migration, not a wholesale restore.

### Independent re-verification (2026-07-27) — second session, evidence re-derived

Everything below was re-run from scratch rather than read off the 07-26 record.
The live database is **unchanged**: 55 policies, 16 on the target tables, 24 base
tables, 1 audit row, 0 crews, 0 `S1.*` rows, before and after.

| # | check | result |
|---|---|---|
| 1 | 16 policies still live on the 4 tables, all `TO authenticated` | confirmed |
| 2 | Repo↔live drift sweep over **all 55** policies: how many are undeclared? | exactly **16**, and they are exactly the S1 set — no other drift anywhere |
| 3 | Exploit reproduced as fixture worker (aborted txn) | `forged=1 deleted_approved_events=18 crew_created=1` |
| 4 | Audit exposure reproduced as the audited entry's owner (aborted txn) | `owner_reads_audits=1 owner_deleted_audits=1` |
| 5 | `scripts/s1-policy-cleanup-rehearsal.sql` (20 assertions, ends `rollback`) | management API returned `[]` — clean, zero residue |
| 6 | Non-vacuity A: drops commented out | `POST A1 FAIL: 16 policies remain` |
| 7 | Non-vacuity B: drops out **and** structural asserts downgraded to notices | `POST B1 FAIL: worker still reads 407 events` |
| 8 | Rollback round-trip: snapshot → drop 16 → run rollback script → compare | `snapshot=16 restored=16 byte_identical=16 missing=0` |
| 9 | Post-drop behaviour in one aborted txn | `w_ev=0 w_cr=0 w_cm=0 o_au=0 forged=0 crewed=0 audit_forged=0 definer_wrote=1 audit_delta=1` |
| 10 | Full regression before/after | **ALL GREEN** — 9 / 10 / 20 / 49 / 27, Runners 24 / 20 / 120 / 314 / 325, both lints, mobile tsc, web build, MCP 10 tools |

Also re-checked and clean: orphan helpers (`rls_auto_enable`, `current_person_id`,
`current_role_key`, `set_updated_at`) absent; no `workflow_*` / `organizations` /
`people` / `roles` table survives; `ensure_rls` absent; all four tables owned by
`postgres` with `relforcerowsecurity=false`; only `emit_event` and
`audit_time_entry_edit` reference the four tables and both are `security definer`
owned by `postgres`.

### New regression coverage added 2026-07-27

`scripts/acceptance-s1-security.sh` — wired into `scripts/regression.sh` after
slice 5. Closes the three gaps this finding had:

- slice 1 check 5 only ever tested **anon**, which these policies never granted.
  The exposed principal is `authenticated`; this script probes a real worker JWT.
- slice 5 check 4 only **printed** the policy count. Now it is asserted.
- `time_entry_audits` had no test at all.

It is **state-aware**, so it is green before the apply and green after, and red on
drift in either direction:

- `S1 PENDING` (16 policies) → asserts the documented exposure is exactly as
  described, which keeps it a live non-vacuity proof of the finding.
- `S1 APPLIED` (0 policies) → asserts worker/audited-user reads are 0 and every
  forge attempt is refused.
- anything else (17 policies, a new undeclared policy, RLS switched off, a
  dependent function that stopped being definer) → fails.

Invariants A1–A6 and surviving-path checks C1–C2 (`emit_event` from a client
session, audit trigger delta = 1) are asserted in **both** states. All writes run
in transactions aborted by a deliberate exception; D1 pins zero residue.

Proof the APPLIED branch is not dead code: forcing `S1STATE=APPLIED` against
today's still-vulnerable database fails 5 of its 6 exposure assertions (B2 passes
honestly — `crews`/`crew_members` really are empty). Row 9 above is the same
assertion set passing once the drops are in place.

### Promoted migration — the only artefact that may be applied

`supabase/migrations/0016_drop_undeclared_client_policies.sql` — promoted from
the prepared script on 2026-07-27 after the required live inventory, full
regression baseline, 20-assertion rehearsal, and migration `BEGIN/ROLLBACK`
dry-run all passed. It remains **unapplied pending explicit approval**. It carries
no "exactly 16 exist" pre-condition, so it replays cleanly on a database built
from 0001–0015; the apply checkpoint separately requires the live inventory to
be exactly the expected 16-policy state.

It contains **only** `drop policy if exists` statements and read-only
post-condition assertions — no probe insert, no probe update, no probe delete,
no `emit_event` call. That is the property that makes it, and not the rehearsal,
the file that may be committed against production.

### Remaining acceptance work after a permanent apply

1. Re-run full regression — expect ALL GREEN, unchanged counts.
2. ~~Add a drift pin for `pg_policies` count = 0 on all four tables~~ — **done
   2026-07-27**, `acceptance-s1-security.sh` B0 + A1. It flips from asserting the
   PENDING state to asserting the APPLIED state on its own; no edit is needed at
   apply time. Its banner must read `S1 state: APPLIED` afterwards.
3. ~~Add a check proving a **worker JWT** (not just anon) reads 0
   `integration_events`~~ — **done 2026-07-27**, same script, B1/B3 (plus B4–B6
   for forgery and B2 for `crews`/`crew_members`).
4. ~~Promote the prepared migration into `supabase/migrations/` and dry-run it~~
   — **done 2026-07-27** on `security/c1-policy-cleanup`; permanent live apply is
   still awaiting explicit approval. The rehearsal and rollback scripts stay
   where they are, unapplied, and are never promoted into `supabase/migrations/`.
5. Optional, separate from S1 — see "Standing security debt": `anon`,
   `authenticated` and `service_role` all hold full DML grants on the four tables
   (Supabase's default `grant all on all tables in schema public`). After S1, RLS
   with zero policies is the only thing denying them. That is sufficient and is
   what 0002/0009 intend, but a `revoke` would make it defence-in-depth. **Not**
   part of S1: it is a separate change, unrehearsed here, and PostgREST schema
   introspection has to be re-verified against it first.

---

## Standing security debt (not findings — scheduled work)

- **Observed 2026-07-27 while auditing S1, NOT part of S1 and not yet a finding**:
  8 of the 18 `SECURITY DEFINER` functions in `public` carry no `set search_path`
  — `business_role_matches`, `create_outbound_draft`, `emit_approval_outcome_events`,
  `emit_email_events`, `emit_outbound_insert_events`, `emit_outbound_update_events`,
  `mark_message_sent`, `record_approval` (all owned by `postgres`; the other 10 set
  `search_path=public`). Definer functions with a mutable search_path are the
  classic privilege-escalation shape. Exploitability here is unproven — it needs a
  caller able to set `search_path`, which PostgREST does not expose — so it is
  logged, not fixed. Fixing it is an `ALTER FUNCTION … SET search_path` change with
  its own rehearsal, deliberately kept out of S1 so the drop set stays exactly the
  16 policies that were proven.
- Revoke the `sbp_` management token when the setup phase ends.
- Rotate the service-role key before real employee data lands.
- Org-scope the punch-photo storage read policy.
- `.env.acceptance` must never be committed (currently gitignored).
