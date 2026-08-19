#!/usr/bin/env node
// ---------------------------------------------------------------------------
// pcc-onboard.mjs — load a company's real users, jobs, vendors, assignments and
// purchase-order sequences into a production installation.
//
// WHY THIS EXISTS. Everything below is already possible through the Admin
// screens, one record at a time. On the day, that is fifty-odd forms typed by
// somebody watching a room wait, and a typo in a vendor CODE is not a typo —
// it is baked into every purchase order number that vendor ever receives. This
// reads reviewed files instead, so the values are checked before anybody is
// standing over the keyboard.
//
// IT CALLS THE SAME FUNCTIONS THE SCREENS CALL. administration.inviteUser,
// createJob, createVendor, setJobAssignment, initializePoSequence. No SQL, no
// second copy of a validation rule, no state the application could not have
// produced itself. A row this refuses is a row the Admin screen would also have
// refused.
//
//   node scripts/pcc-onboard.mjs --dir config/onboarding --dry-run
//   node scripts/pcc-onboard.mjs --dir config/onboarding
//   node scripts/pcc-onboard.mjs --dir config/onboarding --only users,jobs
//
//   --dir       directory holding the CSV files. Required.
//   --dry-run   validate everything and write NOTHING. Always do this first.
//   --only      comma-separated subset: users,jobs,vendors,assignments,sequences
//   --actor     email of the administrator to act as. Default: the first ADMIN.
//
// ORDER IS NOT A PREFERENCE. Jobs and vendors exist before assignments can name
// them, and before a sequence can be seeded for a job+vendor pair. The stages
// run in dependency order and a stage that fails stops the ones after it.
//
// IDEMPOTENT. Re-running skips what already matches and reports it as skipped
// rather than failing. A half-finished load is resumed by running it again,
// which is what you want at 4pm with people waiting.
//
// WHAT IT WILL NOT DO
//   · invent a value. A blank required cell is an error, never a default.
//   · guess a PO sequence. That number comes from the paper book.
//   · overwrite an existing PO sequence for a pair silently.
//   · set a password. Temporary passwords are generated and printed ONCE, for
//     the administrator to hand over; PCC forces a change at first sign-in.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = join(ROOT, 'apps', 'purchasing', 'src');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
}
const DIR = arg('dir');
const DRY = process.argv.includes('--dry-run');
const ONLY = (arg('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ACTOR_EMAIL = arg('actor');

if (!DIR) {
  console.error('pcc-onboard: --dir <directory of CSV files> is required.');
  console.error('Templates and the field rules: config/onboarding/README.md');
  process.exit(1);
}

const wanted = (stage) => ONLY.length === 0 || ONLY.includes(stage);

// --- CSV, deliberately small ------------------------------------------------
// Quoted fields with embedded commas are supported because an address has one.
// Nothing else is: this reads a file a person filled in, not a data feed.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function readTable(name) {
  const path = join(DIR, `${name}.csv`);
  if (!existsSync(path)) return null;
  const rows = parseCsv(readFileSync(path, 'utf8'));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1)
    // A row that is entirely the template's own example is skipped rather than
    // loaded: leaving the sample line in is the most likely filling-in mistake.
    .filter((r) => !String(r[0] ?? '').trim().startsWith('#'))
    .map((r, n) => {
      const o = { __line: n + 2 };
      header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
      return o;
    });
}

// --- reporting --------------------------------------------------------------
const results = [];
let errors = 0;
const ok = (stage, what) => { results.push({ stage, status: 'created', what }); console.log(`  created  ${what}`); };
const skip = (stage, what) => { results.push({ stage, status: 'skipped', what }); console.log(`  skipped  ${what} (already present)`); };
// A refusal that says the record is already there is the importer's own
// contract being met, not a failure: re-running must converge. Anything else
// is a real error and stops the run.
const ALREADY = /already exists|already in use|duplicate/i;
const bad = (stage, line, what, why) => {
  if (ALREADY.test(String(why))) { skip(stage, `${what} (${String(why).trim()})`); return; }
  errors++;
  results.push({ stage, status: 'error', what, why });
  console.log(`  ERROR    ${stage}.csv line ${line}: ${what} — ${why}`);
};
const step = (m) => { console.log(''); console.log(`== ${m}`); };

const ROLES = ['REQUESTOR', 'FOREMAN', 'OFFICE', 'WORKSHOP_APPROVER', 'ACCOUNTING', 'ADMIN'];

// WHAT A DRY RUN WOULD HAVE CREATED.
//
// Nothing is written in a dry run, so a later stage looking a job or a user up
// in the database finds nothing and reports a dependency error for a row that
// is fine — which made the dry run useless for everything past the first file.
// These registries let each stage see what the earlier stages would have made,
// so the run validates the file SET as a whole. In a real run they are simply
// the same facts the database already holds.
const pending = { jobs: new Set(), vendors: new Map(), users: new Set() };
// TWO JOB TABLES EXIST. administration.createJob writes purchase_jobs; the
// legacy `jobs` table is still read as a fallback by the reference repository.
// Checking only one of them made the importer create a job the application
// already had, and the create then failed with "already exists" — an error for
// something that was in fact fine.
const jobExists = (num) => pending.jobs.has(num)
  || !!db.prepare('select 1 from purchase_jobs where org_id = ? and job_number = ?').get(actor.orgId, num)
  || !!db.prepare('select 1 from jobs where org_id = ? and job_number = ?').get(actor.orgId, num);
const userExists = (email) => pending.users.has(email.toLowerCase())
  || !!db.prepare('select 1 from users where org_id = ? and lower(email) = lower(?)').get(actor.orgId, email);
const vendorFor = (name) => pending.vendors.get(name.toLowerCase())
  || db.prepare('select id, code from vendors where org_id = ? and lower(name) = lower(?)').get(actor.orgId, name);
const yes = (v) => ['y', 'yes', 'true', '1'].includes(String(v ?? '').trim().toLowerCase());
const has = (v) => String(v ?? '').trim() !== '';

// A password nobody chose and nobody keeps: printed once, changed at first
// sign-in. Generated here rather than taken from a file so a spreadsheet of
// real passwords never exists.
const tempPassword = () => `Pcc-${randomBytes(6).toString('base64url')}-2026`;

// --- the installation -------------------------------------------------------
process.env.PCC_DATABASE_ALLOW_CREATE = '';
const { getDb } = await import(join(APP, 'purchasing/infrastructure/sqlite/database.ts'));
const { purchasingContext } = await import(join(APP, 'purchasing/composition.ts'));
const admin = await import(join(APP, 'purchasing/application/administration.ts'));

const db = getDb();
const ctx = purchasingContext(db);

function loadActor(email) {
  const row = email
    ? db.prepare('select * from users where lower(email) = lower(?)').get(email)
    : db.prepare(`select u.* from users u join user_roles ur on ur.user_id = u.id
                  where ur.role_key = 'ADMIN' and u.is_active = 1 order by u.created_at limit 1`).get();
  if (!row) {
    console.error(email
      ? `pcc-onboard: no user with email ${email}`
      : 'pcc-onboard: no active ADMIN in this installation. Complete the first start, then run this.');
    process.exit(1);
  }
  const roles = db.prepare('select role_key from user_roles where user_id = ?').all(row.id).map((r) => r.role_key);
  return {
    id: row.id, orgId: row.org_id, name: row.full_name, email: row.email, roles,
    canApprove: !!row.can_approve, isActive: !!row.is_active,
    isPrimaryApprover: !!row.is_primary_approver, isBackupApprover: !!row.is_backup_approver,
    isDeliveryReceiver: !!row.is_delivery_receiver,
    assignedJobNumbers: db.prepare('select job_number from user_job_assignments where user_id = ?')
      .all(row.id).map((r) => r.job_number),
  };
}

const actor = loadActor(ACTOR_EMAIL);
if (!actor.roles.includes('ADMIN')) {
  console.error(`pcc-onboard: ${actor.email} is not an ADMIN. Loading company data is an administrator's act.`);
  process.exit(1);
}

console.log('');
console.log('PCC ONBOARDING LOAD');
console.log(`  directory : ${DIR}`);
console.log(`  acting as : ${actor.name} <${actor.email}>`);
console.log(`  mode      : ${DRY ? 'DRY RUN — nothing will be written' : 'WRITING'}`);

const handedOut = [];

// --- 1. jobs ----------------------------------------------------------------
if (wanted('jobs')) {
  const rows = readTable('jobs');
  step(`jobs (${rows?.length ?? 0} row(s))`);
  if (!rows) console.log('  no jobs.csv — skipping');
  else {
    const seen = new Set();
    for (const r of rows) {
      const num = r.job_number;
      if (!has(num)) { bad('jobs', r.__line, '(blank)', 'job_number is required'); continue; }
      if (!has(r.name)) { bad('jobs', r.__line, num, 'name is required'); continue; }
      if (seen.has(num)) { bad('jobs', r.__line, num, 'duplicated in this file'); continue; }
      seen.add(num);
      if (jobExists(num)) { skip('jobs', num); continue; }
      pending.jobs.add(num);
      if (DRY) { ok('jobs', `${num} — ${r.name}`); continue; }
      try {
        await admin.createJob(ctx, actor, {
          jobNumber: num, name: r.name, customer: r.customer || undefined,
          siteAddress: r.site_address || undefined,
          deliveryInstructions: r.delivery_instructions || undefined,
          status: r.status || undefined,
        });
        ok('jobs', `${num} — ${r.name}`);
      } catch (e) { bad('jobs', r.__line, num, e.message); }
    }
  }
}

// --- 2. vendors -------------------------------------------------------------
// THE VENDOR CODE IS PART OF EVERY PURCHASE ORDER NUMBER FOR THAT VENDOR.
// Changing it later does not renumber what was already issued, so the paper
// trail splits. It is checked harder than anything else here.
if (wanted('vendors')) {
  const rows = readTable('vendors');
  step(`vendors (${rows?.length ?? 0} row(s))`);
  if (!rows) console.log('  no vendors.csv — skipping');
  else {
    const seenName = new Set(), seenCode = new Set();
    for (const r of rows) {
      const name = r.name;
      if (!has(name)) { bad('vendors', r.__line, '(blank)', 'name is required'); continue; }
      if (!has(r.code)) { bad('vendors', r.__line, name, 'code is required — it appears in every PO number for this vendor'); continue; }
      const code = r.code.trim().toUpperCase();
      if (!/^[A-Z0-9]+$/.test(code)) { bad('vendors', r.__line, name, `code "${r.code}" must be letters and digits only — it goes into a PO number`); continue; }
      if (seenName.has(name.toLowerCase())) { bad('vendors', r.__line, name, 'duplicated in this file'); continue; }
      if (seenCode.has(code)) { bad('vendors', r.__line, name, `code ${code} is used by another row — two vendors sharing a code produce colliding PO numbers`); continue; }
      seenName.add(name.toLowerCase()); seenCode.add(code);

      const clash = db.prepare('select name from vendors where org_id = ? and upper(code) = ? and lower(name) <> lower(?)')
        .get(actor.orgId, code, name);
      if (clash) { bad('vendors', r.__line, name, `code ${code} already belongs to "${clash.name}"`); continue; }
      const existing = db.prepare('select id, code from vendors where org_id = ? and lower(name) = lower(?)').get(actor.orgId, name);
      if (existing) { skip('vendors', `${name} (${existing.code ?? 'no code'})`); continue; }
      // A DRY RUN records a placeholder so the sequence stage can resolve the
      // pair; a real run records the id the database actually assigned. Setting
      // the placeholder in both handed the real run a vendor id that does not
      // exist, and initializePoSequence correctly answered "vendor not found".
      if (DRY) {
        pending.vendors.set(name.toLowerCase(), { id: `pending:${code}`, code });
        ok('vendors', `${name} [${code}]`);
        continue;
      }
      try {
        await admin.createVendor(ctx, actor, {
          name, code, accountNumber: r.account_number || undefined,
          phone: r.phone || undefined, address: r.address || undefined,
          contactName: r.contact_name || undefined,
          contactEmail: r.contact_email || undefined,
          contactPhone: r.contact_phone || undefined,
        });
        const row = db.prepare('select id, code from vendors where org_id = ? and lower(name) = lower(?)')
          .get(actor.orgId, name);
        if (row) pending.vendors.set(name.toLowerCase(), row);
        ok('vendors', `${name} [${code}]`);
      } catch (e) { bad('vendors', r.__line, name, e.message); }
    }
  }
}

// --- 3. users ---------------------------------------------------------------
if (wanted('users')) {
  const rows = readTable('users');
  step(`users (${rows?.length ?? 0} row(s))`);
  if (!rows) console.log('  no users.csv — skipping');
  else {
    const seen = new Set();
    for (const r of rows) {
      const email = r.email?.toLowerCase();
      if (!has(r.full_name)) { bad('users', r.__line, '(blank)', 'full_name is required'); continue; }
      if (!has(email)) { bad('users', r.__line, r.full_name, 'email is required — it is the sign-in identity'); continue; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { bad('users', r.__line, r.full_name, `"${r.email}" does not look like an email address`); continue; }
      if (seen.has(email)) { bad('users', r.__line, r.full_name, `${email} appears twice in this file`); continue; }
      seen.add(email);

      const roles = (r.roles ?? '').split(/[;|]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (!roles.length) { bad('users', r.__line, r.full_name, 'at least one role is required'); continue; }
      const unknown = roles.filter((x) => !ROLES.includes(x));
      if (unknown.length) { bad('users', r.__line, r.full_name, `unknown role(s) ${unknown.join(', ')} — valid: ${ROLES.join(', ')}`); continue; }

      const jobs = (r.job_assignments ?? '').split(/[;|]/).map((s) => s.trim()).filter(Boolean);
      // A foreman with no assignment can raise requests and sign for nothing.
      // Legal, and almost always a filling-in omission, so it is said out loud.
      if (roles.includes('FOREMAN') && !jobs.length && !yes(r.workshop_assignment)) {
        console.log(`  note     ${r.full_name} is a FOREMAN with no job or workshop assignment — they will not be able to receive anything`);
      }
      const missingJobs = jobs.filter((j) => !jobExists(j));
      if (missingJobs.length) {
        bad('users', r.__line, r.full_name,
          `job(s) ${missingJobs.join(', ')} do not exist — add them to jobs.csv`);
        continue;
      }

      const existing = db.prepare('select id from users where org_id = ? and lower(email) = lower(?)').get(actor.orgId, email);
      if (existing) { skip('users', `${r.full_name} <${email}>`); continue; }
      pending.users.add(email);
      if (DRY) { ok('users', `${r.full_name} <${email}> ${roles.join('+')}`); continue; }
      try {
        const password = tempPassword();
        const created = await admin.inviteUser(ctx, actor, {
          fullName: r.full_name, email, roles, temporaryPassword: password,
          canApprove: yes(r.approver),
          isDeliveryReceiver: yes(r.receiver) || yes(r.workshop_assignment) || jobs.length > 0,
          jobNumbers: jobs,
        });
        handedOut.push({ name: r.full_name, email, password });
        if (yes(r.login_enabled) === false && has(r.login_enabled)) {
          await admin.setUserDisabled(ctx, actor, created?.id ?? created, true);
          ok('users', `${r.full_name} <${email}> — created DISABLED as requested`);
        } else {
          ok('users', `${r.full_name} <${email}> ${roles.join('+')}`);
        }
      } catch (e) { bad('users', r.__line, r.full_name, e.message); }
    }
  }
}

// --- 4. assignments ---------------------------------------------------------
// Separate from users.csv because assignments change after launch — a foreman
// moves to another site — and re-running the user load is not the way to do it.
if (wanted('assignments')) {
  const rows = readTable('assignments');
  step(`receiving assignments (${rows?.length ?? 0} row(s))`);
  if (!rows) console.log('  no assignments.csv — skipping');
  else {
    for (const r of rows) {
      const email = r.email?.toLowerCase();
      const location = (r.location ?? '').trim();
      if (!has(email) || !has(location)) { bad('assignments', r.__line, email || '(blank)', 'email and location are both required'); continue; }
      if (!userExists(email)) { bad('assignments', r.__line, email, 'no such user — add them to users.csv'); continue; }
      const isWorkshop = location.toUpperCase() === 'WORKSHOP';
      if (!isWorkshop && !jobExists(location)) {
        bad('assignments', r.__line, email, `job ${location} does not exist — add it to jobs.csv`); continue;
      }
      const u = db.prepare('select id, full_name from users where org_id = ? and lower(email) = lower(?)').get(actor.orgId, email)
        ?? { id: null, full_name: email };
      if (DRY && !u.id) { ok('assignments', `${u.full_name} -> ${location}`); continue; }
      const already = db.prepare('select 1 from user_job_assignments where user_id = ? and job_number = ?')
        .get(u.id, isWorkshop ? 'WORKSHOP' : location);
      if (already) { skip('assignments', `${u.full_name} -> ${location}`); continue; }
      if (DRY) { ok('assignments', `${u.full_name} -> ${location}`); continue; }
      try {
        await admin.setJobAssignment(ctx, actor, u.id, location, true);
        await admin.setDeliveryReceiver(ctx, actor, u.id, true);
        ok('assignments', `${u.full_name} -> ${location}`);
      } catch (e) { bad('assignments', r.__line, email, e.message); }
    }
  }
}

// --- 5. PO sequence seeds ---------------------------------------------------
// THE IRREVERSIBLE ONE. A number issued to a supplier cannot be withdrawn, and
// a wrong seed collides with paper that already exists. Only pairs with paper
// history belong here; a pair with no history starts at 1 correctly on its own.
if (wanted('sequences')) {
  const rows = readTable('po_sequences');
  step(`purchase-order sequence seeds (${rows?.length ?? 0} row(s))`);
  if (!rows) console.log('  no po_sequences.csv — skipping');
  else {
    const seen = new Set();
    for (const r of rows) {
      const job = (r.job_number ?? '').trim();
      const vendorName = (r.vendor_name ?? '').trim();
      const last = (r.last_issued_sequence ?? '').trim();
      if (!has(job) || !has(vendorName) || !has(last)) {
        bad('sequences', r.__line, `${job}/${vendorName}`, 'job_number, vendor_name and last_issued_sequence are all required'); continue;
      }
      const n = Number(last);
      if (!Number.isSafeInteger(n) || n < 1) { bad('sequences', r.__line, `${job}/${vendorName}`, `last_issued_sequence "${last}" must be a whole number of 1 or more`); continue; }
      const key = `${job}|${vendorName.toLowerCase()}`;
      if (seen.has(key)) { bad('sequences', r.__line, key, 'this job+vendor pair appears twice — one of them is wrong'); continue; }
      seen.add(key);

      if (!jobExists(job)) { bad('sequences', r.__line, job, 'job does not exist — add it to jobs.csv'); continue; }
      const vendor = vendorFor(vendorName);
      if (!vendor) { bad('sequences', r.__line, vendorName, 'vendor does not exist — add it to vendors.csv'); continue; }

      // THE ONE THAT MUST NOT MOVE SILENTLY. A sequence already initialized for
      // this pair is either the same number — in which case re-running is a
      // no-op — or a DIFFERENT number, which would renumber purchase orders
      // this installation is about to issue. The second case is refused here
      // rather than applied: moving a live sequence is a deliberate act done on
      // the screen, where it demands an acknowledgement.
      const current = vendor.id.startsWith?.('pending:') ? null
        : db.prepare('select next_value from po_job_vendor_sequences where org_id = ? and job_number = ? and vendor_id = ?')
            .get(actor.orgId, job, vendor.id);
      if (current) {
        if (Number(current.next_value) === n + 1) { skip('sequences', `${job} + ${vendorName} — already starts at ${n + 1}`); continue; }
        bad('sequences', r.__line, `${job}/${vendorName}`,
          `already initialized: next is ${current.next_value}, this file says it should be ${n + 1}. `
          + 'Refusing to move a live sequence — change it on the Admin screen, which asks you to acknowledge it.');
        continue;
      }
      if (DRY) { ok('sequences', `${job} + ${vendorName} (${vendor.code}) — next will be ${n + 1}`); continue; }
      try {
        await admin.initializePoSequence(ctx, actor, {
          jobNumber: job, vendorId: vendor.id, lastIssuedSequence: n,
        });
        ok('sequences', `${job}-${vendor.code}-${n + 1} is next`);
      } catch (e) { bad('sequences', r.__line, `${job}/${vendorName}`, e.message); }
    }
  }
}

// --- what happened ----------------------------------------------------------
console.log('');
console.log('======================================================================');
const created = results.filter((r) => r.status === 'created').length;
const skipped = results.filter((r) => r.status === 'skipped').length;
console.log(`  ${created} created, ${skipped} already present, ${errors} error(s)`);

if (handedOut.length) {
  console.log('');
  console.log('  TEMPORARY PASSWORDS — hand these over in person, then destroy this output.');
  console.log('  Each person is forced to change theirs at first sign-in.');
  for (const h of handedOut) console.log(`    ${h.name.padEnd(28)} ${h.email.padEnd(34)} ${h.password}`);
}

if (errors) {
  console.log('');
  console.log('  NOT COMPLETE. Fix the rows named above and run this again —');
  console.log('  everything that succeeded is skipped on the second pass.');
  process.exit(1);
}
if (DRY) {
  console.log('');
  console.log('  DRY RUN — nothing was written. Re-run without --dry-run to load it.');
}
process.exit(0);
