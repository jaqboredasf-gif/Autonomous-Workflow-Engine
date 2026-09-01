import Link from 'next/link';
import { pageTitle } from '../../purchasing/organization/identity.mjs';

export const metadata = { title: pageTitle('Session expired') };

export default function SessionExpiredPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 text-center">
      <div className="max-w-sm">
        <h1 className="text-xl font-semibold text-slate-900">Your session expired</h1>
        <p className="mt-2 text-sm text-slate-600">
          You were signed out after a period of inactivity. Nothing you saved was lost — sign in again to
          pick up where you left off.
        </p>
        <Link
          href="/sign-in"
          className="mt-6 inline-flex rounded-md bg-slate-900 px-4 py-3 text-base font-medium text-white"
        >
          Sign in again
        </Link>
      </div>
    </div>
  );
}
