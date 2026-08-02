// ---------------------------------------------------------------------------
// context-compile.mjs — CLI for the AWE Context Compiler.
//
// Turns a human-defined objective into a bounded execution packet:
//
//   npm run context:compile -- --objective "..." --task-id AWE-INT-102 \
//     --output .awe/packets/AWE-INT-102
//
// OFFLINE and READ-ONLY with respect to the repository: it reads files, queries
// Git, and writes only inside --output (which lives under the ignored .awe/
// directory by default). It contacts no network, no database, and no provider.
//
// Exit code is 0 even when the packet carries warnings — warnings are the
// packet's honest account of its own limits, not a build failure. It exits 1
// only when the packet is structurally invalid, because an invalid packet must
// never reach an agent.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { collectAll, collectKnownPaths } from './lib/context-compiler/fs-sources.mjs';
import { compile, toJson, toMarkdown } from './lib/context-compiler/compile.mjs';

function parseArgs(argv) {
  const out = { limit: 40, minScore: 8 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i += 1];
    if (a === '--objective') out.objective = next();
    else if (a === '--task-id') out.taskId = next();
    else if (a === '--capability') out.capability = next();
    else if (a === '--output') out.output = next();
    else if (a === '--limit') out.limit = Number(next());
    else if (a === '--min-score') out.minScore = Number(next());
    else if (a === '--stdout') out.stdout = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const USAGE = `
context:compile — assemble a bounded execution packet from repository evidence

  npm run context:compile -- --objective "<text>" [options]

  --objective <text>    required — the human-defined objective
  --task-id <id>        dispatch task id, e.g. AWE-INT-102
  --capability <name>   capability this task belongs to
  --output <dir>        output directory (default .awe/packets/<packet-id>)
  --limit <n>           max non-mandatory records (default 40)
  --min-score <n>       relevance threshold (default 8)
  --stdout              also print the Markdown packet
`;

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.objective) {
  console.log(USAGE);
  process.exit(args.objective ? 0 : 1);
}

const root = process.cwd();
const { records, git } = await collectAll(root, { objective: args.objective, taskId: args.taskId });
const knownPaths = collectKnownPaths(root);
const knownBranches = new Set(git.branches);

const { packet, manifest, warnings, errors } = compile(records, {
  objective: args.objective,
  taskId: args.taskId || null,
  capability: args.capability || null,
  git,
  // The clock is injected here, at the edge, so the pure core stays replayable.
  generatedAt: new Date().toISOString(),
  limit: args.limit,
  minScore: args.minScore,
  knownPaths,
  knownBranches,
});

const outDir = resolve(root, args.output || join('.awe', 'packets', packet.packet_id));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'execution-packet.md'), toMarkdown(packet), 'utf8');
writeFileSync(join(outDir, 'execution-packet.json'), toJson(packet), 'utf8');
writeFileSync(join(outDir, 'source-manifest.json'), toJson(manifest), 'utf8');
writeFileSync(join(outDir, 'warnings.json'), toJson({ count: warnings.length, warnings }), 'utf8');

if (args.stdout) console.log(toMarkdown(packet));

console.log(`packet ${packet.packet_id}`);
console.log(`  objective : ${packet.objective}`);
console.log(`  repo      : ${packet.repository} @ ${packet.branch} ${packet.commit.slice(0, 7)}`);
console.log(`  sources   : ${packet.sources.length} selected from ${manifest.selection.considered} records`);
console.log(`  evidence  : ${Object.entries(packet.evidence_summary).sort().map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`  warnings  : ${warnings.length}`);
for (const w of warnings) console.log(`      ${w.kind}: ${w.message}`);
console.log(`  written   : ${outDir}`);

if (errors.length) {
  console.error('\ncontext:compile: PACKET INVALID');
  for (const e of errors) console.error(`  FAIL  ${e}`);
  process.exit(1);
}
console.log('context:compile: OK');
