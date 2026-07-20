// ---------------------------------------------------------------------------
// eval-approval-diff.mjs — assertion harness behind Runner 3.
//
// PURE OFFLINE. No API keys, no model calls, no DB, no network. Loads the
// labelled fixtures under fixtures/approvals/, runs the deterministic diff engine
// (scripts/lib/approval-diff.mjs), and asserts every label. Also proves:
//   * determinism  — diff(draft,sent) run twice is byte-identical
//   * contract     — every result has the required shape and valid values
//   * coverage     — every edit class appears in at least one fixture result
//
// Exit 0 iff all gates pass; nonzero otherwise. Invoked by scripts/eval-approval-diff.sh.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { diff, EDIT_CLASSES } from './lib/approval-diff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'fixtures', 'approvals');
const REQUIRED_KEYS = ['unchanged', 'edit_ratio', 'field_deltas', 'edit_classes', 'material'];

const labels = JSON.parse(readFileSync(join(DIR, 'labels.json'), 'utf8'));

let pass = 0, fail = 0;
const seenClasses = new Set();
const ok = () => { pass++; };
const bad = (m) => { console.log(`FAIL  ${m}`); fail++; };
const check = (cond, m) => (cond ? ok() : bad(m));

const sameSet = (a, b) => {
  const A = new Set(a), B = new Set(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
};

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && f !== 'labels.json')
  .sort();

for (const f of files) {
  const label = labels[f];
  if (!label) { bad(`${f} has no entry in labels.json`); continue; }

  let fx;
  try { fx = JSON.parse(readFileSync(join(DIR, f), 'utf8')); }
  catch (e) { bad(`${f} is not valid JSON: ${e.message}`); continue; }

  const res = diff(fx.draft, fx.sent);
  const res2 = diff(fx.draft, fx.sent);

  // determinism — HARD
  check(JSON.stringify(res) === JSON.stringify(res2), `${f} non-deterministic output`);

  // contract shape — HARD
  check(REQUIRED_KEYS.every((k) => k in res), `${f} missing a required contract key`);
  check(typeof res.edit_ratio === 'number' && res.edit_ratio >= 0 && res.edit_ratio <= 1,
    `${f} edit_ratio out of [0,1]: ${res.edit_ratio}`);
  check(Array.isArray(res.edit_classes) && res.edit_classes.every((c) => EDIT_CLASSES.includes(c)),
    `${f} edit_classes contains an unknown class: ${JSON.stringify(res.edit_classes)}`);
  res.edit_classes.forEach((c) => seenClasses.add(c));

  // label assertions
  if (label.malformed) {
    check(Array.isArray(res.errors) && res.errors.length > 0,
      `${f} expected malformed (errors) but got none`);
  }
  if ('unchanged' in label) {
    check(res.unchanged === label.unchanged,
      `${f} unchanged: expected ${label.unchanged} got ${res.unchanged}`);
  }
  if ('material' in label) {
    check(res.material === label.material,
      `${f} material: expected ${label.material} got ${res.material}`);
  }
  if ('ambiguous' in label) {
    check(res.ambiguous === label.ambiguous,
      `${f} ambiguous: expected ${label.ambiguous} got ${res.ambiguous}`);
  }
  if ('edit_classes' in label) {
    if (label.edit_classes_exact) {
      check(sameSet(res.edit_classes, label.edit_classes),
        `${f} edit_classes exact: expected ${JSON.stringify(label.edit_classes)} got ${JSON.stringify(res.edit_classes)}`);
    } else {
      const missing = label.edit_classes.filter((c) => !res.edit_classes.includes(c));
      check(missing.length === 0,
        `${f} edit_classes subset: missing ${JSON.stringify(missing)} (got ${JSON.stringify(res.edit_classes)})`);
    }
  }
  if (label.no_list_deltas) {
    const listy = ['to', 'cc', 'bcc', 'attachments'].filter((k) => k in res.field_deltas);
    check(listy.length === 0, `${f} unexpected list deltas: ${JSON.stringify(listy)}`);
  }
}

console.log('--- Runner 3 gates ---');
// coverage — every edit class exercised by at least one fixture — HARD
const uncovered = EDIT_CLASSES.filter((c) => !seenClasses.has(c));
check(uncovered.length === 0, `edit-class coverage: uncovered ${JSON.stringify(uncovered)}`);
console.log(`edit-class coverage ${seenClasses.size}/${EDIT_CLASSES.length}`);

console.log(`eval-approval-diff (Runner 3, offline, deterministic): passed=${pass} failed=${fail}  [${files.length} fixtures]`);
process.exit(fail === 0 ? 0 : 1);
