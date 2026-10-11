// ---------------------------------------------------------------------------
// awe-cycle.mjs — one supervised improvement cycle, step by step, on the record.
//
//   npm run cycle -- start                    observe, judge, and either stop or
//                                             prepare ONE package + worktree
//   npm run cycle -- dispatch                 mark the Builder dispatched (attempt n)
//   npm run cycle -- collect [--report f]     commit what the Builder left, if in scope
//   npm run cycle -- push                     push autonomy/<cycle> (fast-forward only)
//   npm run cycle -- evaluate [--review f]    the independent verdict
//   npm run cycle -- pr --url U --number N    record the draft PR a person will review
//   npm run cycle -- finish                   Captain Brief + record + ledger line
//   npm run cycle -- status | verify-ledger
//
// WHO DOES WHAT. This script judges, records and holds the hands (hands.mjs).
// The Builder is a separate agent session given only builder-brief.md; it edits
// files in the cycle's worktree and nothing else. The supervisor (today a
// person-supervised Claude session; later a scheduler) runs these steps,
// imports CI evidence (scripts/awe-ci-evidence.mjs), obtains the fresh-session
// review, and opens the draft PR. Nothing here merges, deploys or writes to
// production, and no step can be skipped: each refuses to run out of order.
//
// State lives in .awe/cycles/<id>/ while the cycle runs; `finish` writes the
// durable record to autonomy/cycles/ for the supervisor to commit.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { observe, loadCiEvidence } from '../autonomy/lib/observe.mjs';
import { judge } from '../autonomy/lib/engine.mjs';
import { git } from '../autonomy/lib/git.mjs';
import { ciVerdict } from '../autonomy/lib/ci-evidence.mjs';
import { evaluate } from '../autonomy/lib/evaluate.mjs';
import { changesOf as diffChanges } from '../autonomy/lib/diff.mjs';
import { createWorktree, commitBuild, pushBranch, checkoutForEvaluation, removeEvaluationCheckout, configFingerprint, checkWorktreeIdentity, SAFE } from '../autonomy/lib/hands.mjs';
import { newCycleId, advance, ledgerEntry, verifyLedger, expectedImpact, renderBrief, sha256 } from '../autonomy/lib/cycle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const die = (m, code = 2) => { console.error(`awe-cycle: ${m}`); process.exit(code); };
const nowIso = () => new Date().toISOString();
const readText = (p) => readFileSync(p, 'utf8');
const fileHash = (p) => (existsSync(p) ? sha256(readText(p)) : null);

const CYCLES = join(ROOT, '.awe/cycles');
const DURABLE = join(ROOT, 'autonomy/cycles');
const CHAIN_FILE = join(DURABLE, 'ledger.jsonl');
const policy = JSON.parse(readText(join(ROOT, 'autonomy/policy.json')));
const { blockers } = JSON.parse(readText(join(ROOT, 'autonomy/blockers.json')));
const AUTHOR = { name: 'AWE Builder', email: 'awe-builder@users.noreply.github.com' };

const dirOf = (id) => join(CYCLES, id);
const save = (r) => { writeFileSync(join(dirOf(r.cycle_id), 'record.json'), JSON.stringify(r, null, 2) + '\n'); return r; };
const loadAll = () => (existsSync(CYCLES) ? readdirSync(CYCLES).filter((d) => existsSync(join(CYCLES, d, 'record.json')))
  .map((d) => JSON.parse(readText(join(CYCLES, d, 'record.json')))) : []);
const active = () => loadAll().filter((r) => r.phase !== 'FINISHED');

function current() {
  const id = arg('cycle');
  const open = active();
  if (id) return open.find((r) => r.cycle_id === id) ?? die(`no unfinished cycle ${id}`);
  if (open.length !== 1) die(open.length ? `${open.length} unfinished cycles; name one with --cycle` : 'no cycle in progress; run start');
  return open[0];
}
const need = (r, ...phases) => { if (!phases.includes(r.phase)) die(`cycle ${r.cycle_id} is ${r.phase}; this step needs ${phases.join(' or ')}`); };

const changesOf = (base, head) => diffChanges(ROOT, base, head);
const wtOf = (r) => ({ path: r.build.worktree, gitDir: r.build.git_dir, dotgit: r.build.dotgit });
/** Refuse to act if the Builder could have steered git since the cycle started. */
function integrity(r) {
  try { checkWorktreeIdentity(wtOf(r)); } catch (e) { return e.message; }
  const fp = configFingerprint(ROOT, r.build.git_dir);
  return fp === r.build.config_sha256 ? null : 'git config or the worktree admin files changed since the cycle started';
}
/**
 * The environment Builder code runs in during evaluation: no credentials, a
 * throwaway HOME, no global or system git config. The head's self-test and the
 * intake are the Builder's code; they must not run as the supervisor.
 */
function untrustedEnv(home) {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'NODE_OPTIONS_DISABLED'];
  const env = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  return { ...env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CI: '', NO_COLOR: '1' };
}

/** "autonomy checks: N passed, M failed" from a self-test's output. */
const counts = (text) => {
  const m = /checks: (\d+) passed, (\d+) failed\s*$/m.exec(text ?? '');
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : { passed: null, failed: null };
};

function builderBrief(r) {
  const p = r.package;
  return `# Builder brief — cycle ${r.cycle_id}, attempt ${r.build.attempts}

You are the BUILDER for one bounded AWE work package. You are an executor, not
an approver: an independent evaluator judges your work with checks you cannot
see or edit. Work ONLY inside this directory:

    ${r.build.worktree}

It is a git worktree on branch \`${r.build.branch}\`, cut from \`${p.base.commit}\`.

## Objective
${p.objective}

## Why
${p.why_now}

## Plan
${p.implementation_plan.map((x) => `- ${x}`).join('\n')}

## Interface the evaluator will hold you to
${p.interface.map((x) => `- ${x}`).join('\n')}

## Files you may change (and nothing else)
${p.allowed_files.map((x) => `- \`${x}\`${p.file_rules[x] ? ` — **${p.file_rules[x]}**` : ''}`).join('\n')}

\`no-removals\`: you may add lines anywhere; do not delete or edit an existing line.
\`add-scripts-only\`: you may add entries to "scripts"; change nothing else.

## Acceptance
${p.acceptance_criteria.map((c) => `- **${c.id}** — \`${c.command}\` → ${c.expect}`).join('\n')}

## Rules (any breach is a REJECT, not a judgement call)
- Do not run \`git commit\`, \`git push\`, \`git checkout\`, \`git reset\` or any command that changes git state. Leave your changes in the working tree; the cycle runner commits them only if every path is allowed.
- Do not touch any path outside the list above, even to fix something you notice. Record it in your report instead.
- Never delete, skip, or weaken a test; never change an acceptance criterion.
- Never open a database other than the fixtures you create under the system temp directory; never write to a production system, never deploy, never merge.
- Never run scripts/awe-cycle.mjs or start another agent.
- Budget: ${p.budget_minutes} minutes for the whole cycle. Attempt ${r.build.attempts} of ${p.max_attempts}.
- If the work cannot be done within these rules, or the acceptance criteria would have to change, STOP and say so.
${r.build.previous_rejection ? `\n## The evaluator rejected attempt ${r.build.attempts - 1}\n${r.build.previous_rejection.map((c) => `- ${c.id}: ${c.detail}`).join('\n')}\n` : ''}
## Report
End with: what you changed (per file), the commands you ran and their exit codes, and anything you chose not to do and why. Begin with \`STOPPED:\` if you stopped.
`;
}

// --- start ------------------------------------------------------------------
if (cmd === 'start') {
  if (ROOT.includes(`${join('.awe', 'worktrees')}`)) die('refusing: this is a Builder worktree; cycles do not start cycles');
  const open = active();
  if (open.length) die(`cycle ${open[0].cycle_id} is ${open[0].phase}; one cycle at a time (no recursive cycles)`);
  if (policy.limits.recursive_cycles !== false) die('policy does not forbid recursive cycles; refusing to run under an unexpected policy');

  const now = new Date();
  const obs = await observe(ROOT, { now });
  if (obs.dirty) die('the working tree is dirty; a cycle observes a commit, not a working copy');
  const baseRef = arg('base-ref') ?? obs.product_line.ref;
  const baseCommit = git(ROOT, ['rev-parse', baseRef]);
  if (!baseCommit) die(`cannot resolve ${baseRef}`);
  const j = judge(obs, { now: now.toISOString(), base: { ref: baseRef, commit: baseCommit } });

  const id = newCycleId(now.toISOString(), obs.head);
  mkdirSync(dirOf(id), { recursive: true });
  const inspection = { ranked: j.ranked, decision: j.decision };
  writeFileSync(join(dirOf(id), 'inspection.json'), JSON.stringify(inspection, null, 2) + '\n');
  const sel = j.decision.build ? j.topMachine : null;
  const brief = (x) => x && { id: x.id, score: x.priority.score, finding: x.finding, authority: x.authority, claims: x.claims };
  let r = {
    schema: 'awe.cycle/1',
    cycle_id: id,
    phase: 'OBSERVED',
    timeline: [{ phase: 'OBSERVED', at: now.toISOString() }],
    supervisor: arg('supervisor') ?? 'unspecified',
    observed: {
      commit: obs.head, branch: obs.branch,
      engineering: obs.engineering.autonomy.verdict,
      engineering_reasons: obs.engineering.autonomy.reasons,
      verification_source: obs.engineering.verification_source,
      ci: obs.verify.authoritative ? { status: obs.verify.authoritative.status, detail: obs.verify.authoritative.detail } : null,
      notes: obs.engineering.notes,
      gate: j.plan?.currentGate?.n ?? null, days_to_deadline: obs.iic.days_to_deadline,
      baseline: obs.human.baseline.status, install_readiness: obs.readiness.install.verdict,
      open_autonomy_prs: obs.autonomy_prs.unmerged_branches.length,
    },
    inputs: {
      inspection_sha256: sha256(JSON.stringify(inspection)),
      ci_evidence_sha256: fileHash(join(ROOT, '.awe/ci', `${obs.head}.json`)),
      policy_sha256: fileHash(join(ROOT, 'autonomy/policy.json')),
      blockers_sha256: fileHash(join(ROOT, 'autonomy/blockers.json')),
      suites_sha256: fileHash(join(ROOT, 'autonomy/suites.json')),
      capabilities_sha256: fileHash(join(ROOT, 'autonomy/capabilities.json')),
    },
    decision: {
      build: j.decision.build, headline: j.decision.headline, reasons: j.decision.reasons,
      top: j.ranked[0] ? brief(j.ranked[0]) : null,
      selected: sel?.id ?? null,
      selected_finding: brief(sel),
      ranked: j.ranked.slice(0, 10).map((x) => ({ id: x.id, score: x.priority.score, authority: x.authority.class })),
    },
    package: null, build: null, evaluation: null, pr: null,
    impact: { expected: expectedImpact(sel), actual: { status: 'UNKNOWN', why: 'nothing has run against production data' } },
    human_disposition: { status: 'PENDING', how: 'derived later: was the cycle branch merged into the product line, or closed?' },
  };
  r = advance(r, 'DECIDED', nowIso());

  if (!j.decision.build) {
    r.outcome = { status: 'STOPPED', why: j.decision.reasons };
    save(r);
    console.log(`cycle ${id}: ${j.decision.headline}`);
    for (const x of j.decision.reasons) console.log(`  · ${x}`);
    console.log('nothing dispatched. run: npm run cycle -- finish');
    process.exit(0);
  }
  if (j.pkg.status !== 'PREPARED_NOT_DISPATCHED') die(`selected ${sel.id} has no bounded template (${j.pkg.status})`);
  r.package = j.pkg;
  if (j.pkg.probes) r.inputs.probes_sha256 = fileHash(join(ROOT, j.pkg.probes));
  const branch = `${policy.autonomy_branch_prefix}${id}`;
  const worktree = join(ROOT, '.awe/worktrees', id);
  mkdirSync(dirname(worktree), { recursive: true });
  const remoteUrl = git(ROOT, ['remote', 'get-url', 'origin']);
  if (!remoteUrl) die('cannot read the origin URL');
  const wt = createWorktree(ROOT, { path: worktree, branch, base: baseCommit }, policy, blockers);
  r.build = { branch, base: baseCommit, worktree, git_dir: wt.gitDir, dotgit: wt.dotgit, remote_url: remoteUrl,
    config_sha256: configFingerprint(ROOT, wt.gitDir), attempts: 0, head: null, changes: [], rejected_heads: [] };
  save(r);
  console.log(`cycle ${id}: ${j.decision.headline}`);
  console.log(`package ${j.pkg.id} prepared; worktree ${relative(ROOT, worktree)} on ${branch} from ${baseCommit.slice(0, 12)}`);
  console.log('next: npm run cycle -- dispatch');
  process.exit(0);
}

// --- dispatch ---------------------------------------------------------------
if (cmd === 'dispatch') {
  let r = current();
  const retry = r.phase === 'EVALUATED' && r.evaluation?.verdict === 'REJECT';
  if (!retry) need(r, 'DECIDED');
  if (!r.package) die('this cycle stopped at its decision; there is nothing to dispatch');
  if (r.build.attempts >= r.package.max_attempts) die(`all ${r.package.max_attempts} attempts are spent`);
  if (retry) {
    // A second attempt starts from what the first left, with the evaluator's reasons.
    r.build.previous_rejection = r.evaluation.checks.filter((c) => c.status === 'FAIL');
    if (r.build.head) r.build.rejected_heads = [...new Set([...(r.build.rejected_heads ?? []), r.build.head])];
    if (r.build.tampered) die('this cycle\'s integrity check failed; it is not retried');
    // A refusal at collection belongs to that attempt; the next one is collected afresh.
    r.history = [...(r.history ?? []), { attempt: r.build.attempts, evaluation: r.evaluation, head: r.build.head,
      refused: { outside: r.build.outside ?? null, builder_commits: r.build.builder_commits ?? null } }];
    delete r.build.outside; delete r.build.builder_commits;
    r.evaluation = null;
    r.phase = 'DECIDED';
  }
  r.build.attempts += 1;
  r.build.dispatched_at = r.build.dispatched_at ?? nowIso();
  r = advance(r, 'DISPATCHED', nowIso());
  const text = builderBrief(r);
  writeFileSync(join(dirOf(r.cycle_id), `builder-brief-${r.build.attempts}.md`), text);
  r.inputs[`builder_brief_${r.build.attempts}_sha256`] = sha256(text);
  save(r);
  console.log(join(dirOf(r.cycle_id), `builder-brief-${r.build.attempts}.md`));
  process.exit(0);
}

// --- collect ----------------------------------------------------------------
if (cmd === 'collect') {
  let r = current();
  need(r, 'DISPATCHED');
  if (arg('report')) {
    const rep = readText(arg('report'));
    writeFileSync(join(dirOf(r.cycle_id), `builder-report-${r.build.attempts}.md`), rep);
    r.build.report_sha256 = sha256(rep);
    r.build.stopped_by_builder = /^\s*STOPPED:/.test(rep);
  }
  const tamper = integrity(r);
  if (tamper) {
    r.build.tampered = tamper;
    r = advance(r, 'COLLECTED', nowIso());
    save(r);
    die(`${tamper}. Nothing was taken. run: npm run cycle -- evaluate`, 1);
  }
  const res = commitBuild(wtOf(r), {
    branch: r.build.branch, since: r.build.head ?? r.build.base, allowed: r.package.allowed_files,
    message: `${r.package.objective.split('.')[0]}\n\nAWE cycle ${r.cycle_id}, work package ${r.package.id}, attempt ${r.build.attempts}.\nBuilt by a bounded Builder session from autonomy/cycles/${r.cycle_id}; not yet evaluated.\nThe evaluator's verdict and the Captain Brief are in the cycle record.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
    author: AUTHOR,
  }, policy, blockers);
  r.build.collected_at = nowIso();
  r.build.elapsed_minutes = (Date.parse(r.build.collected_at) - Date.parse(r.build.dispatched_at)) / 60000;
  if (!res.committed && res.builder_commits?.length) {
    r.build.builder_commits = res.builder_commits;
    r.build.outside = res.paths.filter((p) => !r.package.allowed_files.includes(p));
    r = advance(r, 'COLLECTED', nowIso());
    save(r);
    die(`the Builder committed ${res.builder_commits.length} commit(s) itself; the runner commits. Nothing was taken. run: npm run cycle -- evaluate`, 1);
  }
  if (!res.committed) {
    r.build.outside = res.outside;
    r = advance(r, 'COLLECTED', nowIso());
    save(r);
    die(`the Builder changed paths outside allowed_files: ${res.outside.join(', ')}. Nothing was committed. run: npm run cycle -- evaluate`, 1);
  }
  r.build.head = res.head;
  r.build.changes = changesOf(r.build.base, res.head)
    .map(({ status, path, removed, added }) => ({ status, path, removed_count: removed.length, added_count: added.length }));
  r = advance(r, 'COLLECTED', nowIso());
  save(r);
  console.log(`collected ${res.paths.length} path(s); head ${res.head.slice(0, 12)}; ${r.build.elapsed_minutes.toFixed(1)} min since dispatch`);
  process.exit(0);
}

// --- push -------------------------------------------------------------------
if (cmd === 'push') {
  let r = current();
  need(r, 'COLLECTED');
  if (r.build.outside?.length) die('an out-of-scope build is never pushed');
  const tamper = integrity(r);
  if (tamper) { r.build.tampered = tamper; save(r); die(`${tamper}; not pushing. run: npm run cycle -- evaluate`, 1); }
  const head = pushBranch(wtOf(r), { branch: r.build.branch, url: r.build.remote_url }, policy, blockers);
  if (head !== r.build.head) die(`pushed ${head}, but collected ${r.build.head}`);
  r.build.pushed_at = nowIso();
  r = advance(r, 'PUSHED', nowIso());
  save(r);
  console.log(`pushed ${r.build.branch} @ ${head.slice(0, 12)}. CI runs on push; import it with:\n  node scripts/awe-ci-evidence.mjs --commit ${head} --check-runs <file> --ref ${r.build.branch}`);
  process.exit(0);
}

// --- evaluate ---------------------------------------------------------------
if (cmd === 'evaluate') {
  let r = current();
  // A build that was taken must have been pushed: CI judges the pushed commit.
  // Only a build that was refused at collection is evaluated from COLLECTED.
  const refused = !!(r.build.tampered || r.build.builder_commits?.length || r.build.outside?.length);
  if (refused) need(r, 'COLLECTED', 'PUSHED'); else need(r, 'PUSHED');
  let input;
  const tamper = r.build.tampered ?? integrity(r);
  if (refused || tamper) {
    input = { tampered: tamper, builderCommitted: r.build.builder_commits ?? null,
      changes: (r.build.outside ?? []).map((p) => ({ status: '?', path: p, removed: [], added: [] })) };
  } else {
    const head = r.build.head;
    const changes = changesOf(r.build.base, head);
    const show = (rev, p) => { const o = spawnSync('git', [...SAFE, 'show', `${rev}:${p}`], { cwd: ROOT, encoding: 'utf8' }); return o.status === 0 ? o.stdout : null; };
    const packageJson = changes.some((c) => c.path === 'package.json') ? { before: JSON.parse(show(r.build.base, 'package.json')), after: JSON.parse(show(head, 'package.json')) } : null;
    const ci = ciVerdict(loadCiEvidence(ROOT, head), head);
    if (ci.status === 'PENDING') die(`CI for ${head.slice(0, 12)} is still running; evaluate once it has concluded`);
    if (ci.status === 'ABSENT') die(`no provenanced CI evidence for ${head.slice(0, 12)} (${ci.detail}); import it first`);
    if (!arg('review')) die('an independent review is required: --review <file>');
    if (r.package.probes && fileHash(join(ROOT, r.package.probes)) !== r.inputs.probes_sha256) die('the probe module changed since the cycle started; refusing to evaluate with different probes');
    const review = JSON.parse(readText(arg('review')));
    writeFileSync(join(dirOf(r.cycle_id), `review-${r.build.attempts}.json`), JSON.stringify(review, null, 2) + '\n');
    r.inputs[`review_${r.build.attempts}_sha256`] = sha256(JSON.stringify(review));
    // Self-tests and probes run on a clean checkout of the pushed commit, not
    // in the Builder's worktree, which may hold files the commit does not.
    const evalPath = join(ROOT, '.awe/eval', `${r.cycle_id}-${r.build.attempts}`);
    mkdirSync(dirname(evalPath), { recursive: true });
    checkoutForEvaluation(ROOT, { commit: head, path: evalPath });
    let selftest; let probes = null;
    const sandboxHome = mkdtempSync(join(tmpdir(), 'awe-eval-home-'));
    const env = untrustedEnv(sandboxHome);
    try {
      // BASE copy: the self-test as it was at the base commit, run on the head.
      const baseCopy = join(evalPath, 'scripts', '.awe-base-eval-autonomy.mjs');
      writeFileSync(baseCopy, show(r.build.base, 'scripts/eval-autonomy.mjs'));
      const b = spawnSync(process.execPath, [baseCopy], { cwd: evalPath, encoding: 'utf8', timeout: 300_000, env });
      const h = spawnSync(process.execPath, ['scripts/eval-autonomy.mjs'], { cwd: evalPath, encoding: 'utf8', timeout: 300_000, env });
      writeFileSync(join(dirOf(r.cycle_id), `selftest-${r.build.attempts}.log`),
        `=== base copy on head ===\n${b.stdout ?? ''}${b.stderr ?? ''}\n=== head copy ===\n${h.stdout ?? ''}${h.stderr ?? ''}`);
      selftest = { base: { exit_code: b.status, ...counts(b.stdout) }, head: { exit_code: h.status, ...counts(h.stdout) } };
      if (r.package.probes) probes = await (await import(join(ROOT, r.package.probes))).run({ root: ROOT, worktree: evalPath, env });
    } finally { removeEvaluationCheckout(ROOT, evalPath); rmSync(sandboxHome, { recursive: true, force: true }); }
    // Builder code ran above. If anything the supervisor trusts changed, say so.
    const after = integrity(r);
    if (after) input = { tampered: `during evaluation: ${after}` };
    input = input ?? { changes, packageJson, selftest, probes, ci, review, head,
      previouslyRejected: (r.build.rejected_heads ?? []).includes(head) };
  }
  const result = evaluate({ pkg: r.package, branch: r.build.branch, elapsedMinutes: r.build.elapsed_minutes ?? null, policy, blockers, ...input });
  r.evaluation = { ...result, at: nowIso(), attempt: r.build.attempts, probes: input.probes ?? null, selftest: input.selftest ?? null };
  r = advance(r, 'EVALUATED', nowIso());
  save(r);
  console.log(`EVALUATOR VERDICT: ${result.verdict}`);
  for (const c of result.checks) console.log(`  ${c.status.padEnd(7)} ${c.id} — ${c.detail}`);
  process.exit(0);
}

// --- pr ---------------------------------------------------------------------
if (cmd === 'pr') {
  let r = current();
  need(r, 'EVALUATED');
  if (r.evaluation.verdict === 'REJECT') die('a REJECTED build does not get a PR');
  const unknown = r.evaluation.checks.filter((c) => c.status === 'UNKNOWN').map((c) => c.id);
  if (unknown.includes('independent-review') || unknown.includes('ci')) die(`a PR needs CI and an independent review on record; unknown: ${unknown.join(', ')}`);
  if (!arg('url') || !arg('number')) die('usage: pr --url <url> --number <n>');
  r.pr = { url: arg('url'), number: Number(arg('number')), draft: true, opened_at: nowIso() };
  r = advance(r, 'PR_OPENED', nowIso());
  save(r);
  console.log(`recorded draft PR ${r.pr.url}`);
  process.exit(0);
}

// --- finish -----------------------------------------------------------------
if (cmd === 'finish') {
  let r = current();
  need(r, 'DECIDED', 'EVALUATED', 'PR_OPENED');
  if (r.phase === 'DECIDED' && r.package) die('a prepared package must be dispatched and evaluated before the cycle finishes');
  if (r.phase === 'EVALUATED' && r.evaluation.verdict !== 'REJECT') die('an evaluated, non-rejected build needs its draft PR recorded first');
  if (r.phase === 'EVALUATED' && r.build.attempts < r.package.max_attempts && !argv.includes('--no-retry')) {
    die(`attempt ${r.build.attempts} was rejected and ${r.package.max_attempts - r.build.attempts} attempt(s) remain: dispatch again, or finish --no-retry`);
  }
  const insp = JSON.parse(readText(join(dirOf(r.cycle_id), 'inspection.json')));
  const human = insp.ranked.filter((x) => ['JACK_ACTION_REQUIRED', 'EXTERNAL_DEPENDENCY'].includes(x.authority.class));
  const others = insp.ranked.filter((x) => x.id !== r.decision.selected && !['JACK_ACTION_REQUIRED', 'EXTERNAL_DEPENDENCY'].includes(x.authority.class));
  r.outcome = r.outcome ?? {
    status: r.pr ? `DRAFT_PR_FOR_HUMAN_REVIEW (${r.evaluation.verdict})` : r.evaluation ? `REJECTED after ${r.build.attempts} attempt(s)` : 'STOPPED',
  };
  r.remaining = [
    ...others.slice(0, 5).map((x) => `${x.id} (${x.authority.class}, score ${x.priority.score}): ${x.finding.slice(0, 160)}`),
    ...((r.evaluation?.checks ?? []).filter((c) => c.status !== 'PASS').map((c) => `evaluator ${c.id}: ${c.status} — ${c.detail}`)),
  ];
  r.jack = [
    ...(r.pr ? [`Review draft PR ${r.pr.url} (evaluator: ${r.evaluation.verdict}). Merging it is your decision; AWE will not.`] : []),
    ...human.slice(0, 4).map((x) => `${x.id}: ${x.action.summary.slice(0, 200)}`),
  ];
  r.next = r.pr ? 'Jack reviews the draft PR; AWE records the disposition at the next cycle and stays within one open autonomy PR per reviewer.'
    : human[0] ? `Nothing for the machine above the floor. ${human[0].id} is the constraint.` : 'Re-run the cycle when the evidence changes.';
  r.finished_at = nowIso();
  r = advance(r, 'FINISHED', r.finished_at);
  save(r);

  mkdirSync(DURABLE, { recursive: true });
  const text = JSON.stringify(r, null, 2) + '\n';
  writeFileSync(join(DURABLE, `${r.cycle_id}.json`), text);
  writeFileSync(join(DURABLE, `${r.cycle_id}.md`), renderBrief(r));
  const lines = existsSync(CHAIN_FILE) ? readText(CHAIN_FILE).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const problems = verifyLedger(lines);
  if (problems.length) die(`the ledger is already broken; not appending:\n  ${problems.join('\n  ')}`, 1);
  appendFileSync(CHAIN_FILE, JSON.stringify(ledgerEntry(r, text, lines.at(-1))) + '\n');
  console.log(renderBrief(r));
  console.log(`wrote autonomy/cycles/${r.cycle_id}.json, .md and a ledger line; commit them on the supervisor's branch`);
  process.exit(0);
}

// --- status / verify-ledger -------------------------------------------------
if (cmd === 'status') {
  for (const r of loadAll()) console.log(`${r.cycle_id}  ${r.phase.padEnd(10)} ${r.decision?.selected ?? '—'}  ${r.evaluation?.verdict ?? ''}`);
  process.exit(0);
}
if (cmd === 'verify-ledger') {
  if (!existsSync(CHAIN_FILE)) { console.log('no ledger yet'); process.exit(0); }
  const lines = readText(CHAIN_FILE).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const records = Object.fromEntries(lines.filter((e) => existsSync(join(DURABLE, `${e.cycle_id}.json`)))
    .map((e) => [e.cycle_id, readText(join(DURABLE, `${e.cycle_id}.json`))]));
  const problems = [...verifyLedger(lines, records),
    ...lines.filter((e) => !(e.cycle_id in records)).map((e) => `${e.cycle_id}: its record file autonomy/cycles/${e.cycle_id}.json is missing`)];
  for (const p of problems) console.log(`BROKEN  ${p}`);
  console.log(problems.length ? `ledger: ${problems.length} problem(s)` : `ledger: ${lines.length} cycle(s), chain intact`);
  process.exit(problems.length ? 1 : 0);
}

die('usage: awe-cycle start|dispatch|collect|push|evaluate|pr|finish|status|verify-ledger', 64);
