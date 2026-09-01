// ---------------------------------------------------------------------------
// load.mjs — read the interview records off disk, once.
//
// THERE WERE THREE COPIES OF THIS. `derive.mjs` had one so the scorecard could
// count interviews, `scripts/discovery.mjs` had another so the report could
// analyse them, and each handled the .json and .mjs cases in its own slightly
// different way. Three readers of one directory is three answers to "how many
// interviews are there" on the day one of them mishandles a file — which is the
// same argument that put deriveFacts() in one module, applied one level down.
//
// IT VALIDATES ON THE WAY IN. A .json record goes through `interview()`, so a
// record missing its patternTags is refused here rather than counted as a
// conversation. Problems are returned, never thrown: a malformed note must not
// take down `npm run plan`.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interview } from './interview.mjs';

export const INTERVIEWS = join(dirname(fileURLToPath(import.meta.url)), 'interviews');

export async function loadInterviews({ dir = INTERVIEWS } = {}) {
  const records = [];
  const problems = [];
  const sheets = [];
  if (!existsSync(dir)) return { records, problems, sheets };

  for (const f of readdirSync(dir).sort()) {
    const full = join(dir, f);
    if (f.endsWith('.md') && f !== 'README.md') { sheets.push(f); continue; }
    if (!/\.(json|mjs)$/.test(f)) continue;
    try {
      if (f.endsWith('.json')) {
        const raw = JSON.parse(readFileSync(full, 'utf8'));
        for (const r of Array.isArray(raw) ? raw : [raw]) records.push(interview(r));
      } else {
        const mod = await import(full);
        for (const v of Object.values(mod)) {
          if (Array.isArray(v)) { for (const x of v) if (x?.patternTags) records.push(x); }
          else if (v && typeof v === 'object' && v.patternTags) records.push(v);
        }
      }
    } catch (e) {
      problems.push({ file: `programs/discovery/interviews/${f}`, reason: e.message });
    }
  }
  return { records, problems, sheets };
}
