# ADR-0009 — Two competing artifacts implement the same C1 fix, under two incompatible migration-identity schemes

**Status:** Proposed (2026-07-27) — awaiting Jack's ratification. Raised by the H0
re-verification session, not by the H0 design session.

## Context

Verifying H0 against the repository surfaced a conflict that no harness document
records, because it originated in a parallel security workstream.

The same security fix — dropping the 16 undeclared `*_org_{select,insert,update,delete}`
policies on `integration_events`, `time_entry_audits`, `crews`, `crew_members` — now
exists as **two different, independently authored migration files on two branches**:

| Branch | File | Convention | `drop policy` statements |
|---|---|---|---|
| `security/c1-policy-cleanup` | `supabase/migrations/0016_drop_undeclared_client_policies.sql` | repo sequential `00NN_name.sql` | 17 matches (16 drops + 1 in prose/postcondition) |
| `security/phase-1-remediation` | `supabase/migrations/20260727142118_phase1_c1_remove_undeclared_policies.sql` | Supabase timestamp `YYYYMMDDHHMMSS_name.sql` | 16 |

`main` (`dbf8f17`) contains **neither**; its migration set ends at `0015`. The
phase-1 branch additionally introduces C2/C3/C4 under the same timestamp scheme
(`…142120_phase1_c2_restrict_privileged_rpcs`, `…142121_phase1_c3_bind_time_and_crew_authorization`,
`…142123_phase1_c4_mcp_tenant_contract`).

Three separate problems compound:

1. **Duplicate implementation.** Whichever is applied second is at best a no-op and
   at worst an error, and no single file is "the" C1 artifact. CONTEXT.md and
   SECURITY_FINDINGS § S1 name `0016` as *the only supported apply path*; the open
   draft PR #3 presents the timestamped file as the deployment artifact. Both cannot
   be true.
2. **Two migration-identity schemes in one directory.** `0001`–`0016` sort before
   any `2026…` name, so the orderings agree today by luck, not by rule. The repo has
   no documented convention that admits both.
3. **No live migration history to arbitrate.** The 2026-07-27 read-only deployment
   review (`docs/planning/AGENT_HANDOFF.md`) found the Supabase migration-list API
   returns zero rows and the live database has **no `supabase_migrations` schema**,
   while `0001`–`0015` are materially present in the live schema. Nothing in the
   database records which files ran. This activates the standing repository stop
   condition in `AGENTS.md`: *"Stop when repository, migration history, and live
   state disagree."*

## Decision

**No technical decision is made here.** This record exists so the conflict is
explicit and dated rather than rediscovered by the next session. The resolution is
Jack's, and it must be made before either artifact is applied.

Recommended resolution, in order:

1. **Do not apply either C1 file** until items 2–4 are settled. Both drop live
   objects; `DROP POLICY` is unrecoverable after commit.
2. **Reconcile migration history first** (read-only forensics), per the next prompt
   already recorded in `docs/planning/AGENT_HANDOFF.md`. Do not backfill or fabricate
   `supabase_migrations` rows without a separately reviewed recovery plan.
3. **Pick exactly one C1 artifact and delete the other**, in a commit that says which
   was chosen and why. Recommendation: keep `0016_drop_undeclared_client_policies.sql`
   — it is the file the standing documentation (CONTEXT.md, SECURITY_FINDINGS § S1,
   REGRESSION_CHECKLIST, TASK_BACKLOG) already points at, it has a rehearsed 20-assertion
   dry-run and a rehearsed rollback, and it is pinned by `scripts/acceptance-s1-security.sh`.
   The timestamped C1 has none of that evidence attached to it.
4. **Adopt one migration-identity convention explicitly**, in this file or a successor.
   Recommendation: keep the sequential `00NN_name.sql` scheme, because every existing
   doc, lint (`validate-migration-0014/0015.mjs`), and acceptance script assumes it.
   C2/C3/C4 would then be renumbered `0017`–`0019` — which collides with the harness
   plan below and must be resequenced deliberately.

## Consequences for the Agent Harness

- **`AGENT_HARNESS_H0_EXIT.md` §5 allocates `0017` (H2) and `0018` (H3) to harness
  tables.** If C2/C3/C4 are renumbered into `0017`–`0019`, the harness numbers must
  move. This is a documentation conflict today, not a code conflict, and it is cheap
  to fix only while H2 is unwritten.
- **H0_EXIT blocker B-2 understates the situation.** It recommends applying `0016`
  before harness apply-checkpoint AC-1. That recommendation is sound but assumed a
  single, agreed C1 artifact and a trustworthy migration history. Neither holds.
- **H1 is unaffected in substance.** H1 writes no SQL and touches no database, so the
  conflict does not block the pure core once ADR-0001 is ratified. It does block H2.

## Alternatives considered

- **Apply the phase-1 timestamped set and abandon `0016`.** Rejected as the default:
  it discards the rehearsal, rollback script, and regression pin built for `0016`,
  and the deployment review scored C2 at 35/100 confidence with an unresolved
  allow-list contradiction. Choosing it would mean re-earning evidence that already
  exists. Still open to Jack if PR #3 is the preferred delivery vehicle.
- **Keep both and let filename sort order decide.** Rejected: two files that drop the
  same 16 objects is a double-apply hazard, and "it happens to sort correctly" is not
  an invariant.
- **Say nothing and proceed to H1.** Rejected: H1 is safe, but leaving an undocumented
  duplicate destructive migration in the tree is exactly the drift the ADR process
  exists to catch.

## Security impact

Neutral to positive as written — this record applies nothing. The underlying
vulnerability (S1 / C1) **remains live and unfixed**: any authenticated org member can
still read, insert, and delete audit events on `integration_events`. Duplicated and
competing remediation artifacts increase the chance the fix is applied twice, applied
from the wrong file, or deferred indefinitely because ownership is unclear. Recording
the conflict is the cheapest available mitigation until Jack chooses.

## Operational impact

One decision from Jack plus one small cleanup commit. No live change. Blocks the
harness apply checkpoint AC-1 (H2) and the Phase 1 deployment, neither of which is
scheduled.

## Reversal strategy

Documentation only — delete this file. Nothing else exists to undo.

## Related tasks and guardrails

Tasks S1, Phase 1 C1–C4, H2, H3 · `AGENTS.md` stop condition · Depends on nothing ·
Blocks the choice of C1 artifact, the migration-numbering convention, and therefore
AC-1. Related: ADR-0001 (harness subsystem), `docs/SECURITY_FINDINGS.md` § S1,
`docs/planning/AGENT_HANDOFF.md` (2026-07-27 deployment review).
