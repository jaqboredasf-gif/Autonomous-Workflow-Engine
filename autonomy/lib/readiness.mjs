// ---------------------------------------------------------------------------
// readiness.mjs — how confident should we be that the first Lippolis
// installation works, and what is that confidence made of?
//
// The answer is deliberately two answers, because they fail differently:
//
//   install          can Jack install PCC on LIPELE-RDS02 and expect it to
//                    start, persist, back up and restore? Machine evidence
//                    answers the platform-neutral half; the Windows half is
//                    named, never assumed.
//   first_transaction may a REAL purchase go through it yet? Closed until the
//                    people-facts are attested, the baseline first of all.
//
// THERE IS NO "PRODUCTION READY". Green suites mean the parts a machine can
// exercise behaved. The strongest install verdict this can produce is
// READY_FOR_SUPERVISED_FIRST_INSTALL, and it always comes with the list of
// what only the server can prove.
//
// Each machine answer is VERIFIED only if EVERY evidence suite PASSED in the
// verification run being read. One FAIL makes it FAILED. Anything else (BLOCKED,
// SKIPPED, absent) leaves it UNVERIFIED, with the reasons, because a question
// nobody managed to ask has not been answered.
//
// Pure: no clock, no I/O. The caller supplies verify, gate, facts and now.
// ---------------------------------------------------------------------------

export function answerQuestion(q, suitesById) {
  const rows = q.evidence.map((id) => {
    const s = suitesById.get(id);
    return s
      ? { suite: id, status: s.status, reason: s.reason ?? null, duration_ms: s.duration_ms ?? null }
      : { suite: id, status: 'ABSENT', reason: 'not in this verification run' };
  });
  const statics = (q.static_evidence ?? []).map((id) => ({ suite: id, status: suitesById.get(id)?.status ?? 'ABSENT', kind: 'static' }));
  const machine = rows.some((r) => r.status === 'FAIL') ? 'FAILED'
    : rows.every((r) => r.status === 'PASS') ? 'VERIFIED' : 'UNVERIFIED';
  return { machine, evidence: rows, static_evidence: statics };
}

const factState = (facts, id) => facts.find((f) => f.id === id)?.state ?? 'UNKNOWN';

export function deriveReadiness({ spec, verify, gate, facts, baseline, blockers = [], release = null, now }) {
  const suitesById = new Map((verify?.suites ?? []).map((s) => [s.id, s]));

  const questions = spec.questions.map((q) => {
    const a = answerQuestion(q, suitesById);
    const lippolis = q.lippolis_facts.map((id) => ({ fact: id, state: factState(facts, id) }));
    const lippolisVerified = lippolis.every((l) => l.state === 'HUMAN_VERIFIED' || l.state === 'MACHINE_VERIFIED');
    return {
      id: q.id, question: q.question,
      machine: a.machine,
      lippolis: lippolisVerified ? 'VERIFIED_AT_LIPPOLIS' : 'NOT_YET_PROVEN_AT_LIPPOLIS',
      evidence: a.evidence, static_evidence: a.static_evidence,
      proves: q.proves, does_not_prove: q.does_not_prove, lippolis_facts: lippolis,
    };
  });

  // WHAT WOULD CURRENTLY PREVENT DEPLOYMENT, each with its owner and source.
  const preventing = [];
  if (!verify) preventing.push({ owner: 'AWE', source: 'verify.json', what: 'no deployment verification run was supplied' });
  else {
    if (verify.profile !== 'deploy') preventing.push({ owner: 'AWE', source: 'verify.json', what: `verification profile is "${verify.profile}", not "deploy"; container evidence was not collected` });
    if (verify.tree?.dirty !== false) preventing.push({ owner: 'AWE', source: 'verify.json', what: 'verification ran on a dirty or unknown tree; it is not evidence about any commit' });
  }
  for (const q of questions.filter((x) => x.machine === 'FAILED')) {
    preventing.push({ owner: 'AWE', source: q.evidence.filter((e) => e.status === 'FAIL').map((e) => `suite:${e.suite}`).join(', '),
      what: `${q.question} — machine evidence FAILED` });
  }
  if (!gate) preventing.push({ owner: 'AWE', source: 'pcc-deployment-gate --json', what: 'deployment gate could not be read' });
  else {
    for (const b of gate.blockers ?? []) {
      preventing.push({ owner: b.owner, source: `deployment-gate:${b.path}`, phase: b.phase, what: b.reason ?? b.path });
    }
  }
  // THE EVIDENCE MUST BE ABOUT THE CODE THAT SHIPS. The installation is of the
  // signed commit (deployment/APPROVED_RELEASE.md), not of whatever was tested.
  if (!release?.approved_commit) {
    preventing.push({ owner: 'JACK', source: 'deployment/APPROVED_RELEASE.md', what: 'no signed release: nothing is approved to install' });
  } else if (release.application_identical === false) {
    preventing.push({ owner: 'JACK', source: 'deployment/APPROVED_RELEASE.md',
      what: `application code differs between the signed ${release.approved_commit} and the verified ${release.evidence_commit?.slice(0, 7)}: re-sign the release, or verify the signed commit (${release.application_differs.join(', ')})` });
  }
  for (const f of facts.filter((x) => x.required_before === 'installation' && x.state !== 'HUMAN_VERIFIED')) {
    preventing.push({ owner: 'JACK', source: `attestation:${f.id}`, what: f.statement, phase: 'BEFORE_INSTALL' });
  }

  const unverified = questions.filter((q) => q.machine === 'UNVERIFIED');
  const installVerdict =
    preventing.some((p) => p.owner === 'AWE' || p.source === 'deployment/APPROVED_RELEASE.md') ? 'NOT_READY'
    : unverified.length ? 'MACHINE_EVIDENCE_INCOMPLETE'
    : (gate?.verdict === 'DEPLOY_ONLY' || gate?.verdict === 'GO_LIVE') ? 'READY_FOR_SUPERVISED_FIRST_INSTALL'
    : 'NOT_READY';

  const firstTxnRequired = facts.filter((f) => f.required_before === 'first_real_transaction');
  const firstTxnOpen = firstTxnRequired.filter((f) => f.state !== 'HUMAN_VERIFIED');

  return {
    schema: 'awe.deployment-readiness/1',
    generated_at: now,
    commit: verify?.tree?.commit ?? null,
    verification: verify ? { run_id: verify.run_id, profile: verify.profile, finished_at: verify.finished_at,
      host: verify.host, summary: verify.summary } : null,
    target: spec.target,
    release,
    baseline: baseline,
    banner: baseline?.banner ?? null,
    install: {
      verdict: installVerdict,
      means: {
        NOT_READY: 'something AWE owns is failing or missing; do not install',
        MACHINE_EVIDENCE_INCOMPLETE: 'nothing is failing, but some questions were not asked (BLOCKED/SKIPPED); not enough evidence to recommend installing',
        READY_FOR_SUPERVISED_FIRST_INSTALL: 'every platform-neutral question passed on this commit; the Windows half is unproven and is proven by doing the installation, supervised, with the runbook',
      }[installVerdict],
      never: 'This never says PRODUCTION READY. It cannot see LIPELE-RDS02.',
    },
    first_transaction: {
      verdict: firstTxnOpen.length ? 'NOT_CLEARED' : 'CLEARED',
      requires: firstTxnRequired.map((f) => ({ fact: f.id, state: f.state })),
      open: firstTxnOpen.map((f) => f.id),
    },
    questions,
    preventing_deployment: preventing,
    untested_assumptions: spec.untested_assumptions,
    requires_lippolis: facts.filter((f) => f.required_before).map((f) => ({ fact: f.id, state: f.state, required_before: f.required_before })),
    not_deployment_blockers: spec.not_deployment_blockers,
    open_repository_blockers: blockers.filter((b) => b.status !== 'RESOLVED').map((b) => b.id),
  };
}
