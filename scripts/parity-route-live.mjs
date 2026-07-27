#!/usr/bin/env node
// Live SQL/JS routing parity — retires B3's dual-implementation risk.
//
// route_outbound() (0015, SQL) and route() (scripts/lib/approval-matrix.mjs, JS)
// encode the same approval matrix twice. validate-migration-0015.mjs compares
// their VOCABULARIES (reason strings, role names); it cannot compare BRANCH
// LOGIC. This does: every case is routed by the live database AND by the offline
// engine over the same live policy rows, and every field must agree.
//
// Input on stdin: {"policies": [...message_policies rows...],
//                  "cases": [{message_type, amount_cents, unavailable_roles, db}]}
// where `db` is the jsonb route_outbound() returned live.
// Exit 0 = full parity. Exit 1 = at least one divergence (printed).

import { route } from './lib/approval-matrix.mjs';

const raw = await new Promise((resolve, reject) => {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => resolve(buf));
  process.stdin.on('error', reject);
});

let input;
try {
  input = JSON.parse(raw);
} catch (e) {
  console.error(`parity: stdin is not valid JSON (${e.message})`);
  process.exit(1);
}

const { policies, cases } = input;
if (!Array.isArray(policies) || !Array.isArray(cases)) {
  console.error('parity: expected {policies:[], cases:[]}');
  process.exit(1);
}
if (policies.length === 0 || cases.length === 0) {
  console.error('parity: refusing to pass vacuously (0 policies or 0 cases)');
  process.exit(1);
}

// The DB builds its jsonb with only the keys relevant to the path taken, so a
// key absent from a blocked result is not a disagreement — compare per path.
const norm = (v) => (v === undefined ? null : v);

let compared = 0;
let mismatches = 0;

for (const c of cases) {
  const js = route({
    policies,
    messageType: c.message_type,
    amountCents: c.amount_cents === undefined ? null : c.amount_cents,
    unavailableRoles: c.unavailable_roles || [],
  });
  const db = c.db || {};

  const fields = db.blocked
    ? ['blocked', 'blocked_reason', 'policy_id']
    : ['blocked', 'blocked_reason', 'policy_id', 'approver_role', 'routing_path',
       'escalated', 'escalation_reason', 'policy_mode', 'effective_mode'];

  const bad = [];
  for (const f of fields) {
    const a = norm(db[f]);
    const b = norm(js[f]);
    // jsonb booleans arrive as real booleans; ids as strings. Compare loosely on
    // scalar shape, strictly on value.
    if (String(a) !== String(b)) bad.push(`${f}: db=${JSON.stringify(a)} js=${JSON.stringify(b)}`);
    compared++;
  }

  if (bad.length) {
    mismatches++;
    const label = `${c.message_type} amount=${c.amount_cents ?? 'null'} ` +
                  `unavailable=[${(c.unavailable_roles || []).join(',')}]`;
    console.log(`MISMATCH  ${label}`);
    for (const b of bad) console.log(`          ${b}`);
  }
}

// A parity run that compared nothing proves nothing.
if (compared === 0) {
  console.error('parity: 0 field comparisons performed — harness is vacuous');
  process.exit(1);
}

console.log(`parity: ${cases.length} cases, ${compared} field comparisons, ${mismatches} mismatches`);
process.exit(mismatches === 0 ? 0 : 1);
