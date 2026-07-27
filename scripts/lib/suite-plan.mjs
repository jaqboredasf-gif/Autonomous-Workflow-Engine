#!/usr/bin/env node
// ---------------------------------------------------------------------------
// suite-plan.mjs — resolve the regression plan from the suite registry.
//
// The plan (which suites run, in what order, which are skipped and why) lives
// in packages/awe-kernel/src/registry.mjs. This is the thin CLI that
// scripts/regression.sh consumes, and the one humans use to ask "what would run
// with no credentials?" without executing anything.
//
//   node scripts/lib/suite-plan.mjs                 # human-readable list
//   node scripts/lib/suite-plan.mjs --format=tsv    # machine format for bash
//   node scripts/lib/suite-plan.mjs --format=json
//   node scripts/lib/suite-plan.mjs --kinds=unit,offline,static   # no keys
//   node scripts/lib/suite-plan.mjs --only=eval-kernel,eval-approval-diff
//   node scripts/lib/suite-plan.mjs --exclude-kinds=build
//
// TSV columns (fixed order — regression.sh reads them positionally):
//   id  status  echo_ok  quiet_on_success  cooldown  name  command  skip_reason
//
// PURE OFFLINE: reads the registry and checks file existence. Runs nothing.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registry } from '../../packages/awe-kernel/src/registry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function flag(name, fallback = null) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}
function list(name) {
  const v = flag(name);
  return typeof v === 'string' && v.length > 0 ? v.split(',').map((s) => s.trim()).filter(Boolean) : null;
}

const plan = registry.plan({
  env: process.env,
  exists: (p) => existsSync(join(ROOT, p)),
  only: list('only'),
  kinds: list('kinds'),
  excludeKinds: list('exclude-kinds'),
});

const format = flag('format', 'list');

if (format === 'json') {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} else if (format === 'tsv') {
  for (const s of plan) {
    process.stdout.write([
      s.id,
      s.status,
      s.echo_ok ? '1' : '0',
      s.quiet_on_success ? '1' : '0',
      String(s.cooldown_after_seconds),
      s.name,
      s.command,
      s.skip_reason ?? '',
    ].join('\t') + '\n');
  }
} else {
  const runnable = plan.filter((s) => s.status === 'run');
  process.stdout.write(`regression plan: ${runnable.length}/${plan.length} suites\n`);
  for (const s of plan) {
    const mark = s.status === 'run' ? '·' : 'skip';
    const env = s.missing_env.length ? `  (missing env: ${s.missing_env.join(', ')})` : '';
    const why = s.skip_reason ? `  — ${s.skip_reason}` : '';
    process.stdout.write(`  ${mark.padEnd(4)} ${s.id.padEnd(24)} ${s.kind.padEnd(8)} ${s.name}${why}${env}\n`);
  }
}
