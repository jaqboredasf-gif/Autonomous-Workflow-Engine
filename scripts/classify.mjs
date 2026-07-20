#!/usr/bin/env node
// B2 classification entrypoint. Thin: parse flags, wire an adapter, load the
// fixture, call the domain service, print the result as one JSON object. All
// real logic lives in scripts/lib/classification.mjs (domain) and db.mjs
// (persistence + Verify Step). Two modes:
//
//   node scripts/classify.mjs --selftest
//       Offline self-check of the hallucination guard: an invented value MUST
//       be flagged. Prints "selftest-ok" and exits 0, else exits nonzero.
//
//   node scripts/classify.mjs --fixture <path> --adapter fixture|live [--persist]
//       Classify one fixture email. --adapter fixture uses recorded model
//       output (deterministic, Runner 2A). --adapter live requires
//       ANTHROPIC_API_KEY (Runner 2B). --persist writes to the DB and runs the
//       deterministic Verify Step. Prints the result JSON. Exits nonzero on any
//       error or a failed Verify Step (the model can never claim persistence).
//
// TEST safeguards: no external email is ever sent; the live adapter only reads
// the model API; DB writes are org-scoped fixture rows (is_fixture=true) via
// the same triggers as B1.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  normalizeEmail, classify, hallucinationCheck,
} from './lib/classification.mjs';
import { fixtureAdapter, anthropicAdapter } from './lib/model-adapters.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
function has(flag) { return process.argv.includes(flag); }

async function main() {
  // --- Self-test: the hallucination guard must flag an invented value. ---
  if (has('--selftest')) {
    const email = 'Outlet not working in the kitchen. Please call.';
    const invented = { customer_name: 'Zcoltan Marsh', customer_phone: '000-000-9999',
      customer_address: '404 Nowhere Blvd', county: 'Atlantis', zip: '99999' };
    const flagged = hallucinationCheck(invented, email);
    // Every invented field must be caught, and a value that IS present must not be.
    const present = hallucinationCheck({ customer_name: 'kitchen' }, email);
    if (flagged.length === 5 && present.length === 0) { console.log('selftest-ok'); return; }
    console.error(`selftest-fail flagged=${JSON.stringify(flagged)} present=${JSON.stringify(present)}`);
    process.exit(1);
  }

  const fixturePath = arg('--fixture');
  if (!fixturePath) throw new Error('usage: --fixture <path> --adapter fixture|live [--persist]  |  --selftest');
  const adapterKind = arg('--adapter') || 'fixture';
  const persist = has('--persist');

  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const email = normalizeEmail(raw, basename(fixturePath));

  let adapter;
  if (adapterKind === 'fixture') {
    adapter = fixtureAdapter();
  } else if (adapterKind === 'live') {
    // Throws NO_API_KEY (handled below) when the credential is absent.
    adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.AWE_MODEL });
  } else {
    throw new Error(`unknown --adapter ${adapterKind} (expected fixture|live)`);
  }

  const result = await classify(email, { adapter, persist });
  process.stdout.write(JSON.stringify(result) + '\n');

  // The Verify Step, not the model, decides success. A failed write-back verify
  // is a failed run regardless of what the model returned.
  if (persist && !(result.verify && result.verify.ok)) {
    process.exit(2);
  }
}

main().catch((e) => {
  if (e && e.code === 'NO_API_KEY') {
    console.error('ANTHROPIC_API_KEY not set — live classification (Runner 2B) unavailable. '
      + 'Set the key to run the paid live eval; the deterministic eval (Runner 2A) needs no key.');
    process.exit(3);
  }
  console.error(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
