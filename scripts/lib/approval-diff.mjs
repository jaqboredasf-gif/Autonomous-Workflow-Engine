// ---------------------------------------------------------------------------
// approval-diff.mjs  (Task ADR — Approval Diff & Reasoning, offline engine)
//
// PURE, OFFLINE, DETERMINISTIC diff between an AI-drafted message and the message
// a human actually sent. Same input twice => same output, byte for byte.
//
// HARD BOUNDARIES (enforced by having zero of the machinery):
//   * No network. No fetch/import of anything but node stdlib (nothing imported).
//   * No Microsoft Graph, no mailbox access, no Sent-Items subscription.
//   * No draft<->sent mailbox matching (caller supplies the already-paired inputs).
//   * No send / draft capability of any kind. This module only COMPARES text.
//
// Contract:  diff(draft, sent) -> {
//   unchanged,      // bool: every compared field byte-identical
//   edit_ratio,     // number 0..1: overall edit magnitude (deterministic)
//   field_deltas,   // object keyed by changed field only
//   edit_classes,   // array of the fixed vocabulary (see EDIT_CLASSES)
//   material         // bool: is this a material edit (drives graduation evidence)
// }
// Extra keys returned for evidence/triage (not part of the required 5, additive):
//   ambiguous (bool), errors (array of strings; non-empty on malformed input).
//
// Compared fields: subject, body, to, cc, bcc, attachments.
// Classification rules and material-edit rules: docs/testing/APPROVAL_DIFF.md.
// ---------------------------------------------------------------------------

export const EDIT_CLASSES = [
  'formatting_only', 'tone', 'factual_correction', 'missing_information',
  'recipient_correction', 'scheduling', 'pricing', 'attachment',
  'compliance', 'major_rewrite',
];

// Tunables — single source of truth, documented in APPROVAL_DIFF.md.
const MAJOR_RATIO    = 0.60; // edit_ratio at/above which it is a major_rewrite
const TONE_MAX_RATIO = 0.50; // above this a wording-only change is not "just tone"
const INFO_ADD_RATIO = 1.75; // added/removed token ratio that reads as new info

// formatting_only and tone are cosmetic — they never make an edit material.
// Everything else (including major_rewrite) does. material gates graduation
// evidence, so it is deliberately class-driven, not a fuzzy ratio threshold.
const NON_MATERIAL = new Set(['formatting_only', 'tone']);

const TEXT_FIELDS = ['subject', 'body'];
const LIST_FIELDS = ['to', 'cc', 'bcc', 'attachments'];

// --- Field access / normalization (tolerant of the DB column aliases) ---------

function pickBody(m) {
  return m.body != null ? m.body : (m.body_text != null ? m.body_text : null);
}
function pickList(m, field) {
  const alias = field === 'attachments' ? 'attachments' : field + '_addrs';
  const v = m[field] != null ? m[field] : m[alias];
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
function fieldValue(m, field) {
  if (field === 'body') return pickBody(m);
  if (field === 'subject') return m.subject != null ? m.subject : null;
  return pickList(m, field);
}

// Attachment element -> stable comparison key (name/filename, else stringified).
function attachKey(a) {
  if (a == null) return '';
  if (typeof a === 'string') return a.trim().toLowerCase();
  if (typeof a === 'object') {
    const n = a.name ?? a.filename ?? a.fileName ?? null;
    if (n != null) return String(n).trim().toLowerCase();
    return JSON.stringify(sortedKeys(a));
  }
  return String(a).trim().toLowerCase();
}
function sortedKeys(o) {
  return Object.keys(o).sort().reduce((acc, k) => { acc[k] = o[k]; return acc; }, {});
}
function listKeys(field, arr) {
  const keys = arr.map(field === 'attachments'
    ? attachKey
    : (x) => String(x).trim().toLowerCase());
  return keys.filter((x) => x !== '');
}

// --- Text canonicalization ----------------------------------------------------

const str = (s) => (s == null ? '' : String(s));

// Exact-change detection: only normalize line endings so a pure CRLF/LF swap is
// not counted as content. Everything else (including whitespace) is a change.
function exact(s) { return str(s).replace(/\r\n/g, '\n'); }

// Formatting-normalized: if two texts are equal here but not under exact(), the
// difference is whitespace/case/punctuation/markup only => formatting_only.
function formatNorm(s) {
  return str(s)
    .replace(/<[^>]+>/g, ' ')          // strip simple HTML tags
    .replace(/&nbsp;/gi, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')  // drop punctuation to spaces
    .trim()
    .replace(/\s+/g, ' ');
}

function words(s) {
  const n = formatNorm(s);
  return n === '' ? [] : n.split(' ');
}

// Content tokens keep digits/currency so scheduling/pricing survive normalization.
function contentTokens(s) {
  const t = str(s).toLowerCase().match(/[a-z0-9$%./:@-]+/g);
  return t || [];
}

// --- Distances ----------------------------------------------------------------

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

function setDiff(aKeys, bKeys) {
  const a = new Set(aKeys), b = new Set(bKeys);
  const added = [...b].filter((x) => !a.has(x));
  const removed = [...a].filter((x) => !b.has(x));
  const union = new Set([...a, ...b]);
  return { added, removed, unionSize: union.size };
}

function round4(x) { return Math.round(x * 10000) / 10000; }

// --- Validation ---------------------------------------------------------------

function validateSide(m, label, errors) {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) {
    errors.push(`${label} is not an object`);
    return false;
  }
  const hasAny = ['subject', 'body', 'body_text', 'to', 'to_addrs',
    'cc', 'cc_addrs', 'bcc', 'bcc_addrs', 'attachments']
    .some((k) => m[k] != null);
  if (!hasAny) errors.push(`${label} has no comparable fields`);
  for (const f of LIST_FIELDS) {
    const alias = f === 'attachments' ? 'attachments' : f + '_addrs';
    for (const key of [f, alias]) {
      if (m[key] != null && !Array.isArray(m[key]) && typeof m[key] !== 'string') {
        errors.push(`${label}.${key} must be an array`);
      }
    }
  }
  return errors.length === 0;
}

// --- Public API ---------------------------------------------------------------

export function diff(draft, sent) {
  const errors = [];
  const okD = validateSide(draft, 'draft', errors);
  const okS = validateSide(sent, 'sent', errors);

  if (!okD || !okS) {
    // Malformed input is never silently "unchanged": it must be reviewed.
    return {
      unchanged: false,
      edit_ratio: 1,
      field_deltas: {},
      edit_classes: [],
      material: true,
      ambiguous: false,
      errors,
    };
  }

  const field_deltas = {};
  let sumDist = 0, sumUnits = 0;

  // Text fields ---------------------------------------------------------------
  const textChanged = {};
  const formatOnly = {};
  for (const f of TEXT_FIELDS) {
    const dv = fieldValue(draft, f);
    const sv = fieldValue(sent, f);
    const changed = exact(dv) !== exact(sv);
    textChanged[f] = changed;
    const dw = words(dv), sw = words(sv);
    const dist = levenshtein(dw, sw);
    const units = Math.max(dw.length, sw.length);
    sumDist += dist;
    sumUnits += units;
    if (changed) {
      formatOnly[f] = formatNorm(dv) === formatNorm(sv);
      field_deltas[f] = {
        changed: true,
        before: dv,
        after: sv,
        ratio: units === 0 ? (dist === 0 ? 0 : 1) : round4(dist / units),
        formatting_only: formatOnly[f],
      };
    }
  }

  // List fields ---------------------------------------------------------------
  const listChanged = {};
  for (const f of LIST_FIELDS) {
    const da = listKeys(f, fieldValue(draft, f));
    const sa = listKeys(f, fieldValue(sent, f));
    const { added, removed, unionSize } = setDiff(da, sa);
    const changed = added.length > 0 || removed.length > 0;
    listChanged[f] = changed;
    sumDist += added.length + removed.length;
    sumUnits += unionSize;
    if (changed) {
      field_deltas[f] = { changed: true, added, removed };
    }
  }

  const edit_ratio = round4(sumUnits === 0 ? 0 : sumDist / sumUnits);
  const unchanged = Object.keys(field_deltas).length === 0;

  if (unchanged) {
    return { unchanged: true, edit_ratio: 0, field_deltas: {},
      edit_classes: [], material: false, ambiguous: false, errors: [] };
  }

  // --- Classification --------------------------------------------------------
  const classes = new Set();

  const anyTextChanged = TEXT_FIELDS.some((f) => textChanged[f]);
  const anyListChanged = LIST_FIELDS.some((f) => listChanged[f]);
  const allTextFormatOnly = anyTextChanged &&
    TEXT_FIELDS.every((f) => !textChanged[f] || formatOnly[f]);

  // Pure formatting: only whitespace/case/punctuation/markup moved.
  if (allTextFormatOnly && !anyListChanged) {
    return { unchanged: false, edit_ratio, field_deltas,
      edit_classes: ['formatting_only'], material: false, ambiguous: false, errors: [] };
  }

  if (listChanged.to || listChanged.cc || listChanged.bcc) classes.add('recipient_correction');
  if (listChanged.attachments) classes.add('attachment');

  // Content-token symmetric difference across subject+body drives the topic
  // classes. Only tokens that actually appeared/disappeared are considered.
  const draftTok = [...contentTokens(fieldValue(draft, 'subject')), ...contentTokens(pickBody(draft))];
  const sentTok = [...contentTokens(fieldValue(sent, 'subject')), ...contentTokens(pickBody(sent))];
  const dSet = new Set(draftTok), sSet = new Set(sentTok);
  const addedTok = sentTok.filter((t) => !dSet.has(t));
  const removedTok = draftTok.filter((t) => !sSet.has(t));
  const symTok = [...new Set([...addedTok, ...removedTok])];
  const symText = symTok.join(' ');
  const hasNumberDelta = symTok.some((t) => /\d/.test(t));

  const RE_SCHEDULE = /(\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(am|pm)\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b\d{1,2}(st|nd|rd|th)\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(today|tomorrow|reschedul\w*|schedul\w*|appointment|noon|morning|afternoon|evening)\b)/;
  const RE_PRICE = /(\$\s?\d|\b\d+(\.\d{1,2})?\s?(dollars|usd)\b|\d%|\b(price|pricing|quote|quoted|cost|estimate|invoice|deposit|rate|fee|discount|surcharge|total)\b)/;
  const RE_COMPLY = /\b(licens\w*|insur\w*|permit\w*|osha|liab\w*|warrant\w*|disclaimer|terms|complian\w*|certif\w*|bonded|regulat\w*|code|contract)\b/;

  const scheduling = RE_SCHEDULE.test(symText);
  const pricing = RE_PRICE.test(symText) && (hasNumberDelta || /\$|%/.test(symText) || /\b(price|pricing|quote|cost|fee|discount|deposit|rate)\b/.test(symText));
  const compliance = RE_COMPLY.test(symText);

  if (scheduling) classes.add('scheduling');
  if (pricing) classes.add('pricing');
  if (compliance) classes.add('compliance');

  // Net new information: sent added materially more than it removed.
  const addRemoveRatio = removedTok.length === 0
    ? (addedTok.length > 0 ? Infinity : 0)
    : addedTok.length / removedTok.length;
  const infoAdded = anyTextChanged && addedTok.length >= 6 && addRemoveRatio >= INFO_ADD_RATIO;
  if (infoAdded) classes.add('missing_information');

  // Factual correction: a value substitution (numbers or a Capitalized entity /
  // address) that the topic classes above did not already claim.
  const rawSym = symbolicChangedTokens(draft, sent);
  const factual = anyTextChanged && !scheduling && !pricing &&
    (hasNumberDelta || rawSym.entity);
  if (factual) classes.add('factual_correction');

  // Major rewrite dominates when the edit is large.
  if (edit_ratio >= MAJOR_RATIO) classes.add('major_rewrite');

  // Tone: wording moved but no content class fired and the edit is small and
  // roughly balanced (not a big net add). Last-resort so text edits are labelled.
  const contentClassFired = ['factual_correction', 'missing_information', 'scheduling',
    'pricing', 'compliance', 'major_rewrite'].some((c) => classes.has(c));
  const toneEligible = anyTextChanged && !allTextFormatOnly && !contentClassFired &&
    edit_ratio < TONE_MAX_RATIO && !infoAdded;
  if (toneEligible) classes.add('tone');

  // If text changed but nothing classified it yet (and it is not tone-eligible),
  // fall back to major_rewrite when large else factual_correction — never leave a
  // real text change unlabelled.
  if (anyTextChanged && classes.size === 0) {
    classes.add(edit_ratio >= MAJOR_RATIO ? 'major_rewrite' : 'factual_correction');
  }

  const edit_classes = EDIT_CLASSES.filter((c) => classes.has(c));

  const material = edit_classes.some((c) => !NON_MATERIAL.has(c));
  const nonFormatting = edit_classes.filter((c) => c !== 'formatting_only');
  const ambiguous = nonFormatting.length > 1;

  return { unchanged: false, edit_ratio, field_deltas, edit_classes, material, ambiguous, errors: [] };
}

// Lowercase any word that starts a sentence (string start, or after . ! ? : or a
// newline, optionally through a closing quote/bracket) so sentence-initial capitals
// ("We", "Please", "After") are NOT mistaken for proper-noun entities.
function stripSentenceInitial(text) {
  return str(text).replace(/(^\s*|[.!?:\n]["')\]]?\s*)([A-Z])/g, (_m, p, c) => p + c.toLowerCase());
}

// A Capitalized multi-letter token (proper noun / entity) or a street-address
// pattern that appeared or disappeared between draft and sent.
function symbolicChangedTokens(draft, sent) {
  const grab = (m) => stripSentenceInitial(`${str(fieldValue(m, 'subject'))}\n${str(pickBody(m))}`);
  const d = grab(draft), s = grab(sent);
  const caps = (t) => (t.match(/\b[A-Z][a-zA-Z]{1,}\b/g) || []);
  const dCaps = new Set(caps(d)), sCaps = new Set(caps(s));
  const entity = [...sCaps].some((t) => !dCaps.has(t)) || [...dCaps].some((t) => !sCaps.has(t));
  const addr = /\b\d{1,5}\s+[A-Za-z].{0,20}\b(st|street|ave|avenue|rd|road|blvd|lane|ln|dr|drive|way|ct|court)\b/i;
  const addrChanged = addr.test(d) !== addr.test(s) ||
    (d.match(addr)?.[0] || '') !== (s.match(addr)?.[0] || '');
  return { entity: entity || addrChanged };
}

export default { diff, EDIT_CLASSES };
