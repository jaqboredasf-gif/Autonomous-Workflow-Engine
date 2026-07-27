// ---------------------------------------------------------------------------
// eval-approval-diff.mjs — assertion harness behind Runner 3.
//
// PURE OFFLINE. No API keys, no model calls, no DB, no network. Loads the
// labelled fixtures under fixtures/approvals/, runs the deterministic diff engine
// (scripts/lib/approval-diff.mjs), and asserts every label. Also proves:
//   * corpus parity — every fixture is labelled and every label has a fixture
//   * determinism  — diff(draft,sent) run twice is byte-identical
//   * contract     — every result has the required shape and valid values
//   * coverage     — every edit class appears in at least one fixture result
//
// Built on @exattime/awe-kernel: the corpus loader, the gate run and the
// determinism/coverage gates are shared with every other runner, so this file
// contains only what is specific to the diff engine. Output format is unchanged.
//
// Exit 0 iff all gates pass; nonzero otherwise. Invoked by scripts/eval-approval-diff.sh.
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGateRun, loadCorpus } from '../packages/awe-kernel/src/index.mjs';
import { diff, EDIT_CLASSES } from './lib/approval-diff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'fixtures', 'approvals');
const REQUIRED_KEYS = ['unchanged', 'edit_ratio', 'field_deltas', 'edit_classes', 'material'];
const LIST_FIELDS = ['to', 'cc', 'bcc', 'attachments'];

const run = createGateRun({ name: 'eval-approval-diff (Runner 3, offline, deterministic)' });
const corpus = loadCorpus({ dir: DIR, name: 'fixtures/approvals' });

// An unlabelled fixture is never asserted and an orphan label is a rule nobody
// checks — both are gate failures, not silent skips.
run.corpusParity(corpus);

for (const { name: f, data: fx, label } of corpus.cases) {
  if (label === null) continue; // already reported by the parity gate

  const res = diff(fx.draft, fx.sent);

  // determinism — HARD
  run.deterministic(() => diff(fx.draft, fx.sent), f);

  // contract shape — HARD
  run.contract(res, REQUIRED_KEYS, f);
  run.check(typeof res.edit_ratio === 'number' && res.edit_ratio >= 0 && res.edit_ratio <= 1,
    `${f} edit_ratio out of [0,1]: ${res.edit_ratio}`);
  run.check(Array.isArray(res.edit_classes) && res.edit_classes.every((c) => EDIT_CLASSES.includes(c)),
    `${f} edit_classes contains an unknown class: ${JSON.stringify(res.edit_classes)}`);
  run.record('edit_class', res.edit_classes);

  // label assertions
  if (label.malformed) {
    run.check(Array.isArray(res.errors) && res.errors.length > 0,
      `${f} expected malformed (errors) but got none`);
  }
  if ('unchanged' in label) run.equal(res.unchanged, label.unchanged, `${f} unchanged`);
  if ('material' in label) run.equal(res.material, label.material, `${f} material`);
  if ('ambiguous' in label) run.equal(res.ambiguous, label.ambiguous, `${f} ambiguous`);
  if ('edit_classes' in label) {
    if (label.edit_classes_exact) {
      run.sameSet(res.edit_classes, label.edit_classes, `${f} edit_classes exact`);
    } else {
      run.includesAll(res.edit_classes, label.edit_classes, `${f} edit_classes subset`);
    }
  }
  if (label.no_list_deltas) {
    const listy = LIST_FIELDS.filter((k) => k in res.field_deltas);
    run.check(listy.length === 0, `${f} unexpected list deltas: ${JSON.stringify(listy)}`);
  }
}

run.section('Runner 3 gates');
// coverage — every edit class exercised by at least one fixture — HARD
run.coverage('edit_class', EDIT_CLASSES, { label: 'edit-class coverage' });

run.summary({ fixtures: corpus.cases.length });
process.exit(run.exitCode);
