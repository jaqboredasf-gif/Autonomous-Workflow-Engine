// ---------------------------------------------------------------------------
// store.mjs — the file-backed task store.
//
// One JSON file per task under .awe/dispatch/tasks/. No database, no daemon, no
// server: a queue you can read in a diff and that cannot lose work when a
// process dies.
//
// Claims use an atomic lock file created with the 'wx' flag — open-exclusive,
// which fails if the file already exists. That is the one place two local
// workers could race, and `wx` is the primitive that settles it without a
// coordinator.
//
// This is the I/O module for dispatch; state.mjs, handoff.mjs and verify.mjs
// stay pure.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const DISPATCH_ROOT = join('.awe', 'dispatch');
const TASKS = join(DISPATCH_ROOT, 'tasks');
const LOCKS = join(DISPATCH_ROOT, 'locks');
const HANDOFFS = join(DISPATCH_ROOT, 'handoffs');

export function paths(root) {
  return {
    tasks: join(root, TASKS),
    locks: join(root, LOCKS),
    handoffs: join(root, HANDOFFS),
  };
}

export function ensureDirs(root) {
  for (const d of Object.values(paths(root))) mkdirSync(d, { recursive: true });
}

/** Atomic write: write a temp file, then rename over the target. */
export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function saveTask(root, task) {
  ensureDirs(root);
  writeJsonAtomic(join(paths(root).tasks, `${task.task_id}.json`), task);
  return task;
}

export function loadTask(root, id) {
  const p = join(paths(root).tasks, `${id}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function listTasks(root) {
  const dir = paths(root).tasks;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(a.task_id).localeCompare(String(b.task_id)));
}

export function tasksById(root) {
  return Object.fromEntries(listTasks(root).map((t) => [t.task_id, t]));
}

/**
 * Take an exclusive local claim. Returns { ok, owner, reason }.
 * `wx` fails if the lock exists, which is what makes a second claim lose rather
 * than silently overwrite the first.
 */
export function acquireClaim(root, taskId, owner, at) {
  ensureDirs(root);
  const lock = join(paths(root).locks, `${taskId}.lock`);
  try {
    const fd = openSync(lock, 'wx');
    closeSync(fd);
    writeFileSync(lock, `${JSON.stringify({ task_id: taskId, owner, at }, null, 2)}\n`, 'utf8');
    return { ok: true, owner };
  } catch {
    let held = null;
    try { held = JSON.parse(readFileSync(lock, 'utf8')); } catch { /* unreadable lock is still a lock */ }
    return { ok: false, owner: held?.owner || 'unknown', reason: 'already claimed', held };
  }
}

export function releaseClaim(root, taskId) {
  const lock = join(paths(root).locks, `${taskId}.lock`);
  try { unlinkSync(lock); return true; } catch { return false; }
}

export function readClaim(root, taskId) {
  const lock = join(paths(root).locks, `${taskId}.lock`);
  if (!existsSync(lock)) return null;
  try { return JSON.parse(readFileSync(lock, 'utf8')); } catch { return null; }
}

export function saveHandoff(root, taskId, handoff) {
  ensureDirs(root);
  const p = join(paths(root).handoffs, `${taskId}.json`);
  writeJsonAtomic(p, handoff);
  return p;
}

export function loadHandoff(root, taskId) {
  const p = join(paths(root).handoffs, `${taskId}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
