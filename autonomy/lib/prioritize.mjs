// ---------------------------------------------------------------------------
// prioritize.mjs — what matters most, by a rule anyone can read and argue with.
//
// It composes with the venture plan rather than replacing it. North-Star
// alignment is the plan's own gate order: a finding that serves a claim in the
// CURRENT gate outranks one that serves a later gate, exactly as `npm run plan`
// ranks claims. Then it adds what the plan cannot see: engineering risk,
// external dependencies, and the cost of the machine's own work to Jack.
//
// THE SCORE, in full, printed with every finding:
//
//   value  = 5·north_star + 2·business_value + 2·unlock + 2·risk + 2·urgency
//            (each factor 0–3, set by the inspector rule with its reason)
//   score  = value × confidence ÷ effort_weight
//   effort_weight: LOW 1 · MEDIUM 1.25 · HIGH 1.5
//
// WHY NORTH STAR WEIGHS 5 AND EFFORT SO LITTLE. The first version weighted
// them 3 and up to 2, and on the real repository it ranked "one discovery
// interview" above "install PCC", because the install is hard. The plan's
// own rule is gate first, and the install is the gate-2 critical path.
// A weighted sum cannot guarantee that effort never reorders tiers; these
// weights make effort a mild divisor (at most 1.5) so it rarely does, and the
// case that motivated the change is pinned by a test on the real situation.
//
// DEPENDENCIES INHERIT. A finding that another finding depends on
// (action.depends_on) scores at least as high as what it blocks, and says so
// in its breakdown. The thing in the way of the most important thing IS the
// most important thing.
//
// north_star: 3 if a claim it serves is in the plan's current gate (or an
// earlier gate still unmeasured), 2 if the next gate, 1 if later, 0 if none.
// Confidence comes from the finding: OBSERVED facts near 1, HYPOTHESIZED
// opportunities at most 0.5, so a guess never outranks an equal fact.
//
// Pure: no I/O, no clock.
// ---------------------------------------------------------------------------

export const EFFORT_WEIGHT = Object.freeze({ LOW: 1, MEDIUM: 1.25, HIGH: 1.5 });
export const NORTH_STAR_WEIGHT = 5;
export const HYPOTHESIS_CONFIDENCE_CAP = 0.5;

export function northStar(finding, gates, currentGate, grades) {
  const ns = finding.claims
    .filter((c) => grades.get(c) !== 'MEASURED')
    .map((c) => gates.get(c))
    .filter((g) => g !== undefined)
    .map((g) => (g <= currentGate ? 3 : g === currentGate + 1 ? 2 : 1));
  return ns.length ? Math.max(...ns) : 0;
}

export function score(finding, ctx) {
  const ns = northStar(finding, ctx.gates, ctx.currentGate, ctx.grades);
  const [value, unlock, risk, urgency] = ['value', 'unlock', 'risk', 'urgency'].map((k) => finding.factors[k]?.[0] ?? 0);
  const raw = NORTH_STAR_WEIGHT * ns + 2 * value + 2 * unlock + 2 * risk + 2 * urgency;
  const confidence = finding.kind === 'HYPOTHESIZED' ? Math.min(finding.confidence, HYPOTHESIS_CONFIDENCE_CAP) : finding.confidence;
  const effort = EFFORT_WEIGHT[finding.action.effort] ?? 1.5;
  return {
    score: Math.round((raw * confidence / effort) * 10) / 10,
    breakdown: {
      north_star: [ns, ns ? `serves ${finding.claims.join(', ')} (gate ${Math.min(...finding.claims.map((c) => ctx.gates.get(c) ?? 99))}; current gate ${ctx.currentGate})` : 'serves no unmeasured claim'],
      business_value: finding.factors.value, unlock: finding.factors.unlock, risk: finding.factors.risk, urgency: finding.factors.urgency,
      raw, confidence, effort: [finding.action.effort, effort],
      formula: '(5·north_star + 2·value + 2·unlock + 2·risk + 2·urgency) × confidence ÷ effort',
    },
  };
}

export function prioritize(findings, ctx) {
  const scored = findings.map((x) => ({ ...x, priority: score(x, ctx) }));
  const byId = new Map(scored.map((x) => [x.id, x]));
  for (const x of scored) {
    for (const dep of x.action.depends_on ?? []) {
      const d = byId.get(dep);
      if (d && d.priority.score < x.priority.score) {
        d.priority = { ...d.priority, score: x.priority.score, breakdown: { ...d.priority.breakdown,
          inherited_from: [x.id, `on the critical path of ${x.id}; own score ${d.priority.score}`] } };
      }
    }
  }
  return scored
    .sort((a, b) => b.priority.score - a.priority.score
      || (a.kind === 'OBSERVED' ? -1 : 1) - (b.kind === 'OBSERVED' ? -1 : 1)
      || a.id.localeCompare(b.id));
}

/**
 * SHOULD THE MACHINE BUILD ANYTHING NOW? Every condition is a reason, and all
 * of them are reported. "No" is a first-class answer: every PR the machine
 * opens spends the attention of the one person every gate is waiting on.
 */
export function decide(ranked, { engineeringVerdict, openAutonomyPrs, prLimit, minScore = 8 }) {
  const top = ranked[0] ?? null;
  const machine = ranked.find((x) => x.authority?.class === 'MACHINE_EXECUTABLE' && x.action.kind !== 'observe-only') ?? null;
  const reasons = [];
  if (!machine) reasons.push('no finding is both machine-executable and inside autonomous authority');
  if (engineeringVerdict === 'NOT_SAFE') reasons.push('the engineering state is NOT_SAFE for this commit; no change may start from it');
  if (openAutonomyPrs >= prLimit) reasons.push(`${openAutonomyPrs} autonomy PR(s) already await review (limit ${prLimit}); another would queue behind the same reviewer`);
  if (machine && machine.priority.breakdown.north_star[0] === 0) reasons.push(`the best machine action (${machine.id}) serves no unmeasured North Star claim: tidying, not leverage`);
  if (machine && machine.priority.score < minScore) reasons.push(`the best machine action scores ${machine.priority.score}, below the ${minScore} floor`);
  const humanTop = top && ['JACK_ACTION_REQUIRED', 'EXTERNAL_DEPENDENCY'].includes(top.authority?.class);
  const build = reasons.length === 0;
  return {
    build,
    headline: build
      ? `BUILD: ${machine.id} (score ${machine.priority.score})`
      : humanTop
        ? 'DO NOT BUILD ANYTHING. JACK IS THE BOTTLENECK.'
        : 'DO NOT BUILD ANYTHING NOW.',
    reasons,
    top: top ? { id: top.id, score: top.priority.score, authority: top.authority?.class } : null,
    best_machine: machine ? { id: machine.id, score: machine.priority.score } : null,
  };
}
