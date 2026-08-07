/* eslint-disable @typescript-eslint/no-explicit-any */
// The application shell: who you are, which workspace you are in, where else
// you may go, and how to leave. One shell for every device — the desktop bar
// and the mobile menu are the same links, laid out twice.
//
// Only workspaces the user actually holds appear. A section that would be
// refused is not rendered, and (unlike the previous pilot) not rendering it is
// the courtesy — the refusal itself lives in routeDecision() on the server.
import Link from 'next/link';

import { currentActor, purchasingRequestContext } from '../server/session.ts';
import { workspacesFor } from '../purchasing/domain/workspaces.mjs';
import { hasPermission } from '../purchasing/domain/roles.mjs';
import { signOutAction } from '../app/auth-actions.ts';

export default async function Nav() {
  const actor = await currentActor();
  if (!actor) return null;

  const workspaces = workspacesFor(actor);
  const ctx = await purchasingRequestContext();
  const unread = (await ctx.notifications.inboxFor(actor.id)).filter((n: any) => !n.read_at).length;

  return (
    <header className="no-print sticky top-0 z-20 border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <span className="flex h-7 w-7 items-center justify-center rounded bg-slate-900 text-xs font-bold text-white">
            LE
          </span>
          <span className="hidden sm:inline">Purchasing</span>
        </Link>

        {/* Desktop navigation */}
        <nav className="hidden flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600 md:flex" aria-label="Workspaces">
          {workspaces.map((w: any) => (
            <Link key={w.key} href={w.path} className="hover:text-slate-900">
              {w.label}
            </Link>
          ))}
          {hasPermission(actor, 'request.create') ? (
            <Link href="/requests/new" className="hover:text-slate-900">
              New request
            </Link>
          ) : null}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <Link
            href="/notifications"
            className="relative hidden text-sm text-slate-600 hover:text-slate-900 sm:inline"
            aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
          >
            Notifications
            {unread ? (
              <span className="ml-1 rounded-full bg-slate-900 px-1.5 py-0.5 text-xs font-medium text-white tabular-nums">
                {unread}
              </span>
            ) : null}
          </Link>

          <div className="hidden text-right sm:block">
            <div className="text-xs font-medium text-slate-800">{actor.name}</div>
            <div className="text-xs text-slate-500">
              {actor.roles.join(', ')}
              {actor.canApprove && !actor.roles.includes('WORKSHOP_APPROVER') ? ' · approval granted' : ''}
            </div>
          </div>

          <form action={signOutAction}>
            <button type="submit" className="text-sm text-slate-600 underline underline-offset-2 hover:text-slate-900">
              Sign out
            </button>
          </form>
        </div>
      </div>

      {/* Mobile navigation: a details/summary disclosure, so it works with no
          JavaScript and needs no client component. */}
      <details className="border-t border-slate-200 md:hidden">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-800">
          {actor.name} · {workspaces[0]?.label ?? 'Workspace'}
        </summary>
        <nav className="flex flex-col gap-1 px-2 pb-3" aria-label="Workspaces">
          {workspaces.map((w: any) => (
            <Link key={w.key} href={w.path} className="rounded-md px-2 py-3 text-base text-slate-800 active:bg-slate-100">
              {w.label}
            </Link>
          ))}
          {hasPermission(actor, 'request.create') ? (
            <Link href="/requests/new" className="rounded-md px-2 py-3 text-base text-slate-800 active:bg-slate-100">
              New request
            </Link>
          ) : null}
          <Link href="/notifications" className="rounded-md px-2 py-3 text-base text-slate-800 active:bg-slate-100">
            Notifications{unread ? ` (${unread})` : ''}
          </Link>
        </nav>
      </details>
    </header>
  );
}
