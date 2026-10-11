// ---------------------------------------------------------------------------
// awe-inspect.mjs — what matters next, and may the machine do it?
//
//   npm run inspect                 # human report + .awe/inspection.json
//   npm run inspect -- --json       # the record only
//
// OBSERVE (observe.mjs) → FINDINGS (inspect.mjs) → AUTHORITY (authority.mjs)
// → PRIORITY (prioritize.mjs) → DECISION → WORK PACKAGE (work-package.mjs).
//
// It reads the evidence the other commands produce and does not run suites
// itself: run `npm run verify` (and the deploy profile) first, or it reports
// the evidence as stale, which is itself a finding.
//
// It changes nothing and dispatches nothing. Acting on the decision is
// scripts/awe-cycle.mjs, which uses the same judgement (autonomy/lib/engine.mjs).
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observe } from '../autonomy/lib/observe.mjs';
import { judge } from '../autonomy/lib/engine.mjs';
import { git } from '../autonomy/lib/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');
const now = new Date();

const obs = await observe(ROOT, { now });
const productRef = obs.product_line.ref;
const { plan, ctx, ranked, decision, topMachine, pkg } = judge(obs, {
  now: now.toISOString(),
  base: { ref: productRef, commit: git(ROOT, ['rev-parse', productRef]) },
});

const record = {
  schema: 'awe.inspection/1',
  inspected_at: now.toISOString(),
  commit: obs.head, branch: obs.branch, dirty: obs.dirty,
  north_star: { current_gate: plan?.currentGate ?? null, next_gate: plan?.nextGate ?? null,
    iic_deadline: obs.iic.evidence_deadline, days_to_deadline: obs.iic.days_to_deadline, baseline: obs.human.baseline.status },
  state: {
    engineering: obs.engineering.autonomy.verdict,
    verification_source: obs.engineering.verification_source,
    ci: obs.verify.authoritative,
    verification: obs.verify.ci ? { commit: obs.verify.ci.commit, fresh: obs.verify.ci.fresh, verdict: obs.verify.ci.verdict } : null,
    deploy_verification: obs.verify.deploy ? { commit: obs.verify.deploy.commit, fresh: obs.verify.deploy.fresh } : null,
    install_readiness: obs.readiness.install.verdict,
    product_line: obs.product_line,
    open_autonomy_prs: obs.autonomy_prs,
  },
  findings: ranked,
  decision,
  work_package: pkg,
};
mkdirSync(join(ROOT, '.awe'), { recursive: true });
writeFileSync(join(ROOT, '.awe/inspection.json'), JSON.stringify(record, null, 2) + '\n');

if (asJson) { console.log(JSON.stringify(record, null, 2)); process.exit(0); }

const line = '─'.repeat(78);
if (obs.human.baseline.banner) console.log(`${'!'.repeat(78)}\n  ${obs.human.baseline.banner}\n${'!'.repeat(78)}`);
console.log(`AWE INSPECTION — ${obs.head?.slice(0, 7)}${obs.dirty ? ' (dirty)' : ''} — gate ${ctx.currentGate} "${plan?.currentGate?.name}" — ${obs.iic.days_to_deadline} days to IIC evidence deadline`);
console.log(`engineering ${obs.engineering.autonomy.verdict} (verification: ${obs.engineering.verification_source ?? 'none'}; CI ${obs.verify.authoritative.status}) · install ${obs.readiness.install.verdict} · product line last commit ${obs.product_line.days_since_commit} days ago · ${obs.autonomy_prs.unmerged_branches.length}/${obs.autonomy_prs.limit} autonomy PRs open`);
console.log(`\n${line}\n  ${decision.headline}\n${line}`);
for (const r of decision.reasons) console.log(`  · ${r}`);

console.log(`\nTOP FINDINGS (score = (5·NS + 2·value + 2·unlock + 2·risk + 2·urgency) × confidence ÷ effort)\n`);
ranked.slice(0, 10).forEach((x, i) => {
  const b = x.priority.breakdown;
  console.log(`${String(i + 1).padStart(2)}. [${x.priority.score.toFixed(1).padStart(4)}] ${x.authority.class.padEnd(23)} ${x.kind === 'HYPOTHESIZED' ? 'HYPOTHESIS ' : ''}${x.id}`);
  console.log(`    ${x.finding}`);
  console.log(`    NS ${b.north_star[0]} · value ${b.business_value[0]} · unlock ${b.unlock[0]} · risk ${b.risk[0]} · urgency ${b.urgency[0]} · conf ${b.confidence} · effort ${b.effort[0]}`);
  for (const e of x.evidence.slice(0, 3)) console.log(`      ↳ ${e.source}: ${String(e.detail).slice(0, 140)}`);
  console.log(`    → ${x.action.summary.slice(0, 160)}`);
});
const firstOf = (cls) => ranked.find((x) => x.authority.class === cls);
console.log(`\n${line}`);
for (const cls of ['MACHINE_EXECUTABLE', 'HUMAN_APPROVAL_REQUIRED', 'JACK_ACTION_REQUIRED', 'EXTERNAL_DEPENDENCY', 'BLOCKED']) {
  const x = cls === 'MACHINE_EXECUTABLE' ? topMachine : firstOf(cls);
  console.log(`TOP ${cls.padEnd(24)} ${x ? `${x.id} (${x.priority.score})` : '—'}`);
}
if (pkg) console.log(`\nWORK PACKAGE ${pkg.id}: ${pkg.status} — ${pkg.objective.slice(0, 120)}`);
console.log('\nwrote .awe/inspection.json');
