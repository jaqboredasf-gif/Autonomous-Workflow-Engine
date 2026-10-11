// ---------------------------------------------------------------------------
// observe.mjs — gather what the improvement engine is allowed to know.
//
// The Inspector consumes the evidence systems that already exist. It never
// re-implements them: the plan comes from `npm run plan --json`, deployment
// facts from `pcc-deployment-gate --json`, verification from verify.json, the
// engineering state and readiness from their own derivations, human facts from
// the attestation ledger. What this file adds is only what nothing else
// observed yet: a handful of git facts, the capability probes, and a count of
// TODO markers on the deployed path.
//
// Every observation records where it came from, so a finding can cite it.
// Freshness matters: a verify.json for a different commit is reported as
// stale, never silently used.
//
// I/O only; the judgement is in inspect.mjs.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { git, treeFacts } from './git.mjs';
import { runDetectors } from './detectors.mjs';
import { deriveEngineeringState } from './state.mjs';
import { deriveReadiness } from './readiness.mjs';
import { loadHumanEvidence } from './human-evidence.mjs';
import { signedRelease } from './release.mjs';

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const runJson = (root, args) => {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(r.stdout); } catch { return null; }
};

function grepDocs(root, dirs, pattern) {
  const hits = [];
  for (const d of dirs) {
    const abs = join(root, d);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      if (!f.endsWith('.md')) continue;
      const text = readFileSync(join(abs, f), 'utf8');
      for (const [i, line] of text.split('\n').entries()) if (pattern.test(line)) hits.push(`${d}/${f}:${i + 1}`);
    }
  }
  return hits;
}

function todoMarkers(root, dirs) {
  const out = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (!['node_modules', '.next'].includes(e.name)) walk(p); continue; }
      if (!/\.(mjs|ts|tsx|js)$/.test(e.name)) continue;
      const lines = readFileSync(join(root, p), 'utf8').split('\n');
      lines.forEach((l, i) => { if (/\b(TODO|FIXME|XXX)\b/.test(l)) out.push({ file: p, line: i + 1, text: l.trim().slice(0, 120) }); });
    }
  };
  dirs.forEach(walk);
  return out;
}

function probe(root, cap) {
  const p = cap.probe;
  if (p.kind === 'file-on-ref') {
    const refOk = git(root, ['rev-parse', '--verify', '-q', p.ref]);
    if (!refOk) return { observable: false, reason: `${p.ref} not fetched` };
    const present = git(root, ['cat-file', '-e', `${p.ref}:${p.path}`]) !== null;
    return { observable: true, present, evidence: [`git cat-file -e ${p.ref}:${p.path} → ${present ? 'present' : 'absent'}`] };
  }
  if (p.kind === 'workflow-runs-on') {
    const dir = join(root, '.github/workflows');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
    const matching = files.filter((f) => new RegExp(`runs-on:\\s*[\\[\\'"]?${p.pattern}`, 'i').test(readFileSync(join(dir, f), 'utf8')));
    return { observable: true, present: matching.length > 0,
      evidence: [`.github/workflows: ${files.length} workflow(s); ${matching.length} run on ${p.pattern}${matching.length ? ` (${matching.join(', ')})` : ''}`] };
  }
  if (p.kind === 'evidence-return') {
    const pkg = existsSync(join(root, 'scripts/package-release.mjs')) ? readFileSync(join(root, 'scripts/package-release.mjs'), 'utf8') : '';
    const entry = /const ENTRY_SCRIPTS = \[([\s\S]*?)\];/.exec(pkg)?.[1] ?? '';
    const shipped = p.tools.filter((t) => entry.includes(t));
    const needDb = p.tools.filter((t) => existsSync(join(root, t)) && /--db/.test(readFileSync(join(root, t), 'utf8')));
    const procedure = grepDocs(root, p.docs_glob, /(copy|bring|transfer|export).{0,60}(backup|database|pcc\.sqlite).{0,80}(plan|case[- ]study|evidence|proof)/i);
    return {
      observable: true,
      present: shipped.length > 0 || procedure.length > 0,
      evidence: [
        `${needDb.join(', ')} read the production database only through --db (a local file)`,
        `release package ENTRY_SCRIPTS ships ${shipped.length ? shipped.join(', ') : 'none of them'} (scripts/package-release.mjs)`,
        procedure.length ? `procedure found: ${procedure.join(', ')}` : `no document in ${p.docs_glob.join(', ')} describes moving production records to where plan/case-study run`,
        'RDS02 has no outbound network at runtime (PCC_RDS02_EXECUTION_PACKAGE.md §7)',
      ],
    };
  }
  return { observable: false, reason: `unknown probe ${p.kind}` };
}

export async function observe(root, { now = new Date() } = {}) {
  const head = git(root, ['rev-parse', 'HEAD']);
  const tree = treeFacts(root);
  const fresh = (v) => !!v && v.tree?.commit === head && v.tree?.dirty === false;

  const ciVerify = readJson(join(root, '.awe/verify.json'));
  const deployVerify = readJson(join(root, '.awe-deploy/verify.json'));
  const blockers = readJson(join(root, 'autonomy/blockers.json')).blockers;
  const policy = readJson(join(root, 'autonomy/policy.json'));
  const detections = runDetectors(root, blockers);
  const human = await loadHumanEvidence(root);
  const gate = runJson(root, [join(root, 'scripts/pcc-deployment-gate.mjs'), '--json']);
  const plan = runJson(root, [join(root, 'scripts/awe-plan.mjs'), '--json']);

  const engineering = deriveEngineeringState({
    verify: fresh(ciVerify) ? ciVerify : null,
    verifyError: ciVerify && !fresh(ciVerify) ? `verify.json is for ${ciVerify.tree?.commit?.slice(0, 7)}${ciVerify.tree?.dirty ? ' (dirty)' : ''}, not HEAD` : null,
    blockers, policy, detections, head, now: now.toISOString(), human,
  });
  const spec = readJson(join(root, 'autonomy/deployment-readiness.json'));
  const readiness = deriveReadiness({
    spec, verify: fresh(deployVerify) ? deployVerify : null, gate, facts: human.facts,
    baseline: human.baseline, blockers,
    release: signedRelease(root, fresh(deployVerify) ? deployVerify.tree.commit : null), now: now.toISOString(),
  });

  // The product line, and what is waiting to land on it.
  const productRef = 'origin/pcc-production';
  const productLast = git(root, ['log', '-1', '--format=%cs %h %s', productRef]);
  const productDate = productLast?.slice(0, 10) ?? null;
  const branches = (git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']) ?? '')
    .split('\n').filter((b) => /^origin\/(claude\/autonomy-|autonomy\/)/.test(b));
  const unmergedAutonomy = branches.filter((b) => git(root, ['merge-base', '--is-ancestor', b, productRef]) === null)
    .map((b) => ({ branch: b.replace(/^origin\//, ''), ahead: Number(git(root, ['rev-list', '--count', `${productRef}..${b}`]) ?? 0) }));

  // The IIC evidence deadline, read from the spec that states it.
  const spec2027 = existsSync(join(root, 'programs/iic-2027/MASTER_SPEC.md')) ? readFileSync(join(root, 'programs/iic-2027/MASTER_SPEC.md'), 'utf8') : '';
  const deadlineText = /evidence deadline is (\d{1,2}) (January|February|March|April) (\d{4})/i.exec(spec2027);
  const months = { january: '01', february: '02', march: '03', april: '04' };
  const deadline = deadlineText ? `${deadlineText[3]}-${months[deadlineText[2].toLowerCase()]}-${deadlineText[1].padStart(2, '0')}` : null;
  const daysTo = (iso) => (iso ? Math.round((Date.parse(iso) - Date.parse(now.toISOString().slice(0, 10))) / 864e5) : null);

  const capabilities = readJson(join(root, 'autonomy/capabilities.json')).capabilities
    .map((c) => ({ ...c, result: probe(root, c) }));

  // TODO markers on the path that actually ships (purchasing app, proof,
  // deployment tooling). Markers elsewhere are not evidence about the pilot.
  const deployedPath = ['apps/purchasing/src', 'proof', 'deployment', 'capability'];
  const todos = todoMarkers(root, deployedPath);

  const runtimeDocsRds = existsSync(join(root, 'docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md'))
    ? readFileSync(join(root, 'docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md'), 'utf8') : '';
  const itOutstanding = /## 7\. What Jose still needs to provide([\s\S]*?)\n## /.exec(runtimeDocsRds)?.[1] ?? '';
  const itItems = [...itOutstanding.matchAll(/^> \d+\. \*\*([^*]+)\*\*/gm)].map((m) => m[1].trim());

  return {
    observed_at: now.toISOString(),
    head, branch: tree.branch, dirty: tree.dirty,
    verify: {
      ci: ciVerify ? { commit: ciVerify.tree?.commit, fresh: fresh(ciVerify), verdict: ciVerify.verdict, summary: ciVerify.summary, profile: ciVerify.profile,
        suites: ciVerify.suites.map((s) => ({ id: s.id, status: s.status, blocking: s.blocking, reason: s.reason, area: s.area, category: s.category })) } : null,
      deploy: deployVerify ? { commit: deployVerify.tree?.commit, fresh: fresh(deployVerify), verdict: deployVerify.verdict, summary: deployVerify.summary } : null,
    },
    engineering, readiness, gate, plan, human, blockers, detections, policy,
    product_line: { ref: productRef, last_commit: productLast, days_since_commit: productDate ? -daysTo(productDate) : null },
    autonomy_prs: { unmerged_branches: unmergedAutonomy, limit: policy.limits.open_autonomy_prs },
    iic: { evidence_deadline: deadline, days_to_deadline: daysTo(deadline), source: 'programs/iic-2027/MASTER_SPEC.md' },
    capabilities,
    todos: { scope: deployedPath, markers: todos },
    lippolis_it: { outstanding_items: itItems, source: 'docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md §7' },
  };
}
