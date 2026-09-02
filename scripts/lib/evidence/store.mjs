// Evidence store — the only module in the evidence layer that touches disk.
// Plain JSON files under evidence/, one record per file, so every piece of
// evidence is greppable, diffable and reviewable in git history. Git is the
// audit log: a changed record shows up as a diff with a date and an author.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

export const ROOT = resolve(new URL('../../../', import.meta.url).pathname);
export const EVIDENCE_DIR = join(ROOT, 'evidence');
export const RECORDS_DIR = join(EVIDENCE_DIR, 'records');
export const FROZEN_DIR = join(EVIDENCE_DIR, 'frozen');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

export function loadRecords(dir = RECORDS_DIR) {
  const out = [];
  for (const path of walk(dir)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      out.push({ path, parseError: e.message, record: null });
      continue;
    }
    out.push({ path, record: parsed });
  }
  return out;
}

export function writeRecord(record, dir = RECORDS_DIR) {
  const sub = join(dir, record.record_type);
  mkdirSync(sub, { recursive: true });
  const path = join(sub, `${record.record_id}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function writeJSON(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
  return path;
}

export function loadFreezes(dir = FROZEN_DIR) {
  const out = [];
  for (const path of walk(dir)) {
    try {
      out.push({ path, freeze: JSON.parse(readFileSync(path, 'utf8')) });
    } catch (e) {
      out.push({ path, parseError: e.message, freeze: null });
    }
  }
  return out;
}

/** Latest freeze receipt per baseline (amendments chain forward via prior_hash). */
export function latestFreeze(baselineId, dir = FROZEN_DIR) {
  const all = loadFreezes(dir)
    .map((f) => f.freeze)
    .filter((f) => f && f.baseline_id === baselineId)
    .sort((a, b) => (a.frozen_at < b.frozen_at ? -1 : 1));
  return all.length ? all[all.length - 1] : null;
}

export function freezePath(baselineId, version, dir = FROZEN_DIR) {
  return join(dir, `${baselineId}.v${version}.freeze.json`);
}

export function freezeVersionCount(baselineId, dir = FROZEN_DIR) {
  return loadFreezes(dir).filter((f) => f.freeze && f.freeze.baseline_id === baselineId).length;
}
