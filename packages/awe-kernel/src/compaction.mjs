// ---------------------------------------------------------------------------
// compaction.mjs — deterministic, model-independent context compaction.
//
// A long-running or resumed run accumulates more context than any budget can
// carry. The industry-default answer is "ask the model to summarize it", which
// is three bad properties at once: it is non-deterministic, so a run cannot be
// replayed; it is vendor-coupled, so the platform's memory depends on one API;
// and it is lossy in an unrecorded way, so nobody can afterwards say what the
// run stopped knowing.
//
// This is the deterministic layer underneath that. Six mechanisms, applied in a
// fixed order, each of which a human can predict and a test can pin:
//
//   1. de-duplicate      — same fact twice, keep the higher-priority copy
//   2. expire            — older than the caller's window, where the kind allows
//   3. substitute        — body dropped, artifact reference kept
//   4. summarize         — a run of same-source items collapsed structurally
//   5. priority floor    — below the caller's floor, dropped
//   6. budget            — what still does not fit, dropped
//
// The invariants, which the tests enforce:
//
//   * no silent loss     — every item is accounted for in the ledger with an
//                          action from a closed vocabulary. Retained, dropped,
//                          summarized or substituted; there is no fifth option.
//   * no trust promotion — a summary inherits the MAXIMUM sensitivity and the
//                          MINIMUM trust of its inputs. Compaction can never
//                          launder a customer email into an internal fact (G10).
//   * tenant preserved   — a summary is bound to the same tenant as its inputs,
//                          and cross-tenant inputs cannot be summarized together.
//   * reproducible       — identical bundle plus identical options gives
//                          identical bytes, including the digests.
//
// A model-assisted compactor is anticipated and NOT mandatory: pass a
// `summarizer` and it produces the summary text instead of the structural
// default. It is still held to every invariant above — the kernel labels and
// binds the result, the summarizer only writes the words. Nothing in this
// module imports, requires or assumes a provider.
//
// PURE: no clock, no randomness, no I/O. Age is measured against a caller-
// supplied `as_of` instant, because a kernel that reads the clock cannot be
// part of a determinism gate.
// ---------------------------------------------------------------------------

import { canonicalClone, deepFreeze, digest } from './canonical.mjs';
import { assembleContext, assertContextBundle } from './assembly.mjs';
import {
  compareContextItems, createContextItem, estimateItems, maxSensitivity, sensitivityRank,
} from './context-item.mjs';
import { assertExecutionContext } from './context.mjs';
import { invariant } from './errors.mjs';
import { instantEpochSeconds, isInstant } from './events.mjs';

export const CONTEXT_CHECKPOINT_SCHEMA = 'awe.context_checkpoint/v1';

export const CHECKPOINT_KEYS = [
  'schema', 'checkpoint_id', 'run_id', 'workflow_id', 'org_id', 'mode', 'is_fixture',
  'created_at', 'source_bundle_digest', 'items', 'item_count', 'token_count',
  'budget', 'ledger', 'stats', 'checkpoint_digest',
];

// What happened to an item. Closed: an item whose fate is not one of these is a
// bug in this module, not a new category.
export const COMPACTION_ACTIONS = [
  'retained',
  'dropped_duplicate',
  'dropped_expired',
  'dropped_priority',
  'dropped_budget',
  'summarized',            // folded INTO a derived summary (the input's fate)
  'substituted_artifact',  // body replaced by its artifact reference
  'created_summary',       // the derived summary itself (the output's origin)
];

// Kinds that age may never remove. A policy the org set and a decision a human
// made do not become irrelevant because they are old; dropping them silently is
// how an automated system forgets it was told not to do something.
export const NON_EXPIRABLE_KINDS = ['policy', 'human_decision'];

const DEFAULT_SUBSTITUTE_OVER_TOKENS = 400;
const DEFAULT_SUMMARIZE_MIN_GROUP = 3;

function ledgerEntry(item, action, { reason = null, from_tokens = null, to_tokens = null, replaced_by = null } = {}) {
  invariant(
    COMPACTION_ACTIONS.includes(action),
    'invalid_input', `unknown compaction action '${action}'`, { action, known: COMPACTION_ACTIONS },
  );
  return {
    id: item.id,
    kind: item.kind,
    source: item.source,
    action,
    reason,
    from_tokens: from_tokens ?? item.tokens,
    to_tokens,
    replaced_by,
  };
}

// The default, deterministic summarizer: a structural digest of a group of
// items. It counts rather than paraphrases — how many items, over what span, of
// which kinds, from which source, with which ids — which is exactly the
// information a later reader needs to decide whether to go and fetch the
// originals. It invents nothing, so it cannot hallucinate.
export function structuralSummary(items) {
  const ids = items.map((i) => i.id).sort();
  const kinds = [...new Set(items.map((i) => i.kind))].sort();
  const times = items.map((i) => i.occurred_at).filter((t) => t !== null).sort();
  const eventTypes = [...new Set(
    items.map((i) => i.metadata?.event_type).filter((t) => typeof t === 'string'),
  )].sort();

  const counts = eventTypes
    .map((type) => `${type}=${items.filter((i) => i.metadata?.event_type === type).length}`)
    .join(', ');

  const lines = [
    `${items.length} ${kinds.join('/')} item(s) from ${items[0].source}, compacted.`,
    times.length > 0 ? `span: ${times[0]} .. ${times[times.length - 1]}` : 'span: unknown',
    counts.length > 0 ? `event types: ${counts}` : null,
    `ids: ${ids.join(', ')}`,
  ].filter((l) => l !== null);

  return { content: lines.join('\n') };
}

// Build the derived-summary item for a group, applying the rules a summarizer
// is not trusted to apply itself.
function buildSummaryItem(group, { summarizer, org_id }) {
  const produced = (summarizer ?? structuralSummary)(group);
  invariant(
    produced !== null && typeof produced === 'object' && typeof produced.content === 'string',
    'contract_violation', 'a summarizer must return { content: string }', { source: group[0].source },
  );

  // Trust and sensitivity are decided HERE, from the inputs, never by the
  // summarizer. A model-assisted compactor summarizing a customer email cannot
  // hand back an "internal, trusted" fact.
  const sensitivity = maxSensitivity(group.map((i) => i.sensitivity));
  const trusted = group.every((i) => i.trusted);
  const priority = Math.max(...group.map((i) => i.priority));
  const times = group.map((i) => i.occurred_at).filter((t) => t !== null).sort();

  return createContextItem({
    // Content-addressed: the same group summarized twice is the same item, with
    // the same id, so a re-run overwrites rather than accumulates.
    id: `summary-${digest({ ids: group.map((i) => i.id).sort(), content: produced.content })}`,
    kind: 'derived_summary',
    source: group[0].source,
    org_id,
    sensitivity,
    trusted,
    priority,
    occurred_at: times.length > 0 ? times[times.length - 1] : null,
    content: produced.content,
    provenance: {
      compacted_from: group.map((i) => i.id).sort(),
      input_count: group.length,
      input_tokens: estimateItems(group),
      input_fingerprints: group.map((i) => i.fingerprint).sort(),
      summarizer: summarizer ? 'custom' : 'structural',
    },
    metadata: { derived: true },
  });
}

/**
 * compactContext(bundle, options) -> { bundle, ledger, stats }
 *
 * Options (every one optional; omitting all of them is a no-op that still
 * produces a full `retained` ledger):
 *
 *   max_tokens               number   — final token ceiling
 *   max_items                number   — final item ceiling
 *   as_of                    instant  — "now", supplied by the caller
 *   max_age_seconds          number   — with `as_of`, the expiry window
 *   expirable_kinds          string[] — defaults to every kind except policy
 *                                       and human_decision
 *   min_priority             number   — drop below this floor
 *   substitute_over_tokens   number   — bodies larger than this are replaced by
 *                                       their artifact_ref, when they have one
 *   summarize_kinds          string[] — kinds eligible for grouping
 *   summarize_min_group      number   — group size at which summarizing starts
 *   summarizer               fn       — optional model-assisted replacement for
 *                                       the structural summary
 */
export function compactContext(bundle, {
  max_tokens = null,
  max_items = null,
  as_of = null,
  max_age_seconds = null,
  expirable_kinds = null,
  min_priority = null,
  substitute_over_tokens = DEFAULT_SUBSTITUTE_OVER_TOKENS,
  summarize_kinds = [],
  summarize_min_group = DEFAULT_SUMMARIZE_MIN_GROUP,
  summarizer = null,
} = {}) {
  assertContextBundle(bundle, { at: 'compactContext' });
  invariant(
    as_of === null || isInstant(as_of),
    'invalid_input', `as_of must be an ISO-8601 instant or null, got '${as_of}'`, { as_of },
  );
  invariant(
    max_age_seconds === null || (Number.isInteger(max_age_seconds) && max_age_seconds >= 0),
    'invalid_input', 'max_age_seconds must be a non-negative integer or null', { max_age_seconds },
  );
  invariant(
    !(max_age_seconds !== null && as_of === null),
    'invalid_input', 'age-based pruning needs an `as_of` instant — the kernel has no clock', {},
  );
  invariant(
    summarizer === null || typeof summarizer === 'function',
    'invalid_input', 'summarizer must be a function or null', {},
  );
  invariant(Array.isArray(summarize_kinds), 'invalid_input', 'summarize_kinds must be an array', {});

  const ledger = [];
  const expirable = expirable_kinds ?? null;

  // --- 1. de-duplicate ------------------------------------------------------
  // The bundle is already ordered; the first copy seen is the one the ordering
  // rule selected.
  const seen = new Map();
  let items = [];
  for (const item of bundle.items) {
    if (seen.has(item.fingerprint)) {
      ledger.push(ledgerEntry(item, 'dropped_duplicate', {
        reason: `same content as '${seen.get(item.fingerprint)}'`, to_tokens: 0,
      }));
      continue;
    }
    seen.set(item.fingerprint, item.id);
    items.push(item);
  }

  // --- 2. expire ------------------------------------------------------------
  if (max_age_seconds !== null) {
    const cutoff = instantEpochSeconds(as_of) - max_age_seconds;
    const kept = [];
    for (const item of items) {
      const mayExpire = expirable === null
        ? !NON_EXPIRABLE_KINDS.includes(item.kind)
        : expirable.includes(item.kind);
      // An item with no timestamp has no age, and the kernel will not invent
      // one to justify deleting it.
      if (mayExpire && item.occurred_at !== null && instantEpochSeconds(item.occurred_at) < cutoff) {
        ledger.push(ledgerEntry(item, 'dropped_expired', {
          reason: `occurred_at ${item.occurred_at} is older than ${max_age_seconds}s before ${as_of}`, to_tokens: 0,
        }));
        continue;
      }
      kept.push(item);
    }
    items = kept;
  }

  // --- 3. substitute artifact references ------------------------------------
  // The body goes, the pointer and the content digest stay. Nothing is lost —
  // it is one read away — and the ledger says exactly where it went.
  items = items.map((item) => {
    if (item.artifact_ref === null || item.content === null || item.tokens <= substitute_over_tokens) return item;
    const substituted = createContextItem({
      ...item,
      content: null,
      tokens: null,
      provenance: {
        ...item.provenance,
        substituted_content_digest: digest(item.content),
        substituted_content_tokens: item.tokens,
      },
    });
    ledger.push(ledgerEntry(item, 'substituted_artifact', {
      reason: `body of ${item.tokens} tokens replaced by artifact_ref`,
      to_tokens: substituted.tokens,
      replaced_by: substituted.id,
    }));
    return substituted;
  });

  // --- 4. structural summarization ------------------------------------------
  // Groups are (source, kind) runs within an eligible kind. Grouping by source
  // as well as kind is what keeps a summary honest: "12 tool results" from two
  // different tools is not one fact.
  if (summarize_kinds.length > 0) {
    const groups = new Map();
    for (const item of items) {
      if (!summarize_kinds.includes(item.kind)) continue;
      const key = `${item.source} ${item.kind}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }

    const folded = new Set();
    const summaries = [];
    for (const [, group] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (group.length < summarize_min_group) continue;
      // Cross-tenant inputs can never be folded together: the summary would be
      // bound to one tenant while carrying another's content.
      const orgs = new Set(group.map((i) => i.org_id));
      invariant(
        orgs.size === 1,
        'contract_violation', `cannot summarize items from ${orgs.size} tenants together`,
        { source: group[0].source, orgs: [...orgs] },
      );
      const summary = buildSummaryItem(group, { summarizer, org_id: group[0].org_id });

      // Compaction may never GROW the context. A structural summary of three
      // one-line items is longer than the items, and a model-assisted
      // summarizer can be verbose; in either case the honest answer is to keep
      // the originals. Skipping is silent only in the sense that nothing was
      // lost — the group is still in the ledger as `retained` further down.
      if (summary.tokens >= estimateItems(group)) continue;

      // Sensitivity may only move toward MORE restricted. Asserted rather than
      // assumed, because this is the invariant a future model-assisted
      // compactor is most likely to break.
      for (const input of group) {
        invariant(
          sensitivityRank(summary.sensitivity) >= sensitivityRank(input.sensitivity),
          'contract_violation', `summary '${summary.id}' would declassify '${input.id}'`,
          { summary: summary.sensitivity, input: input.sensitivity },
        );
        invariant(
          summary.trusted === false || input.trusted === true,
          'contract_violation', `summary '${summary.id}' would promote untrusted input '${input.id}' to trusted`,
          { input: input.id },
        );
        folded.add(input.id);
        ledger.push(ledgerEntry(input, 'summarized', {
          reason: `folded into '${summary.id}'`, to_tokens: 0, replaced_by: summary.id,
        }));
      }
      ledger.push(ledgerEntry(summary, 'created_summary', {
        reason: `structural summary of ${group.length} item(s)`,
        from_tokens: estimateItems(group),
        to_tokens: summary.tokens,
      }));
      summaries.push(summary);
    }
    items = [...items.filter((i) => !folded.has(i.id)), ...summaries].sort(compareContextItems);
  }

  // --- 5. priority floor ----------------------------------------------------
  if (min_priority !== null) {
    const kept = [];
    for (const item of items) {
      if (item.priority < min_priority) {
        ledger.push(ledgerEntry(item, 'dropped_priority', {
          reason: `priority ${item.priority} below floor ${min_priority}`, to_tokens: 0,
        }));
        continue;
      }
      kept.push(item);
    }
    items = kept;
  }

  // --- 6. budget ------------------------------------------------------------
  const tokenCeiling = max_tokens ?? bundle.budget.max_tokens;
  const itemCeiling = max_items ?? bundle.budget.max_items;
  const kept = [];
  let used = 0;
  for (const item of items) {
    if (kept.length >= itemCeiling) {
      ledger.push(ledgerEntry(item, 'dropped_budget', { reason: `item budget ${itemCeiling} reached`, to_tokens: 0 }));
      continue;
    }
    if (used + item.tokens > tokenCeiling) {
      ledger.push(ledgerEntry(item, 'dropped_budget', {
        reason: `${item.tokens} tokens would exceed ${tokenCeiling} (used ${used})`, to_tokens: 0,
      }));
      continue;
    }
    kept.push(item);
    used += item.tokens;
  }
  for (const item of kept) ledger.push(ledgerEntry(item, 'retained', { to_tokens: item.tokens }));

  const actions = Object.fromEntries(
    COMPACTION_ACTIONS.map((a) => [a, ledger.filter((e) => e.action === a).length]),
  );
  const stats = {
    input_items: bundle.item_count,
    input_tokens: bundle.token_count,
    output_items: kept.length,
    output_tokens: used,
    // Counted from the ledger, not by differencing the two bundles: a summary
    // is an ADDED item, so item counts alone would understate what was removed.
    removed_items: actions.dropped_duplicate + actions.dropped_expired
      + actions.dropped_priority + actions.dropped_budget + actions.summarized,
    actions,
  };

  // Rebuilt through the assembler so the result is a real bundle — same
  // contract, same digest rule, same tenant check — and not a hand-shaped
  // object that merely resembles one.
  const compacted = assembleContext({
    context: {
      run_id: bundle.run_id,
      workflow_id: bundle.workflow_id,
      org_id: bundle.org_id,
      actor: bundle.actor,
      mode: bundle.mode,
      is_fixture: bundle.is_fixture,
      started_at: null,
      deadline_at: null,
      trace_id: bundle.trace_id,
      attributes: {},
    },
    items: kept,
    budget: { max_tokens: tokenCeiling, max_items: itemCeiling },
    assembled_at: bundle.assembled_at,
    compaction: {
      compacted_from: bundle.bundle_digest,
      stats,
      // The ledger is sorted so an identical compaction is byte-identical
      // whichever mechanism recorded an entry first.
      ledger: [...ledger].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1
        : a.action < b.action ? -1 : a.action > b.action ? 1 : 0)),
    },
  });

  return Object.freeze({ bundle: compacted, ledger: Object.freeze(ledger), stats: Object.freeze(stats) });
}

/**
 * createCheckpoint(bundle, { created_at, checkpoint_id }) -> frozen checkpoint
 *
 * The resumable form. A checkpoint is what an unattended run writes before it
 * stops and reads when it starts again: the compacted items, the ledger that
 * explains what is missing, the budget it was operating under, and the digest
 * of the bundle it came from — so a resumed run can prove it resumed the run it
 * thinks it did.
 *
 * `checkpoint_id` is derived from content when not supplied, so writing the
 * same checkpoint twice is idempotent rather than duplicating.
 */
export function createCheckpoint(bundle, { created_at = null, checkpoint_id = null } = {}) {
  assertContextBundle(bundle, { at: 'createCheckpoint' });
  invariant(
    created_at === null || isInstant(created_at),
    'invalid_input', `created_at must be an ISO-8601 instant or null, got '${created_at}'`, { created_at },
  );

  const body = {
    schema: CONTEXT_CHECKPOINT_SCHEMA,
    checkpoint_id: checkpoint_id ?? `ckpt-${digest({ run_id: bundle.run_id, bundle: bundle.bundle_digest })}`,
    run_id: bundle.run_id,
    workflow_id: bundle.workflow_id,
    org_id: bundle.org_id,
    mode: bundle.mode,
    is_fixture: bundle.is_fixture,
    created_at,
    source_bundle_digest: bundle.bundle_digest,
    items: canonicalClone(bundle.items),
    item_count: bundle.item_count,
    token_count: bundle.token_count,
    budget: canonicalClone(bundle.budget),
    ledger: canonicalClone(bundle.compaction?.ledger ?? []),
    stats: canonicalClone(bundle.compaction?.stats ?? null),
  };

  return deepFreeze({ ...body, checkpoint_digest: digest(body) });
}

export function assertCheckpoint(checkpoint, where = {}) {
  invariant(
    checkpoint !== null && typeof checkpoint === 'object' && !Array.isArray(checkpoint),
    'contract_violation', 'checkpoint must be an object', { ...where },
  );
  for (const key of CHECKPOINT_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(checkpoint, key),
      'contract_violation', `checkpoint is missing '${key}'`, { ...where, key },
    );
  }
  invariant(
    checkpoint.schema === CONTEXT_CHECKPOINT_SCHEMA,
    'contract_violation', `checkpoint schema '${checkpoint.schema}' is not '${CONTEXT_CHECKPOINT_SCHEMA}'`, { ...where },
  );
  checkpoint.items.forEach((item) => invariant(
    item.org_id === null || item.org_id === checkpoint.org_id,
    'contract_violation', `checkpoint for org '${checkpoint.org_id}' carries an item bound to '${item.org_id}'`,
    { ...where, item_id: item.id },
  ));
  const { checkpoint_digest, ...rest } = checkpoint;
  invariant(
    digest(rest) === checkpoint_digest,
    'contract_violation', 'checkpoint_digest does not match the checkpoint content',
    { ...where, expected: digest(rest), actual: checkpoint_digest },
  );
  return checkpoint;
}

/**
 * restoreCheckpoint(checkpoint, { context }) -> Execution Context Bundle
 *
 * Resumption. The context of the RESUMING run is supplied and checked against
 * the checkpoint: a checkpoint written for one tenant cannot be restored into
 * another run's context, which is the failure mode that makes resumable
 * unattended work dangerous in a multi-tenant system.
 */
export function restoreCheckpoint(checkpoint, { context } = {}) {
  assertCheckpoint(checkpoint, { at: 'restoreCheckpoint' });
  assertExecutionContext(context, { at: 'restoreCheckpoint' });
  invariant(
    context.org_id === checkpoint.org_id,
    'contract_violation',
    `checkpoint belongs to tenant '${checkpoint.org_id}' but the resuming run is bound to '${context.org_id}'`,
    { checkpoint_org: checkpoint.org_id, run_org: context.org_id },
  );
  invariant(
    context.workflow_id === checkpoint.workflow_id,
    'contract_violation',
    `checkpoint is for workflow '${checkpoint.workflow_id}', not '${context.workflow_id}'`,
    { checkpoint_workflow: checkpoint.workflow_id, run_workflow: context.workflow_id },
  );

  return assembleContext({
    context,
    items: checkpoint.items,
    budget: { max_tokens: checkpoint.budget.max_tokens, max_items: checkpoint.budget.max_items },
    compaction: {
      restored_from: checkpoint.checkpoint_id,
      source_bundle_digest: checkpoint.source_bundle_digest,
      stats: checkpoint.stats,
      ledger: checkpoint.ledger,
    },
  });
}
