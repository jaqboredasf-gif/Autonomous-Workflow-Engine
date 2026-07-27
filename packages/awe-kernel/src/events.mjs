// ---------------------------------------------------------------------------
// events.mjs — the canonical audit/event envelope.
//
// `integration_events` is the platform's audit substrate, but until now every
// producer hand-built its own row shape and its own idempotency story. This
// module gives one envelope with three properties workflows keep needing:
//
//   * deterministic  — no clock and no randomness inside. `occurred_at` is
//                      supplied by the caller (a fixture can pin it), so the
//                      same run produces byte-identical events every time.
//   * idempotent     — `event_key` is a content digest, so re-emitting the same
//                      event is detectable BEFORE it reaches the database.
//   * safe to log    — payloads pass through redaction, so a credential that
//                      wandered into a context object never lands in an audit
//                      trail, an eval report, or a terminal.
//
// PURE: no clock, no randomness, no I/O, no network.
// ---------------------------------------------------------------------------

import { digest } from './canonical.mjs';
import { invariant } from './errors.mjs';

export const EVENT_ENVELOPE_KEYS = [
  'event_type', 'entity_type', 'entity_id', 'org_id', 'payload', 'occurred_at', 'event_key',
];

export const REDACTED = '[redacted]';

// Dotted or snake_case; matches both existing conventions in the migrations
// ('request.classified' and 'duplicate_flagged').
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

// Exported so every module that records a time (execution context, run report)
// applies the SAME rule: an instant or nothing. A bare date is refused because
// it is not a point in time, and the kernel will not invent the missing part.
export function isInstant(value) {
  return typeof value === 'string' && ISO_INSTANT.test(value);
}

// The date partition of an instant, for predictable artifact paths.
export function instantDate(value) {
  invariant(isInstant(value), 'invalid_input', `not an ISO-8601 instant: '${value}'`, { value });
  return value.slice(0, 10);
}

// Seconds since the epoch, for age arithmetic (context compaction prunes by
// age against a caller-supplied `as_of`).
//
// `Date.parse` is a pure string→number function: it takes no reading from the
// system clock and returns the same value on every machine for a fully
// qualified instant, which `isInstant` has already required. That is why it is
// permitted here while `Date.now()` and `new Date()` are forbidden kernel-wide
// — the ban is on reading the clock, not on parsing a timestamp the caller
// supplied. Comparing the ISO strings directly would be wrong: two instants
// with different UTC offsets sort by their text, not by their moment.
export function instantEpochSeconds(value) {
  invariant(isInstant(value), 'invalid_input', `not an ISO-8601 instant: '${value}'`, { value });
  const ms = Date.parse(value);
  invariant(Number.isFinite(ms), 'invalid_input', `instant '${value}' could not be parsed`, { value });
  return Math.floor(ms / 1000);
}

// Key names whose values are never safe to record.
//
// `pass` is deliberately NOT on its own here: it is a plain English word, and in
// this repo it is the name of every runner's pass counter. Matching it redacted
// real evidence out of run reports — a deny-list that eats the data it is meant
// to protect gets turned off, which is worse than a narrow one. `password`,
// `passphrase` and `passcode` are still caught, and any actual credential is
// caught by value shape regardless of what its key is called.
const SECRET_KEY_PATTERN =
  /(pass(word|phrase|code)|secret|token|credential|authorization|cookie|session_id|api[-_]?key|service[-_]?role|private[-_]?key|access[-_]?key)/i;

// Value shapes that are credentials wherever they appear, whatever the key is.
//
// These are deliberately NOT anchored to the start and end of the value. A token
// almost never arrives alone: it arrives inside an error message, a URL, a
// rejected-request log line, a stack frame. Matching only whole values meant
// `"rejected token eyJhbGci…"` sailed through untouched, which is precisely how
// credentials end up in audit trails. Scrubbing is by substring, so a value that
// IS a credential still collapses to `[redacted]` and a value that merely
// CONTAINS one loses only that part.
const SECRET_VALUE_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,   // JWT (Supabase anon/service keys)
  /sk-[A-Za-z0-9-]{16,}/g,                                         // provider secret keys
  /sbp_[A-Za-z0-9]{20,}/g,                                         // Supabase personal access token
  /sb_secret_[A-Za-z0-9_-]{10,}/g,                                 // Supabase secret key (new format)
  /(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,                  // Authorization header values
  // An ASSIGNED secret inside free text: `password=hunter2`, `api_key: abc123`,
  // `token = xyz`. The key-name deny-list above only catches an object KEY;
  // this catches the same names when they appear inside a string, which is
  // where they actually turn up — connection strings, driver errors, curl
  // commands pasted into a note. The key name is kept so the message still
  // reads; only the value is replaced.
  /((?:pass(?:word|phrase|code)?|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key)\s*[=:]\s*)(?!\s)[^\s'"&,;)]{4,}/gi,
];

// Patterns whose replacement keeps a capture group. Kept separate from the
// whole-match patterns above so the simple ones stay simple.
const SECRET_ASSIGNMENT_PATTERN = SECRET_VALUE_PATTERNS[SECRET_VALUE_PATTERNS.length - 1];

// Replace every credential-shaped substring. Returns the value unchanged when it
// holds nothing that looks like a credential, so digests over clean data stay
// stable.
function scrubSecrets(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    // `lastIndex` is per-regex state on a global pattern; reset so a previous
    // call cannot make this one start half way through the string.
    pattern.lastIndex = 0;
    out = pattern === SECRET_ASSIGNMENT_PATTERN
      // Keep `password=`, replace what follows it: a redacted message that still
      // says WHICH field was scrubbed is far more useful to whoever is debugging.
      ? out.replace(pattern, (_m, prefix) => `${prefix}${REDACTED}`)
      : out.replace(pattern, REDACTED);
  }
  return out;
}

// Recursively replace credential-shaped keys and values. Structure, key order
// and every non-secret value are preserved so digests stay meaningful.
export function redact(value, { keyPattern = SECRET_KEY_PATTERN } = {}) {
  const walk = (v, keyHint) => {
    if (keyHint !== undefined && keyPattern.test(keyHint) && v !== null && v !== undefined) return REDACTED;
    if (typeof v === 'string') return scrubSecrets(v);
    if (Array.isArray(v)) return v.map((item) => walk(item, undefined));
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const [k, child] of Object.entries(v)) out[k] = walk(child, k);
      return out;
    }
    return v;
  };
  return walk(value, undefined);
}

// Build one audit event. `occurred_at` is optional and, when present, must be an
// ISO-8601 instant — the kernel refuses to read the clock on the caller's behalf
// because that is exactly what makes a run unreproducible.
export function createEvent({
  event_type, entity_type, entity_id, org_id = null, payload = {}, occurred_at = null,
}) {
  invariant(
    typeof event_type === 'string' && EVENT_TYPE_PATTERN.test(event_type),
    'invalid_input', `event_type '${event_type}' must be snake_case, optionally dotted`, { event_type },
  );
  invariant(
    typeof entity_type === 'string' && ENTITY_TYPE_PATTERN.test(entity_type),
    'invalid_input', `entity_type '${entity_type}' must be snake_case`, { entity_type },
  );
  invariant(
    entity_id === null || (typeof entity_id === 'string' && entity_id.length > 0),
    'invalid_input', 'entity_id must be a non-empty string or null', { entity_id },
  );
  invariant(
    org_id === null || (typeof org_id === 'string' && org_id.length > 0),
    'invalid_input', 'org_id must be a non-empty string or null', { org_id },
  );
  invariant(
    occurred_at === null || (typeof occurred_at === 'string' && ISO_INSTANT.test(occurred_at)),
    'invalid_input', `occurred_at must be an ISO-8601 instant or null, got '${occurred_at}'`, { occurred_at },
  );

  const safePayload = redact(payload ?? {});
  const event = {
    event_type,
    entity_type,
    entity_id: entity_id ?? null,
    org_id,
    payload: safePayload,
    occurred_at,
    // Deliberately excludes occurred_at: the same logical event replayed at a
    // different time is still the same event for idempotency purposes.
    event_key: digest({ event_type, entity_type, entity_id: entity_id ?? null, org_id, payload: safePayload }),
  };
  return Object.freeze(event);
}

export function assertEvent(event, context = {}) {
  invariant(
    event !== null && typeof event === 'object' && !Array.isArray(event),
    'contract_violation', 'event must be an object', { ...context, event },
  );
  for (const key of EVENT_ENVELOPE_KEYS) {
    invariant(
      Object.prototype.hasOwnProperty.call(event, key),
      'contract_violation', `event is missing '${key}'`, { ...context, event },
    );
  }
  const rebuilt = createEvent(event);
  invariant(
    rebuilt.event_key === event.event_key,
    'contract_violation', `event_key does not match the event's content (${event.event_type})`,
    { ...context, expected: rebuilt.event_key, actual: event.event_key },
  );
  return event;
}

// Order a batch and surface repeats. `seq` is positional, so a batch is
// reproducible; `duplicates` is the pre-write idempotency signal — the caller
// decides whether a repeat is a bug or a benign retry.
export function sequence(events) {
  invariant(Array.isArray(events), 'invalid_input', 'sequence() takes an array of events', {});
  const seen = new Map();
  const duplicates = [];
  const sequenced = events.map((event, i) => {
    assertEvent(event, { index: i });
    if (seen.has(event.event_key)) duplicates.push({ event_key: event.event_key, first: seen.get(event.event_key), repeat: i });
    else seen.set(event.event_key, i);
    return Object.freeze({ ...event, seq: i + 1 });
  });
  return Object.freeze({ events: Object.freeze(sequenced), duplicates: Object.freeze(duplicates) });
}

// Convenience for gates: the set of event types a run produced.
export function eventTypes(events) {
  return [...new Set((events ?? []).map((e) => e.event_type))].sort();
}
