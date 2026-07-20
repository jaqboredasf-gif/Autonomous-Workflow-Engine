// ---------------------------------------------------------------------------
// validate-migration-0014.mjs — OFFLINE structural validation of
// supabase/migrations/0014_approval_evidence.sql.
//
// This environment has no psql / supabase CLI / docker, so 0014 cannot be
// applied to a real Postgres here. Live apply is a documented, human-gated step
// (see docs/testing/APPROVAL_DIFF.md). In the meantime this deterministic lint
// asserts the migration is additive, self-consistent, and follows the project
// conventions the ADR requires. Exit 0 iff all checks pass.
//
// Usage: node scripts/lib/validate-migration-0014.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const PATH = 'supabase/migrations/0014_approval_evidence.sql';
const sql = readFileSync(PATH, 'utf8');
const lower = sql.toLowerCase();

let fail = 0;
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`); if (!cond) fail++; };

// Additive-only: no destructive statements against existing schema.
const destructive = lower.match(/\b(drop\s+(table|type|function|trigger|policy|index|column|schema)|truncate\b|alter\s+table\s+\w+\s+drop|delete\s+from)\b/g) || [];
check(destructive.length === 0, `additive-only: no destructive statements (found ${JSON.stringify(destructive)})`);

// The three required evidence tables.
for (const t of ['approval_drafts', 'approval_outcomes', 'category_authority']) {
  check(new RegExp(`create table ${t}\\b`).test(lower), `table ${t} created`);
  check(new RegExp(`create table ${t}[\\s\\S]*?is_fixture\\s+boolean`).test(lower), `${t} has is_fixture boolean`);
  check(new RegExp(`create table ${t}[\\s\\S]*?created_at\\s+timestamptz`).test(lower), `${t} has created_at timestamptz`);
  check(new RegExp(`create table ${t}[\\s\\S]*?org_id\\s+uuid not null references orgs`).test(lower), `${t} org-scoped to orgs`);
  check(new RegExp(`alter table ${t} enable row level security`).test(lower), `${t} RLS enabled`);
  check(new RegExp(`create (unique )?index \\w*${t.split('_')[1]}\\w*`).test(lower) || new RegExp(`on ${t}\\(`).test(lower), `${t} has at least one index`);
}

// FK targets must be tables that already exist (0001-0013) or the new tables.
const known = new Set(['orgs', 'users', 'work_requests', 'approval_drafts', 'approval_outcomes', 'category_authority']);
const fkTargets = [...lower.matchAll(/references\s+(\w+)/g)].map((m) => m[1]);
const unknownFk = [...new Set(fkTargets)].filter((t) => !known.has(t));
check(unknownFk.length === 0, `FK targets all known (unknown: ${JSON.stringify(unknownFk)})`);

// Required enums.
for (const e of ['approval_edit_class', 'approval_outcome_kind', 'approval_authority_level']) {
  check(new RegExp(`create type ${e} as enum`).test(lower), `enum ${e} defined`);
}
// All 10 edit classes present in the enum.
for (const c of ['formatting_only', 'tone', 'factual_correction', 'missing_information',
  'recipient_correction', 'scheduling', 'pricing', 'attachment', 'compliance', 'major_rewrite']) {
  check(new RegExp(`'${c}'`).test(lower), `edit class '${c}' in enum`);
}

// Auditability / no hard deletes / immutability.
check(/function guard_no_delete/.test(lower), 'guard_no_delete function present');
check(/before delete on approval_drafts/.test(lower), 'approval_drafts blocks delete');
check(/before delete on approval_outcomes/.test(lower), 'approval_outcomes blocks delete');
check(/immutability/.test(lower) && /before update on approval_drafts/.test(lower), 'approval_drafts immutability guard');
check(/before update on approval_outcomes/.test(lower), 'approval_outcomes immutability guard');

// Event contract on the same emit_event spine.
check(/emit_event\('approval\.diff_recorded'/.test(sql), "emits approval.diff_recorded");
check(/emit_event\('approval\.material_edit'/.test(sql), "emits approval.material_edit");

// No autonomous graduation: nothing writes authority_level in a trigger/update.
check(!/update\s+category_authority\s+set/i.test(sql) && !/authority_level\s*:=/.test(sql),
  'no autonomous write to authority_level (graduation out of scope)');

// No send / Graph / network machinery leaked into the migration CODE. Comments
// deliberately document the exclusions, so lint the non-comment lines only.
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
check(!/\b(graph|https?:\/\/|fetch\s*\(|subscription|smtp)\b/i.test(code), 'no Graph/network/send machinery in code');

// Balanced dollar-quoted function bodies and parentheses.
check(((sql.match(/\$\$/g) || []).length % 2) === 0, 'balanced $$ function delimiters');
const opens = (sql.match(/\(/g) || []).length, closes = (sql.match(/\)/g) || []).length;
check(opens === closes, `balanced parentheses (${opens} open / ${closes} close)`);

console.log(`\nvalidate-migration-0014: ${fail === 0 ? 'PASS' : `FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
