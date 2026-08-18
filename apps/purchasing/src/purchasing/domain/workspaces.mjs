// ---------------------------------------------------------------------------
// workspaces.mjs — which part of the website a person belongs in.
//
// PURE. A workspace is a named area of the one shared website, not a separate
// application: everybody signs in at the same door and lands where their roles
// put them. This module answers three questions and nothing else:
//
//   defaultWorkspaceFor(user)   — where does sign-in send them?
//   workspacesFor(user)         — what can they switch between?
//   guardFor(pathname)          — what does THIS url require?
//
// The last one is the important one. Route protection reads from this table, so
// "can I open /workshop" has exactly one answer, and knowing the URL is not it.
// ---------------------------------------------------------------------------

import { hasPermission } from './roles.mjs';

/**
 * The workspaces, in priority order — the first one a user can enter is where
 * they land after signing in.
 *
 * `permission` is what the workspace requires. `label` is what the switcher
 * shows. `path` is the route.
 */
export const WORKSPACES = [
  {
    key: 'ADMIN',
    path: '/admin',
    label: 'Administration',
    permission: 'admin.settings',
    description: 'Users, roles, vendors, PO numbering, audit.',
  },
  {
    key: 'WORKSHOP',
    path: '/workshop',
    label: 'Workshop queue',
    permission: 'review.read_queue',
    description: 'Review, decide, order and receive.',
  },
  {
    key: 'ACCOUNTING',
    path: '/accounting',
    label: 'Accounting',
    permission: 'accounting.read',
    description: 'Receipt evidence and accounting-ready packets.',
  },
  {
    key: 'OFFICE',
    path: '/office',
    label: 'Office',
    permission: 'request.read.all',
    description: 'All active orders, tracking and receiving.',
  },
  {
    key: 'FIELD',
    path: '/my-requests',
    label: 'My requests',
    permission: 'request.read.own',
    description: 'Raise a request and follow it.',
  },
  {
    key: 'DELIVERIES',
    path: '/deliveries',
    label: 'Deliveries',
    permission: 'deliveries.confirm',
    description: 'Confirm what arrived on your job sites.',
  },
];

export function workspacesFor(user) {
  return WORKSPACES.filter((w) => hasPermission(user, w.permission));
}

/**
 * Where a person lands after signing in. Falls back to /my-requests: a user who
 * somehow holds no workspace permission still sees their own requests rather
 * than a dead end. A user with no roles at all gets /unauthorized.
 */
export function defaultWorkspaceFor(user) {
  const available = workspacesFor(user);
  if (available.length === 0) return '/unauthorized';
  return available[0].path;
}

/**
 * WHERE "HOME" IS — what the brand mark returns you to.
 *
 * The logo used to link to `/`, which redirects to the DEFAULT WORKSPACE: an
 * admin landed on Administration, a foreman on My requests. Nobody ever reached
 * the dashboard by clicking the logo, which is the one thing a logo in the top
 * left is universally expected to do.
 *
 * It is not a constant, because `/dashboard` aggregates the whole
 * organization's purchasing and is guarded by `request.read.all`. Pointing a
 * requester's logo at it would send them to /unauthorized every time they
 * clicked it — a broken affordance in the most-clicked spot on the screen. So
 * home is the dashboard for whoever may open it, and their own landing place
 * otherwise.
 *
 * Deliberately NOT the same thing as defaultWorkspaceFor(): where sign-in sends
 * you is a question about your job, and it stays as it is. This is only where
 * "back to the start" goes.
 */
export function homeFor(user) {
  return hasPermission(user, 'request.read.all') ? '/dashboard' : defaultWorkspaceFor(user);
}

export function workspaceForPath(pathname) {
  return WORKSPACES.find((w) => pathname === w.path || pathname.startsWith(`${w.path}/`)) ?? null;
}

// ---------------------------------------------------------------------------
// Route guards. Every non-public route in the application appears here, most
// specific first. A route that is not listed is DENIED to signed-in users by
// default (fail closed) — adding a page means declaring who it is for.
// ---------------------------------------------------------------------------

/** Routes anyone may reach, signed in or not. */
export const PUBLIC_ROUTES = [
  '/sign-in',
  '/forgot-password',
  '/reset-password',
  '/session-expired',
  '/unauthorized',
  '/api/health',
  '/api/auth/sign-in',
];

/**
 * THE ONLY PLACES A PERSON HOLDING A PASSWORD SOMEBODY ELSE CHOSE MAY GO.
 *
 * Deliberately three, and deliberately not `/unauthorized` or the workspace
 * they would otherwise land on: the point is that the account does nothing
 * until the password is replaced, and every extra exit is a way to put it off.
 *
 * `/change-password` is the way out. Sign-out is always allowed — trapping
 * somebody in a screen they cannot leave produces a phone call, not a password
 * change. The root only redirects, and redirecting it here is what stops the
 * default workspace from being a way around this.
 */
export const PASSWORD_CHANGE_ROUTES = ['/change-password', '/api/auth/sign-out', '/'];

export const ROUTE_GUARDS = [
  // Reachable by anyone signed in, whether or not they are being made to change
  // it: a person may replace a password they already chose, and forcing a
  // change on somebody doing it voluntarily would be nonsense.
  { prefix: '/change-password', permission: null },
  { prefix: '/admin', permission: 'admin.settings' },
  { prefix: '/workshop', permission: 'review.read_queue' },
  { prefix: '/accounting', permission: 'accounting.read' },
  { prefix: '/office', permission: 'request.read.all' },
  { prefix: '/deliveries', permission: 'deliveries.confirm' },
  // The management surfaces. `request.read.all` is the honest requirement for
  // all four: each one aggregates across the whole organization's purchasing,
  // so a user who may only see their own requests must not open them.
  { prefix: '/dashboard', permission: 'request.read.all' },
  { prefix: '/vendors', permission: 'request.read.all' },
  { prefix: '/materials', permission: 'request.read.all' },
  { prefix: '/jobs', permission: 'request.read.all' },
  { prefix: '/reports', permission: 'request.read.all' },
  // Receiving is the workspace behind screen 06. It is guarded by the
  // permission that RECORDS a receipt rather than by `deliveries.confirm`,
  // which is the field-only grant: purchasing staff receive at the shop
  // counter and hold `receiving.record` without holding the other. Which
  // requests each of them may actually touch is still decided per record by
  // authorize(), where the job assignment is known.
  { prefix: '/receiving', permission: 'receiving.record' },
  { prefix: '/my-requests', permission: 'request.read.own' },
  { prefix: '/notifications', permission: 'request.read.own' },
  // Entity routes: reachable by anyone who may read a request; the record-level
  // check (is it YOURS, is it your org's) happens in the use case, because only
  // it knows the record.
  { prefix: '/requests', permission: 'request.read.own' },
  { prefix: '/purchase-orders', permission: 'request.read.own' },
  { prefix: '/email-drafts', permission: 'email.draft' },
  { prefix: '/receipts', permission: 'request.read.own' },
  { prefix: '/api/documents', permission: 'request.read.own' },
  // Material autocomplete. Everyone who may RAISE a request may ask what the
  // organization already buys — that is the point of the suggestion.
  { prefix: '/api/materials', permission: 'request.create' },
  { prefix: '/api/auth', permission: null },
  { prefix: '/', permission: null }, // the root only redirects; it shows nothing
];

export function isPublicRoute(pathname) {
  return PUBLIC_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * What this URL requires. Returns {permission} or null when the route is
 * unknown — an unknown route is not a licence, it is a 404 for the router and a
 * refusal for us.
 */
export function guardFor(pathname) {
  if (pathname === '/') return { permission: null };
  return ROUTE_GUARDS.find((g) => g.prefix !== '/' && (pathname === g.prefix || pathname.startsWith(`${g.prefix}/`))) ?? null;
}

/**
 * THE route decision. Used by the middleware and again by every page, because a
 * middleware can be misconfigured and a page cannot afford to assume.
 *
 * @returns {{allow: true} | {allow: false, redirect: string, reason: string}}
 */
export function routeDecision(user, pathname) {
  if (isPublicRoute(pathname)) return { allow: true };
  if (!user) return { allow: false, redirect: '/sign-in', reason: 'no_session' };
  if (user.isActive === false) return { allow: false, redirect: '/sign-in?error=account_disabled', reason: 'account_disabled' };

  // A PASSWORD SOMEBODY ELSE CHOSE OPENS NOTHING BUT THE SCREEN THAT REPLACES IT.
  //
  // Checked BEFORE the permission guard, so it applies to every route including
  // the ones the person is otherwise entitled to, and checked here rather than
  // in a page or a layout so that server actions and API routes are covered by
  // the same sentence. The flag is read from the credential store on every
  // request, so an administrator's reset takes hold on the account's next move
  // rather than whenever its cookie happens to expire.
  if (user.mustChangePassword && !PASSWORD_CHANGE_ROUTES.includes(pathname)) {
    return { allow: false, redirect: '/change-password', reason: 'must_change_password' };
  }

  const guard = guardFor(pathname);
  if (!guard) return { allow: false, redirect: '/unauthorized', reason: 'unknown_route' };
  if (guard.permission === null) return { allow: true };
  if (!hasPermission(user, guard.permission)) {
    return { allow: false, redirect: '/unauthorized', reason: 'missing_permission' };
  }
  return { allow: true };
}
