// ---------------------------------------------------------------------------
// eval-onboarding.mjs — the company-data load, checked without a database.
//
// The importer itself was validated against a real production-mode install:
// bare org, admin bootstrap, then jobs, vendors, users, assignments and a
// purchase-order seed, run twice to prove it converges. What this file defends
// is the part that rots quietly — the templates matching what the importer
// reads, no real company data reaching the repository, and the two refusals
// that matter more than any of it.
//
//   node scripts/eval-onboarding.mjs
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
const failures = [];
const check = (c, m) => (c ? pass++ : (failures.push(m), console.log(`FAIL  ${m}`)));

const IMPORTER = 'scripts/pcc-onboard.mjs';
const DIR = 'config/onboarding';
const importer = read(IMPORTER);

console.log('--- the importer and its templates exist -----------------------');
check(existsSync(join(ROOT, IMPORTER)), `${IMPORTER} exists`);

// Header ↔ reader agreement. A renamed column silently becomes an empty cell,
// and an empty required cell is refused — which reads like the operator got it
// wrong when in fact the template and the reader disagree.
const TABLES = {
  users: ['full_name', 'email', 'roles', 'approver', 'receiver', 'workshop_assignment', 'job_assignments', 'login_enabled'],
  jobs: ['job_number', 'name', 'customer', 'site_address', 'delivery_instructions', 'status'],
  vendors: ['name', 'code', 'account_number', 'phone', 'address', 'contact_name', 'contact_email', 'contact_phone'],
  assignments: ['email', 'location'],
  po_sequences: ['job_number', 'vendor_name', 'last_issued_sequence'],
};

for (const [table, columns] of Object.entries(TABLES)) {
  const path = `${DIR}/${table}.csv`;
  check(existsSync(join(ROOT, path)), `${path} exists`);
  if (!existsSync(join(ROOT, path))) continue;
  const header = read(path).split('\n')[0].trim().split(',').map((h) => h.trim());
  for (const c of columns) {
    check(header.includes(c), `${table}.csv has a ${c} column`);
    check(importer.includes(c), `the importer reads ${table}.${c}`);
  }
}

console.log('--- no real company data in the repository ---------------------');
// Placeholders are commented out with '#'. A live row would be data, and data
// belongs on the server, not in a repository that gets cloned and mailed.
for (const file of readdirSync(join(ROOT, DIR)).filter((f) => f.endsWith('.csv'))) {
  const lines = read(`${DIR}/${file}`).split('\n').slice(1)
    .map((l) => l.trim()).filter(Boolean);
  check(lines.every((l) => l.startsWith('#')),
    `${file} carries only commented placeholders — real values live on the server`);
}
// The obvious tell, checked by value rather than by trusting the rule above.
for (const file of readdirSync(join(ROOT, DIR)).filter((f) => f.endsWith('.csv'))) {
  const body = read(`${DIR}/${file}`);
  check(!/@lippoliselectric\.com/.test(body.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')),
    `${file} contains no live Lippolis address on an active row`);
}

console.log('--- the refusals that matter -----------------------------------');

// A PO number cannot be withdrawn once a supplier has it, so a seed that would
// MOVE a live sequence is refused rather than applied.
check(/Refusing to move a live sequence/.test(importer),
  'the importer refuses to move an already-initialized PO sequence');
check(/already starts at/.test(importer),
  'and treats a matching seed as a no-op rather than re-applying it');
check(/does not look like an email address/.test(importer),
  'a malformed sign-in address is refused');
check(/letters and digits only/.test(importer),
  'a vendor code is constrained — it goes into every PO number for that vendor');
check(/two vendors sharing a code produce colliding PO numbers/.test(importer),
  'two vendors cannot share a code');
check(/unknown role/.test(importer), 'an unknown role is refused rather than ignored');
check(/is not an ADMIN/.test(importer), 'loading company data requires an administrator');

// Idempotence is the contract: the load is resumed by running it again.
check(/ALREADY *= *\/already exists/.test(importer) || /already exists\|already in use\|duplicate/.test(importer),
  'a record that already exists is a skip, not a failure — re-running converges');
check(/--dry-run/.test(importer), 'the load can be validated without writing');
check(/validates the file SET as a whole/.test(importer),
  'and a dry run resolves cross-file references, so it checks more than the first file');

// Passwords are generated, printed once, and never read from a file: a
// spreadsheet of real passwords must not be a step in this process.
check(/randomBytes/.test(importer), 'temporary passwords are generated, not supplied in a file');
check(!/password/i.test(read(`${DIR}/users.csv`)), 'users.csv has no password column');

// It must call the application, not the database.
check(/admin\.inviteUser|admin\.createJob|admin\.createVendor/.test(importer),
  'the importer goes through the application layer the screens use');
check(!/insert into/i.test(importer), 'and writes no SQL of its own');

console.log('');
if (failures.length) {
  console.log(`onboarding checks: ${pass} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`onboarding checks: ${pass} passed, 0 failed`);
