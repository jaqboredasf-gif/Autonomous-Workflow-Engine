// ---------------------------------------------------------------------------
// field-sheet.mjs — the format a person can fill in on a phone, in a car park.
//
// THE FAILURE THIS EXISTS AGAINST is the one scripts/baseline-import.mjs
// already names: the founder collects evidence standing in somebody's office,
// and the thing the repository needs is a JSON document with enum values and
// ISO dates. Asking one person to produce the second while doing the first
// guarantees either bad evidence or no evidence.
//
// So the capture artifact is a text file with `key: value` lines, and this is
// the deterministic conversion into the records the modules validate.
//
// IT REFUSES RATHER THAN GUESSES, exactly as the baseline importer does. An
// unknown key, a missing attribution, a value that is not one of the enum's
// words: each is reported with its line number and NOTHING is written. A
// half-imported record is worse than none, because it looks finished.
//
// THE ONE PLACE IT IS GENEROUS: keys are matched loosely — `pattern-tags`,
// `pattern_tags` and `patternTags` are the same key, and case does not matter.
// A person writing on a phone should not lose an interview to a hyphen.
// ---------------------------------------------------------------------------

/** `pattern-tags`, `pattern_tags`, `Pattern Tags` -> `patternTags`. */
export function normaliseKey(k) {
  return String(k).trim().toLowerCase()
    .replace(/[\s_-]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/[\s_-]+$/, '');
}

/**
 * Parse a field sheet into blocks.
 *
 * The first block is the record. A line of the form `--- name` starts a new
 * block, which is how repeatable things (an alternative per block) are written
 * without any nesting syntax to get wrong.
 *
 * @returns {{name: string|null, fields: Map<string,{value:string,line:number}>}[]}
 */
export function parseSheet(text) {
  const blocks = [{ name: null, fields: new Map() }];
  const errors = [];
  const lines = String(text).split(/\r?\n/);

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) continue;
    const sep = /^-{2,}\s*(.*)$/.exec(line);
    if (sep) {
      const name = normaliseKey(sep[1] || '');
      if (!name) continue;                       // a horizontal rule, not a block
      blocks.push({ name, fields: new Map() });
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/.exec(line);
    if (!m) {
      errors.push(`line ${n + 1}: "${line.slice(0, 60)}" is neither a "key: value" line nor a "--- block" line`);
      continue;
    }
    const key = normaliseKey(m[1]);
    // A TRAILING COMMENT IS NOT A VALUE. The templates carry the enum's words
    // in a comment after each key, and a blank sheet whose every field held its
    // own instructions would import a record made entirely of help text.
    // Two spaces before the `#` is the separator, so a value that contains a
    // hash — a job number, an address — survives.
    const value = m[2].replace(/^#.*$/, '').replace(/\s{2,}#.*$/, '').trim();
    const block = blocks[blocks.length - 1];
    if (block.fields.has(key)) {
      errors.push(`line ${n + 1}: "${m[1].trim()}" appears twice in the same block`);
      continue;
    }
    block.fields.set(key, { value, line: n + 1 });
  }
  return { blocks, errors };
}

/** A reader over one block that reports what it refused. */
export function reader(block, errors, { where = 'the sheet' } = {}) {
  const used = new Set();
  const get = (key) => { used.add(key); return block.fields.get(key); };

  const api = {
    str(key, { required = false } = {}) {
      const f = get(key);
      if (!f || f.value === '') {
        if (required) errors.push(`${where}: "${key}" is required and is empty`);
        return null;
      }
      return f.value;
    },
    bool(key, fallback = false) {
      const f = get(key);
      if (!f || f.value === '') return fallback;
      if (/^(y|yes|true|1)$/i.test(f.value)) return true;
      if (/^(n|no|false|0)$/i.test(f.value)) return false;
      errors.push(`line ${f.line}: "${key}" should be yes or no, not "${f.value}"`);
      return fallback;
    },
    list(key) {
      const f = get(key);
      if (!f || f.value === '') return [];
      return f.value.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    },
    enumOf(key, allowed, fallback = null) {
      const f = get(key);
      if (!f || f.value === '') return fallback;
      const v = f.value.trim().toUpperCase().replace(/[\s-]+/g, '_');
      if (allowed.includes(v)) return v;
      const lower = f.value.trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (allowed.includes(lower)) return lower;
      errors.push(`line ${f.line}: "${key}" is "${f.value}". One of: ${allowed.join(', ')}`);
      return fallback;
    },
    /**
     * An interpreted field, with its attribution.
     *
     * `pain` + `pain-said` + `pain-quote`. THE ATTRIBUTION IS NEVER DEFAULTED.
     * A missing `-said` is refused with the three words that could go there,
     * because the alternative — assuming STATED — silently converts a founder's
     * note into a customer's testimony, which is the exact failure the record
     * format was built to prevent.
     */
    testimony(key, { required = false } = {}) {
      const f = get(key);
      const saidKey = `${key}Said`;
      // Claimed even when the base field is empty, so a blank template — which
      // carries every `-said` line — does not report ten spelling mistakes.
      const said = get(saidKey);
      get(`${key}Quote`);
      if (!f || f.value === '') {
        if (required) errors.push(`${where}: "${key}" is required and is empty`);
        return null;
      }
      if (!said || !said.value) {
        errors.push(
          `line ${f.line}: "${key}" has no "${key}-said". Add one of: STATED (they said it), ` +
          'FOUNDER_OBSERVED (you saw it), FOUNDER_INFERRED (you concluded it).');
        return null;
      }
      const quote = block.fields.get(`${key}Quote`);
      return { value: f.value, said: said.value.trim().toUpperCase().replace(/[\s-]+/g, '_'), quote: quote?.value || null };
    },
    unusedKeys() {
      return [...block.fields.keys()].filter((k) => !used.has(k));
    },
  };
  return api;
}
