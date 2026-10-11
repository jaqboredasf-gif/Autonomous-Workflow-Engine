// ---------------------------------------------------------------------------
// human-evidence.mjs — load the human facts and their state (I/O shell).
//
// The rules are in attestations.mjs. This reads the files and computes the two
// machine signals the catalog names, both by counting records that already
// exist in the repository, so nothing here can be satisfied by declaring it.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseLedger, resolveFacts, baselineGate } from './attestations.mjs';

export const LEDGER = 'autonomy/attestations.jsonl';
export const CATALOG = 'autonomy/human-facts.json';

function countJson(dir, recursive = false) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.json')) n++;
    else if (recursive && e.isDirectory()) n += countJson(join(dir, e.name), true);
  }
  return n;
}

export async function loadHumanEvidence(root) {
  const catalog = JSON.parse(readFileSync(join(root, CATALOG), 'utf8'));
  const text = existsSync(join(root, LEDGER)) ? readFileSync(join(root, LEDGER), 'utf8') : '';
  const { records, rejected } = parseLedger(text, catalog);

  let interviews = 0;
  let interviewDetail = 'no interview records';
  try {
    const { loadInterviews } = await import(join(root, 'programs/discovery/load.mjs'));
    const { records: recs } = await loadInterviews();
    interviews = recs.length;
    interviewDetail = `${interviews} interview record(s) under programs/discovery/interviews/`;
  } catch (e) { interviewDetail = `could not read interview records: ${e.message}`; }

  const frozenBaselines = countJson(join(root, 'proof/baselines/frozen'));
  const machine = {
    'discovery-interview-records': { ok: interviews > 0, detail: interviewDetail },
  };
  const facts = resolveFacts(catalog, records, machine);
  return { catalog, facts, rejected, baseline: baselineGate(facts, { frozenBaselines }) };
}
