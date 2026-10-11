import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <h1 className="text-xl font-semibold text-slate-900">That page does not exist</h1>
      <p className="mt-2 max-w-sm text-sm text-slate-600">
        The link may be out of date, or the record may have been removed. Nothing has been changed.
      </p>
      <Link href="/" className="mt-6 rounded-md bg-slate-900 px-4 py-3 text-base font-medium text-white">
        Back to my work
      </Link>
    </div>
  );
}
