# Codex Handoff

- **Current branch:** `security/c1-policy-cleanup`
- **Latest commit hash:** `HEAD` on the branch above; resolve with
  `git rev-parse HEAD` (the concrete checkpoint hash is also reported in the
  task's final response)
- **Pre-task base commit:** `75c43c6e42de1bd5265e95c88ebd6ed94afaf383`
- **Task attempted:** Task 1 / Critical finding C1 only — promote and verify
  migration 0016 to remove the 16 undeclared client policies.
- **Current status:** Awaiting explicit approval for permanent live apply.
- **Files changed:** `docs/SECURITY_FINDINGS.md`,
  `docs/REGRESSION_CHECKLIST.md`, `docs/planning/CONTEXT.md`,
  `docs/planning/DECISION_LOG.md`, `docs/planning/SESSION_HANDOFF.md`,
  `docs/planning/TASK_BACKLOG.md`, `docs/planning/CODEX_HANDOFF.md`,
  `scripts/regression.sh`, `scripts/acceptance-s1-security.sh`,
  `scripts/s1-policy-cleanup-rehearsal.sql`,
  `scripts/s1-policy-cleanup-rollback.sql`, and
  `supabase/migrations/0016_drop_undeclared_client_policies.sql`.
- **Database changes:** None. All DDL validation ran inside transactions ending
  in `ROLLBACK`.
- **Commands run:** Exact live policy inventory query; full
  `source .env.acceptance && bash scripts/regression.sh`; existing S1 rehearsal
  through the management query API; migration 0016 wrapped in
  `BEGIN/ROLLBACK`; post-rollback catalog/function/probe verification; Git
  diff/static migration/secret-pattern checks.
- **Tests passed:** Mobile typecheck; web production build; MCP smoke (10 tools);
  acceptance slices 1–5 (`9/0`, `10/0`, `20/0`, `49/0`, `27/0`); S1 security
  (`14/0`, state `PENDING`); intake/classification/diff/matrix/queue runners
  (`24/0`, `20/0`, `120/0`, `314/0`, `325/0`); migration lints; 20-assertion
  rehearsal; migration postconditions under rollback.
- **Tests failed:** None.
- **Live changes applied:** None.
- **Live changes awaiting approval:** Apply only
  `supabase/migrations/0016_drop_undeclared_client_policies.sql`, dropping the
  exact 16 named policies and running its read-only postconditions.
- **Risks or blockers:** Explicit user approval is required. Possible breaking
  change is limited to an undocumented authenticated client depending on direct
  CRUD access to the four protected tables. The checked-in application, MCP,
  and current n8n state do not use those policies.
- **Recommended next task:** Obtain approval, recheck that live state is still
  exactly the expected 16-policy inventory, apply migration 0016, and run the
  required post-apply verification. Do not begin C2, C3, or C4.
- **Exact next prompt for a fresh Codex session:**  
  `Read docs/planning/CONTEXT.md, docs/planning/SESSION_HANDOFF.md,
  docs/planning/CODEX_HANDOFF.md, and docs/SECURITY_FINDINGS.md. Continue Task 1
  only on branch security/c1-policy-cleanup. Confirm explicit approval exists,
  re-query the exact 16-policy live inventory, and stop if it differs. If it
  matches, apply only
  supabase/migrations/0016_drop_undeclared_client_policies.sql using the reviewed
  management-API command. Then run scripts/acceptance-s1-security.sh and the full
  regression, verify S1 state APPLIED, verify worker denial and surviving
  internal trigger writes, verify zero probe residue and no secrets in the diff,
  update the requested Task 1 documentation and this handoff, commit, and push.
  Do not begin C2, C3, C4, or any other remediation.`
