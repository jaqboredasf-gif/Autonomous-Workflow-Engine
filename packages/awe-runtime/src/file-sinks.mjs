// ---------------------------------------------------------------------------
// file-sinks.mjs — the local-filesystem implementations of the kernel's
// ArtifactSink, AuditSink and (for context checkpoints) DocumentSink
// boundaries.
//
// Lives in `packages/` rather than `scripts/` because deployable surfaces need
// it: the MCP server persists a run report for every call, and a package cannot
// import from the repo's script directory without inverting the dependency.
// `scripts/lib/artifact-store.mjs` re-exports it unchanged, so every runner
// that already imported it there is unaffected.
//
// This is the FIRST implementation, not the permanent one. The kernel defines
// the interfaces (packages/awe-kernel/src/sinks.mjs) precisely so that a
// Supabase table, an object store or an append-only log can replace this module
// without a workflow changing a line. That successor is deliberately not chosen
// here: the harness database access path is ADR-0002 and is unresolved.
//
// Why the writer lives outside the kernel: the kernel's layering lint forbids
// filesystem writes, and it should — a module that writes cannot be part of a
// determinism gate. Everything about WHAT is written is decided by pure kernel
// code (report.mjs); this file only decides WHERE and HOW.
//
// Properties:
//   * atomic       — write to a temp file in the destination directory, then
//                    rename. A reader never sees a half-written report, and a
//                    crash mid-write leaves the previous artifact intact.
//   * deterministic— the bytes are `serializeReport()` (canonical JSON), and the
//                    temp name is derived from the report digest, not from a
//                    random suffix or a clock, so a replayed run is idempotent.
//   * contained    — every path is resolved and checked to stay under `root`; a
//                    workflow id cannot walk out of the artifact directory.
//   * offline      — filesystem only. No network, no credentials, no database.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { canonicalJson, createArtifactSink, createAuditSink, serializeReport } from '../../awe-kernel/src/index.mjs';

// Repo-relative default. Gitignored: run artifacts are evidence of a run, not
// source, and committing them would make every regression run a diff.
export const DEFAULT_ARTIFACT_ROOT = 'artifacts';

function containedPath(root, relative) {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relative);
  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + sep)) {
    throw new Error(`artifact path '${relative}' escapes the artifact root`);
  }
  return target;
}

/**
 * createFileArtifactSink({ root }) -> ArtifactSink
 *
 * write(report, { path }) -> { ok, ref, bytes, error }
 * `ref` is the absolute path of the stored artifact.
 */
export function createFileArtifactSink({ root = DEFAULT_ARTIFACT_ROOT, name = 'local_file' } = {}) {
  return Object.freeze({
    ...createArtifactSink({
      name,
      write(report, { path } = {}) {
        try {
          const relative = path ?? `${report.run_id}.json`;
          const target = containedPath(root, relative);
          mkdirSync(dirname(target), { recursive: true });

          const bytes = serializeReport(report);
          // Same directory as the target so the rename is same-filesystem, and
          // therefore atomic. The digest keys the temp file, so two concurrent
          // writers of the SAME report cannot corrupt each other, and two
          // writers of different reports never collide.
          const temp = `${target}.${report.report_digest}.tmp`;
          writeFileSync(temp, bytes, { encoding: 'utf8', mode: 0o600 });
          renameSync(temp, target);

          return { ok: true, ref: target, bytes: bytes.length, error: null };
        } catch (e) {
          // Reported, never thrown: a full disk must not turn a correct run into
          // a crash. runWorkflow downgrades the run's final state instead.
          return { ok: false, ref: null, bytes: 0, error: String(e?.message ?? e) };
        }
      },
    }),
    root,
  });
}

/**
 * createFileAuditSink({ root }) -> AuditSink
 *
 * Appends sanitized audit events as JSON Lines under `<root>/audit/<org>.jsonl`.
 * This is a holding pattern with a named successor: `integration_events` is the
 * platform's audit substrate, and moving there is a sink swap once ADR-0002
 * settles how harness code reaches the database. Until then a run still leaves a
 * durable, greppable audit trail instead of nothing.
 */
export function createFileAuditSink({ root = DEFAULT_ARTIFACT_ROOT, name = 'local_file' } = {}) {
  return createAuditSink({
    name,
    emit(events, context) {
      try {
        if (events.length === 0) return { ok: true, written: 0, ref: null, error: null };
        const scope = context?.org_id ?? 'no_org';
        const target = containedPath(root, join('audit', `${scope}.jsonl`));
        mkdirSync(dirname(target), { recursive: true });

        // Events are already redacted and content-addressed by the kernel; the
        // run ids make a line traceable back to its report.
        const lines = events.map((e) => JSON.stringify({
          run_id: context?.run_id ?? null,
          workflow_id: context?.workflow_id ?? null,
          ...e,
        })).join('\n');
        writeFileSync(target, `${lines}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });

        return { ok: true, written: events.length, ref: target, error: null };
      } catch (e) {
        return { ok: false, written: 0, ref: null, error: String(e?.message ?? e) };
      }
    },
  });
}

/**
 * createFileDocumentSink({ root }) -> DocumentSink
 *
 * write(document, { path }) -> { ok, ref, bytes, error }
 *
 * The same atomic, contained, canonical writer for documents that are NOT run
 * reports — today, context checkpoints (`awe.context_checkpoint/v1`). It is a
 * separate sink rather than a looser ArtifactSink on purpose: an ArtifactSink
 * asserts the run-report schema on every write, and widening it to "any object"
 * would silently retire that check for the reports too.
 *
 * The document must carry its own `schema` and its own self-digest; this writer
 * verifies neither, because the kernel builder that produced it already did.
 */
export function createFileDocumentSink({ root = DEFAULT_ARTIFACT_ROOT, name = 'local_document' } = {}) {
  return Object.freeze({
    kind: 'document_sink',
    name,
    write(document, { path } = {}) {
      try {
        if (typeof path !== 'string' || path.length === 0) {
          return { ok: false, ref: null, bytes: 0, error: 'a document write needs a path' };
        }
        const target = containedPath(root, path);
        mkdirSync(dirname(target), { recursive: true });

        const bytes = `${canonicalJson(document)}\n`;
        const temp = `${target}.tmp`;
        writeFileSync(temp, bytes, { encoding: 'utf8', mode: 0o600 });
        renameSync(temp, target);

        return { ok: true, ref: target, bytes: bytes.length, error: null };
      } catch (e) {
        return { ok: false, ref: null, bytes: 0, error: String(e?.message ?? e) };
      }
    },
    root,
  });
}

// --- Read side (operators and tests) ----------------------------------------

export function readArtifact(reference) {
  return JSON.parse(readFileSync(reference, 'utf8'));
}

// Every artifact under `root`, relative and sorted — a deterministic listing for
// a test or an operator, without shelling out to `find`.
export function listArtifacts(root = DEFAULT_ARTIFACT_ROOT, { extension = '.json' } = {}) {
  const absoluteRoot = resolve(root);
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, relative);
      else if (entry.endsWith(extension)) out.push(relative);
    }
  };
  walk(absoluteRoot, '');
  return out;
}
