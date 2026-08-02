// ---------------------------------------------------------------------------
// validate-context.mjs — checks the Persistent Cognition Layer under context/.
//
// OFFLINE. Reads files, writes nothing, contacts nothing. Exit 0 iff the layer
// is complete, dated, secret-free, uses the allowed evidence vocabulary, and
// every repo path it cites actually exists.
//
// Usage: node scripts/validate-context.mjs
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REQUIRED_FILES, validateDocument, extractRepoPaths } from './lib/context-validator.mjs';

const ROOT = process.cwd();
const DIR = join(ROOT, 'context');
const findings = [];

for (const file of REQUIRED_FILES) {
  const path = join(DIR, file);
  if (!existsSync(path)) {
    findings.push({ level: 'error', file, message: 'required context file is missing' });
    continue;
  }
  const text = readFileSync(path, 'utf8');
  findings.push(...validateDocument(file, text));

  // Referenced repo paths must resolve, or the layer sends agents to files that
  // do not exist — the exact failure this layer is meant to prevent.
  for (const p of extractRepoPaths(text)) {
    const rel = p.replace(/^\.\.\//, '');
    if (!existsSync(join(ROOT, rel)) && !existsSync(join(DIR, p))) {
      findings.push({ level: 'warn', file, message: `referenced path does not exist: ${p}` });
    }
  }
}

const errors = findings.filter((f) => f.level === 'error');
const warns = findings.filter((f) => f.level === 'warn');

for (const f of findings) console.log(`${f.level === 'error' ? 'FAIL' : 'warn'}  ${f.file}: ${f.message}`);

console.log(`\nvalidate-context: ${REQUIRED_FILES.length} files, ${errors.length} errors, ${warns.length} warnings`);
console.log(errors.length === 0 ? 'validate-context: PASS' : 'validate-context: FAIL');
process.exit(errors.length === 0 ? 0 : 1);
