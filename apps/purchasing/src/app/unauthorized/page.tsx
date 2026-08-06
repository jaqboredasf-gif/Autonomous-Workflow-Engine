import Link from 'next/link';

import { currentActor } from '../../server/session.ts';
import { defaultWorkspaceFor, workspacesFor } from '../../purchasing/domain/workspaces.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Not available to you — Lippolis Purchasing' };

export default async function UnauthorizedPage() {
  const actor = await currentActor();
  const home = actor ? defaultWorkspaceFor(actor) : '/sign-in';
  const available = actor ? workspacesFor(actor) : [];

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 text-center">
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-slate-900">That area is not available to you</h1>
        <p className="mt-2 text-sm text-slate-600">
          {actor
            ? 'Your account does not carry the permission this page needs. If that is wrong, an administrator can change it.'
            : 'Sign in to continue.'}
        </p>
        {available.length ? (
          <ul className="mt-6 space-y-2 text-left">
            {available.map((w: { key: string; path: string; label: string; description: string }) => (
              <li key={w.key}>
                <Link
                  href={w.path}
                  className="block rounded-lg border border-slate-200 bg-white px-4 py-3 hover:border-slate-400"
                >
                  <span className="text-sm font-medium text-slate-900">{w.label}</span>
                  <span className="block text-xs text-slate-500">{w.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Link href={home} className="mt-6 inline-flex rounded-md bg-slate-900 px-4 py-3 text-base font-medium text-white">
            Go back
          </Link>
        )}
      </div>
    </div>
  );
}
