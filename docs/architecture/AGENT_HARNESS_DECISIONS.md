# Agent Harness — open-question decision matrix (H0, 2026-07-27)

Resolves O1–O5 from `docs/architecture/AGENT_HARNESS_DESIGN.md` §17, plus two
defects found in that design during H0 inspection (D-A, D-B below). Full records:
`docs/architecture/decisions/` (ADR-0001 … ADR-0008).

**Status of every decision here: PROPOSED.** None carries authority until Jack
ratifies and a DECISION_LOG entry records the date.

## Summary

| # | Question | Recommendation | ADR | Blocks H1? | Configurable later? |
|---|---|---|---|---|---|
| O1 | Harness DB access path | Service-role `supabase-js`, explicit org binding, no `db.mjs` in runtime | ADR-0002 | **No** (H1 is pure) — blocks H2/H6/H11 | Yes — one module behind `DbClient` |
| O2 | Where the loop runs | Library only; CLI/web/MCP callers; no daemon | ADR-0003 | No — blocks H11/H15 | Yes — worker is a new caller |
| O3 | Structured output | Strict JSON-in-text; native tool-calling deferred | ADR-0004 | No — blocks H7/H9 | Yes — adapter capability flag |
| O4 | Fixture row lifecycle | Accumulate, idempotent per fixture, no reaper; threshold 100k | ADR-0005 | No — blocks H13 | Yes — threshold is config |
| O5 | Human-gate surface | Approvals reuse B5 queue; blocks get read-only ops list | ADR-0006 | No — blocks H14/H15 | Yes |
| D-A | Kill-switch home | `agent_harness_settings` table, not `org_settings` | ADR-0007 | No — blocks H2 | Enabled flag is data |
| D-B | Harness eval runner number | **Runner 6** (1–5 taken) | ADR-0008 | No — blocks H13 | No (naming) |

Only **ADR-0001** (doctrine supersede) blocks H1.

---

## O1 — Which database access path does the harness runtime use?

**1. Why it matters.** It picks the credential an agent loop runs under, decides
whether tenant isolation is DB-enforced or code-enforced, and determines whether
harness runs inherit the per-minute management rate limit that already forces a
45-second sleep into `regression.sh`. Getting it wrong means an agent loop holding
a credential that can execute DDL.

**2. Realistic options.**
- **A. Supabase management query API** — the `scripts/lib/db.mjs` path: raw SQL,
  `sbp_` management token, hard-coded `PROJECT_REF` + `ORG_ID` (`db.mjs:9-11`),
  per-minute rate limit with 5-retry backoff, string-interpolated SQL via
  `lit()`/`jsonb()`/`textArray()`. **The token is scheduled for revocation**
  (SECURITY_FINDINGS § Standing security debt).
- **B. Service-role `supabase-js`** — the `packages/mcp-server` path: PostgREST,
  parameterized builder, `SUPABASE_SERVICE_ROLE_KEY`, no DDL, bypasses RLS. Its
  current tenant binding is defective (`index.js:396` — `from('orgs')…limit(1)`).
- **C. Direct PostgreSQL** (`pg` driver, least-privilege role, RLS applied to the
  harness itself). **Not available**: CONTEXT.md records no DB password, no psql,
  no CLI, no Docker in this environment.
- **D. Anon key + service-user JWT** (RLS applies to the harness). Conflicts with
  G2: harness tables are service-role-only with **zero** client policies; granting
  the harness user policies there rebuilds the S1 shape.

**3. Comparison.** Full table in ADR-0002. Decisive points: A carries a
project-admin credential into an agent loop and is built on a token slated for
revocation; A's rate limit turns sessions into flaky tests; C is unavailable; D
reintroduces the S1 policy shape.

**4. Compatibility with current AWE.** B is already proven in-repo (MCP server, 10
tools, in regression), its dependency and env wiring already exist (`.mcp.json`,
`.env.acceptance`, `apps/web/.env.local`). A stays exactly where it is for
migrations and for acceptance scripts that need `set local role` RLS probing —
PostgREST cannot express slice 4's `as_user()` idiom.

**5. Recommendation.** **Option B**, with four conditions: explicit `org_id` binding
(never "first org"); no hard-coded project ref or org id in harness code; harness
runtime may not import `scripts/lib/db.mjs`; `DbClient` interface kept narrow so
option C is a one-module swap when a password and least-privilege role exist.

**6. Consequences / rejected.** Runtime now requires `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` (no new secret created). Service role bypasses RLS ⇒
**tenant safety for harness code is code-enforced**, making the dispatcher
assertion and the Verify Step's `org_scoped` check load-bearing, with explicit
cross-org refusal tests. Harness adds no management-API traffic. Rotating the
service-role key (standing debt) now rotates three consumers. Rejected: A (blast
radius + revocation + throttle), C (unavailable, but named successor), D (S1 shape).
Two AR items created: `db.mjs` hard-coded constants; MCP `orgs limit 1` binding.

**7. Blocks H1?** No — H1 is pure and touches no database. Blocks H2, H6, H11, H15.
Remains configurable behind `DbClient`.

---

## O2 — Where does the step loop execute?

**1. Why it matters.** It decides whether this project acquires its first
long-running process, with the hosting, restart, log-shipping and on-call
obligations that implies — and whether anything can run unattended.

**2. Options.** (a) library invoked by callers (CLI, web route, MCP, later n8n);
(b) dedicated worker/daemon polling for `created` sessions; (c) n8n drives each
step; (d) Supabase Edge Functions.

**3. Comparison.** (b) needs infrastructure that does not exist and creates an
unattended action surface before there is a kill-switch track record. (c) puts
budgets/retries/guards outside the code regression tests, and B12 is blocked on an
instance URL. (d) adds a runtime, a deploy path, a secret store and a hard time cap
for no gain over a web route. (a) needs nothing new and keeps every run attributable.

**4. Compatibility.** Matches the repo exactly: batch scripts, request/response web
app, stdio MCP server, no services. The lease design (`claimed_by`,
`lease_expires_at`, `expire_agent_leases()`) already permits (b) later.

**5. Recommendation.** **(a) Library only.** Web-invoked session types cap
`max_wall_seconds ≤ 50`; the CLI may run to budget; MCP is fixture-only.

**6. Consequences / rejected.** No unattended runs — a scheduled trigger would be a
separate approved task, not a flag. Long sessions belong to the CLI. Crash
semantics handled by lease expiry + `resume()`. Rejected (b)/(c)/(d) as above.

**7. Blocks H1?** No. Blocks H11, H15. Fully reversible — a worker is just another
caller.

---

## O3 — Strict JSON output, or provider-native tool-calling?

**1. Why it matters.** It sets the model contract, the retry semantics for malformed
output, the adapter interface, and whether the recorded-output fixture corpus
(`fixtures/emails/model_recorded.json`) stays replayable.

**2. Options.** (a) keep JSON-in-text + parse + schema-validate + fail-closed;
(b) native `tools:`/`tool_use` blocks; (c) provider JSON-mode / constrained decoding.

**3. Comparison.** (b) rewrites the recorded corpus that Runner 2A replays — i.e. it
changes the measuring instrument in the same change that builds the thing being
measured. (c) is provider-specific and pushes a capability into the domain contract
(against portability). (a) is already proven end to end by B2.

**4. Compatibility.** (a) is what `classification.mjs` does today; the harness
inherits `parseModelText` → `validateModelOutput` → one repair → fail-closed.

**5. Recommendation.** **(a)**, with a `capabilities.native_tools` flag on
`ModelAdapter` that nothing branches on yet. One tool intent per model turn;
multi-tool work sequences across loop iterations.

**6. Consequences / rejected.** Slightly more model calls per session, all visible
in the ledger and all budget-charged. Later migration: add a `native_tools` adapter
plus its own recorded corpus, keep JSON as the regression default. Rejected (b) now,
(c) as an optimization that must not change observable output.

**7. Blocks H1?** No. Blocks H7, H9. Configurable at adapter level.

---

## O4 — What happens to fixture rows the harness writes?

**1. Why it matters.** Runner 6A writes sessions, steps, tool calls and model calls
to the **live** project on every regression run. Unbounded growth in immutable
audit tables cannot be fixed later by deletion — `guard_no_delete` forbids it.

**2. Options.** (a) accumulate; (b) build a reaper/archival job; (c) dedicated
fixture org; (d) non-persisting fixture runs.

**3. Comparison.** (d) would gut the Verify Step, which is exactly what Runner 6
exists to exercise — a run that writes nothing proves nothing. (b) is deletion
machinery against audit tables, written before any evidence of a problem. (c) is
the cleanest long-term answer but forks every acceptance script's org constant and
touches Workstream A tests. (a) plus idempotency bounds growth by corpus size
instead of run count.

**4. Compatibility.** Mirrors the existing `fixture:<name>` idempotent ingest idiom
in `db.mjs:ingestEmail` and the `is_fixture` column convention in 0011/0014/0015.

**5. Recommendation.** **(a) + idempotent session keys** (`fixture:<corpus>:<name>`),
`is_fixture` propagated through every harness table, TEST-mode dispatch guard, and a
`agent_fixture_footprint` view with a **100,000-row** revisit threshold. Deletion
stays forbidden.

**6. Consequences / rejected.** Runner 6 must prove idempotency (two consecutive
runs ⇒ same session count, same terminal states). The AR fixture-reaper item is
expanded to cover harness tables and the fixture-org option, and stays open.
Rejected (b) now, (c) as the named successor, (d) outright.

**7. Blocks H1?** No. Blocks H13. Threshold is configuration.

---

## O5 — Where do humans see a session that stopped for them?

**1. Why it matters.** Two different stops — "approve this customer message" and
"a guardrail refused, investigate" — have different audiences and different
authority. Merging them trains the office admin to click past safety signals.

**2. Options.** (a) reuse the B5 approval queue for everything; (b) a separate
harness queue for everything; (c) split: approvals → B5, operational blocks →
read-only ops list; (d) CLI only.

**3. Comparison.** (b) duplicates approval semantics that `message_policies` already
owns as data and creates a second path to the same authority. (a) puts harness
failures in front of the office admin. (d) makes a blocked session invisible until
someone runs a command. (c) keeps authority where it is already tested.

**4. Compatibility.** B5 (`src/lib/approval-queue.ts`, Runner 5, slices 4–5) is
built and green; harness drafts go through the existing `create_outbound_draft()`
RPC, so the queue sees an ordinary row.

**5. Recommendation.** **(c).** `awaiting_human` sessions that produced a draft
surface in B5 unchanged; `blocked`/budget-exhausted/verify-failed sessions surface
in a read-only admin list from `agent_blocked_sessions` + the trace endpoint. No
approve/reject control on the ops list.

**6. Consequences / rejected.** Slices 4 and 5 must stay green through H14.
`awaiting_human` sessions always carry a pointer to what the human is looking at.
Rejected (a), (b), (d) as above.

**7. Blocks H1?** No. Blocks H14, H15.

---

## D-A — Kill-switch home (defect found in the design doc)

The design named `org_settings.harness_enabled`. `org_settings`
(`0001_core.sql:18-29`) is the **payroll config** table — timezone, rounding, OT,
lunch window — and has no such column; adding one would alter a Workstream A table
inside a Workstream B migration. **Recommendation: `agent_harness_settings`**
(ADR-0007), `enabled` default **false**, `fixture_mode_only` default **true**, so
the harness arrives inert. Three-level switch: harness → session type → tool.
Blocks H2. Standing rule adopted: **no harness migration touches a Workstream A table.**

## D-B — Runner number collision (defect found in the design doc)

The design called the harness eval "Runner 4". Runner 4 is `eval-approval-matrix.sh`
(B3) and Runner 5 is `eval-approval-queue.sh` (B5). **Recommendation: Runner 6**
(6A deterministic/in-regression, 6B live/key-gated), with H1's unit suite explicitly
*not* a Runner (`scripts/eval-harness-unit.sh`, an offline lint step). ADR-0008.
Blocks H13.

---

## Decisions that must never remain implicit

Recorded here so a future session cannot "reasonably assume" otherwise:

1. The harness never chooses an org. `org_id` is always an explicit argument.
2. Harness runtime never imports `scripts/lib/db.mjs` and never holds a management
   token.
3. The `external` effect class has no descriptor, no permitted ceiling, and no code
   path in v1.
4. The harness is never an approver.
5. The harness is dormant on arrival (`enabled=false`, `fixture_mode_only=true`).
6. Model output is never evidence; only a Verify Step is.
7. A guard refusal is never retried.
8. No harness migration touches a Workstream A table.
