'use client';
// The chrome: sidebar, topbar, mobile drawer.
//
// A client component for three reasons and no others — the current pathname
// (to mark the active destination), the drawer's open state, and closing that
// drawer on navigation. Everything it renders is handed to it by the server,
// including which destinations this person may see: the browser is never asked
// to work out what somebody is allowed to open.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BrandMark } from './BrandMark';

export type NavGroup = { key: string; label: string; items: Array<{ key: string; label: string; path: string }> };
export type ShellUser = { name: string; roles: string[]; canApprove: boolean; approvalByGrant: boolean };

export function ShellChrome({
  groups,
  user,
  unread,
  searchPath,
  /**
   * Where the brand mark returns you to. Resolved on the SERVER by homeFor() —
   * the dashboard for whoever may open it, their own landing place otherwise.
   * A fixed `/` sent an admin to Administration and a requester to a page they
   * are not allowed to see.
   */
  homePath,
  signOut,
  children,
}: {
  groups: NavGroup[];
  user: ShellUser;
  unread: number;
  searchPath: string;
  homePath: string;
  signOut: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Any navigation closes the drawer. Without this it stays open over the page
  // the user just asked for, which on a phone reads as "the tap did nothing".
  useEffect(() => setDrawerOpen(false), [pathname]);

  const activeKey = activeFor(groups, pathname);

  return (
    <div className="min-h-dvh lg:flex">
      {/* --- Sidebar: permanent from lg, a drawer below it -------------- */}
      <div
        aria-hidden={!drawerOpen}
        onClick={() => setDrawerOpen(false)}
        className={`fixed inset-0 z-30 bg-ink/40 transition-opacity lg:hidden ${
          drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        className={`no-print fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-line bg-surface transition-transform lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0 ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center gap-2 border-b border-line px-4">
          <Link href={homePath} className="min-w-0 rounded focus-visible:outline-none">
            {/* "Purchasing", not "Purchasing Control Center": the rail is 15rem
                and the longer product name truncates to an ellipsis, which
                reads as a bug rather than as a name. */}
            <BrandMark variant="lockup" size={26} subtitle="Purchasing" />
          </Link>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="ml-auto rounded p-1 text-muted hover:text-ink lg:hidden"
            aria-label="Close navigation"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m5 5 10 10M15 5 5 15" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/*
          Grouped, with a visible rule between groups rather than whitespace
          alone. The sidebar is read dozens of times a day by people who know
          exactly where they are going: the dividers let them aim at a region
          instead of scanning a flat list of eleven links.
        */}
        <nav aria-label="Sections" className="flex-1 overflow-y-auto py-2">
          {groups.map((group, index) => (
            <div
              key={group.key}
              className={index > 0 ? 'mt-1 border-t border-line pt-3' : 'pt-1'}
            >
              <p className="px-5 pb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted">{group.label}</p>
              <ul>
                {group.items.map((item) => {
                  const current = item.key === activeKey;
                  return (
                    <li key={item.key}>
                      <Link
                        href={item.path}
                        aria-current={current ? 'page' : undefined}
                        // The active marker is a brand-blue rail on the edge,
                        // not a filled pill: it survives being next to a
                        // hovered sibling, and it reads at a glance from across
                        // a desk.
                        className={`flex items-center gap-2 border-l-[3px] py-2 pl-4 pr-3 text-sm transition ${
                          current
                            ? 'border-brand bg-brand-soft font-semibold text-brand-ink'
                            : 'border-transparent font-medium text-ink-soft hover:bg-subtle hover:text-ink'
                        }`}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-line bg-canvas px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-white"
            >
              {initials(user.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink">{user.name}</p>
              <p className="truncate text-xs text-muted">{user.roles.join(', ') || 'No role'}</p>
            </div>
          </div>
          {/* Approval authority is worth stating plainly in the chrome: after
              BR-011 it is the thing that decides whether the Approve button
              appears at all, and it is granted per person. */}
          {user.canApprove ? (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand-ink">
              Approval authority
              {user.approvalByGrant ? <span className="font-medium text-muted">· granted</span> : null}
            </p>
          ) : null}
          <div className="mt-2">{signOut}</div>
        </div>
      </aside>

      {/* --- Content column --------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="rounded-md p-2 text-ink-soft hover:bg-subtle lg:hidden"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
            </svg>
          </button>

          {/* On a phone the sidebar is closed, so the topbar carries the brand. */}
          <Link href={homePath} className="shrink-0 lg:hidden" aria-label="Lippolis Electric — Purchasing">
            <BrandMark size={22} />
          </Link>

          <form action={searchPath} method="get" className="min-w-0 flex-1 md:max-w-md">
            <label htmlFor="global-search" className="sr-only">
              Search purchase orders, jobs, vendors
            </label>
            <div className="relative">
              <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="9" cy="9" r="6" />
                  <path d="m14 14 4 4" strokeLinecap="round" />
                </svg>
              </span>
              <input
                id="global-search"
                name="search"
                type="search"
                placeholder="Search PO, request, job, vendor…"
                className="h-9 w-full rounded-md border border-line bg-canvas pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-action focus:bg-surface focus:outline-none focus:ring-1 focus:ring-action"
              />
            </div>
          </form>

          <div className="ml-auto flex items-center gap-1">
            <Link
              href="/notifications"
              className="relative inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-ink-soft hover:bg-subtle"
            >
              Alerts
              {/* Unread work is the one place the accent orange earns its
                  loudness: it is the colour of "somebody is waiting on you". */}
              {unread ? (
                <span className="ml-1.5 inline-flex min-w-5 justify-center rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
                  {unread}
                </span>
              ) : null}
              <span className="sr-only">{unread ? `${unread} unread notifications` : 'no unread notifications'}</span>
            </Link>
            <Link
              href="/requests/new"
              className="hidden h-9 items-center rounded-md bg-brand px-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-hover sm:inline-flex"
            >
              New request
            </Link>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

/** Up to two initials, for the sidebar avatar. Names arrive as free text. */
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function activeFor(groups: NavGroup[], pathname: string) {
  const all = groups.flatMap((g) => g.items);
  const matches = all.filter((item) => pathname === item.path || pathname.startsWith(`${item.path}/`));
  if (matches.length === 0) return null;
  return matches.reduce((best, item) => (item.path.length > best.path.length ? item : best)).key;
}
