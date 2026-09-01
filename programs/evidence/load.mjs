// ---------------------------------------------------------------------------
// load.mjs — read the evidence records off disk, and refuse to inflate.
//
// ONE RULE, and everything else follows from it: A RECORD THAT DOES NOT
// VALIDATE IS NOT COUNTED AND IS NOT SILENT. It is excluded from every number
// and reported by filename with the reason, so the failure mode is "the command
// tells you file three is broken" rather than "the number is quietly four
// instead of five".
//
// AND IT NEVER THROWS. `derive.mjs` calls this on the way to every readiness
// figure in the repository, and a single malformed capture file should not take
// down `npm run plan` on a Tuesday morning. Problems are data.
//
// Formats accepted, in order of how likely they are to be written by a person
// standing in a car park:
//
//   .md    a field sheet — `key: value` lines. Imported to .json by
//          `npm run evidence -- --import`, and NOT read as evidence directly:
//          the import is where the refusals happen, and evidence that skipped
//          validation is the thing this file exists to prevent.
//   .json  one record, or an array of them
//   .mjs   exports the record(s), for anything that needs a comment
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECORDS = join(HERE, 'records');

/**
 * Every record in one directory, validated by `make`.
 *
 * @returns {{records: object[], problems: {file: string, reason: string}[], sheets: string[]}}
 */
export async function loadRecords(dir, make, { shape = (v) => v?.id } = {}) {
  const records = [];
  const problems = [];
  const sheets = [];
  if (!existsSync(dir)) return { records, problems, sheets };

  for (const f of readdirSync(dir).sort()) {
    const full = join(dir, f);
    // A field sheet that was never imported is a real and common state — the
    // note was taken and the import not run — so it is reported as waiting,
    // not as broken.
    if (f.endsWith('.md') && f !== 'README.md') { sheets.push(f); continue; }
    if (!/\.(json|mjs)$/.test(f)) continue;
    try {
      if (f.endsWith('.json')) {
        const raw = JSON.parse(readFileSync(full, 'utf8'));
        for (const r of Array.isArray(raw) ? raw : [raw]) records.push(make(r));
      } else {
        const mod = await import(full);
        for (const v of Object.values(mod)) {
          if (Array.isArray(v)) { for (const x of v) if (shape(x)) records.push(x); }
          else if (shape(v)) records.push(v);
        }
      }
    } catch (e) {
      problems.push({ file: `${dir.split('/').slice(-2).join('/')}/${f}`, reason: e.message });
    }
  }
  return { records, problems, sheets };
}

/** Everything the founder has collected that is not a customer interview. */
export async function loadEvidence({ root = RECORDS } = {}) {
  const C = await import('./comprehension.mjs');
  const M = await import('./mock-pitch.mjs');
  const F = await import('./founder-story.mjs');

  const comprehension = await loadRecords(join(root, 'comprehension'), C.comprehensionTest);
  const pitches = await loadRecords(join(root, 'mock-pitch'), M.mockPitch);

  let story = F.founderStory({});
  const problems = [...comprehension.problems, ...pitches.problems];
  const storyFile = join(root, 'founder-story.json');
  if (existsSync(storyFile)) {
    try { story = F.founderStory(JSON.parse(readFileSync(storyFile, 'utf8'))); }
    catch (e) { problems.push({ file: 'records/founder-story.json', reason: e.message }); }
  }

  return {
    comprehension: comprehension.records,
    comprehensionSummary: C.comprehensionSummary(comprehension.records),
    versions: C.byVersion(comprehension.records),
    mockPitches: pitches.records,
    mockPitchFacts: M.mockPitchFacts(pitches.records),
    mockPitchLearning: M.mockPitchLearning(pitches.records),
    founderStory: story,
    problems,
    unimported: [...comprehension.sheets.map((f) => `comprehension/${f}`), ...pitches.sheets.map((f) => `mock-pitch/${f}`)],
  };
}
