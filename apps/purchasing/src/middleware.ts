// ---------------------------------------------------------------------------
// middleware.ts — the coarse gate in front of every route.
//
// It runs on the edge runtime, so it cannot touch the database. That bounds
// what it is allowed to decide: it verifies the session cookie's SIGNATURE and
// EXPIRY and turns away traffic with neither. It never decides permissions —
// every protected page calls requireAccess() with the real user loaded, and
// that is the authoritative check.
//
// Two layers on purpose: this one keeps unauthenticated traffic off the app
// entirely; the page-level one is the security boundary. A misconfigured
// matcher here is an inconvenience, not a hole.
// ---------------------------------------------------------------------------

import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE, verifySession } from './purchasing/infrastructure/auth/session-token.ts';
import { isPublicRoute } from './purchasing/domain/workspaces.mjs';

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicRoute(pathname)) return NextResponse.next();

  const secret = process.env.SESSION_SECRET ?? 'purchasing-pilot-development-secret-not-for-production';
  const verified = await verifySession(request.cookies.get(SESSION_COOKIE)?.value, secret);

  if (verified.valid) return NextResponse.next();

  // An expired session gets its own landing so the user is told what happened
  // rather than silently dumped at a login form they thought they had passed.
  if (verified.reason === 'expired') {
    return NextResponse.redirect(new URL('/session-expired', request.url));
  }

  const signIn = new URL('/sign-in', request.url);
  if (pathname !== '/') signIn.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(signIn);
}

export const config = {
  // Everything except Next's own assets and the favicon. API routes ARE matched:
  // an unauthenticated fetch of a document should be turned away too.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
