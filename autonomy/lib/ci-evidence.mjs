// ---------------------------------------------------------------------------
// ci-evidence.mjs — what the authoritative runner said about one exact commit.
//
// The local container is not the authority on whether the code is green. It
// runs as root (auth-recovery is BLOCKED there by design) and may be dirty or
// behind. GitHub Actions runs the registered ci profile on a clean checkout of
// one commit, and the `verify` job exits non-zero on any blocking FAIL or
// BLOCKED (.github/workflows/awe-verify.yml). So "the verify check concluded
// success for commit X" is exactly "every blocking suite passed on X".
//
// The engine itself makes no network call. A check-runs document (the shape
// GitHub's REST API and the GitHub MCP tools both return) is imported by
// whoever can read it, into .awe/ci/<commit>.json, with where it came from.
// The record names the run ids and URLs, so a person can check it.
//
// Pure.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/** The job whose conclusion is the verdict. Others (deploy evidence) are reported, not required. */
export const REQUIRED_CHECK = 'verify';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Build a record from a check-runs document for `commit`.
 *   checkRuns: { check_runs: [{ id, name, status, conclusion, html_url, head_sha?, completed_at }] }
 */
export function fromCheckRuns(checkRuns, { commit, ref = null, importedBy, importedAt }) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('commit must be a full 40-character sha');
  const runs = checkRuns?.check_runs ?? [];
  const mismatched = runs.filter((r) => r.head_sha && r.head_sha !== commit);
  if (mismatched.length) throw new Error(`check run(s) ${mismatched.map((r) => r.id).join(', ')} are for ${mismatched[0].head_sha}, not ${commit}`);
  return {
    schema: 'awe.ci-evidence/1',
    commit,
    ref,
    imported_at: importedAt,
    imported_by: importedBy,
    checks: runs.map((r) => ({
      id: r.id, name: r.name, status: r.status, conclusion: r.conclusion ?? null,
      url: r.html_url ?? r.details_url ?? null, completed_at: r.completed_at ?? null,
    })),
    source_sha256: sha256(JSON.stringify(checkRuns)),
  };
}

/**
 * PASS / FAIL / PENDING / ABSENT for `commit`. Only the required check decides.
 * A record for another commit is ABSENT for this one, never borrowed.
 */
export function ciVerdict(record, commit) {
  if (!record) return { status: 'ABSENT', detail: 'no CI evidence imported for this commit' };
  if (record.schema !== 'awe.ci-evidence/1') return { status: 'ABSENT', detail: `unknown schema ${record.schema}` };
  if (record.commit !== commit) return { status: 'ABSENT', detail: `CI evidence is for ${record.commit?.slice(0, 12)}, not ${commit?.slice(0, 12)}` };
  const req = record.checks.filter((c) => c.name === REQUIRED_CHECK);
  if (!req.length) return { status: 'ABSENT', detail: `no "${REQUIRED_CHECK}" check run for ${commit.slice(0, 12)}` };
  // The newest run decides (a re-run supersedes); ties broken by id.
  const latest = [...req].sort((a, b) => String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? '')) || b.id - a.id)[0];
  const others = record.checks.filter((c) => c.name !== REQUIRED_CHECK).map((c) => `${c.name}: ${c.conclusion ?? c.status}`);
  const base = { check: latest, others };
  if (latest.status !== 'completed') return { ...base, status: 'PENDING', detail: `${REQUIRED_CHECK} is ${latest.status}` };
  if (latest.conclusion === 'success') return { ...base, status: 'PASS', detail: `${REQUIRED_CHECK} succeeded on ${commit.slice(0, 12)} (${latest.url})` };
  return { ...base, status: 'FAIL', detail: `${REQUIRED_CHECK} concluded ${latest.conclusion} on ${commit.slice(0, 12)} (${latest.url})` };
}
