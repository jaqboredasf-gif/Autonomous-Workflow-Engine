// ---------------------------------------------------------------------------
// inspect.mjs — from observations to findings, and nothing it cannot cite.
//
// Every rule here reads observations gathered by observe.mjs and emits a finding
// ONLY when the observation supports it. A finding carries:
//
//   kind        OBSERVED      the problem is a fact in the evidence
//               HYPOTHESIZED  a structural opportunity: the gap is observed, but
//                             whether the proposed remedy helps is a guess
//   evidence[]  the sources it rests on, each a file, command or record
//   claims[]    the venture claims it serves (programs/venture/claims.mjs ids)
//   action      what would address it, who would have to do it, and which
//               files it would touch; the authority classifier reads these
//   factors     the prioritizer's inputs, each with its reason
//
// Rules that would only brainstorm do not exist here. A capability that might
// be nice but has no probe, no evidence and no claim is not a finding.
//
// ANTI-JANITOR, built into the rules rather than bolted on: work that only
// tidies (lint, TODOs, renames) is emitted with north-star 0 and unlock 0
// unless an observation shows it blocks something that matters, so it can
// never outrank leverage by volume.
//
// Pure: no I/O, no clock (observations carry `observed_at`).
// ---------------------------------------------------------------------------

const f = (o) => Object.freeze({ kind: 'OBSERVED', confidence: 0.9, ...o });
const ev = (source, detail) => ({ source, detail });

/** The venture gate of each claim, read from the plan's own gate list. */
export function gateIndex(plan) {
  const m = new Map();
  for (const g of plan?.plan?.gates ?? []) for (const c of g.claims ?? []) if (!m.has(c)) m.set(c, g.n);
  return m;
}

export function inspect(obs) {
  const out = [];
  const plan = obs.plan?.plan ?? null;
  const claimsById = new Map((plan?.claims ?? []).map((c) => [c.id, c]));
  const grade = (id) => claimsById.get(id)?.grade ?? 'UNKNOWN';
  const factState = (id) => obs.human?.facts?.find((x) => x.id === id)?.state ?? 'UNKNOWN';
  const days = obs.iic?.days_to_deadline;

  // --- 1. The baseline: irreversible if missed -----------------------------
  if (obs.human?.baseline?.status === 'OPEN') {
    out.push(f({
      id: 'baseline-before-first-transaction',
      category: 'founder',
      finding: 'The Lippolis baseline has not been captured, and it must exist before the first real purchase runs through PCC.',
      evidence: [
        ev('autonomy/attestations.jsonl', `baseline_captured_before_first_transaction is ${factState('baseline_captured_before_first_transaction')}`),
        ev('npm run plan', `founder highest-leverage: ${plan?.founderHighestLeverage?.claim ?? '?'} (${plan?.founderHighestLeverage?.grade ?? '?'}) — ${plan?.founderHighestLeverage?.because ?? ''}`),
        ev('proof/baselines', `${obs.human.baseline.frozen_baselines} frozen baseline(s)`),
        ev('docs/proof/FIRST_REAL_PROOF_ACTIVATION.md', 'purchases raised before a baseline exists are permanently unvaluable'),
      ],
      claims: ['problem_economic', 'measurable_value'],
      action: { summary: 'Capture the baseline at Lippolis (docs/proof/BASELINE_DAY.md), freeze it, attest it', actor: 'JACK', touches: [], effort: 'MEDIUM' },
      factors: {
        value: [3, 'hours returned and the first case study cannot exist without it'],
        unlock: [3, 'unblocks problem_economic, then measurable_value (plan)'],
        risk: [3, 'missing it before the first real purchase loses that evidence permanently'],
        urgency: [3, 'must precede the first real transaction; irreversible'],
      },
      confidence: 1,
    }));
  }

  // --- 2. PCC is not installed: works_in_production ------------------------
  if (grade('works_in_production') !== 'MEASURED' && factState('pcc_installed_at_lippolis') !== 'HUMAN_VERIFIED') {
    const install = obs.readiness?.install?.verdict ?? 'UNKNOWN';
    out.push(f({
      id: 'install-pcc-at-lippolis',
      category: 'founder',
      finding: `PCC has never run in production. The machine evidence for the install says ${install}; the installation itself is a supervised human act on LIPELE-RDS02.`,
      evidence: [
        ev('npm run plan', `works_in_production ${grade('works_in_production')}: ${claimsById.get('works_in_production')?.because ?? ''}`),
        ev('npm run readiness', `install verdict ${install}${obs.verify.deploy?.fresh ? '' : ' (no fresh deploy verification for HEAD)'}`),
        ev('autonomy/attestations.jsonl', `pcc_installed_at_lippolis is ${factState('pcc_installed_at_lippolis')}`),
        ev('git', `${obs.product_line.ref} last commit ${obs.product_line.last_commit} (${obs.product_line.days_since_commit} days ago)`),
      ],
      claims: ['works_in_production', 'repeatable_deployment'],
      action: { summary: 'Install the signed release on LIPELE-RDS02 following docs/deployment/FIRST_LIPPOLIS_DEPLOYMENT.md, then attest each step', actor: 'JACK', touches: [], effort: 'HIGH', depends_on: ['lippolis-it-prerequisites'] },
      factors: {
        value: [3, 'the first production execution; every IIC claim after gate 1 waits on it'],
        unlock: [3, 'unblocks works_in_production → measurable_value → the case study'],
        risk: [1, 'machine evidence for the platform-neutral half is green; Windows half unproven'],
        urgency: [days !== null && days < 120 ? 3 : 2, `${days ?? '?'} days to the IIC evidence deadline (${obs.iic.evidence_deadline})`],
      },
      confidence: 1,
    }));
  }

  // --- 3. Lippolis IT prerequisites ----------------------------------------
  const itBlockers = (obs.gate?.blockers ?? []).filter((b) => b.owner === 'CUSTOMER_IT' || b.owner === 'SHARED');
  if (itBlockers.length || obs.lippolis_it?.outstanding_items?.length) {
    out.push(f({
      id: 'lippolis-it-prerequisites',
      category: 'external',
      finding: `Installation depends on Lippolis IT: ${itBlockers.length} deployment-gate fact(s) and ${obs.lippolis_it.outstanding_items.length} server prerequisite(s) listed as outstanding.`,
      evidence: [
        ...itBlockers.map((b) => ev(`pcc-deployment-gate:${b.path}`, `${b.owner}: ${b.reason ?? b.phase}`)),
        ev(obs.lippolis_it.source, `outstanding: ${obs.lippolis_it.outstanding_items.join('; ')}`),
      ],
      claims: ['works_in_production'],
      action: { summary: 'Lippolis IT installs Node 24, IIS, URL Rewrite, ARR and NSSM on RDS02 and answers hostname, boot start and backup rotation. Jack chases.', actor: 'EXTERNAL', touches: [], effort: 'MEDIUM' },
      factors: {
        value: [2, 'prerequisite to the installation'],
        unlock: [3, 'the installation cannot start without the server prerequisites'],
        risk: [1, 'status unknown, not known to be wrong'],
        urgency: [2, 'on the critical path to the first install'],
      },
      confidence: 0.9,
    }));
  }

  // --- 4. Customer discovery: the next founder claim ------------------------
  const disc = obs.plan?.facts?.discovery;
  if (disc && disc.externalInterviews === 0) {
    out.push(f({
      id: 'first-external-interview',
      category: 'evidence',
      finding: 'No interview with anyone outside Lippolis who does purchasing has been recorded; problem_real and every commercial claim start at zero.',
      evidence: [
        ev('npm run plan --json facts.discovery', `${disc.interviews} interview(s), ${disc.externalInterviews} external`),
        ev('npm run plan', `problem_real ${grade('problem_real')}; then-next founder action: ${plan?.founderHighestLeverage?.thenNext?.action ?? '?'}`),
        ev('programs/iic-2027/MASTER_SPEC.md', `evidence deadline ${obs.iic.evidence_deadline} (${days} days)`),
      ],
      claims: ['problem_real', 'external_pain'],
      action: { summary: 'Record one interview with a purchaser at another trades business (programs/discovery/interview.mjs protocol)', actor: 'JACK', touches: [], effort: 'LOW' },
      factors: {
        value: [2, 'first commercial evidence; IIC judges score market need'],
        unlock: [2, 'unblocks external_pain → external_want (plan)'],
        risk: [0, ''],
        urgency: [days !== null && days < 120 ? 2 : 1, `${days} days to the IIC evidence deadline`],
      },
      confidence: 1,
    }));
  }

  // --- 5. Verification exists only on unmerged branches --------------------
  const ciCap = obs.capabilities.find((c) => c.id === 'ci-on-product-line');
  if (ciCap?.result?.observable && !ciCap.result.present) {
    const open = obs.autonomy_prs.unmerged_branches;
    out.push(f({
      id: 'verification-not-on-product-line',
      category: 'infrastructure',
      finding: `pcc-production still runs no CI. The verification layer and deploy evidence exist only on ${open.length} unmerged autonomy branch(es) awaiting review.`,
      evidence: [
        ...ciCap.result.evidence.map((d) => ev('git', d)),
        ...open.map((b) => ev('git', `${b.branch}: ${b.ahead} commit(s) ahead of pcc-production, not merged`)),
        ev('autonomy/policy.json', `open autonomy PR limit ${obs.autonomy_prs.limit}`),
      ],
      // No claim: CI on the product line serves every claim indirectly and none
      // directly. The first version borrowed repeatable_deployment here and
      // ranked a review above the installation.
      claims: [],
      action: { summary: 'Review and merge the autonomy PRs (M2A first, then M2B), then require the AWE verify check on pcc-production', actor: 'JACK', touches: [], effort: 'LOW' },
      factors: {
        value: [1, 'turns verification into a property of the product line'],
        unlock: [2, 'every later autonomous cycle is limited by the open-PR cap until these land'],
        risk: [2, 'until merged, a push to pcc-production is unverified again'],
        urgency: [1, 'not on the install critical path'],
      },
      confidence: 1,
    }));
  }

  // --- 6. Windows install mechanics: no machine evidence --------------------
  const winCap = obs.capabilities.find((c) => c.id === 'windows-deploy-verification');
  if (winCap?.result?.observable && !winCap.result.present) {
    const rdsOnly = (obs.readiness?.untested_assumptions ?? []).filter((a) => /RDS02 only/.test(a.where_proven ?? ''));
    out.push(f({
      id: 'windows-install-unverified',
      kind: 'HYPOTHESIZED',
      category: 'capability',
      finding: `No machine has ever run the Windows install path (NSSM service, IIS/ARR, scheduled backup task); ${rdsOnly.length} deployment assumptions are listed as provable "RDS02 only".`,
      evidence: [
        ...winCap.result.evidence.map((d) => ev('repository', d)),
        ...rdsOnly.map((a) => ev('autonomy/deployment-readiness.json', `${a.id}: ${a.assumption}`)),
        ev('docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md', 'target: Windows Server 2019 Standard'),
      ],
      claims: ['works_in_production', 'repeatable_deployment'],
      action: {
        summary: 'A Windows runner job that runs Deploy-PCCProduction.ps1 against the release zip with NSSM, verifies health, installs the backup task and runs a restore (HYPOTHESIS: a GitHub Windows Server 2022 runner is close enough to RDS02 2019 to catch most script defects, not all)',
        actor: 'MACHINE', touches: ['.github/workflows/awe-verify.yml', 'autonomy/suites.json', 'scripts/eval-windows-install.ps1'], effort: 'MEDIUM',
      },
      factors: {
        value: [2, 'reduces the chance the first supervised install stalls on a script defect'],
        unlock: [1, 'makes install day shorter, not possible'],
        risk: [3, 'the only install path Lippolis will use has zero machine evidence'],
        urgency: [2, 'useful only before the install happens'],
      },
      confidence: 0.5,
    }));
  }

  // --- 7. Production evidence return path ----------------------------------
  const retCap = obs.capabilities.find((c) => c.id === 'production-evidence-return');
  if (retCap?.result?.observable && !retCap.result.present) {
    out.push(f({
      id: 'production-evidence-return',
      category: 'capability',
      finding: 'Nothing defines how production records reach the evidence layer. Plan and case study read the database only as a local file, neither ships to the server, and the server has no outbound network.',
      evidence: retCap.result.evidence.map((d) => ev('repository', d)),
      claims: ['works_in_production', 'measurable_value'],
      action: {
        summary: 'A read-only intake command that takes a verified backup copied off RDS02 (never into git), checks it is stamped production/lippolis and verifies, and runs plan/readiness/case-study against it; plus the one-page procedure for bringing the copy back',
        actor: 'MACHINE', touches: ['scripts/awe-production-intake.mjs', 'docs/proof/PRODUCTION_EVIDENCE_RETURN.md', 'scripts/eval-autonomy.mjs', 'package.json'], effort: 'MEDIUM',
        package: 'production-evidence-intake',
      },
      factors: {
        value: [2, 'the first measured outcome is computed from these records'],
        unlock: [2, 'measurable_value and the case study read through it once production exists'],
        risk: [1, 'without it the first figures are produced by hand, the failure the proof layer was built against'],
        urgency: [1, 'needed within weeks of installation, not before it'],
      },
      confidence: 0.8,
    }));
  }

  // --- 8. Open blockers: observe and escalate only -------------------------
  for (const b of obs.blockers.filter((x) => x.status !== 'RESOLVED')) {
    const d = obs.detections[b.id] ?? {};
    const notGating = (obs.readiness?.not_deployment_blockers ?? []).some((n) => n.id === b.id);
    out.push(f({
      id: `blocker-${b.id.toLowerCase()}`,
      category: b.id === 'S1' ? 'security' : 'governance',
      finding: `${b.id}: ${b.title}`,
      evidence: [
        ev('autonomy/blockers.json', `${b.status} / ${b.autonomous_action}`),
        ev(`detector:${b.detector}`, d.observable ? `still present: ${d.still_present}${d.unobservable_part ? `; unobservable: ${d.unobservable_part}` : ''}` : `unobservable: ${d.reason}`),
        ...(notGating ? [ev('autonomy/deployment-readiness.json', 'not a blocker for the SQLite pilot installation')] : []),
      ],
      claims: [],
      blocker: b.id,
      action: { summary: b.resolution_requires, actor: 'JACK', touches: b.forbidden_paths ?? [], effort: 'MEDIUM' },
      factors: {
        value: [b.id === 'S1' ? 1 : 0, b.id === 'S1' ? 'audit integrity on the hosted project' : ''],
        unlock: [b.id === 'MIGRATION-0016' || b.id === 'GOV-1' ? 1 : 0, 'schema and branch work stay closed until reconciled'],
        risk: [b.severity === 'critical' ? 3 : b.severity === 'high' ? 2 : 1, `severity ${b.severity}`],
        urgency: [notGating ? 0 : 1, notGating ? 'does not gate the first installation' : ''],
      },
      confidence: d.observable === false ? 0.7 : 0.9,
    }));
  }

  // --- 9. Verification evidence itself -------------------------------------
  const ci = obs.verify.ci;
  if (!ci || !ci.fresh) {
    out.push(f({
      id: 'verification-stale',
      category: 'reliability',
      finding: ci ? `The newest verification is for ${ci.commit?.slice(0, 7)}, not HEAD; the engineering state cannot be trusted for this commit.` : 'No verification result exists for this checkout.',
      evidence: [ev('.awe/verify.json', ci ? `commit ${ci.commit}` : 'absent')],
      claims: [],
      action: { summary: 'Run npm run verify on HEAD', actor: 'MACHINE', touches: [], effort: 'LOW', kind: 'observe-only' },
      factors: { value: [0, ''], unlock: [2, 'every other machine conclusion depends on it'], risk: [2, 'decisions on stale evidence'], urgency: [2, 'precedes any machine work'] },
      confidence: 1,
    }));
  }
  for (const s of (ci?.fresh ? ci.suites : []).filter((x) => x.status === 'FAIL' || (x.status === 'BLOCKED' && x.blocking))) {
    const janitor = !s.blocking && ['lint'].includes(s.category);
    out.push(f({
      id: `suite-${s.status.toLowerCase()}-${s.id}`,
      category: janitor ? 'debt' : 'reliability',
      finding: `${s.id} is ${s.status}${s.blocking ? ' (blocking)' : ' (non-blocking)'}: ${s.reason}`,
      evidence: [ev('.awe/verify.json', `${s.id} ${s.status} — ${s.reason}`)],
      claims: [],
      action: {
        summary: janitor ? `Fix the ${s.id} findings, then make the suite blocking` : `Root-cause and fix ${s.id}`,
        actor: 'MACHINE', touches: s.area === 'purchasing' ? ['apps/purchasing/src/'] : ['scripts/'], effort: janitor ? 'LOW' : 'MEDIUM',
      },
      factors: janitor
        ? { value: [0, 'tidiness; nothing observed depends on it'], unlock: [0, ''], risk: [1, 'lint errors can hide real defects'], urgency: [0, ''] }
        : { value: [2, 'a red blocking suite stops all machine work'], unlock: [3, ''], risk: [3, ''], urgency: [3, ''] },
      confidence: 1,
    }));
  }

  // --- 10. TODO markers on the deployed path --------------------------------
  // Reported only as a count; never a work item on its own. A marker is a note,
  // not evidence of a defect.
  if (obs.todos.markers.length) {
    out.push(f({
      id: 'todo-markers-deployed-path',
      category: 'debt',
      finding: `${obs.todos.markers.length} TODO/FIXME marker(s) on the deployed path.`,
      evidence: obs.todos.markers.slice(0, 5).map((m) => ev(`${m.file}:${m.line}`, m.text)),
      claims: [],
      action: { summary: 'Review the markers', actor: 'MACHINE', touches: obs.todos.markers.map((m) => m.file), effort: 'LOW' },
      factors: { value: [0, ''], unlock: [0, ''], risk: [0, 'a marker is not a defect'], urgency: [0, ''] },
      confidence: 0.5,
    }));
  }

  return out;
}
