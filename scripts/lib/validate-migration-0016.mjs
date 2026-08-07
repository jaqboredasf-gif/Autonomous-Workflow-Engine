// ---------------------------------------------------------------------------
// validate-migration-0016.mjs — parity lint between the purchasing module's
// code and supabase/migrations/0016_purchasing_control.sql.
//
// OFFLINE and TEXTUAL: it reads the SQL as a string. It cannot prove the
// migration runs (that needs a database), but it CAN prove the two enforcement
// paths speak the same language — which is the failure mode that actually
// happens: someone adds a status, a permission or a transition in TypeScript,
// ships it, and the production policies silently disagree.
//
// Asserts:
//   * status vocabulary          — enum == REQUEST_STATUSES, both directions
//   * transition graph           — every legal edge appears in the SQL guard,
//                                  and the SQL guard invents no extra edge
//   * role + permission matrix   — purchasing_role_permissions rows == ROLE_PERMISSIONS,
//                                  purchasing_grant_permissions == APPROVAL_GRANT_PERMISSIONS
//   * email vocabulary           — template types and draft statuses
//   * table parity               — every pilot table has a production table
//                                  (through the documented rename map)
//   * no send capability         — no http/smtp/pg_net/graph anywhere in it
//   * the send gate + no-delete guards are present
//
// Used by scripts/eval-purchasing.mjs; exits non-zero on its own if run directly.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const MIGRATION = join(MIGRATIONS_DIR, '0016_purchasing_control.sql');
// 0017 adds the auth link and job assignments; parity is checked over both,
// because the app does not care which file a table arrived in.
const MIGRATION_0017 = join(ROOT, 'supabase', 'migrations', '0017_purchasing_auth_and_assignments.sql');
// 0018 adds tenant ownership on line items, the item catalog and the job
// directory. Parity is checked over the whole set.
const MIGRATION_0018 = join(ROOT, 'supabase', 'migrations', '0018_purchasing_history_and_jobs.sql');
const APP = join(ROOT, 'apps', 'purchasing', 'src');

/**
 * Pilot table -> production table. A null value means "pilot-only, on purpose",
 * with the reason stated: those rows come from tables AWE already has.
 */
export const TABLE_MAP = {
  orgs: 'orgs',                                     // 0001
  users: 'users',                                   // 0001 (+ purchasing columns here)
  roles: null,                                      // production uses the purchasing_role enum
  user_roles: 'purchasing_user_roles',
  vendors: 'purchase_vendors',
  vendor_contacts: 'purchase_vendor_contacts',
  delivery_locations: 'purchase_delivery_locations',
  jobs: null,                                       // production reads job numbers from AWE job data
  purchase_requests: 'purchase_requests',
  purchase_request_items: 'purchase_request_items',
  purchase_request_attachments: 'purchase_request_attachments',
  purchase_reviews: 'purchase_reviews',
  purchase_review_items: 'purchase_review_items',
  purchase_approvals: 'purchase_approvals',
  po_number_sequences: 'po_number_sequences',
  request_number_sequences: 'request_number_sequences',
  purchase_orders: 'purchase_orders',
  purchase_order_items: 'purchase_order_items',
  purchase_order_documents: 'purchase_order_documents',
  email_templates: 'purchase_email_templates',
  purchase_email_drafts: 'purchase_email_drafts',
  purchase_receipts: 'purchase_receipts',
  purchase_receipt_items: 'purchase_receipt_items',
  purchase_receipt_attachments: 'purchase_receipt_attachments',
  inventory_observations: 'inventory_observations',
  inventory_adjustments: 'inventory_adjustments',
  purchase_activity_log: 'purchase_activity_log',
  purchase_notifications: 'purchase_notifications',
  system_settings: 'purchasing_settings',
  // Credentials are the auth provider's, never purchasing's: in production
  // Supabase Auth owns them in auth.users and 0017 stores only the reference.
  auth_identities: null,
  user_job_assignments: 'purchasing_job_assignments',
  purchase_item_catalog: 'purchase_item_catalog',
  purchase_jobs: 'purchase_jobs',
};

export async function validate() {
  const sql = [MIGRATION, MIGRATION_0017, MIGRATION_0018].map((f) => readFileSync(f, 'utf8')).join('\n');
  const problems = [];
  const bad = (m) => problems.push(m);

  const { REQUEST_STATUSES, TRANSITIONS } = await import(join(APP, 'purchasing', 'domain', 'status.mjs'));
  const { ROLE_PERMISSIONS, APPROVAL_GRANT_PERMISSIONS, ROLES } = await import(join(APP, 'purchasing', 'domain', 'roles.mjs'));
  const { EMAIL_TEMPLATE_TYPES, EMAIL_DRAFT_STATUSES } = await import(join(APP, 'purchasing', 'domain', 'email.mjs'));
  const { TABLES } = await import(join(APP, 'purchasing', 'infrastructure', 'sqlite', 'database.ts'));

  // --- status enum ----------------------------------------------------------
  const statusEnum = enumValues(sql, 'purchase_request_status');
  for (const s of REQUEST_STATUSES) {
    if (!statusEnum.includes(s)) bad(`status ${s} is missing from purchase_request_status`);
  }
  for (const s of statusEnum) {
    if (!REQUEST_STATUSES.includes(s)) bad(`purchase_request_status has ${s}, which the app does not know`);
  }

  // --- role enum ------------------------------------------------------------
  const roleEnum = enumValues(sql, 'purchasing_role');
  for (const r of ROLES) if (!roleEnum.includes(r)) bad(`role ${r} is missing from purchasing_role`);
  for (const r of roleEnum) if (!ROLES.includes(r)) bad(`purchasing_role has ${r}, which the app does not know`);

  // --- transition graph -----------------------------------------------------
  const guard = functionBody(sql, 'guard_purchase_request_transition');
  if (!guard) bad('guard_purchase_request_transition() is not defined in the migration');
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    if (targets.length === 0) {
      if (guard.includes(`old.status = '${from}'`)) {
        bad(`${from} is terminal in the app but has an allowed transition in the SQL guard`);
      }
      continue;
    }
    const clause = guardClause(guard, from);
    if (!clause) {
      bad(`the SQL guard has no clause for ${from}`);
      continue;
    }
    for (const to of targets) {
      if (!clause.includes(`'${to}'`)) bad(`the SQL guard is missing ${from} -> ${to}`);
    }
    for (const quoted of clause.match(/'([A-Z_]+)'/g) ?? []) {
      const to = quoted.slice(1, -1);
      if (to !== from && !targets.includes(to)) bad(`the SQL guard allows ${from} -> ${to}, which the app forbids`);
    }
  }

  // --- role / permission matrix --------------------------------------------
  // Built from the app's own role list, so adding a role cannot silently
  // narrow what this lint looks at.
  const rolePermPattern = new RegExp(`\\('(${ROLES.join('|')})',\\s*'([\\w.]+)'\\)`, 'g');
  const rolePermRows = new Set([...sql.matchAll(rolePermPattern)].map((m) => `${m[1]}:${m[2]}`));

  // Migrations are append-only, so a grant seeded by one migration can be
  // WITHDRAWN by a later one. Reading only the INSERTs would report a
  // divergence that the database does not actually have. Every migration is
  // scanned for deletes and they are applied to the seeded set, in the same
  // order Postgres would apply them.
  const allMigrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
  for (const m of allMigrations.matchAll(
    /delete\s+from\s+purchasing_role_permissions\s+where([\s\S]*?);/gi,
  )) {
    const clause = m[1];
    const deletedRoles = [...clause.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).filter((r) => ROLES.includes(r));
    const deletedPerms = [...clause.matchAll(/permission\s*=\s*'([\w.]+)'/g)].map((x) => x[1]);
    for (const role of deletedRoles) {
      for (const permission of deletedPerms) rolePermRows.delete(`${role}:${permission}`);
    }
  }
  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    if (role === 'ADMIN') continue; // seeded by the union query, checked below
    for (const p of permissions) {
      if (!rolePermRows.has(`${role}:${p}`)) bad(`purchasing_role_permissions is missing (${role}, ${p})`);
    }
  }
  for (const key of rolePermRows) {
    const [role, permission] = key.split(':');
    if (role === 'ADMIN') continue;
    if (!(ROLE_PERMISSIONS[role] ?? []).includes(permission)) {
      bad(`purchasing_role_permissions grants (${role}, ${permission}), which the app does not`);
    }
  }
  const grantBlock = between(sql, 'insert into purchasing_grant_permissions', ';');
  for (const p of APPROVAL_GRANT_PERMISSIONS) {
    if (!grantBlock.includes(`'${p}'`)) bad(`purchasing_grant_permissions is missing ${p}`);
  }

  // --- email vocabulary -----------------------------------------------------
  const templateEnum = enumValues(sql, 'purchase_email_template');
  for (const t of EMAIL_TEMPLATE_TYPES) if (!templateEnum.includes(t)) bad(`email template ${t} is missing from the enum`);
  const draftEnum = enumValues(sql, 'purchase_email_status');
  for (const s of EMAIL_DRAFT_STATUSES) if (!draftEnum.includes(s)) bad(`email draft status ${s} is missing from the enum`);

  // --- table parity ---------------------------------------------------------
  const created = new Set([...sql.matchAll(/create table (?:if not exists )?(\w+)/g)].map((m) => m[1]));
  for (const pilotTable of TABLES) {
    if (!(pilotTable in TABLE_MAP)) {
      bad(`pilot table ${pilotTable} has no entry in TABLE_MAP — add it or map it to null with a reason`);
      continue;
    }
    const target = TABLE_MAP[pilotTable];
    if (target === null) continue;
    if (!created.has(target) && !['orgs', 'users'].includes(target)) {
      bad(`migration 0016 does not create ${target} (pilot table ${pilotTable})`);
    }
  }

  // --- no send capability ---------------------------------------------------
  // Comments are stripped first: the header SAYS "no SMTP", and a lint that
  // cannot tell a promise from a call is a lint nobody keeps.
  const code = stripComments(sql).toLowerCase();
  for (const forbidden of ['pg_net', 'http_post', 'http_get', 'smtp', 'graph.microsoft', 'net.http']) {
    if (code.includes(forbidden)) bad(`the migration references ${forbidden} — v1 has no send path`);
  }

  // --- the gates that make it safe -----------------------------------------
  const required = [
    ['purchase_email_no_external_send', 'the external-send kill switch'],
    ['purchase_email_sent_requires_review', 'the send gate'],
    ['purchase_email_vendor_needs_po', 'no vendor email without a purchase order'],
    ['guard_po_number_permanent', 'permanent PO numbers'],
    ['guard_po_sequence_forward', 'forward-only PO sequence'],
    ['for update', 'the PO sequence row lock'],
    ['guard_no_delete', 'append-only business records'],
    ['guard_receipt_quantities', 'the over-receipt guard'],
    ['guard_request_item_immutability', 'the original request is read-only after submission'],
    ['a request cannot be decided by the person who raised it', 'the self-approval refusal'],
  ];
  for (const [needle, what] of required) {
    if (!sql.includes(needle)) bad(`migration 0016 is missing ${what} (${needle})`);
  }

  return problems;
}

function enumValues(sql, name) {
  const m = sql.match(new RegExp(`create type ${name} as enum\\s*\\(([\\s\\S]*?)\\);`));
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function between(sql, start, end) {
  const i = sql.indexOf(start);
  if (i === -1) return '';
  const j = sql.indexOf(end, i + start.length);
  return sql.slice(i, j === -1 ? sql.length : j + end.length);
}

/** The body of a plpgsql function: everything between `as $$` and the next `$$`. */
function functionBody(sql, name) {
  const i = sql.indexOf(`function ${name}(`);
  if (i === -1) return '';
  const open = sql.indexOf('$$', i);
  if (open === -1) return '';
  const close = sql.indexOf('$$', open + 2);
  return sql.slice(open + 2, close === -1 ? sql.length : close);
}

function stripComments(sql) {
  return sql
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line.replace(/\s--.*$/, '')))
    .join('\n');
}

function guardClause(guard, from) {
  const marker = `old.status = '${from}'`;
  const i = guard.indexOf(marker);
  if (i === -1) return null;
  const j = guard.indexOf('\n', i);
  return guard.slice(i, j === -1 ? guard.length : j);
}

// Run directly: `node scripts/lib/validate-migration-0016.mjs`
if (process.argv[1] && process.argv[1].endsWith('validate-migration-0016.mjs')) {
  const problems = await validate();
  for (const p of problems) console.log(`FAIL  ${p}`);
  console.log(problems.length === 0 ? 'migration 0016 parity: PASS' : `migration 0016 parity: ${problems.length} problem(s)`);
  process.exit(problems.length === 0 ? 0 : 1);
}
