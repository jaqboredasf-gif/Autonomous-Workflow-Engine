// ---------------------------------------------------------------------------
// eval-purchasing-supabase-web.mjs — the WEBSITE, running on Supabase
// persistence, exercised the way a browser exercises it.
//
// Everything here goes over HTTP against a running dev server. No module is
// imported from the app, no repository is called directly, no privileged client
// is constructed. If a check passes here, it passes for a person with a browser.
//
// What it is trying to disprove:
//   * that a signed-in user of one organization can see another's data
//   * that an unauthenticated request reaches a workspace
//   * that a suspended membership keeps working
//   * that sending someone else's org identifier changes what you get
//   * that an expired or forged session is honoured
//   * that the service role key reaches the browser
//
// Requires: the local Supabase stack, the fixture from
// provision-local-tenants.mjs, and the dev server started with
// PURCHASING_PERSISTENCE=supabase.
// ---------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';

const BASE = process.env.ACCEPTANCE_BASE_URL ?? 'http://localhost:3100';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = 'pilot-password-9137';

/**
 * A page whose HTML contains the tenant's marker vendor.
 *
 * The marker is how every cross-tenant check below tells whose data came back,
 * so it has to be a page that actually renders vendors. It carries a query
 * string already, which is why the forged-parameter URLs append with `&`.
 */
const MARKER_PAGE = '/admin?module=vendors';

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// --- a browser, more or less -----------------------------------------------
// Keeps a cookie jar, follows nothing automatically, so a redirect is visible
// as a redirect rather than silently becoming its destination.
function browser() {
  const jar = new Map();
  return {
    jar,
    cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    async go(path, init = {}) {
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        redirect: 'manual',
        headers: {
          ...(init.headers ?? {}),
          ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        },
      });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (value === '' || /expires=Thu, 01 Jan 1970/i.test(raw)) jar.delete(name);
        else jar.set(name, value);
      }
      const body = await res.text();
      return { status: res.status, location: res.headers.get('location'), body, headers: res.headers };
    },
  };
}

// --- submitting a form the way a browser without JS submits it ------------
// Next renders server actions as real multipart forms with hidden fields for
// progressive enhancement. Scraping those fields and posting them IS the
// no-JavaScript path a browser takes — not a test-only backdoor.
function hiddenFields(html, formIndex = 0) {
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
  const form = forms[formIndex] ?? html;
  const fields = [];
  for (const m of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(m[0])?.[1];
    const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? '';
    if (name) fields.push([decodeEntities(name), decodeEntities(value)]);
  }
  return fields;
}

function decodeEntities(v) {
  return v.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function multipart(fields) {
  const boundary = '----purchasingacceptance7f3a91';
  let body = '';
  for (const [name, value] of fields) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return { boundary, body };
}

/** Index of the form whose markup contains `needle` (e.g. its button label). */
function formContaining(html, needle) {
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
  const idx = forms.findIndex((f) => f.includes(needle));
  return idx < 0 ? 0 : idx;
}

async function submitForm(b, path, extra, formIndex = 0) {
  const page = await b.go(path);
  const fields = [...hiddenFields(page.body, formIndex), ...extra];
  const { boundary, body } = multipart(fields);
  return b.go(path, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

async function signIn(b, email, password = PASSWORD) {
  return submitForm(b, '/sign-in', [['email', email], ['password', password]]);
}

const admin = SERVICE ? createClient(SUPA, SERVICE, { auth: { persistSession: false } }) : null;

// ---------------------------------------------------------------------------
console.log('SUPABASE WEB ACCEPTANCE\n');

// 1. Unauthenticated requests never reach a workspace.
{
  const b = browser();
  for (const path of ['/requests', '/office', '/admin', '/accounting', '/workshop']) {
    const res = await b.go(path);
    const bounced = res.status >= 300 && res.status < 400 && /sign-in|session-expired/.test(res.location ?? '');
    check(`unauthenticated ${path} is refused`, bounced, `status ${res.status} -> ${res.location}`);
  }
}

// 2. Sign-in works against Supabase Auth, and lands somewhere real.
const lippolis = browser();
{
  const res = await signIn(lippolis, 'admin@lippolis.test');
  const ok = res.status >= 300 && res.status < 400 && !/sign-in/.test(res.location ?? '');
  check('sign-in with correct credentials succeeds', ok, `status ${res.status} -> ${res.location}`);
  check('sign-in sets an identity cookie', lippolis.jar.has('purchasing_session') || lippolis.jar.has('purchasing_uid'),
    `cookies: ${[...lippolis.jar.keys()].join(',')}`);
  check('sign-in sets the access token cookie', lippolis.jar.has('purchasing_at'),
    `cookies: ${[...lippolis.jar.keys()].join(',')}`);
}

// 3 & 4. Both failure modes are refused, and are INDISTINGUISHABLE. Comparing
// the two rendered messages is the real test: a check for suspicious words
// tells you nothing (an earlier version of this file matched the Tailwind class
// `disabled:opacity-60` and reported a leak). If the wrong password and the
// unknown address produce the same message, the form cannot be used to
// enumerate who has an account.
const errorText = (html) => {
  const m = /role="alert"[^>]*>([\s\S]*?)<\/(?:p|div|span)>/.exec(html);
  return (m?.[1] ?? '').replace(/<[^>]*>/g, '').trim();
};
{
  const wrongPassword = browser();
  const wrongRes = await signIn(wrongPassword, 'admin@lippolis.test', 'not-the-password');
  check('wrong password is refused', !wrongPassword.jar.has('purchasing_at'));

  const unknown = browser();
  const unknownRes = await signIn(unknown, 'nobody@nowhere.test');
  check('unknown address is refused', !unknown.jar.has('purchasing_at'));

  const a = errorText(wrongRes.body);
  const b2 = errorText(unknownRes.body);
  check('the sign-in form reports an error at all', a.length > 0, 'no alert text was rendered');
  check('a wrong password and an unknown address are indistinguishable', a === b2,
    `"${a}" vs "${b2}"`);
  check('the message names no account state', !/\bdisabled\b|\bsuspended\b|no such|not found/i.test(a),
    `message was "${a}"`);
}

// 5. The signed-in user reaches their own workspace and sees their own data.
//
// MARKER_PAGE is a page that actually RENDERS the marker vendor. /admin alone
// no longer does: it became tabbed, and its default module is Users, so every
// check below that looks for a marker was passing or failing on whether an
// unrelated tab happened to contain the string. A leak check that cannot see
// either tenant's data proves nothing about leaks.
{
  const res = await lippolis.go(MARKER_PAGE);
  check('signed-in user reaches a workspace', res.status === 200, `status ${res.status}`);
  check('workspace shows this tenant\'s marker', res.body.includes('LIPPOLIS-ONLY-VENDOR'),
    'the Lippolis marker vendor was not rendered');
  check('workspace shows NO other tenant\'s marker', !res.body.includes('NORTHGATE-ONLY-VENDOR'),
    'CROSS-TENANT LEAK: Northgate data rendered in a Lippolis session');
}

// 6. The second tenant, in a separate browser, sees the mirror image.
const northgate = browser();
{
  await signIn(northgate, 'admin@northgate.test');
  const res = await northgate.go(MARKER_PAGE);
  check('second tenant reaches their workspace', res.status === 200, `status ${res.status}`);
  check('second tenant sees their own marker', res.body.includes('NORTHGATE-ONLY-VENDOR'));
  check('second tenant sees NO Lippolis marker', !res.body.includes('LIPPOLIS-ONLY-VENDOR'),
    'CROSS-TENANT LEAK: Lippolis data rendered in a Northgate session');
}

// 7. A fabricated org identifier changes nothing. The organization comes from
//    membership; anything the browser sends is decoration.
if (admin) {
  const { data: orgs } = await admin.from('orgs').select('id, name');
  const northgateOrg = (orgs ?? []).find((o) => /northgate/i.test(o.name))?.id;
  const forged = [
    `${MARKER_PAGE}&org_id=${northgateOrg}`,
    `${MARKER_PAGE}&orgId=${northgateOrg}`,
    `${MARKER_PAGE}&org_id=00000000-0000-0000-0000-000000000000`,
  ];
  for (const path of forged) {
    const res = await lippolis.go(path);
    const leaked = res.body.includes('NORTHGATE-ONLY-VENDOR');
    check(`fabricated org identifier is ignored (${path.split('?')[1]})`, !leaked,
      'CROSS-TENANT LEAK: a client-supplied org identifier changed what was returned');
    // ...and the page still WORKED. Without this, an unrelated 500 would make
    // the leak check pass for the wrong reason.
    check(`fabricated org identifier still renders the caller's own tenant (${path.split('?')[1]})`,
      res.status === 200 && res.body.includes('LIPPOLIS-ONLY-VENDOR'),
      `status ${res.status}`);
  }
  // The same claim, in a header — some frameworks read these.
  const res = await lippolis.go(MARKER_PAGE, { headers: { 'x-org-id': northgateOrg ?? '' } });
  check('fabricated org header is ignored', !res.body.includes('NORTHGATE-ONLY-VENDOR'),
    'CROSS-TENANT LEAK: an org header changed what was returned');
}

// 8. Another tenant's access token in the cookie yields THEIR data, never a
//    mixture. This is the check that would catch an org resolved from the
//    signed identity cookie while queries ran under a different token.
{
  const anonClient = createClient(SUPA, ANON, { auth: { persistSession: false } });
  const { data } = await anonClient.auth.signInWithPassword({
    email: 'admin@northgate.test', password: PASSWORD,
  });
  const northgateToken = data?.session?.access_token;
  if (northgateToken) {
    const mixed = browser();
    for (const [k, v] of lippolis.jar) mixed.jar.set(k, v);   // Lippolis identity cookie
    mixed.jar.set('purchasing_at', northgateToken);            // Northgate token
    const res = await mixed.go(MARKER_PAGE);
    const leaked = res.body.includes('LIPPOLIS-ONLY-VENDOR');
    check('a swapped token cannot read the cookie-claimed tenant', !leaked,
      'CROSS-TENANT LEAK: identity came from the cookie while the token said otherwise');
    // The token decides, so the only acceptable outcomes are "Northgate's data"
    // or "refused" — never a Lippolis page, and never a mixture of the two.
    const coherent = res.status !== 200 || res.body.includes('NORTHGATE-ONLY-VENDOR');
    check('a swapped token yields that token\'s tenant, not a mixture', coherent,
      `status ${res.status}, neither tenant's marker present`);
  } else {
    check('could obtain a second tenant token for the swap test', false, 'sign-in failed');
  }
}

// 9. A forged or corrupted access token is refused outright.
{
  const b = browser();
  for (const [k, v] of lippolis.jar) b.jar.set(k, v);
  b.jar.set('purchasing_at', 'not.a.real.token');
  const res = await b.go('/admin');
  const refused = (res.status >= 300 && res.status < 400) || res.status >= 400;
  check('a forged access token is refused', refused, `status ${res.status} -> ${res.location}`);
  check('a forged access token renders no tenant data', !res.body.includes('LIPPOLIS-ONLY-VENDOR'));
}

// 10. An EXPIRED token is refused. Signed with the stack's real JWT secret, so
//     this is a genuine well-formed token whose only fault is its expiry.
{
  const secret = process.env.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';
  const { createHmac } = await import('node:crypto');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const { data: users } = admin ? await admin.auth.admin.listUsers({ perPage: 200 }) : { data: null };
  const sub = users?.users?.find((u) => u.email === 'admin@lippolis.test')?.id;
  const past = Math.floor(Date.now() / 1000) - 3600;
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({ sub, role: 'authenticated', aud: 'authenticated', iat: past - 60, exp: past });
  const sig = createHmac('sha256', secret).update(`${head}.${payload}`).digest('base64url');

  const b = browser();
  for (const [k, v] of lippolis.jar) b.jar.set(k, v);
  b.jar.set('purchasing_at', `${head}.${payload}.${sig}`);
  const res = await b.go('/admin');
  const refused = (res.status >= 300 && res.status < 400) || res.status >= 400;
  check('an expired token is refused', refused, `status ${res.status} -> ${res.location}`);
  check('an expired token renders no tenant data', !res.body.includes('LIPPOLIS-ONLY-VENDOR'));
}

// 11. Suspending a membership ends access on the NEXT request, not at cookie
//     expiry. The session cookie is untouched — only Postgres changed.
if (admin) {
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
  const authId = users?.users?.find((u) => u.email === 'admin@northgate.test')?.id;

  const before = await northgate.go('/admin');
  check('membership is active before suspension', before.status === 200, `status ${before.status}`);

  await admin.from('purchasing_org_memberships')
    .update({ status: 'SUSPENDED' }).eq('user_id', authId);

  const after = await northgate.go('/admin');
  const refused = (after.status >= 300 && after.status < 400) || after.status >= 400;
  check('a suspended membership loses access immediately', refused,
    `status ${after.status} -> ${after.location}`);
  check('a suspended membership renders no tenant data',
    !after.body.includes('NORTHGATE-ONLY-VENDOR'));

  await admin.from('purchasing_org_memberships')
    .update({ status: 'ACTIVE' }).eq('user_id', authId);

  const restored = await northgate.go('/admin');
  check('restoring the membership restores access', restored.status === 200, `status ${restored.status}`);
}

// 12. Sign-out actually invalidates. Every credential cookie goes, and the
//     workspace is unreachable afterwards.
{
  const b = browser();
  await signIn(b, 'admin@lippolis.test');
  check('a fresh session works before sign-out', (await b.go('/admin')).status === 200);
  const shell = await b.go('/admin');
  await submitForm(b, '/admin', [], formContaining(shell.body, 'Sign out'));
  check('sign-out clears the access token cookie', !b.jar.has('purchasing_at'),
    `cookies left: ${[...b.jar.keys()].join(',')}`);
  const after = await b.go('/admin');
  const refused = after.status >= 300 && after.status < 400;
  check('the workspace is unreachable after sign-out', refused, `status ${after.status}`);
}

// 13. The service role key never reaches the browser. Checked against what the
//     server actually SENDS — page HTML and every script it references.
{
  const b = browser();
  await signIn(b, 'admin@lippolis.test');
  const page = await b.go('/admin');
  const leaked = (text) => (SERVICE ? text.includes(SERVICE) : false)
    || /service_role/.test(text)
    || /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'][\w.-]+["']/.test(text);

  check('page HTML carries no service role key', !leaked(page.body));

  const scripts = [...page.body.matchAll(/src="(\/_next\/[^"]+\.js)"/g)].map((m) => m[1]);
  let scanned = 0;
  for (const src of scripts.slice(0, 40)) {
    const res = await fetch(`${BASE}${src}`);
    const text = await res.text();
    scanned += 1;
    if (leaked(text)) { check(`client bundle ${src} carries no service role key`, false); break; }
  }
  check(`client bundles carry no service role key (${scanned} scanned)`, scanned > 0 || scripts.length === 0);
}

// ---------------------------------------------------------------------------
console.log(`${passed} checks passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\nSUPABASE WEB ACCEPTANCE: PASS');
