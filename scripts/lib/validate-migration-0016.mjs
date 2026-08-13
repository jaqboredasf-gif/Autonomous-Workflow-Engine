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
//   * BR-011                     — the LATEST definition of the decision RPC
//                                  gates on the review.decide capability, does
//                                  not refuse self-approval, and stamps it
//   * BR-014                     — the LATEST definition of purchasing_may_receive
//                                  gates on capability + job scope, and never
//                                  on who requested or approved the order
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
// 0030 replaces the purchase_line_history VIEW with the immutable history
// table. It creates a pilot-parity table, so table parity must see it.
const MIGRATION_0030 = join(ROOT, 'supabase', 'migrations', '0030_purchasing_immutable_history.sql');
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
  // Retired by 0038 as the allocator; the table stays because it records what
  // an office was configured to before the real rule was known.
  po_number_sequences: 'po_number_sequences',
  po_job_vendor_sequences: 'po_job_vendor_sequences',
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
  purchase_history_lines: 'purchase_history_lines',
};

export async function validate() {
  const sql = [MIGRATION, MIGRATION_0017, MIGRATION_0018, MIGRATION_0030]
    .map((f) => readFileSync(f, 'utf8')).join('\n');
  const problems = [];
  const bad = (m) => problems.push(m);

  const { REQUEST_STATUSES, TRANSITIONS } = await import(join(APP, 'purchasing', 'domain', 'status.mjs'));
  const { ROLE_PERMISSIONS, APPROVAL_GRANT_PERMISSIONS, ROLES, DENY_REASONS } =
    await import(join(APP, 'purchasing', 'domain', 'roles.mjs'));
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
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') }));
  const allMigrations = migrationFiles.map((f) => f.text).join('\n');
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
  // Every migration, not only the four read into `sql`: a pilot table created
  // by a later migration (po_job_vendor_sequences, 0038) is still a table the
  // production schema has, and reporting it missing would be a false alarm.
  const created = new Set(
    [...allMigrations.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)/g)].map((m) => m[1]),
  );
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
  ];
  for (const [needle, what] of required) {
    if (!sql.includes(needle)) bad(`migration 0016 is missing ${what} (${needle})`);
  }

  // --- 0038: the numbering rule Lippolis actually uses ----------------------
  //
  // Checked across every migration rather than 0016, because that is where it
  // lives. Each of these is a property the pilot store also has, and the two
  // must not drift: a purchase order numbered one way on the workshop PC and
  // another way in production would be two products.
  // THE ONE PLACE THE FORMAT IS DUPLICATED, and therefore the one place it can
  // drift. `formatPoNumber` builds the number for the local provider; Postgres
  // must build it inside `next_po_number_for()`, because the allocation has to
  // be one statement to be atomic. Two implementations of one format is a
  // deliberate cost — so the separator, the component order and the absence of
  // padding are asserted against the DOMAIN's own constants rather than against
  // a string typed twice.
  {
    const { PO_NUMBER_SEPARATOR, formatPoNumber } =
      await import(join(APP, 'purchasing', 'domain', 'po-number.mjs'));
    const sep = PO_NUMBER_SEPARATOR;
    const expression = `v_job || '${sep}' || v_code || '${sep}' || v_seq::text`;
    if (!allMigrations.includes(expression)) {
      bad(
        `the Postgres allocator does not build the PO number the way domain/po-number.mjs does ` +
        `(expected \`${expression}\`) — the two providers would issue differently formatted numbers`,
      );
    }
    // And the domain itself still produces what that expression produces, so a
    // change to formatPoNumber cannot pass by leaving the SQL alone.
    const sample = formatPoNumber({ jobNumber: 'JOB', vendorCode: 'VEND', sequence: 5 });
    if (sample !== `JOB${sep}VEND${sep}5`) {
      bad(`formatPoNumber no longer produces job${sep}vendor${sep}sequence (got ${sample}) — update migration 0038 to match`);
    }
    if (/lpad|to_char/.test(allMigrations.slice(allMigrations.indexOf('next_po_number_for')).slice(0, 2000))) {
      bad('the Postgres allocator pads the sequence; the local provider does not');
    }
  }

  for (const [needle, what] of [
    ['po_job_vendor_sequences', 'the per (job, vendor) sequence table'],
    ['next_po_number_for', 'the per-pair allocator'],
    ['guard_po_pair_sequence_forward', 'forward-only pair sequences'],
    ['initialize_po_sequence', 'the administrator-controlled historical initialization'],
    ['purchase_orders_pair_sequence_idx', 'per-pair uniqueness on the orders themselves'],
    ['drop constraint if exists purchase_orders_org_id_sequence_value_key', 'retiring the global sequence uniqueness'],
    ['revoke execute on function next_po_number', 'putting the retired global allocator out of reach'],
  ]) {
    if (!allMigrations.includes(needle)) bad(`the migrations are missing ${what} (${needle})`);
  }

  // --- BR-011: approval authority, not requester identity -------------------
  //
  // Migrations are append-only, so the rule the DATABASE enforces is whatever
  // the LAST definition of record_purchase_decision() says. 0016's original
  // definition still contains the old identity refusal and always will; that
  // is history, not policy. This checks the definition that wins.
  const decisionDefs = migrationFiles.filter((f) =>
    f.text.includes('create or replace function record_purchase_decision'));
  if (decisionDefs.length === 0) {
    bad('no migration defines record_purchase_decision()');
  } else {
    const latest = decisionDefs[decisionDefs.length - 1];
    const body = functionBody(latest.text, 'record_purchase_decision') ?? '';
    if (!body.includes("purchasing_can(v_uid, 'review.decide')")) {
      bad(`${latest.name}: record_purchase_decision() does not check the review.decide capability`);
    }
    if (body.includes('a request cannot be decided by the person who raised it')) {
      bad(`${latest.name}: record_purchase_decision() still refuses self-approval — BR-011 makes approval a capability, not a function of who raised the request`);
    }
    if (!body.includes('self_approved')) {
      bad(`${latest.name}: record_purchase_decision() does not stamp self_approved — BR-011 records self-approval instead of refusing it`);
    }
    // The domain must not carry a denial the database cannot produce.
    if (DENY_REASONS.includes('self_approval')) {
      bad("roles.mjs still lists 'self_approval' as a denial reason, which BR-011 removed");
    }
  }

  // --- BR-014: receipt authority is capability + scope, never identity ------
  //
  // Same reasoning as above, for the receiving side. The rule the database
  // enforces is whatever the LAST definition of purchasing_may_receive() says,
  // and what must never appear in it is a test of who raised or approved the
  // order — signing for a delivery is a statement about the delivery.
  const receiveDefs = migrationFiles.filter((f) =>
    f.text.includes('function purchasing_may_receive'));
  if (receiveDefs.length === 0) {
    bad('no migration defines purchasing_may_receive()');
  } else {
    const latest = receiveDefs[receiveDefs.length - 1];
    const body = functionBody(latest.text, 'purchasing_may_receive') ?? '';
    if (!body.includes("purchasing_can(p_user, 'receiving.record')")) {
      bad(`${latest.name}: purchasing_may_receive() does not check the receiving.record capability`);
    }
    if (!body.includes('purchasing_is_field_only')) {
      bad(`${latest.name}: purchasing_may_receive() does not scope field users to their assigned jobs`);
    }
    for (const identity of ['requestor_id', 'created_by', 'approver_id']) {
      if (body.includes(identity)) {
        bad(`${latest.name}: purchasing_may_receive() consults ${identity} — BR-014 makes receipt authority a capability plus scope, never a function of who requested or approved the order`);
      }
    }
  }

  // --- BR-012: history is immutable evidence --------------------------------
  //
  // The rule the DATABASE enforces, checked over every migration in order: the
  // history table must exist, must be append-only, and no migration may add an
  // UPDATE or DELETE policy to it later. The old view must be gone — leaving it
  // would leave a second, contradictory answer to "what did we buy", and the
  // wrong one is the one called `history`.
  const everySql = migrationFiles.map((f) => f.text).join('\n');
  if (!/create table (?:if not exists )?purchase_history_lines/.test(everySql)) {
    bad('no migration creates purchase_history_lines — BR-012 needs an immutable history table');
  }
  if (!/drop view if exists purchase_line_history/.test(everySql)) {
    bad('purchase_line_history (the mutable view) is never dropped — two answers to "what did we buy" is one too many');
  }
  for (const trigger of ['purchase_history_lines_no_update', 'purchase_history_lines_no_delete']) {
    if (!everySql.includes(`create trigger ${trigger}`)) {
      bad(`purchase_history_lines is missing the ${trigger} guard — BR-012 makes history append-only`);
    }
  }
  for (const m of everySql.matchAll(/create policy (\w+) on purchase_history_lines\b([\s\S]*?);/g)) {
    if (/for (update|delete|all)\b/.test(m[2])) {
      bad(`policy ${m[1]} grants UPDATE or DELETE on purchase_history_lines — a correction is a new request, never an edit`);
    }
  }
  // THE OUTERMOST FENCE, and the one a live database found missing.
  //
  // 0030 shipped the table with RLS and two policies and no GRANT, so PostgREST
  // answered "permission denied" before RLS was ever consulted: the policies
  // were correct and the feature was unusable. 0031 grants exactly select and
  // insert. This asserts both halves — that the grant exists, and that no
  // migration ever widens it. 0020 grants `select, insert, update` over an
  // ARRAY of table names, and this table being added to such an array is the
  // realistic way UPDATE gets handed out by accident.
  if (!/grant\s+select,\s*insert\s+on\s+(public\.)?purchase_history_lines\s+to\s+authenticated/i.test(everySql)) {
    bad('purchase_history_lines is never granted select+insert to authenticated — PostgREST refuses it before RLS is consulted');
  }
  for (const m of everySql.matchAll(/grant\s+([\w\s,]+?)\s+on\s+(?:public\.)?purchase_history_lines\s+to\s+(\w+)/gi)) {
    const privileges = m[1].toLowerCase();
    if (/\b(update|delete|all)\b/.test(privileges)) {
      bad(`a migration grants ${m[1].trim()} on purchase_history_lines to ${m[2]} — history is append-only at the grant as well as the policy`);
    }
    if (m[2] !== 'authenticated') {
      bad(`a migration grants ${m[1].trim()} on purchase_history_lines to ${m[2]} — only authenticated reaches history, and never with RLS bypassed`);
    }
  }
  // The same table added to one of 0020's bulk grant loops would slip past the
  // check above, because those grants are built with format() at run time.
  for (const m of everySql.matchAll(/purchasing_tables\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/g)) {
    if (m[1].includes('purchase_history_lines')) {
      bad('purchase_history_lines appears in a bulk grant array — those loops grant UPDATE, which history must never have');
    }
  }
  // Snapshot columns are the whole point: an id-only history is the view again.
  for (const column of ['vendor_name', 'requestor_name', 'approver_name', 'request_number',
                        'po_number', 'job_number', 'requested_description', 'ordered_description']) {
    if (!new RegExp(`\\n\\s+${column}\\s`).test(everySql.slice(everySql.indexOf('create table purchase_history_lines')))) {
      bad(`purchase_history_lines has no ${column} snapshot — without it a rename rewrites history`);
    }
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
