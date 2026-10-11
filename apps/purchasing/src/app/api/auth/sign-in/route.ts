// POST /api/auth/sign-in — the same sign-in the form uses, over JSON.
//
// It exists so something other than a browser form can authenticate: the
// acceptance suite drives it, and a future mobile client would too. It shares
// signIn() with the form, so there is ONE credential path and one place where a
// session is minted — a second implementation is how the two drift and one of
// them forgets a check.
//
// It reports the same coarse errors as the form: a wrong password and an
// unknown address are both 401 `invalid_credentials`.
import { NextResponse } from 'next/server';

import { signIn } from '../../../../server/session.ts';
import { log } from '../../../../purchasing/infrastructure/logging.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: { email?: string; password?: string; next?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  // The client address, as the proxy reports it. `x-forwarded-for` is
  // spoofable by a direct caller, which is why it is only ever used to WIDEN a
  // restriction (one more bucket to fill), never to lift one — a forged header
  // buys an attacker a fresh source budget, not an exemption from the per-
  // account limit, which is the one that protects a real person's password.
  const source = request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    ?? request.headers.get('x-real-ip')
    ?? null;

  const result = await signIn(String(body.email ?? ''), String(body.password ?? ''), body.next, source);
  if (result.ok) {
    log.info('auth.sign_in', { email: body.email, channel: 'api', outcome: 'success' });
    return NextResponse.json({ ok: true, redirectTo: result.redirectTo });
  }

  log.warn('auth.sign_in_failed', { email: body.email, channel: 'api', reason: result.error });

  if (result.error === 'too_many_attempts') {
    const retryAfter = result.retryAfterSeconds ?? 900;
    return NextResponse.json(
      { ok: false, error: 'too_many_attempts', retryAfterSeconds: retryAfter },
      { status: 429, headers: { 'retry-after': String(retryAfter) } },
    );
  }

  const status = result.error === 'account_disabled' ? 403 : result.error === 'unavailable' ? 503 : 401;
  return NextResponse.json({ ok: false, error: result.error }, { status });
}
