// ---------------------------------------------------------------------------
// corpus.mjs — labelled fixture corpora.
//
// Every deterministic runner in this repo does the same four things by hand:
// list a fixture directory, sort it, read `labels.json`, and hope the two
// agree. When they silently disagree the eval still exits 0 — a fixture with no
// label is simply never asserted, which is the worst possible failure mode for
// a safety suite.
//
// A corpus here loads both halves and reports the disagreements as data
// (`problems`), so a runner can fail them as gates instead of skipping them.
// The parity rule itself (`corpusParity`) is a pure function, testable without
// touching a filesystem.
//
// PURE except for `loadCorpus`, which reads files. No writes, no clock, no
// randomness, no network anywhere in this module.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { KernelError, invariant } from './errors.mjs';

// The disagreements between a set of case files and a set of labels. Both
// directions are failures: an unlabelled case is never asserted, and an orphan
// label is a rule nobody is checking any more.
export function corpusParity(caseNames, labelKeys) {
  const cases = new Set(caseNames);
  const labels = new Set(labelKeys);
  return {
    missingLabels: [...cases].filter((n) => !labels.has(n)).sort(),
    orphanLabels: [...labels].filter((n) => !cases.has(n)).sort(),
  };
}

// Build a corpus from already-read data. `loadCorpus` is a thin filesystem
// wrapper around this, and tests use it directly.
// Label files in this repo carry documentation keys alongside the per-case
// entries (`_comment`, `_readme`). Anything starting with `metaPrefix` is
// metadata, not a case label, and is excluded from parity.
export function buildCorpus({ name, labels, entries, metaPrefix = '_' }) {
  invariant(labels !== null && typeof labels === 'object', 'invalid_input', `corpus '${name}' labels must be an object`, {});
  invariant(Array.isArray(entries), 'invalid_input', `corpus '${name}' entries must be an array`, {});

  const problems = [];
  const cases = [];

  for (const entry of entries) {
    if (entry.parseError) {
      problems.push({ kind: 'parse_error', name: entry.name, message: entry.parseError });
      continue;
    }
    cases.push(Object.freeze({
      name: entry.name,
      path: entry.path ?? null,
      data: entry.data,
      label: labels[entry.name] ?? null,
    }));
  }

  const caseLabels = Object.keys(labels).filter((k) => !k.startsWith(metaPrefix));
  const parity = corpusParity(cases.map((c) => c.name), caseLabels);
  for (const n of parity.missingLabels) {
    problems.push({ kind: 'missing_label', name: n, message: `${n} has no entry in the label file` });
  }
  for (const n of parity.orphanLabels) {
    problems.push({ kind: 'orphan_label', name: n, message: `label '${n}' has no fixture file` });
  }

  const byName = new Map(cases.map((c) => [c.name, c]));

  return Object.freeze({
    name,
    labels,
    cases: Object.freeze(cases),
    problems: Object.freeze(problems),
    parity: Object.freeze(parity),
    ok: problems.length === 0,
    get(caseName) {
      const c = byName.get(caseName);
      invariant(c !== undefined, 'invalid_input', `corpus '${name}' has no case '${caseName}'`, { caseName });
      return c;
    },
    // Cases whose label carries a given key, for building targeted gate loops.
    withLabelKey(key) {
      return cases.filter((c) => c.label !== null && Object.prototype.hasOwnProperty.call(c.label, key));
    },
    assertClean() {
      invariant(
        problems.length === 0,
        'corpus_parity',
        `corpus '${name}' is inconsistent: ${problems.map((p) => `${p.kind}:${p.name}`).join(', ')}`,
        { problems },
      );
      return true;
    },
  });
}

// Load a labelled corpus off disk. `casesDir` defaults to `dir`, which covers
// the flat layout (fixtures/approvals); pass it explicitly for the nested one
// (fixtures/outbound/cases). Non-case companions (`policies.json`,
// `base-row.json`, ...) are excluded via `ignore`.
export function loadCorpus({
  dir,
  casesDir = null,
  labelsFile = 'labels.json',
  ignore = [],
  extension = '.json',
  name = null,
  metaPrefix = '_',
}) {
  invariant(typeof dir === 'string' && dir.length > 0, 'invalid_input', 'loadCorpus needs a dir', { dir });

  const cases = casesDir ?? dir;
  const labelsPath = join(dir, labelsFile);
  const skip = new Set([labelsFile, ...ignore]);

  let labels;
  try {
    labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
  } catch (e) {
    // An unreadable label file is not a case-level problem to be reported — it
    // means the corpus cannot be asserted at all, so fail loudly and early.
    throw new KernelError('corpus_parity', `cannot read labels at ${labelsPath}: ${e.message}`, { labelsPath });
  }

  const entries = readdirSync(cases)
    .filter((f) => f.endsWith(extension) && !skip.has(f))
    .filter((f) => statSync(join(cases, f)).isFile())
    .sort()
    .map((f) => {
      const path = join(cases, f);
      try {
        return { name: f, path, data: JSON.parse(readFileSync(path, 'utf8')) };
      } catch (e) {
        return { name: f, path, parseError: `${f} is not valid JSON: ${e.message}` };
      }
    });

  const corpus = buildCorpus({ name: name ?? dir, labels, entries, metaPrefix });
  return Object.freeze({ ...corpus, dir, casesDir: cases, labelsPath });
}
