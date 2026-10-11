// ---------------------------------------------------------------------------
// navigation.mjs — what the sidebar offers, and to whom.
//
// PURE. Presentation only: this decides what a person is SHOWN, never what
// they may do. Every destination still passes routeDecision() on the server,
// so hiding an entry is a courtesy and removing one would not be a control.
//
// Deliberately separate from workspaces.mjs. That module answers "where does
// signing in land this person" and its order is load-bearing — the first
// workspace a user holds is their home, and the website acceptance tests pin
// those landings per role. Navigation is a different question with a different
// order, and mixing the two would mean a sidebar reshuffle silently moved
// where everybody lands after sign-in.
// ---------------------------------------------------------------------------

import { hasPermission, WORKSHOP_LOCATION } from './roles.mjs';

/**
 * The sidebar, in groups. `permission` is what the destination requires and
 * matches the ROUTE_GUARDS entry for the same path — if the two ever disagree,
 * the guard wins and the user meets /unauthorized, which is the failure
 * direction to have.
 */
export const NAV_GROUPS = [
  {
    key: 'WORK',
    label: 'Work',
    items: [
      { key: 'DASHBOARD', label: 'Dashboard', path: '/dashboard', permission: 'request.read.all' },
      { key: 'REQUESTS', label: 'Requests', path: '/requests', permission: 'request.read.own' },
      { key: 'PURCHASING', label: 'Purchasing', path: '/workshop', permission: 'review.read_queue' },
      { key: 'RECEIVING', label: 'Receiving', path: '/receiving', permission: 'receiving.record' },
      // The foreman's own list of what is landing on his sites. Held by field
      // users, who do not hold receiving's broader permission.
      { key: 'DELIVERIES', label: 'My deliveries', path: '/deliveries', permission: 'deliveries.confirm' },
      { key: 'OFFICE', label: 'Office', path: '/office', permission: 'request.read.all' },
    ],
  },
  {
    key: 'DIRECTORY',
    label: 'Directory',
    items: [
      { key: 'VENDORS', label: 'Vendors', path: '/vendors', permission: 'request.read.all' },
      { key: 'MATERIALS', label: 'Materials', path: '/materials', permission: 'request.read.all' },
      // The job directory. Read-only here on purpose: jobs are created in
      // Administration today and will come from QuickBooks later, so this is
      // the place to LOOK ONE UP, not a second place to invent one.
      { key: 'JOBS', label: 'Jobs', path: '/jobs', permission: 'request.read.all' },
    ],
  },
  {
    key: 'INSIGHT',
    label: 'Records',
    items: [
      { key: 'REPORTS', label: 'Reports', path: '/reports', permission: 'request.read.all' },
      { key: 'ACCOUNTING', label: 'Accounting', path: '/accounting', permission: 'accounting.read' },
    ],
  },
  {
    key: 'ADMIN',
    label: 'Configure',
    items: [{ key: 'ADMINISTRATION', label: 'Administration', path: '/admin', permission: 'admin.settings' }],
  },
];

/** The groups this user can actually enter. Empty groups are dropped. */
export function navigationFor(user) {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => hasPermission(user, item.permission)),
  })).filter((group) => group.items.length > 0);
}

/** Every destination, flattened — for "is this path in the sidebar" checks. */
export function navigationItemsFor(user) {
  return navigationFor(user).flatMap((g) => g.items);
}

/**
 * Which sidebar entry is current, given a pathname. Longest matching path
 * wins, so /requests/new highlights Requests rather than nothing, and a
 * one-character prefix collision cannot light up the wrong entry.
 */
export function activeNavKey(pathname) {
  const all = NAV_GROUPS.flatMap((g) => g.items);
  const matches = all.filter((item) => pathname === item.path || pathname.startsWith(`${item.path}/`));
  if (matches.length === 0) return null;
  return matches.reduce((best, item) => (item.path.length > best.path.length ? item : best)).key;
}

/**
 * A person's receiving locations, as a sentence fragment they would recognise.
 *
 * The workshop travels as the reserved key `WORKSHOP` (see roles.mjs), which is
 * the right thing for a scope check and the wrong thing to print at somebody:
 * "Your job sites: 24-118, WORKSHOP" reads as a data error. Both indexes say
 * this the same way because they call the same function.
 */
export function describeLocations(locations = []) {
  const names = locations
    .map((l) => String(l).trim())
    .filter(Boolean)
    .map((l) => (l === WORKSHOP_LOCATION ? 'the workshop' : `job ${l}`));
  if (names.length === 0) return 'nothing yet';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
