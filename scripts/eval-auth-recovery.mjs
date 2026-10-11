// ---------------------------------------------------------------------------
// eval-auth-recovery.mjs — the two ways back into PCC, and the way that was
// open to strangers.
//
// THE DEFECT THIS SUITE EXISTS TO KEEP CLOSED. `/forgot-password` is a public
// page. The local credential provider used to mint a 30-minute reset token on
// any request and hand it back to the caller, and the page printed it. So
// anybody who could reach the sign-in form could type the administrator's
// address and read a live credential for their account — and, because the
// token came back ONLY when the address existed, could also enumerate who has
// an account here, which is the exact question the uniform sign-in failure
// message is written to refuse.
//
// It was invisible to every existing suite: the only assertion anywhere near
// it was that the page returns 200.
//
// So this suite asks the three questions that matter, and one of them is asked
// of the SOURCE rather than of behaviour, because "the token is not on the
// screen" has to survive somebody helpfully putting it back:
//
//   1. the provider issues nothing, writes nothing, and answers a real address
//      exactly as it answers an invented one
//   2. the state returned to an unauthenticated browser has nowhere to put a
//      token, and neither the action nor the page mentions one
//   3. an installation nobody can sign into can be recovered ON THE SERVER,
//      by the operator, without a developer — and the recovery command refuses
//      every shortcut that would make it a backdoor
//
// Offline: a temp SQLite database, the modules the app ships, and the script
// run as a child process the way an operator runs it.
// ---------------------------------------------------------------------------

import { readFileSync, mkdtempSync, rmSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP = join(ROOT, 'apps', 'purchasing', 'src');

let pass = 0;
const fails = [];
const ok = (cond, name, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fails.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return cond;
};

const TMP = mkdtempSync(join(tmpdir(), 'pcc-auth-recovery-'));
const DB_PATH = join(TMP, 'recovery.db');

const { openDatabase } = await import(join(APP, 'purchasing', 'infrastructure', 'sqlite', 'database.ts'));
const { seed } = await import(join(APP, 'purchasing', 'infrastructure', 'seed.ts'));
const { localAuthAdapter, verifyPassword } = await import(
  join(APP, 'purchasing', 'infrastructure', 'auth', 'local-auth.ts')
);

const db = openDatabase(DB_PATH);
seed(db, '2026-08-18T09:00:00.000Z');
const auth = localAuthAdapter(db);

const ADMIN = db.prepare(
  `select u.email from users u join user_roles r on r.user_id = u.id and r.role_key = 'ADMIN' limit 1`,
).get().email;

// ---------------------------------------------------------------------------
console.log('--- what an anonymous forgot-password request may learn ----------');

const real = await auth.requestPasswordReset(ADMIN);
const invented = await auth.requestPasswordReset('nobody@nowhere.invalid');

ok(real.token === undefined, 'a real address gets no reset token back',
   real.token ? `it returned ${String(real.token).slice(0, 8)}…` : '');
ok(invented.token === undefined, 'an invented address gets no reset token back');
ok(JSON.stringify(real) === JSON.stringify(invented),
   'the two answers are identical, so the reply is not an account oracle',
   `real=${JSON.stringify(real)} invented=${JSON.stringify(invented)}`);

const tokenRows = db.prepare('select count(*) as n from auth_identities where reset_token is not null').get();
ok(tokenRows.n === 0, 'and nothing was written: no live reset token exists in the database',
   `${tokenRows.n} identity row(s) carry one`);

// The reset path itself is left intact for a token issued deliberately one day.
// Nothing issues one today, so the only thing to prove is that a guess fails.
const guessed = await auth.resetPassword('11111111-2222-3333-4444-555555555555', 'a new long password');
ok(guessed.ok === false && guessed.reason === 'invalid_token', 'a made-up reset token is refused');

// ---------------------------------------------------------------------------
console.log('--- the source, so the token cannot be put back by accident ------');

const actionSrc = readFileSync(join(APP, 'app', 'auth-actions.ts'), 'utf8');
const pageSrc = readFileSync(join(APP, 'app', 'forgot-password', 'page.tsx'), 'utf8');
// The whole declaration, to the end of its line — NOT `[^;]*;`, which stops at
// the first semicolon INSIDE the object and would read `{ sent: boolean;` as
// the entire type. That version of this check passed against the defective
// code, which is the only kind of check worth deleting.
const forgotState = /export type ForgotPasswordState =.*$/m.exec(actionSrc)?.[0] ?? '';

ok(forgotState !== '', 'ForgotPasswordState is declared where this check can read it');
ok(!/\btoken\b/.test(forgotState),
   'the state returned to an anonymous browser has no token field', forgotState.trim());
ok(!/result\.token|\.token\s*\?\?/.test(actionSrc),
   'the forgot-password action never reads a token off the provider result');
ok(!/state\.token|state\?\.token/.test(pageSrc),
   'the forgot-password page never renders a token');

const providerSrc = readFileSync(
  join(APP, 'purchasing', 'infrastructure', 'auth', 'local-auth.ts'), 'utf8',
);
const requestFn = /async requestPasswordReset\([\s\S]*?\n    },/.exec(providerSrc)?.[0] ?? '';
ok(requestFn !== '', 'the provider\'s requestPasswordReset is where this check can read it');
ok(!/update auth_identities set reset_token/.test(requestFn),
   'and it writes no reset token');

// ---------------------------------------------------------------------------
console.log('--- recovering an installation nobody can sign into --------------');

const SCRIPT = join(ROOT, 'scripts', 'pcc-reset-admin.mjs');
const NEW_PASSWORD = 'a new long operator password';

const run = (args) => {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

// Lock the door: this is the state an installation is in when the bootstrap
// password has been removed from the environment and forgotten.
db.prepare('update auth_identities set password_hash = ?, salt = ? where email = ?')
  .run('f'.repeat(128), 'deadbeefdeadbeefdeadbeefdeadbeef', ADMIN);
const lockedOut = await auth.signIn(ADMIN, NEW_PASSWORD);
ok(lockedOut.ok === false, 'the administrator cannot sign in — this is the situation');

const missingDb = run(['--db', join(TMP, 'not-here.db'), '--email', ADMIN, '--password', NEW_PASSWORD]);
ok(missingDb.code === 1 && /will not create one/.test(missingDb.out),
   'it refuses a database path that does not exist, rather than creating one');
ok(!existsSync(join(TMP, 'not-here.db')), 'and no database file was created by the attempt');

// A DIRECTORY THIS USER CANNOT WRITE INTO, which is what a Docker volume
// mounted with the wrong ownership looks like. The store runs in WAL mode, so
// even the first SELECT has to be able to create files beside the database —
// found the hard way, as a raw Node stack trace, running the command this suite
// now covers. An operator gets a diagnosis and the chown that fixes it.
const LOCKED = mkdtempSync(join(tmpdir(), 'pcc-auth-locked-'));
const LOCKED_DB = join(LOCKED, 'pcc.sqlite');
copyFileSync(DB_PATH, LOCKED_DB);
chmodSync(LOCKED, 0o500);
const unwritable = run(['--db', LOCKED_DB, '--list']);
chmodSync(LOCKED, 0o700);
ok(unwritable.code === 1, 'an unwritable data directory exits 1 rather than throwing a stack trace',
   unwritable.out.slice(0, 120));
ok(/chown/.test(unwritable.out) && !/at ModuleJob/.test(unwritable.out),
   'and it names the ownership fix instead of printing a Node stack', unwritable.out.slice(0, 200));
rmSync(LOCKED, { recursive: true, force: true });

const noUser = run(['--db', DB_PATH, '--email', 'stranger@nowhere.invalid', '--password', NEW_PASSWORD]);
ok(noUser.code === 1 && /does not create people/.test(noUser.out),
   'it refuses to invent a person, and says who the administrators are');

const weak = run(['--db', DB_PATH, '--email', ADMIN, '--password', 'short']);
ok(weak.code === 1 && /minimum/.test(weak.out), 'it refuses a password shorter than the minimum');

const listed = run(['--db', DB_PATH, '--list']);
ok(listed.code === 0 && listed.out.includes(ADMIN), '--list names the administrators');

const before = db.prepare('select password_hash from auth_identities where email = ?').get(ADMIN).password_hash;
ok(before === 'f'.repeat(128), 'none of those refusals changed a credential');

const reset = run(['--db', DB_PATH, '--email', ADMIN, '--password', NEW_PASSWORD]);
ok(reset.code === 0, 'the reset succeeds', reset.out);
ok(/roles: .*ADMIN/.test(reset.out), 'and it reports the roles the account actually holds');
ok(!reset.out.includes(NEW_PASSWORD), 'without printing the password it just set');

// THE CROSS-CHECK THAT MATTERS: the application itself must accept what the
// script wrote. This is what fails if the two scrypt definitions ever drift.
const recovered = await auth.signIn(ADMIN, NEW_PASSWORD);
ok(recovered.ok === true, 'and the administrator signs in through the application with it');
ok((await auth.signIn(ADMIN, 'the old forgotten password')).ok === false,
   'while the old password does not work');

const identity = db.prepare('select password_hash, salt, reset_token from auth_identities where email = ?').get(ADMIN);
ok(verifyPassword(NEW_PASSWORD, identity.password_hash, identity.salt),
   'the stored credential verifies with the application\'s own scrypt parameters');
ok(identity.reset_token === null, 'and any outstanding reset token was cleared');

const audit = db.prepare(
  `select action, notes from purchase_activity_log where action = 'auth.credentials_reset_out_of_band'`,
).all();
ok(audit.length === 1, 'the out-of-band credential change is in the audit trail');
ok(audit.length === 1 && !audit[0].notes.includes(NEW_PASSWORD),
   'and the audit row does not contain the password');

// A disabled account is a decision somebody made. Restoring a password must not
// quietly undo it.
db.prepare('update auth_identities set disabled = 1 where email = ?').run(ADMIN);
const disabled = run(['--db', DB_PATH, '--email', ADMIN, '--password', NEW_PASSWORD]);
ok(disabled.code === 1 && /deliberately/.test(disabled.out),
   'it refuses a disabled account rather than silently re-enabling it');

const enabled = run(['--db', DB_PATH, '--email', ADMIN, '--password', NEW_PASSWORD, '--enable']);
ok(enabled.code === 0 && /re-enabled/.test(enabled.out), '--enable re-enables it, and says so');
ok((await auth.signIn(ADMIN, NEW_PASSWORD)).ok === true, 'and the account signs in again');

// ---------------------------------------------------------------------------
console.log('--- a password somebody else chose opens nothing else ------------');

const { routeDecision, PASSWORD_CHANGE_ROUTES } = await import(
  join(APP, 'purchasing', 'domain', 'workspaces.mjs')
);
const { identityAdapter } = await import(join(APP, 'purchasing', 'infrastructure', 'adapters.ts'));
const identityPort = identityAdapter(db);

const TEMP_PASSWORD = 'temporary-from-the-office';
const MINE = 'a password only mike knows';

const mike = db.prepare("select id, email from users where email like 'mike%'").get();
ok(Boolean(mike), 'the fixture has a user to act as');

const flagOf = (userId) =>
  Number(db.prepare('select must_change_password from auth_identities where user_id = ?').get(userId)
    ?.must_change_password ?? -1);

// An administrator hands out a password. This is the ONE call every
// administrative path funnels through — invite, reset access, bootstrap.
await auth.setPassword(mike.id, TEMP_PASSWORD);
ok(flagOf(mike.id) === 1, 'an administratively-set password requires a change');

const asMike = await identityPort.load(mike.id);
ok(asMike.mustChangePassword === true, 'and the actor carries it, read from the credential store');

ok((await auth.signIn(mike.email, TEMP_PASSWORD)).ok === true,
   'the temporary password still SIGNS IN — the account is reachable, not locked out');

// Every route a working day is made of.
for (const path of ['/workshop', '/dashboard', '/my-requests', '/requests/new', '/admin',
                    '/receiving', '/api/documents/any-id', '/api/materials/suggest']) {
  const decision = routeDecision(asMike, path);
  ok(decision.allow === false && decision.redirect === '/change-password',
     `${path} is refused and sent to the password screen`, JSON.stringify(decision));
  ok(decision.reason === 'must_change_password', `${path} says why`, decision.reason);
}

// And the few that must still work, or the person is trapped.
for (const path of PASSWORD_CHANGE_ROUTES) {
  ok(routeDecision(asMike, path).allow === true, `${path} stays open — no trap, no redirect loop`);
}
ok(PASSWORD_CHANGE_ROUTES.includes('/change-password'), 'the way out is one of them');
ok(PASSWORD_CHANGE_ROUTES.includes('/api/auth/sign-out'), 'and so is signing out');
ok(routeDecision(asMike, '/sign-in').allow === true, 'public routes are unaffected');

// The refusal must not depend on the ROUTE TABLE knowing about the flag: an
// unknown path is refused for its own reason and must not become an escape.
ok(routeDecision(asMike, '/some/route/nobody/added').allow === false,
   'an unknown route is still refused');

console.log('--- replacing it, and what that clears ---------------------------');

const wrongCurrent = await auth.changeOwnPassword(mike.id, 'not the temporary one', MINE);
ok(wrongCurrent.ok === false && wrongCurrent.reason === 'invalid_credentials',
   'a wrong current password is refused');
ok(flagOf(mike.id) === 1, 'and changes nothing');
ok((await auth.signIn(mike.email, TEMP_PASSWORD)).ok === true, 'the old password still works after a failed attempt');

const tooShort = await auth.changeOwnPassword(mike.id, TEMP_PASSWORD, 'short');
ok(tooShort.ok === false && tooShort.reason === 'weak_password', 'a password under ten characters is refused');

const same = await auth.changeOwnPassword(mike.id, TEMP_PASSWORD, TEMP_PASSWORD);
ok(same.ok === false && same.reason === 'same_password',
   'and "changing" it to the same one is refused — the administrator would still know it');
ok(flagOf(mike.id) === 1, 'neither refusal cleared the requirement');

const changed = await auth.changeOwnPassword(mike.id, TEMP_PASSWORD, MINE);
ok(changed.ok === true, 'the right current password and a new one succeeds');
ok(flagOf(mike.id) === 0, 'the requirement is cleared');
ok((await auth.signIn(mike.email, MINE)).ok === true, 'the new password signs in');
ok((await auth.signIn(mike.email, TEMP_PASSWORD)).ok === false, 'the temporary one no longer does');

const afterwards = await identityPort.load(mike.id);
ok(afterwards.mustChangePassword === false, 'the actor is no longer flagged');
for (const path of ['/workshop', '/my-requests', '/dashboard']) {
  ok(routeDecision(afterwards, path).allow !== false || routeDecision(afterwards, path).reason !== 'must_change_password',
     `${path} is no longer blocked by the password requirement`);
}

// A VOLUNTARY change does not re-arm it: the person chose this one too.
const second = await auth.changeOwnPassword(mike.id, MINE, 'another password mike picked');
ok(second.ok === true && flagOf(mike.id) === 0,
   'changing a password you already chose does not demand another change');

// An administrator resetting access re-arms it.
await auth.setPassword(mike.id, 'the office reset this again');
ok(flagOf(mike.id) === 1, 'an administrator reset requires a change again');

console.log('--- the flag is not something a user can set ---------------------');

// Nothing outside the credential provider may write it. If a server action or
// an API route ever does, this fails — and that is the only way an ordinary
// user could clear it without knowing their current password.
const appSrc = [
  'app/actions.ts', 'app/auth-actions.ts',
  'purchasing/application/administration.ts', 'purchasing/application/requests.ts',
].map((f) => readFileSync(join(APP, f), 'utf8')).join('\n');
// WRITES, not mentions: actions.ts legitimately names `must_change_password`
// as a refusal reason it hands back to the browser. What must not exist above
// the credential provider is a statement that SETS it, or any other route into
// the identity table.
ok(!/must_change_password\s*=\s*[01]/.test(appSrc) && !/into auth_identities/.test(appSrc),
   'no action, route or use case writes must_change_password — only the credential provider does');

const providerSrc2 = readFileSync(join(APP, 'purchasing', 'infrastructure', 'auth', 'local-auth.ts'), 'utf8');
const clears = [...providerSrc2.matchAll(/must_change_password = 0/g)].length;
ok(clears === 1, 'and exactly one statement clears it', `${clears} found`);
ok(/async changeOwnPassword[\s\S]*must_change_password = 0/.test(providerSrc2),
   'that statement is inside changeOwnPassword, which verifies the current password first');

// Requirement: neither password is ever returned or logged.
const authActionsSrc = readFileSync(join(APP, 'app', 'auth-actions.ts'), 'utf8');
const changeFn = /export async function changePasswordAction[\s\S]*?\n}/.exec(authActionsSrc)?.[0] ?? '';
ok(changeFn !== '', 'the change action is where this check can read it');
ok(!/log\.(info|warn|error)\([^)]*(newPassword|currentPassword|confirmPassword)/.test(changeFn),
   'it never logs a password');
ok(!/return \{[^}]*(newPassword|currentPassword)/.test(changeFn), 'and never returns one');
ok(/userId: actor\.id/.test(changeFn), 'what it does log is who, not what');

// ---------------------------------------------------------------------------
db.close();
rmSync(TMP, { recursive: true, force: true });

console.log('');
for (const f of fails) console.log(`FAILED: ${f}`);
console.log(`auth recovery checks: ${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
