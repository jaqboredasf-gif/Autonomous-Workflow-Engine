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

export const ROUTE_GUARDS = [
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

  const guard = guardFor(pathname);
  if (!guard) return { allow: false, redirect: '/unauthorized', reason: 'unknown_route' };
  if (guard.permission === null) return { allow: true };
  if (!hasPermission(user, guard.permission)) {
    return { allow: false, redirect: '/unauthorized', reason: 'missing_permission' };
  }
  return { allow: true };
}
