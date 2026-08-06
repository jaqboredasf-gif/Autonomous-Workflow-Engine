// Role-aware navigation. What a person can reach is derived from the SAME
// permission table the server enforces with — a link that is absent would also
// have been refused, and a link that is present always works.
import Link from 'next/link';

import { currentActor } from '../server/session.ts';
import { hasPermission } from '../purchasing/domain/roles.mjs';
import { signOutAction } from '../app/actions.ts';

export default async function Nav() {
  const actor = await currentActor();
  if (!actor) return null;

  const links: Array<{ href: string; label: string }> = [];
  if (hasPermission(actor, 'request.read.all')) links.push({ href: '/', label: 'Dashboard' });
  links.push({ href: '/requests', label: hasPermission(actor, 'request.read.all') ? 'All requests' : 'My requests' });
  links.push({ href: '/requests/new', label: 'New request' });
  if (hasPermission(actor, 'review.read_queue')) links.push({ href: '/queue', label: 'Workshop queue' });
  if (hasPermission(actor, 'admin.settings')) links.push({ href: '/admin', label: 'Admin' });

  return (
    <nav className="no-print border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="text-sm font-semibold text-slate-900">
          Lippolis Purchasing
        </Link>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-600">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="hover:text-slate-900">
              {l.label}
            </Link>
          ))}
        </div>
        <form action={signOutAction} className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-500">
            {actor.name} · {actor.roles.join(', ')}
            {actor.canApprove && !actor.roles.includes('WORKSHOP_APPROVER') ? ' (approval granted)' : ''}
          </span>
          <button type="submit" className="text-xs text-slate-600 underline hover:text-slate-900">
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
