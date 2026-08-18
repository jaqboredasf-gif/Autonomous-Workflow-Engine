// ---------------------------------------------------------------------------
// pcc-reset-admin.mjs — the way back in when nobody can sign in.
//
// THE FAILURE THIS EXISTS FOR. PCC creates one administrator on first start,
// from PCC_BOOTSTRAP_ADMIN_EMAIL/_PASSWORD, and the installation instructions
// then say to remove that password from the environment — correctly, because a
// bootstrap password left in a file is a bootstrap password somebody finds.
// Every other account recovers through Administration → Users → Reset access.
// The administrator's own account had no route at all: forget that password
// and PCC is a running, healthy application that nobody can enter, and the only
// remedy was a developer with a SQL prompt.
//
// That is exactly the dependency this whole phase exists to remove. So:
// recovery is a command on the server, run by whoever holds shell access to the
// machine and the database file — which is the same authority that could
// replace the database outright, so it grants nothing new.
//
//   node scripts/pcc-reset-admin.mjs --db /data/pcc.sqlite \
//                                    --email mike@lippoliselectric.com \
//                                    --password 'a new long password'
//
//   --db        the live database. REQUIRED, must already exist.
//   --email     whose password to set. REQUIRED. Must already be a user.
//   --password  the new password. REQUIRED, 12 characters or more.
//   --enable    also re-enable the account if it is disabled or inactive.
//   --list      print the administrators and exit, changing nothing.
//
// WHAT IT WILL NOT DO, and each of these is a decision:
//
//   · create a database. It opens an existing file or exits — an installation
//     recovered into a brand new empty database is not a recovery.
//   · create a user. The people are the company's, entered in Administration.
//     A script that can invent an administrator is a backdoor with a --help.
//   · grant a role. It restores a way to sign in as somebody who already has
//     the authority; it does not hand authority to anybody.
//   · quietly re-enable a disabled account. Somebody disabled it on purpose.
//     --enable says so out loud.
//   · take the password on stdin from a pipe, or generate one. The operator
//     chooses it and knows what they chose.
//
// It writes to purchase_activity_log, because a credential changed outside the
// application is precisely the event somebody should be able to find later.
// ---------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { randomBytes, scryptSync, randomUUID } from 'node:crypto';

// The same parameters as apps/purchasing/.../auth/local-auth.ts, which is the
// module that has to verify what this writes. They are repeated rather than
// imported because this is a plain script that must run on a server against a
// database, with no application build present. `eval-auth-recovery.mjs` signs
// in through local-auth with a password written here, so the day these drift
// apart is the day that eval fails.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD = 12;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function fail(message, ...detail) {
  console.error(`pcc-reset-admin: ${message}`);
  for (const line of detail) console.error(`  ${line}`);
  console.error('Nothing has been changed.');
  process.exit(1);
}

const dbPath = arg('db') ?? process.env.PCC_DATABASE_PATH ?? process.env.PURCHASING_DB_PATH ?? null;
if (!dbPath) {
  fail('no database given.', 'Pass --db /data/pcc.sqlite, or set PCC_DATABASE_PATH.');
}
// OPEN, NEVER CREATE. node:sqlite creates on open by default, and a typo in a
// path would otherwise produce a new empty database with a working
// administrator in it — an installation that looks recovered and contains
// nothing. The existence check is the whole guard.
if (!existsSync(dbPath)) {
  fail(
    `no database at ${dbPath}.`,
    'This command recovers access to an EXISTING installation; it will not create one.',
    'Check the path against PCC_DATABASE_PATH in the service environment file.',
  );
}

// EVERY DATABASE CALL GOES THROUGH HERE, INCLUDING THE READS.
//
// Found by running the documented Docker command against a volume whose data
// DIRECTORY was owned by root while the database file was owned by uid 1000:
// the very first SELECT died with `attempt to write a readonly database` and a
// raw stack trace. The store runs in WAL mode, where even a read may have to
// create the `-wal` and `-shm` files beside the database — so a directory this
// user cannot write into fails on a read, which is not a sentence anybody
// should have to work out from a Node stack at 7am.
function attempt(what, fn) {
  try {
    return fn();
  } catch (error) {
    if (/readonly|unable to open|permission|SQLITE_CANTOPEN|attempt to write/i.test(error.message)) {
      fail(
        `${what}: ${error.message}`,
        `The database and the DIRECTORY holding it must both be writable by this user (uid ${
          typeof process.getuid === 'function' ? process.getuid() : 'unknown'
        }).`,
        'SQLite keeps a -wal and a -shm file beside the database, so even reading can need to create them.',
        'On the VM:   sudo chown -R 1000:1000 /var/lib/pcc',
        'In Docker:   run with --user 1000:1000 against the same volume PCC uses.',
      );
    }
    fail(`${what}: ${error.message}`);
  }
}

const db = attempt(`could not open ${dbPath}`, () => new DatabaseSync(dbPath));

const admins = attempt('could not read the users table', () =>
  db
    .prepare(
      `select u.id, u.email, u.full_name, u.is_active,
              coalesce(i.disabled, -1) as disabled
         from users u
         join user_roles r on r.user_id = u.id and r.role_key = 'ADMIN'
         left join auth_identities i on i.user_id = u.id
        order by u.email`,
    )
    .all(),
);

const describe = (row) =>
  `  ${row.email.padEnd(34)} ${row.full_name}` +
  (row.disabled === -1 ? '   [no password set]' : row.disabled === 1 ? '   [sign-in disabled]' : '') +
  (row.is_active === 0 ? '   [user deactivated]' : '');

if (flag('list')) {
  console.log(`pcc-reset-admin: administrators in ${dbPath}`);
  if (!admins.length) console.log('  (none — this database has no user holding the ADMIN role)');
  for (const row of admins) console.log(describe(row));
  process.exit(0);
}

const email = (arg('email') ?? '').trim();
const password = arg('password') ?? '';

if (!email) fail('no --email given.', 'Run with --list to see the administrators in this database.');
if (!password) fail('no --password given.');
if (password.length < MIN_PASSWORD) {
  fail(`the new password is ${password.length} characters; ${MIN_PASSWORD} is the minimum.`);
}

const user = db
  .prepare('select id, org_id, email, full_name, is_active from users where lower(email) = lower(?)')
  .get(email);

if (!user) {
  console.error(`pcc-reset-admin: no user with the address ${email}.`);
  console.error('  This command does not create people. The administrators in this database are:');
  if (!admins.length) console.error('    (none — no user holds the ADMIN role)');
  for (const row of admins) console.error(`  ${describe(row)}`);
  console.error('Nothing has been changed.');
  process.exit(1);
}

const roles = db
  .prepare('select role_key from user_roles where user_id = ? order by role_key')
  .all(user.id)
  .map((r) => r.role_key);

const identity = db.prepare('select disabled from auth_identities where user_id = ?').get(user.id);
const blocked = [];
if (user.is_active === 0) blocked.push('the user is deactivated');
if (identity && identity.disabled === 1) blocked.push('sign-in is disabled for this identity');
if (blocked.length && !flag('enable')) {
  fail(
    `${email} cannot sign in for another reason: ${blocked.join(', ')}.`,
    'Somebody turned this account off deliberately. Setting a password would not let them in,',
    'and turning it back on is a separate decision — pass --enable to make it.',
  );
}

const now = new Date().toISOString();
const salt = randomBytes(16).toString('hex');
const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');

try {
  db.exec('begin immediate');

  if (identity) {
    db.prepare(
      `update auth_identities
          set password_hash = ?, salt = ?, reset_token = null, reset_expires_at = null, updated_at = ?
        where user_id = ?`,
    ).run(hash, salt, now, user.id);
  } else {
    db.prepare(
      `insert into auth_identities (user_id, email, password_hash, salt, disabled, created_at, updated_at)
       values (?,?,?,?,0,?,?)`,
    ).run(user.id, user.email, hash, salt, now, now);
  }

  if (flag('enable')) {
    db.prepare('update auth_identities set disabled = 0, updated_at = ? where user_id = ?').run(now, user.id);
    db.prepare('update users set is_active = 1, updated_at = ? where id = ?').run(now, user.id);
  }

  // The audit trail. A credential changed from outside the application is the
  // event most worth finding later, and the row says it came from here rather
  // than from a person clicking Reset access. The password is not in it.
  const seq = db
    .prepare('select coalesce(max(seq), 0) as m from purchase_activity_log where request_id is null')
    .get();
  db.prepare(
    `insert into purchase_activity_log
       (id, org_id, request_id, actor_id, actor_name, action, entity_type, entity_id,
        previous_values, new_values, notes, at, seq)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(),
    user.org_id,
    null,
    null,
    'server operator',
    'auth.credentials_reset_out_of_band',
    'auth_identity',
    user.id,
    null,
    null,
    `pcc-reset-admin.mjs set a new password for ${user.email}` + (flag('enable') ? ', and re-enabled the account' : ''),
    now,
    Number(seq?.m ?? 0) + 1,
  );

  db.exec('commit');
} catch (error) {
  try {
    db.exec('rollback');
  } catch {
    /* the transaction is already gone */
  }
  // Same diagnosis as the reads: a permission problem here is a permission
  // problem on the data directory, and saying so is the difference between a
  // one-line fix and a phone call.
  attempt('the change was rolled back', () => {
    throw error;
  });
}

console.log(`pcc-reset-admin: set a new password for ${user.email} (${user.full_name}).`);
console.log(`  roles: ${roles.length ? roles.join(', ') : 'none'}`);
if (!roles.includes('ADMIN')) {
  console.log('  NOTE: this account does NOT hold the ADMIN role, so it cannot reach Administration.');
  console.log('        Run with --list to see who does.');
}
if (flag('enable')) console.log('  the account was re-enabled.');
console.log('  Sign in with it now, and change the password from inside the application.');
