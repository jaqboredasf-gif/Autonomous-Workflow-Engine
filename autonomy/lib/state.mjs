// ---------------------------------------------------------------------------
// state.mjs — the engineering state, derived from evidence and nothing else.
//
// The question a future Inspector asks is not "what did the logs say" but "is
// autonomous engineering safe to proceed on this commit, and if not, why". This
// function answers it from three inputs, each of which is a file a reader can
// check: the verification result, the blocker registry and the policy.
//
// THE VERDICT, strictest first. Every reason is listed, not just the first:
//
//   NOT_SAFE                   the evidence cannot support any autonomous
//                              change: no verification, verification of a
//                              different commit or a dirty tree, a partial run,
//                              an invalid registry, a blocking FAIL, or a
//                              blocking suite BLOCKED (state unknown is not
//                              state good).
//   PROCEED_WITH_RESTRICTIONS  the product line is green, but open blockers
//                              close paths. The closed paths are listed.
//   SAFE_TO_PROCEED            green, and nothing closed beyond standing L3.
//
// AUTHORITATIVE CI. When `ci` (ci-evidence.mjs ciVerdict) is PASS for HEAD,
// CI is the verification: a clean runner verified this exact commit, so a
// local BLOCKED (the root container, a missing daemon) is an environment
// note, not a repository verdict, and a stale or absent local run does not
// matter. Two things still make it NOT_SAFE: CI FAIL, and a local blocking FAIL
// on the same clean commit, because local and authoritative verification then
// disagree, and disagreement is a reason to stop (AGENTS.md), not to pick one.
// PENDING or ABSENT CI falls back to the local run, exactly as before.
//
// "Safe to proceed" means only "an L2 change outside the closed paths would
// start from a verified-green, attributable base". It never authorizes an L3
// act; nothing in this file can.
//
// Pure: no clock (the caller passes `now`), no I/O.
// ---------------------------------------------------------------------------

import { closedPaths, openBlockers } from './guard.mjs';

export function deriveEngineeringState({ verify, verifyError = null, blockers, policy, detections = {}, head, now, human = null, ci = null }) {
  const reasons = [];
  const notes = [];
  const notSafe = (r) => reasons.push({ level: 'NOT_SAFE', reason: r });
  const ciPass = ci?.status === 'PASS';

  if (ci?.status === 'FAIL') notSafe(`authoritative CI: ${ci.detail}`);
  if (ciPass) {
    const sameClean = verify && verify.tree?.commit === head && verify.tree?.dirty === false;
    if (!verify) notes.push(`no local verification${verifyError ? ` (${verifyError})` : ''}; authoritative CI verified this commit`);
    else if (!sameClean) notes.push(`local verification is not of this clean commit; authoritative CI verified it`);
    else {
      for (const s of verify.suites.filter((x) => x.blocking && x.status === 'FAIL')) {
        notSafe(`local blocking suite ${s.id} FAILED on the commit CI passed: local and authoritative verification disagree (${s.reason})`);
      }
      for (const s of verify.suites.filter((x) => x.blocking && x.status === 'BLOCKED')) {
        notes.push(`local suite ${s.id} BLOCKED by this environment (${s.reason}); CI ran it`);
      }
    }
  } else if (!verify) notSafe(`no verification result${verifyError ? `: ${verifyError}` : ''}`);
  else {
    if (verify.registry?.errors?.length) notSafe(`registry invalid: ${verify.registry.errors.length} error(s)`);
    if (verify.selection?.only?.length) notSafe(`partial run (--only ${verify.selection.only.join(', ')}) cannot establish state`);
    if (verify.profile !== 'ci') notSafe(`run used profile "${verify.profile}", not "ci"`);
    if (head && verify.tree?.commit !== head) notSafe(`verification is of ${verify.tree?.commit?.slice(0, 12)}, not HEAD ${head.slice(0, 12)}`);
    if (verify.tree?.dirty !== false) notSafe(`verification ran on a ${verify.tree?.dirty === null ? 'unknown' : 'dirty'} working tree; results are not attributable to a commit`);
    for (const s of verify.suites.filter((x) => x.blocking && x.status === 'FAIL')) {
      notSafe(`blocking suite ${s.id} FAILED: ${s.reason}`);
    }
    for (const s of verify.suites.filter((x) => x.blocking && x.status === 'BLOCKED')) {
      notSafe(`blocking suite ${s.id} BLOCKED: ${s.reason}`);
    }
  }

  const open = openBlockers(blockers);
  if (!reasons.length && open.length) {
    reasons.push({ level: 'PROCEED_WITH_RESTRICTIONS',
      reason: `${open.length} open blocker(s) close paths to autonomous change: ${open.map((b) => b.id).join(', ')}` });
  }
  const verdict = reasons.some((r) => r.level === 'NOT_SAFE') ? 'NOT_SAFE'
    : reasons.length ? 'PROCEED_WITH_RESTRICTIONS' : 'SAFE_TO_PROCEED';

  const by = (status) => (verify?.suites ?? []).filter((s) => s.status === status)
    .map((s) => ({ id: s.id, blocking: s.blocking, criticality: s.criticality, reason: s.reason }));

  return {
    schema: 'awe.engineering-state/1',
    generated_at: now,
    // With CI as the verification, the state is about HEAD, whatever a stale local run says.
    commit: ciPass ? head : verify?.tree?.commit ?? head ?? null,
    head,
    branch: verify?.tree?.branch ?? null,
    verification_source: ciPass ? 'ci' : verify ? 'local' : null,
    ci: ci ? { status: ci.status, detail: ci.detail, run: ci.check?.url ?? null } : null,
    notes,
    verification: verify ? {
      run_id: verify.run_id,
      verdict: verify.verdict,
      profile: verify.profile,
      finished_at: verify.finished_at,
      summary: verify.summary,
      registry_sha256: verify.registry?.sha256 ?? null,
    } : null,
    suites: { passed: by('PASS'), failed: by('FAIL'), blocked: by('BLOCKED'), skipped: by('SKIPPED') },
    known_debt: by('FAIL').filter((s) => !s.blocking),
    blockers: blockers.map((b) => ({
      id: b.id, title: b.title, status: b.status, autonomous_action: b.autonomous_action,
      severity: b.severity, forbidden_paths: b.forbidden_paths, forbidden_refs: b.forbidden_refs,
      observed: detections[b.id] ?? { observable: false, reason: 'not run' },
      note: detections[b.id]?.observable && detections[b.id].still_present === false
        ? 'Detector suggests this may be resolved. Status changes only when a human updates autonomy/blockers.json.'
        : undefined,
    })),
    // Human facts are reported, never used to decide `verdict`: engineering may
    // proceed while nobody has been to Lippolis. The baseline banner rides along
    // so no reader of this file can miss it.
    banner: human?.baseline?.banner ?? null,
    baseline: human?.baseline ?? null,
    human_facts: human ? human.facts.map((f) => ({ id: f.id, state: f.state, attested_by: f.attested_by ?? null, date: f.date ?? null })) : null,
    autonomy: {
      verdict,
      safe_to_proceed: verdict !== 'NOT_SAFE',
      reasons,
      closed_paths: closedPaths(policy, blockers),
      limits: policy.limits,
      reminder: 'Even when safe_to_proceed is true, L3 acts (merge, deploy, migrations, auth, secrets, CI, external communication) require Jack.',
    },
  };
}
