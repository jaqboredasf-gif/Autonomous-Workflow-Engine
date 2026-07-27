// ---------------------------------------------------------------------------
// context-item.mjs — the Context Item.
//
// "Context" in this repo has so far meant a string someone assembled by hand at
// a call site: a prompt prefix, a bag of fields, a JSON blob. That is fine right
// up until something has to answer a question about it — where did this fact
// come from, which tenant does it belong to, may it be summarized, may it be
// dropped, how much of the budget does it cost, and is it a policy the platform
// wrote or a sentence a customer typed. A string cannot answer any of those.
//
// A Context Item is one unit of context with those answers attached:
//
//   { id, kind, source, org_id, sensitivity, trusted, priority, occurred_at,
//     content, artifact_ref, tokens, provenance, metadata, fingerprint }
//
// Two properties the rest of the subsystem is built on:
//
//   tenant binding — `org_id` is on the ITEM, not just on the run. An item that
//     names a different tenant than the run cannot be assembled into that run's
//     bundle by accident; the assembler has the fact it needs to refuse.
//   declared trust — `trusted` and `sensitivity` travel with the content. A
//     compactor may therefore never promote a customer email body into a
//     "policy" summary, because the label is data rather than a convention.
//
// What this module deliberately does NOT do (ADR-0002 is unresolved): it grants
// nothing and decides no policy. An item says WHAT and WHOSE and HOW SENSITIVE.
// It never says who may read it. Access control stays in RLS and the approval
// matrix until the Tool Registry is unblocked.
//
// PURE: no clock, no randomness, no I/O. `occurred_at` is supplied by the
// caller, which is what keeps an assembled bundle replayable.
// ---------------------------------------------------------------------------

import { canonicalClone, deepFreeze, digest } from './canonical.mjs';
import { invariant } from './errors.mjs';
import { isInstant, redact } from './events.mjs';

// What KIND of fact this is. Owned here because the item is the thing that has
// a kind; `defineContextProvider` re-exports this list so a provider and the
// items it produces cannot drift apart.
export const CONTEXT_ITEM_KINDS = [
  'domain_facts',        // rows and records the platform owns
  'workflow_state',      // where a run got to
  'tool_result',         // what a tool returned
  'policy',              // an operating rule the org set
  'human_decision',      // an approval, a rejection, an instruction
  'untrusted_content',   // anything a third party authored (G10)
  'derived_summary',     // produced by compaction, never by a source
];

// How restricted the content is. Ordered least → most restricted; compaction
// uses the ORDER (a summary inherits the maximum of its inputs), so this array
// is a ranking and not just a vocabulary.
export const CONTEXT_SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted'];

export const CONTEXT_ITEM_KEYS = [
  'id', 'kind', 'source', 'org_id', 'sensitivity', 'trusted', 'priority',
  'occurred_at', 'content', 'artifact_ref', 'tokens', 'provenance', 'metadata',
  'fingerprint',
];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_PATTERN = /^[a-z][a-z0-9_]*$/;

export const MAX_PRIORITY = 1000;

export function sensitivityRank(sensitivity) {
  const rank = CONTEXT_SENSITIVITIES.indexOf(sensitivity);
  invariant(rank >= 0, 'invalid_input', `unknown sensitivity '${sensitivity}'`, { sensitivity });
  return rank;
}

// The more restricted of two classifications. The only direction compaction is
// allowed to move: a summary of a confidential item is confidential.
export function maxSensitivity(values) {
  return values.reduce(
    (worst, s) => (sensitivityRank(s) > sensitivityRank(worst) ? s : worst),
    CONTEXT_SENSITIVITIES[0],
  );
}

// Deterministic token estimate.
//
// Every budget in this subsystem is expressed in tokens, and a budget that
// depends on a provider's tokenizer is a budget that changes when the vendor
// does — which would make an assembled bundle unreplayable and would bind the
// kernel to one model API. This is a pure character-based estimate instead, and
// it deliberately OVER-estimates: roughly one token per three characters
// against an English average nearer four. Running out of budget early is
// recoverable; discovering the overflow at the provider is not.
//
// Monotonic (never decreases as text grows) so that budget arithmetic behaves.
export function estimateTokens(text) {
  if (text === null || text === undefined) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(s.length / 3) + 1;
}

export function estimateItems(items) {
  return (items ?? []).reduce((total, item) => total + (item?.tokens ?? 0), 0);
}

// Content identity, for de-duplication. Two items are the same FACT when they
// carry the same content from the same source in the same kind — the id is not
// enough, because two providers legitimately mint different ids for one row.
export function contentFingerprint({ kind, source, content = null, artifact_ref = null }) {
  return digest({ kind, source, content, artifact_ref });
}

/**
 * createContextItem(spec) -> frozen Context Item
 *
 * `content` and `artifact_ref` are both optional individually but at least one
 * is required: an item that references nothing is not a fact. An item may carry
 * both, which is what lets compaction drop the body and keep the pointer.
 */
export function createContextItem({
  id,
  kind,
  source,
  org_id = null,
  sensitivity = 'internal',
  trusted = false,
  priority = 100,
  occurred_at = null,
  content = null,
  artifact_ref = null,
  tokens = null,
  provenance = {},
  metadata = {},
} = {}) {
  invariant(
    typeof id === 'string' && ID_PATTERN.test(id),
    'invalid_input', `context item id '${id}' must be a short opaque identifier`, { id },
  );
  invariant(
    CONTEXT_ITEM_KINDS.includes(kind),
    'invalid_input', `context item '${id}' has unknown kind '${kind}'`, { id, kind, known: CONTEXT_ITEM_KINDS },
  );
  invariant(
    typeof source === 'string' && SOURCE_PATTERN.test(source),
    'invalid_input', `context item '${id}' source '${source}' must be snake_case`, { id, source },
  );
  // null = tenant-neutral (a platform policy, a unit conversion). Anything else
  // must name its tenant, because the assembler refuses what it cannot check.
  invariant(
    org_id === null || (typeof org_id === 'string' && org_id.length > 0),
    'invalid_input', `context item '${id}' org_id must be a non-empty string or null`, { id, org_id },
  );
  invariant(
    CONTEXT_SENSITIVITIES.includes(sensitivity),
    'invalid_input', `context item '${id}' has unknown sensitivity '${sensitivity}'`,
    { id, sensitivity, known: CONTEXT_SENSITIVITIES },
  );
  // Not defaulted by inference. A source that does not say is untrusted (the
  // default above), which is the fail-closed reading of G10.
  invariant(
    typeof trusted === 'boolean',
    'invalid_input', `context item '${id}' must declare trusted: true|false`, { id },
  );
  invariant(
    Number.isInteger(priority) && priority >= 0 && priority <= MAX_PRIORITY,
    'invalid_input', `context item '${id}' priority must be an integer in [0,${MAX_PRIORITY}]`, { id, priority },
  );
  invariant(
    occurred_at === null || isInstant(occurred_at),
    'invalid_input', `context item '${id}' occurred_at must be an ISO-8601 instant or null`, { id, occurred_at },
  );
  invariant(
    content === null || typeof content === 'string',
    'invalid_input', `context item '${id}' content must be a string or null`, { id },
  );
  invariant(
    artifact_ref === null || (typeof artifact_ref === 'string' && artifact_ref.length > 0),
    'invalid_input', `context item '${id}' artifact_ref must be a non-empty string or null`, { id },
  );
  invariant(
    content !== null || artifact_ref !== null,
    'invalid_input', `context item '${id}' must carry content or an artifact_ref`, { id },
  );
  invariant(
    tokens === null || (Number.isInteger(tokens) && tokens >= 0),
    'invalid_input', `context item '${id}' tokens must be a non-negative integer or null`, { id, tokens },
  );
  invariant(
    provenance !== null && typeof provenance === 'object' && !Array.isArray(provenance),
    'invalid_input', `context item '${id}' provenance must be a plain object`, { id },
  );
  invariant(
    metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata),
    'invalid_input', `context item '${id}' metadata must be a plain object`, { id },
  );

  // Redacted on the way IN, not on the way out to a log. A credential that
  // reached a context item would otherwise be handed to a model, put in a
  // checkpoint, and written to an artifact before anything looked at it (G17).
  const safeContent = content === null ? null : redact(content);
  const safeProvenance = canonicalClone(redact({ ...provenance }));
  const safeMetadata = canonicalClone(redact({ ...metadata }));

  const estimated = tokens ?? (estimateTokens(safeContent) + estimateTokens(artifact_ref));

  return deepFreeze({
    id,
    kind,
    source,
    org_id,
    sensitivity,
    trusted,
    priority,
    occurred_at,
    content: safeContent,
    artifact_ref,
    tokens: estimated,
    provenance: safeProvenance,
    metadata: safeMetadata,
    fingerprint: contentFingerprint({ kind, source, content: safeContent, artifact_ref }),
  });
}

export function assertContextItem(item, where = {}) {
  invariant(
    item !== null && typeof item === 'object' && !Array.isArray(item),
    'contract_violation', 'context item must be an object', { ...where },
  );
  for (const key of CONTEXT_ITEM_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(item, key),
      'contract_violation', `context item is missing '${key}'`, { ...where, key, id: item.id },
    );
  }
  // Rebuilding is the check: anything createContextItem would refuse is refused
  // here too, and a hand-edited fingerprint cannot survive it.
  const rebuilt = createContextItem(item);
  invariant(
    rebuilt.fingerprint === item.fingerprint,
    'contract_violation', `context item '${item.id}' fingerprint does not match its content`,
    { ...where, id: item.id, expected: rebuilt.fingerprint, actual: item.fingerprint },
  );
  return item;
}

// Total ordering for assembly. Deterministic and total: no two distinct items
// can compare equal, because `id` is unique within a bundle and breaks every
// remaining tie.
//
//   1. priority, descending      — what the caller said matters most
//   2. occurred_at, ascending    — chronology within a priority band; an item
//                                  with no time sorts after one that has a time,
//                                  because "unknown when" is not "oldest"
//   3. kind, then source, then id, ascending — stable, arbitrary, reproducible
export function compareContextItems(a, b) {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.occurred_at !== b.occurred_at) {
    if (a.occurred_at === null) return 1;
    if (b.occurred_at === null) return -1;
    return a.occurred_at < b.occurred_at ? -1 : 1;
  }
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
