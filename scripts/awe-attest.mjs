// ---------------------------------------------------------------------------
// awe-attest.mjs — a person tells the repository something only a person knows.
//
//   npm run attest -- --list                 # every human fact and its state (read-only; runs anywhere)
//   npm run attest                           # record an attestation, interactively
//
// Writes one line to autonomy/attestations.jsonl and nothing else. The line
// names the fact, the date it became true (or was checked), who attests it,
// an optional evidence reference and a status: verified, or refuted (checked,
// and not true).
//
// IT REFUSES TO RUN WITHOUT A PERSON. Recording requires an interactive
// terminal, and it refuses inside CI and inside an agent session (CLAUDECODE,
// CODEX_*), however it is invoked. A determined program can always forge a line
// in a text file; the point is that nothing in this repository does it by
// accident or by design. autonomy/attestations.jsonl is also an L3 path, so
// scripts/awe-guard.mjs refuses any autonomous change that touches it, and
// scripts/eval-autonomy.mjs fails if any other file in the repository writes
// to it.
//
// Commit the new line yourself, so the attestation carries your git identity too.
// ---------------------------------------------------------------------------

import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecord } from '../autonomy/lib/attestations.mjs';
import { loadHumanEvidence, LEDGER, CATALOG } from '../autonomy/lib/human-evidence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

if (argv.includes('--list')) {
  const { facts, rejected, baseline } = await loadHumanEvidence(ROOT);
  if (baseline.banner) console.log(`\n  !!  ${baseline.banner}  !!\n`);
  for (const f of facts) {
    const who = f.attested_by ? ` — ${f.attested_by}, ${f.date}` : f.detail ? ` — ${f.detail}` : '';
    console.log(`${f.state.padEnd(17)} ${f.id}${who}`);
  }
  for (const r of rejected) console.log(`IGNORED  ${LEDGER} line ${r.line}: ${r.errors.join('; ')}`);
  process.exit(0);
}

const agentMarkers = ['CI', 'GITHUB_ACTIONS', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_HOME']
  .filter((k) => process.env[k]);
if (agentMarkers.length || !process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('awe-attest: refusing to record an attestation.');
  console.error(agentMarkers.length
    ? `  This looks like CI or an agent session (${agentMarkers.join(', ')}). Attestations come from a person.`
    : '  No interactive terminal. Run it yourself, in a terminal.');
  console.error('  Read-only: npm run attest -- --list');
  process.exit(2);
}

const catalog = JSON.parse(readFileSync(join(ROOT, CATALOG), 'utf8'));
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log('Human facts (autonomy/human-facts.json):');
catalog.facts.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}. ${f.id}`));
const pick = (await rl.question('\nWhich fact? (number) ')).trim();
const fact = catalog.facts[Number(pick) - 1];
if (!fact) { console.error('no such fact'); process.exit(64); }
console.log(`\n  ${fact.statement}\n`);
const status = (await rl.question('Is that TRUE (verified) or did you check and find it NOT true (refuted)? [verified/refuted] ')).trim();
const today = new Date().toISOString().slice(0, 10);
const date = (await rl.question(`Date it became true / was checked (YYYY-MM-DD) [${today}] `)).trim() || today;
const by = (await rl.question('Your name: ')).trim();
const evidence = (await rl.question(`Evidence reference (optional — ${fact.evidence_hint ?? 'a path, photo name or note'}): `)).trim();
const note = (await rl.question('Note (optional): ')).trim();
const confirm = (await rl.question(`\nRecord: ${by} attests "${fact.id}" is ${status.toUpperCase()} as of ${date}. Type yes to record: `)).trim();
rl.close();
if (confirm !== 'yes') { console.log('nothing recorded'); process.exit(1); }

const record = {
  fact: fact.id, status, date, attested_by: by,
  ...(evidence ? { evidence } : {}), ...(note ? { note } : {}),
  recorded_at: new Date().toISOString(), via: 'awe-attest',
};
const errors = validateRecord(record, catalog);
if (errors.length) { console.error(`not recorded: ${errors.join('; ')}`); process.exit(1); }
appendFileSync(join(ROOT, LEDGER), JSON.stringify(record) + '\n');
console.log(`recorded in ${LEDGER}. Commit it yourself:\n  git add ${LEDGER} && git commit -m "Attest ${fact.id}"`);
