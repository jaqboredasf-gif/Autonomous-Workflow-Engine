# Regression Checklist — functioning features as of slice 1 (2026-07-16)

Run before and after every change. Automated column = covered by
`scripts/acceptance-slice1.sh` (A1) / `scripts/acceptance-slice2.sh` (A2) /
typecheck+build (T). Manual items need a device or browser.

## Automated (run: `bash scripts/regression.sh`)

| # | Feature | Check | Auto |
|---|---|---|---|
| 1 | Web typecheck + production build (15 routes) | `npm run build` in apps/web | T |
| 2 | Mobile typecheck | `npx tsc` in apps/mobile | T |
| 3 | Password auth + RLS-scoped profile fetch | login → users select returns caller only | A1 |
| 4 | Punch insert w/ GPS accuracy + computed distance | REST insert → distance/flag stored | A1 |
| 5 | Geofence benefit-of-doubt (accuracy widens fence) | 210m out / 80m acc → inside | A1 |
| 6 | Geofence outside flag + evidence | 2km out / 10m acc → outside + distance | A1 |
| 7 | punch.created / punch.flagged events, exactly-once | integration_events rows | A1 |
| 8 | Completion report insert (worker RLS) + events | job.completed, return_trip_required | A1 |
| 9 | integration_events / completion_reports hidden from anon | anon selects return empty | A1 |
| 10 | MCP server boots, lists 10 tools, live tool call works | JSON-RPC smoke in regression.sh | ✔ |
| 11 | Punch idempotency (device_id, client_uuid) | duplicate insert → 23505 handled | A1 (implicit) |
| 12 | Punch-time immutability + correction flow | added this slice | A2 |
| 13 | Approval-diff engine (ADR) + migration 0014 shape | `eval-approval-diff.sh` (Runner 3) + `validate-migration-0014.mjs` | ✔ offline |
| 14 | Approval-matrix routing, outbound drafting, no-send gate (B3) | `eval-approval-matrix.sh` (Runner 4) — labels, determinism, no-send, fixture recipients, 11/11 blocked reasons, 10/10 templates, source purity | ✔ offline |
| 15 | Migration 0015 shape + engine/SQL routing parity (B3) | `validate-migration-0015.mjs` (64 checks) | ✔ offline |
| 16 | B3 live DB gates: RLS denial for non-approvers, approve → `message.approved`, `sent` unreachable without approval, invoice refuses auto, duplicate `draft_key` → 23505, no hard deletes, fail-closed routing | `acceptance-slice4.sh` (49 checks) | ✔ B3-live |
| 17 | Live SQL `route_outbound()` == offline JS `route()`, both on the seeded matrix and on a fully-configured one (limit/backup/escalation branches) | `parity-route-live.mjs` via slice 4 checks 14–14d (460 cases, 2946 field comparisons) | ✔ B3-live |
| 18 | Approval-queue decision logic (B5): duplicate-decision guard across every status, unauthorized approver, required rejection reason, TEST mode both directions, five view states, refresh verdict, audit trail, `QUEUE_SELECT` schema + enum parity, UI source purity (no send call, no service-role key) | `eval-approval-queue.sh` (Runner 5, 325 checks, 19 fixtures, 7/7 guard reasons) | ✔ offline |
| 19 | B5 over the browser's real credentials: `QUEUE_SELECT` + FK-hint embeds resolve, admin reads / anon + worker read zero, `record_approval()` enforces reason + role + one-decision-per-message, blocked row visible but undecidable, direct PATCH writes nothing, nothing sent | `acceptance-slice5.sh` (27 checks) | ✔ B5 |

Rows 13–15 and 18 need no keys, no database and no network — they are the subset that
can run when the live project must not be touched. Rows 16–17 and 19 require the live
project (`.env.acceptance` sourced) and migrations 0014+0015 applied.

Row 18 imports `apps/web/src/lib/approval-queue.ts` directly (Node 24 strips the
types), so it tests the module the page ships rather than a copy of it. Row 19 reads
`QUEUE_SELECT` out of that same module, so the acceptance test cannot query different
columns than the UI does.

Slice 4 is management-API heavy (~60 queries). regression.sh pauses 45s after it so the
per-minute rate-limit window drains; `scripts/lib/db.mjs` and slice 4 also retry 429s
with backoff. **A 429 is a throttle, not a test failure** — if a runner reports one,
re-run it rather than treating it as a regression.

## Manual (spot-check when touched area changes)

| # | Feature | How to verify |
|---|---|---|
| M1 | Mobile solo clock in/out + wrap-up form | Expo Go: punch in, out → completion form appears |
| M2 | Mobile crew punch | foreman: Crew tab, select 2, CREW IN |
| M3 | Offline queue | airplane mode punch → badge shows queued → sync on reconnect |
| M4 | Punch photo (when setting on) | Settings: require photo → clock-in opens camera |
| M5 | Web pages render signed-in | Home, Timesheets (approve btn), Schedule, Completions, Map, Flags, Sites, Employees (skills edit), Payroll (lock), Settings |
| M6 | Payroll lunch deduction 12:00–12:30 | entry spanning lunch → 0.5h deducted |
| M7 | Employee creation via admin route | Employees page add → new login works |
| M8 | Timesheet approve → audit on later edit | approve entry, edit notes → time_entry_audits row |

## Invariants (never break silently)

- Service-role key only in `apps/web/.env.local` + MCP env — never client bundles.
- RLS: worker sees own entries; events table service-only. **Known live drift (S1,
  2026-07-26): `integration_events`, `time_entry_audits`, `crews`, `crew_members`
  carry 16 undeclared org-scoped client policies with no role gate — an authenticated
  worker can read AND delete audit events, and the owner of an edited time entry can
  delete and forge that entry's own audit rows. Removal fully rehearsed in a
  rolled-back transaction 2026-07-26 (all assertions pass, rollback proven) and
  independently re-verified 2026-07-27; **still not applied — waiting on explicit
  approval.** The only supported apply artefact is the promoted, dry-run-verified
  migration `supabase/migrations/0016_drop_undeclared_client_policies.sql`;
  `scripts/s1-policy-cleanup-rehearsal.sql` is a dry-run instrument that writes
  probe data and is **never** applied or converted to `commit;`. Evidence + exact
  SQL + apply path: `docs/SECURITY_FINDINGS.md` § S1.**
- **Regression note**: nothing in regression.sh depends on those 16 policies. Every
  `sql()` call in `scripts/acceptance-slice*.sh` goes through the management API,
  which bypasses RLS; no suite issues a client-JWT request against the four tables.
  Slice 1 check 5 tests `anon`, which those policies never granted.
- **S1 pin (added 2026-07-27)**: `scripts/acceptance-s1-security.sh`, run by
  `regression.sh` after slice 5, is the assertion that the four tables stay
  service-role-only. It is state-aware — green while S1 is PENDING (16 policies,
  exposure asserted to be exactly as documented) and green once APPLIED (0
  policies, worker/audited-user reads asserted to be 0 and every forge refused) —
  and RED on any other state. Its banner prints which one is live. It writes
  nothing: every write probe runs in a transaction aborted by a deliberate
  exception, and check D1 pins zero residue.
- The approval queue writes only through `record_approval()`; `outbound_messages` has
  no client insert/update/delete policy, and no UI file may reference
  `mark_message_sent` (Runner 5 asserts this).
- Geofence flags computed server-side (trigger), never trusted from client.
- `.env*` gitignored except `.env.example`.
- Offline punches idempotent on (device_id, client_uuid).
