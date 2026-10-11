// ---------------------------------------------------------------------------
// engine.mjs — observation in, judgement out. Shared by awe-inspect (look) and
// awe-cycle (look, then maybe act), so the two can never judge differently.
//
// FINDINGS (inspect.mjs) → AUTHORITY (authority.mjs) → PRIORITY (prioritize.mjs)
// → DECISION → WORK PACKAGE (work-package.mjs). Pure given `obs`.
// ---------------------------------------------------------------------------

import { inspect, gateIndex } from './inspect.mjs';
import { classify } from './authority.mjs';
import { prioritize, decide } from './prioritize.mjs';
import { generateWorkPackage } from './work-package.mjs';

export function judge(obs, { now, base = null }) {
  const plan = obs.plan?.plan;
  const ctx = {
    gates: gateIndex(obs.plan),
    currentGate: plan?.currentGate?.n ?? 1,
    grades: new Map((plan?.claims ?? []).map((c) => [c.id, c.grade])),
  };
  const findings = inspect(obs).map((x) => ({ ...x, authority: classify(x, obs.policy, obs.blockers) }));
  const ranked = prioritize(findings, ctx);
  const decision = decide(ranked, {
    engineeringVerdict: obs.engineering.autonomy.verdict,
    openAutonomyPrs: obs.autonomy_prs.unmerged_branches.length,
    prLimit: obs.autonomy_prs.limit,
  });
  const topMachine = ranked.find((x) => x.authority.class === 'MACHINE_EXECUTABLE' && x.action.kind !== 'observe-only') ?? null;
  const pkg = topMachine ? generateWorkPackage(topMachine, { policy: obs.policy, blockers: obs.blockers, now, base }) : null;
  return { plan, ctx, ranked, decision, topMachine, pkg };
}
