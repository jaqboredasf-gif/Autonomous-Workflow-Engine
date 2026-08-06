'use client';
// The error boundary. It shows what went wrong in a way a foreman can act on,
// and never renders a stack trace into a page a customer might see over a
// shoulder — the detail goes to the server log.
import { useEffect } from 'react';
import Link from 'next/link';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(JSON.stringify({ level: 'error', event: 'ui.render_failed', digest: error.digest, message: error.message }));
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <h1 className="text-xl font-semibold text-slate-900">Something went wrong on this page</h1>
      <p className="mt-2 max-w-sm text-sm text-slate-600">
        Your work was not lost. Try again — if it keeps happening, tell the office and quote this reference.
      </p>
      {error.digest ? <code className="mt-2 rounded bg-slate-100 px-2 py-1 font-mono text-xs">{error.digest}</code> : null}
      <div className="mt-6 flex gap-2">
        <button onClick={reset} className="rounded-md bg-slate-900 px-4 py-3 text-base font-medium text-white">
          Try again
        </button>
        <Link href="/" className="rounded-md border border-slate-300 bg-white px-4 py-3 text-base font-medium text-slate-800">
          Back to my work
        </Link>
      </div>
    </div>
  );
}
